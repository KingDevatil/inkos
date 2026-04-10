import { join } from "node:path";
import type { VectorRetrievalConfig } from "../vector/types.js";
import { createEmbeddingClient } from "../vector/embedding-client.js";
import { createEnhancedVectorStore, EnhancedVectorStore } from "./enhanced-vector-store.js";
import { createDocumentProcessor } from "./document-processor.js";
import type { DocumentChunk } from "./document-processor.js";
import { createLogger, nullSink } from "../utils/logger.js";
import type { MemorySelection } from "../utils/memory-retrieval.js";
import type { LLMClient, LLMMessage, LLMResponse } from "../llm/provider.js";
import { chatCompletion } from "../llm/provider.js";

const logger = createLogger({ tag: "rag-manager", sinks: [nullSink] });

export interface RAGManagerOptions {
  readonly bookDir: string;
  readonly config: VectorRetrievalConfig;
  readonly llmClient?: LLMClient;
  readonly modelName?: string;
}

export interface RAGContext {
  readonly query: string;
  readonly retrievedContent: ReadonlyArray<{
    id: string;
    content: string;
    score: number;
    metadata: Record<string, unknown>;
  }>;
  readonly contextWindow: string;
}

export interface RAGResponse {
  readonly response: string;
  readonly context: RAGContext;
  readonly tokenUsage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export class RAGManager {
  private readonly bookDir: string;
  private readonly config: VectorRetrievalConfig;
  private readonly llmClient?: LLMClient;
  private readonly modelName: string;
  private embeddingClient: ReturnType<typeof createEmbeddingClient> | null = null;
  private vectorStore: ReturnType<typeof createEnhancedVectorStore> | null = null;
  private documentProcessor: ReturnType<typeof createDocumentProcessor> | null = null;
  private available: boolean = false;
  private initialized: boolean = false;

  constructor(options: RAGManagerOptions) {
    this.bookDir = options.bookDir;
    this.config = options.config;
    this.llmClient = options.llmClient;
    this.modelName = options.modelName || "gpt-4";
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    if (!this.config.enabled) {
      logger.info("RAG system is disabled");
      this.available = false;
      return;
    }

    try {
      // 1. 初始化嵌入客户端
      this.embeddingClient = createEmbeddingClient(this.config.model);
      
      const isClientAvailable = await this.embeddingClient.isAvailable();
      if (!isClientAvailable) {
        logger.warn("Embedding client is not available, falling back to original retrieval");
        this.available = false;
        return;
      }

      // 2. 初始化向量存储
      const storePath = this.config.storePath
        ? this.config.storePath
        : join(this.bookDir, "story", "rag-vector-index.json");

      this.vectorStore = await EnhancedVectorStore.load({
        embeddingClient: this.embeddingClient,
        savePath: storePath,
        enableHierarchicalIndex: true,
        enableMetadataSearch: true,
      });

      // 3. 初始化文档处理器
      this.documentProcessor = createDocumentProcessor({
        maxChunkSize: 500,
        minChunkSize: 50,
        chunkOverlap: 50,
        qualityThreshold: 0.3,
        enableQualityFilter: true,
        enableMetadataExtraction: true,
      });

      this.available = true;
      logger.info("RAG manager initialized successfully");
    } catch (error) {
      logger.warn(`Failed to initialize RAG manager: ${error instanceof Error ? error.message : String(error)}`);
      this.available = false;
    }
  }

  isAvailable(): boolean {
    return this.available && this.config.enabled;
  }

  async indexMemory(memorySelection: MemorySelection): Promise<void> {
    if (!this.isAvailable()) return;

    // 1. 处理章节摘要
    for (const summary of memorySelection.summaries) {
      const chunks = this.documentProcessor?.processDocument(
        `${summary.title}\n${summary.characters}\n${summary.events}`,
        {
          chapterNumber: summary.chapter,
          chapterTitle: summary.title,
          type: "summary",
        }
      ) || [];
      
      await this.vectorStore?.addChunks(chunks);
    }

    // 2. 处理事实
    for (const fact of memorySelection.facts) {
      const chunks = this.documentProcessor?.processDocument(
        `${fact.subject} ${fact.predicate} ${fact.object}`,
        {
          subject: fact.subject,
          predicate: fact.predicate,
          type: "fact",
        }
      ) || [];
      
      await this.vectorStore?.addChunks(chunks);
    }

    // 3. 处理伏笔
    for (const hook of memorySelection.activeHooks) {
      const chunks = this.documentProcessor?.processDocument(
        `${hook.type}: ${hook.expectedPayoff}`,
        {
          hookId: hook.hookId,
          type: "hook",
          status: hook.status,
        }
      ) || [];
      
      await this.vectorStore?.addChunks(chunks);
    }
  }

  async retrieveRelevantContent(
    query: string,
    options?: {
      limit?: number;
      chapterNumber?: number;
      minScore?: number;
    }
  ): Promise<ReadonlyArray<{
    id: string;
    content: string;
    score: number;
    metadata: Record<string, unknown>;
  }>> {
    if (!this.isAvailable()) {
      return [];
    }

    const searchLimit = options?.limit ?? this.config.topK ?? 10;
    const minScore = options?.minScore ?? this.config.minScore ?? 0.5;

    const results = await this.vectorStore?.search(query, searchLimit, {
      chapterNumber: options?.chapterNumber,
      minQualityScore: 0.3,
    }) || [];
    
    return results.filter((r) => r.score >= minScore).map((r) => ({
      id: r.id,
      content: r.content,
      score: r.score,
      metadata: r.metadata,
    }));
  }

  async generateWithRAG(
    query: string,
    systemPrompt: string,
    options?: {
      limit?: number;
      chapterNumber?: number;
      temperature?: number;
    }
  ): Promise<RAGResponse> {
    if (!this.isAvailable() || !this.llmClient) {
      throw new Error("RAG system is not available");
    }

    // 1. 检索相关内容
    const relevantContent = await this.retrieveRelevantContent(query, {
      limit: options?.limit ?? 5,
      chapterNumber: options?.chapterNumber,
    });

    // 2. 构建上下文
    const contextWindow = relevantContent
      .map((item, index) => `[参考${index + 1}] ${item.content}`)
      .join("\n\n");

    // 3. 构建提示
    const prompt = `# 上下文信息

${contextWindow}

# 用户查询

${query}`;

    // 4. 调用LLM
    const messages: LLMMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: prompt },
    ];

    const response = await chatCompletion(
      this.llmClient!,
      this.modelName,
      messages,
      {
        temperature: options?.temperature ?? 0.7,
        maxTokens: 1000,
      }
    );

    return {
      response: response.content,
      context: {
        query,
        retrievedContent: relevantContent,
        contextWindow,
      },
      tokenUsage: response.usage,
    };
  }

  async clearIndex(): Promise<void> {
    if (!this.isAvailable()) return;
    await this.vectorStore?.clear();
  }

  async close(): Promise<void> {
    await this.vectorStore?.close();
  }
}

export async function createRAGManager(options: RAGManagerOptions): Promise<RAGManager> {
  const manager = new RAGManager(options);
  await manager.initialize();
  return manager;
}
