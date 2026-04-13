import type { LLMClient, OnStreamProgress } from "../llm/provider.js";
import { chatCompletion, createLLMClient } from "../llm/provider.js";
import type { Logger } from "../utils/logger.js";
import type { BookConfig, FanficMode } from "../models/book.js";
import type { ChapterMeta } from "../models/chapter.js";
import type { NotifyChannel, LLMConfig, AgentLLMOverride, InputGovernanceMode } from "../models/project.js";
import type { GenreProfile } from "../models/genre-profile.js";
import { ArchitectAgent, type ArchitectOutput } from "../agents/architect.js";
import { FoundationReviewerAgent } from "../agents/foundation-reviewer.js";
import { PlannerAgent, type PlanChapterOutput } from "../agents/planner.js";
import { ComposerAgent } from "../agents/composer.js";
import { WriterAgent, type WriteChapterInput, type WriteChapterOutput } from "../agents/writer.js";
import { LengthNormalizerAgent } from "../agents/length-normalizer.js";
import { ChapterAnalyzerAgent } from "../agents/chapter-analyzer.js";
import { ContinuityAuditor } from "../agents/continuity.js";
import { ChapterPlanAuditor } from "../agents/chapter-plan-auditor.js";
import { ReviserAgent, DEFAULT_REVISE_MODE, type ReviseMode } from "../agents/reviser.js";
import { StateValidatorAgent, type ValidationResult, type ValidationWarning } from "../agents/state-validator.js";
import { RadarAgent } from "../agents/radar.js";
import type { RadarSource } from "../agents/radar-source.js";
import { readGenreProfile } from "../agents/rules-reader.js";
import { analyzeAITells } from "../agents/ai-tells.js";
import { analyzeSensitiveWords } from "../agents/sensitive-words.js";
import { StateManager } from "../state/manager.js";
import { MemoryDB, type Fact } from "../state/memory-db.js";
import { dispatchNotification, dispatchWebhookEvent } from "../notify/dispatcher.js";
import type { WebhookEvent } from "../notify/webhook.js";
import type { AgentContext } from "../agents/base.js";
import type { AuditResult, AuditIssue } from "../agents/continuity.js";
import type { RadarResult } from "../agents/radar.js";
import type { LengthSpec, LengthTelemetry } from "../models/length-governance.js";
import type { ContextPackage, RuleStack } from "../models/input-governance.js";
import type { VectorRetrievalConfig } from "../vector/types.js";
import { buildLengthSpec, countChapterLength, formatLengthCount, isOutsideHardRange, isOutsideSoftRange, resolveLengthCountingMode, type LengthLanguage } from "../utils/length-metrics.js";
import { createRAGManager, type RAGManager } from "../rag/rag-manager.js";
import type { MemorySelection } from "../utils/memory-retrieval.js";
import { analyzeLongSpanFatigue } from "../utils/long-span-fatigue.js";
import { loadNarrativeMemorySeed, loadSnapshotCurrentStateFacts } from "../state/runtime-state-store.js";
import { rewriteStructuredStateFromMarkdown } from "../state/state-bootstrap.js";
import { readFile, readdir, writeFile, mkdir, rename, rm, stat, copyFile, unlink, access } from "node:fs/promises";
import { join } from "node:path";
import {
  parseStateDegradedReviewNote,
  resolveStateDegradedBaseStatus,
  retrySettlementAfterValidationFailure,
} from "./chapter-state-recovery.js";
import { persistChapterArtifacts } from "./chapter-persistence.js";
import { runChapterReviewCycle } from "./chapter-review-cycle.js";
import { validateChapterTruthPersistence } from "./chapter-truth-validation.js";
import { loadPersistedPlan, relativeToBookDir } from "./persisted-governed-plan.js";

const SEQUENCE_LEVEL_CATEGORIES = new Set([
  "Pacing Monotony", "节奏单调",
  "Mood Monotony", "情绪单调",
  "Title Collapse", "标题重复",
  "Title Clustering", "标题聚集",
  "Opening Pattern Repetition", "开头同构",
  "Ending Pattern Repetition", "结尾同构",
]);

function isSequenceLevelCategory(category: string): boolean {
  return SEQUENCE_LEVEL_CATEGORIES.has(category);
}

export interface PipelineConfig {
  readonly client: LLMClient;
  readonly model: string;
  readonly projectRoot: string;
  readonly defaultLLMConfig?: LLMConfig;
  readonly notifyChannels?: ReadonlyArray<NotifyChannel>;
  readonly radarSources?: ReadonlyArray<RadarSource>;
  readonly externalContext?: string;
  readonly modelOverrides?: Record<string, string | AgentLLMOverride>;
  readonly inputGovernanceMode?: InputGovernanceMode;
  readonly logger?: Logger;
  readonly onStreamProgress?: OnStreamProgress;
}

export interface TokenUsageSummary {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

export interface ChapterPipelineResult {
  readonly chapterNumber: number;
  readonly title: string;
  readonly wordCount: number;
  readonly auditResult: AuditResult;
  readonly revised: boolean;
  readonly status: "ready-for-review" | "audit-failed" | "state-degraded";
  readonly lengthWarnings?: ReadonlyArray<string>;
  readonly lengthTelemetry?: LengthTelemetry;
  readonly tokenUsage?: TokenUsageSummary;
}

// Atomic operation results
export interface DraftResult {
  readonly chapterNumber: number;
  readonly title: string;
  readonly wordCount: number;
  readonly filePath: string;
  readonly lengthWarnings?: ReadonlyArray<string>;
  readonly lengthTelemetry?: LengthTelemetry;
  readonly tokenUsage?: TokenUsageSummary;
}

export interface PlanChapterResult {
  readonly bookId: string;
  readonly chapterNumber: number;
  readonly intentPath: string;
  readonly goal: string;
  readonly conflicts: ReadonlyArray<string>;
}

export interface ComposeChapterResult extends PlanChapterResult {
  readonly contextPath: string;
  readonly ruleStackPath: string;
  readonly tracePath: string;
}

export interface ReviseResult {
  readonly chapterNumber: number;
  readonly wordCount: number;
  readonly fixedIssues: ReadonlyArray<string>;
  readonly applied: boolean;
  readonly status: "unchanged" | "ready-for-review" | "audit-failed";
  readonly skippedReason?: string;
  readonly lengthWarnings?: ReadonlyArray<string>;
  readonly lengthTelemetry?: LengthTelemetry;
}

export interface TruthFiles {
  readonly currentState: string;
  readonly particleLedger: string;
  readonly pendingHooks: string;
  readonly storyBible: string;
  readonly volumeOutline: string;
  readonly bookRules: string;
}

export interface BookStatusInfo {
  readonly bookId: string;
  readonly title: string;
  readonly genre: string;
  readonly platform: string;
  readonly status: string;
  readonly chaptersWritten: number;
  readonly totalWords: number;
  readonly nextChapter: number;
  readonly chapters: ReadonlyArray<ChapterMeta>;
}

interface MergedAuditEvaluation {
  readonly auditResult: AuditResult;
  readonly aiTellCount: number;
  readonly blockingCount: number;
  readonly criticalCount: number;
  readonly revisionBlockingIssues: ReadonlyArray<AuditIssue>;
}

export interface ImportChaptersInput {
  readonly bookId: string;
  readonly chapters: ReadonlyArray<{ readonly title: string; readonly content: string }>;
  readonly resumeFrom?: number;
  /** "continuation" (default) = pick up where the text left off, no new spacetime.
   *  "series" = shared universe but independent new story, requires new spacetime. */
  readonly importMode?: "continuation" | "series";
}

export interface ImportChaptersResult {
  readonly bookId: string;
  readonly importedCount: number;
  readonly totalWords: number;
  readonly nextChapter: number;
}

export class PipelineRunner {
  private readonly state: StateManager;
  private readonly config: PipelineConfig;
  private readonly agentClients = new Map<string, LLMClient>();
  private memoryIndexFallbackWarned = false;
  private ragManagers = new Map<string, RAGManager>();

  constructor(config: PipelineConfig) {
    this.config = config;
    this.state = new StateManager(config.projectRoot);
  }

  private localize(language: LengthLanguage, messages: { zh: string; en: string }): string {
    return language === "en" ? messages.en : messages.zh;
  }

  private async resolveBookLanguage(
    book: Pick<BookConfig, "genre" | "language">,
  ): Promise<LengthLanguage> {
    if (book.language) {
      return book.language;
    }

    try {
      const { profile } = await this.loadGenreProfile(book.genre);
      return profile.language;
    } catch {
      return "zh";
    }
  }

  private async resolveBookLanguageById(bookId: string): Promise<LengthLanguage> {
    try {
      const book = await this.state.loadBookConfig(bookId);
      return await this.resolveBookLanguage(book);
    } catch {
      return "zh";
    }
  }

  private languageFromLengthSpec(lengthSpec: Pick<LengthSpec, "countingMode">): LengthLanguage {
    return lengthSpec.countingMode === "en_words" ? "en" : "zh";
  }

  private logStage(language: LengthLanguage, message: { zh: string; en: string }): void {
    this.config.logger?.info(
      `${this.localize(language, { zh: "阶段：", en: "Stage: " })}${this.localize(language, message)}`,
    );
  }

  private logInfo(language: LengthLanguage, message: { zh: string; en: string }): void {
    this.config.logger?.info(this.localize(language, message));
  }

  private logWarn(language: LengthLanguage, message: { zh: string; en: string }): void {
    this.config.logger?.warn(this.localize(language, message));
  }

  private logError(language: LengthLanguage, message: { zh: string; en: string }): void {
    this.config.logger?.error(this.localize(language, message));
  }

  private async tryGenerateStyleGuide(
    bookId: string,
    referenceText: string,
    sourceName: string | undefined,
    language?: LengthLanguage,
  ): Promise<void> {
    try {
      await this.generateStyleGuide(bookId, referenceText, sourceName);
    } catch (error) {
      const resolvedLanguage = language ?? await this.resolveBookLanguageById(bookId);
      const detail = error instanceof Error ? error.message : String(error);
      this.logWarn(resolvedLanguage, {
        zh: `风格指纹提取失败，已跳过：${detail}`,
        en: `Style fingerprint extraction failed and was skipped: ${detail}`,
      });
    }
  }

  async regenerateOutline(
    bookId: string,
    authorIntent: string,
    rewriteLevel: "low" | "medium" | "high" = "medium",
  ): Promise<{ readonly volumeOutline: string; readonly tempPath: string }> {
    const book = await this.state.loadBookConfig(bookId);
    const bookDir = this.state.bookDir(bookId);
    const language = await this.resolveBookLanguage(book);

    this.logStage(language, {
      zh: "开始重新生成卷纲",
      en: "Regenerating volume outline",
    });

    const architect = new ArchitectAgent(this.config);
    const result = await architect.regenerateOutline(book, bookDir, authorIntent, rewriteLevel);

    // 保存为临时文件
    const tempPath = join(bookDir, "story", "volume_outline.temp.md");
    await writeFile(tempPath, result.volumeOutline, "utf-8");

    this.logInfo(language, {
      zh: "卷纲重新生成完成，已保存为临时文件",
      en: "Volume outline regenerated and saved as temporary file",
    });

    return { volumeOutline: result.volumeOutline, tempPath };
  }

  async confirmOutline(bookId: string): Promise<void> {
    const book = await this.state.loadBookConfig(bookId);
    const bookDir = this.state.bookDir(bookId);
    const language = await this.resolveBookLanguage(book);

    this.logStage(language, {
      zh: "确认卷纲更新",
      en: "Confirming outline update",
    });

    // 替换原卷纲文件
    const tempPath = join(bookDir, "story", "volume_outline.temp.md");
    const finalPath = join(bookDir, "story", "volume_outline.md");

    try {
      await copyFile(tempPath, finalPath);
      await unlink(tempPath);

      this.logInfo(language, {
        zh: "卷纲更新完成",
        en: "Volume outline updated successfully",
      });

      // 提前生成章节规划
      await this.preGenerateChapterPlans(bookId);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logWarn(language, {
        zh: `卷纲更新失败：${detail}`,
        en: `Failed to update volume outline: ${detail}`,
      });
      throw error;
    }
  }

