import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { serve } from "@hono/node-server";
import {
  StateManager,
  PipelineRunner,
  createLLMClient,
  createLogger,
  createJsonLineSink,
  computeAnalytics,
  loadProjectConfig,
  type PipelineConfig,
  type ProjectConfig,
  type LogSink,
  type LogEntry,
  type ChapterMeta,
  type VectorRetrievalConfig,
  type VectorModelType,
} from "@actalk/inkos-core";
import { access, readFile, writeFile, readdir, unlink, rename, mkdir, stat, rm } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { isSafeBookId } from "./safety.js";
import { ApiError } from "./errors.js";
import { buildStudioBookConfig } from "./book-create.js";
import {
  loadAuditConfig,
  getDefaultAuditConfig,
  saveProjectAuditConfig,
} from "@actalk/inkos-core";
import { RunStore } from "./lib/run-store.js";

// --- Event bus for SSE ---

type EventHandler = (event: string, data: unknown) => void;
const subscribers = new Set<EventHandler>();
const bookCreateStatus = new Map<string, { status: "creating" | "error"; error?: string }>();

function broadcast(event: string, data: unknown): void {
  for (const handler of subscribers) {
    handler(event, data);
  }
}

// --- Server factory ---

// --- Temp directory cleanup ---

const TEMP_DIR_PREFIX = ".tmp-book-create-";
const TEMP_DIR_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
const TEMP_DIR_MIN_AGE_MS = 5 * 60 * 1000; // 5 minutes - protect very recent directories

async function cleanupTempDirectories(
  booksDir: string,
  activeStatuses?: Map<string, { status: string; error?: string }>
): Promise<void> {
  try {
    const files = await readdir(booksDir);
    const tempDirs = files.filter(f => f.startsWith(TEMP_DIR_PREFIX));
    const now = Date.now();
    let cleaned = 0;
    let skipped = 0;

    for (const tempDirName of tempDirs) {
      try {
        const tempDir = join(booksDir, tempDirName);
        const stats = await stat(tempDir);
        const age = now - stats.mtime.getTime();

        // Extract bookId from temp directory name
        // Format: .tmp-book-create-{bookId}-{timestamp}-{random}
        const bookIdMatch = tempDirName.match(/\.tmp-book-create-(.+?)-\d+-[a-z0-9]+/);
        const bookId = bookIdMatch ? bookIdMatch[1] : null;

        // Check if this book has an active creation status
        const isActive = bookId && activeStatuses?.has(bookId);
        if (isActive) {
          console.log(`[Cleanup] Skipping active temp directory: ${tempDirName} (book creation in progress)`);
          skipped++;
          continue;
        }

        // Check if directory is too new (protect ongoing operations)
        if (age < TEMP_DIR_MIN_AGE_MS) {
          console.log(`[Cleanup] Skipping recent temp directory: ${tempDirName} (age: ${Math.round(age / 1000)} seconds)`);
          skipped++;
          continue;
        }

        // Clean up directories older than 24 hours
        if (age > TEMP_DIR_MAX_AGE_MS) {
          await rm(tempDir, { recursive: true, force: true });
          cleaned++;
          console.log(`[Cleanup] Removed old temp directory: ${tempDirName} (age: ${Math.round(age / 1000 / 60)} minutes)`);
        }
      } catch (e) {
        console.warn(`[Cleanup] Failed to clean temp directory ${tempDirName}:`, e);
      }
    }

    if (cleaned > 0 || skipped > 0) {
      console.log(`[Cleanup] Cleaned up ${cleaned} temporary directories, skipped ${skipped} active/recent directories`);
    }
  } catch (e) {
    console.warn("[Cleanup] Failed to cleanup temp directories:", e);
  }
}

