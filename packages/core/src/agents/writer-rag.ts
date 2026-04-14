/**
 * RAG-enhanced Writer Agent
 * 
 * Extends the base WriterAgent with RAG (Retrieval-Augmented Generation) capabilities.
 * Retrieves relevant context from the vector store before writing.
 */

import { WriterAgent, type WriteChapterInput, type WriteChapterOutput } from "./writer.js";
import type { RAGManager } from "../rag/rag-manager.js";
import type { AgentContext } from "./base.js";
import { createLogger, nullSink } from "../utils/logger.js";

const logger = createLogger({ tag: "writer-rag", sinks: [nullSink] });

export interface RAGWriterOptions {
  readonly ctx: AgentContext;
  readonly ragManager: RAGManager;
  readonly retrievalLimit?: number;
  readonly minScore?: number;
}

export class RAGWriterAgent extends WriterAgent {
  private readonly ragManager: RAGManager;
  private readonly retrievalLimit: number;
  private readonly minScore: number;

  constructor(options: RAGWriterOptions) {
    super(options.ctx);
    this.ragManager = options.ragManager;
    this.retrievalLimit = options.retrievalLimit ?? 5;
    this.minScore = options.minScore ?? 0.5;
  }

  get name(): string {
    return "writer-rag";
  }

  /**
   * Retrieve relevant context from RAG for the chapter being written
   */
  private async retrieveRAGContext(
    chapterNumber: number,
    chapterTitle?: string,
  ): Promise<string> {
    if (!this.ragManager.isAvailable()) {
      logger.debug("RAG not available, skipping retrieval");
      return "";
    }

    try {
      // Build query based on chapter number and title
      const query = chapterTitle
        ? `第${chapterNumber}章 ${chapterTitle} 相关内容`
        : `第${chapterNumber}章 剧情发展 人物关系`;

      logger.info(`Retrieving RAG context for: ${query}`);

      const results = await this.ragManager.retrieveRelevantContent(query, {
        limit: this.retrievalLimit,
        chapterNumber,
        minScore: this.minScore,
      });

      if (results.length === 0) {
        logger.debug("No relevant content found in RAG");
        return "";
      }

      // Format retrieved content
      const contextParts = results.map((item, index) => {
        const metadata = item.metadata;
        const source = metadata?.fileName || metadata?.type || "未知来源";
        return `[RAG参考${index + 1}] 来源: ${source}\n${item.content}`;
      });

      const context = contextParts.join("\n\n---\n\n");
      logger.info(`Retrieved ${results.length} relevant documents from RAG`);

      return context;
    } catch (error) {
      logger.warn(`Failed to retrieve RAG context: ${error instanceof Error ? error.message : String(error)}`);
      return "";
    }
  }

  /**
   * Override writeChapter to include RAG context
   */
  async writeChapter(input: WriteChapterInput): Promise<WriteChapterOutput> {
    const { chapterNumber } = input;

    // Retrieve RAG context before writing
    const ragContext = await this.retrieveRAGContext(chapterNumber, input.chapterIntent);

    if (ragContext) {
      logger.info(`Adding RAG context to chapter ${chapterNumber}`);
      
      // Enhance the input with RAG context
      const enhancedInput = {
        ...input,
        externalContext: input.externalContext
          ? `${input.externalContext}\n\n## RAG检索到的相关内容\n\n${ragContext}`
          : `## RAG检索到的相关内容\n\n${ragContext}`,
      };

      return super.writeChapter(enhancedInput);
    }

    // If no RAG context, use original method
    return super.writeChapter(input);
  }
}
