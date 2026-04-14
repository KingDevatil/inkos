/**
 * RAG状态管理
 * 跟踪书籍和章节的RAG索引状态，支持延迟写入和增量补充
 */

import { readFile, writeFile, access, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { z } from "zod";

// 章节RAG状态
export const ChapterRAGStatusSchema = z.object({
  chapter: z.number().int().min(1),
  indexed: z.boolean().default(false),
  indexedAt: z.string().datetime().optional(),
  contentHash: z.string().optional(), // 内容哈希，用于检测变化
  documentIds: z.array(z.string()).default([]), // 索引的文档ID列表
});

export type ChapterRAGStatus = z.infer<typeof ChapterRAGStatusSchema>;

// 书籍RAG状态
export const BookRAGStatusSchema = z.object({
  bookId: z.string(),
  version: z.number().default(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  // 基础设定索引状态
  foundationIndexed: z.boolean().default(false),
  foundationIndexedAt: z.string().datetime().optional(),
  foundationDocumentIds: z.array(z.string()).default([]),
  // 章节索引状态
  chapters: z.array(ChapterRAGStatusSchema).default([]),
  // 统计信息
  stats: z.object({
    totalChapters: z.number().int().default(0),
    indexedChapters: z.number().int().default(0),
    pendingChapters: z.number().int().default(0),
  }).default({}),
});

export type BookRAGStatus = z.infer<typeof BookRAGStatusSchema>;

// RAG检测补充结果
export interface RAGCheckResult {
  bookId: string;
  foundationStatus: "indexed" | "missing" | "outdated";
  foundationIndexedAt?: string;
  chapters: {
    chapter: number;
    status: "indexed" | "missing" | "outdated";
    indexedAt?: string;
  }[];
  summary: {
    total: number;
    indexed: number;
    missing: number;
    outdated: number;
  };
}

export class RAGStatusManager {
  private bookDir: string;
  private statusFilePath: string;
  private cache: BookRAGStatus | null = null;
  private cacheDirty = false;

  constructor(bookDir: string) {
    this.bookDir = bookDir;
    this.statusFilePath = join(bookDir, "chapters", "rag-status.json");
  }

  /**
   * 初始化状态文件
   */
  async init(bookId: string): Promise<BookRAGStatus> {
    try {
      // 尝试读取现有状态
      const status = await this.load();
      return status;
    } catch {
      // 创建新状态
      const now = new Date().toISOString();
      const status: BookRAGStatus = {
        bookId,
        version: 1,
        createdAt: now,
        updatedAt: now,
        foundationIndexed: false,
        foundationDocumentIds: [],
        chapters: [],
        stats: {
          totalChapters: 0,
          indexedChapters: 0,
          pendingChapters: 0,
        },
      };
      await this.save(status);
      return status;
    }
  }

  /**
   * 加载状态
   */
  async load(): Promise<BookRAGStatus> {
    if (this.cache && !this.cacheDirty) {
      return this.cache;
    }

    const content = await readFile(this.statusFilePath, "utf-8");
    const data = JSON.parse(content);
    const status = BookRAGStatusSchema.parse(data);
    this.cache = status;
    return status;
  }

  /**
   * 保存状态
   */
  async save(status: BookRAGStatus): Promise<void> {
    // 确保目录存在
    await mkdir(dirname(this.statusFilePath), { recursive: true });
    
    const updatedStatus = {
      ...status,
      updatedAt: new Date().toISOString(),
    };
    
    await writeFile(
      this.statusFilePath,
      JSON.stringify(updatedStatus, null, 2),
      "utf-8"
    );
    
    this.cache = updatedStatus;
    this.cacheDirty = false;
  }

  /**
   * 标记基础设定已索引
   */
  async markFoundationIndexed(documentIds: string[]): Promise<void> {
    const status = await this.load();
    status.foundationIndexed = true;
    status.foundationIndexedAt = new Date().toISOString();
    status.foundationDocumentIds = documentIds;
    await this.save(status);
  }

  /**
   * 标记基础设定未索引（用于重置）
   */
  async markFoundationUnindexed(): Promise<void> {
    const status = await this.load();
    status.foundationIndexed = false;
    status.foundationIndexedAt = undefined;
    status.foundationDocumentIds = [];
    await this.save(status);
  }

  /**
   * 更新或添加章节索引状态
   */
  async updateChapterStatus(
    chapter: number,
    indexed: boolean,
    documentIds: string[],
    contentHash?: string
  ): Promise<void> {
    const status = await this.load();
    const now = new Date().toISOString();
    
    const existingIndex = status.chapters.findIndex(c => c.chapter === chapter);
    const chapterStatus: ChapterRAGStatus = {
      chapter,
      indexed,
      indexedAt: indexed ? now : undefined,
      contentHash,
      documentIds,
    };
    
    if (existingIndex >= 0) {
      status.chapters[existingIndex] = chapterStatus;
    } else {
      status.chapters.push(chapterStatus);
    }
    
    // 更新统计
    this.updateStats(status);
    await this.save(status);
  }

  /**
   * 标记章节未索引（用于重置）
   */
  async markChapterUnindexed(chapter: number): Promise<void> {
    const status = await this.load();
    const existingIndex = status.chapters.findIndex(c => c.chapter === chapter);
    
    if (existingIndex >= 0) {
      status.chapters[existingIndex] = {
        ...status.chapters[existingIndex],
        indexed: false,
        indexedAt: undefined,
        documentIds: [],
      };
      this.updateStats(status);
      await this.save(status);
    }
  }

  /**
   * 获取章节索引状态
   */
  async getChapterStatus(chapter: number): Promise<ChapterRAGStatus | undefined> {
    const status = await this.load();
    return status.chapters.find(c => c.chapter === chapter);
  }

  /**
   * 检查章节是否已索引
   */
  async isChapterIndexed(chapter: number): Promise<boolean> {
    const chapterStatus = await this.getChapterStatus(chapter);
    return chapterStatus?.indexed ?? false;
  }

  /**
   * 获取所有未索引的章节
   */
  async getUnindexedChapters(existingChapters: number[]): Promise<number[]> {
    const status = await this.load();
    const indexedChapters = new Set(
      status.chapters.filter(c => c.indexed).map(c => c.chapter)
    );
    return existingChapters.filter(c => !indexedChapters.has(c));
  }

  /**
   * 获取RAG检测补充报告
   */
  async checkStatus(existingChapters: number[]): Promise<RAGCheckResult> {
    const status = await this.load();
    
    const chapters: RAGCheckResult["chapters"] = [];
    
    for (const chapterNum of existingChapters) {
      const chapterStatus = status.chapters.find(c => c.chapter === chapterNum);
      
      if (!chapterStatus) {
        chapters.push({
          chapter: chapterNum,
          status: "missing",
        });
      } else if (!chapterStatus.indexed) {
        chapters.push({
          chapter: chapterNum,
          status: "missing",
        });
      } else {
        chapters.push({
          chapter: chapterNum,
          status: "indexed",
          indexedAt: chapterStatus.indexedAt,
        });
      }
    }
    
    const summary = {
      total: existingChapters.length,
      indexed: chapters.filter(c => c.status === "indexed").length,
      missing: chapters.filter(c => c.status === "missing").length,
      outdated: chapters.filter(c => c.status === "outdated").length,
    };
    
    return {
      bookId: status.bookId,
      foundationStatus: status.foundationIndexed ? "indexed" : "missing",
      foundationIndexedAt: status.foundationIndexedAt,
      chapters,
      summary,
    };
  }

  /**
   * 重置所有状态
   */
  async reset(): Promise<void> {
    const status = await this.load();
    status.foundationIndexed = false;
    status.foundationIndexedAt = undefined;
    status.foundationDocumentIds = [];
    status.chapters = [];
    status.stats = {
      totalChapters: 0,
      indexedChapters: 0,
      pendingChapters: 0,
    };
    await this.save(status);
  }

  /**
   * 批量更新章节状态
   */
  async batchUpdateChapterStatuses(
    updates: Array<{
      chapter: number;
      indexed: boolean;
      documentIds: string[];
      contentHash?: string;
    }>
  ): Promise<void> {
    const status = await this.load();
    const now = new Date().toISOString();
    
    for (const update of updates) {
      const existingIndex = status.chapters.findIndex(c => c.chapter === update.chapter);
      const chapterStatus: ChapterRAGStatus = {
        chapter: update.chapter,
        indexed: update.indexed,
        indexedAt: update.indexed ? now : undefined,
        contentHash: update.contentHash,
        documentIds: update.documentIds,
      };
      
      if (existingIndex >= 0) {
        status.chapters[existingIndex] = chapterStatus;
      } else {
        status.chapters.push(chapterStatus);
      }
    }
    
    this.updateStats(status);
    await this.save(status);
  }

  /**
   * 更新统计信息
   */
  private updateStats(status: BookRAGStatus): void {
    const indexedCount = status.chapters.filter(c => c.indexed).length;
    status.stats = {
      totalChapters: status.chapters.length,
      indexedChapters: indexedCount,
      pendingChapters: status.chapters.length - indexedCount,
    };
  }
}

/**
 * 创建RAG状态管理器
 */
export async function createRAGStatusManager(
  bookDir: string,
  bookId: string
): Promise<RAGStatusManager> {
  const manager = new RAGStatusManager(bookDir);
  await manager.init(bookId);
  return manager;
}