export function createStudioServer(initialConfig: ProjectConfig, root: string) {
  const app = new Hono();
  const state = new StateManager(root);
  const booksDir = join(root, "books");

  // Run cleanup on startup and every hour
  // Pass bookCreateStatus to avoid cleaning up active book creation directories
  cleanupTempDirectories(booksDir, bookCreateStatus);
  setInterval(() => cleanupTempDirectories(booksDir, bookCreateStatus), 60 * 60 * 1000);
  let cachedConfig = initialConfig;

  app.use("/*", cors());
  
  // Health check endpoint
  app.get("/health", (c) => {
    return c.json({ status: "ok", timestamp: new Date().toISOString() });
  });
  
  app.get("/api/health", (c) => {
    return c.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // Structured error handler — ApiError returns typed JSON, others return 500
  app.onError((error, c) => {
    if (error instanceof ApiError) {
      return c.json({ error: { code: error.code, message: error.message } }, error.status as 400);
    }
    return c.json(
      { error: { code: "INTERNAL_ERROR", message: "Unexpected server error." } },
      500,
    );
  });

  // BookId validation middleware — blocks path traversal on all book routes
  app.use("/api/books/:id/*", async (c, next) => {
    const bookId = c.req.param("id");
    if (!isSafeBookId(bookId)) {
      throw new ApiError(400, "INVALID_BOOK_ID", `Invalid book ID: "${bookId}"`);
    }
    await next();
  });
  app.use("/api/books/:id", async (c, next) => {
    const bookId = c.req.param("id");
    if (!isSafeBookId(bookId)) {
      throw new ApiError(400, "INVALID_BOOK_ID", `Invalid book ID: "${bookId}"`);
    }
    await next();
  });

  // Logger sink that broadcasts to SSE
  const sseSink: LogSink = {
    write(entry: LogEntry): void {
      broadcast("log", { level: entry.level, tag: entry.tag, message: entry.message });
    },
  };

  async function loadCurrentProjectConfig(
    options?: { readonly requireApiKey?: boolean },
  ): Promise<ProjectConfig> {
    const freshConfig = await loadProjectConfig(root, options);
    cachedConfig = freshConfig;
    return freshConfig;
  }

  async function buildPipelineConfig(
    overrides?: Partial<Pick<PipelineConfig, "externalContext">>,
  ): Promise<PipelineConfig> {
    const currentConfig = await loadCurrentProjectConfig();
    const logPath = join(root, "inkos.log");
    const logStream = createWriteStream(logPath, { flags: "a" });
    const logger = createLogger({ 
      tag: "studio", 
      sinks: [sseSink, createJsonLineSink(logStream)] 
    });
    return {
      client: createLLMClient(currentConfig.llm),
      model: currentConfig.llm.model,
      projectRoot: root,
      defaultLLMConfig: currentConfig.llm,
      modelOverrides: currentConfig.modelOverrides,
      notifyChannels: currentConfig.notify,
      logger,
      onStreamProgress: (progress) => {
        if (progress.status === "streaming") {
          broadcast("llm:progress", {
            elapsedMs: progress.elapsedMs,
            totalChars: progress.totalChars,
            chineseChars: progress.chineseChars,
          });
        }
      },
      externalContext: overrides?.externalContext,
    };
  }

  // --- Books ---

  app.get("/api/books", async (c) => {
    console.log(`[API] /api/books - booksDir: ${booksDir}`);
    const bookIds = await state.listBooks();
    console.log(`[API] /api/books - found bookIds:`, bookIds);
    const books = await Promise.all(
      bookIds.map(async (id) => {
        try {
          const book = await state.loadBookConfig(id);
          const nextChapter = await state.getNextChapterNumber(id);
          return { ...book, chaptersWritten: nextChapter - 1 };
        } catch (e) {
          console.warn(`[API] Failed to load book "${id}":`, e);
          return null;
        }
      }),
    );
    // Filter out null values (failed to load)
    const result = books.filter((b): b is NonNullable<typeof b> => b !== null);
    console.log(`[API] /api/books - returning ${result.length} books`);
    return c.json({ books: result });
  });

  app.get("/api/books/:id", async (c) => {
    const id = c.req.param("id");
    try {
      // 尝试加载正式的书籍目录
      try {
        const book = await state.loadBookConfig(id);
        const chapters = await state.loadChapterIndex(id);
        const nextChapter = await state.getNextChapterNumber(id);
        return c.json({ book, chapters, nextChapter });
      } catch (e) {
        // 正式书籍目录不存在，尝试查找对应的临时目录
        const booksDir = join(root, "books");
        try {
          const files = await readdir(booksDir);
          const tempDirs = files.filter(f => f.startsWith(".tmp-book-create-") && f.includes(id));
          if (tempDirs.length > 0) {
            // 找到临时目录，加载其中的书籍配置
            const tempDir = join(booksDir, tempDirs[0]);
            const book = await state.loadBookConfigAt(tempDir);
            return c.json({ 
              book, 
              chapters: [], 
              nextChapter: 1,
              isTemporary: true
            });
          }
        } catch (tempError) {
          // 临时目录也不存在，返回404
        }
        return c.json({ error: `Book "${id}" not found` }, 404);
      }
    } catch {
      return c.json({ error: `Book "${id}" not found` }, 404);
    }
  });

  // --- Genres ---

  app.get("/api/genres", async (c) => {
    const { listAvailableGenres, readGenreProfile } = await import("@actalk/inkos-core");
    const rawGenres = await listAvailableGenres(root);
    const genres = await Promise.all(
      rawGenres.map(async (g) => {
        try {
          const { profile } = await readGenreProfile(root, g.id);
          return { ...g, language: profile.language ?? "zh" };
        } catch {
          return { ...g, language: "zh" };
        }
      }),
    );
    return c.json({ genres });
  });

  // --- Book Create ---

  app.post("/api/books/create", async (c) => {
    const body = await c.req.json<{
      title: string;
      genre: string;
      language?: string;
      platform?: string;
      chapterWordCount?: number;
      targetChapters?: number;
      useGlobalAuditConfig?: boolean;
      auditConfig?: {
        dimensions: Array<{ id: string; name: string; enabled: boolean; weight: number }>;
        scoring: {
          baseScore: number;
          penalties: { auditIssue: number; aiTellDensity: number; paragraphWarning: number };
          weights: { auditPassRate: number; aiTellDensity: number; paragraphWarnings: number; hookResolveRate: number; duplicateTitles: number };
        };
        validationRules: {
          bannedPatterns: string[];
          bannedDashes: boolean;
          transitionWordDensity: number;
          fatigueWordLimit: number;
          maxConsecutiveLe: number;
          maxParagraphLength: number;
        };
      };
      brief?: string;
    }>();

    const now = new Date().toISOString();
    const bookConfig = buildStudioBookConfig(body, now);
    const bookId = bookConfig.id;
    const bookDir = state.bookDir(bookId);

    console.log(`\n========== 书籍创建流程开始 ==========`);
    console.log(`[1] 书籍 ID: ${bookId}`);
    console.log(`[2] 书籍标题：${body.title}`);
    console.log(`[3] 是否使用全局审计配置：${body.useGlobalAuditConfig}`);
    console.log(`[4] 正式书籍目录路径：${bookDir}`);

    try {
      await access(join(bookDir, "book.json"));
      await access(join(bookDir, "story", "story_bible.md"));
      return c.json({ error: `Book "${bookId}" already exists` }, 409);
    } catch {
      console.log(`[5] 正式书籍目录尚未完全初始化，继续创建流程`);
    }

    broadcast("book:creating", { bookId, title: body.title });
    bookCreateStatus.set(bookId, { status: "creating" });

    // 保存审计配置
    if (body.useGlobalAuditConfig === false && body.auditConfig) {
      console.log(`\n[6] 开始保存审计配置到正式书籍目录`);
      console.log(`[6.1] 审计配置内容：${JSON.stringify(body.auditConfig, null, 2)}`);
      try {
        // 创建正式书籍目录
        console.log(`[6.2] 创建正式书籍目录：${bookDir}`);
        await mkdir(bookDir, { recursive: true });
        console.log(`[6.3] 正式书籍目录创建成功`);
        
        // 保存审计配置
        console.log(`[6.4] 保存审计配置到：${join(bookDir, "audit-config.json")}`);
        await state.saveAuditConfig(bookId, body.auditConfig);
        console.log(`[6.5] 审计配置保存成功`);
        
        // 验证保存
        try {
          await access(join(bookDir, "audit-config.json"));
          console.log(`[6.6] 验证：审计配置文件存在`);
        } catch {
          console.warn(`[6.6] 验证：审计配置文件不存在！`);
        }
      } catch (e) {
        console.warn(`[6.7] 保存审计配置失败：${e}`);
      }
    } else {
      console.log(`\n[6] 使用全局默认审计配置，不保存书籍特定配置`);
    }

    console.log(`\n[7] 创建 PipelineRunner 并调用 initBook`);
    const pipeline = new PipelineRunner(await buildPipelineConfig({ externalContext: body.brief }));
    pipeline.initBook(bookConfig).then(
      async () => {
        console.log(`\n[8] 书籍创建成功`);
        bookCreateStatus.delete(bookId);
        broadcast("book:created", { bookId });
      },
      async (e) => {
        const error = e instanceof Error ? e.message : String(e);
        console.log(`\n[8] 书籍创建失败：${error}`);
        bookCreateStatus.set(bookId, { status: "error", error });
        broadcast("book:error", { bookId, error });
        
        // Clean up temporary directories on failure
        console.log(`[8.1] 清理临时目录...`);
        try {
          const files = await readdir(booksDir);
          const tempDirs = files.filter(f => f.startsWith(TEMP_DIR_PREFIX) && f.includes(bookId));
          for (const tempDirName of tempDirs) {
            const tempDir = join(booksDir, tempDirName);
            await rm(tempDir, { recursive: true, force: true });
            console.log(`[8.2] 已清理临时目录：${tempDirName}`);
          }
        } catch (cleanupError) {
          console.warn(`[8.2] 清理临时目录失败：`, cleanupError);
        }
      },
    );

    return c.json({ status: "creating", bookId });
  });

  app.get("/api/books/:id/create-status", async (c) => {
    const id = c.req.param("id");
    const status = bookCreateStatus.get(id);
    if (!status) {
      return c.json({ status: "missing" }, 404);
    }
    return c.json(status);
  });

  // --- Chapters ---

  app.get("/api/books/:id/chapters/:num", async (c) => {
    const id = c.req.param("id");
    const num = parseInt(c.req.param("num"), 10);
    const bookDir = state.bookDir(id);
    const chaptersDir = join(bookDir, "chapters");

    try {
      const files = await readdir(chaptersDir);
      const paddedNum = String(num).padStart(4, "0");
      const match = files.find((f) => f.startsWith(paddedNum) && f.endsWith(".md"));
      if (!match) return c.json({ error: "Chapter not found" }, 404);
      const content = await readFile(join(chaptersDir, match), "utf-8");
      return c.json({ chapterNumber: num, filename: match, content });
    } catch {
      return c.json({ error: "Chapter not found" }, 404);
    }
  });

  // --- Chapter Save ---

  app.put("/api/books/:id/chapters/:num", async (c) => {
    const id = c.req.param("id");
    const num = parseInt(c.req.param("num"), 10);
    const bookDir = state.bookDir(id);
    const chaptersDir = join(bookDir, "chapters");
    const { content } = await c.req.json<{ content: string }>();

    try {
      const files = await readdir(chaptersDir);
      const paddedNum = String(num).padStart(4, "0");
      const match = files.find((f) => f.startsWith(paddedNum) && f.endsWith(".md"));
      if (!match) return c.json({ error: "Chapter not found" }, 404);

      const { writeFile: writeFileFs } = await import("node:fs/promises");
      await writeFileFs(join(chaptersDir, match), content, "utf-8");
      return c.json({ ok: true, chapterNumber: num });
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Truth files ---

  const TRUTH_FILES = [
    "story_bible.md", "volume_outline.md", "current_state.md",
    "particle_ledger.md", "pending_hooks.md", "chapter_summaries.md",
    "subplot_board.md", "emotional_arcs.md", "character_matrix.md",
    "style_guide.md", "parent_canon.md", "fanfic_canon.md", "book_rules.md",
  ];

  app.get("/api/books/:id/truth/:file", async (c) => {
    const id = c.req.param("id");
    const file = c.req.param("file");

    if (!TRUTH_FILES.includes(file)) {
      return c.json({ error: "Invalid truth file" }, 400);
    }

    const bookDir = state.bookDir(id);
    try {
      const content = await readFile(join(bookDir, "story", file), "utf-8");
      return c.json({ file, content });
    } catch {
      return c.json({ file, content: null });
    }
  });

  // --- Analytics ---

  app.get("/api/books/:id/analytics", async (c) => {
    const id = c.req.param("id");
    try {
      const chapters = await state.loadChapterIndex(id);
      return c.json(computeAnalytics(id, chapters));
    } catch {
      return c.json({ error: `Book "${id}" not found` }, 404);
    }
  });

  // --- Actions ---

  app.post("/api/books/:id/regenerate-outline", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json<{ intent: string; rewriteLevel?: "low" | "medium" | "high" }>().catch(() => ({ intent: "", rewriteLevel: "medium" }));

    if (!body.intent?.trim()) {
      return c.json({ error: "Author intent is required" }, 400);
    }

    broadcast("outline:regenerate:start", { bookId: id });

    try {
      const pipeline = new PipelineRunner(await buildPipelineConfig());
      const rewriteLevel = body.rewriteLevel as "low" | "medium" | "high" | undefined;
      const result = await pipeline.regenerateOutline(id, body.intent, rewriteLevel);
      broadcast("outline:regenerate:complete", { bookId: id });
      return c.json({ ok: true, volumeOutline: result.volumeOutline, tempPath: result.tempPath });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      broadcast("outline:regenerate:error", { bookId: id, error });
      return c.json({ error }, 500);
    }
  });

  app.post("/api/books/:id/confirm-outline", async (c) => {
    const id = c.req.param("id");

    broadcast("outline:confirm:start", { bookId: id });

    try {
      const pipeline = new PipelineRunner(await buildPipelineConfig());
      await pipeline.confirmOutline(id);
      broadcast("outline:confirm:complete", { bookId: id });
      return c.json({ ok: true });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      broadcast("outline:confirm:error", { bookId: id, error });
      return c.json({ error }, 500);
    }
  });

  app.post("/api/books/:id/write-next", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json<{ wordCount?: number }>().catch(() => ({ wordCount: undefined }));

    broadcast("write:start", { bookId: id });

    // Fire and forget — progress/completion/errors pushed via SSE
    const pipeline = new PipelineRunner(await buildPipelineConfig());
    pipeline.writeNextChapter(id, body.wordCount).then(
      (result) => {
        broadcast("write:complete", { bookId: id, chapterNumber: result.chapterNumber, status: result.status, title: result.title, wordCount: result.wordCount });
      },
      (e) => {
        broadcast("write:error", { bookId: id, error: e instanceof Error ? e.message : String(e) });
      },
    );

    return c.json({ status: "writing", bookId: id });
  });

  app.post("/api/books/:id/draft", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json<{ wordCount?: number; context?: string }>().catch(() => ({ wordCount: undefined, context: undefined }));

    broadcast("draft:start", { bookId: id });

    const pipeline = new PipelineRunner(await buildPipelineConfig());
    pipeline.writeDraft(id, body.context, body.wordCount).then(
      (result) => {
        broadcast("draft:complete", { bookId: id, chapterNumber: result.chapterNumber, title: result.title, wordCount: result.wordCount });
      },
      (e) => {
        broadcast("draft:error", { bookId: id, error: e instanceof Error ? e.message : String(e) });
      },
    );

    return c.json({ status: "drafting", bookId: id });
  });

  app.post("/api/books/:id/chapters/:num/approve", async (c) => {
    const id = c.req.param("id");
    const num = parseInt(c.req.param("num"), 10);

    try {
      const index = await state.loadChapterIndex(id);
      const updated = index.map((ch) =>
        ch.number === num ? { ...ch, status: "approved" as const } : ch,
      );
      await state.saveChapterIndex(id, updated);
      return c.json({ ok: true, chapterNumber: num, status: "approved" });
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  app.post("/api/books/:id/chapters/:num/reject", async (c) => {
    const id = c.req.param("id");
    const num = parseInt(c.req.param("num"), 10);

    try {
      const index = await state.loadChapterIndex(id);
      const target = index.find((ch) => ch.number === num);
      if (!target) {
        return c.json({ error: `Chapter ${num} not found` }, 404);
      }

      const rollbackTarget = num - 1;
      const discarded = await state.rollbackToChapter(id, rollbackTarget);
      return c.json({
        ok: true,
        chapterNumber: num,
        status: "rejected",
        rolledBackTo: rollbackTarget,
        discarded,
      });
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Batch Operations ---

  // Approve all ready-for-review chapters
  app.post("/api/books/:id/approve-all", async (c) => {
    const id = c.req.param("id");

    try {
      const index = await state.loadChapterIndex(id);
      const reviewable = index.filter((ch) => ch.status === "ready-for-review");

      const results = [];
      const updatedIndex = [...index];

      for (const ch of reviewable) {
        try {
          // Update chapter status in index
          const chapterIdx = updatedIndex.findIndex((item) => item.number === ch.number);
          if (chapterIdx !== -1) {
            updatedIndex[chapterIdx] = { ...updatedIndex[chapterIdx], status: "approved" as const };
          }
          results.push({ chapterNumber: ch.number, status: "approved" });
        } catch (e) {
          results.push({ chapterNumber: ch.number, status: "error", error: String(e) });
        }
      }

      // Save updated index
      await state.saveChapterIndex(id, updatedIndex);

      broadcast("book:approve-all", { bookId: id, count: reviewable.length });
      return c.json({
        ok: true,
        approved: results.filter((r) => r.status === "approved").length,
        failed: results.filter((r) => r.status === "error").length,
        results,
      });
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // Repair book state
  app.post("/api/books/:id/repair-state", async (c) => {
    const id = c.req.param("id");

    try {
      const index = await state.loadChapterIndex(id);
      const repairs = [];

      // Fix 1: Ensure chapter numbers are sequential
      const sortedIndex = [...index].sort((a, b) => a.number - b.number);
      for (let i = 0; i < sortedIndex.length; i++) {
        const expectedNumber = i + 1;
        if (sortedIndex[i].number !== expectedNumber) {
          repairs.push({
            type: "renumber",
            oldNumber: sortedIndex[i].number,
            newNumber: expectedNumber,
          });
        }
      }

      // Fix 2: Validate chapter files exist
      const bookDir = state.bookDir(id);
      const chaptersDir = join(bookDir, "chapters");
      const existingFiles = await readdir(chaptersDir).catch(() => [] as string[]);

      for (const ch of index) {
        const paddedNum = String(ch.number).padStart(4, "0");
        const chapterFile = existingFiles.find((f) => f.startsWith(paddedNum) && f.endsWith(".md"));
        if (!chapterFile) {
          // File doesn't exist, mark as orphaned
          repairs.push({
            type: "orphaned",
            chapterNumber: ch.number,
            status: ch.status,
          });
        }
      }

      // Fix 3: Rebuild chapter index from actual files if needed
      if (repairs.length > 0) {
        const validChapters = [];
        for (const file of existingFiles.sort()) {
          const match = file.match(/^(\d{4})[-_](.*)\.md$/);
          if (!match) continue;

          const num = parseInt(match[1], 10);
          const title = match[2].replace(/-/g, " ");

          // Find existing chapter metadata if available
          const existing = index.find((ch) => ch.number === num);

          validChapters.push({
            number: num,
            title: existing?.title ?? title,
            status: existing?.status ?? "drafted",
            wordCount: existing?.wordCount ?? 0,
            createdAt: existing?.createdAt ?? new Date().toISOString(),
            updatedAt: existing?.updatedAt ?? new Date().toISOString(),
            auditIssues: existing?.auditIssues ?? [],
            lengthWarnings: existing?.lengthWarnings ?? [],
          });
        }

        // Sort by chapter number
        validChapters.sort((a, b) => a.number - b.number);
        await state.saveChapterIndex(id, validChapters);
      }

      broadcast("book:repair-state", { bookId: id, repairs: repairs.length });
      return c.json({
        ok: true,
        repairs,
        repaired: repairs.length,
      });
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- SSE ---

  app.get("/api/events", (c) => {
    return streamSSE(c, async (stream) => {
      const handler: EventHandler = (event, data) => {
        stream.writeSSE({ event, data: JSON.stringify(data) });
      };
      subscribers.add(handler);

      // Keep alive
      const keepAlive = setInterval(() => {
        stream.writeSSE({ event: "ping", data: "" });
      }, 30000);

      stream.onAbort(() => {
        subscribers.delete(handler);
        clearInterval(keepAlive);
      });

      // Block until aborted
      await new Promise(() => {});
    });
  });

  // --- Project info ---

  app.get("/api/project", async (c) => {
    const currentConfig = await loadCurrentProjectConfig({ requireApiKey: false });
    // Check if language was explicitly set in inkos.json (not just the schema default)
    const raw = JSON.parse(await readFile(join(root, "inkos.json"), "utf-8"));
    const languageExplicit = "language" in raw && raw.language !== "";

    return c.json({
      name: currentConfig.name,
      language: currentConfig.language,
      languageExplicit,
      model: currentConfig.llm.model,
      provider: currentConfig.llm.provider,
      baseUrl: currentConfig.llm.baseUrl,
      stream: currentConfig.llm.stream,
      temperature: currentConfig.llm.temperature,
      maxTokens: currentConfig.llm.maxTokens,
    });
  });

  // --- Config editing ---

  app.put("/api/project", async (c) => {
    const updates = await c.req.json<Record<string, unknown>>();
    const configPath = join(root, "inkos.json");
    try {
      const raw = await readFile(configPath, "utf-8");
      const existing = JSON.parse(raw);
      // Merge LLM settings
      if (updates.temperature !== undefined) {
        existing.llm.temperature = updates.temperature;
      }
      if (updates.maxTokens !== undefined) {
        existing.llm.maxTokens = updates.maxTokens;
      }
      if (updates.stream !== undefined) {
        existing.llm.stream = updates.stream;
      }
      if (updates.language === "zh" || updates.language === "en") {
        existing.language = updates.language;
      }
      const { writeFile: writeFileFs } = await import("node:fs/promises");
      await writeFileFs(configPath, JSON.stringify(existing, null, 2), "utf-8");
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Global Config Management ---

  app.get("/api/config/global", async (c) => {
    try {
      const globalConfigPath = join(homedir(), ".config", "inkos", "config.json");
      try {
        const raw = await readFile(globalConfigPath, "utf-8");
        const config = JSON.parse(raw);
        return c.json({ config });
      } catch {
        return c.json({ config: null, message: "Global config not found" });
      }
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  app.put("/api/config/global", async (c) => {
    try {
      const updates = await c.req.json<Record<string, unknown>>();
      const globalConfigDir = join(homedir(), ".config", "inkos");
      const globalConfigPath = join(globalConfigDir, "config.json");

      // Ensure directory exists
      const { mkdir } = await import("node:fs/promises");
      await mkdir(globalConfigDir, { recursive: true });

      // Load existing or create new
      let config: Record<string, unknown> = {};
      try {
        const raw = await readFile(globalConfigPath, "utf-8");
        config = JSON.parse(raw);
      } catch {
        // File doesn't exist, use empty config
      }

      // Merge updates
      const merged = { ...config, ...updates };

      // Save
      const { writeFile: writeFileFs } = await import("node:fs/promises");
      await writeFileFs(globalConfigPath, JSON.stringify(merged, null, 2), "utf-8");

      broadcast("config:global:updated", { keys: Object.keys(updates) });
      return c.json({ ok: true, config: merged });
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  app.delete("/api/config/global", async (c) => {
    try {
      const globalConfigPath = join(homedir(), ".config", "inkos", "config.json");
      const { unlink } = await import("node:fs/promises");
      await unlink(globalConfigPath);
      broadcast("config:global:deleted", {});
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Truth files browser ---

  app.get("/api/books/:id/truth", async (c) => {
    const id = c.req.param("id");
    const bookDir = state.bookDir(id);
    const storyDir = join(bookDir, "story");
    try {
      const files = await readdir(storyDir);
      const mdFiles = files.filter((f) => f.endsWith(".md") || f.endsWith(".json"));
      const result = await Promise.all(
        mdFiles.map(async (f) => {
          const content = await readFile(join(storyDir, f), "utf-8");
          return { name: f, size: content.length, preview: content.slice(0, 200) };
        }),
      );
      return c.json({ files: result });
    } catch {
      return c.json({ files: [] });
    }
  });

  // --- Daemon control ---

  let schedulerInstance: import("@actalk/inkos-core").Scheduler | null = null;

  app.get("/api/daemon", (c) => {
    return c.json({
      running: schedulerInstance?.isRunning ?? false,
    });
  });

  app.post("/api/daemon/start", async (c) => {
    if (schedulerInstance?.isRunning) {
      return c.json({ error: "Daemon already running" }, 400);
    }
    try {
      const { Scheduler } = await import("@actalk/inkos-core");
      const currentConfig = await loadCurrentProjectConfig();
      const scheduler = new Scheduler({
        ...(await buildPipelineConfig()),
        radarCron: currentConfig.daemon.schedule.radarCron,
        writeCron: currentConfig.daemon.schedule.writeCron,
        maxConcurrentBooks: currentConfig.daemon.maxConcurrentBooks,
        chaptersPerCycle: currentConfig.daemon.chaptersPerCycle,
        retryDelayMs: currentConfig.daemon.retryDelayMs,
        cooldownAfterChapterMs: currentConfig.daemon.cooldownAfterChapterMs,
        maxChaptersPerDay: currentConfig.daemon.maxChaptersPerDay,
        onChapterComplete: (bookId, chapter, status) => {
          broadcast("daemon:chapter", { bookId, chapter, status });
        },
        onError: (bookId, error) => {
          broadcast("daemon:error", { bookId, error: error.message });
        },
      });
      schedulerInstance = scheduler;
      broadcast("daemon:started", {});
      void scheduler.start().catch((e) => {
        const error = e instanceof Error ? e : new Error(String(e));
        if (schedulerInstance === scheduler) {
          scheduler.stop();
          schedulerInstance = null;
          broadcast("daemon:stopped", {});
        }
        broadcast("daemon:error", { bookId: "scheduler", error: error.message });
      });
      return c.json({ ok: true, running: true });
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  app.post("/api/daemon/stop", (c) => {
    if (!schedulerInstance?.isRunning) {
      return c.json({ error: "Daemon not running" }, 400);
    }
    schedulerInstance.stop();
    schedulerInstance = null;
    broadcast("daemon:stopped", {});
    return c.json({ ok: true, running: false });
  });

  // --- Run Store for task management ---
  const runStore = new RunStore();

  app.get("/api/runs/active", (c) => {
    const bookId = c.req.query("bookId");
    if (bookId) {
      const activeRun = runStore.findActiveRun(bookId);
      return c.json({ active: !!activeRun, run: activeRun });
    }
    const allActive = runStore.list().filter(r => r.status === "running" || r.status === "queued");
    return c.json({ active: allActive.length > 0, runs: allActive });
  });

  app.post("/api/runs/cancel", (c) => {
    const bookId = c.req.query("bookId");
    if (bookId) {
      const cancelled = runStore.cancelActiveRun(bookId);
      if (!cancelled) {
        return c.json({ error: "No active run found for this book" }, 404);
      }
      broadcast("run:cancelled", { runId: cancelled.id, bookId });
      return c.json({ ok: true, run: cancelled });
    }
    // Cancel all active runs if no bookId provided
    const activeRuns = runStore.list().filter(r => r.status === "running" || r.status === "queued");
    if (activeRuns.length === 0) {
      return c.json({ error: "No active runs found" }, 404);
    }
    const cancelledRuns = [];
    for (const run of activeRuns) {
      const cancelled = runStore.cancelActiveRun(run.bookId);
      if (cancelled) {
        cancelledRuns.push(cancelled);
        broadcast("run:cancelled", { runId: cancelled.id, bookId: run.bookId });
      }
    }
    return c.json({ ok: true, runs: cancelledRuns });
  });

  // --- Logs ---

  app.get("/api/logs", async (c) => {
    const logPath = join(root, "inkos.log");
    try {
      const content = await readFile(logPath, "utf-8");
      const lines = content.trim().split("\n").slice(-100);
      const entries = lines.map((line) => {
        try { return JSON.parse(line); } catch { return { message: line }; }
      });
      return c.json({ entries });
    } catch {
      return c.json({ entries: [] });
    }
  });

  // --- Agent chat ---

  app.post("/api/agent", async (c) => {
    const { instruction } = await c.req.json<{ instruction: string }>();
    if (!instruction?.trim()) {
      return c.json({ error: "No instruction provided" }, 400);
    }

    broadcast("agent:start", { instruction });

    try {
      const { runAgentLoop } = await import("@actalk/inkos-core");

      const result = await runAgentLoop(
        await buildPipelineConfig(),
        instruction
      );

      broadcast("agent:complete", { instruction, response: result });
      return c.json({ response: result });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      broadcast("agent:error", { instruction, error: msg });
      return c.json({ response: msg });
    }
  });

  // --- Language setup ---

  app.post("/api/project/language", async (c) => {
    const { language } = await c.req.json<{ language: "zh" | "en" }>();
    const configPath = join(root, "inkos.json");
    try {
      const raw = await readFile(configPath, "utf-8");
      const existing = JSON.parse(raw);
      existing.language = language;
      const { writeFile: writeFileFs } = await import("node:fs/promises");
      await writeFileFs(configPath, JSON.stringify(existing, null, 2), "utf-8");
      return c.json({ ok: true, language });
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Audit Config ---

  app.get("/api/audit-config/default", async (c) => {
    try {
      const defaultConfig = getDefaultAuditConfig();
      return c.json(defaultConfig);
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  app.get("/api/books/:id/audit-config", async (c) => {
    const id = c.req.param("id");
    try {
      const config = await state.loadAuditConfig(id);
      if (config) {
        return c.json(config);
      }
      // Return default config if no project config exists
      const defaultConfig = getDefaultAuditConfig();
      return c.json(defaultConfig);
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  app.put("/api/books/:id/audit-config", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json<{
      dimensions: Array<{ id: string; name: string; enabled: boolean; weight: number }>;
      scoring: {
        baseScore: number;
        penalties: { auditIssue: number; aiTellDensity: number; paragraphWarning: number };
        weights: { auditPassRate: number; aiTellDensity: number; paragraphWarnings: number; hookResolveRate: number; duplicateTitles: number };
      };
      validationRules: {
        bannedPatterns: string[];
        bannedDashes: boolean;
        transitionWordDensity: number;
        fatigueWordLimit: number;
        maxConsecutiveLe: number;
        maxParagraphLength: number;
      };
      chapterPlanAudit?: {
        enabled: boolean;
        maxRetries: number;
        passThreshold: number;
        dimensionFloor: number;
        dimensions: Array<{
          id: string;
          name: string;
          enabled: boolean;
          weight: number;
          severity: "critical" | "warning" | "info";
          description: string;
          checkContent: string;
        }>;
      };
    }>();

    try {
      await state.saveAuditConfig(id, body);
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Chapter Plan Audit Config Endpoints ---

  // 获取章节规划审计配置
  app.get("/api/books/:id/chapter-plan-audit-config", async (c) => {
    const id = c.req.param("id");
    try {
      const config = await state.loadAuditConfig(id);
      if (config && (config as any).chapterPlanAudit) {
        return c.json((config as any).chapterPlanAudit);
      }
      // Return default chapter plan audit config
      const { DEFAULT_CHAPTER_PLAN_AUDIT } = await import("@actalk/inkos-core");
      return c.json(DEFAULT_CHAPTER_PLAN_AUDIT);
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // 保存章节规划审计配置
  app.put("/api/books/:id/chapter-plan-audit-config", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json<{
      enabled: boolean;
      maxRetries: number;
      passThreshold: number;
      dimensionFloor: number;
      dimensions: Array<{
        id: string;
        name: string;
        enabled: boolean;
        weight: number;
        severity: "critical" | "warning" | "info";
        description: string;
        checkContent: string;
      }>;
    }>();

    try {
      const existingConfig = await state.loadAuditConfig(id);
      const updatedConfig: any = {
        ...existingConfig,
        chapterPlanAudit: body,
      };
      await state.saveAuditConfig(id, updatedConfig);
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // 手动触发单个章节规划审计
  app.post("/api/books/:id/chapters/:chapterNumber/plan-audit", async (c) => {
    const bookId = c.req.param("id");
    const chapterNumber = parseInt(c.req.param("chapterNumber"), 10);

    try {
      const pipeline = new PipelineRunner(await buildPipelineConfig());
      const bookDir = pipeline["state"].bookDir(bookId);
      
      // 读取章节规划
      const planPath = join(bookDir, "story", "runtime", `chapter-${String(chapterNumber).padStart(4, "0")}.intent.md`);
      const planContent = await readFile(planPath, "utf-8");
      const chapterPlan = pipeline["parseChapterIntent"](planContent);

      // 读取卷纲和详细卷纲
      const outlinePath = join(bookDir, "story", "volume_outline.md");
      const detailPath = join(bookDir, "story", `volume_${Math.ceil(chapterNumber / 30)}_detail.md`);
      let volumeOutline = "";
      let volumeDetail = "";
      
      try {
        volumeOutline = await readFile(outlinePath, "utf-8");
      } catch {
        // 卷纲不存在
      }
      
      try {
        volumeDetail = await readFile(detailPath, "utf-8");
      } catch {
        // 详细卷纲不存在
      }

      // 加载审计配置
      const { loadAuditConfig } = await import("@actalk/inkos-core");
      const auditConfig = loadAuditConfig(bookDir);

      // 执行审计
      const { ChapterPlanAuditor } = await import("@actalk/inkos-core");
      const auditor = new ChapterPlanAuditor(pipeline["agentCtxFor"]("chapter-plan-auditor", bookId));
      
      const result = await auditor.audit({
        chapterNumber,
        chapterPlan,
        volumeOutline,
        volumeDetail,
        bookRules: await pipeline["readBookRules"](bookDir),
        config: auditConfig.chapterPlanAudit,
      });

      return c.json(result);
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Audit Config Test Endpoint ---  
  
  app.post("/api/audit-config/test", async (c) => {
    try {
      const body = await c.req.json();
      const { bookId, testScores, configPath } = body;
      console.log(`Received request: bookId=${bookId}, testScores=${testScores}, configPath=${configPath}`);
      
      // 加载审计配置
      let passThreshold = 80;
      let dimensionFloor = 60;
      let configLoaded = false;
      
      // 优先使用直接指定的配置文件路径
      if (configPath) {
        try {
          console.log(`Loading audit config from direct path: ${configPath}`);
          await access(configPath);
          const configContent = await readFile(configPath, "utf-8");
          const auditConfig = JSON.parse(configContent);
          
          if (auditConfig) {
            if (auditConfig.foundationReview && typeof auditConfig.foundationReview === 'object') {
              if (auditConfig.foundationReview.passThreshold !== undefined) {
                passThreshold = auditConfig.foundationReview.passThreshold;
                configLoaded = true;
              }
              if (auditConfig.foundationReview.dimensionFloor !== undefined) {
                dimensionFloor = auditConfig.foundationReview.dimensionFloor;
                configLoaded = true;
              }
            }
          }
          console.log(`Loaded audit config from direct path: passThreshold=${passThreshold}, dimensionFloor=${dimensionFloor}, configLoaded=${configLoaded}`);
        } catch (fileError) {
          console.warn(`Failed to load from direct path: ${fileError}`);
        }
      }
      
      // 如果未指定配置文件路径或加载失败，尝试使用书籍 ID
      if (!configLoaded && bookId) {
        try {
          console.log(`Loading audit config for book: ${bookId}`);
          // 尝试直接读取审计配置文件
          const bookDir = state.bookDir(bookId);
          console.log(`Book directory: ${bookDir}`);
          const configPath = join(bookDir, "audit-config.json");
          console.log(`Audit config path: ${configPath}`);
          
          // 检查文件是否存在
          try {
            await access(configPath);
            console.log(`Audit config file exists: ${configPath}`);
            
            // 读取文件内容
            const configContent = await readFile(configPath, "utf-8");
            console.log(`Read audit config file, length: ${configContent.length}`);
            
            // 解析配置
            const auditConfig = JSON.parse(configContent);
            console.log(`Parsed audit config: ${JSON.stringify(auditConfig, null, 2)}`);
            
            if (auditConfig) {
              // 检查基础审核标准
              if (auditConfig.passCriteria && typeof auditConfig.passCriteria === 'object') {
                if (auditConfig.passCriteria.scoringRules && typeof auditConfig.passCriteria.scoringRules === 'object') {
                  if (auditConfig.passCriteria.scoringRules.minPassScore !== undefined) {
                    passThreshold = auditConfig.passCriteria.scoringRules.minPassScore;
                    configLoaded = true;
                  }
                }
              }
              // 检查foundationReview部分
              if (auditConfig.foundationReview && typeof auditConfig.foundationReview === 'object') {
                if (auditConfig.foundationReview.passThreshold !== undefined) {
                  passThreshold = auditConfig.foundationReview.passThreshold;
                  configLoaded = true;
                } else if (auditConfig.foundationReview.minScore !== undefined) {
                  passThreshold = auditConfig.foundationReview.minScore;
                  configLoaded = true;
                }
                if (auditConfig.foundationReview.dimensionFloor !== undefined) {
                  dimensionFloor = auditConfig.foundationReview.dimensionFloor;
                  configLoaded = true;
                } else if (auditConfig.foundationReview.minDimensionScore !== undefined) {
                  dimensionFloor = auditConfig.foundationReview.minDimensionScore;
                  configLoaded = true;
                }
              }
            }
          } catch (fileError) {
            console.warn(`Failed to access or read audit config file: ${fileError}`);
          }
          
          console.log(`Loaded audit config: passThreshold=${passThreshold}, dimensionFloor=${dimensionFloor}, configLoaded=${configLoaded}`);
        } catch (e) {
          console.warn("Failed to load audit config:", e);
        }
      }
      
      // 计算总分
      const totalScore = testScores.length > 0
        ? Math.round(testScores.reduce((sum: number, score: number) => sum + score, 0) / testScores.length)
        : 0;
      
      // 检查是否有维度分数低于最低分
      const anyBelowFloor = testScores.some((score: number) => score < dimensionFloor);
      
      // 检查是否通过审核
      const passed = totalScore >= passThreshold && !anyBelowFloor;
      
      return c.json({
        passThreshold,
        dimensionFloor,
        testScores,
        totalScore,
        anyBelowFloor,
        passed,
        configLoaded
      });
    } catch (e) {
      console.error("Error in audit config test endpoint:", e);
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Audit ---

  app.post("/api/books/:id/audit/:chapter", async (c) => {
    const id = c.req.param("id");
    const chapterNum = parseInt(c.req.param("chapter"), 10);

    broadcast("audit:start", { bookId: id, chapter: chapterNum });
    try {
      const pipeline = new PipelineRunner(await buildPipelineConfig());
      const result = await pipeline.auditDraft(id, chapterNum);
      broadcast("audit:complete", { bookId: id, chapter: chapterNum, passed: result.passed });
      return c.json(result);
    } catch (e) {
      broadcast("audit:error", { bookId: id, error: String(e) });
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Revise ---

  app.post("/api/books/:id/revise/:chapter", async (c) => {
    const id = c.req.param("id");
    const chapterNum = parseInt(c.req.param("chapter"), 10);
    const body: { mode?: string; brief?: string } = await c.req
      .json<{ mode?: string; brief?: string }>()
      .catch(() => ({ mode: "spot-fix" }));

    broadcast("revise:start", { bookId: id, chapter: chapterNum });
    try {
      const pipeline = new PipelineRunner(await buildPipelineConfig());
      const result = await pipeline.reviseDraft(
        id,
        chapterNum,
        (body.mode ?? "spot-fix") as "spot-fix" | "polish" | "rewrite" | "rework" | "anti-detect",
        body.brief,
      );
      broadcast("revise:complete", { bookId: id, chapter: chapterNum });
      return c.json(result);
    } catch (e) {
      broadcast("revise:error", { bookId: id, error: String(e) });
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Export ---

  app.get("/api/books/:id/export", async (c) => {
    const id = c.req.param("id");
    const format = (c.req.query("format") ?? "txt") as string;
    const approvedOnly = c.req.query("approvedOnly") === "true";
    const bookDir = state.bookDir(id);
    const chaptersDir = join(bookDir, "chapters");

    try {
      const book = await state.loadBookConfig(id);
      const index = await state.loadChapterIndex(id);
      const approvedNums = new Set(
        approvedOnly ? index.filter((ch) => ch.status === "approved").map((ch) => ch.number) : [],
      );

      const files = await readdir(chaptersDir);
      const mdFiles = files.filter((f) => f.endsWith(".md") && /^\d{4}/.test(f)).sort();

      const filteredFiles = approvedOnly
        ? mdFiles.filter((f) => approvedNums.has(parseInt(f.slice(0, 4), 10)))
        : mdFiles;

      const contents = await Promise.all(
        filteredFiles.map((f) => readFile(join(chaptersDir, f), "utf-8")),
      );

      if (format === "epub") {
        // Basic EPUB: XHTML container
        const chapters = contents.map((content, i) => {
          const title = content.match(/^#\s+(.+)$/m)?.[1] ?? `Chapter ${i + 1}`;
          const html = content.split("\n").filter((l) => !l.startsWith("#")).map((l) => l.trim() ? `<p>${l}</p>` : "").join("\n");
          return { title, html };
        });
        const toc = chapters.map((ch, i) => `<li><a href="#ch${i}">${ch.title}</a></li>`).join("\n");
        const body = chapters.map((ch, i) => `<h2 id="ch${i}">${ch.title}</h2>\n${ch.html}`).join("\n<hr/>\n");
        const epub = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${book.title}</title><style>body{font-family:serif;max-width:40em;margin:auto;padding:2em;line-height:1.8}h2{margin-top:3em}</style></head><body><h1>${book.title}</h1><nav><ol>${toc}</ol></nav><hr/>${body}</body></html>`;
        return new Response(epub, {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Content-Disposition": `attachment; filename="${id}.html"`,
          },
        });
      }
      if (format === "md") {
        const body = contents.join("\n\n---\n\n");
        return new Response(body, {
          headers: {
            "Content-Type": "text/markdown; charset=utf-8",
            "Content-Disposition": `attachment; filename="${id}.md"`,
          },
        });
      }
      // Default: txt
      const body = contents.join("\n\n");
      return new Response(body, {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Content-Disposition": `attachment; filename="${id}.txt"`,
        },
      });
    } catch {
      return c.json({ error: "Export failed" }, 500);
    }
  });

  // --- Export to file (save to project dir) ---

  app.post("/api/books/:id/export-save", async (c) => {
    const id = c.req.param("id");
    const { format, approvedOnly } = await c.req.json<{ format?: string; approvedOnly?: boolean }>().catch(() => ({ format: "txt", approvedOnly: false }));
    const bookDir = state.bookDir(id);
    const chaptersDir = join(bookDir, "chapters");
    const fmt = format ?? "txt";

    try {
      const book = await state.loadBookConfig(id);
      const index = await state.loadChapterIndex(id);
      const approvedNums = new Set(
        approvedOnly ? index.filter((ch) => ch.status === "approved").map((ch) => ch.number) : [],
      );

      const files = await readdir(chaptersDir);
      const mdFiles = files.filter((f) => f.endsWith(".md") && /^\d{4}/.test(f)).sort();
      const filteredFiles = approvedOnly
        ? mdFiles.filter((f) => approvedNums.has(parseInt(f.slice(0, 4), 10)))
        : mdFiles;
      const contents = await Promise.all(
        filteredFiles.map((f) => readFile(join(chaptersDir, f), "utf-8")),
      );

      const { writeFile: writeFileFs } = await import("node:fs/promises");
      let outputPath: string;
      let body: string;

      if (fmt === "md") {
        body = contents.join("\n\n---\n\n");
        outputPath = join(bookDir, `${id}.md`);
      } else if (fmt === "epub") {
        const chapters = contents.map((content, i) => {
          const title = content.match(/^#\s+(.+)$/m)?.[1] ?? `Chapter ${i + 1}`;
          const html = content.split("\n").filter((l) => !l.startsWith("#")).map((l) => l.trim() ? `<p>${l}</p>` : "").join("\n");
          return { title, html };
        });
        const toc = chapters.map((ch, i) => `<li><a href="#ch${i}">${ch.title}</a></li>`).join("\n");
        const chapterHtml = chapters.map((ch, i) => `<h2 id="ch${i}">${ch.title}</h2>\n${ch.html}`).join("\n<hr/>\n");
        body = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${book.title}</title><style>body{font-family:serif;max-width:40em;margin:auto;padding:2em;line-height:1.8}h2{margin-top:3em}</style></head><body><h1>${book.title}</h1><nav><ol>${toc}</ol></nav><hr/>${chapterHtml}</body></html>`;
        outputPath = join(bookDir, `${id}.html`);
      } else {
        body = contents.join("\n\n");
        outputPath = join(bookDir, `${id}.txt`);
      }

      await writeFileFs(outputPath, body, "utf-8");
      return c.json({ ok: true, path: outputPath, format: fmt, chapters: filteredFiles.length });
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Batch Export ---

  app.post("/api/batch/export", async (c) => {
    const { bookIds, format, approvedOnly } = await c.req.json<{
      bookIds?: string[];
      format?: string;
      approvedOnly?: boolean;
    }>().catch(() => ({ bookIds: [], format: "txt", approvedOnly: false }));

    if (!bookIds || bookIds.length === 0) {
      return c.json({ error: "bookIds is required" }, 400);
    }

    const results = [];
    const errors = [];

    for (const id of bookIds) {
      try {
        const bookDir = state.bookDir(id);
        const chaptersDir = join(bookDir, "chapters");
        const fmt = format ?? "txt";

        const book = await state.loadBookConfig(id);
        const index = await state.loadChapterIndex(id);
        const approvedNums = new Set(
          approvedOnly ? index.filter((ch) => ch.status === "approved").map((ch) => ch.number) : [],
        );

        const files = await readdir(chaptersDir);
        const mdFiles = files.filter((f) => f.endsWith(".md") && /^\d{4}/.test(f)).sort();
        const filteredFiles = approvedOnly
          ? mdFiles.filter((f) => approvedNums.has(parseInt(f.slice(0, 4), 10)))
          : mdFiles;
        const contents = await Promise.all(
          filteredFiles.map((f) => readFile(join(chaptersDir, f), "utf-8")),
        );

        const { writeFile: writeFileFs } = await import("node:fs/promises");
        let outputPath: string;
        let body: string;

        if (fmt === "md") {
          body = contents.join("\n\n---\n\n");
          outputPath = join(bookDir, `${id}.md`);
        } else if (fmt === "epub") {
          const chapters = contents.map((content, i) => {
            const title = content.match(/^#\s+(.+)$/m)?.[1] ?? `Chapter ${i + 1}`;
            const html = content.split("\n").filter((l) => !l.startsWith("#")).map((l) => l.trim() ? `<p>${l}</p>` : "").join("\n");
            return { title, html };
          });
          const toc = chapters.map((ch, i) => `<li><a href="#ch${i}">${ch.title}</a></li>`).join("\n");
          const chapterHtml = chapters.map((ch, i) => `<h2 id="ch${i}">${ch.title}</h2>\n${ch.html}`).join("\n<hr/>\n");
          body = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${book.title}</title><style>body{font-family:serif;max-width:40em;margin:auto;padding:2em;line-height:1.8}h2{margin-top:3em}</style></head><body><h1>${book.title}</h1><nav><ol>${toc}</ol></nav><hr/>${chapterHtml}</body></html>`;
          outputPath = join(bookDir, `${id}.html`);
        } else {
          body = contents.join("\n\n");
          outputPath = join(bookDir, `${id}.txt`);
        }

        await writeFileFs(outputPath, body, "utf-8");
        results.push({ bookId: id, ok: true, path: outputPath, format: fmt, chapters: filteredFiles.length });
      } catch (e) {
        errors.push({ bookId: id, error: String(e) });
      }
    }

    broadcast("batch:export:complete", { exported: results.length, failed: errors.length });
    return c.json({
      ok: errors.length === 0,
      exported: results.length,
      failed: errors.length,
      results,
      errors,
    });
  });

  // --- Genre detail + copy ---

  app.get("/api/genres/:id", async (c) => {
    const genreId = c.req.param("id");
    try {
      const { readGenreProfile } = await import("@actalk/inkos-core");
      const { profile, body } = await readGenreProfile(root, genreId);
      return c.json({ profile, body });
    } catch (e) {
      return c.json({ error: String(e) }, 404);
    }
  });

  app.post("/api/genres/:id/copy", async (c) => {
    const genreId = c.req.param("id");
    if (/[/\\\0]/.test(genreId) || genreId.includes("..")) {
      throw new ApiError(400, "INVALID_GENRE_ID", `Invalid genre ID: "${genreId}"`);
    }
    try {
      const { getBuiltinGenresDir } = await import("@actalk/inkos-core");
      const { mkdir: mkdirFs, copyFile } = await import("node:fs/promises");
      const builtinDir = getBuiltinGenresDir();
      const projectGenresDir = join(root, "genres");
      await mkdirFs(projectGenresDir, { recursive: true });
      await copyFile(join(builtinDir, `${genreId}.md`), join(projectGenresDir, `${genreId}.md`));
      return c.json({ ok: true, path: `genres/${genreId}.md` });
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Model overrides ---

  app.get("/api/project/model-overrides", async (c) => {
    const raw = JSON.parse(await readFile(join(root, "inkos.json"), "utf-8"));
    return c.json({ overrides: raw.modelOverrides ?? {} });
  });

  app.put("/api/project/model-overrides", async (c) => {
    const { overrides } = await c.req.json<{ overrides: Record<string, unknown> }>();
    const configPath = join(root, "inkos.json");
    const raw = JSON.parse(await readFile(configPath, "utf-8"));
    raw.modelOverrides = overrides;
    const { writeFile: writeFileFs } = await import("node:fs/promises");
    await writeFileFs(configPath, JSON.stringify(raw, null, 2), "utf-8");
    return c.json({ ok: true });
  });

  // --- Notify channels ---

  app.get("/api/project/notify", async (c) => {
    const raw = JSON.parse(await readFile(join(root, "inkos.json"), "utf-8"));
    return c.json({ channels: raw.notify ?? [] });
  });

  app.put("/api/project/notify", async (c) => {
    const { channels } = await c.req.json<{ channels: unknown[] }>();
    const configPath = join(root, "inkos.json");
    const raw = JSON.parse(await readFile(configPath, "utf-8"));
    raw.notify = channels;
    const { writeFile: writeFileFs } = await import("node:fs/promises");
    await writeFileFs(configPath, JSON.stringify(raw, null, 2), "utf-8");
    return c.json({ ok: true });
  });

  // --- RAG Status & Supplement ---

  // 获取书籍RAG状态
  app.get("/api/books/:id/rag-status", async (c) => {
    const id = c.req.param("id");
    try {
      const { createRAGStatusManager } = await import("@actalk/inkos-core");
      const bookDir = state.bookDir(id);
      const statusManager = await createRAGStatusManager(bookDir, id);
      const status = await statusManager.load();
      
      // 获取章节列表
      const chapters = await state.loadChapterIndex(id);
      const chapterNumbers = chapters.map(ch => ch.number);
      
      // 检查状态
      const checkResult = await statusManager.checkStatus(chapterNumbers);
      
      return c.json({
        status,
        check: checkResult,
      });
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // 检测并补充RAG索引
  app.post("/api/books/:id/rag-supplement", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json<{ forceReindex?: boolean }>().catch(() => ({ forceReindex: false }));
    
    broadcast("rag:supplement:start", { bookId: id });
    
    try {
      const { createRAGStatusManager, createRAGManager, createRAGIndexer } = await import("@actalk/inkos-core");
      const bookDir = state.bookDir(id);
      const chapters = await state.loadChapterIndex(id);
      const chapterNumbers = chapters.map(ch => ch.number);
      
      // 初始化RAG管理器
      const projectConfig = await loadCurrentProjectConfig();
      const vectorRetrievalConfig = (projectConfig as unknown as { vectorRetrieval?: VectorRetrievalConfig }).vectorRetrieval;

      if (!vectorRetrievalConfig?.enabled) {
        return c.json({ error: "RAG is not enabled in project config" }, 400);
      }

      const ragManager = await createRAGManager({
        bookDir,
        config: vectorRetrievalConfig,
      });

      if (!ragManager.isAvailable()) {
        const modelConfig = vectorRetrievalConfig.model;
        const modelType = modelConfig?.type || "unknown";
        let apiKeyEnv = "";
        switch (modelType) {
          case "openai":
            apiKeyEnv = "OPENAI_API_KEY";
            break;
          case "siliconflow":
            apiKeyEnv = "SILICONFLOW_API_KEY";
            break;
          case "mota":
            apiKeyEnv = "MOTA_API_KEY";
            break;
          case "modelscope":
            apiKeyEnv = "MODELSCOPE_API_KEY";
            break;
          case "zhipu":
            apiKeyEnv = "ZHIPU_API_KEY";
            break;
          case "dashscope":
            apiKeyEnv = "DASHSCOPE_API_KEY";
            break;
          case "lmstudio":
          case "local":
            apiKeyEnv = "(local model, no API key required)";
            break;
          default:
            apiKeyEnv = "<unknown>";
        }
        return c.json({
          error: "RAG manager is not available",
          details: `Embedding client '${modelType}' is not available. Please check:\n1. RAG_ENABLED is set to 'true' in environment\n2. ${apiKeyEnv ? `${apiKeyEnv} is set in .env file` : "API key is configured"}\n3. For local models (lmstudio/ollama), ensure the service is running`,
          modelType,
          config: {
            enabled: vectorRetrievalConfig.enabled,
            modelType: modelConfig?.type,
            model: modelConfig?.model,
            hasApiKey: !!modelConfig?.apiKey,
          },
        }, 500);
      }
      
      const statusManager = await createRAGStatusManager(bookDir, id);
      const indexer = createRAGIndexer(ragManager, statusManager);
      
      // 检查结果
      const checkResult = await statusManager.checkStatus(chapterNumbers);
      
      // 补充缺失的章节
      const missingChapters = checkResult.chapters.filter(c => c.status === "missing");
      const results: Array<{ chapter: number; success: boolean; error?: string }> = [];
      
      if (missingChapters.length > 0 || body.forceReindex) {
        const targetChapters = body.forceReindex ? chapterNumbers : missingChapters.map(c => c.chapter);
        
        for (let i = 0; i < targetChapters.length; i++) {
          const chapter = targetChapters[i];
          broadcast("rag:supplement:progress", { 
            bookId: id, 
            current: i + 1, 
            total: targetChapters.length, 
            chapter 
          });
          
          try {
            const chapterPath = join(bookDir, "chapters", `chapter_${String(chapter).padStart(3, "0")}.md`);
            const content = await readFile(chapterPath, "utf-8");
            await indexer.indexChapter(chapter, content, { chapter });
            results.push({ chapter, success: true });
          } catch (error) {
            results.push({ 
              chapter, 
              success: false, 
              error: error instanceof Error ? error.message : String(error) 
            });
          }
        }
      }
      
      broadcast("rag:supplement:complete", { 
        bookId: id, 
        checked: checkResult.summary.total,
        missing: checkResult.summary.missing,
        indexed: results.filter(r => r.success).length,
        failed: results.filter(r => !r.success).length,
      });
      
      return c.json({
        ok: true,
        checked: checkResult.summary.total,
        foundationStatus: checkResult.foundationStatus,
        summary: checkResult.summary,
        results,
      });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      broadcast("rag:supplement:error", { bookId: id, error });
      return c.json({ error }, 500);
    }
  });

  // 重建RAG索引（清空后重新索引）
  app.post("/api/books/:id/rag-rebuild", async (c) => {
    const id = c.req.param("id");
    
    broadcast("rag:rebuild:start", { bookId: id });
    
    try {
      const { createRAGStatusManager, createRAGManager, createRAGIndexer, createDocumentProcessor } = await import("@actalk/inkos-core");
      const bookDir = state.bookDir(id);
      const chapters = await state.loadChapterIndex(id);
      const chapterNumbers = chapters.map(ch => ch.number);
      
      // 初始化RAG管理器
      const projectConfig = await loadCurrentProjectConfig();
      const vectorRetrievalConfig = (projectConfig as unknown as { vectorRetrieval?: VectorRetrievalConfig }).vectorRetrieval;

      if (!vectorRetrievalConfig?.enabled) {
        return c.json({ error: "RAG is not enabled in project config" }, 400);
      }

      const ragManager = await createRAGManager({
        bookDir,
        config: vectorRetrievalConfig,
      });

      if (!ragManager.isAvailable()) {
        const modelConfig = vectorRetrievalConfig.model;
        const modelType = modelConfig?.type || "unknown";
        let apiKeyEnv = "";
        switch (modelType) {
          case "openai":
            apiKeyEnv = "OPENAI_API_KEY";
            break;
          case "siliconflow":
            apiKeyEnv = "SILICONFLOW_API_KEY";
            break;
          case "mota":
            apiKeyEnv = "MOTA_API_KEY";
            break;
          case "modelscope":
            apiKeyEnv = "MODELSCOPE_API_KEY";
            break;
          case "zhipu":
            apiKeyEnv = "ZHIPU_API_KEY";
            break;
          case "dashscope":
            apiKeyEnv = "DASHSCOPE_API_KEY";
            break;
          case "lmstudio":
          case "local":
            apiKeyEnv = "(local model, no API key required)";
            break;
          default:
            apiKeyEnv = "<unknown>";
        }
        return c.json({
          error: "RAG manager is not available",
          details: `Embedding client '${modelType}' is not available. Please check:\n1. RAG_ENABLED is set to 'true' in environment\n2. ${apiKeyEnv ? `${apiKeyEnv} is set in .env file` : "API key is configured"}\n3. For local models (lmstudio/local), ensure the service is running`,
          modelType,
          config: {
            enabled: vectorRetrievalConfig.enabled,
            modelType: modelConfig?.type,
            model: modelConfig?.model,
            hasApiKey: !!modelConfig?.apiKey,
          },
        }, 500);
      }

      const statusManager = await createRAGStatusManager(bookDir, id);
      const indexer = createRAGIndexer(ragManager, statusManager);
      
      // 清空索引
      await ragManager.clearIndex();
      await statusManager.reset();
      
      // 重新索引基础设定
      const foundationFiles = ["story_bible.md", "volume_outline.md", "book_rules.md"];
      const foundationDocumentIds: string[] = [];
      for (const file of foundationFiles) {
        try {
          const content = await readFile(join(bookDir, "story", file), "utf-8");
          const chunks = createDocumentProcessor().processDocument(content, {
            fileName: file,
            type: "foundation",
            category: file.replace(".md", ""),
          });
          await (ragManager as any).vectorStore.addChunks(chunks);
          // 收集文档ID用于更新状态
          foundationDocumentIds.push(...chunks.map((c: { id: string }) => c.id));
        } catch {
          // 文件可能不存在，跳过
        }
      }
      // 更新基础设定索引状态
      if (foundationDocumentIds.length > 0) {
        await statusManager.markFoundationIndexed(foundationDocumentIds);
      }
      
      // 重新索引所有章节
      const results: Array<{ chapter: number; success: boolean; error?: string }> = [];
      
      for (let i = 0; i < chapterNumbers.length; i++) {
        const chapter = chapterNumbers[i];
        broadcast("rag:rebuild:progress", { 
          bookId: id, 
          current: i + 1, 
          total: chapterNumbers.length, 
          chapter 
        });
        
        try {
          const chapterPath = join(bookDir, "chapters", `chapter_${String(chapter).padStart(3, "0")}.md`);
          const content = await readFile(chapterPath, "utf-8");
          await indexer.indexChapter(chapter, content, { chapter });
          results.push({ chapter, success: true });
        } catch (error) {
          results.push({ 
            chapter, 
            success: false, 
            error: error instanceof Error ? error.message : String(error) 
          });
        }
      }
      
      broadcast("rag:rebuild:complete", { 
        bookId: id, 
        total: chapterNumbers.length,
        indexed: results.filter(r => r.success).length,
        failed: results.filter(r => !r.success).length,
      });
      
      return c.json({
        ok: true,
        total: chapterNumbers.length,
        indexed: results.filter(r => r.success).length,
        failed: results.filter(r => !r.success).length,
        results,
      });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      broadcast("rag:rebuild:error", { bookId: id, error });
      return c.json({ error }, 500);
    }
  });

  // --- AIGC Detection ---

  app.post("/api/books/:id/detect/:chapter", async (c) => {
    const id = c.req.param("id");
    const chapterNum = parseInt(c.req.param("chapter"), 10);
    const bookDir = state.bookDir(id);

    try {
      const chaptersDir = join(bookDir, "chapters");
      const files = await readdir(chaptersDir);
      const paddedNum = String(chapterNum).padStart(4, "0");
      const match = files.find((f) => f.startsWith(paddedNum) && f.endsWith(".md"));
      if (!match) return c.json({ error: "Chapter not found" }, 404);

      const content = await readFile(join(chaptersDir, match), "utf-8");
      const { analyzeAITells } = await import("@actalk/inkos-core");
      const result = analyzeAITells(content);
      return c.json({ chapterNumber: chapterNum, ...result });
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Truth file edit ---

  app.put("/api/books/:id/truth/:file", async (c) => {
    const id = c.req.param("id");
    const file = c.req.param("file");
    if (!TRUTH_FILES.includes(file)) {
      return c.json({ error: "Invalid truth file" }, 400);
    }
    const { content } = await c.req.json<{ content: string }>();
    const bookDir = state.bookDir(id);
    const { writeFile: writeFileFs, mkdir: mkdirFs } = await import("node:fs/promises");
    await mkdirFs(join(bookDir, "story"), { recursive: true });
    await writeFileFs(join(bookDir, "story", file), content, "utf-8");
    return c.json({ ok: true });
  });

  // =============================================
  // NEW ENDPOINTS — CLI parity
  // =============================================

  // --- Book Delete ---

  app.delete("/api/books/:id", async (c) => {
    const id = c.req.param("id");
    try {
      const { rm } = await import("node:fs/promises");
      
      // 尝试删除正式的书籍目录
      const bookDir = state.bookDir(id);
      await rm(bookDir, { recursive: true, force: true }).catch(() => undefined);
      
      // 尝试删除对应的临时目录
      const booksDir = join(root, "books");
      try {
        const files = await readdir(booksDir);
        const tempDirs = files.filter(f => f.startsWith(".tmp-book-create-") && f.includes(id));
        for (const tempDirName of tempDirs) {
          const tempDir = join(booksDir, tempDirName);
          await rm(tempDir, { recursive: true, force: true });
        }
      } catch (tempError) {
        // 临时目录不存在，忽略错误
      }
      
      broadcast("book:deleted", { bookId: id });
      return c.json({ ok: true, bookId: id });
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Book Update ---

  app.put("/api/books/:id", async (c) => {
    const id = c.req.param("id");
    const updates = await c.req.json<{
      chapterWordCount?: number;
      targetChapters?: number;
      status?: string;
      language?: string;
    }>();
    try {
      const book = await state.loadBookConfig(id);
      const updated = {
        ...book,
        ...(updates.chapterWordCount !== undefined ? { chapterWordCount: Number(updates.chapterWordCount) } : {}),
        ...(updates.targetChapters !== undefined ? { targetChapters: Number(updates.targetChapters) } : {}),
        ...(updates.status !== undefined ? { status: updates.status as typeof book.status } : {}),
        ...(updates.language !== undefined ? { language: updates.language as "zh" | "en" } : {}),
        updatedAt: new Date().toISOString(),
      };
      await state.saveBookConfig(id, updated);
      return c.json({ ok: true, book: updated });
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Write Rewrite (specific chapter) ---

  app.post("/api/books/:id/rewrite/:chapter", async (c) => {
    const id = c.req.param("id");
    const chapterNum = parseInt(c.req.param("chapter"), 10);
    const body: { brief?: string } = await c.req
      .json<{ brief?: string }>()
      .catch(() => ({}));

    broadcast("rewrite:start", { bookId: id, chapter: chapterNum });
    try {
      const pipeline = new PipelineRunner(await buildPipelineConfig({
        externalContext: body.brief,
      }));
      pipeline.reviseDraft(id, chapterNum, "rewrite").then(
        (result) => broadcast("rewrite:complete", { bookId: id, chapterNumber: result.chapterNumber, wordCount: result.wordCount }),
        (e) => broadcast("rewrite:error", { bookId: id, error: e instanceof Error ? e.message : String(e) }),
      );
      return c.json({ status: "rewriting", bookId: id, chapter: chapterNum });
    } catch (e) {
      broadcast("rewrite:error", { bookId: id, error: String(e) });
      return c.json({ error: String(e) }, 500);
    }
  });

  app.post("/api/books/:id/resync/:chapter", async (c) => {
    const id = c.req.param("id");
    const chapterNum = parseInt(c.req.param("chapter"), 10);
    const body: { brief?: string } = await c.req
      .json<{ brief?: string }>()
      .catch(() => ({}));

    try {
      const pipeline = new PipelineRunner(await buildPipelineConfig({
        externalContext: body.brief,
      }));
      const result = await pipeline.resyncChapterArtifacts(id, chapterNum);
      return c.json(result);
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Delete Chapter ---  

  app.delete("/api/books/:id/chapters/:chapter", async (c) => {
    const id = c.req.param("id");
    const chapterNum = parseInt(c.req.param("chapter"), 10);

    try {
      const bookDir = state.bookDir(id);
      const chaptersDir = join(bookDir, "chapters");
      const files = await readdir(chaptersDir);
      const paddedNum = String(chapterNum).padStart(4, "0");
      const chapterFile = files.find((f) => f.startsWith(paddedNum) && f.endsWith(".md"));

      if (!chapterFile) {
        return c.json({ error: `Chapter ${chapterNum} not found` }, 404);
      }

      // Delete chapter file
      await unlink(join(chaptersDir, chapterFile));

      // Update chapter index
      const index = await state.loadChapterIndex(id);
      const updatedIndex = index.filter((ch) => ch.number !== chapterNum);
      await state.saveChapterIndex(id, updatedIndex);

      return c.json({ status: "deleted", bookId: id, chapter: chapterNum });
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Update Chapter Order ---  

  app.put("/api/books/:id/chapters/order", async (c) => {
    const id = c.req.param("id");
    const body: { chapters: Array<{ number: number; newNumber: number }> } = await c.req
      .json<{ chapters: Array<{ number: number; newNumber: number }> }>()
      .catch(() => ({ chapters: [] }));

    try {
      const bookDir = state.bookDir(id);
      const chaptersDir = join(bookDir, "chapters");
      const files = await readdir(chaptersDir);
      const index = await state.loadChapterIndex(id);

      // Update chapter files and index
      const updatedIndex = [...index];
      
      // Process chapters in reverse order to avoid conflicts
      for (const { number, newNumber } of body.chapters.sort((a, b) => b.number - a.number)) {
        // Find chapter in index
        const chapterIndex = updatedIndex.findIndex((ch) => ch.number === number);
        if (chapterIndex === -1) continue;

        // Find chapter file
        const oldPaddedNum = String(number).padStart(4, "0");
        const chapterFile = files.find((f) => f.startsWith(oldPaddedNum) && f.endsWith(".md"));
        if (!chapterFile) continue;

        // Rename chapter file
        const newPaddedNum = String(newNumber).padStart(4, "0");
        const newFileName = chapterFile.replace(oldPaddedNum, newPaddedNum);
        await rename(join(chaptersDir, chapterFile), join(chaptersDir, newFileName));

        // Update chapter number in index
        updatedIndex[chapterIndex] = {
          ...updatedIndex[chapterIndex],
          number: newNumber,
        };
      }

      // Sort index by chapter number
      updatedIndex.sort((a, b) => a.number - b.number);

      // Save updated index
      await state.saveChapterIndex(id, updatedIndex);

      return c.json({ status: "updated", bookId: id, chapters: body.chapters });
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Fix Chapter Order ---  

  // --- Volume and Chapter Planning ---  

  // Get volume outlines and chapter plans
  // Persistent storage for volume plans metadata (per book, in story directory)
  let volumePlansMeta: any = {};
  let metaInitialized = false;
  
  // Initialize metadata storage
  const initVolumePlansMeta = async () => {
    if (metaInitialized) return;
    
    try {
      // Load all existing metadata from book story directories
      const pipeline = new PipelineRunner(await buildPipelineConfig());
      const booksDir = pipeline["state"].booksDir;
      
      if (existsSync(booksDir)) {
        const books = await readdir(booksDir);
        for (const book of books) {
          const bookMetaPath = join(booksDir, book, "story", ".volume-plans-meta.json");
          if (existsSync(bookMetaPath)) {
            const content = await readFile(bookMetaPath, "utf-8");
            volumePlansMeta[book] = JSON.parse(content);
          }
        }
      }
    } catch (e) {
      console.warn("Failed to initialize volume plans metadata:", e);
    }
    
    metaInitialized = true;
  };
  
  // Save metadata to file (per book)
  const saveVolumePlansMeta = async (bookId: string) => {
    try {
      const pipeline = new PipelineRunner(await buildPipelineConfig());
      const bookDir = pipeline["state"].bookDir(bookId);
      const bookMetaPath = join(bookDir, "story", ".volume-plans-meta.json");
      
      await writeFile(bookMetaPath, JSON.stringify(volumePlansMeta[bookId], null, 2), "utf-8");
    } catch (e) {
      console.error("Failed to save volume plans metadata:", e);
    }
  };

  app.get("/api/books/:id/volume-plans", async (c) => {
    const id = c.req.param("id");

    // Initialize metadata storage
    await initVolumePlansMeta();

    // Check if we have cached metadata for this book
    const bookMeta = volumePlansMeta[id];
    if (bookMeta) {
      // Return cached metadata with generation status
      return c.json({ 
        ok: true, 
        volumePlans: bookMeta.volumePlans.map((vp: any) => ({
          ...vp,
          detailOutlineGenerated: vp.detailOutlineGenerated
        })),
        fromCache: true
      });
    }

    try {
      const pipeline = new PipelineRunner(await buildPipelineConfig());
      const book = await pipeline["state"].loadBookConfig(id);
      const bookDir = pipeline["state"].bookDir(id);
      const outlinePath = join(bookDir, "story", "volume_outline.md");
      
      try {
        const outlineContent = await readFile(outlinePath, "utf-8");
        
        // 使用 ArchitectAgent 辅助解析卷纲
        const { ArchitectAgent } = await import("@actalk/inkos-core");
        const ctx = {
          client: createLLMClient(cachedConfig.llm),
          model: cachedConfig.llm.model,
          projectRoot: root,
          bookId: id,
          logger: createLogger({ tag: "architect", sinks: [sseSink] }),
        };
        const architect = new ArchitectAgent(ctx);
        
        // 调用 ArchitectAgent 解析卷纲
        const parsedResult = await architect.parseVolumeOutline(outlineContent);
        
        // Check for existing volume detail files and update metadata
        const volumePlansWithStatus = await Promise.all(parsedResult.volumePlans.map(async (vp: any) => {
          const volumeDetailPath = join(bookDir, "story", `volume_${vp.volumeId}_detail.md`);
          let detailOutlineGenerated = false;
          let detailOutlineFile: string | undefined;
          
          try {
            await stat(volumeDetailPath);
            // File exists, mark as generated
            detailOutlineGenerated = true;
            detailOutlineFile = `volume_${vp.volumeId}_detail.md`;
          } catch {
            // File doesn't exist
            detailOutlineGenerated = false;
          }
          
          return {
            volumeId: vp.volumeId,
            title: vp.title,
            chapterRange: vp.chapterRange,
            detailOutlineGenerated,
            detailOutlineFile,
            lastGeneratedAt: detailOutlineGenerated ? new Date().toISOString() : undefined
          };
        }));
        
        // Save metadata to persistent storage
        volumePlansMeta[id] = {
          volumePlans: volumePlansWithStatus,
          lastParsedAt: new Date().toISOString()
        };
        await saveVolumePlansMeta(id);
        
        return c.json({ 
          ok: true, 
          volumePlans: volumePlansMeta[id].volumePlans,
          totalOutline: outlineContent,
          fromCache: false
        });
      } catch {
        return c.json({ ok: true, volumePlans: [], totalOutline: "" });
      }
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // Re-parse volume outline and update volume plans (useful after outline rewrite)
  app.post("/api/books/:id/reparse-volume-plans", async (c) => {
    const id = c.req.param("id");
    
    broadcast("volume-plans:reparse:start", { bookId: id });
    
    try {
      // Clear cached metadata to force re-parse
      if (volumePlansMeta[id]) {
        delete volumePlansMeta[id];
      }
      
      // Delete metadata file
      try {
        const pipeline = new PipelineRunner(await buildPipelineConfig());
        const bookDir = pipeline["state"].bookDir(id);
        const bookMetaPath = join(bookDir, "story", ".volume-plans-meta.json");
        if (existsSync(bookMetaPath)) {
          await unlink(bookMetaPath);
        }
      } catch (e) {
        console.warn("Failed to delete old metadata:", e);
      }
      
      // Re-initialize metadata (will re-parse from volume_outline.md)
      await initVolumePlansMeta();
      
      // Now the GET /api/books/:id/volume-plans will re-parse automatically
      // We just need to trigger it by calling the same logic
      const pipeline = new PipelineRunner(await buildPipelineConfig());
      const book = await pipeline["state"].loadBookConfig(id);
      const bookDir = pipeline["state"].bookDir(id);
      const outlinePath = join(bookDir, "story", "volume_outline.md");
      
      const outlineContent = await readFile(outlinePath, "utf-8");
      
      // 使用 ArchitectAgent 辅助解析卷纲
      const { ArchitectAgent } = await import("@actalk/inkos-core");
      const ctx = {
        client: createLLMClient(cachedConfig.llm),
        model: cachedConfig.llm.model,
        projectRoot: root,
        bookId: id,
        logger: createLogger({ tag: "architect", sinks: [sseSink] }),
      };
      const architect = new ArchitectAgent(ctx);
      
      // 调用 ArchitectAgent 解析卷纲
      const parsedResult = await architect.parseVolumeOutline(outlineContent);
      
      // Check for existing volume detail files and update metadata
      const volumePlansWithStatus = await Promise.all(parsedResult.volumePlans.map(async (vp: any) => {
        const volumeDetailPath = join(bookDir, "story", `volume_${vp.volumeId}_detail.md`);
        let detailOutlineGenerated = false;
        let detailOutlineFile: string | undefined;
        
        try {
          await stat(volumeDetailPath);
          detailOutlineGenerated = true;
          detailOutlineFile = `volume_${vp.volumeId}_detail.md`;
        } catch {
          detailOutlineGenerated = false;
        }
        
        return {
          volumeId: vp.volumeId,
          title: vp.title,
          chapterRange: vp.chapterRange,
          detailOutlineGenerated,
          detailOutlineFile,
          lastGeneratedAt: detailOutlineGenerated ? new Date().toISOString() : undefined
        };
      }));
      
      // Save metadata to persistent storage
      volumePlansMeta[id] = {
        volumePlans: volumePlansWithStatus,
        lastParsedAt: new Date().toISOString()
      };
      await saveVolumePlansMeta(id);
      
      broadcast("volume-plans:reparse:complete", { 
        bookId: id, 
        volumeCount: volumePlansWithStatus.length 
      });
      
      return c.json({ 
        ok: true, 
        message: `已根据最新卷纲重新拆分为 ${volumePlansWithStatus.length} 个分卷`,
        volumePlans: volumePlansWithStatus
      });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      broadcast("volume-plans:reparse:error", { bookId: id, error });
      return c.json({ error }, 500);
    }
  });

  // Get specific volume outline
  app.get("/api/books/:id/volumes/:volumeId/outline", async (c) => {
    const id = c.req.param("id");
    const volumeId = parseInt(c.req.param("volumeId"), 10);

    try {
      const pipeline = new PipelineRunner(await buildPipelineConfig());
      const bookDir = pipeline["state"].bookDir(id);
      const outlinePath = join(bookDir, "story", "volume_outline.md");
      
      try {
        const outlineContent = await readFile(outlinePath, "utf-8");
        // Find specific volume outline
        const volumeRegex = new RegExp(`### 第${volumeId}卷 ([^\\n]+)[\\\\s\\\\S]*?章节范围[：:](\\d+)-(\\d+)[\\\\s\\\\S]*?([\\\\s\\\\S]*?)(?=### 第\\d+卷|$)`);
        const match = volumeRegex.exec(outlineContent);
        
        if (match) {
          return c.json({
            ok: true,
            volumeId,
            title: match[1]?.trim() || `第${volumeId}卷`,
            chapterRange: {
              start: parseInt(match[2], 10),
              end: parseInt(match[3], 10)
            },
            outline: match[4]?.trim() || ""
          });
        } else {
          return c.json({ error: `Volume ${volumeId} not found` }, 404);
        }
      } catch {
        return c.json({ error: "Failed to read volume outline" }, 500);
      }
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // Get specific volume detail outline (generated by ArchitectAgent)
  app.get("/api/books/:id/volumes/:volumeId/detail-outline", async (c) => {
    const id = c.req.param("id");
    const volumeId = parseInt(c.req.param("volumeId"), 10);

    try {
      // Initialize metadata storage
      await initVolumePlansMeta();

      // Check if we have metadata for this book
      const bookMeta = volumePlansMeta[id];
      if (!bookMeta) {
        return c.json({
          ok: true,
          volumeId,
          exists: false,
          content: null
        });
      }

      // Find volume in metadata
      const volumeMeta = bookMeta.volumePlans.find((vp: any) => vp.volumeId === volumeId);
      if (!volumeMeta || !volumeMeta.detailOutlineGenerated || !volumeMeta.detailOutlineFile) {
        return c.json({
          ok: true,
          volumeId,
          exists: false,
          content: null
        });
      }

      // Read the file directly
      const pipeline = new PipelineRunner(await buildPipelineConfig());
      const bookDir = pipeline["state"].bookDir(id);
      const volumeDetailPath = join(bookDir, "story", volumeMeta.detailOutlineFile);
      
      try {
        const content = await readFile(volumeDetailPath, "utf-8");
        
        // File exists, ensure metadata is up to date
        if (!volumeMeta.detailOutlineGenerated || volumeMeta.detailOutlineFile !== `volume_${volumeId}_detail.md`) {
          volumeMeta.detailOutlineGenerated = true;
          volumeMeta.detailOutlineFile = `volume_${volumeId}_detail.md`;
          await saveVolumePlansMeta(id);
        }
        
        return c.json({
          ok: true,
          volumeId,
          exists: true,
          content
        });
      } catch {
        // File doesn't exist, update metadata
        volumeMeta.detailOutlineGenerated = false;
        delete volumeMeta.detailOutlineFile;
        await saveVolumePlansMeta(id);
        
        return c.json({
          ok: true,
          volumeId,
          exists: false,
          content: null
        });
      }
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // Get chapter plans for a specific volume
  app.get("/api/books/:id/volumes/:volumeId/chapter-plans", async (c) => {
    const id = c.req.param("id");
    const volumeId = parseInt(c.req.param("volumeId"), 10);

    try {
      const pipeline = new PipelineRunner(await buildPipelineConfig());
      const book = await pipeline["state"].loadBookConfig(id);
      const bookDir = pipeline["state"].bookDir(id);
      
      // Try to get chapter range from metadata first
      let startChapter: number | null = null;
      let endChapter: number | null = null;
      
      // Check metadata first
      if (volumePlansMeta[id]) {
        const volumeMeta = volumePlansMeta[id].volumePlans.find((vp: any) => vp.volumeId === volumeId);
        if (volumeMeta && volumeMeta.chapterRange) {
          startChapter = volumeMeta.chapterRange.start;
          endChapter = volumeMeta.chapterRange.end;
        }
      }
      
      // Fallback to parsing outline file if metadata doesn't have the info
      if (startChapter === null || endChapter === null) {
        const volumeDetailPath = join(bookDir, "story", `volume_${volumeId}_detail.md`);
        let outlineContent: string;
        
        try {
          outlineContent = await readFile(volumeDetailPath, "utf-8");
        } catch {
          // Fallback to regular volume outline
          const outlinePath = join(bookDir, "story", "volume_outline.md");
          outlineContent = await readFile(outlinePath, "utf-8");
        }
        
        // Parse chapter range from outline
        const volumeRegex = new RegExp(`### 第${volumeId}卷[\\\\s\\\\S]*?(?:章节范围|Chapter Range)[：:](\\d+)-(\\d+)`, "i");
        const match = volumeRegex.exec(outlineContent);
        if (!match) {
          return c.json({ error: `Volume ${volumeId} chapter range not found` }, 404);
        }
        
        startChapter = parseInt(match[1], 10);
        endChapter = parseInt(match[2], 10);
      }
      
      // Read chapter plans for this volume
      const chapterPlans = [];
      const runtimeDir = join(bookDir, "story", "runtime");
      
      // Read audit success and failure records
      const successPath = join(bookDir, "story", ".chapter-plan-audit-success.json");
      const failuresPath = join(bookDir, "story", ".chapter-plan-audit-failures.json");
      let successes: Record<string, any> = {};
      let failures: Record<string, any> = {};
      
      try {
        const content = await readFile(successPath, "utf-8");
        successes = JSON.parse(content);
      } catch {
        // File doesn't exist
      }
      
      try {
        const content = await readFile(failuresPath, "utf-8");
        failures = JSON.parse(content);
      } catch {
        // File doesn't exist
      }
      
      for (let chapterNum = startChapter; chapterNum <= endChapter; chapterNum++) {
        const chapterPlanPath = join(runtimeDir, `chapter-${String(chapterNum).padStart(4, "0")}.intent.md`);
        const chapterKey = String(chapterNum);
        
        try {
          const content = await readFile(chapterPlanPath, "utf-8");
          
          // Determine audit status
          let auditStatus: 'pending' | 'passed' | 'failed' = 'pending';
          if (successes[chapterKey]) {
            auditStatus = 'passed';
          } else if (failures[chapterKey]) {
            auditStatus = 'failed';
          }
          
          chapterPlans.push({
            chapterNumber: chapterNum,
            content,
            auditStatus
          });
        } catch {
          // Chapter plan doesn't exist yet
          chapterPlans.push({
            chapterNumber: chapterNum,
            content: null,
            notGenerated: true
          });
        }
      }
      
      return c.json({
        ok: true,
        volumeId,
        chapterRange: { start: startChapter, end: endChapter },
        chapterPlans
      });
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // Check if chapter plans exist for a volume
  app.get("/api/books/:id/volumes/:volumeId/chapter-plans-status", async (c) => {
    const id = c.req.param("id");
    const volumeId = parseInt(c.req.param("volumeId"), 10);

    try {
      const pipeline = new PipelineRunner(await buildPipelineConfig());
      const book = await pipeline["state"].loadBookConfig(id);
      const bookDir = pipeline["state"].bookDir(id);
      
      // Try to get chapter range from metadata first
      let startChapter: number | null = null;
      let endChapter: number | null = null;
      
      // Check metadata first
      if (volumePlansMeta[id]) {
        const volumeMeta = volumePlansMeta[id].volumePlans.find((vp: any) => vp.volumeId === volumeId);
        if (volumeMeta && volumeMeta.chapterRange) {
          startChapter = volumeMeta.chapterRange.start;
          endChapter = volumeMeta.chapterRange.end;
        }
      }
      
      // Fallback to parsing outline file if metadata doesn't have the info
      if (startChapter === null || endChapter === null) {
        const volumeDetailPath = join(bookDir, "story", `volume_${volumeId}_detail.md`);
        let outlineContent: string;
        
        try {
          outlineContent = await readFile(volumeDetailPath, "utf-8");
        } catch {
          // Fallback to regular volume outline
          const outlinePath = join(bookDir, "story", "volume_outline.md");
          outlineContent = await readFile(outlinePath, "utf-8");
        }
        
        // Parse chapter range from outline
        const volumeRegex = new RegExp(`### 第${volumeId}卷[\\\\s\\\\S]*?(?:章节范围|Chapter Range)[：:](\\d+)-(\\d+)`, "i");
        const match = volumeRegex.exec(outlineContent);
        if (!match) {
          return c.json({ error: `Volume ${volumeId} chapter range not found` }, 404);
        }
        
        startChapter = parseInt(match[1], 10);
        endChapter = parseInt(match[2], 10);
      }
      
      // Check if all chapter plans exist
      const runtimeDir = join(bookDir, "story", "runtime");
      let allGenerated = true;
      let generatedCount = 0;
      
      for (let chapterNum = startChapter; chapterNum <= endChapter; chapterNum++) {
        const chapterPlanPath = join(runtimeDir, `chapter-${String(chapterNum).padStart(4, "0")}.intent.md`);
        try {
          await readFile(chapterPlanPath, "utf-8");
          generatedCount++;
        } catch {
          allGenerated = false;
        }
      }
      
      return c.json({
        ok: true,
        volumeId,
        chapterRange: { start: startChapter, end: endChapter },
        totalChapters: endChapter - startChapter + 1,
        generatedCount,
        allGenerated,
        hasSomeGenerated: generatedCount > 0
      });
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // Get chapter plan audit failures for a volume
  app.get("/api/books/:id/volumes/:volumeId/chapter-plan-audit-failures", async (c) => {
    const id = c.req.param("id");
    const volumeId = parseInt(c.req.param("volumeId"), 10);

    try {
      const pipeline = new PipelineRunner(await buildPipelineConfig());
      const bookDir = pipeline["state"].bookDir(id);
      
      // Read audit failures from metadata file
      const failuresPath = join(bookDir, "story", ".chapter-plan-audit-failures.json");
      let failures: Record<string, unknown> = {};
      
      try {
        const content = await readFile(failuresPath, "utf-8");
        const allFailures = JSON.parse(content);
        
        // Get chapter range for this volume
        const metaPath = join(bookDir, "story", ".volume-plans-meta.json");
        let startChapter = 1;
        let endChapter = 1;
        
        try {
          const metaContent = await readFile(metaPath, "utf-8");
          const meta = JSON.parse(metaContent);
          const volumeMeta = meta.volumePlans?.find((vp: any) => vp.volumeId === volumeId);
          if (volumeMeta?.chapterRange) {
            startChapter = volumeMeta.chapterRange.start;
            endChapter = volumeMeta.chapterRange.end;
          }
        } catch {
          // Fallback: try to parse from outline
          const detailPath = join(bookDir, "story", `volume_${volumeId}_detail.md`);
          try {
            const detailContent = await readFile(detailPath, "utf-8");
            const rangeMatch = detailContent.match(/章节范围[：:]\s*(?:第)?(\d+)[\s-]*(?:章)?[\s-]*(?:第)?(\d+)(?:章)?/i);
            if (rangeMatch) {
              startChapter = parseInt(rangeMatch[1], 10);
              endChapter = parseInt(rangeMatch[2], 10);
            }
          } catch {
            // Ignore
          }
        }
        
        // Filter failures for this volume's chapters
        for (let chapterNum = startChapter; chapterNum <= endChapter; chapterNum++) {
          const key = String(chapterNum);
          if (allFailures[key]) {
            failures[key] = allFailures[key];
          }
        }
      } catch {
        // File doesn't exist, return empty failures
      }
      
      return c.json({ ok: true, volumeId, failures });
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // Generate missing chapter plans for failed audits
  app.post("/api/books/:id/volumes/:volumeId/generate-missing-plans", async (c) => {
    const id = c.req.param("id");
    const volumeId = parseInt(c.req.param("volumeId"), 10);

    // Create file log stream for this operation
    const logPath = join(root, "inkos.log");
    const logStream = createWriteStream(logPath, { flags: "a" });
    const fileSink = createJsonLineSink(logStream);
    
    // Combined sink that broadcasts to SSE and writes to file
    const combinedSink: LogSink = {
      write(entry: LogEntry): void {
        sseSink.write(entry);
        fileSink.write(entry);
      },
    };

    broadcast("volume:generate-missing-plans:start", { bookId: id, volumeId });
    combinedSink.write({ 
      level: "info", 
      tag: "planner", 
      message: `开始生成第${volumeId}卷缺失的章节规划...`,
      timestamp: new Date().toISOString(),
    });

    try {
      const pipeline = new PipelineRunner(await buildPipelineConfig());
      const bookDir = pipeline["state"].bookDir(id);
      
      // Read audit failures
      const failuresPath = join(bookDir, "story", ".chapter-plan-audit-failures.json");
      let failedChapters: number[] = [];
      
      try {
        const content = await readFile(failuresPath, "utf-8");
        const allFailures = JSON.parse(content);
        
        // Get chapter range for this volume
        const metaPath = join(bookDir, "story", ".volume-plans-meta.json");
        let startChapter = 1;
        let endChapter = 1;
        
        try {
          const metaContent = await readFile(metaPath, "utf-8");
          const meta = JSON.parse(metaContent);
          const volumeMeta = meta.volumePlans?.find((vp: any) => vp.volumeId === volumeId);
          if (volumeMeta?.chapterRange) {
            startChapter = volumeMeta.chapterRange.start;
            endChapter = volumeMeta.chapterRange.end;
          }
        } catch {
          // Fallback: try to parse from outline
          const detailPath = join(bookDir, "story", `volume_${volumeId}_detail.md`);
          try {
            const detailContent = await readFile(detailPath, "utf-8");
            const rangeMatch = detailContent.match(/章节范围[：:]\s*(?:第)?(\d+)[\s-]*(?:章)?[\s-]*(?:第)?(\d+)(?:章)?/i);
            if (rangeMatch) {
              startChapter = parseInt(rangeMatch[1], 10);
              endChapter = parseInt(rangeMatch[2], 10);
            }
          } catch {
            // Ignore
          }
        }
        
        // Find failed chapters in this volume
        for (let chapterNum = startChapter; chapterNum <= endChapter; chapterNum++) {
          if (allFailures[String(chapterNum)]) {
            failedChapters.push(chapterNum);
          }
        }
      } catch {
        // No failures file, nothing to do
      }
      
      if (failedChapters.length === 0) {
        combinedSink.write({ 
          level: "info", 
          tag: "planner", 
          message: `第${volumeId}卷没有审计失败的章节规划`,
          timestamp: new Date().toISOString(),
        });
        return c.json({ ok: true, message: "No failed chapter plans to regenerate", regenerated: [] });
      }
      
      combinedSink.write({ 
        level: "info", 
        tag: "planner", 
        message: `发现${failedChapters.length}个审计失败的章节规划：${failedChapters.join(", ")}`,
        timestamp: new Date().toISOString(),
      });

      // Clear the failures for these chapters before regenerating
      try {
        const content = await readFile(failuresPath, "utf-8");
        const allFailures = JSON.parse(content);
        for (const chapterNum of failedChapters) {
          delete allFailures[String(chapterNum)];
        }
        await writeFile(failuresPath, JSON.stringify(allFailures, null, 2), "utf-8");
      } catch {
        // Ignore errors
      }

      // Regenerate failed chapter plans
      await pipeline.generateChapterPlansForVolume(id, volumeId);

      combinedSink.write({ 
        level: "info", 
        tag: "planner", 
        message: `第${volumeId}卷缺失章节规划生成完成`,
        timestamp: new Date().toISOString(),
      });
      
      broadcast("volume:generate-missing-plans:complete", { 
        bookId: id, 
        volumeId,
        regenerated: failedChapters
      });
      
      logStream.end();
      
      return c.json({ ok: true, message: "Missing chapter plans regenerated", regenerated: failedChapters });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      combinedSink.write({ 
        level: "error", 
        tag: "planner", 
        message: `第${volumeId}卷缺失章节规划生成失败：${error}`,
        timestamp: new Date().toISOString(),
      });
      broadcast("volume:generate-missing-plans:error", { bookId: id, volumeId, error });
      logStream.end();
      return c.json({ error }, 500);
    }
  });

  // Get single chapter plan
  app.get("/api/books/:id/chapters/:chapterNumber/plan", async (c) => {
    const id = c.req.param("id");
    const chapterNumber = parseInt(c.req.param("chapterNumber"), 10);

    try {
      const pipeline = new PipelineRunner(await buildPipelineConfig());
      const bookDir = pipeline["state"].bookDir(id);
      
      // Try to read chapter plan file from runtime directory (where PlannerAgent saves it)
      const runtimePlanPath = join(bookDir, "story", "runtime", `chapter-${String(chapterNumber).padStart(4, "0")}.intent.md`);
      
      try {
        const content = await readFile(runtimePlanPath, "utf-8");
        return c.json({ 
          ok: true, 
          chapterNumber, 
          exists: true,
          content 
        });
      } catch {
        // Fallback: try the old path for backward compatibility
        const legacyPlanPath = join(bookDir, "story", `chapter_${chapterNumber}_plan.md`);
        try {
          const content = await readFile(legacyPlanPath, "utf-8");
          return c.json({ 
            ok: true, 
            chapterNumber, 
            exists: true,
            content 
          });
        } catch {
          return c.json({ 
            ok: true, 
            chapterNumber, 
            exists: false,
            content: null 
          });
        }
      }
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // Generate single chapter plan
  app.post("/api/books/:id/chapters/:chapterNumber/generate-plan", async (c) => {
    const id = c.req.param("id");
    const chapterNumber = parseInt(c.req.param("chapterNumber"), 10);

    // Create file log stream for this operation
    const logPath = join(root, "inkos.log");
    const logStream = createWriteStream(logPath, { flags: "a" });
    const fileSink = createJsonLineSink(logStream);
    
    const combinedSink: LogSink = {
      write(entry: LogEntry): void {
        sseSink.write(entry);
        fileSink.write(entry);
      },
    };

    broadcast("chapter:generate-plan:start", { bookId: id, chapterNumber });
    combinedSink.write({ 
      level: "info", 
      tag: "planner", 
      message: `开始生成第${chapterNumber}章章节规划...`,
      timestamp: new Date().toISOString(),
    });

    try {
      const pipeline = new PipelineRunner(await buildPipelineConfig());
      
      // Find which volume this chapter belongs to
      const bookDir = pipeline["state"].bookDir(id);
      const metaPath = join(bookDir, "story", ".volume-plans-meta.json");
      let volumeId: number | null = null;
      
      try {
        const metaContent = await readFile(metaPath, "utf-8");
        const meta = JSON.parse(metaContent);
        for (const vp of meta.volumePlans || []) {
          if (chapterNumber >= vp.chapterRange.start && chapterNumber <= vp.chapterRange.end) {
            volumeId = vp.volumeId;
            break;
          }
        }
      } catch {
        // Fallback: try to determine from outline files
        const outlinePath = join(bookDir, "story", "volume_outline.md");
        try {
          const outlineContent = await readFile(outlinePath, "utf-8");
          const volumeMatches = outlineContent.matchAll(/第\s*(\d+)\s*卷[\s\S]*?章节范围[：:]\s*(?:第)?(\d+)[\s-]*(?:章)?[\s-]*(?:第)?(\d+)(?:章)?/gi);
          for (const match of volumeMatches) {
            const volId = parseInt(match[1], 10);
            const startCh = parseInt(match[2], 10);
            const endCh = parseInt(match[3], 10);
            if (chapterNumber >= startCh && chapterNumber <= endCh) {
              volumeId = volId;
              break;
            }
          }
        } catch {
          // Ignore
        }
      }
      
      if (!volumeId) {
        throw new Error(`无法确定第${chapterNumber}章所属的分卷`);
      }

      // Generate chapter plan for this specific chapter
      await pipeline.generateSingleChapterPlan(id, volumeId, chapterNumber);

      combinedSink.write({ 
        level: "info", 
        tag: "planner", 
        message: `第${chapterNumber}章章节规划生成完成`,
        timestamp: new Date().toISOString(),
      });
      
      broadcast("chapter:generate-plan:complete", { bookId: id, chapterNumber });
      
      logStream.end();
      
      return c.json({ ok: true, message: "Chapter plan generated", chapterNumber });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      combinedSink.write({ 
        level: "error", 
        tag: "planner", 
        message: `第${chapterNumber}章章节规划生成失败：${error}`,
        timestamp: new Date().toISOString(),
      });
      broadcast("chapter:generate-plan:error", { bookId: id, chapterNumber, error });
      logStream.end();
      return c.json({ error }, 500);
    }
  });

  // Rewrite single chapter plan
  app.post("/api/books/:id/chapters/:chapterNumber/rewrite-plan", async (c) => {
    const id = c.req.param("id");
    const chapterNumber = parseInt(c.req.param("chapterNumber"), 10);

    // Create file log stream for this operation
    const logPath = join(root, "inkos.log");
    const logStream = createWriteStream(logPath, { flags: "a" });
    const fileSink = createJsonLineSink(logStream);
    
    const combinedSink: LogSink = {
      write(entry: LogEntry): void {
        sseSink.write(entry);
        fileSink.write(entry);
      },
    };

    broadcast("chapter:rewrite-plan:start", { bookId: id, chapterNumber });
    combinedSink.write({ 
      level: "info", 
      tag: "planner", 
      message: `开始重写第${chapterNumber}章章节规划...`,
      timestamp: new Date().toISOString(),
    });

    try {
      const pipeline = new PipelineRunner(await buildPipelineConfig());
      
      // Find which volume this chapter belongs to
      const bookDir = pipeline["state"].bookDir(id);
      const metaPath = join(bookDir, "story", ".volume-plans-meta.json");
      let volumeId: number | null = null;
      
      try {
        const metaContent = await readFile(metaPath, "utf-8");
        const meta = JSON.parse(metaContent);
        for (const vp of meta.volumePlans || []) {
          if (chapterNumber >= vp.chapterRange.start && chapterNumber <= vp.chapterRange.end) {
            volumeId = vp.volumeId;
            break;
          }
        }
      } catch {
        // Fallback
      }
      
      if (!volumeId) {
        throw new Error(`无法确定第${chapterNumber}章所属的分卷`);
      }

      // Delete existing plan file to force regeneration
      const planPath = join(bookDir, "story", `chapter_${chapterNumber}_plan.md`);
      try {
        await unlink(planPath);
      } catch {
        // File may not exist, ignore
      }

      // Regenerate chapter plan
      await pipeline.generateSingleChapterPlan(id, volumeId, chapterNumber);

      combinedSink.write({ 
        level: "info", 
        tag: "planner", 
        message: `第${chapterNumber}章章节规划重写完成`,
        timestamp: new Date().toISOString(),
      });
      
      broadcast("chapter:rewrite-plan:complete", { bookId: id, chapterNumber });
      
      logStream.end();
      
      return c.json({ ok: true, message: "Chapter plan rewritten", chapterNumber });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      combinedSink.write({ 
        level: "error", 
        tag: "planner", 
        message: `第${chapterNumber}章章节规划重写失败：${error}`,
        timestamp: new Date().toISOString(),
      });
      broadcast("chapter:rewrite-plan:error", { bookId: id, chapterNumber, error });
      logStream.end();
      return c.json({ error }, 500);
    }
  });

  // Continue chapter plan audit
  app.post("/api/books/:id/chapters/:chapterNumber/continue-audit", async (c) => {
    const id = c.req.param("id");
    const chapterNumber = parseInt(c.req.param("chapterNumber"), 10);

    // Create file log stream for this operation
    const logPath = join(root, "inkos.log");
    const logStream = createWriteStream(logPath, { flags: "a" });
    const fileSink = createJsonLineSink(logStream);
    
    const combinedSink: LogSink = {
      write(entry: LogEntry): void {
        sseSink.write(entry);
        fileSink.write(entry);
      },
    };

    broadcast("chapter:continue-audit:start", { bookId: id, chapterNumber });
    combinedSink.write({ 
      level: "info", 
      tag: "planner", 
      message: `继续第${chapterNumber}章章节规划审计...`,
      timestamp: new Date().toISOString(),
    });

    try {
      const pipeline = new PipelineRunner(await buildPipelineConfig());
      
      // Find which volume this chapter belongs to
      const bookDir = pipeline["state"].bookDir(id);
      const metaPath = join(bookDir, "story", ".volume-plans-meta.json");
      let volumeId: number | null = null;
      
      try {
        const metaContent = await readFile(metaPath, "utf-8");
        const meta = JSON.parse(metaContent);
        for (const vp of meta.volumePlans || []) {
          if (chapterNumber >= vp.chapterRange.start && chapterNumber <= vp.chapterRange.end) {
            volumeId = vp.volumeId;
            break;
          }
        }
      } catch {
        // Fallback
      }
      
      if (!volumeId) {
        throw new Error(`无法确定第${chapterNumber}章所属的分卷`);
      }

      // Clear any existing audit failure for this chapter
      const failuresPath = join(bookDir, "story", ".chapter-plan-audit-failures.json");
      try {
        const content = await readFile(failuresPath, "utf-8");
        const failures = JSON.parse(content);
        delete failures[String(chapterNumber)];
        await writeFile(failuresPath, JSON.stringify(failures, null, 2), "utf-8");
      } catch {
        // File may not exist, ignore
      }

      // Regenerate chapter plan (will go through audit again)
      await pipeline.generateSingleChapterPlan(id, volumeId, chapterNumber);

      combinedSink.write({ 
        level: "info", 
        tag: "planner", 
        message: `第${chapterNumber}章章节规划审计完成`,
        timestamp: new Date().toISOString(),
      });
      
      broadcast("chapter:continue-audit:complete", { bookId: id, chapterNumber });
      
      logStream.end();
      
      return c.json({ ok: true, message: "Chapter plan audit continued", chapterNumber });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      combinedSink.write({ 
        level: "error", 
        tag: "planner", 
        message: `第${chapterNumber}章章节规划审计失败：${error}`,
        timestamp: new Date().toISOString(),
      });
      broadcast("chapter:continue-audit:error", { bookId: id, chapterNumber, error });
      logStream.end();
      return c.json({ error }, 500);
    }
  });

  // Batch rewrite all chapter plans for a volume
  app.post("/api/books/:id/volumes/:volumeId/rewrite-plans", async (c) => {
    const id = c.req.param("id");
    const volumeId = parseInt(c.req.param("volumeId"), 10);

    // Create file log stream for this operation
    const logPath = join(root, "inkos.log");
    const logStream = createWriteStream(logPath, { flags: "a" });
    const fileSink = createJsonLineSink(logStream);
    
    const combinedSink: LogSink = {
      write(entry: LogEntry): void {
        sseSink.write(entry);
        fileSink.write(entry);
      },
    };

    broadcast("volume:rewrite-plans:start", { bookId: id, volumeId });
    combinedSink.write({ 
      level: "info", 
      tag: "planner", 
      message: `开始批量重写第${volumeId}卷所有章节规划...`,
      timestamp: new Date().toISOString(),
    });

    try {
      const pipeline = new PipelineRunner(await buildPipelineConfig());
      const bookDir = pipeline["state"].bookDir(id);
      
      // Get chapter range for this volume
      const metaPath = join(bookDir, "story", ".volume-plans-meta.json");
      let startChapter = 1;
      let endChapter = 1;
      
      try {
        const metaContent = await readFile(metaPath, "utf-8");
        const meta = JSON.parse(metaContent);
        const volumeMeta = meta.volumePlans?.find((vp: any) => vp.volumeId === volumeId);
        if (volumeMeta?.chapterRange) {
          startChapter = volumeMeta.chapterRange.start;
          endChapter = volumeMeta.chapterRange.end;
        }
      } catch {
        // Fallback: try to parse from outline
        const detailPath = join(bookDir, "story", `volume_${volumeId}_detail.md`);
        try {
          const detailContent = await readFile(detailPath, "utf-8");
          const rangeMatch = detailContent.match(/章节范围[：:]\s*(?:第)?(\d+)[\s-]*(?:章)?[\s-]*(?:第)?(\d+)(?:章)?/i);
          if (rangeMatch) {
            startChapter = parseInt(rangeMatch[1], 10);
            endChapter = parseInt(rangeMatch[2], 10);
          }
        } catch {
          // Ignore
        }
      }
      
      combinedSink.write({ 
        level: "info", 
        tag: "planner", 
        message: `第${volumeId}卷章节范围：${startChapter}-${endChapter}章，开始删除现有规划...`,
        timestamp: new Date().toISOString(),
      });

      // Delete all existing chapter plans for this volume
      for (let chapterNum = startChapter; chapterNum <= endChapter; chapterNum++) {
        const planPath = join(bookDir, "story", `chapter_${chapterNum}_plan.md`);
        try {
          await unlink(planPath);
          combinedSink.write({ 
            level: "info", 
            tag: "planner", 
            message: `已删除第${chapterNum}章原有规划`,
            timestamp: new Date().toISOString(),
          });
        } catch {
          // File may not exist, ignore
        }
      }

      // Clear audit failures for this volume
      const failuresPath = join(bookDir, "story", ".chapter-plan-audit-failures.json");
      try {
        const content = await readFile(failuresPath, "utf-8");
        const failures = JSON.parse(content);
        for (let chapterNum = startChapter; chapterNum <= endChapter; chapterNum++) {
          delete failures[String(chapterNum)];
        }
        await writeFile(failuresPath, JSON.stringify(failures, null, 2), "utf-8");
      } catch {
        // File may not exist, ignore
      }

      combinedSink.write({ 
        level: "info", 
        tag: "planner", 
        message: `开始重新生成第${volumeId}卷所有章节规划...`,
        timestamp: new Date().toISOString(),
      });

      // Regenerate all chapter plans
      await pipeline.generateChapterPlansForVolume(id, volumeId);

      combinedSink.write({ 
        level: "info", 
        tag: "planner", 
        message: `第${volumeId}卷所有章节规划重写完成`,
        timestamp: new Date().toISOString(),
      });
      
      broadcast("volume:rewrite-plans:complete", { bookId: id, volumeId });
      
      logStream.end();
      
      return c.json({ ok: true, message: "All chapter plans rewritten", volumeId });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      combinedSink.write({ 
        level: "error", 
        tag: "planner", 
        message: `第${volumeId}卷章节规划批量重写失败：${error}`,
        timestamp: new Date().toISOString(),
      });
      broadcast("volume:rewrite-plans:error", { bookId: id, volumeId, error });
      logStream.end();
      return c.json({ error }, 500);
    }
  });

  // Rewrite specific volume outline
  app.post("/api/books/:id/volumes/:volumeId/rewrite-outline", async (c) => {
    const id = c.req.param("id");
    const volumeId = parseInt(c.req.param("volumeId"), 10);

    // Create run record for task management
    const run = runStore.create({
      bookId: id,
      action: "rewrite-volume-outline",
    });
    runStore.markRunning(run.id, `重写第${volumeId}卷卷纲`);

    try {
      const pipeline = new PipelineRunner(await buildPipelineConfig());
      const book = await pipeline["state"].loadBookConfig(id);
      const bookDir = pipeline["state"].bookDir(id);
      const outlinePath = join(bookDir, "story", "volume_outline.md");
      
      const outlineContent = await readFile(outlinePath, "utf-8");
      
      // TODO: Implement volume outline rewrite logic
      // For now, just mark as succeeded
      runStore.succeed(run.id, { volumeId, message: "Volume outline rewrite started" });
      return c.json({ ok: true, message: "Volume outline rewrite started", runId: run.id });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      runStore.fail(run.id, error);
      return c.json({ error, runId: run.id }, 500);
    }
  });

  // Generate detailed volume outline using ArchitectAgent
  app.post("/api/books/:id/volumes/:volumeId/generate-detail", async (c) => {
    const id = c.req.param("id");
    const volumeId = parseInt(c.req.param("volumeId"), 10);

    // Create run record for task management
    const run = runStore.create({
      bookId: id,
      action: "generate-volume-detail",
    });
    runStore.markRunning(run.id, `生成第${volumeId}卷详细卷纲`);

    // Create file log stream for this operation
    const logPath = join(root, "inkos.log");
    const logStream = createWriteStream(logPath, { flags: "a" });
    const fileSink = createJsonLineSink(logStream);
    
    // Combined sink that broadcasts to SSE and writes to file
    const combinedSink: LogSink = {
      write(entry: LogEntry): void {
        sseSink.write(entry);
        fileSink.write(entry);
        // Also append log to run
        runStore.appendLog(run.id, {
          level: entry.level,
          message: entry.message,
          timestamp: entry.timestamp || new Date().toISOString(),
        });
      },
    };

    broadcast("volume:generate-detail:start", { bookId: id, volumeId, runId: run.id });
    combinedSink.write({ 
      level: "info", 
      tag: "architect", 
      message: `开始生成第${volumeId}卷详细卷纲...`,
      timestamp: new Date().toISOString(),
    });

    try {
      const pipeline = new PipelineRunner(await buildPipelineConfig());
      const book = await pipeline["state"].loadBookConfig(id);
      const bookDir = pipeline["state"].bookDir(id);
      
      // Use ArchitectAgent to generate detailed volume outline
      const { ArchitectAgent } = await import("@actalk/inkos-core");
      // Create a minimal context for the agent
      const ctx = {
        client: createLLMClient(cachedConfig.llm),
        model: cachedConfig.llm.model,
        projectRoot: root,
        bookId: id,
        logger: createLogger({ tag: "architect", sinks: [combinedSink] }),
      };
      const architect = new ArchitectAgent(ctx);
      
      combinedSink.write({ 
        level: "info", 
        tag: "architect", 
        message: `ArchitectAgent 正在为第${volumeId}卷生成详细卷纲（包含章节分组、角色发展等）...`,
        timestamp: new Date().toISOString(),
      });
      
      const result = await architect.generateVolumeDetail(book, bookDir, volumeId);
      
      // Filter out <think> and <thinking> tags from LLM response
      let filteredContent = result.volumeDetail;
      // Remove <think>...</think> tags (used by some LLM models)
      const thinkRegex = /<think>[\s\S]*?<\/think>/gi;
      filteredContent = filteredContent.replace(thinkRegex, "");
      // Remove <thinking>...</thinking> tags (used by some LLM models)
      const thinkingRegex = /<thinking>[\s\S]*?<\/thinking>/gi;
      filteredContent = filteredContent.replace(thinkingRegex, "");
      // Clean up any empty lines left after removal
      filteredContent = filteredContent.replace(/\n{3,}/g, "\n\n").trim();
      
      // Save the generated volume detail to a separate file
      const volumeDetailPath = join(bookDir, "story", `volume_${volumeId}_detail.md`);
      await writeFile(volumeDetailPath, filteredContent, "utf-8");
      
      // Update metadata
      if (volumePlansMeta[id]) {
        const volumeMeta = volumePlansMeta[id].volumePlans.find((vp: any) => vp.volumeId === volumeId);
        if (volumeMeta) {
          volumeMeta.detailOutlineGenerated = true;
          volumeMeta.detailOutlineFile = `volume_${volumeId}_detail.md`;
          volumeMeta.lastGeneratedAt = new Date().toISOString();
          await saveVolumePlansMeta(id);
        }
      }
      
      combinedSink.write({ 
        level: "info", 
        tag: "architect", 
        message: `第${volumeId}卷详细卷纲生成完成，已保存到 volume_${volumeId}_detail.md`,
        timestamp: new Date().toISOString(),
      });
      
      runStore.succeed(run.id, { volumeId, volumeDetail: filteredContent });
      broadcast("volume:generate-detail:complete", { 
        bookId: id, 
        volumeId,
        volumeDetail: result.volumeDetail,
        runId: run.id
      });
      
      // Close log stream
      logStream.end();
      
      return c.json({ 
        ok: true, 
        volumeId,
        volumeDetail: result.volumeDetail,
        runId: run.id
      });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      combinedSink.write({ 
        level: "error", 
        tag: "architect", 
        message: `第${volumeId}卷详细卷纲生成失败：${error}`,
        timestamp: new Date().toISOString(),
      });
      runStore.fail(run.id, error);
      broadcast("volume:generate-detail:error", { bookId: id, volumeId, error, runId: run.id });
      
      // Close log stream
      logStream.end();
      
      return c.json({ error, runId: run.id }, 500);
    }
  });

  // Generate chapter plans for a specific volume
  app.post("/api/books/:id/volumes/:volumeId/generate-plans", async (c) => {
    const id = c.req.param("id");
    const volumeId = parseInt(c.req.param("volumeId"), 10);

    // Create file log stream for this operation
    const logPath = join(root, "inkos.log");
    const logStream = createWriteStream(logPath, { flags: "a" });
    const fileSink = createJsonLineSink(logStream);
    
    // Combined sink that broadcasts to SSE and writes to file
    const combinedSink: LogSink = {
      write(entry: LogEntry): void {
        sseSink.write(entry);
        fileSink.write(entry);
      },
    };

    broadcast("volume:generate-plans:start", { bookId: id, volumeId });
    combinedSink.write({ 
      level: "info", 
      tag: "planner", 
      message: `开始生成第${volumeId}卷章节规划...`,
      timestamp: new Date().toISOString(),
    });

    try {
      const pipeline = new PipelineRunner(await buildPipelineConfig());
      
      // 读取卷纲获取章节范围
      const book = await pipeline["state"].loadBookConfig(id);
      const bookDir = pipeline["state"].bookDir(id);
      const outlinePath = join(bookDir, "story", "volume_outline.md");
      const outlineContent = await readFile(outlinePath, "utf-8");
      const volumeRegex = new RegExp(`### 第${volumeId}卷[\\s\\S]*?(?:章节范围 | Chapter Range)[：:](\\d+)-(\\d+)`, "i");
      const match = volumeRegex.exec(outlineContent);
      
      if (match) {
        const startChapter = parseInt(match[1], 10);
        const endChapter = parseInt(match[2], 10);
        combinedSink.write({ 
          level: "info", 
          tag: "planner", 
          message: `第${volumeId}卷章节范围：第${startChapter}-${endChapter}章，共${endChapter - startChapter + 1}章`,
          timestamp: new Date().toISOString(),
        });
      }
      
      await pipeline.generateChapterPlansForVolume(id, volumeId);
      
      combinedSink.write({ 
        level: "info", 
        tag: "planner", 
        message: `第${volumeId}卷章节规划全部生成完成`,
        timestamp: new Date().toISOString(),
      });
      
      broadcast("volume:generate-plans:complete", { bookId: id, volumeId });
      
      // Close log stream
      logStream.end();
      
      return c.json({ ok: true });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      combinedSink.write({ 
        level: "error", 
        tag: "planner", 
        message: `第${volumeId}卷章节规划生成失败：${error}`,
        timestamp: new Date().toISOString(),
      });
      broadcast("volume:generate-plans:error", { bookId: id, volumeId, error });
      
      // Close log stream
      logStream.end();
      
      return c.json({ error }, 500);
    }
  });

  // Rewrite all chapters in a volume
  app.post("/api/books/:id/volumes/:volumeId/rewrite-chapters", async (c) => {
    const id = c.req.param("id");
    const volumeId = parseInt(c.req.param("volumeId"), 10);

    // Create run record for task management
    const run = runStore.create({
      bookId: id,
      action: "rewrite-volume-chapters",
    });
    runStore.markRunning(run.id, `重写第${volumeId}卷章节`);

    // Create file log stream for this operation
    const logPath = join(root, "inkos.log");
    const logStream = createWriteStream(logPath, { flags: "a" });
    const fileSink = createJsonLineSink(logStream);
    
    // Combined sink that broadcasts to SSE and writes to file
    const combinedSink: LogSink = {
      write(entry: LogEntry): void {
        sseSink.write(entry);
        fileSink.write(entry);
        // Also append log to run
        runStore.appendLog(run.id, {
          level: entry.level,
          message: entry.message,
          timestamp: entry.timestamp || new Date().toISOString(),
        });
      },
    };

    broadcast("volume:rewrite-chapters:start", { bookId: id, volumeId, runId: run.id });
    combinedSink.write({ 
      level: "info", 
      tag: "writer", 
      message: `开始重写第${volumeId}卷所有章节...`,
      timestamp: new Date().toISOString(),
    });

    try {
      const pipeline = new PipelineRunner(await buildPipelineConfig());
      await pipeline.regenerateVolumeChapters(id, volumeId);
      
      combinedSink.write({ 
        level: "info", 
        tag: "writer", 
        message: `第${volumeId}卷所有章节重写完成`,
        timestamp: new Date().toISOString(),
      });
      
      runStore.succeed(run.id, { volumeId });
      broadcast("volume:rewrite-chapters:complete", { bookId: id, volumeId, runId: run.id });
      
      // Close log stream
      logStream.end();
      
      return c.json({ ok: true, runId: run.id });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      combinedSink.write({ 
        level: "error", 
        tag: "writer", 
        message: `第${volumeId}卷章节重写失败：${error}`,
        timestamp: new Date().toISOString(),
      });
      runStore.fail(run.id, error);
      broadcast("volume:rewrite-chapters:error", { bookId: id, volumeId, error, runId: run.id });
      
      // Close log stream
      logStream.end();
      
      return c.json({ error, runId: run.id }, 500);
    }
  });

  // Mark affected chapters
  app.post("/api/books/:id/volumes/:volumeId/mark-affected", async (c) => {
    const id = c.req.param("id");
    const volumeId = parseInt(c.req.param("volumeId"), 10);

    try {
      const pipeline = new PipelineRunner(await buildPipelineConfig());
      const bookDir = pipeline["state"].bookDir(id);
      const outlinePath = join(bookDir, "story", "volume_outline.md");
      
      try {
        const outlineContent = await readFile(outlinePath, "utf-8");
        // Simple parsing to extract volume information
        const volumeRegex = new RegExp(`### 第${volumeId}卷[\\s\\S]*?章节范围[：:](\\d+)-(\\d+)`, "i");
        const match = volumeRegex.exec(outlineContent);
        
        if (match) {
          const startChapter = parseInt(match[1], 10);
          const endChapter = parseInt(match[2], 10);
          
          await pipeline.markAffectedChapters(id, { start: startChapter, end: endChapter });
          return c.json({ ok: true, affectedChapters: { start: startChapter, end: endChapter } });
        } else {
          return c.json({ error: `Volume ${volumeId} not found in outline` }, 404);
        }
      } catch {
        return c.json({ error: "Failed to read volume outline" }, 500);
      }
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Fix Chapter Order ---  

  app.post("/api/books/:id/chapters/fix-order", async (c) => {
    const id = c.req.param("id");

    try {
      const bookDir = state.bookDir(id);
      const chaptersDir = join(bookDir, "chapters");
      const files = await readdir(chaptersDir);
      
      // Filter and sort chapter files
      const chapterFiles = files
        .filter((f) => f.match(/^\d{4}.*\.md$/))
        .sort();

      // Load existing chapter index to preserve metadata
      let existingIndex: ReadonlyArray<ChapterMeta> = [];
      try {
        existingIndex = await state.loadChapterIndex(id);
      } catch {
        // If index doesn't exist, continue with empty array
      }

      // Update chapter files and build new index
      const newIndex = [];
      for (let i = 0; i < chapterFiles.length; i++) {
        const newNumber = i + 1;
        const newPaddedNum = String(newNumber).padStart(4, "0");
        const oldFileName = chapterFiles[i];
        const newFileName = oldFileName.replace(/^\d{4}/, newPaddedNum);
        
        // Rename file if needed
        if (oldFileName !== newFileName) {
          await rename(join(chaptersDir, oldFileName), join(chaptersDir, newFileName));
        }

        // Extract old chapter number from filename
        const oldNumberMatch = oldFileName.match(/^(\d{4})/);
        const oldNumber = oldNumberMatch ? parseInt(oldNumberMatch[1], 10) : null;

        // Find existing chapter metadata
        let existingChapter = existingIndex.find(ch => ch.number === oldNumber);
        
        // If not found by number, try to find by filename pattern
        if (!existingChapter) {
          existingChapter = existingIndex.find(ch => {
            const oldPaddedNum = String(ch.number).padStart(4, "0");
            return oldFileName.startsWith(oldPaddedNum);
          });
        }

        // Determine chapter title
        let title: string;
        if (existingChapter?.title) {
          title = existingChapter.title;
        } else {
          // Extract chapter title from filename
          const titleMatch = newFileName.match(/^\d{4}-(.*)\.md$/);
          title = titleMatch ? titleMatch[1].replace(/-/g, " ") : `Chapter ${newNumber}`;
        }

        // Determine chapter status
        const status = existingChapter?.status || "drafted" as const;
        const wordCount = existingChapter?.wordCount || 0;
        const createdAt = existingChapter?.createdAt || new Date().toISOString();
        const updatedAt = new Date().toISOString();
        const auditIssues = existingChapter?.auditIssues || [];
        const lengthWarnings = existingChapter?.lengthWarnings || [];

        // Add to new index
        newIndex.push({
          number: newNumber,
          title,
          status,
          wordCount,
          createdAt,
          updatedAt,
          auditIssues,
          lengthWarnings,
        });
      }

      // Save new index
      await state.saveChapterIndex(id, newIndex);

      return c.json({ status: "fixed", bookId: id, chapterCount: newIndex.length });
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Detect All chapters ---

  app.post("/api/books/:id/detect-all", async (c) => {
    const id = c.req.param("id");
    const bookDir = state.bookDir(id);

    try {
      const chaptersDir = join(bookDir, "chapters");
      const files = await readdir(chaptersDir);
      const mdFiles = files.filter((f) => f.endsWith(".md") && /^\d{4}/.test(f)).sort();
      const { analyzeAITells } = await import("@actalk/inkos-core");

      const results = await Promise.all(
        mdFiles.map(async (f) => {
          const num = parseInt(f.slice(0, 4), 10);
          const content = await readFile(join(chaptersDir, f), "utf-8");
          const result = analyzeAITells(content);
          return { chapterNumber: num, filename: f, ...result };
        }),
      );
      return c.json({ bookId: id, results });
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Detect Stats ---

  app.get("/api/books/:id/detect/stats", async (c) => {
    const id = c.req.param("id");
    try {
      const { loadDetectionHistory, analyzeDetectionInsights } = await import("@actalk/inkos-core");
      const bookDir = state.bookDir(id);
      const history = await loadDetectionHistory(bookDir);
      const insights = analyzeDetectionInsights(history);
      return c.json(insights);
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Genre Create ---

  app.post("/api/genres/create", async (c) => {
    const body = await c.req.json<{
      id: string; name: string; language?: string;
      chapterTypes?: string[]; fatigueWords?: string[];
      numericalSystem?: boolean; powerScaling?: boolean; eraResearch?: boolean;
      pacingRule?: string; satisfactionTypes?: string[]; auditDimensions?: number[];
      body?: string;
    }>();

    if (!body.id || !body.name) {
      return c.json({ error: "id and name are required" }, 400);
    }
    if (/[/\\\0]/.test(body.id) || body.id.includes("..")) {
      throw new ApiError(400, "INVALID_GENRE_ID", `Invalid genre ID: "${body.id}"`);
    }

    const { writeFile: writeFileFs, mkdir: mkdirFs } = await import("node:fs/promises");
    const genresDir = join(root, "genres");
    await mkdirFs(genresDir, { recursive: true });

    const frontmatter = [
      "---",
      `name: ${body.name}`,
      `id: ${body.id}`,
      `language: ${body.language ?? "zh"}`,
      `chapterTypes: ${JSON.stringify(body.chapterTypes ?? [])}`,
      `fatigueWords: ${JSON.stringify(body.fatigueWords ?? [])}`,
      `numericalSystem: ${body.numericalSystem ?? false}`,
      `powerScaling: ${body.powerScaling ?? false}`,
      `eraResearch: ${body.eraResearch ?? false}`,
      `pacingRule: "${body.pacingRule ?? ""}"`,
      `satisfactionTypes: ${JSON.stringify(body.satisfactionTypes ?? [])}`,
      `auditDimensions: ${JSON.stringify(body.auditDimensions ?? [])}`,
      "---",
      "",
      body.body ?? "",
    ].join("\n");

    await writeFileFs(join(genresDir, `${body.id}.md`), frontmatter, "utf-8");
    return c.json({ ok: true, id: body.id });
  });

  // --- Genre Edit ---

  app.put("/api/genres/:id", async (c) => {
    const genreId = c.req.param("id");
    if (/[/\\\0]/.test(genreId) || genreId.includes("..")) {
      throw new ApiError(400, "INVALID_GENRE_ID", `Invalid genre ID: "${genreId}"`);
    }

    const body = await c.req.json<{ profile: Record<string, unknown>; body: string }>();
    const { writeFile: writeFileFs, mkdir: mkdirFs } = await import("node:fs/promises");
    const genresDir = join(root, "genres");
    await mkdirFs(genresDir, { recursive: true });

    const p = body.profile;
    const frontmatter = [
      "---",
      `name: ${p.name ?? genreId}`,
      `id: ${p.id ?? genreId}`,
      `language: ${p.language ?? "zh"}`,
      `chapterTypes: ${JSON.stringify(p.chapterTypes ?? [])}`,
      `fatigueWords: ${JSON.stringify(p.fatigueWords ?? [])}`,
      `numericalSystem: ${p.numericalSystem ?? false}`,
      `powerScaling: ${p.powerScaling ?? false}`,
      `eraResearch: ${p.eraResearch ?? false}`,
      `pacingRule: "${p.pacingRule ?? ""}"`,
      `satisfactionTypes: ${JSON.stringify(p.satisfactionTypes ?? [])}`,
      `auditDimensions: ${JSON.stringify(p.auditDimensions ?? [])}`,
      "---",
      "",
      body.body ?? "",
    ].join("\n");

    await writeFileFs(join(genresDir, `${genreId}.md`), frontmatter, "utf-8");
    return c.json({ ok: true, id: genreId });
  });

  // --- Genre Delete (project-level only) ---

  app.delete("/api/genres/:id", async (c) => {
    const genreId = c.req.param("id");
    if (/[/\\\0]/.test(genreId) || genreId.includes("..")) {
      throw new ApiError(400, "INVALID_GENRE_ID", `Invalid genre ID: "${genreId}"`);
    }

    const filePath = join(root, "genres", `${genreId}.md`);
    try {
      const { rm } = await import("node:fs/promises");
      await rm(filePath);
      return c.json({ ok: true, id: genreId });
    } catch (e) {
      return c.json({ error: `Genre "${genreId}" not found in project` }, 404);
    }
  });

  // --- Style Analyze ---

  app.post("/api/style/analyze", async (c) => {
    const { text, sourceName } = await c.req.json<{ text: string; sourceName: string }>();
    if (!text?.trim()) return c.json({ error: "text is required" }, 400);

    try {
      const { analyzeStyle } = await import("@actalk/inkos-core");
      const profile = analyzeStyle(text, sourceName ?? "unknown");
      return c.json(profile);
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Style Import to Book ---

  app.post("/api/books/:id/style/import", async (c) => {
    const id = c.req.param("id");
    const { text, sourceName } = await c.req.json<{ text: string; sourceName: string }>();

    broadcast("style:start", { bookId: id });
    try {
      const pipeline = new PipelineRunner(await buildPipelineConfig());
      const result = await pipeline.generateStyleGuide(id, text, sourceName ?? "unknown");
      broadcast("style:complete", { bookId: id });
      return c.json({ ok: true, result });
    } catch (e) {
      broadcast("style:error", { bookId: id, error: String(e) });
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Import Chapters ---

  app.post("/api/books/:id/import/chapters", async (c) => {
    const id = c.req.param("id");
    const { text, splitRegex } = await c.req.json<{ text: string; splitRegex?: string }>();
    if (!text?.trim()) return c.json({ error: "text is required" }, 400);

    broadcast("import:start", { bookId: id, type: "chapters" });
    try {
      const { splitChapters } = await import("@actalk/inkos-core");
      const chapters = [...splitChapters(text, splitRegex)];

      const pipeline = new PipelineRunner(await buildPipelineConfig());
      const result = await pipeline.importChapters({ bookId: id, chapters });
      broadcast("import:complete", { bookId: id, type: "chapters", count: result.importedCount });
      return c.json(result);
    } catch (e) {
      broadcast("import:error", { bookId: id, error: String(e) });
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Import Canon ---

  app.post("/api/books/:id/import/canon", async (c) => {
    const id = c.req.param("id");
    const { fromBookId } = await c.req.json<{ fromBookId: string }>();
    if (!fromBookId) return c.json({ error: "fromBookId is required" }, 400);

    broadcast("import:start", { bookId: id, type: "canon" });
    try {
      const pipeline = new PipelineRunner(await buildPipelineConfig());
      await pipeline.importCanon(id, fromBookId);
      broadcast("import:complete", { bookId: id, type: "canon" });
      return c.json({ ok: true });
    } catch (e) {
      broadcast("import:error", { bookId: id, error: String(e) });
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Fanfic Init ---

  app.post("/api/fanfic/init", async (c) => {
    const body = await c.req.json<{
      title: string; sourceText: string; sourceName?: string;
      mode?: string; genre?: string; platform?: string;
      targetChapters?: number; chapterWordCount?: number; language?: string;
    }>();
    if (!body.title || !body.sourceText) {
      return c.json({ error: "title and sourceText are required" }, 400);
    }

    const now = new Date().toISOString();
    const bookId = body.title.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, "-").replace(/-+/g, "-").slice(0, 30);

    const bookConfig = {
      id: bookId,
      title: body.title,
      platform: (body.platform ?? "other") as "other",
      genre: (body.genre ?? "other") as "xuanhuan",
      status: "outlining" as const,
      targetChapters: body.targetChapters ?? 100,
      chapterWordCount: body.chapterWordCount ?? 3000,
      fanficMode: (body.mode ?? "canon") as "canon",
      ...(body.language ? { language: body.language as "zh" | "en" } : {}),
      createdAt: now,
      updatedAt: now,
    };

    broadcast("fanfic:start", { bookId, title: body.title });
    try {
      const pipeline = new PipelineRunner(await buildPipelineConfig());
      await pipeline.initFanficBook(bookConfig, body.sourceText, body.sourceName ?? "source", (body.mode ?? "canon") as "canon");
      broadcast("fanfic:complete", { bookId });
      return c.json({ ok: true, bookId });
    } catch (e) {
      broadcast("fanfic:error", { bookId, error: String(e) });
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Fanfic Show (read canon) ---

  app.get("/api/books/:id/fanfic", async (c) => {
    const id = c.req.param("id");
    const bookDir = state.bookDir(id);
    try {
      const content = await readFile(join(bookDir, "story", "fanfic_canon.md"), "utf-8");
      return c.json({ bookId: id, content });
    } catch {
      return c.json({ bookId: id, content: null });
    }
  });

  // --- Fanfic Refresh ---

  app.post("/api/books/:id/fanfic/refresh", async (c) => {
    const id = c.req.param("id");
    const { sourceText, sourceName } = await c.req.json<{ sourceText: string; sourceName?: string }>();
    if (!sourceText?.trim()) return c.json({ error: "sourceText is required" }, 400);

    broadcast("fanfic:refresh:start", { bookId: id });
    try {
      const book = await state.loadBookConfig(id);
      const pipeline = new PipelineRunner(await buildPipelineConfig());
      await pipeline.importFanficCanon(id, sourceText, sourceName ?? "source", (book.fanficMode ?? "canon") as "canon");
      broadcast("fanfic:refresh:complete", { bookId: id });
      return c.json({ ok: true });
    } catch (e) {
      broadcast("fanfic:refresh:error", { bookId: id, error: String(e) });
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Radar Scan ---

  app.post("/api/radar/scan", async (c) => {
    broadcast("radar:start", {});
    try {
      const pipeline = new PipelineRunner(await buildPipelineConfig());
      const result = await pipeline.runRadar();
      broadcast("radar:complete", { result });
      return c.json(result);
    } catch (e) {
      broadcast("radar:error", { error: String(e) });
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Plan Chapter ---

  app.post("/api/books/:id/plan", async (c) => {
    const id = c.req.param("id");
    const body: { context?: string } = await c.req
      .json<{ context?: string }>()
      .catch(() => ({ context: undefined }));

    broadcast("plan:start", { bookId: id });
    try {
      const pipeline = new PipelineRunner(await buildPipelineConfig({
        externalContext: body.context,
      }));
      const result = await pipeline.planChapter(id, body.context);
      broadcast("plan:complete", { bookId: id, chapterNumber: result.chapterNumber });
      return c.json(result);
    } catch (e) {
      broadcast("plan:error", { bookId: id, error: String(e) });
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Consolidate ---

  app.post("/api/books/:id/consolidate", async (c) => {
    const id = c.req.param("id");

    broadcast("consolidate:start", { bookId: id });
    try {
      const { ConsolidatorAgent } = await import("@actalk/inkos-core");
      const currentConfig = await loadCurrentProjectConfig();
      const consolidator = new ConsolidatorAgent({
        client: createLLMClient(currentConfig.llm),
        model: currentConfig.llm.model,
        projectRoot: root,
      });

      const bookDir = state.bookDir(id);
      const result = await consolidator.consolidate(bookDir);

      broadcast("consolidate:complete", { bookId: id, archivedVolumes: result.archivedVolumes });
      return c.json(result);
    } catch (e) {
      broadcast("consolidate:error", { bookId: id, error: String(e) });
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- RAG System Toggle ---

  // Helper function to reload env vars from .env file
  // Priority: Project .env > Global ~/.inkos/.env > Existing process.env
  async function reloadEnvFromFile(): Promise<void> {
    // Save existing process.env values (system env vars)
    const existingEnv = { ...process.env };
    
    // Step 1: Load global env first (lowest priority)
    try {
      const { GLOBAL_ENV_PATH } = await import("@actalk/inkos-core");
      console.log("[RAG Debug] Loading global env from:", GLOBAL_ENV_PATH);
      const globalEnvContent = await readFile(GLOBAL_ENV_PATH, "utf-8");
      console.log("[RAG Debug] Global env content length:", globalEnvContent.length);
      const globalLines = globalEnvContent.split("\n");
      
      let loadedCount = 0;
      for (const line of globalLines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        
        const eqIndex = trimmed.indexOf("=");
        if (eqIndex > 0) {
          const key = trimmed.substring(0, eqIndex);
          const value = trimmed.substring(eqIndex + 1);
          // Only set if not set by system env
          if (!existingEnv[key]) {
            process.env[key] = value;
            loadedCount++;
            if (key.startsWith("RAG_")) {
              console.log("[RAG Debug] Loaded from global:", key, "=", value);
            }
          }
        }
      }
      console.log("[RAG Debug] Total vars loaded from global:", loadedCount);
    } catch (error) {
      console.log("[RAG Debug] Failed to load global env:", error instanceof Error ? error.message : String(error));
    }
    
    // Step 2: Load project env (highest priority, overrides everything)
    try {
      const envPath = join(root, ".env");
      console.log("[RAG Debug] Loading project env from:", envPath);
      const envContent = await readFile(envPath, "utf-8");
      const lines = envContent.split("\n");
      
      let loadedCount = 0;
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        
        const eqIndex = trimmed.indexOf("=");
        if (eqIndex > 0) {
          const key = trimmed.substring(0, eqIndex);
          const value = trimmed.substring(eqIndex + 1);
          // Project env always overrides
          process.env[key] = value;
          loadedCount++;
          if (key.startsWith("RAG_")) {
            console.log("[RAG Debug] Loaded from project:", key, "=", value);
          }
        }
      }
      console.log("[RAG Debug] Total vars loaded from project:", loadedCount);
    } catch (error) {
      console.log("[RAG Debug] Failed to load project env:", error instanceof Error ? error.message : String(error));
    }
  }

  app.get("/api/rag-status", async (c) => {
    // Reload env vars to get latest changes
    await reloadEnvFromFile();
    
    const enabled = process.env.RAG_ENABLED === "true";
    const modelType = process.env.RAG_MODEL_TYPE || "openai";
    const modelName = process.env.RAG_MODEL_NAME || "text-embedding-3-small";
    
    // Check if API key is available for the model type
    let available = false;
    const apiKeyEnvVars: Record<string, string[]> = {
      openai: ["OPENAI_API_KEY"],
      huggingface: ["HUGGINGFACE_API_KEY"],
      lmstudio: [], // LM Studio doesn't require API key
      mota: ["MOTA_API_KEY"],
      modelscope: ["MODELSCOPE_API_KEY"],
      siliconflow: ["SILICONFLOW_API_KEY"],
      zhipu: ["ZHIPU_API_KEY"],
      dashscope: ["DASHSCOPE_API_KEY"],
      local: [],
      custom: ["EMBEDDING_API_KEY"],
    };
    
    const envVars = apiKeyEnvVars[modelType] || ["OPENAI_API_KEY"];
    
    // For local models (lmstudio, local), check if the service is actually reachable
    if (modelType === "lmstudio" || modelType === "local") {
      try {
        const baseUrl = process.env.RAG_BASE_URL || (modelType === "lmstudio" ? "http://127.0.0.1:1234/v1/embeddings" : "http://localhost:11434/api/embeddings");
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3000);
        
        const response = await fetch(baseUrl.replace("/v1/embeddings", "").replace("/api/embeddings", ""), {
          method: "GET",
          signal: controller.signal,
        });
        clearTimeout(timeout);
        
        available = response.ok;
      } catch {
        available = false;
      }
    } else {
      available = envVars.length === 0 || envVars.some(v => !!process.env[v]);
    }
    
    return c.json({
      enabled,
      available,
      modelType,
      modelName,
    });
  });

  app.post("/api/rag-toggle", async (c) => {
    const { enabled } = await c.req.json<{ enabled?: boolean }>();
    
    if (enabled === undefined) {
      return c.json({ error: "enabled is required" }, 400);
    }
    
    try {
      // Update .env file
      const envPath = join(root, ".env");
      let envContent = "";
      
      try {
        envContent = await readFile(envPath, "utf-8");
      } catch {
        // File doesn't exist, will create new
      }
      
      // Update or add RAG_ENABLED
      const envLines = envContent.split("\n");
      const ragEnabledIndex = envLines.findIndex(line => line.startsWith("RAG_ENABLED="));
      
      if (ragEnabledIndex >= 0) {
        envLines[ragEnabledIndex] = `RAG_ENABLED=${enabled}`;
      } else {
        envLines.push(`RAG_ENABLED=${enabled}`);
      }
      
      // Add default config if not exists
      if (enabled && !envLines.some(line => line.startsWith("RAG_MODEL_TYPE="))) {
        envLines.push("RAG_MODEL_TYPE=openai");
      }
      if (enabled && !envLines.some(line => line.startsWith("RAG_MODEL_NAME="))) {
        envLines.push("RAG_MODEL_NAME=text-embedding-3-small");
      }
      
      await writeFile(envPath, envLines.join("\n"), "utf-8");
      
      // Update process.env for current session
      process.env.RAG_ENABLED = String(enabled);
      
      return c.json({ ok: true, enabled });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  });

  // --- Doctor (environment health check) ---

  app.get("/api/doctor", async (c) => {
    const { existsSync } = await import("node:fs");
    const { GLOBAL_ENV_PATH } = await import("@actalk/inkos-core");

    // Reload env vars to get latest changes
    await reloadEnvFromFile();

    const checks = {
      inkosJson: existsSync(join(root, "inkos.json")),
      projectEnv: existsSync(join(root, ".env")),
      globalEnv: existsSync(GLOBAL_ENV_PATH),
      booksDir: existsSync(join(root, "books")),
      llmConnected: false,
      bookCount: 0,
      rag: {
        enabled: false,
        available: false,
        embeddingModel: null as string | null,
        configPath: null as string | null,
      },
    };

    try {
      const books = await state.listBooks();
      checks.bookCount = books.length;
    } catch { /* ignore */ }

    try {
      const currentConfig = await loadCurrentProjectConfig({ requireApiKey: false });
      const client = createLLMClient(currentConfig.llm);
      const { chatCompletion } = await import("@actalk/inkos-core");
      await chatCompletion(client, currentConfig.llm.model, [{ role: "user", content: "ping" }], { maxTokens: 5 });
      checks.llmConnected = true;
    } catch { /* ignore */ }

    // Check RAG system status from environment variables
    try {
      const ragEnabled = process.env.RAG_ENABLED === "true";
      const modelType = process.env.RAG_MODEL_TYPE || "openai";
      const modelName = process.env.RAG_MODEL_NAME || "text-embedding-3-small";
      
      console.log("[RAG Debug] RAG_ENABLED:", process.env.RAG_ENABLED);
      console.log("[RAG Debug] RAG_MODEL_TYPE:", process.env.RAG_MODEL_TYPE);
      console.log("[RAG Debug] RAG_MODEL_NAME:", process.env.RAG_MODEL_NAME);
      console.log("[RAG Debug] Parsed - enabled:", ragEnabled, "type:", modelType, "name:", modelName);
      
      checks.rag.enabled = ragEnabled;
      checks.rag.embeddingModel = `${modelType}/${modelName}`;
      checks.rag.configPath = join(root, ".env");
      
      if (ragEnabled) {
        // Check if API key is available for the model type
        const apiKeyEnvVars: Record<string, string[]> = {
          openai: ["OPENAI_API_KEY"],
          huggingface: ["HUGGINGFACE_API_KEY"],
          lmstudio: [], // LM Studio doesn't require API key
          mota: ["MOTA_API_KEY"],
          modelscope: ["MODELSCOPE_API_KEY"],
          siliconflow: ["SILICONFLOW_API_KEY"],
          zhipu: ["ZHIPU_API_KEY"],
          dashscope: ["DASHSCOPE_API_KEY"],
          local: [],
          custom: ["EMBEDDING_API_KEY"],
        };
        
        const envVars = apiKeyEnvVars[modelType] || ["OPENAI_API_KEY"];
        
        // For all models, check if the service is actually reachable
        if (modelType === "lmstudio" || modelType === "local") {
          try {
            const baseUrl = process.env.RAG_BASE_URL || (modelType === "lmstudio" ? "http://127.0.0.1:1234/v1/embeddings" : "http://localhost:11434/api/embeddings");
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 3000);
            
            const response = await fetch(baseUrl.replace("/v1/embeddings", "").replace("/api/embeddings", ""), {
              method: "GET",
              signal: controller.signal,
            });
            clearTimeout(timeout);
            
            checks.rag.available = response.ok;
          } catch {
            checks.rag.available = false;
          }
        } else {
          // For cloud models, verify API key exists and try a test request
          const hasApiKey = envVars.length === 0 || envVars.some(v => !!process.env[v]);
          
          if (!hasApiKey) {
            checks.rag.available = false;
          } else {
            // Try to make a test embedding request
            try {
              const { createEmbeddingClient } = await import("@actalk/inkos-core");
              const testConfig: VectorRetrievalConfig = {
                enabled: true,
                model: {
                  type: modelType as VectorModelType,
                  model: modelName,
                },
              };
              const client = createEmbeddingClient(testConfig.model);
              await client.embed("test");
              checks.rag.available = true;
            } catch (error) {
              console.log("[RAG Debug] Embedding test failed:", error instanceof Error ? error.message : String(error));
              checks.rag.available = false;
            }
          }
        }
      }
    } catch (error) {
      checks.rag.available = false;
    }

    return c.json(checks);
  });

  // --- Regenerate Foundation (for book creation flow) ---
  app.post("/api/books/:id/regenerate-foundation", async (c) => {
    const id = c.req.param("id");
    const { genre, brief, intent, clearChapters } = await c.req.json<{ genre?: string; brief?: string; intent?: string; clearChapters?: boolean }>();

    // Support both genre-based and intent-based regeneration
    if (!genre && !intent) {
      return c.json({ error: "genre or intent is required" }, 400);
    }

    // Create run record for task management
    const run = runStore.create({
      bookId: id,
      action: "regenerate-foundation",
    });
    runStore.markRunning(run.id, "重新生成基础设定");

    broadcast("foundation:regenerate:start", { bookId: id, genre, runId: run.id });
    try {
      const book = await state.loadBookConfig(id);
      const now = new Date().toISOString();

      const updatedBook = {
        ...book,
        ...(genre ? { genre } : {}),
        updatedAt: now,
      };

      await state.saveBookConfig(id, updatedBook);

      // 如果用户选择清理章节，删除所有已有章节和状态文件
      if (clearChapters) {
        const bookDir = state.bookDir(id);
        const chaptersDir = join(bookDir, "chapters");
        const storyDir = join(bookDir, "story");

        try {
          // 清理章节文件
          const chapterFiles = await readdir(chaptersDir).catch(() => [] as string[]);
          for (const file of chapterFiles) {
            if (file.endsWith(".md")) {
              await unlink(join(chaptersDir, file));
            }
          }

          // 清理状态文件（保留基础设定文件）
          const stateFilesToRemove = [
            "current_state.md",
            "pending_hooks.md",
            "chapter_summaries.md",
            "subplot_board.md",
            "emotional_arcs.md",
            "character_matrix.md",
            "particle_ledger.md",
          ];
          for (const file of stateFilesToRemove) {
            try {
              await unlink(join(storyDir, file));
            } catch {
              // 文件可能不存在，忽略错误
            }
          }

          // 重置章节索引
          await state.saveChapterIndex(id, []);

          broadcast("foundation:regenerate:progress", { bookId: id, message: "已清理已有章节" });
        } catch (e) {
          broadcast("foundation:regenerate:progress", { bookId: id, message: `清理章节时出错: ${e instanceof Error ? e.message : String(e)}` });
        }
      }

      const pipeline = new PipelineRunner(await buildPipelineConfig({ externalContext: brief || intent }));
      const result = await pipeline.regenerateFoundation(updatedBook, brief || intent);

      runStore.succeed(run.id, { bookId: id, result });
      broadcast("foundation:regenerate:complete", { bookId: id, runId: run.id });
      return c.json({ ok: true, bookId: id, runId: run.id, result, chaptersCleared: clearChapters });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      runStore.fail(run.id, error);
      broadcast("foundation:regenerate:error", { bookId: id, error, runId: run.id });
      return c.json({ error, runId: run.id }, 500);
    }
  });

  return app;
}

// --- Standalone runner ---

export async function startStudioServer(
  root: string,
  port = 4567,
  options?: { readonly staticDir?: string },
): Promise<void> {
  const config = await loadProjectConfig(root);

  const app = createStudioServer(config, root);

  // Serve frontend static files — single process for API + frontend
  if (options?.staticDir) {
    const { readFile: readFileFs } = await import("node:fs/promises");
    const { join: joinPath } = await import("node:path");
    const { existsSync } = await import("node:fs");

    // Serve static assets (js, css, etc.)
    app.get("/assets/*", async (c) => {
      const filePath = joinPath(options.staticDir!, c.req.path);
      try {
        const content = await readFileFs(filePath);
        const ext = filePath.split(".").pop() ?? "";
        const contentTypes: Record<string, string> = {
          js: "application/javascript",
          css: "text/css",
          svg: "image/svg+xml",
          png: "image/png",
          ico: "image/x-icon",
          json: "application/json",
        };
        return new Response(content, {
          headers: { "Content-Type": contentTypes[ext] ?? "application/octet-stream" },
        });
      } catch {
        return c.notFound();
      }
    });

    // SPA fallback — serve index.html for all non-API routes
    const indexPath = joinPath(options.staticDir!, "index.html");
    if (existsSync(indexPath)) {
      const indexHtml = await readFileFs(indexPath, "utf-8");
      app.get("*", (c) => {
        if (c.req.path.startsWith("/api/")) return c.notFound();
        return c.html(indexHtml);
      });
    }
  }

  console.log(`InkOS Studio running on http://localhost:${port}`);
  serve({ fetch: app.fetch, port });
}