  private async preGenerateChapterPlans(bookId: string): Promise<void> {
    const book = await this.state.loadBookConfig(bookId);
    const bookDir = this.state.bookDir(bookId);
    const language = await this.resolveBookLanguage(book);
    const nextChapter = await this.state.getNextChapterNumber(bookId);

    this.logStage(language, {
      zh: "开始提前生成章节规划",
      en: "Pre-generating chapter plans",
    });

    // 提前生成接下来3章的规划
    for (let i = 0; i < 3; i++) {
      const chapterNumber = nextChapter + i;
      if (chapterNumber > book.targetChapters) break;

      try {
        const planner = new PlannerAgent(this.config);
        await planner.planChapter({
          book,
          bookDir,
          chapterNumber,
        });

        this.logInfo(language, {
          zh: `已生成第 ${chapterNumber} 章规划`,
          en: `Generated plan for chapter ${chapterNumber}`,
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        this.logWarn(language, {
          zh: `生成第 ${nextChapter + i} 章规划失败：${detail}`,
          en: `Failed to generate plan for chapter ${nextChapter + i}: ${detail}`,
        });
      }
    }

    this.logInfo(language, {
      zh: "章节规划生成完成",
      en: "Chapter plans generated successfully",
    });
  }

  async updateChapterPlans(bookId: string): Promise<void> {
    const book = await this.state.loadBookConfig(bookId);
    const bookDir = this.state.bookDir(bookId);
    const language = await this.resolveBookLanguage(book);
    const nextChapter = await this.state.getNextChapterNumber(bookId);

    this.logStage(language, {
      zh: "更新章节规划",
      en: "Updating chapter plans",
    });

    // 更新接下来5章的规划
    for (let i = 0; i < 5; i++) {
      const chapterNumber = nextChapter + i;
      if (chapterNumber > book.targetChapters) break;

      try {
        const planner = new PlannerAgent(this.config);
        await planner.planChapter({
          book,
          bookDir,
          chapterNumber,
        });

        this.logInfo(language, {
          zh: `已更新第 ${chapterNumber} 章规划`,
          en: `Updated plan for chapter ${chapterNumber}`,
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        this.logWarn(language, {
          zh: `更新第 ${nextChapter + i} 章规划失败：${detail}`,
          en: `Failed to update plan for chapter ${nextChapter + i}: ${detail}`,
        });
      }
    }

    this.logInfo(language, {
      zh: "章节规划更新完成",
      en: "Chapter plans updated successfully",
    });
  }

  private async generateAndReviewFoundation(params: {
    readonly generate: (reviewFeedback?: string) => Promise<ArchitectOutput>;
    readonly reviewer: FoundationReviewerAgent;
    readonly mode: "original" | "fanfic" | "series";
    readonly sourceCanon?: string;
    readonly styleGuide?: string;
    readonly language: "zh" | "en";
    readonly stageLanguage: LengthLanguage;
    readonly maxRetries?: number;
    readonly passThreshold?: number;
    readonly dimensionFloor?: number;
  }): Promise<ArchitectOutput> {
    const maxRetries = params.maxRetries ?? 2;
    let foundation = await params.generate();

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      this.logStage(params.stageLanguage, {
        zh: `审核基础设定（第${attempt + 1}轮）`,
        en: `reviewing foundation (round ${attempt + 1})`,
      });

      const review = await params.reviewer.review({
        foundation,
        mode: params.mode,
        sourceCanon: params.sourceCanon,
        styleGuide: params.styleGuide,
        language: params.language,
        passThreshold: params.passThreshold,
        dimensionFloor: params.dimensionFloor,
      });

      this.config.logger?.info(
        `Foundation review: ${review.totalScore}/100 ${review.passed ? "PASSED" : "REJECTED"}`,
      );
      for (const dim of review.dimensions) {
        this.config.logger?.info(`  [${dim.score}] ${dim.name.slice(0, 40)}`);
      }

      if (review.passed) {
        return foundation;
      }

      this.logWarn(params.stageLanguage, {
        zh: `基础设定未通过审核（${review.totalScore}分），正在重新生成...`,
        en: `Foundation rejected (${review.totalScore}/100), regenerating...`,
      });

      foundation = await params.generate(this.buildFoundationReviewFeedback(review, params.language));
    }

    // Final review
    const finalReview = await params.reviewer.review({
      foundation,
      mode: params.mode,
      sourceCanon: params.sourceCanon,
      styleGuide: params.styleGuide,
      language: params.language,
      passThreshold: params.passThreshold,
      dimensionFloor: params.dimensionFloor,
    });
    this.config.logger?.info(
      `Foundation final review: ${finalReview.totalScore}/100 ${finalReview.passed ? "PASSED" : "ACCEPTED (max retries)"}`,
    );

    return foundation;
  }

  private buildFoundationReviewFeedback(
    review: {
      readonly dimensions: ReadonlyArray<{
        readonly name: string;
        readonly score: number;
        readonly feedback: string;
      }>;
      readonly overallFeedback: string;
    },
    language: "zh" | "en",
  ): string {
    const dimensionLines = review.dimensions
      .map((dimension) => (
        language === "en"
          ? `- ${dimension.name} [${dimension.score}]: ${dimension.feedback}`
          : `- ${dimension.name}（${dimension.score}分）：${dimension.feedback}`
      ))
      .join("\n");

    return language === "en"
      ? [
          "## Overall Feedback",
          review.overallFeedback,
          "",
          "## Dimension Notes",
          dimensionLines || "- none",
        ].join("\n")
      : [
          "## 总评",
          review.overallFeedback,
          "",
          "## 分项问题",
          dimensionLines || "- 无",
        ].join("\n");
  }

  private agentCtx(bookId?: string): AgentContext {
    return {
      client: this.config.client,
      model: this.config.model,
      projectRoot: this.config.projectRoot,
      bookId,
      logger: this.config.logger,
      onStreamProgress: this.config.onStreamProgress,
    };
  }

  private resolveOverride(agentName: string): { model: string; client: LLMClient } {
    const override = this.config.modelOverrides?.[agentName];
    if (!override) {
      return { model: this.config.model, client: this.config.client };
    }
    if (typeof override === "string") {
      return { model: override, client: this.config.client };
    }
    // Full override — needs its own client if baseUrl differs
    if (!override.baseUrl) {
      return { model: override.model, client: this.config.client };
    }
    const base = this.config.defaultLLMConfig;
    const provider = override.provider ?? base?.provider ?? "custom";
    const apiKeySource = override.apiKeyEnv
      ? `env:${override.apiKeyEnv}`
      : `base:${base?.apiKey ?? ""}`;
    const stream = override.stream ?? base?.stream ?? true;
    const apiFormat = base?.apiFormat ?? "chat";
    const cacheKey = [
      provider,
      override.baseUrl,
      apiKeySource,
      `stream:${stream}`,
      `format:${apiFormat}`,
    ].join("|");
    let client = this.agentClients.get(cacheKey);
    if (!client) {
      const apiKey = override.apiKeyEnv
        ? process.env[override.apiKeyEnv] ?? ""
        : base?.apiKey ?? "";
      client = createLLMClient({
        provider,
        baseUrl: override.baseUrl,
        apiKey,
        model: override.model,
        temperature: base?.temperature ?? 0.7,
        maxTokens: base?.maxTokens ?? 8192,
        thinkingBudget: base?.thinkingBudget ?? 0,
        apiFormat,
        stream,
      });
      this.agentClients.set(cacheKey, client);
    }
    return { model: override.model, client };
  }

  private agentCtxFor(agent: string, bookId?: string): AgentContext {
    const { model, client } = this.resolveOverride(agent);
    return {
      client,
      model,
      projectRoot: this.config.projectRoot,
      bookId,
      logger: this.config.logger?.child(agent),
      onStreamProgress: this.config.onStreamProgress,
    };
  }

  private async pathExists(path: string): Promise<boolean> {
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  }

  private async getRAGManager(bookId: string): Promise<RAGManager | null> {
    try {
      const bookDir = this.state.bookDir(bookId);
      const projectConfig = await this.state.loadProjectConfig();
      const vectorRetrievalConfig = projectConfig.vectorRetrieval as VectorRetrievalConfig | undefined;
      
      if (!vectorRetrievalConfig || !vectorRetrievalConfig.enabled) {
        return null;
      }
      
      if (this.ragManagers.has(bookId)) {
        return this.ragManagers.get(bookId)!;
      }
      
      const ragManager = await createRAGManager({
        bookDir,
        config: vectorRetrievalConfig,
        llmClient: this.config.client,
      });
      
      if (ragManager.isAvailable()) {
        this.ragManagers.set(bookId, ragManager);
        return ragManager;
      }
      
      return null;
    } catch (error) {
      this.config.logger?.warn(`Failed to initialize RAG manager: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  private async indexMemoryToRAG(bookId: string): Promise<void> {
    try {
      const ragManager = await this.getRAGManager(bookId);
      if (!ragManager) return;
      
      const bookDir = this.state.bookDir(bookId);
      const { retrieveMemorySelection } = await import("../utils/memory-retrieval.js");
      const memorySelection = await retrieveMemorySelection({
        bookDir,
        chapterNumber: await this.state.getNextChapterNumber(bookId),
        goal: "Index memory for RAG system",
      });
      await ragManager.indexMemory(memorySelection);
      this.config.logger?.info(`RAG memory indexed for book ${bookId}`);
    } catch (error) {
      this.config.logger?.warn(`Failed to index memory to RAG: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async indexBookFoundationToRAG(bookId: string): Promise<void> {
    try {
      const ragManager = await this.getRAGManager(bookId);
      if (!ragManager) return;
      
      const bookDir = this.state.bookDir(bookId);
      const storyDir = join(bookDir, "story");
      
      // 读取基础设定文件
      const foundationFiles = [
        "story_bible.md",
        "volume_outline.md",
        "book_rules.md",
        "style_guide.md"
      ];
      
      for (const fileName of foundationFiles) {
        try {
          const filePath = join(storyDir, fileName);
          const content = await readFile(filePath, "utf-8");
          
          // 处理文件内容并索引
          const { createDocumentProcessor } = await import("../rag/document-processor.js");
          const documentProcessor = createDocumentProcessor();
          const chunks = documentProcessor.processDocument(content, {
            fileName,
            type: "foundation",
          });
          
          // 手动添加到向量存储
          const vectorStore = (ragManager as any).vectorStore;
          if (vectorStore) {
            await vectorStore.addChunks(chunks);
          }
          
          this.config.logger?.info(`Indexed foundation file ${fileName} for book ${bookId}`);
        } catch (error) {
          // 文件不存在或读取失败，跳过
          this.config.logger?.debug(`Failed to index foundation file ${fileName}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      
      this.config.logger?.info(`RAG foundation indexed for book ${bookId}`);
    } catch (error) {
      this.config.logger?.warn(`Failed to index book foundation to RAG: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async loadGenreProfile(genre: string): Promise<{ profile: GenreProfile }> {
    const parsed = await readGenreProfile(this.config.projectRoot, genre);
    return { profile: parsed.profile };
  }

  // ---------------------------------------------------------------------------
  // Atomic operations (composable by OpenClaw or agent mode)
  // ---------------------------------------------------------------------------

  async runRadar(): Promise<RadarResult> {
    const radar = new RadarAgent(this.agentCtxFor("radar"), this.config.radarSources);
    return radar.scan();
  }

  async initBook(book: BookConfig): Promise<{ readonly volumeOutline: string; readonly tempPath: string }> {
    const architect = new ArchitectAgent(this.agentCtxFor("architect", book.id));
    const bookDir = this.state.bookDir(book.id);
    const stagingBookDir = join(
      this.state.booksDir,
      `.tmp-book-create-${book.id}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    );
    const stageLanguage = await this.resolveBookLanguage(book);

    console.log(`\n[PipelineRunner.initBook] 创建临时目录`);
    console.log(`[PipelineRunner.initBook] 临时目录路径：${stagingBookDir}`);
    
    // 创建临时目录后，尝试从正式书籍目录复制审计配置到临时目录
    try {
      console.log(`[PipelineRunner.initBook] 检查正式书籍目录是否存在审计配置`);
      const formalAuditConfigPath = join(bookDir, "audit-config.json");
      try {
        await access(formalAuditConfigPath);
        console.log(`[PipelineRunner.initBook] 正式书籍目录存在审计配置：${formalAuditConfigPath}`);
        
        // 创建临时目录
        await mkdir(stagingBookDir, { recursive: true });
        console.log(`[PipelineRunner.initBook] 临时目录创建成功`);
        
        // 复制审计配置到临时目录
        const tempAuditConfigPath = join(stagingBookDir, "audit-config.json");
        await copyFile(formalAuditConfigPath, tempAuditConfigPath);
        console.log(`[PipelineRunner.initBook] 审计配置已从正式目录复制到临时目录：${tempAuditConfigPath}`);
        
        // 验证复制
        try {
          await access(tempAuditConfigPath);
          console.log(`[PipelineRunner.initBook] 验证：临时目录中的审计配置文件存在`);
        } catch {
          console.warn(`[PipelineRunner.initBook] 验证：临时目录中的审计配置文件不存在！`);
        }
      } catch {
        console.log(`[PipelineRunner.initBook] 正式书籍目录不存在审计配置，跳过复制`);
        // 创建临时目录
        await mkdir(stagingBookDir, { recursive: true });
        console.log(`[PipelineRunner.initBook] 临时目录创建成功`);
      }
    } catch (e) {
      console.warn(`[PipelineRunner.initBook] 复制审计配置失败：${e instanceof Error ? e.message : String(e)}`);
      // 创建临时目录
      try {
        await mkdir(stagingBookDir, { recursive: true });
        console.log(`[PipelineRunner.initBook] 临时目录创建成功`);
      } catch (mkdirError) {
        console.error(`[PipelineRunner.initBook] 临时目录创建失败：${mkdirError instanceof Error ? mkdirError.message : String(mkdirError)}`);
      }
    }

    this.logStage(stageLanguage, { zh: "生成基础设定", en: "generating foundation" });
    const { profile: gp } = await this.loadGenreProfile(book.genre);
    const reviewer = new FoundationReviewerAgent(this.agentCtxFor("foundation-reviewer", book.id));
    const resolvedLanguage = (book.language ?? gp.language) === "en" ? "en" as const : "zh" as const;
    
    // 尝试加载审计配置
    let passThreshold = 80;
    let dimensionFloor = 60;
    try {
      // 先尝试从正式书籍目录加载审计配置
      try {
        const auditConfig = await this.state.loadAuditConfig(book.id);
        if (auditConfig) {
          // 使用类型断言来访问属性
          const config = auditConfig as any;
          // 检查审计配置的结构
          if (config.foundationReview && typeof config.foundationReview === 'object') {
            // 检查passThreshold和dimensionFloor属性
            if (config.foundationReview.passThreshold !== undefined) {
              passThreshold = config.foundationReview.passThreshold;
            } else if (config.foundationReview.minScore !== undefined) {
              passThreshold = config.foundationReview.minScore;
            }
            if (config.foundationReview.dimensionFloor !== undefined) {
              dimensionFloor = config.foundationReview.dimensionFloor;
            } else if (config.foundationReview.minDimensionScore !== undefined) {
              dimensionFloor = config.foundationReview.minDimensionScore;
            }
          } else if (config.passCriteria && typeof config.passCriteria === 'object') {
            passThreshold = config.passCriteria.foundationReview?.minScore ?? 80;
            dimensionFloor = config.passCriteria.foundationReview?.minDimensionScore ?? 60;
          }
        }
      } catch (e) {
        // 如果从正式书籍目录加载失败，尝试从临时目录加载
        this.config.logger?.debug(`Failed to load audit config from book directory: ${e instanceof Error ? e.message : String(e)}`);
        try {
          // 查找临时目录
          const booksDir = this.state.booksDir;
          const files = await readdir(booksDir);
          const tempDirs = files.filter(f => f.startsWith(".tmp-book-create-") && f.includes(book.id));
          if (tempDirs.length > 0) {
            const tempDir = join(booksDir, tempDirs[0]);
            const auditConfig = await this.state.loadAuditConfigAt(tempDir);
            if (auditConfig) {
              // 使用类型断言来访问属性
              const config = auditConfig as any;
              // 检查审计配置的结构
              if (config.foundationReview && typeof config.foundationReview === 'object') {
                // 检查passThreshold和dimensionFloor属性
                if (config.foundationReview.passThreshold !== undefined) {
                  passThreshold = config.foundationReview.passThreshold;
                } else if (config.foundationReview.minScore !== undefined) {
                  passThreshold = config.foundationReview.minScore;
                }
                if (config.foundationReview.dimensionFloor !== undefined) {
                  dimensionFloor = config.foundationReview.dimensionFloor;
                } else if (config.foundationReview.minDimensionScore !== undefined) {
                  dimensionFloor = config.foundationReview.minDimensionScore;
                }
              } else if (config.passCriteria && typeof config.passCriteria === 'object') {
                passThreshold = config.passCriteria.foundationReview?.minScore ?? 80;
                dimensionFloor = config.passCriteria.foundationReview?.minDimensionScore ?? 60;
              }
            }
          }
        } catch (tempError) {
          // 如果从临时目录加载也失败，使用默认值
          this.config.logger?.debug(`Failed to load audit config from temp directory: ${tempError instanceof Error ? tempError.message : String(tempError)}`);
        }
      }
    } catch (e) {
      // 如果加载审计配置失败，使用默认值
      this.config.logger?.debug(`Failed to load audit config: ${e instanceof Error ? e.message : String(e)}`);
    }
    
    // 输出加载的审计配置，以便调试
    console.log(`Loaded audit config for book ${book.id}: passThreshold=${passThreshold}, dimensionFloor=${dimensionFloor}`);
    this.config.logger?.info(`Loaded audit config for book ${book.id}: passThreshold=${passThreshold}, dimensionFloor=${dimensionFloor}`);
    
    const foundation = await this.generateAndReviewFoundation({
      generate: (reviewFeedback) => architect.generateFoundation(
        book,
        this.config.externalContext,
        reviewFeedback,
      ),
      reviewer,
      mode: "original",
      language: resolvedLanguage,
      stageLanguage,
      passThreshold,
      dimensionFloor,
    });
    try {
      this.logStage(stageLanguage, { zh: "保存书籍配置", en: "saving book config" });
      await this.state.saveBookConfigAt(stagingBookDir, book);

      this.logStage(stageLanguage, { zh: "写入基础设定文件", en: "writing foundation files" });
      await architect.writeFoundationFiles(
        stagingBookDir,
        foundation,
        gp.numericalSystem,
        book.language ?? gp.language,
      );

      this.logStage(stageLanguage, { zh: "初始化控制文档", en: "initializing control documents" });
      await this.state.ensureControlDocumentsAt(
        stagingBookDir,
        book.language ?? gp.language,
        this.config.externalContext,
      );

      await this.state.saveChapterIndexAt(stagingBookDir, []);

      this.logStage(stageLanguage, { zh: "创建初始快照", en: "creating initial snapshot" });
      await this.state.snapshotStateAt(stagingBookDir, 0);

      // 保存为临时目录，等待用户确认卷纲
      if (await this.pathExists(bookDir)) {
        if (await this.state.isCompleteBookDirectory(bookDir)) {
          throw new Error(`Book "${book.id}" already exists at books/${book.id}/. Use a different title or delete the existing book first.`);
        }
        await rm(bookDir, { recursive: true, force: true });
      }

      console.log(`\n[PipelineRunner.initBook] 卷纲生成完成，准备重命名临时目录为正式目录`);
      console.log(`[PipelineRunner.initBook] 临时目录：${stagingBookDir}`);
      console.log(`[PipelineRunner.initBook] 正式目录：${bookDir}`);
      
      // 保存卷纲为临时文件
      const tempPath = join(stagingBookDir, "story", "volume_outline.temp.md");
      await writeFile(tempPath, foundation.volumeOutline, "utf-8");
      
      // 重命名临时目录为正式书籍目录
      try {
        await rename(stagingBookDir, bookDir);
        console.log(`[PipelineRunner.initBook] 临时目录已重命名为正式目录：${bookDir}`);
        
        // 更新书籍状态为 outlining
        const bookConfigPath = join(bookDir, "book.json");
        const bookConfig = JSON.parse(await readFile(bookConfigPath, "utf-8"));
        bookConfig.status = "outlining";
        bookConfig.updatedAt = new Date().toISOString();
        await writeFile(bookConfigPath, JSON.stringify(bookConfig, null, 2), "utf-8");
        console.log(`[PipelineRunner.initBook] 书籍状态已更新为：outlining`);
        
        // 验证重命名
        try {
          await access(join(bookDir, "story", "story_bible.md"));
          console.log(`[PipelineRunner.initBook] 验证：正式目录中的基础设定文件存在`);
        } catch {
          console.warn(`[PipelineRunner.initBook] 验证：正式目录中的基础设定文件不存在！`);
        }
      } catch (renameError) {
        console.warn(`[PipelineRunner.initBook] 重命名失败：${renameError instanceof Error ? renameError.message : String(renameError)}`);
        // 如果重命名失败，保留临时目录
      }

      this.logInfo(stageLanguage, {
        zh: "卷纲生成完成，等待用户确认",
        en: "Volume outline generated, waiting for user confirmation",
      });

      return { volumeOutline: foundation.volumeOutline, tempPath: bookDir };
    } catch (error) {
      await rm(stagingBookDir, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  async confirmBookCreation(bookId: string, tempPath: string): Promise<void> {
    const book = await this.state.loadBookConfig(bookId);
    const bookDir = this.state.bookDir(bookId);
    const stageLanguage = await this.resolveBookLanguage(book);

    console.log(`\n[PipelineRunner.confirmBookCreation] 确认书籍创建`);
    console.log(`[PipelineRunner.confirmBookCreation] 书籍 ID: ${bookId}`);
    console.log(`[PipelineRunner.confirmBookCreation] 书籍目录：${bookDir}`);

    this.logStage(stageLanguage, { zh: "确认书籍创建", en: "Confirming book creation" });

    try {
      // 替换原卷纲文件
      const tempOutlinePath = join(bookDir, "story", "volume_outline.temp.md");
      const finalOutlinePath = join(bookDir, "story", "volume_outline.md");
      await copyFile(tempOutlinePath, finalOutlinePath);
      await unlink(tempOutlinePath);
      
      console.log(`[PipelineRunner.confirmBookCreation] 卷纲文件已替换`);

      // 更新书籍状态为 active
      const bookConfigPath = join(bookDir, "book.json");
      const bookConfig = JSON.parse(await readFile(bookConfigPath, "utf-8"));
      bookConfig.status = "active";
      bookConfig.updatedAt = new Date().toISOString();
      await writeFile(bookConfigPath, JSON.stringify(bookConfig, null, 2), "utf-8");
      console.log(`[PipelineRunner.confirmBookCreation] 书籍状态已更新为：active`);

      this.logInfo(stageLanguage, {
        zh: "书籍创建完成",
        en: "Book creation completed",
      });

      // 索引基础设定文件到 RAG 系统
      await this.indexBookFoundationToRAG(bookId);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logWarn(stageLanguage, {
        zh: `书籍创建失败：${detail}`,
        en: `Failed to create book: ${detail}`,
      });
      throw error;
    }
  }

  async generateChapterPlansForVolume(bookId: string, volumeId: number): Promise<void> {
    const book = await this.state.loadBookConfig(bookId);
    const bookDir = this.state.bookDir(bookId);
    const stageLanguage = await this.resolveBookLanguage(book);

    this.logStage(stageLanguage, {
      zh: `为第 ${volumeId} 卷生成章节规划`,
      en: `Generating chapter plans for volume ${volumeId}`,
    });

    // 优先从 .volume-plans-meta.json 读取章节范围
    const metaPath = join(bookDir, "story", ".volume-plans-meta.json");
    let startChapter: number;
    let endChapter: number;
    let chapterRangeSource = "meta";
    
    try {
      const metaContent = await readFile(metaPath, "utf-8");
      const meta = JSON.parse(metaContent);
      const volumeMeta = meta.volumePlans?.find((vp: any) => vp.volumeId === volumeId);
      
      if (volumeMeta?.chapterRange) {
        startChapter = volumeMeta.chapterRange.start;
        endChapter = volumeMeta.chapterRange.end;
        this.logInfo(stageLanguage, {
          zh: `从元数据读取第 ${volumeId} 卷章节范围：第${startChapter}-${endChapter}章`,
          en: `Read volume ${volumeId} chapter range from metadata: chapters ${startChapter}-${endChapter}`,
        });
      } else {
        throw new Error(`Volume ${volumeId} chapter range not found in metadata`);
      }
    } catch (metaError) {
      // 元数据读取失败，回退到从卷纲文件解析
      this.logWarn(stageLanguage, {
        zh: `无法从元数据读取章节范围，尝试从卷纲文件解析: ${metaError instanceof Error ? metaError.message : String(metaError)}`,
        en: `Failed to read chapter range from metadata, falling back to outline file: ${metaError instanceof Error ? metaError.message : String(metaError)}`,
      });
      
      // 优先读取分卷详细卷纲
      const detailPath = join(bookDir, "story", `volume_${volumeId}_detail.md`);
      const outlinePath = join(bookDir, "story", "volume_outline.md");
      
      try {
        // 尝试读取分卷详细卷纲
        const detailContent = await readFile(detailPath, "utf-8");
        this.logInfo(stageLanguage, {
          zh: `使用第 ${volumeId} 卷详细卷纲解析章节范围`,
          en: `Using volume ${volumeId} detail outline to parse chapter range`,
        });
        
        // 从详细卷纲中解析章节范围
        const rangeMatch = detailContent.match(/章节范围[：:]\s*(?:第)?(\d+)[\s-]*(?:章)?[\s-]*(?:第)?(\d+)(?:章)?/i);
        if (rangeMatch) {
          startChapter = parseInt(rangeMatch[1], 10);
          endChapter = parseInt(rangeMatch[2], 10);
          chapterRangeSource = "detail";
        } else {
          throw new Error(`Chapter range not found in detail outline`);
        }
      } catch {
        // 详细卷纲不存在或解析失败，读取总卷纲
        const outlineContent = await readFile(outlinePath, "utf-8");
        this.logInfo(stageLanguage, {
          zh: `使用总卷纲解析第 ${volumeId} 卷章节范围`,
          en: `Using main outline to parse volume ${volumeId} chapter range`,
        });
        
        // 解析卷纲，找到指定卷的章节范围
        const volumeRegex = new RegExp(`### 第${volumeId}卷[\\s\\S]*?章节范围[：:](\\d+)-(\\d+)`, "i");
        const match = volumeRegex.exec(outlineContent);
        if (!match) {
          throw new Error(`Volume ${volumeId} not found in outline`);
        }
        startChapter = parseInt(match[1], 10);
        endChapter = parseInt(match[2], 10);
        chapterRangeSource = "outline";
      }
    }

    this.logInfo(stageLanguage, {
      zh: `第 ${volumeId} 卷章节范围：第${startChapter}-${endChapter}章，共${endChapter - startChapter + 1}章（来源：${chapterRangeSource}）`,
      en: `Volume ${volumeId} chapter range: chapters ${startChapter}-${endChapter}, total ${endChapter - startChapter + 1} chapters (source: ${chapterRangeSource})`,
    });

    // 加载审计配置
    const { loadAuditConfig } = await import("../config/audit-config.js");
    const auditConfig = loadAuditConfig(bookDir);

    // 读取卷纲和详细卷纲（用于审计）
    const outlinePath = join(bookDir, "story", "volume_outline.md");
    const detailPath = join(bookDir, "story", `volume_${volumeId}_detail.md`);
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

    // 生成章节规划
    for (let chapterNumber = startChapter; chapterNumber <= endChapter; chapterNumber++) {
      if (chapterNumber > book.targetChapters) break;

      try {
        this.logInfo(stageLanguage, {
          zh: `正在生成第 ${chapterNumber} 章规划...`,
          en: `Generating plan for chapter ${chapterNumber}...`,
        });

        let attempt = 0;
        let auditResult = null;
        let planGenerated = false;

        do {
          // 生成章节规划
          const planner = new PlannerAgent(this.config);
          await planner.planChapter({
            book,
            bookDir,
            chapterNumber,
          });

          // 如果审计未启用，直接通过
          if (!auditConfig.chapterPlanAudit.enabled) {
            planGenerated = true;
            break;
          }

          // 读取生成的章节规划
          const planPath = join(bookDir, "story", "runtime", `chapter-${String(chapterNumber).padStart(4, "0")}.intent.md`);
          let chapterPlan;
          try {
            const planContent = await readFile(planPath, "utf-8");
            chapterPlan = this.parseChapterIntent(planContent);
          } catch {
            this.logWarn(stageLanguage, {
              zh: `无法读取第 ${chapterNumber} 章规划文件，跳过审计`,
              en: `Cannot read chapter ${chapterNumber} plan file, skipping audit`,
            });
            planGenerated = true;
            break;
          }

          // 审计章节规划
          this.logInfo(stageLanguage, {
            zh: `正在审计第 ${chapterNumber} 章规划（第 ${attempt + 1} 次）...`,
            en: `Auditing chapter ${chapterNumber} plan (attempt ${attempt + 1})...`,
          });

          const auditor = new ChapterPlanAuditor(this.agentCtxFor("chapter-plan-auditor", bookId));
          auditResult = await auditor.audit({
            chapterNumber,
            chapterPlan: chapterPlan as import("../models/input-governance.js").ChapterIntent,
            volumeOutline,
            volumeDetail,
            bookRules: await this.readBookRules(bookDir),
            config: auditConfig.chapterPlanAudit,
          });

          if (auditResult.passed) {
            this.logInfo(stageLanguage, {
              zh: `✓ 第 ${chapterNumber} 章规划审计通过（${auditResult.score}分）`,
              en: `✓ Chapter ${chapterNumber} plan audit passed (${auditResult.score} points)`,
            });
            // 保存审计成功状态
            await this.saveChapterPlanAuditSuccess(bookDir, chapterNumber, auditResult);
            planGenerated = true;
            break;
          } else if (attempt < auditConfig.chapterPlanAudit.maxRetries) {
            this.logWarn(stageLanguage, {
              zh: `✗ 第 ${chapterNumber} 章规划审计未通过（${auditResult.score}分），正在重新生成...`,
              en: `✗ Chapter ${chapterNumber} plan audit failed (${auditResult.score} points), regenerating...`,
            });
            // 删除失败的规划文件，以便重新生成
            try {
              await unlink(planPath);
            } catch {
              // 忽略删除错误
            }
          }

          attempt++;
        } while (attempt <= auditConfig.chapterPlanAudit.maxRetries);

        if (!planGenerated) {
          // 超过最大重试次数，标记为失败
          this.logError(stageLanguage, {
            zh: `✗ 第 ${chapterNumber} 章规划审计连续${auditConfig.chapterPlanAudit.maxRetries}次未通过，已终止`,
            en: `✗ Chapter ${chapterNumber} plan audit failed ${auditConfig.chapterPlanAudit.maxRetries} times, terminated`,
          });
          
          // 保存审计失败信息到元数据
          await this.saveChapterPlanAuditFailure(bookDir, chapterNumber, auditResult);
        } else {
          this.logInfo(stageLanguage, {
            zh: `✓ 已生成第 ${chapterNumber} 章规划`,
            en: `✓ Generated plan for chapter ${chapterNumber}`,
          });
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        this.logWarn(stageLanguage, {
          zh: `✗ 生成第 ${chapterNumber} 章规划失败：${detail}`,
          en: `✗ Failed to generate plan for chapter ${chapterNumber}: ${detail}`,
        });
      }
    }

    this.logInfo(stageLanguage, {
      zh: `第 ${volumeId} 卷章节规划生成完成`,
      en: `Chapter plans for volume ${volumeId} generated successfully`,
    });
  }

  async generateSingleChapterPlan(bookId: string, volumeId: number, chapterNumber: number): Promise<void> {
    const book = await this.state.loadBookConfig(bookId);
    const bookDir = this.state.bookDir(bookId);
    const stageLanguage = await this.resolveBookLanguage(book);

    this.logStage(stageLanguage, {
      zh: `为第 ${volumeId} 卷第 ${chapterNumber} 章生成章节规划`,
      en: `Generating chapter plan for volume ${volumeId} chapter ${chapterNumber}`,
    });

    // 加载审计配置
    const { loadAuditConfig } = await import("../config/audit-config.js");
    const auditConfig = loadAuditConfig(bookDir);

    // 读取卷纲和详细卷纲（用于审计）
    const outlinePath = join(bookDir, "story", "volume_outline.md");
    const detailPath = join(bookDir, "story", `volume_${volumeId}_detail.md`);
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

    try {
      this.logInfo(stageLanguage, {
        zh: `正在生成第 ${chapterNumber} 章规划...`,
        en: `Generating plan for chapter ${chapterNumber}...`,
      });

      let attempt = 0;
      let auditResult = null;
      let planGenerated = false;

      do {
        // 生成章节规划
        const planner = new PlannerAgent(this.config);
        await planner.planChapter({
          book,
          bookDir,
          chapterNumber,
        });

        // 如果审计未启用，直接通过
        if (!auditConfig.chapterPlanAudit.enabled) {
          planGenerated = true;
          break;
        }

        // 读取生成的章节规划
        const planPath = join(bookDir, "story", "runtime", `chapter-${String(chapterNumber).padStart(4, "0")}.intent.md`);
        let chapterPlan;
        try {
          const planContent = await readFile(planPath, "utf-8");
          chapterPlan = this.parseChapterIntent(planContent);
        } catch {
          this.logWarn(stageLanguage, {
            zh: `无法读取第 ${chapterNumber} 章规划文件，跳过审计`,
            en: `Cannot read chapter ${chapterNumber} plan file, skipping audit`,
          });
          planGenerated = true;
          break;
        }

        // 审计章节规划
        this.logInfo(stageLanguage, {
          zh: `正在审计第 ${chapterNumber} 章规划（第 ${attempt + 1} 次）...`,
          en: `Auditing chapter ${chapterNumber} plan (attempt ${attempt + 1})...`,
        });

        const { ChapterPlanAuditor } = await import("../agents/chapter-plan-auditor.js");
        const auditor = new ChapterPlanAuditor(this.agentCtxFor("chapter-plan-auditor", bookId));
        auditResult = await auditor.audit({
          chapterNumber,
          chapterPlan: chapterPlan as import("../models/input-governance.js").ChapterIntent,
          volumeOutline,
          volumeDetail,
          bookRules: await this.readBookRules(bookDir),
          config: auditConfig.chapterPlanAudit,
        });

        if (auditResult.passed) {
          this.logInfo(stageLanguage, {
            zh: `✓ 第 ${chapterNumber} 章规划审计通过（${auditResult.score}分）`,
            en: `✓ Chapter ${chapterNumber} plan audit passed (${auditResult.score} points)`,
          });
          // 保存审计成功状态
          await this.saveChapterPlanAuditSuccess(bookDir, chapterNumber, auditResult);
          planGenerated = true;
          break;
        } else if (attempt < auditConfig.chapterPlanAudit.maxRetries) {
          this.logWarn(stageLanguage, {
            zh: `✗ 第 ${chapterNumber} 章规划审计未通过（${auditResult.score}分），正在重新生成...`,
            en: `✗ Chapter ${chapterNumber} plan audit failed (${auditResult.score} points), regenerating...`,
          });
          // 删除失败的规划文件，以便重新生成
          try {
            await unlink(planPath);
          } catch {
            // 忽略删除错误
          }
        }

        attempt++;
      } while (attempt <= auditConfig.chapterPlanAudit.maxRetries);

      if (!planGenerated) {
        // 超过最大重试次数，标记为失败
        this.logError(stageLanguage, {
          zh: `✗ 第 ${chapterNumber} 章规划审计连续${auditConfig.chapterPlanAudit.maxRetries}次未通过，已终止`,
          en: `✗ Chapter ${chapterNumber} plan audit failed ${auditConfig.chapterPlanAudit.maxRetries} times, terminated`,
        });
        
        // 保存审计失败信息到元数据
        await this.saveChapterPlanAuditFailure(bookDir, chapterNumber, auditResult);
        throw new Error(`Chapter ${chapterNumber} plan audit failed after ${auditConfig.chapterPlanAudit.maxRetries} retries`);
      } else {
        this.logInfo(stageLanguage, {
          zh: `✓ 已生成第 ${chapterNumber} 章规划`,
          en: `✓ Generated plan for chapter ${chapterNumber}`,
        });
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logWarn(stageLanguage, {
        zh: `✗ 生成第 ${chapterNumber} 章规划失败：${detail}`,
        en: `✗ Failed to generate plan for chapter ${chapterNumber}: ${detail}`,
      });
      throw error;
    }
  }

  async regenerateVolumeChapters(bookId: string, volumeId: number): Promise<void> {
    const book = await this.state.loadBookConfig(bookId);
    const bookDir = this.state.bookDir(bookId);
    const stageLanguage = await this.resolveBookLanguage(book);

    this.logStage(stageLanguage, {
      zh: `重写第 ${volumeId} 卷章节`,
      en: `Rewriting chapters for volume ${volumeId}`,
    });

    // 优先从 .volume-plans-meta.json 读取章节范围
    const metaPath = join(bookDir, "story", ".volume-plans-meta.json");
    let startChapter: number;
    let endChapter: number;
    let chapterRangeSource = "meta";
    
    try {
      const metaContent = await readFile(metaPath, "utf-8");
      const meta = JSON.parse(metaContent);
      const volumeMeta = meta.volumePlans?.find((vp: any) => vp.volumeId === volumeId);
      
      if (volumeMeta?.chapterRange) {
        startChapter = volumeMeta.chapterRange.start;
        endChapter = volumeMeta.chapterRange.end;
        this.logInfo(stageLanguage, {
          zh: `从元数据读取第 ${volumeId} 卷章节范围：第${startChapter}-${endChapter}章`,
          en: `Read volume ${volumeId} chapter range from metadata: chapters ${startChapter}-${endChapter}`,
        });
      } else {
        throw new Error(`Volume ${volumeId} chapter range not found in metadata`);
      }
    } catch (metaError) {
      // 元数据读取失败，回退到从卷纲文件解析
      this.logWarn(stageLanguage, {
        zh: `无法从元数据读取章节范围，尝试从卷纲文件解析: ${metaError instanceof Error ? metaError.message : String(metaError)}`,
        en: `Failed to read chapter range from metadata, falling back to outline file: ${metaError instanceof Error ? metaError.message : String(metaError)}`,
      });
      
      // 优先读取分卷详细卷纲
      const detailPath = join(bookDir, "story", `volume_${volumeId}_detail.md`);
      const outlinePath = join(bookDir, "story", "volume_outline.md");
      
      try {
        // 尝试读取分卷详细卷纲
        const detailContent = await readFile(detailPath, "utf-8");
        this.logInfo(stageLanguage, {
          zh: `使用第 ${volumeId} 卷详细卷纲确定章节范围`,
          en: `Using volume ${volumeId} detail outline to determine chapter range`,
        });
        
        // 从详细卷纲中解析章节范围
        const rangeMatch = detailContent.match(/章节范围[：:]\s*(?:第)?(\d+)[\s-]*(?:章)?[\s-]*(?:第)?(\d+)(?:章)?/i);
        if (rangeMatch) {
          startChapter = parseInt(rangeMatch[1], 10);
          endChapter = parseInt(rangeMatch[2], 10);
          chapterRangeSource = "detail";
        } else {
          throw new Error(`Chapter range not found in detail outline`);
        }
      } catch {
        // 详细卷纲不存在或解析失败，读取总卷纲
        const outlineContent = await readFile(outlinePath, "utf-8");
        this.logInfo(stageLanguage, {
          zh: `使用总卷纲确定第 ${volumeId} 卷章节范围`,
          en: `Using main outline to determine volume ${volumeId} chapter range`,
        });
        
        // 解析卷纲，找到指定卷的章节范围
        const volumeRegex = new RegExp(`### 第${volumeId}卷[\\s\\S]*?章节范围[：:](\\d+)-(\\d+)`, "i");
        const match = volumeRegex.exec(outlineContent);
        if (!match) {
          throw new Error(`Volume ${volumeId} not found in outline`);
        }
        startChapter = parseInt(match[1], 10);
        endChapter = parseInt(match[2], 10);
        chapterRangeSource = "outline";
      }
    }

    // 重写本卷所有章节
    for (let chapterNumber = startChapter; chapterNumber <= endChapter; chapterNumber++) {
      if (chapterNumber > book.targetChapters) break;

      try {
        // 检查章节是否存在
        const chaptersDir = join(bookDir, "chapters");
        const files = await readdir(chaptersDir);
        const paddedNum = String(chapterNumber).padStart(4, "0");
        const existingFile = files.find((f) => f.startsWith(paddedNum) && f.endsWith(".md"));
        
        if (existingFile) {
          // 重写章节
          await this.reviseDraft(bookId, chapterNumber, "rewrite");
          
          // 审计章节
          await this.auditDraft(bookId, chapterNumber);

          this.logInfo(stageLanguage, {
            zh: `已重写并审计第 ${chapterNumber} 章`,
            en: `Rewrote and audited chapter ${chapterNumber}`,
          });
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        this.logWarn(stageLanguage, {
          zh: `重写第 ${chapterNumber} 章失败：${detail}`,
          en: `Failed to rewrite chapter ${chapterNumber}: ${detail}`,
        });
      }
    }

    this.logInfo(stageLanguage, {
      zh: "本卷章节重写完成",
      en: "Volume chapters rewritten successfully",
    });
  }

  async markAffectedChapters(bookId: string, affectedChapterRange: { start: number; end: number }): Promise<void> {
    const book = await this.state.loadBookConfig(bookId);
    const stageLanguage = await this.resolveBookLanguage(book);

    this.logStage(stageLanguage, {
      zh: "标记受影响章节",
      en: "Marking affected chapters",
    });

    try {
      const index = await this.state.loadChapterIndex(bookId);
      const updated = index.map((ch) => {
        if (ch.number >= affectedChapterRange.start && ch.number <= affectedChapterRange.end) {
          return {
            ...ch,
            status: "needs-review" as ChapterMeta["status"],
            updatedAt: new Date().toISOString(),
          };
        }
        return ch;
      });
      await this.state.saveChapterIndex(bookId, updated);

      this.logInfo(stageLanguage, {
        zh: `已标记第 ${affectedChapterRange.start}-${affectedChapterRange.end} 章为需要审核`,
        en: `Marked chapters ${affectedChapterRange.start}-${affectedChapterRange.end} as needs review`,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logWarn(stageLanguage, {
        zh: `标记受影响章节失败：${detail}`,
        en: `Failed to mark affected chapters: ${detail}`,
      });
      throw error;
    }
  }

  /**
   * Regenerate foundation (outline) for an existing book.
   * Preserves existing chapters but updates story bible and other foundation files.
   */
  async regenerateFoundation(book: BookConfig, externalContext?: string): Promise<void> {
    const architect = new ArchitectAgent(this.agentCtxFor("architect", book.id));
    const bookDir = this.state.bookDir(book.id);
    const stageLanguage = await this.resolveBookLanguage(book);

    this.logStage(stageLanguage, { zh: "重新生成基础设定", en: "regenerating foundation" });
    const { profile: gp } = await this.loadGenreProfile(book.genre);
    const reviewer = new FoundationReviewerAgent(this.agentCtxFor("foundation-reviewer", book.id));
    const resolvedLanguage = (book.language ?? gp.language) === "en" ? "en" as const : "zh" as const;
    const foundation = await this.generateAndReviewFoundation({
      generate: (reviewFeedback) => architect.generateFoundation(
        book,
        externalContext ?? this.config.externalContext,
        reviewFeedback,
      ),
      reviewer,
      mode: "original",
      language: resolvedLanguage,
      stageLanguage,
    });

    this.logStage(stageLanguage, { zh: "更新基础设定文件", en: "updating foundation files" });
    await architect.writeFoundationFiles(
      bookDir,
      foundation,
      gp.numericalSystem,
      book.language ?? gp.language,
    );

    this.logStage(stageLanguage, { zh: "更新控制文档", en: "updating control documents" });
    await this.state.ensureControlDocumentsAt(
      bookDir,
      book.language ?? gp.language,
      externalContext ?? this.config.externalContext,
    );

    this.logStage(stageLanguage, { zh: "创建新快照", en: "creating new snapshot" });
    const chapterIndex = await this.state.loadChapterIndex(book.id);
    const currentChapter = chapterIndex.length > 0 ? chapterIndex[chapterIndex.length - 1].number : 0;
    await this.state.snapshotStateAt(bookDir, currentChapter);
    
    // 索引基础设定文件到RAG系统
    await this.indexBookFoundationToRAG(book.id);
  }

  /** Import external source material and generate fanfic_canon.md */
  async importFanficCanon(
    bookId: string,
    sourceText: string,
    sourceName: string,
    fanficMode: FanficMode,
  ): Promise<string> {
    const { FanficCanonImporter } = await import("../agents/fanfic-canon-importer.js");
    const importer = new FanficCanonImporter(this.agentCtxFor("fanfic-canon-importer", bookId));
    const result = await importer.importFromText(sourceText, sourceName, fanficMode);

    const bookDir = this.state.bookDir(bookId);
    const storyDir = join(bookDir, "story");
    await mkdir(storyDir, { recursive: true });
    await writeFile(join(storyDir, "fanfic_canon.md"), result.fullDocument, "utf-8");

    return result.fullDocument;
  }

  /** One-step fanfic book creation: create book + import canon + generate foundation */
  async initFanficBook(
    book: BookConfig,
    sourceText: string,
    sourceName: string,
    fanficMode: FanficMode,
  ): Promise<void> {
    const bookDir = this.state.bookDir(book.id);
    const stageLanguage = await this.resolveBookLanguage(book);

    this.logStage(stageLanguage, { zh: "保存书籍配置", en: "saving book config" });
    await this.state.saveBookConfig(book.id, book);

    // Step 1: Import source material → fanfic_canon.md
    this.logStage(stageLanguage, { zh: "导入同人正典", en: "importing fanfic canon" });
    const fanficCanon = await this.importFanficCanon(book.id, sourceText, sourceName, fanficMode);

    // Step 2: Generate foundation with review loop
    const architect = new ArchitectAgent(this.agentCtxFor("architect", book.id));
    const reviewer = new FoundationReviewerAgent(this.agentCtxFor("foundation-reviewer", book.id));
    this.logStage(stageLanguage, { zh: "生成同人基础设定", en: "generating fanfic foundation" });
    const { profile: gp } = await this.loadGenreProfile(book.genre);
    const resolvedLanguage = (book.language ?? gp.language) === "en" ? "en" as const : "zh" as const;
    const foundation = await this.generateAndReviewFoundation({
      generate: (reviewFeedback) => architect.generateFanficFoundation(
        book,
        fanficCanon,
        fanficMode,
        reviewFeedback,
      ),
      reviewer,
      mode: "fanfic",
      sourceCanon: fanficCanon,
      language: resolvedLanguage,
      stageLanguage,
    });
    this.logStage(stageLanguage, { zh: "写入基础设定文件", en: "writing foundation files" });
    await architect.writeFoundationFiles(
      bookDir,
      foundation,
      gp.numericalSystem,
      book.language ?? gp.language,
    );
    this.logStage(stageLanguage, { zh: "初始化控制文档", en: "initializing control documents" });
    await this.state.ensureControlDocuments(book.id, this.config.externalContext);

    // Step 3: Generate style guide from source material
    if (sourceText.length >= 500) {
      this.logStage(stageLanguage, { zh: "提取原作风格指纹", en: "extracting source style fingerprint" });
      await this.tryGenerateStyleGuide(book.id, sourceText, sourceName, stageLanguage);
    }

    // Step 4: Initialize chapters directory + snapshot
    this.logStage(stageLanguage, { zh: "创建初始快照", en: "creating initial snapshot" });
    await mkdir(join(bookDir, "chapters"), { recursive: true });
    await this.state.saveChapterIndex(book.id, []);
    await this.state.snapshotState(book.id, 0);
    
    // 索引基础设定文件到RAG系统
    await this.indexBookFoundationToRAG(book.id);
  }

  /** Write a single draft chapter. Saves chapter file + truth files + index + snapshot. */
  async writeDraft(bookId: string, context?: string, wordCount?: number): Promise<DraftResult> {
    const releaseLock = await this.state.acquireBookLock(bookId);
    try {
      await this.state.ensureControlDocuments(bookId);
      const book = await this.state.loadBookConfig(bookId);
      const bookDir = this.state.bookDir(bookId);
      const chapterNumber = await this.state.getNextChapterNumber(bookId);
      const stageLanguage = await this.resolveBookLanguage(book);
      this.logStage(stageLanguage, { zh: "准备章节输入", en: "preparing chapter inputs" });
      
      // 索引记忆到RAG系统
      await this.indexMemoryToRAG(bookId);
      
      const writeInput = await this.prepareWriteInput(
        book,
        bookDir,
        chapterNumber,
        context ?? this.config.externalContext,
      );

      const { profile: gp } = await this.loadGenreProfile(book.genre);
      const lengthSpec = buildLengthSpec(
        wordCount ?? book.chapterWordCount,
        book.language ?? gp.language,
      );

      const writer = new WriterAgent(this.agentCtxFor("writer", bookId));
      this.logStage(stageLanguage, { zh: "撰写章节草稿", en: "writing chapter draft" });
      const output = await writer.writeChapter({
        book,
        bookDir,
        chapterNumber,
        ...writeInput,
        lengthSpec,
        ...(wordCount ? { wordCountOverride: wordCount } : {}),
      });
      const writerCount = countChapterLength(output.content, lengthSpec.countingMode);
      let totalUsage: TokenUsageSummary = output.tokenUsage ?? {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
      };
      const normalizedDraft = await this.normalizeDraftLengthIfNeeded({
        bookId,
        chapterNumber,
        chapterContent: output.content,
        lengthSpec,
        chapterIntent: writeInput.chapterIntent,
      });
      totalUsage = PipelineRunner.addUsage(totalUsage, normalizedDraft.tokenUsage);
      const draftOutput: WriteChapterOutput = {
        ...output,
        content: normalizedDraft.content,
        wordCount: normalizedDraft.wordCount,
        tokenUsage: totalUsage,
      };
      const lengthWarnings = this.buildLengthWarnings(
        chapterNumber,
        draftOutput.wordCount,
        lengthSpec,
      );
      const lengthTelemetry = this.buildLengthTelemetry({
        lengthSpec,
        writerCount,
        postWriterNormalizeCount: normalizedDraft.wordCount,
        postReviseCount: 0,
        finalCount: draftOutput.wordCount,
        normalizeApplied: normalizedDraft.applied,
        lengthWarning: lengthWarnings.length > 0,
      });
      this.logLengthWarnings(lengthWarnings);

      // Save chapter file
      const chaptersDir = join(bookDir, "chapters");
      const paddedNum = String(chapterNumber).padStart(4, "0");
      const sanitized = draftOutput.title.replace(/[/\\?%*:|"<>]/g, "").replace(/\s+/g, "_").slice(0, 50);
      const filename = `${paddedNum}_${sanitized}.md`;
      const filePath = join(chaptersDir, filename);

      const resolvedLang = book.language ?? gp.language;
      const heading = resolvedLang === "en"
        ? `# Chapter ${chapterNumber}: ${draftOutput.title}`
        : `# 第${chapterNumber}章 ${draftOutput.title}`;
      await writeFile(filePath, `${heading}\n\n${draftOutput.content}`, "utf-8");

      // Save truth files
      this.logStage(stageLanguage, { zh: "落盘草稿与真相文件", en: "persisting draft and truth files" });
      await writer.saveChapter(bookDir, draftOutput, gp.numericalSystem, resolvedLang);
      await writer.saveNewTruthFiles(bookDir, draftOutput, resolvedLang);
      await this.syncLegacyStructuredStateFromMarkdown(bookDir, chapterNumber, draftOutput);
      await this.syncNarrativeMemoryIndex(bookId);

      // Update index
      const existingIndex = await this.state.loadChapterIndex(bookId);
      const now = new Date().toISOString();
      const newEntry: ChapterMeta = {
        number: chapterNumber,
        title: draftOutput.title,
        status: "drafted",
        wordCount: draftOutput.wordCount,
        createdAt: now,
        updatedAt: now,
        auditIssues: [],
        lengthWarnings,
        lengthTelemetry,
        ...(draftOutput.tokenUsage ? { tokenUsage: draftOutput.tokenUsage } : {}),
      };
      await this.state.saveChapterIndex(bookId, [...existingIndex, newEntry]);
      await this.markBookActiveIfNeeded(bookId);

      // Snapshot
      this.logStage(stageLanguage, { zh: "更新章节索引与快照", en: "updating chapter index and snapshots" });
      await this.state.snapshotState(bookId, chapterNumber);
      await this.syncCurrentStateFactHistory(bookId, chapterNumber);

      await this.emitWebhook("chapter-complete", bookId, chapterNumber, {
        title: draftOutput.title,
        wordCount: draftOutput.wordCount,
      });

      return {
        chapterNumber,
        title: draftOutput.title,
        wordCount: draftOutput.wordCount,
        filePath,
        lengthWarnings,
        lengthTelemetry,
        tokenUsage: draftOutput.tokenUsage,
      };
    } finally {
      await releaseLock();
    }
  }

  async planChapter(bookId: string, context?: string): Promise<PlanChapterResult> {
    await this.state.ensureControlDocuments(bookId);
    const book = await this.state.loadBookConfig(bookId);
    const bookDir = this.state.bookDir(bookId);
    const chapterNumber = await this.state.getNextChapterNumber(bookId);
    const stageLanguage = await this.resolveBookLanguage(book);
    this.logStage(stageLanguage, { zh: "规划下一章意图", en: "planning next chapter intent" });
    const { plan } = await this.createGovernedArtifacts(
      book,
      bookDir,
      chapterNumber,
      context ?? this.config.externalContext,
      { reuseExistingIntentWhenContextMissing: false },
    );

    return {
      bookId,
      chapterNumber,
      intentPath: relativeToBookDir(bookDir, plan.runtimePath),
      goal: plan.intent.goal,
      conflicts: plan.intent.conflicts.map((conflict) => `${conflict.type}: ${conflict.resolution}`),
    };
  }

  async composeChapter(bookId: string, context?: string): Promise<ComposeChapterResult> {
    await this.state.ensureControlDocuments(bookId);
    const book = await this.state.loadBookConfig(bookId);
    const bookDir = this.state.bookDir(bookId);
    const chapterNumber = await this.state.getNextChapterNumber(bookId);
    const stageLanguage = await this.resolveBookLanguage(book);
    this.logStage(stageLanguage, { zh: "组装章节运行时上下文", en: "composing chapter runtime context" });
    const { plan, composed } = await this.createGovernedArtifacts(
      book,
      bookDir,
      chapterNumber,
      context ?? this.config.externalContext,
      { reuseExistingIntentWhenContextMissing: true },
    );

    return {
      bookId,
      chapterNumber,
      intentPath: relativeToBookDir(bookDir, plan.runtimePath),
      goal: plan.intent.goal,
      conflicts: plan.intent.conflicts.map((conflict) => `${conflict.type}: ${conflict.resolution}`),
      contextPath: relativeToBookDir(bookDir, composed.contextPath),
      ruleStackPath: relativeToBookDir(bookDir, composed.ruleStackPath),
      tracePath: relativeToBookDir(bookDir, composed.tracePath),
    };
  }

  /** Audit the latest (or specified) chapter. Read-only, no lock needed. */
  async auditDraft(bookId: string, chapterNumber?: number): Promise<AuditResult & { readonly chapterNumber: number }> {
    const book = await this.state.loadBookConfig(bookId);
    const bookDir = this.state.bookDir(bookId);
    const targetChapter = chapterNumber ?? (await this.state.getNextChapterNumber(bookId)) - 1;
    if (targetChapter < 1) {
      throw new Error(`No chapters to audit for "${bookId}"`);
    }

    // 索引记忆到RAG系统
    await this.indexMemoryToRAG(bookId);

    const content = await this.readChapterContent(bookDir, targetChapter);
    const auditor = new ContinuityAuditor(this.agentCtxFor("auditor", bookId));
    const { profile: gp } = await this.loadGenreProfile(book.genre);
    const language = book.language ?? gp.language;
    this.logStage(language, {
      zh: `审计第${targetChapter}章`,
      en: `auditing chapter ${targetChapter}`,
    });
    const evaluation = await this.evaluateMergedAudit({
      auditor,
      book,
      bookDir,
      chapterContent: content,
      chapterNumber: targetChapter,
      language,
    });
    const result = evaluation.auditResult;

    // Log audit results
    if (result.issues.length > 0) {
      this.config.logger?.info(`审计发现 ${result.issues.length} 个问题:`);
      result.issues.forEach((issue, index) => {
        this.config.logger?.info(`  ${index + 1}. [${issue.severity}] ${issue.description}`);
      });
    } else {
      this.config.logger?.info(`审计通过，未发现问题`);
    }
    this.config.logger?.info(`审计摘要: ${result.summary}`);

    // Update index with audit result
    const index = await this.state.loadChapterIndex(bookId);
    const updated = index.map((ch) =>
      ch.number === targetChapter
        ? {
            ...ch,
            status: (result.passed ? "ready-for-review" : "audit-failed") as ChapterMeta["status"],
            updatedAt: new Date().toISOString(),
            auditIssues: result.issues.map((i) => `[${i.severity}] ${i.description}`),
          }
        : ch,
    );
    await this.state.saveChapterIndex(bookId, updated);
    const latestChapter = index.length > 0 ? Math.max(...index.map((chapter) => chapter.number)) : targetChapter;
    if (targetChapter === latestChapter) {
      await this.persistAuditDriftGuidance({
        bookDir,
        chapterNumber: targetChapter,
        issues: result.issues.filter((issue) => issue.severity === "critical" || issue.severity === "warning"),
        language,
      }).catch(() => undefined);
    }

    await this.emitWebhook(
      result.passed ? "audit-passed" : "audit-failed",
      bookId,
      targetChapter,
      { summary: result.summary, issueCount: result.issues.length },
    );

    return { ...result, chapterNumber: targetChapter };
  }

  /** Revise the latest (or specified) chapter based on audit issues. */
  async reviseDraft(bookId: string, chapterNumber?: number, mode: ReviseMode = DEFAULT_REVISE_MODE, brief?: string): Promise<ReviseResult> {
    const releaseLock = await this.state.acquireBookLock(bookId);
    try {
      const book = await this.state.loadBookConfig(bookId);
      const bookDir = this.state.bookDir(bookId);
      const targetChapter = chapterNumber ?? (await this.state.getNextChapterNumber(bookId)) - 1;
      if (targetChapter < 1) {
        throw new Error(`No chapters to revise for "${bookId}"`);
      }

      const stageLanguage = await this.resolveBookLanguage(book);
      
      // 记录修订开始
      this.config.logger?.info(`[reviseDraft] 开始修订第${targetChapter}章，模式: ${mode}${brief ? '，有补充意图' : ''}`);
      
      // Read the current audit issues from index
      this.logStage(stageLanguage, {
        zh: `加载第${targetChapter}章修订上下文`,
        en: `loading revision context for chapter ${targetChapter}`,
      });
      const index = await this.state.loadChapterIndex(bookId);
      const chapterMeta = index.find((ch) => ch.number === targetChapter);
      if (!chapterMeta) {
        throw new Error(`Chapter ${targetChapter} not found in index`);
      }

      // 索引记忆到RAG系统
      this.config.logger?.info(`[reviseDraft] 索引记忆到RAG系统...`);
      await this.indexMemoryToRAG(bookId);
      this.config.logger?.info(`[reviseDraft] RAG索引完成`);
      
      // Re-audit to get structured issues (index only stores strings)
      this.config.logger?.info(`[reviseDraft] 读取第${targetChapter}章内容...`);
      const content = await this.readChapterContent(bookDir, targetChapter);
      this.config.logger?.info(`[reviseDraft] 章节内容读取完成，字数: ${content.length}`);
      
      this.config.logger?.info(`[reviseDraft] 开始审计章节...`);
      const auditor = new ContinuityAuditor(this.agentCtxFor("auditor", bookId));
      const { profile: gp } = await this.loadGenreProfile(book.genre);
      const language = book.language ?? gp.language;
      const countingMode = resolveLengthCountingMode(language);
      const reviseControlInput = (this.config.inputGovernanceMode ?? "v2") === "legacy"
        ? undefined
        : await this.createGovernedArtifacts(
          book,
          bookDir,
          targetChapter,
          this.config.externalContext,
          { reuseExistingIntentWhenContextMissing: true },
        );
      this.config.logger?.info(`[reviseDraft] 治理工件创建完成`);
      
      const preRevision = await this.evaluateMergedAudit({
        auditor,
        book,
        bookDir,
        chapterContent: content,
        chapterNumber: targetChapter,
        language,
        auditOptions: reviseControlInput
          ? {
              chapterIntent: reviseControlInput.plan.intentMarkdown,
              contextPackage: reviseControlInput.composed.contextPackage,
              ruleStack: reviseControlInput.composed.ruleStack,
            }
          : undefined,
      });
      this.config.logger?.info(`[reviseDraft] 审计完成，发现问题: ${preRevision.auditResult.issues.length}，阻塞问题: ${preRevision.blockingCount}，AI痕迹: ${preRevision.aiTellCount}`);

      if (preRevision.blockingCount === 0 && preRevision.aiTellCount === 0) {
        return {
          chapterNumber: targetChapter,
          wordCount: countChapterLength(content, countingMode),
          fixedIssues: [],
          applied: false,
          status: "unchanged",
          skippedReason: "No warning, critical, or AI-tell issues to fix.",
        };
      }

      const chapterLengthTarget = chapterMeta.lengthTelemetry?.target ?? book.chapterWordCount;
      const lengthLanguage = chapterMeta.lengthTelemetry?.countingMode === "en_words"
        ? "en"
        : language;
      const lengthSpec = buildLengthSpec(
        chapterLengthTarget,
        lengthLanguage,
      );

      const reviser = new ReviserAgent(this.agentCtxFor("reviser", bookId));
      this.logStage(stageLanguage, {
        zh: `修订第${targetChapter}章`,
        en: `revising chapter ${targetChapter}`,
      });
      this.config.logger?.info(`[reviseDraft] 开始调用ReviserAgent修订章节，模式: ${mode}...`);
      
      // 获取RAG管理器
      const ragManager = await this.getRAGManager(bookId);
      this.config.logger?.info(`[reviseDraft] RAG管理器获取完成`);
      
      this.config.logger?.info(`[reviseDraft] 调用reviseChapter...`);
      const reviseOutput = await reviser.reviseChapter(
        bookDir,
        content,
        targetChapter,
        preRevision.auditResult.issues,
        mode,
        book.genre,
        reviseControlInput
          ? {
              chapterIntent: reviseControlInput.plan.intentMarkdown,
              contextPackage: reviseControlInput.composed.contextPackage,
              ruleStack: reviseControlInput.composed.ruleStack,
              lengthSpec,
              ragManager: ragManager || undefined,
              brief,
            }
          : {
              lengthSpec,
              ragManager: ragManager || undefined,
              brief,
            },
      );
      this.config.logger?.info(`[reviseDraft] reviseChapter完成，修订后字数: ${reviseOutput.revisedContent.length}，修复问题数: ${reviseOutput.fixedIssues.length}`);

      if (reviseOutput.revisedContent.length === 0) {
        throw new Error("Reviser returned empty content");
      }
      
      this.config.logger?.info(`[reviseDraft] 开始字数标准化检查...`);
      const normalizedRevision = await this.normalizeDraftLengthIfNeeded({
        bookId,
        chapterNumber: targetChapter,
        chapterContent: reviseOutput.revisedContent,
        lengthSpec,
      });
      this.config.logger?.info(`[reviseDraft] 字数标准化完成，应用调整: ${normalizedRevision.applied}`);
      
      this.config.logger?.info(`[reviseDraft] 开始修订后审计...`);
      const postRevision = await this.evaluateMergedAudit({
        auditor,
        book,
        bookDir,
        chapterContent: normalizedRevision.content,
        chapterNumber: targetChapter,
        language,
        auditOptions: reviseControlInput
          ? {
              temperature: 0,
              chapterIntent: reviseControlInput.plan.intentMarkdown,
              contextPackage: reviseControlInput.composed.contextPackage,
              ruleStack: reviseControlInput.composed.ruleStack,
              truthFileOverrides: {
                currentState: reviseOutput.updatedState !== "(状态卡未更新)" ? reviseOutput.updatedState : undefined,
                ledger: reviseOutput.updatedLedger !== "(账本未更新)" ? reviseOutput.updatedLedger : undefined,
                hooks: reviseOutput.updatedHooks !== "(伏笔池未更新)" ? reviseOutput.updatedHooks : undefined,
              },
            }
          : {
              temperature: 0,
              truthFileOverrides: {
                currentState: reviseOutput.updatedState !== "(状态卡未更新)" ? reviseOutput.updatedState : undefined,
                ledger: reviseOutput.updatedLedger !== "(账本未更新)" ? reviseOutput.updatedLedger : undefined,
                hooks: reviseOutput.updatedHooks !== "(伏笔池未更新)" ? reviseOutput.updatedHooks : undefined,
              },
            },
      });
      const effectivePostRevision = this.restoreActionableAuditIfLost(
        preRevision,
        postRevision,
      );
      const revisionBaseCount = countChapterLength(content, lengthSpec.countingMode);
      const lengthWarnings = this.buildLengthWarnings(
        targetChapter,
        normalizedRevision.wordCount,
        lengthSpec,
      );
      const lengthTelemetry = this.buildLengthTelemetry({
        lengthSpec,
        writerCount: revisionBaseCount,
        postWriterNormalizeCount: 0,
        postReviseCount: normalizedRevision.wordCount,
        finalCount: normalizedRevision.wordCount,
        normalizeApplied: normalizedRevision.applied,
        lengthWarning: lengthWarnings.length > 0,
      });

      this.config.logger?.info(`[reviseDraft] 修订后审计完成，阻塞问题: ${effectivePostRevision.blockingCount}，AI痕迹: ${effectivePostRevision.aiTellCount}`);

      const improvedBlocking = effectivePostRevision.blockingCount < preRevision.blockingCount;
      const improvedAITells = effectivePostRevision.aiTellCount < preRevision.aiTellCount;
      const blockingDidNotWorsen = effectivePostRevision.blockingCount <= preRevision.blockingCount;
      const criticalDidNotWorsen = effectivePostRevision.criticalCount <= preRevision.criticalCount;
      const aiDidNotWorsen = effectivePostRevision.aiTellCount <= preRevision.aiTellCount;
      const shouldApplyRevision = blockingDidNotWorsen
        && criticalDidNotWorsen
        && aiDidNotWorsen
        && (improvedBlocking || improvedAITells);

      this.config.logger?.info(`[reviseDraft] 修订效果评估: 阻塞问题改善=${improvedBlocking}, AI痕迹改善=${improvedAITells}, 是否应用=${shouldApplyRevision}`);

      if (!shouldApplyRevision) {
        this.config.logger?.info(`[reviseDraft] 修订未改善问题，保持原章节`);
        return {
          chapterNumber: targetChapter,
          wordCount: revisionBaseCount,
          fixedIssues: [],
          applied: false,
          status: "unchanged",
          skippedReason: "Manual revision did not improve merged audit or AI-tell metrics; kept original chapter.",
        };
      }
      this.logLengthWarnings(lengthWarnings);

      // Save revised chapter file
      this.logStage(stageLanguage, {
        zh: `落盘第${targetChapter}章修订结果`,
        en: `persisting revision for chapter ${targetChapter}`,
      });
      this.config.logger?.info(`[reviseDraft] 开始保存修订后的章节文件...`);
      const chaptersDir = join(bookDir, "chapters");
      const files = await readdir(chaptersDir);
      const paddedNum = String(targetChapter).padStart(4, "0");
      const existingFile = files.find((f) => f.startsWith(paddedNum) && f.endsWith(".md"));
      if (!existingFile) {
        throw new Error(`Chapter ${targetChapter} file not found in ${chaptersDir} (expected filename starting with ${paddedNum})`);
      }
      const reviseLang = book.language ?? gp.language;
      const reviseHeading = reviseLang === "en"
        ? `# Chapter ${targetChapter}: ${chapterMeta.title}`
        : `# 第${targetChapter}章 ${chapterMeta.title}`;
      await writeFile(
        join(chaptersDir, existingFile),
        `${reviseHeading}\n\n${normalizedRevision.content}`,
        "utf-8",
      );
      this.config.logger?.info(`[reviseDraft] 章节文件保存完成: ${existingFile}`);

      // Update truth files
      this.config.logger?.info(`[reviseDraft] 更新真相文件...`);
      const storyDir = join(bookDir, "story");
      if (reviseOutput.updatedState !== "(状态卡未更新)") {
        await writeFile(join(storyDir, "current_state.md"), reviseOutput.updatedState, "utf-8");
        this.config.logger?.info(`[reviseDraft] 状态卡已更新`);
      }
      if (gp.numericalSystem && reviseOutput.updatedLedger && reviseOutput.updatedLedger !== "(账本未更新)") {
        await writeFile(join(storyDir, "particle_ledger.md"), reviseOutput.updatedLedger, "utf-8");
        this.config.logger?.info(`[reviseDraft] 账本已更新`);
      }
      if (reviseOutput.updatedHooks !== "(伏笔池未更新)") {
        await writeFile(join(storyDir, "pending_hooks.md"), reviseOutput.updatedHooks, "utf-8");
        this.config.logger?.info(`[reviseDraft] 伏笔池已更新`);
      }
      await this.syncLegacyStructuredStateFromMarkdown(bookDir, targetChapter);

      // Update index
      this.config.logger?.info(`[reviseDraft] 更新章节索引...`);
      const updatedIndex = index.map((ch) =>
        ch.number === targetChapter
          ? {
              ...ch,
              status: (effectivePostRevision.auditResult.passed ? "ready-for-review" : "audit-failed") as ChapterMeta["status"],
              wordCount: normalizedRevision.wordCount,
              updatedAt: new Date().toISOString(),
              auditIssues: effectivePostRevision.auditResult.issues.map((i) => `[${i.severity}] ${i.description}`),
              lengthWarnings,
              lengthTelemetry,
            }
          : ch,
      );
      await this.state.saveChapterIndex(bookId, updatedIndex);
      this.config.logger?.info(`[reviseDraft] 章节索引更新完成，状态: ${effectivePostRevision.auditResult.passed ? "ready-for-review" : "audit-failed"}`);
      const latestChapter = index.length > 0 ? Math.max(...index.map((chapter) => chapter.number)) : targetChapter;
      if (targetChapter === latestChapter) {
        await this.persistAuditDriftGuidance({
          bookDir,
          chapterNumber: targetChapter,
          issues: effectivePostRevision.auditResult.issues.filter(
            (issue) => issue.severity === "critical" || issue.severity === "warning",
          ),
          language,
        }).catch(() => undefined);
      }

      // Re-snapshot
      this.logStage(stageLanguage, {
        zh: `更新第${targetChapter}章索引与快照`,
        en: `updating chapter index and snapshots for chapter ${targetChapter}`,
      });
      this.config.logger?.info(`[reviseDraft] 创建状态快照...`);
      await this.state.snapshotState(bookId, targetChapter);
      this.config.logger?.info(`[reviseDraft] 同步叙事记忆索引...`);
      await this.syncNarrativeMemoryIndex(bookId);
      this.config.logger?.info(`[reviseDraft] 同步当前状态事实历史...`);
      await this.syncCurrentStateFactHistory(bookId, targetChapter);

      this.config.logger?.info(`[reviseDraft] 发送修订完成webhook...`);
      await this.emitWebhook("revision-complete", bookId, targetChapter, {
        wordCount: normalizedRevision.wordCount,
        fixedCount: reviseOutput.fixedIssues.length,
      });

      this.config.logger?.info(`[reviseDraft] 修订完成！第${targetChapter}章，字数: ${normalizedRevision.wordCount}，修复问题: ${reviseOutput.fixedIssues.length}，状态: ${effectivePostRevision.auditResult.passed ? "ready-for-review" : "audit-failed"}`);

      return {
        chapterNumber: targetChapter,
        wordCount: normalizedRevision.wordCount,
        fixedIssues: reviseOutput.fixedIssues,
        applied: true,
        status: effectivePostRevision.auditResult.passed ? "ready-for-review" : "audit-failed",
        lengthWarnings,
        lengthTelemetry,
      };
    } finally {
      this.config.logger?.info(`[reviseDraft] 释放书籍锁`);
      await releaseLock();
    }
  }

  /** Read all truth files for a book. */
  async readTruthFiles(bookId: string): Promise<TruthFiles> {
    const bookDir = this.state.bookDir(bookId);
    const storyDir = join(bookDir, "story");
    const readSafe = async (path: string): Promise<string> => {
      try {
        return await readFile(path, "utf-8");
      } catch {
        return "(文件不存在)";
      }
    };

    const [currentState, particleLedger, pendingHooks, storyBible, volumeOutline, bookRules] =
      await Promise.all([
        readSafe(join(storyDir, "current_state.md")),
        readSafe(join(storyDir, "particle_ledger.md")),
        readSafe(join(storyDir, "pending_hooks.md")),
        readSafe(join(storyDir, "story_bible.md")),
        readSafe(join(storyDir, "volume_outline.md")),
        readSafe(join(storyDir, "book_rules.md")),
      ]);

    return { currentState, particleLedger, pendingHooks, storyBible, volumeOutline, bookRules };
  }

  /** Get book status overview. */
  async getBookStatus(bookId: string): Promise<BookStatusInfo> {
    const book = await this.state.loadBookConfig(bookId);
    const chapters = await this.state.loadChapterIndex(bookId);
    const nextChapter = await this.state.getNextChapterNumber(bookId);
    const totalWords = chapters.reduce((sum, ch) => sum + ch.wordCount, 0);

    return {
      bookId,
      title: book.title,
      genre: book.genre,
      platform: book.platform,
      status: book.status,
      chaptersWritten: chapters.length,
      totalWords,
      nextChapter,
      chapters: [...chapters],
    };
  }

  // ---------------------------------------------------------------------------
  // Full pipeline (convenience — runs draft + audit + revise in one shot)
  // ---------------------------------------------------------------------------

  async writeNextChapter(bookId: string, wordCount?: number, temperatureOverride?: number): Promise<ChapterPipelineResult> {
    const releaseLock = await this.state.acquireBookLock(bookId);
    try {
      return await this._writeNextChapterLocked(bookId, wordCount, temperatureOverride);
    } finally {
      await releaseLock();
    }
  }

  async repairChapterState(bookId: string, chapterNumber?: number): Promise<ChapterPipelineResult> {
    const releaseLock = await this.state.acquireBookLock(bookId);
    try {
      return await this._repairChapterStateLocked(bookId, chapterNumber);
    } finally {
      await releaseLock();
    }
  }

  async resyncChapterArtifacts(bookId: string, chapterNumber?: number): Promise<ChapterPipelineResult> {
    const releaseLock = await this.state.acquireBookLock(bookId);
    try {
      return await this._resyncChapterArtifactsLocked(bookId, chapterNumber);
    } finally {
      await releaseLock();
    }
  }

  private async _writeNextChapterLocked(bookId: string, wordCount?: number, temperatureOverride?: number): Promise<ChapterPipelineResult> {
    await this.state.ensureControlDocuments(bookId);
    const book = await this.state.loadBookConfig(bookId);
    const bookDir = this.state.bookDir(bookId);
    await this.assertNoPendingStateRepair(bookId);
    const chapterNumber = await this.state.getNextChapterNumber(bookId);
    const stageLanguage = await this.resolveBookLanguage(book);
    this.logStage(stageLanguage, { zh: "准备章节输入", en: "preparing chapter inputs" });
    const writeInput = await this.prepareWriteInput(
      book,
      bookDir,
      chapterNumber,
      this.config.externalContext,
    );
    const reducedControlInput = writeInput.chapterIntent && writeInput.contextPackage && writeInput.ruleStack
      ? {
          chapterIntent: writeInput.chapterIntent,
          contextPackage: writeInput.contextPackage,
          ruleStack: writeInput.ruleStack,
        }
      : undefined;
    const { profile: gp } = await this.loadGenreProfile(book.genre);
    const pipelineLang = book.language ?? gp.language;
    const lengthSpec = buildLengthSpec(
      wordCount ?? book.chapterWordCount,
      pipelineLang,
    );

    // 1. Write chapter
    const writer = new WriterAgent(this.agentCtxFor("writer", bookId));
    this.logStage(stageLanguage, { zh: "撰写章节草稿", en: "writing chapter draft" });
    const output = await writer.writeChapter({
      book,
      bookDir,
      chapterNumber,
      ...writeInput,
      lengthSpec,
      ...(wordCount ? { wordCountOverride: wordCount } : {}),
      ...(temperatureOverride ? { temperatureOverride } : {}),
    });
    const writerCount = countChapterLength(output.content, lengthSpec.countingMode);

    // Token usage accumulator
    let totalUsage: TokenUsageSummary = output.tokenUsage ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    const auditor = new ContinuityAuditor(this.agentCtxFor("auditor", bookId));
    const reviewResult = await runChapterReviewCycle({
      book: { genre: book.genre },
      bookDir,
      chapterNumber,
      initialOutput: output,
      reducedControlInput,
      lengthSpec,
      initialUsage: totalUsage,
      createReviser: () => new ReviserAgent(this.agentCtxFor("reviser", bookId)),
      auditor,
      normalizeDraftLengthIfNeeded: (chapterContent) => this.normalizeDraftLengthIfNeeded({
        bookId,
        chapterNumber,
        chapterContent,
        lengthSpec,
        chapterIntent: writeInput.chapterIntent,
      }),
      assertChapterContentNotEmpty: (content, stage) =>
        this.assertChapterContentNotEmpty(content, chapterNumber, stage),
      addUsage: PipelineRunner.addUsage,
      restoreLostAuditIssues: (previous, next) => this.restoreLostAuditIssues(previous, next),
      analyzeAITells,
      analyzeSensitiveWords,
      logWarn: (message) => this.logWarn(pipelineLang, message),
      logStage: (message) => this.logStage(stageLanguage, message),
    });
    totalUsage = reviewResult.totalUsage;
    let finalContent = reviewResult.finalContent;
    let finalWordCount = reviewResult.finalWordCount;
    let revised = reviewResult.revised;
    let auditResult = reviewResult.auditResult;
    const postReviseCount = reviewResult.postReviseCount;
    const normalizeApplied = reviewResult.normalizeApplied;

    // 4. Save the final chapter and truth files from a single persistence source
    this.logStage(stageLanguage, { zh: "落盘最终章节", en: "persisting final chapter" });
    this.logStage(stageLanguage, { zh: "生成最终真相文件", en: "rebuilding final truth files" });
    const chapterIndexBeforePersist = await this.state.loadChapterIndex(bookId);
    const { resolveDuplicateTitle } = await import("../agents/post-write-validator.js");
    const initialTitleResolution = resolveDuplicateTitle(
      output.title,
      chapterIndexBeforePersist.map((chapter) => chapter.title),
      pipelineLang,
      { content: finalContent },
    );
    let persistenceOutput = await this.buildPersistenceOutput(
      bookId,
      book,
      bookDir,
      chapterNumber,
      initialTitleResolution.title === output.title
        ? output
        : { ...output, title: initialTitleResolution.title },
      finalContent,
      lengthSpec.countingMode,
      reducedControlInput,
    );
    const finalTitleResolution = resolveDuplicateTitle(
      persistenceOutput.title,
      chapterIndexBeforePersist.map((chapter) => chapter.title),
      pipelineLang,
      { content: finalContent },
    );
    if (finalTitleResolution.title !== persistenceOutput.title) {
      persistenceOutput = {
        ...persistenceOutput,
        title: finalTitleResolution.title,
      };
    }
    if (persistenceOutput.title !== output.title) {
      const description = pipelineLang === "en"
        ? `Chapter title "${output.title}" was auto-adjusted to "${persistenceOutput.title}".`
        : `章节标题"${output.title}"已自动调整为"${persistenceOutput.title}"。`;
      this.config.logger?.warn(`[title] ${description}`);
      auditResult = {
        ...auditResult,
        issues: [...auditResult.issues, {
          severity: "warning",
          category: "title-dedup",
          description,
          suggestion: pipelineLang === "en"
            ? "If the auto-renamed title is weak, revise the chapter title manually."
            : "如果自动改名不理想，可以在后续手动修订章节标题。",
        }],
      };
    }
    const longSpanFatigue = await analyzeLongSpanFatigue({
      bookDir,
      chapterNumber,
      chapterContent: finalContent,
      chapterSummary: persistenceOutput.chapterSummary,
      language: pipelineLang,
    });
    auditResult = {
      ...auditResult,
      issues: [
        ...auditResult.issues,
        ...longSpanFatigue.issues,
        ...(persistenceOutput.hookHealthIssues ?? []),
      ],
    };
    finalWordCount = persistenceOutput.wordCount;
    const lengthWarnings = this.buildLengthWarnings(
      chapterNumber,
      finalWordCount,
      lengthSpec,
    );
    const lengthTelemetry = this.buildLengthTelemetry({
      lengthSpec,
      writerCount,
      postWriterNormalizeCount: reviewResult.preAuditNormalizedWordCount,
      postReviseCount,
      finalCount: finalWordCount,
      normalizeApplied,
      lengthWarning: lengthWarnings.length > 0,
    });
    this.logLengthWarnings(lengthWarnings);

    // 4.1 Validate settler output before writing
    this.logStage(stageLanguage, { zh: "校验真相文件变更", en: "validating truth file updates" });
    const storyDir = join(bookDir, "story");
    const [oldState, oldHooks, oldLedger] = await Promise.all([
      readFile(join(storyDir, "current_state.md"), "utf-8").catch(() => ""),
      readFile(join(storyDir, "pending_hooks.md"), "utf-8").catch(() => ""),
      readFile(join(storyDir, "particle_ledger.md"), "utf-8").catch(() => ""),
    ]);
    const validator = new StateValidatorAgent(this.agentCtxFor("state-validator", bookId));
    const truthValidation = await validateChapterTruthPersistence({
      writer,
      validator,
      book,
      bookDir,
      chapterNumber,
      title: persistenceOutput.title,
      content: finalContent,
      persistenceOutput,
      auditResult,
      previousTruth: {
        oldState,
        oldHooks,
        oldLedger,
      },
      reducedControlInput,
      language: pipelineLang,
      logWarn: (message) => this.logWarn(pipelineLang, message),
      logger: this.config.logger,
    });
    let chapterStatus: ChapterPipelineResult["status"] | null = truthValidation.chapterStatus;
    let degradedIssues: ReadonlyArray<AuditIssue> = truthValidation.degradedIssues;
    persistenceOutput = truthValidation.persistenceOutput;
    auditResult = truthValidation.auditResult;

    // 4.2 Final paragraph shape check on persisted content (post-normalize, post-revise)
    {
      const {
        detectParagraphLengthDrift,
        detectParagraphShapeWarnings,
      } = await import("../agents/post-write-validator.js");
      const chapDir = join(bookDir, "chapters");
      const recentFiles = (await readdir(chapDir).catch(() => [] as string[]))
        .filter((f) => f.endsWith(".md") && /^\d{4}/.test(f))
        .sort()
        .slice(-5);
      const recentContent = (await Promise.all(
        recentFiles.map((f) => readFile(join(chapDir, f), "utf-8").catch(() => "")),
      )).join("\n\n");
      const paragraphIssues = [
        ...detectParagraphShapeWarnings(finalContent, pipelineLang),
        ...detectParagraphLengthDrift(finalContent, recentContent, pipelineLang),
      ];
      if (paragraphIssues.length > 0) {
        for (const issue of paragraphIssues) {
          this.config.logger?.warn(`[paragraph] ${issue.description}`);
        }
        auditResult = {
          ...auditResult,
          issues: [...auditResult.issues, ...paragraphIssues.map((v) => ({
            severity: v.severity as "warning",
            category: "paragraph-shape",
            description: v.description,
            suggestion: v.suggestion,
          }))],
        };
      }
    }

    const resolvedStatus = chapterStatus ?? (auditResult.passed ? "ready-for-review" : "audit-failed");
    await persistChapterArtifacts({
      chapterNumber,
      chapterTitle: persistenceOutput.title,
      status: resolvedStatus,
      auditResult,
      finalWordCount,
      lengthWarnings,
      lengthTelemetry,
      degradedIssues,
      tokenUsage: totalUsage,
      loadChapterIndex: () => this.state.loadChapterIndex(bookId),
      saveChapter: () => writer.saveChapter(bookDir, persistenceOutput, gp.numericalSystem, pipelineLang),
      saveTruthFiles: async () => {
        await writer.saveNewTruthFiles(bookDir, persistenceOutput, pipelineLang);
        await this.syncLegacyStructuredStateFromMarkdown(bookDir, chapterNumber, persistenceOutput);
        this.logStage(stageLanguage, { zh: "同步记忆索引", en: "syncing memory indexes" });
        await this.syncNarrativeMemoryIndex(bookId);
      },
      saveChapterIndex: (index) => this.state.saveChapterIndex(bookId, index),
      markBookActiveIfNeeded: () => this.markBookActiveIfNeeded(bookId),
      persistAuditDriftGuidance: (issues) => this.persistAuditDriftGuidance({
        bookDir,
        chapterNumber,
        issues,
        language: stageLanguage,
      }).catch(() => undefined),
      snapshotState: () => this.state.snapshotState(bookId, chapterNumber),
      syncCurrentStateFactHistory: () => this.syncCurrentStateFactHistory(bookId, chapterNumber),
      logSnapshotStage: () =>
        this.logStage(stageLanguage, { zh: "更新章节索引与快照", en: "updating chapter index and snapshots" }),
    });

    // 6. Send notification
    if (this.config.notifyChannels && this.config.notifyChannels.length > 0) {
      const statusEmoji = resolvedStatus === "state-degraded"
        ? "🧯"
        : auditResult.passed ? "✅" : "⚠️";
      const chapterLength = formatLengthCount(finalWordCount, lengthSpec.countingMode);
      await dispatchNotification(this.config.notifyChannels, {
        title: `${statusEmoji} ${book.title} 第${chapterNumber}章`,
        body: [
          `**${persistenceOutput.title}** | ${chapterLength}`,
          revised ? "📝 已自动修正" : "",
          resolvedStatus === "state-degraded"
            ? "状态结算: 已降级保存，需先修复 state 再继续"
            : `审稿: ${auditResult.passed ? "通过" : "需人工审核"}`,
          ...auditResult.issues
            .filter((i) => i.severity !== "info")
            .map((i) => `- [${i.severity}] ${i.description}`),
        ]
          .filter(Boolean)
          .join("\n"),
      });
    }

    await this.emitWebhook("pipeline-complete", bookId, chapterNumber, {
      title: persistenceOutput.title,
      wordCount: finalWordCount,
      passed: auditResult.passed,
      revised,
      status: resolvedStatus,
    });

    return {
      chapterNumber,
      title: persistenceOutput.title,
      wordCount: finalWordCount,
      auditResult,
      revised,
      status: resolvedStatus,
      lengthWarnings,
      lengthTelemetry,
      tokenUsage: totalUsage,
    };
  }

  private async _repairChapterStateLocked(bookId: string, chapterNumber?: number): Promise<ChapterPipelineResult> {
    const book = await this.state.loadBookConfig(bookId);
    const bookDir = this.state.bookDir(bookId);
    const stageLanguage = await this.resolveBookLanguage(book);
    const index = [...(await this.state.loadChapterIndex(bookId))];
    if (index.length === 0) {
      throw new Error(`Book "${bookId}" has no persisted chapters to repair.`);
    }

    const targetChapter = chapterNumber ?? index[index.length - 1]!.number;
    const targetIndex = index.findIndex((chapter) => chapter.number === targetChapter);
    if (targetIndex < 0) {
      throw new Error(`Chapter ${targetChapter} not found in "${bookId}".`);
    }
    const targetMeta = index[targetIndex]!;
    const latestChapter = Math.max(...index.map((chapter) => chapter.number));
    if (targetMeta.status !== "state-degraded") {
      throw new Error(`Chapter ${targetChapter} is not state-degraded.`);
    }
    if (targetChapter !== latestChapter) {
      throw new Error(`Only the latest state-degraded chapter can be repaired safely (latest is ${latestChapter}).`);
    }

    this.logStage(stageLanguage, { zh: "修复章节状态结算", en: "repairing chapter state settlement" });
    const { profile: gp } = await this.loadGenreProfile(book.genre);
    const pipelineLang = book.language ?? gp.language;
    const content = await this.readChapterContent(bookDir, targetChapter);
    const storyDir = join(bookDir, "story");
    const [oldState, oldHooks] = await Promise.all([
      readFile(join(storyDir, "current_state.md"), "utf-8").catch(() => ""),
      readFile(join(storyDir, "pending_hooks.md"), "utf-8").catch(() => ""),
    ]);

    const writer = new WriterAgent(this.agentCtxFor("writer", bookId));
    let repairedOutput = await writer.settleChapterState({
      book,
      bookDir,
      chapterNumber: targetChapter,
      title: targetMeta.title,
      content,
      allowReapply: true,
    });
    const validator = new StateValidatorAgent(this.agentCtxFor("state-validator", bookId));
    let validation = await validator.validate(
      content,
      targetChapter,
      oldState,
      repairedOutput.updatedState,
      oldHooks,
      repairedOutput.updatedHooks,
      pipelineLang,
    );

    if (!validation.passed) {
      const recovery = await retrySettlementAfterValidationFailure({
        writer,
        validator,
        book,
        bookDir,
        chapterNumber: targetChapter,
        title: targetMeta.title,
        content,
        oldState,
        oldHooks,
        originalValidation: validation,
        language: pipelineLang,
        logWarn: (message) => this.logWarn(pipelineLang, message),
        logger: this.config.logger,
      });
      if (recovery.kind !== "recovered") {
        throw new Error(
          recovery.issues[0]?.description
            ?? `State repair still failed for chapter ${targetChapter}.`,
        );
      }
      repairedOutput = recovery.output;
      validation = recovery.validation;
    }

    if (!validation.passed) {
      throw new Error(`State repair still failed for chapter ${targetChapter}.`);
    }

    await writer.saveChapter(bookDir, repairedOutput, gp.numericalSystem, pipelineLang);
    await writer.saveNewTruthFiles(bookDir, repairedOutput, pipelineLang);
    await this.syncLegacyStructuredStateFromMarkdown(bookDir, targetChapter, repairedOutput);
    await this.syncNarrativeMemoryIndex(bookId);
    await this.state.snapshotState(bookId, targetChapter);
    await this.syncCurrentStateFactHistory(bookId, targetChapter);

    const baseStatus = resolveStateDegradedBaseStatus(targetMeta);
    const degradedMetadata = parseStateDegradedReviewNote(targetMeta.reviewNote);
    const injectedIssues = new Set(degradedMetadata?.injectedIssues ?? []);
    index[targetIndex] = {
      ...targetMeta,
      status: baseStatus,
      updatedAt: new Date().toISOString(),
      auditIssues: targetMeta.auditIssues.filter((issue) => !injectedIssues.has(issue)),
      reviewNote: undefined,
    };
    await this.state.saveChapterIndex(bookId, index);

    const repairedPassesAudit = baseStatus !== "audit-failed";
    return {
      chapterNumber: targetChapter,
      title: targetMeta.title,
      wordCount: targetMeta.wordCount,
      auditResult: {
        passed: repairedPassesAudit,
        issues: [],
        summary: repairedPassesAudit ? "state repaired" : "state repaired but chapter still needs review",
      },
      revised: false,
      status: baseStatus,
      lengthWarnings: targetMeta.lengthWarnings,
      lengthTelemetry: targetMeta.lengthTelemetry,
      tokenUsage: targetMeta.tokenUsage,
    };
  }

  private async _resyncChapterArtifactsLocked(bookId: string, chapterNumber?: number): Promise<ChapterPipelineResult> {
    const book = await this.state.loadBookConfig(bookId);
    const bookDir = this.state.bookDir(bookId);
    const stageLanguage = await this.resolveBookLanguage(book);
    const index = [...(await this.state.loadChapterIndex(bookId))];
    if (index.length === 0) {
      throw new Error(`Book "${bookId}" has no persisted chapters to sync.`);
    }

    const targetChapter = chapterNumber ?? index[index.length - 1]!.number;
    const targetIndex = index.findIndex((chapter) => chapter.number === targetChapter);
    if (targetIndex < 0) {
      throw new Error(`Chapter ${targetChapter} not found in "${bookId}".`);
    }

    const targetMeta = index[targetIndex]!;
    const latestChapter = Math.max(...index.map((chapter) => chapter.number));
    if (targetChapter !== latestChapter) {
      throw new Error(`Only the latest persisted chapter can be synced safely (latest is ${latestChapter}).`);
    }

    this.logStage(stageLanguage, { zh: "根据已编辑正文同步真相文件与索引", en: "syncing truth files and indexes from edited chapter body" });
    const { profile: gp } = await this.loadGenreProfile(book.genre);
    const pipelineLang = book.language ?? gp.language;
    const content = await this.readChapterContent(bookDir, targetChapter);
    const storyDir = join(bookDir, "story");
    const [oldState, oldHooks] = await Promise.all([
      readFile(join(storyDir, "current_state.md"), "utf-8").catch(() => ""),
      readFile(join(storyDir, "pending_hooks.md"), "utf-8").catch(() => ""),
    ]);

    const reducedControlInput = (this.config.inputGovernanceMode ?? "v2") === "legacy"
      ? undefined
      : await this.createGovernedArtifacts(
        book,
        bookDir,
        targetChapter,
        this.config.externalContext,
        { reuseExistingIntentWhenContextMissing: true },
      );

    const writer = new WriterAgent(this.agentCtxFor("writer", bookId));
    let syncedOutput = await writer.settleChapterState({
      book,
      bookDir,
      chapterNumber: targetChapter,
      title: targetMeta.title,
      content,
      chapterIntent: reducedControlInput?.plan.intentMarkdown,
      contextPackage: reducedControlInput?.composed.contextPackage,
      ruleStack: reducedControlInput?.composed.ruleStack,
      allowReapply: true,
    });
    const validator = new StateValidatorAgent(this.agentCtxFor("state-validator", bookId));
    let validation = await validator.validate(
      content,
      targetChapter,
      oldState,
      syncedOutput.updatedState,
      oldHooks,
      syncedOutput.updatedHooks,
      pipelineLang,
    );

    if (!validation.passed) {
      const recovery = await retrySettlementAfterValidationFailure({
        writer,
        validator,
        book,
        bookDir,
        chapterNumber: targetChapter,
        title: targetMeta.title,
        content,
        reducedControlInput: reducedControlInput
          ? {
              chapterIntent: reducedControlInput.plan.intentMarkdown,
              contextPackage: reducedControlInput.composed.contextPackage,
              ruleStack: reducedControlInput.composed.ruleStack,
            }
          : undefined,
        oldState,
        oldHooks,
        originalValidation: validation,
        language: pipelineLang,
        logWarn: (message) => this.logWarn(pipelineLang, message),
        logger: this.config.logger,
      });
      if (recovery.kind !== "recovered") {
        throw new Error(
          recovery.issues[0]?.description
            ?? `Chapter sync still failed for chapter ${targetChapter}.`,
        );
      }
      syncedOutput = recovery.output;
      validation = recovery.validation;
    }

    if (!validation.passed) {
      throw new Error(`Chapter sync still failed for chapter ${targetChapter}.`);
    }

    await writer.saveChapter(bookDir, syncedOutput, gp.numericalSystem, pipelineLang);
    await writer.saveNewTruthFiles(bookDir, syncedOutput, pipelineLang);
    await this.syncLegacyStructuredStateFromMarkdown(bookDir, targetChapter, syncedOutput);
    await this.syncNarrativeMemoryIndex(bookId);
    await this.state.snapshotState(bookId, targetChapter);
    await this.syncCurrentStateFactHistory(bookId, targetChapter);

    const finalStatus: "ready-for-review" | "audit-failed" = targetMeta.status === "state-degraded"
      ? resolveStateDegradedBaseStatus(targetMeta)
      : "ready-for-review";

    if (targetMeta.status === "state-degraded") {
      const degradedMetadata = parseStateDegradedReviewNote(targetMeta.reviewNote);
      const injectedIssues = new Set(degradedMetadata?.injectedIssues ?? []);
      index[targetIndex] = {
        ...targetMeta,
        status: finalStatus,
        updatedAt: new Date().toISOString(),
        auditIssues: targetMeta.auditIssues.filter((issue) => !injectedIssues.has(issue)),
        reviewNote: undefined,
      };
    } else {
      index[targetIndex] = {
        ...targetMeta,
        status: "ready-for-review",
        updatedAt: new Date().toISOString(),
      };
    }
    await this.state.saveChapterIndex(bookId, index);
    return {
      chapterNumber: targetChapter,
      title: targetMeta.title,
      wordCount: targetMeta.wordCount,
      auditResult: {
        passed: finalStatus !== "audit-failed",
        issues: [],
        summary: finalStatus === "audit-failed"
          ? "chapter truth/state resynced from edited body, but chapter still needs audit fixes"
          : "chapter truth/state resynced from edited body",
      },
      revised: false,
      status: finalStatus,
      lengthWarnings: targetMeta.lengthWarnings,
      lengthTelemetry: targetMeta.lengthTelemetry,
      tokenUsage: targetMeta.tokenUsage,
    };
  }

  // ---------------------------------------------------------------------------
  // Import operations (style imitation + canon for spinoff)
  // ---------------------------------------------------------------------------

  /**
   * Generate a qualitative style guide from reference text via LLM.
   * Also saves the statistical style_profile.json.
   */
  async generateStyleGuide(bookId: string, referenceText: string, sourceName?: string): Promise<string> {
    if (referenceText.length < 500) {
      throw new Error(`Reference text too short (${referenceText.length} chars, minimum 500). Provide at least 2000 chars for reliable style extraction.`);
    }

    const { analyzeStyle } = await import("../agents/style-analyzer.js");
    const bookDir = this.state.bookDir(bookId);
    const storyDir = join(bookDir, "story");
    await mkdir(storyDir, { recursive: true });

    // Statistical fingerprint
    const profile = analyzeStyle(referenceText, sourceName);
    await writeFile(join(storyDir, "style_profile.json"), JSON.stringify(profile, null, 2), "utf-8");

    // LLM qualitative extraction
    const response = await chatCompletion(this.config.client, this.config.model, [
      {
        role: "system",
        content: `你是一位文学风格分析专家。分析参考文本的写作风格，提取可供模仿的定性特征。

输出格式（Markdown）：
## 叙事声音与语气
（冷峻/热烈/讽刺/温情/...，附1-2个原文例句）

## 对话风格
（角色说话的共性特征：句子长短、口头禅倾向、方言痕迹、对话节奏）

## 场景描写特征
（五感偏好、意象选择、描写密度、环境与情绪的关联方式）

## 转折与衔接手法
（场景如何切换、时间跳跃的处理方式、段落间的过渡特征）

## 节奏特征
（长短句分布、段落长度偏好、高潮/舒缓的交替方式）

## 词汇偏好
（高频特色用词、比喻/修辞倾向、口语化程度）

## 情绪表达方式
（直白抒情 vs 动作外化、内心独白的频率和风格）

## 独特习惯
（任何值得模仿的个人写作习惯）

分析必须基于原文实际特征，不要泛泛而谈。每个部分用1-2个原文例句佐证。`,
      },
      {
        role: "user",
        content: `分析以下参考文本的写作风格：\n\n${referenceText.slice(0, 20000)}`,
      },
    ], { temperature: 0.3, maxTokens: 4096 });

    await writeFile(join(storyDir, "style_guide.md"), response.content, "utf-8");
    return response.content;
  }

  /**
   * Import canon from parent book for spinoff writing.
   * Reads parent's truth files, uses LLM to generate parent_canon.md in target book.
   */
  async importCanon(targetBookId: string, parentBookId: string): Promise<string> {
    // Validate both books exist
    const bookIds = await this.state.listBooks();
    if (!bookIds.includes(parentBookId)) {
      throw new Error(`Parent book "${parentBookId}" not found. Available: ${bookIds.join(", ") || "(none)"}`);
    }
    if (!bookIds.includes(targetBookId)) {
      throw new Error(`Target book "${targetBookId}" not found. Available: ${bookIds.join(", ") || "(none)"}`);
    }

    const parentDir = this.state.bookDir(parentBookId);
    const targetDir = this.state.bookDir(targetBookId);
    const storyDir = join(targetDir, "story");
    await mkdir(storyDir, { recursive: true });

    const readSafe = async (path: string): Promise<string> => {
      try { return await readFile(path, "utf-8"); } catch { return "(无)"; }
    };

    const parentBook = await this.state.loadBookConfig(parentBookId);

    const [storyBible, currentState, ledger, hooks, summaries, subplots, emotions, matrix] =
      await Promise.all([
        readSafe(join(parentDir, "story/story_bible.md")),
        readSafe(join(parentDir, "story/current_state.md")),
        readSafe(join(parentDir, "story/particle_ledger.md")),
        readSafe(join(parentDir, "story/pending_hooks.md")),
        readSafe(join(parentDir, "story/chapter_summaries.md")),
        readSafe(join(parentDir, "story/subplot_board.md")),
        readSafe(join(parentDir, "story/emotional_arcs.md")),
        readSafe(join(parentDir, "story/character_matrix.md")),
      ]);

    const response = await chatCompletion(this.config.client, this.config.model, [
      {
        role: "system",
        content: `你是一位网络小说架构师。基于正传的全部设定和状态文件，生成一份完整的"正传正典参照"文档，供番外写作和审计使用。

输出格式（Markdown）：
# 正传正典（《{正传书名}》）

## 世界规则（完整，来自正传设定）
（力量体系、地理设定、阵营关系、核心规则——完整复制，不压缩）

## 正典约束（不可违反的事实）
| 约束ID | 类型 | 约束内容 | 严重性 |
|---|---|---|---|
| C01 | 人物存亡 | ... | critical |
（列出所有硬性约束：谁活着、谁死了、什么事件已经发生、什么规则不可违反）

## 角色快照
| 角色 | 当前状态 | 性格底色 | 对话特征 | 已知信息 | 未知信息 |
|---|---|---|---|---|---|
（从状态卡和角色矩阵中提取每个重要角色的完整快照）

## 角色双态处理原则
- 未来会变强的角色：写潜力暗示
- 未来会黑化的角色：写微小裂痕
- 未来会死的角色：写导致死亡的性格底色

## 关键事件时间线
| 章节 | 事件 | 涉及角色 | 对番外的约束 |
|---|---|---|---|
（从章节摘要中提取关键事件）

## 伏笔状态
| Hook ID | 类型 | 状态 | 内容 | 预期回收 |
|---|---|---|---|---|

## 资源账本快照
（当前资源状态）

---
meta:
  parentBookId: "{parentBookId}"
  parentTitle: "{正传书名}"
  generatedAt: "{ISO timestamp}"

要求：
1. 世界规则完整复制，不压缩——准确性优先
2. 正典约束必须穷尽，遗漏会导致番外与正传矛盾
3. 角色快照必须包含信息边界（已知/未知），防止番外中角色引用不该知道的信息`,
      },
      {
        role: "user",
        content: `正传书名：${parentBook.title}
正传ID：${parentBookId}

## 正传世界设定
${storyBible}

## 正传当前状态卡
${currentState}

## 正传资源账本
${ledger}

## 正传伏笔池
${hooks}

## 正传章节摘要
${summaries}

## 正传支线进度
${subplots}

## 正传情感弧线
${emotions}

## 正传角色矩阵
${matrix}`,
      },
    ], { temperature: 0.3, maxTokens: 16384 });

    // Append deterministic meta block (LLM may hallucinate timestamps)
    const metaBlock = [
      "",
      "---",
      "meta:",
      `  parentBookId: "${parentBookId}"`,
      `  parentTitle: "${parentBook.title}"`,
      `  generatedAt: "${new Date().toISOString()}"`,
    ].join("\n");
    const canon = response.content + metaBlock;

    await writeFile(join(storyDir, "parent_canon.md"), canon, "utf-8");

    // Also generate style guide from parent's chapter text if available
    const parentChaptersDir = join(parentDir, "chapters");
    const parentChapterText = await this.readParentChapterSample(parentChaptersDir);
    if (parentChapterText.length >= 500) {
      await this.tryGenerateStyleGuide(targetBookId, parentChapterText, parentBook.title);
    }

    return canon;
  }

  private async readParentChapterSample(chaptersDir: string): Promise<string> {
    try {
      const entries = await readdir(chaptersDir);
      const mdFiles = entries
        .filter((file) => file.endsWith(".md"))
        .sort()
        .slice(0, 5);
      const chunks: string[] = [];
      let totalLength = 0;
      for (const file of mdFiles) {
        if (totalLength >= 20000) break;
        const content = await readFile(join(chaptersDir, file), "utf-8");
        chunks.push(content);
        totalLength += content.length;
      }
      return chunks.join("\n\n---\n\n");
    } catch {
      return "";
    }
  }

  // ---------------------------------------------------------------------------
  // Chapter import (for continuation writing from existing chapters)
  // ---------------------------------------------------------------------------

  /**
   * Import existing chapters into a book. Reverse-engineers all truth files
   * via sequential replay so the Writer and Auditor can continue naturally.
   *
   * Step 1: Generate foundation (story_bible, volume_outline, book_rules) from all chapters.
   * Step 2: Sequentially replay each chapter through ChapterAnalyzer to build truth files.
   */
  async importChapters(input: ImportChaptersInput): Promise<ImportChaptersResult> {
    const releaseLock = await this.state.acquireBookLock(input.bookId);
    try {
      const book = await this.state.loadBookConfig(input.bookId);
      const bookDir = this.state.bookDir(input.bookId);
      const { profile: gp } = await this.loadGenreProfile(book.genre);
      const resolvedLanguage = book.language ?? gp.language;

      const startFrom = input.resumeFrom ?? 1;

      const log = this.config.logger?.child("import");

      // Step 1: Generate foundation on first run (not on resume)
      if (startFrom === 1) {
        log?.info(this.localize(resolvedLanguage, {
          zh: `步骤 1：从 ${input.chapters.length} 章生成基础设定...`,
          en: `Step 1: Generating foundation from ${input.chapters.length} chapters...`,
        }));
        const allText = input.chapters.map((c, i) =>
          resolvedLanguage === "en"
            ? `Chapter ${i + 1}: ${c.title}\n\n${c.content}`
            : `第${i + 1}章 ${c.title}\n\n${c.content}`,
        ).join("\n\n---\n\n");

        const architect = new ArchitectAgent(this.agentCtxFor("architect", input.bookId));
        const isSeries = input.importMode === "series";
        const foundation = isSeries
          ? await this.generateAndReviewFoundation({
              generate: (reviewFeedback) => architect.generateFoundationFromImport(book, allText, undefined, reviewFeedback, { importMode: "series" }),
              reviewer: new FoundationReviewerAgent(this.agentCtxFor("foundation-reviewer", input.bookId)),
              mode: "series",
              language: resolvedLanguage === "en" ? "en" : "zh",
              stageLanguage: resolvedLanguage,
            })
          : await architect.generateFoundationFromImport(book, allText);
        await architect.writeFoundationFiles(
          bookDir,
          foundation,
          gp.numericalSystem,
          resolvedLanguage,
        );
        await this.resetImportReplayTruthFiles(bookDir, resolvedLanguage);
        await this.state.saveChapterIndex(input.bookId, []);
        await this.state.snapshotState(input.bookId, 0);

        // Generate style guide from imported chapters
        if (allText.length >= 500) {
          log?.info(this.localize(resolvedLanguage, {
            zh: "提取原文风格指纹...",
            en: "Extracting source style fingerprint...",
          }));
          await this.tryGenerateStyleGuide(input.bookId, allText, book.title, resolvedLanguage);
        }

        log?.info(this.localize(resolvedLanguage, {
          zh: "基础设定已生成。",
          en: "Foundation generated.",
        }));
      }

      // Step 2: Sequential replay
      log?.info(this.localize(resolvedLanguage, {
        zh: `步骤 2：从第 ${startFrom} 章开始顺序回放...`,
        en: `Step 2: Sequential replay from chapter ${startFrom}...`,
      }));
      const analyzer = new ChapterAnalyzerAgent(this.agentCtxFor("chapter-analyzer", input.bookId));
      const writer = new WriterAgent(this.agentCtxFor("writer", input.bookId));
      const countingMode = resolveLengthCountingMode(book.language ?? gp.language);
      let totalWords = 0;
      let importedCount = 0;

      for (let i = startFrom - 1; i < input.chapters.length; i++) {
        const ch = input.chapters[i]!;
        const chapterNumber = i + 1;
        const governedInput = await this.prepareWriteInput(book, bookDir, chapterNumber);

        log?.info(this.localize(resolvedLanguage, {
          zh: `分析章节 ${chapterNumber}/${input.chapters.length}：${ch.title}...`,
          en: `Analyzing chapter ${chapterNumber}/${input.chapters.length}: ${ch.title}...`,
        }));

        // Analyze chapter to get truth file updates
        const output = await analyzer.analyzeChapter({
          book,
          bookDir,
          chapterNumber,
          chapterContent: ch.content,
          chapterTitle: ch.title,
          chapterIntent: governedInput.chapterIntent,
          contextPackage: governedInput.contextPackage,
          ruleStack: governedInput.ruleStack,
        });

        // Save chapter file + core truth files (state, ledger, hooks)
        await writer.saveChapter(bookDir, {
          ...output,
          postWriteErrors: [],
          postWriteWarnings: [],
        }, gp.numericalSystem, resolvedLanguage);

        // Save extended truth files (summaries, subplots, emotional arcs, character matrix)
        await writer.saveNewTruthFiles(bookDir, {
          ...output,
          postWriteErrors: [],
          postWriteWarnings: [],
        }, resolvedLanguage);
        await this.syncLegacyStructuredStateFromMarkdown(bookDir, chapterNumber, output);
        await this.syncNarrativeMemoryIndex(input.bookId);

        // Update chapter index
        const existingIndex = await this.state.loadChapterIndex(input.bookId);
        const now = new Date().toISOString();
        const chapterWordCount = countChapterLength(ch.content, countingMode);
        const newEntry: ChapterMeta = {
          number: chapterNumber,
          title: output.title,
          status: "imported",
          wordCount: chapterWordCount,
          createdAt: now,
          updatedAt: now,
          auditIssues: [],
          lengthWarnings: [],
        };
        // Replace if exists (resume case), otherwise append
        const existingIdx = existingIndex.findIndex((e) => e.number === chapterNumber);
        const updatedIndex = existingIdx >= 0
          ? existingIndex.map((e, idx) => idx === existingIdx ? newEntry : e)
          : [...existingIndex, newEntry];
        await this.state.saveChapterIndex(input.bookId, updatedIndex);

        // Snapshot state after each chapter for rollback + resume support
        await this.state.snapshotState(input.bookId, chapterNumber);

        importedCount++;
        totalWords += chapterWordCount;
      }

      if (input.chapters.length > 0) {
        await this.markBookActiveIfNeeded(input.bookId);
        await this.syncCurrentStateFactHistory(input.bookId, input.chapters.length);
      }

      const nextChapter = input.chapters.length + 1;
      log?.info(this.localize(resolvedLanguage, {
        zh: `完成。已导入 ${importedCount} 章，共 ${formatLengthCount(totalWords, countingMode)}。下一章：${nextChapter}`,
        en: `Done. ${importedCount} chapters imported, ${formatLengthCount(totalWords, countingMode)}. Next chapter: ${nextChapter}`,
      }));

      return {
        bookId: input.bookId,
        importedCount,
        totalWords,
        nextChapter,
      };
    } finally {
      await releaseLock();
    }
  }

  private static addUsage(
    a: TokenUsageSummary,
    b?: { readonly promptTokens: number; readonly completionTokens: number; readonly totalTokens: number },
  ): TokenUsageSummary {
    if (!b) return a;
    return {
      promptTokens: a.promptTokens + b.promptTokens,
      completionTokens: a.completionTokens + b.completionTokens,
      totalTokens: a.totalTokens + b.totalTokens,
    };
  }

  private async buildPersistenceOutput(
    bookId: string,
    book: BookConfig,
    bookDir: string,
    chapterNumber: number,
    output: WriteChapterOutput,
    finalContent: string,
    countingMode: Parameters<typeof countChapterLength>[1],
    reducedControlInput?: {
      chapterIntent: string;
      contextPackage: ContextPackage;
      ruleStack: RuleStack;
    },
  ): Promise<WriteChapterOutput> {
    if (finalContent === output.content) {
      return output;
    }

    const analyzer = new ChapterAnalyzerAgent(this.agentCtxFor("chapter-analyzer", bookId));
    const analyzed = await analyzer.analyzeChapter({
      book,
      bookDir,
      chapterNumber,
      chapterContent: finalContent,
      chapterTitle: output.title,
      chapterIntent: reducedControlInput?.chapterIntent,
      contextPackage: reducedControlInput?.contextPackage,
      ruleStack: reducedControlInput?.ruleStack,
    });

    return {
      ...analyzed,
      content: finalContent,
      wordCount: countChapterLength(finalContent, countingMode),
      postWriteErrors: [],
      postWriteWarnings: [],
      hookHealthIssues: output.hookHealthIssues,
      tokenUsage: output.tokenUsage,
    };
  }

  private async assertNoPendingStateRepair(bookId: string): Promise<void> {
    const existingIndex = await this.state.loadChapterIndex(bookId);
    const latestChapter = [...existingIndex].sort((left, right) => right.number - left.number)[0];
    if (latestChapter?.status !== "state-degraded") {
      return;
    }

    throw new Error(
      `Latest chapter ${latestChapter.number} is state-degraded. Repair state or rewrite that chapter before continuing.`,
    );
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private async prepareWriteInput(
    book: BookConfig,
    bookDir: string,
    chapterNumber: number,
    externalContext?: string,
  ): Promise<Pick<WriteChapterInput, "externalContext" | "chapterIntent" | "contextPackage" | "ruleStack" | "trace">> {
    if ((this.config.inputGovernanceMode ?? "v2") === "legacy") {
      return { externalContext };
    }

    const { plan, composed } = await this.createGovernedArtifacts(
      book,
      bookDir,
      chapterNumber,
      externalContext,
      { reuseExistingIntentWhenContextMissing: true },
    );

    return {
      chapterIntent: plan.intentMarkdown,
      contextPackage: composed.contextPackage,
      ruleStack: composed.ruleStack,
      trace: composed.trace,
    };
  }

  private async resetImportReplayTruthFiles(
    bookDir: string,
    language: LengthLanguage,
  ): Promise<void> {
    const storyDir = join(bookDir, "story");

    await Promise.all([
      writeFile(
        join(storyDir, "current_state.md"),
        this.buildImportReplayStateSeed(language),
        "utf-8",
      ),
      writeFile(
        join(storyDir, "pending_hooks.md"),
        this.buildImportReplayHooksSeed(language),
        "utf-8",
      ),
      rm(join(storyDir, "chapter_summaries.md"), { force: true }),
      rm(join(storyDir, "subplot_board.md"), { force: true }),
      rm(join(storyDir, "emotional_arcs.md"), { force: true }),
      rm(join(storyDir, "character_matrix.md"), { force: true }),
      rm(join(storyDir, "volume_summaries.md"), { force: true }),
      rm(join(storyDir, "particle_ledger.md"), { force: true }),
      rm(join(storyDir, "memory.db"), { force: true }),
      rm(join(storyDir, "memory.db-shm"), { force: true }),
      rm(join(storyDir, "memory.db-wal"), { force: true }),
      rm(join(storyDir, "state"), { recursive: true, force: true }),
      rm(join(storyDir, "snapshots"), { recursive: true, force: true }),
    ]);
  }

  private buildImportReplayStateSeed(language: LengthLanguage): string {
    if (language === "en") {
      return [
        "# Current State",
        "",
        "| Field | Value |",
        "| --- | --- |",
        "| Current Chapter | 0 |",
        "| Current Location | (not set) |",
        "| Protagonist State | (not set) |",
        "| Current Goal | (not set) |",
        "| Current Constraint | (not set) |",
        "| Current Alliances | (not set) |",
        "| Current Conflict | (not set) |",
        "",
      ].join("\n");
    }

    return [
      "# 当前状态",
      "",
      "| 字段 | 值 |",
      "| --- | --- |",
      "| 当前章节 | 0 |",
      "| 当前位置 | （未设定） |",
      "| 主角状态 | （未设定） |",
      "| 当前目标 | （未设定） |",
      "| 当前限制 | （未设定） |",
      "| 当前敌我 | （未设定） |",
      "| 当前冲突 | （未设定） |",
      "",
    ].join("\n");
  }

  private buildImportReplayHooksSeed(language: LengthLanguage): string {
    if (language === "en") {
      return [
        "# Pending Hooks",
        "",
        "| hook_id | start_chapter | type | status | last_advanced_chapter | expected_payoff | notes |",
        "| --- | --- | --- | --- | --- | --- | --- |",
        "",
      ].join("\n");
    }

    return [
      "# 伏笔池",
      "",
      "| hook_id | 起始章节 | 类型 | 状态 | 最近推进 | 预期回收 | 备注 |",
      "| --- | --- | --- | --- | --- | --- | --- |",
      "",
    ].join("\n");
  }

  private async normalizeDraftLengthIfNeeded(params: {
    bookId: string;
    chapterNumber: number;
    chapterContent: string;
    lengthSpec: LengthSpec;
    chapterIntent?: string;
  }): Promise<{
    content: string;
    wordCount: number;
    applied: boolean;
    tokenUsage?: TokenUsageSummary;
  }> {
    const writerCount = countChapterLength(
      params.chapterContent,
      params.lengthSpec.countingMode,
    );
    if (!isOutsideSoftRange(writerCount, params.lengthSpec)) {
      return {
        content: params.chapterContent,
        wordCount: writerCount,
        applied: false,
      };
    }

    const normalizer = new LengthNormalizerAgent(
      this.agentCtxFor("length-normalizer", params.bookId),
    );
    const normalized = await normalizer.normalizeChapter({
      chapterContent: params.chapterContent,
      lengthSpec: params.lengthSpec,
      chapterIntent: params.chapterIntent,
    });

    // Safety net: if normalizer output is less than 25% of original, it was too destructive.
    // Reject and keep original content.
    if (normalized.finalCount < writerCount * 0.25) {
      this.logWarn(this.languageFromLengthSpec(params.lengthSpec), {
        zh: `字数归一化被拒绝：第${params.chapterNumber}章 ${writerCount} -> ${normalized.finalCount}（砍了${Math.round((1 - normalized.finalCount / writerCount) * 100)}%，超过安全阈值）`,
        en: `Length normalization rejected for chapter ${params.chapterNumber}: ${writerCount} -> ${normalized.finalCount} (cut ${Math.round((1 - normalized.finalCount / writerCount) * 100)}%, exceeds safety threshold)`,
      });
      return {
        content: params.chapterContent,
        wordCount: writerCount,
        applied: false,
      };
    }

    this.logInfo(this.languageFromLengthSpec(params.lengthSpec), {
      zh: `审计前字数归一化：第${params.chapterNumber}章 ${writerCount} -> ${normalized.finalCount}`,
      en: `Length normalization before audit for chapter ${params.chapterNumber}: ${writerCount} -> ${normalized.finalCount}`,
    });

    return {
      content: normalized.normalizedContent,
      wordCount: normalized.finalCount,
      applied: normalized.applied,
      tokenUsage: normalized.tokenUsage,
    };
  }

  private assertChapterContentNotEmpty(content: string, chapterNumber: number, stage: string): void {
    if (content.trim().length > 0) return;
    throw new Error(`Chapter ${chapterNumber} has empty chapter content after ${stage}`);
  }

  private async syncCurrentStateFactHistory(bookId: string, uptoChapter: number): Promise<void> {
    const bookDir = this.state.bookDir(bookId);
    try {
      await this.rebuildCurrentStateFactHistory(bookDir, uptoChapter);
    } catch (error) {
      if (this.isMemoryIndexUnavailableError(error)) {
        if (this.canOpenMemoryIndex(bookDir)) {
          try {
            await this.rebuildCurrentStateFactHistory(bookDir, uptoChapter);
            return;
          } catch (retryError) {
            error = retryError;
          }
        } else {
          if (!this.memoryIndexFallbackWarned) {
            this.memoryIndexFallbackWarned = true;
            this.logWarn(await this.resolveBookLanguageById(bookId), {
              zh: "当前 Node 运行时不支持 SQLite 记忆索引，继续使用 Markdown 回退方案。",
              en: "SQLite memory index unavailable on this Node runtime; continuing with markdown fallback.",
            });
            await this.logMemoryIndexDebugInfo(bookId, error);
          }
          return;
        }
      }
      this.logWarn(await this.resolveBookLanguageById(bookId), {
        zh: `状态事实同步已跳过：${String(error)}`,
        en: `State fact sync skipped: ${String(error)}`,
      });
    }
  }

  private async syncLegacyStructuredStateFromMarkdown(
    bookDir: string,
    chapterNumber: number,
    output?: {
      readonly runtimeStateDelta?: WriteChapterOutput["runtimeStateDelta"];
      readonly runtimeStateSnapshot?: WriteChapterOutput["runtimeStateSnapshot"];
    },
  ): Promise<void> {
    if (output?.runtimeStateDelta || output?.runtimeStateSnapshot) {
      return;
    }

    await rewriteStructuredStateFromMarkdown({
      bookDir,
      fallbackChapter: chapterNumber,
    });
  }

  private async syncNarrativeMemoryIndex(bookId: string): Promise<void> {
    const bookDir = this.state.bookDir(bookId);
    try {
      await this.rebuildNarrativeMemoryIndex(bookDir);
    } catch (error) {
      if (this.isMemoryIndexUnavailableError(error)) {
        if (this.canOpenMemoryIndex(bookDir)) {
          try {
            await this.rebuildNarrativeMemoryIndex(bookDir);
            return;
          } catch (retryError) {
            error = retryError;
          }
        } else {
          if (!this.memoryIndexFallbackWarned) {
            this.memoryIndexFallbackWarned = true;
            this.logWarn(await this.resolveBookLanguageById(bookId), {
              zh: "当前 Node 运行时不支持 SQLite 记忆索引，继续使用 Markdown 回退方案。",
              en: "SQLite memory index unavailable on this Node runtime; continuing with markdown fallback.",
            });
            await this.logMemoryIndexDebugInfo(bookId, error);
          }
          return;
        }
      }
      this.logWarn(await this.resolveBookLanguageById(bookId), {
        zh: `叙事记忆同步已跳过：${String(error)}`,
        en: `Narrative memory sync skipped: ${String(error)}`,
      });
    }
  }

  private async rebuildCurrentStateFactHistory(bookDir: string, uptoChapter: number): Promise<void> {
    const memoryDb = await this.withMemoryIndexRetry(async () => {
      const db = new MemoryDB(bookDir);
      try {
        db.resetFacts();

        const activeFacts = new Map<string, { id: number; object: string }>();

        for (let chapter = 0; chapter <= uptoChapter; chapter++) {
          const snapshotFacts = await loadSnapshotCurrentStateFacts(bookDir, chapter);
          if (snapshotFacts.length === 0) continue;
          const nextFacts = new Map<string, Omit<Fact, "id">>();

          for (const fact of snapshotFacts) {
            nextFacts.set(this.factKey(fact), {
              subject: fact.subject,
              predicate: fact.predicate,
              object: fact.object,
              validFromChapter: chapter,
              validUntilChapter: null,
              sourceChapter: chapter,
            });
          }

          for (const [key, previous] of activeFacts.entries()) {
            const next = nextFacts.get(key);
            if (!next || next.object !== previous.object) {
              db.invalidateFact(previous.id, chapter);
              activeFacts.delete(key);
            }
          }

          for (const [key, fact] of nextFacts.entries()) {
            if (activeFacts.has(key)) continue;
            const id = db.addFact(fact);
            activeFacts.set(key, { id, object: fact.object });
          }
        }

        return db;
      } catch (error) {
        db.close();
        throw error;
      }
    });

    try {
      // No-op: keep the db open only for the duration of the rebuild.
    } finally {
      memoryDb.close();
    }
  }

  private async rebuildNarrativeMemoryIndex(bookDir: string): Promise<void> {
    const memorySeed = await loadNarrativeMemorySeed(bookDir);

    const memoryDb = await this.withMemoryIndexRetry(() => {
      const db = new MemoryDB(bookDir);
      try {
        db.replaceSummaries(memorySeed.summaries);
        db.replaceHooks(memorySeed.hooks);
        return db;
      } catch (error) {
        db.close();
        throw error;
      }
    });

    try {
      // No-op: keep the db open only for the duration of the rebuild.
    } finally {
      memoryDb.close();
    }
  }

  private canOpenMemoryIndex(bookDir: string): boolean {
    let memoryDb: MemoryDB | null = null;
    try {
      memoryDb = new MemoryDB(bookDir);
      return true;
    } catch {
      return false;
    } finally {
      memoryDb?.close();
    }
  }

  private async logMemoryIndexDebugInfo(bookId: string, error: unknown): Promise<void> {
    if (process.env.INKOS_DEBUG_SQLITE_MEMORY !== "1") {
      return;
    }

    const code = typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : "";
    const message = error instanceof Error
      ? error.message
      : String(error);

    this.logWarn(await this.resolveBookLanguageById(bookId), {
      zh: `SQLite 记忆索引调试：node=${process.version}; execArgv=${JSON.stringify(process.execArgv)}; code=${code || "(none)"}; message=${message}`,
      en: `SQLite memory debug: node=${process.version}; execArgv=${JSON.stringify(process.execArgv)}; code=${code || "(none)"}; message=${message}`,
    });
  }

  private async withMemoryIndexRetry<T>(operation: () => Promise<T> | T): Promise<T> {
    const retryDelaysMs = [0, 25, 75];
    let lastError: unknown;

    for (let attempt = 0; attempt < retryDelaysMs.length; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        if (!this.isMemoryIndexBusyError(error) || attempt === retryDelaysMs.length - 1) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, retryDelaysMs[attempt + 1]!));
      }
    }

    throw lastError;
  }

  private isMemoryIndexUnavailableError(error: unknown): boolean {
    if (!error) return false;

    const code = typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : "";
    const message = error instanceof Error
      ? error.message
      : String(error);
    const normalizedMessage = message.trim();

    return /^No such built-in module:\s*node:sqlite$/i.test(normalizedMessage)
      || /^Cannot find module ['"]node:sqlite['"]$/i.test(normalizedMessage)
      || (code === "ERR_UNKNOWN_BUILTIN_MODULE" && /\bnode:sqlite\b/i.test(normalizedMessage));
  }

  private isMemoryIndexBusyError(error: unknown): boolean {
    if (!error) return false;

    const code = typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : "";
    const message = error instanceof Error
      ? error.message
      : String(error);

    return code === "SQLITE_BUSY"
      || code === "SQLITE_LOCKED"
      || /\bSQLITE_BUSY\b/i.test(message)
      || /\bSQLITE_LOCKED\b/i.test(message)
      || /database is locked/i.test(message)
      || /database is busy/i.test(message);
  }

  private factKey(fact: Pick<Fact, "subject" | "predicate">): string {
    return `${fact.subject}::${fact.predicate}`;
  }

  private buildLengthWarnings(
    chapterNumber: number,
    finalCount: number,
    lengthSpec: LengthSpec,
  ): string[] {
    if (!isOutsideHardRange(finalCount, lengthSpec)) {
      return [];
    }
    return [
      this.localize(this.languageFromLengthSpec(lengthSpec), {
        zh: `第${chapterNumber}章经过一次字数归一化后仍超出硬区间（${lengthSpec.hardMin}-${lengthSpec.hardMax}，实际 ${finalCount}）。`,
        en: `Chapter ${chapterNumber} remains outside hard range (${lengthSpec.hardMin}-${lengthSpec.hardMax}, actual ${finalCount}) after a single normalization pass.`,
      }),
    ];
  }

  private buildLengthTelemetry(params: {
    lengthSpec: LengthSpec;
    writerCount: number;
    postWriterNormalizeCount: number;
    postReviseCount: number;
    finalCount: number;
    normalizeApplied: boolean;
    lengthWarning: boolean;
  }): LengthTelemetry {
    return {
      target: params.lengthSpec.target,
      softMin: params.lengthSpec.softMin,
      softMax: params.lengthSpec.softMax,
      hardMin: params.lengthSpec.hardMin,
      hardMax: params.lengthSpec.hardMax,
      countingMode: params.lengthSpec.countingMode,
      writerCount: params.writerCount,
      postWriterNormalizeCount: params.postWriterNormalizeCount,
      postReviseCount: params.postReviseCount,
      finalCount: params.finalCount,
      normalizeApplied: params.normalizeApplied,
      lengthWarning: params.lengthWarning,
    };
  }

  private async persistAuditDriftGuidance(params: {
    readonly bookDir: string;
    readonly chapterNumber: number;
    readonly issues: ReadonlyArray<AuditIssue>;
    readonly language: LengthLanguage;
  }): Promise<void> {
    const storyDir = join(params.bookDir, "story");
    const driftPath = join(storyDir, "audit_drift.md");
    const statePath = join(storyDir, "current_state.md");
    const currentState = await readFile(statePath, "utf-8").catch(() => "");
    const sanitizedState = this.stripAuditDriftCorrectionBlock(currentState).trimEnd();

    if (sanitizedState !== currentState) {
      await writeFile(statePath, sanitizedState, "utf-8");
    }

    if (params.issues.length === 0) {
      await rm(driftPath, { force: true }).catch(() => undefined);
      return;
    }

    const block = [
      this.localize(params.language, {
        zh: "# 审计纠偏",
        en: "# Audit Drift",
      }),
      "",
      this.localize(params.language, {
        zh: "## 审计纠偏（自动生成，下一章写作前参照）",
        en: "## Audit Drift Correction",
      }),
      "",
      this.localize(params.language, {
        zh: `> 第${params.chapterNumber}章审计发现以下问题，下一章写作时必须避免：`,
        en: `> Chapter ${params.chapterNumber} audit found the following issues to avoid in the next chapter:`,
      }),
      ...params.issues.map((issue) => `> - [${issue.severity}] ${issue.category}: ${issue.description}`),
      "",
    ].join("\n");

    await writeFile(driftPath, block, "utf-8");
  }

  private stripAuditDriftCorrectionBlock(currentState: string): string {
    const headers = [
      "## 审计纠偏（自动生成，下一章写作前参照）",
      "## Audit Drift Correction",
      "# 审计纠偏",
      "# Audit Drift",
    ];

    let cutIndex = -1;
    for (const header of headers) {
      const index = currentState.indexOf(header);
      if (index >= 0 && (cutIndex < 0 || index < cutIndex)) {
        cutIndex = index;
      }
    }

    if (cutIndex < 0) {
      return currentState;
    }

    return currentState.slice(0, cutIndex).trimEnd();
  }

  private logLengthWarnings(lengthWarnings: ReadonlyArray<string>): void {
    for (const warning of lengthWarnings) {
      this.config.logger?.warn(warning);
    }
  }

  private restoreLostAuditIssues(previous: AuditResult, next: AuditResult): AuditResult {
    if (next.passed || next.issues.length > 0 || previous.issues.length === 0) {
      return next;
    }

    return {
      ...next,
      issues: previous.issues,
      summary: next.summary || previous.summary,
    };
  }

  private restoreActionableAuditIfLost(
    previous: {
      auditResult: AuditResult;
      aiTellCount: number;
      blockingCount: number;
      criticalCount: number;
      revisionBlockingIssues: ReadonlyArray<AuditIssue>;
    },
    next: {
      auditResult: AuditResult;
      aiTellCount: number;
      blockingCount: number;
      criticalCount: number;
      revisionBlockingIssues: ReadonlyArray<AuditIssue>;
    },
  ): MergedAuditEvaluation {
    const auditResult = this.restoreLostAuditIssues(previous.auditResult, next.auditResult);
    if (auditResult === next.auditResult) {
      return next;
    }

    return {
      ...next,
      auditResult,
      revisionBlockingIssues: previous.revisionBlockingIssues,
      blockingCount: previous.blockingCount,
      criticalCount: previous.criticalCount,
    };
  }

  private async evaluateMergedAudit(params: {
    auditor: ContinuityAuditor;
    book: BookConfig;
    bookDir: string;
    chapterContent: string;
    chapterNumber: number;
    language: LengthLanguage;
    auditOptions?: {
      temperature?: number;
      chapterIntent?: string;
      contextPackage?: ContextPackage;
      ruleStack?: RuleStack;
      truthFileOverrides?: {
        currentState?: string;
        ledger?: string;
        hooks?: string;
      };
    };
  }): Promise<MergedAuditEvaluation> {
    const llmAudit = await params.auditor.auditChapter(
      params.bookDir,
      params.chapterContent,
      params.chapterNumber,
      params.book.genre,
      params.auditOptions,
    );
    const aiTells = analyzeAITells(params.chapterContent, params.language);
    const sensitiveResult = analyzeSensitiveWords(params.chapterContent, undefined, params.language);
    const longSpanFatigue = await analyzeLongSpanFatigue({
      bookDir: params.bookDir,
      chapterNumber: params.chapterNumber,
      chapterContent: params.chapterContent,
      language: params.language,
    });
    const hasBlockedWords = sensitiveResult.found.some((f) => f.severity === "block");
    const issues: ReadonlyArray<AuditIssue> = [
      ...llmAudit.issues,
      ...aiTells.issues,
      ...sensitiveResult.issues,
      ...longSpanFatigue.issues,
    ];
    // revisionBlockingIssues excludes long-span-fatigue issues by
    // construction (not by category name) so that an LLM-reported issue
    // sharing a category label with a long-span issue is still counted.
    const revisionBlockingIssues: ReadonlyArray<AuditIssue> = [
      ...llmAudit.issues,
      ...aiTells.issues,
      ...sensitiveResult.issues,
    ];

    return {
      auditResult: {
        passed: hasBlockedWords ? false : llmAudit.passed,
        issues,
        summary: llmAudit.summary,
        tokenUsage: llmAudit.tokenUsage,
      },
      aiTellCount: aiTells.issues.length,
      blockingCount: revisionBlockingIssues.filter((issue) => issue.severity === "warning" || issue.severity === "critical").length,
      criticalCount: revisionBlockingIssues.filter((issue) => issue.severity === "critical").length,
      revisionBlockingIssues,
    };
  }

  private async markBookActiveIfNeeded(bookId: string): Promise<void> {
    const book = await this.state.loadBookConfig(bookId);
    if (book.status !== "outlining") return;

    await this.state.saveBookConfig(bookId, {
      ...book,
      status: "active",
      updatedAt: new Date().toISOString(),
    });
  }

  private async createGovernedArtifacts(
    book: BookConfig,
    bookDir: string,
    chapterNumber: number,
    externalContext?: string,
    options?: {
      readonly reuseExistingIntentWhenContextMissing?: boolean;
    },
  ): Promise<{
    plan: PlanChapterOutput;
    composed: Awaited<ReturnType<ComposerAgent["composeChapter"]>>;
  }> {
    const plan = await this.resolveGovernedPlan(book, bookDir, chapterNumber, externalContext, options);

    const composer = new ComposerAgent(this.agentCtxFor("composer", book.id));
    const composed = await composer.composeChapter({
      book,
      bookDir,
      chapterNumber,
      plan,
    });

    return { plan, composed };
  }

  private async resolveGovernedPlan(
    book: BookConfig,
    bookDir: string,
    chapterNumber: number,
    externalContext?: string,
    options?: {
      readonly reuseExistingIntentWhenContextMissing?: boolean;
    },
  ): Promise<PlanChapterOutput> {
    if (
      options?.reuseExistingIntentWhenContextMissing &&
      (!externalContext || externalContext.trim().length === 0)
    ) {
      const persisted = await loadPersistedPlan(bookDir, chapterNumber);
      if (persisted) return persisted;
    }

    const planner = new PlannerAgent(this.agentCtxFor("planner", book.id));
    return planner.planChapter({
      book,
      bookDir,
      chapterNumber,
      externalContext,
    });
  }

  private async emitWebhook(
    event: WebhookEvent,
    bookId: string,
    chapterNumber?: number,
    data?: Record<string, unknown>,
  ): Promise<void> {
    if (!this.config.notifyChannels || this.config.notifyChannels.length === 0) return;
    await dispatchWebhookEvent(this.config.notifyChannels, {
      event,
      bookId,
      chapterNumber,
      timestamp: new Date().toISOString(),
      data,
    });
  }

  private async readChapterContent(bookDir: string, chapterNumber: number): Promise<string> {
    const chaptersDir = join(bookDir, "chapters");
    const files = await readdir(chaptersDir);
    const paddedNum = String(chapterNumber).padStart(4, "0");
    const chapterFile = files.find((f) => f.startsWith(paddedNum) && f.endsWith(".md"));
    if (!chapterFile) {
      throw new Error(`Chapter ${chapterNumber} file not found in ${chaptersDir}`);
    }
    const raw = await readFile(join(chaptersDir, chapterFile), "utf-8");
    // Strip the title line
    const lines = raw.split("\n");
    const contentStart = lines.findIndex((l, i) => i > 0 && l.trim().length > 0);
    return contentStart >= 0 ? lines.slice(contentStart).join("\n") : raw;
  }

  // ---------------------------------------------------------------------------
  // Chapter Plan Audit Helpers
  // ---------------------------------------------------------------------------

  /**
   * 解析章节规划文件内容为 ChapterIntent 对象
   */
  private parseChapterIntent(content: string): {
    goal: string;
    outlineNode?: string;
    mustKeep: string[];
    mustAvoid: string[];
    arcDirective?: string;
    sceneDirective?: string;
    moodDirective?: string;
    titleDirective?: string;
  } {
    // 简单的解析逻辑，提取关键字段
    const lines = content.split("\n");
    const intent: {
      goal: string;
      outlineNode?: string;
      mustKeep: string[];
      mustAvoid: string[];
      arcDirective?: string;
      sceneDirective?: string;
      moodDirective?: string;
      titleDirective?: string;
    } = {
      goal: "",
      mustKeep: [],
      mustAvoid: [],
    };

    let currentSection: keyof typeof intent | null = null;

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("## 章节目标")) {
        currentSection = "goal";
      } else if (trimmed.startsWith("## 大纲节点")) {
        currentSection = "outlineNode";
      } else if (trimmed.startsWith("## 必须保持")) {
        currentSection = "mustKeep";
      } else if (trimmed.startsWith("## 必须避免")) {
        currentSection = "mustAvoid";
      } else if (trimmed.startsWith("## 弧线指令")) {
        currentSection = "arcDirective";
      } else if (trimmed.startsWith("## 场景指令")) {
        currentSection = "sceneDirective";
      } else if (trimmed.startsWith("## 情绪指令")) {
        currentSection = "moodDirective";
      } else if (trimmed.startsWith("## 标题指令")) {
        currentSection = "titleDirective";
      } else if (currentSection && trimmed && !trimmed.startsWith("#")) {
        if (currentSection === "mustKeep" || currentSection === "mustAvoid") {
          intent[currentSection].push(trimmed);
        } else {
          intent[currentSection] = trimmed;
        }
      }
    }

    return intent;
  }

  /**
   * 读取书籍规则
   */
  private async readBookRules(bookDir: string): Promise<import("../models/book-rules.js").BookRules> {
    const { readBookRules } = await import("../agents/rules-reader.js");
    const parsed = await readBookRules(bookDir);
    return parsed?.rules ?? {
      version: "1.0",
      prohibitions: [],
      chapterTypesOverride: [],
      fatigueWordsOverride: [],
      additionalAuditDimensions: [],
      enableFullCastTracking: false,
      allowedDeviations: [],
    };
  }

  /**
   * 保存章节规划审计失败信息
   */
  private async saveChapterPlanAuditFailure(
    bookDir: string,
    chapterNumber: number,
    auditResult: import("../config/audit-config.js").ChapterPlanAuditResult | null,
  ): Promise<void> {
    const metaPath = join(bookDir, "story", ".chapter-plan-audit-failures.json");
    let failures: Record<string, unknown> = {};

    try {
      const content = await readFile(metaPath, "utf-8");
      failures = JSON.parse(content);
    } catch {
      // 文件不存在，使用空对象
    }

    failures[String(chapterNumber)] = {
      chapterNumber,
      timestamp: new Date().toISOString(),
      score: auditResult?.score ?? 0,
      passed: false,
      issues: auditResult?.issues ?? [],
      summary: auditResult?.summary ?? "审计失败",
    };

    await writeFile(metaPath, JSON.stringify(failures, null, 2), "utf-8");
  }

  /**
   * 保存章节规划审计成功信息
   */
  private async saveChapterPlanAuditSuccess(
    bookDir: string,
    chapterNumber: number,
    auditResult: import("../config/audit-config.js").ChapterPlanAuditResult | null,
  ): Promise<void> {
    const metaPath = join(bookDir, "story", ".chapter-plan-audit-failures.json");
    let failures: Record<string, unknown> = {};

    try {
      const content = await readFile(metaPath, "utf-8");
      failures = JSON.parse(content);
    } catch {
      // 文件不存在，使用空对象
    }

    // 删除该章节的失败记录（如果存在）
    delete failures[String(chapterNumber)];

    await writeFile(metaPath, JSON.stringify(failures, null, 2), "utf-8");

    // 同时保存成功记录到另一个文件
    const successMetaPath = join(bookDir, "story", ".chapter-plan-audit-success.json");
    let successes: Record<string, unknown> = {};

    try {
      const content = await readFile(successMetaPath, "utf-8");
      successes = JSON.parse(content);
    } catch {
      // 文件不存在，使用空对象
    }

    successes[String(chapterNumber)] = {
      chapterNumber,
      timestamp: new Date().toISOString(),
      score: auditResult?.score ?? 0,
      passed: true,
      summary: auditResult?.summary ?? "审计通过",
    };

    await writeFile(successMetaPath, JSON.stringify(successes, null, 2), "utf-8");
  }
}
