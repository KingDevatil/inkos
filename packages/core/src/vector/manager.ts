import { createLogger, nullSink } from "../utils/logger.js";
import type { VectorRetrievalConfig, VectorDocument, VectorSearchResult } from "./types.js";
import { createEmbeddingClient } from "./embedding-client.js";
import { InMemoryVectorStore } from "./vector-store.js";

const logger = createLogger({ tag: "vector-retrieval-manager", sinks: [nullSink] });

export class VectorRetrievalManager {
  private readonly config: VectorRetrievalConfig;
  private store: InMemoryVectorStore | null = null;
  private available: boolean = false;

  constructor(config: VectorRetrievalConfig) {
    this.config = config;
  }

  async initialize(): Promise<void> {
    if (!this.config.enabled) {
      logger.info("Vector retrieval is disabled");
      this.available = false;
      return;
    }

    try {
      const embeddingClient = createEmbeddingClient(this.config.model);
      const isClientAvailable = await embeddingClient.isAvailable();
      if (!isClientAvailable) {
        logger.warn("Embedding client is not available, vector retrieval will be disabled");
        this.available = false;
        return;
      }

      const storePath = this.config.storePath || "./vector-index.json";
      this.store = await InMemoryVectorStore.load(embeddingClient, storePath);
      this.available = true;
      logger.info("Vector retrieval manager initialized successfully");
    } catch (error) {
      logger.warn(`Failed to initialize vector retrieval manager: ${error instanceof Error ? error.message : String(error)}`);
      this.available = false;
    }
  }

  isAvailable(): boolean {
    return this.available && this.store !== null;
  }

  async addDocument(doc: VectorDocument): Promise<void> {
    if (!this.isAvailable()) {
      return;
    }
    await this.store!.addDocument(doc);
  }

  async addDocuments(docs: ReadonlyArray<VectorDocument>): Promise<void> {
    if (!this.isAvailable()) {
      return;
    }
    await this.store!.addDocuments(docs);
  }

  async search(query: string, limit: number = 10): Promise<ReadonlyArray<VectorSearchResult>> {
    if (!this.isAvailable()) {
      return [];
    }
    return this.store!.search(query, limit);
  }

  async clear(): Promise<void> {
    if (!this.isAvailable()) {
      return;
    }
    await this.store!.clear();
  }

  async close(): Promise<void> {
    if (this.store) {
      await this.store.close();
    }
  }
}

export function createVectorRetrievalManager(config: VectorRetrievalConfig): VectorRetrievalManager {
  return new VectorRetrievalManager(config);
}
