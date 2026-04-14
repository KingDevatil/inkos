export type VectorModelType =
  | "openai"
  | "huggingface"
  | "local"
  | "lmstudio"
  | "mota"
  | "modelscope"
  | "siliconflow"
  | "zhipu"
  | "dashscope"
  | "custom";

export interface VectorModelConfig {
  readonly type: VectorModelType;
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly model?: string;
  readonly dimensions?: number;
  // Custom embedding model options
  readonly custom?: {
    readonly embeddingEndpoint?: string;
    readonly embeddingMethod?: "POST" | "GET";
    readonly embeddingHeaders?: Record<string, string>;
    readonly embeddingBodyTemplate?: string;
    readonly embeddingResponsePath?: string;
    readonly maxBatchSize?: number;
  };
}

export interface VectorRetrievalConfig {
  readonly enabled: boolean;
  readonly model: VectorModelConfig;
  readonly topK?: number;
  readonly minScore?: number;
  readonly storePath?: string;
}

export interface VectorDocument {
  readonly id: string;
  readonly type: "summary" | "fact" | "hook";
  readonly content: string;
  readonly metadata: Record<string, unknown>;
  readonly chapterNumber?: number;
}

export interface VectorSearchResult {
  readonly id: string;
  readonly type: "summary" | "fact" | "hook";
  readonly content: string;
  readonly metadata: Record<string, unknown>;
  readonly score: number;
  readonly chapterNumber?: number;
}

export interface VectorStore {
  addDocument(doc: VectorDocument): Promise<void>;
  addDocuments(docs: ReadonlyArray<VectorDocument>): Promise<void>;
  search(query: string, limit: number): Promise<ReadonlyArray<VectorSearchResult>>;
  searchByVector(vector: ReadonlyArray<number>, limit: number): Promise<ReadonlyArray<VectorSearchResult>>;
  deleteDocument(id: string): Promise<void>;
  clear(): Promise<void>;
  close(): Promise<void>;
}

export interface EmbeddingClient {
  embed(text: string): Promise<ReadonlyArray<number>>;
  embedBatch(texts: ReadonlyArray<string>): Promise<ReadonlyArray<ReadonlyArray<number>>>;
  isAvailable(): Promise<boolean>;
}
