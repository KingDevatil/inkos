/**
 * RAG索引器
 * 支持延迟写入、批量索引、增量更新
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { RAGManager } from "./rag-manager.js";
import type { RAGStatusManager } from "./rag-status.js";
import { createDocumentProcessor } from "./document-processor.js";
import type { ArchitectOutput } from "../agents/architect.js";
import { createLogger, nullSink } from "../utils/logger.js";

const logger = createLogger({ tag: "rag-indexer", sinks: [nullSink] });

// 索引操作类型
export interface IndexOperation {
  type: "foundation" | "chapter";
  id: string;
  content: string;
  metadata: Record<string, unknown>;
}

// 索引结果
export interface IndexResult {
  success: boolean;
  documentIds: string[];
  error?: string;
}

// 批量索引选项
export interface BatchIndexOptions {
  skipExisting?: boolean; // 跳过已索引的内容
  forceReindex?: boolean; // 强制重新索引
  onProgress?: (current: number, total: number, item: string) => void;
}

export class RAGIndexer {
  private ragManager: RAGManager;
  private statusManager: RAGStatusManager;
  private documentProcessor: ReturnType<typeof createDocumentProcessor>;
  private pendingOperations: IndexOperation[] = [];
  private isBatchMode = false;

  constructor(
    ragManager: RAGManager,
    statusManager: RAGStatusManager
  ) {
    this.ragManager = ragManager;
    this.statusManager = statusManager;
    this.documentProcessor = createDocumentProcessor({
      maxChunkSize: 500,
      minChunkSize: 50,
      chunkOverlap: 50,
      qualityThreshold: 0.3,
      enableQualityFilter: true,
      enableMetadataExtraction: true,
    });
  }

  /**
   * 开始批量模式（延迟写入）
   * 在批量模式下，索引操作会被缓存，直到调用 commit() 才真正写入
   */
  beginBatch(): void {
    this.isBatchMode = true;
    this.pendingOperations = [];
    logger.info("RAG indexer entered batch mode");
  }

  /**
   * 提交批量操作
   */
  async commit(): Promise<IndexResult[]> {
    if (!this.isBatchMode) {
      throw new Error("Not in batch mode");
    }

    this.isBatchMode = false;
    const results: IndexResult[] = [];

    logger.info(`Committing ${this.pendingOperations.length} pending operations`);

    // 按类型分组处理
    const foundationOps = this.pendingOperations.filter(op => op.type === "foundation");
    const chapterOps = this.pendingOperations.filter(op => op.type === "chapter");

    // 处理基础设定
    for (const op of foundationOps) {
      try {
        const result = await this.executeIndexOperation(op);
        results.push(result);
        
        if (result.success) {
          await this.statusManager.markFoundationIndexed(result.documentIds);
        }
      } catch (error) {
        results.push({
          success: false,
          documentIds: [],
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // 处理章节
    for (const op of chapterOps) {
      try {
        const result = await this.executeIndexOperation(op);
        results.push(result);
        
        if (result.success) {
          const chapterNum = parseInt(op.metadata.chapter as string, 10);
          const contentHash = this.computeHash(op.content);
          await this.statusManager.updateChapterStatus(
            chapterNum,
            true,
            result.documentIds,
            contentHash
          );
        }
      } catch (error) {
        results.push({
          success: false,
          documentIds: [],
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    this.pendingOperations = [];
    logger.info("Batch commit completed");
    
    return results;
  }

  /**
   * 回滚批量操作
   */
  rollback(): void {
    this.isBatchMode = false;
    this.pendingOperations = [];
    logger.info("RAG indexer batch operations rolled back");
  }

  /**
   * 索引基础设定（支持延迟写入）
   */
  async indexFoundation(
    foundation: ArchitectOutput,
    options?: { defer?: boolean }
  ): Promise<IndexResult | void> {
    const operations: IndexOperation[] = [];

    // story_bible
    if (foundation.storyBible) {
      operations.push({
        type: "foundation",
        id: "foundation:story_bible",
        content: foundation.storyBible,
        metadata: {
          fileName: "story_bible.md",
          type: "foundation",
          category: "story_bible",
        },
      });
    }

    // volume_outline
    if (foundation.volumeOutline) {
      operations.push({
        type: "foundation",
        id: "foundation:volume_outline",
        content: foundation.volumeOutline,
        metadata: {
          fileName: "volume_outline.md",
          type: "foundation",
          category: "volume_outline",
        },
      });
    }

    // book_rules
    if (foundation.bookRules) {
      operations.push({
        type: "foundation",
        id: "foundation:book_rules",
        content: foundation.bookRules,
        metadata: {
          fileName: "book_rules.md",
          type: "foundation",
          category: "book_rules",
        },
      });
    }

    // current_state
    if (foundation.currentState) {
      operations.push({
        type: "foundation",
        id: "foundation:current_state",
        content: foundation.currentState,
        metadata: {
          fileName: "current_state.md",
          type: "foundation",
          category: "current_state",
        },
      });
    }

    // pending_hooks
    if (foundation.pendingHooks) {
      operations.push({
        type: "foundation",
        id: "foundation:pending_hooks",
        content: foundation.pendingHooks,
        metadata: {
          fileName: "pending_hooks.md",
          type: "foundation",
          category: "pending_hooks",
        },
      });
    }

    // 延迟写入模式
    if (options?.defer || this.isBatchMode) {
      this.pendingOperations.push(...operations);
      logger.info(`Deferred ${operations.length} foundation indexing operations`);
      return;
    }

    // 立即执行
    const documentIds: string[] = [];
    for (const op of operations) {
      const result = await this.executeIndexOperation(op);
      if (result.success) {
        documentIds.push(...result.documentIds);
      }
    }

    // 更新状态
    await this.statusManager.markFoundationIndexed(documentIds);

    return {
      success: true,
      documentIds,
    };
  }

  /**
   * 索引章节内容（支持延迟写入）
   */
  async indexChapter(
    chapter: number,
    content: string,
    metadata?: Record<string, unknown>,
    options?: { defer?: boolean }
  ): Promise<IndexResult | void> {
    const operation: IndexOperation = {
      type: "chapter",
      id: `chapter:${chapter}`,
      content,
      metadata: {
        ...metadata,
        chapter,
        type: "chapter",
      },
    };

    // 延迟写入模式
    if (options?.defer || this.isBatchMode) {
      this.pendingOperations.push(operation);
      logger.info(`Deferred chapter ${chapter} indexing operation`);
      return;
    }

    // 立即执行
    const result = await this.executeIndexOperation(operation);
    
    if (result.success) {
      const contentHash = this.computeHash(content);
      await this.statusManager.updateChapterStatus(
        chapter,
        true,
        result.documentIds,
        contentHash
      );
    }

    return result;
  }

  /**
   * 批量索引所有章节
   */
  async indexAllChapters(
    bookDir: string,
    chapters: number[],
    options?: BatchIndexOptions
  ): Promise<IndexResult[]> {
    const results: IndexResult[] = [];
    const status = await this.statusManager.load();

    // 进入批量模式
    this.beginBatch();

    try {
      for (let i = 0; i < chapters.length; i++) {
        const chapter = chapters[i];
        
        // 检查是否需要跳过
        if (options?.skipExisting) {
          const chapterStatus = status.chapters.find(c => c.chapter === chapter);
          if (chapterStatus?.indexed && !options.forceReindex) {
            logger.info(`Skipping already indexed chapter ${chapter}`);
            options.onProgress?.(i + 1, chapters.length, `跳过已索引章节 ${chapter}`);
            continue;
          }
        }

        options?.onProgress?.(i + 1, chapters.length, `索引章节 ${chapter}`);

        try {
          // 读取章节内容
          const chapterPath = join(bookDir, "chapters", `chapter_${String(chapter).padStart(3, "0")}.md`);
          const content = await readFile(chapterPath, "utf-8");

          // 添加延迟索引操作
          await this.indexChapter(chapter, content, { chapter }, { defer: true });
        } catch (error) {
          logger.warn(`Failed to read chapter ${chapter}: ${error instanceof Error ? error.message : String(error)}`);
          results.push({
            success: false,
            documentIds: [],
            error: `Failed to read chapter ${chapter}`,
          });
        }
      }

      // 提交所有操作
      const commitResults = await this.commit();
      results.push(...commitResults);
    } catch (error) {
      this.rollback();
      throw error;
    }

    return results;
  }

  /**
   * 补充索引缺失的章节
   */
  async supplementMissingChapters(
    bookDir: string,
    existingChapters: number[],
    options?: BatchIndexOptions
  ): Promise<{
    checked: number;
    missing: number;
    indexed: number;
    failed: number;
    results: IndexResult[];
  }> {
    // 检查状态
    const checkResult = await this.statusManager.checkStatus(existingChapters);
    const missingChapters = checkResult.chapters.filter(c => c.status === "missing");
    
    logger.info(`Found ${missingChapters.length} missing chapters out of ${existingChapters.length}`);

    if (missingChapters.length === 0) {
      return {
        checked: existingChapters.length,
        missing: 0,
        indexed: 0,
        failed: 0,
        results: [],
      };
    }

    // 索引缺失的章节
    const chapterNumbers = missingChapters.map(c => c.chapter);
    const results = await this.indexAllChapters(bookDir, chapterNumbers, options);

    const successCount = results.filter(r => r.success).length;
    const failCount = results.filter(r => !r.success).length;

    return {
      checked: existingChapters.length,
      missing: missingChapters.length,
      indexed: successCount,
      failed: failCount,
      results,
    };
  }

  /**
   * 删除章节索引
   */
  async deleteChapterIndex(chapter: number): Promise<void> {
    const status = await this.statusManager.load();
    const chapterStatus = status.chapters.find(c => c.chapter === chapter);
    
    if (chapterStatus?.documentIds.length) {
      // 从向量存储中删除文档
      const vectorStore = (this.ragManager as any).vectorStore;
      if (vectorStore) {
        for (const docId of chapterStatus.documentIds) {
          try {
            await vectorStore.deleteDocument(docId);
          } catch (error) {
            logger.warn(`Failed to delete document ${docId}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
    }

    // 更新状态
    await this.statusManager.markChapterUnindexed(chapter);
    logger.info(`Deleted index for chapter ${chapter}`);
  }

  /**
   * 重建所有索引
   */
  async rebuildAllIndexes(
    bookDir: string,
    foundation: ArchitectOutput,
    chapters: number[],
    options?: BatchIndexOptions
  ): Promise<{
    foundation: IndexResult;
    chapters: IndexResult[];
  }> {
    // 重置状态
    await this.statusManager.reset();
    
    // 清除向量存储
    await this.ragManager.clearIndex();

    // 索引基础设定
    const foundationResult = await this.indexFoundation(foundation);

    // 索引章节
    const chapterResults = await this.indexAllChapters(bookDir, chapters, {
      ...options,
      forceReindex: true,
    });

    return {
      foundation: foundationResult || { success: false, documentIds: [] },
      chapters: chapterResults,
    };
  }

  /**
   * 执行索引操作
   */
  private async executeIndexOperation(operation: IndexOperation): Promise<IndexResult> {
    try {
      const chunks = this.documentProcessor.processDocument(
        operation.content,
        operation.metadata
      );

      const vectorStore = (this.ragManager as any).vectorStore;
      if (!vectorStore) {
        throw new Error("Vector store not available");
      }

      await vectorStore.addChunks(chunks);

      const documentIds = chunks.map((c: { id: string }) => c.id);
      
      logger.info(`Indexed ${operation.type} ${operation.id}: ${documentIds.length} chunks`);

      return {
        success: true,
        documentIds,
      };
    } catch (error) {
      logger.error(`Failed to index ${operation.type} ${operation.id}: ${error instanceof Error ? error.message : String(error)}`);
      return {
        success: false,
        documentIds: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * 计算内容哈希
   */
  private computeHash(content: string): string {
    return createHash("md5").update(content).digest("hex");
  }
}

/**
 * 创建RAG索引器
 */
export function createRAGIndexer(
  ragManager: RAGManager,
  statusManager: RAGStatusManager
): RAGIndexer {
  return new RAGIndexer(ragManager, statusManager);
}
