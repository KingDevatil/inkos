import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { join } from "node:path";
import type { VectorDocument, VectorSearchResult } from "../vector/types.js";
import type { EmbeddingClient } from "../vector/types.js";
import type { DocumentChunk } from "./document-processor.js";

export interface EnhancedVectorStoreOptions {
  readonly embeddingClient: EmbeddingClient;
  readonly savePath?: string;
  readonly enableHierarchicalIndex?: boolean;
  readonly enableMetadataSearch?: boolean;
}

interface IndexedDocument extends VectorDocument {
  readonly vector: ReadonlyArray<number>;
  readonly chunkLevel?: "chapter" | "paragraph" | "sentence";
  readonly qualityScore?: number;
  readonly relevanceScore?: number;
}

export class EnhancedVectorStore {
  private readonly documents: Map<string, IndexedDocument> = new Map();
  private readonly embeddingClient: EmbeddingClient;
  private readonly savePath?: string;
  private readonly enableHierarchicalIndex: boolean;
  private readonly enableMetadataSearch: boolean;
  private hierarchicalIndex: {
    chapter: Map<number, Set<string>>;
    paragraph: Map<string, Set<string>>;
  } = {
    chapter: new Map(),
    paragraph: new Map(),
  };

  constructor(options: EnhancedVectorStoreOptions) {
    this.embeddingClient = options.embeddingClient;
    this.savePath = options.savePath;
    this.enableHierarchicalIndex = options.enableHierarchicalIndex ?? true;
    this.enableMetadataSearch = options.enableMetadataSearch ?? true;
  }

  static async load(
    options: EnhancedVectorStoreOptions
  ): Promise<EnhancedVectorStore> {
    const store = new EnhancedVectorStore(options);
    
    if (options.savePath) {
      try {
        await access(options.savePath);
        const data = JSON.parse(await readFile(options.savePath, "utf-8")) as {
          documents: Array<{
            id: string;
            type: "summary" | "fact" | "hook";
            content: string;
            metadata: Record<string, unknown>;
            chapterNumber?: number;
            vector: number[];
            chunkLevel?: "chapter" | "paragraph" | "sentence";
            qualityScore?: number;
            relevanceScore?: number;
          }>;
        };
        
        for (const doc of data.documents) {
          store.documents.set(doc.id, {
            id: doc.id,
            type: doc.type,
            content: doc.content,
            metadata: doc.metadata,
            chapterNumber: doc.chapterNumber,
            vector: doc.vector,
            chunkLevel: doc.chunkLevel,
            qualityScore: doc.qualityScore,
            relevanceScore: doc.relevanceScore,
          });
          
          // Rebuild hierarchical index
          if (store.enableHierarchicalIndex) {
            store.buildHierarchicalIndex(doc);
          }
        }
      } catch {
        // File doesn't exist, start fresh
      }
    }
    
    return store;
  }

  async save(): Promise<void> {
    if (!this.savePath) return;
    
    const dir = this.savePath.split("/").slice(0, -1).join("/");
    if (dir) {
      try {
        await mkdir(dir, { recursive: true });
      } catch {
        // Directory already exists
      }
    }
    
    const data = {
      documents: Array.from(this.documents.values()).map((doc) => ({
        id: doc.id,
        type: doc.type,
        content: doc.content,
        metadata: doc.metadata,
        chapterNumber: doc.chapterNumber,
        vector: doc.vector,
        chunkLevel: doc.chunkLevel,
        qualityScore: doc.qualityScore,
        relevanceScore: doc.relevanceScore,
      })),
    };
    
    await writeFile(this.savePath, JSON.stringify(data, null, 2), "utf-8");
  }

  async addDocument(doc: VectorDocument): Promise<void> {
    const vector = await this.embeddingClient.embed(doc.content);
    const indexedDoc: IndexedDocument = { ...doc, vector };
    
    this.documents.set(doc.id, indexedDoc);
    
    if (this.enableHierarchicalIndex) {
      this.buildHierarchicalIndex(indexedDoc);
    }
    
    await this.save();
  }

  async addChunks(chunks: DocumentChunk[]): Promise<void> {
    const contents = chunks.map((chunk) => chunk.content);
    const vectors = await this.embeddingClient.embedBatch(contents);
    
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const vector = vectors[i];
      
      const doc: IndexedDocument = {
        id: chunk.id,
        type: "summary",
        content: chunk.content,
        metadata: chunk.metadata,
        chapterNumber: chunk.metadata.chapterNumber as number,
        vector,
        chunkLevel: chunk.level,
        qualityScore: chunk.qualityScore,
        relevanceScore: chunk.relevanceScore,
      };
      
      this.documents.set(doc.id, doc);
      
      if (this.enableHierarchicalIndex) {
        this.buildHierarchicalIndex(doc);
      }
    }
    
    await this.save();
  }

  async addDocuments(docs: ReadonlyArray<VectorDocument>): Promise<void> {
    const contents = docs.map((doc) => doc.content);
    const vectors = await this.embeddingClient.embedBatch(contents);
    
    for (let i = 0; i < docs.length; i++) {
      const doc = docs[i];
      const vector = vectors[i];
      
      const indexedDoc: IndexedDocument = { ...doc, vector };
      this.documents.set(doc.id, indexedDoc);
      
      if (this.enableHierarchicalIndex) {
        this.buildHierarchicalIndex(indexedDoc);
      }
    }
    
    await this.save();
  }

  async search(
    query: string, 
    limit: number, 
    options?: {
      chapterNumber?: number;
      chunkLevel?: "chapter" | "paragraph" | "sentence";
      minQualityScore?: number;
    }
  ): Promise<ReadonlyArray<VectorSearchResult>> {
    const queryVector = await this.embeddingClient.embed(query);
    return this.searchByVector(queryVector, limit, options);
  }

  async searchByVector(
    queryVector: ReadonlyArray<number>,
    limit: number,
    options?: {
      chapterNumber?: number;
      chunkLevel?: "chapter" | "paragraph" | "sentence";
      minQualityScore?: number;
    }
  ): Promise<ReadonlyArray<VectorSearchResult>> {
    const results: Array<{ doc: IndexedDocument; score: number }> = [];
    
    // 过滤文档
    const filteredDocs = Array.from(this.documents.values()).filter((doc) => {
      if (options?.chapterNumber && doc.chapterNumber !== options.chapterNumber) {
        return false;
      }
      
      if (options?.chunkLevel && doc.chunkLevel !== options.chunkLevel) {
        return false;
      }
      
      if (options?.minQualityScore && doc.qualityScore && doc.qualityScore < options.minQualityScore) {
        return false;
      }
      
      return true;
    });
    
    // 计算相似度
    for (const doc of filteredDocs) {
      const score = this.cosineSimilarity(queryVector, doc.vector);
      results.push({ doc, score });
    }
    
    // 排序并返回结果
    results.sort((a, b) => b.score - a.score);
    
    return results.slice(0, limit).map(({ doc, score }) => ({
      id: doc.id,
      type: doc.type,
      content: doc.content,
      metadata: doc.metadata,
      score,
      chapterNumber: doc.chapterNumber,
    }));
  }

  async deleteDocument(id: string): Promise<void> {
    const doc = this.documents.get(id);
    if (doc && this.enableHierarchicalIndex) {
      this.removeFromHierarchicalIndex(doc);
    }
    this.documents.delete(id);
    await this.save();
  }

  async clear(): Promise<void> {
    this.documents.clear();
    this.hierarchicalIndex = {
      chapter: new Map(),
      paragraph: new Map(),
    };
    await this.save();
  }

  async close(): Promise<void> {
    await this.save();
  }

  private buildHierarchicalIndex(doc: IndexedDocument): void {
    if (doc.chapterNumber) {
      if (!this.hierarchicalIndex.chapter.has(doc.chapterNumber)) {
        this.hierarchicalIndex.chapter.set(doc.chapterNumber, new Set());
      }
      this.hierarchicalIndex.chapter.get(doc.chapterNumber)?.add(doc.id);
    }
  }

  private removeFromHierarchicalIndex(doc: IndexedDocument): void {
    if (doc.chapterNumber) {
      this.hierarchicalIndex.chapter.get(doc.chapterNumber)?.delete(doc.id);
    }
  }

  private cosineSimilarity(a: ReadonlyArray<number>, b: ReadonlyArray<number>): number {
    if (a.length !== b.length) {
      throw new Error("Vectors must have the same length");
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    if (normA === 0 || normB === 0) {
      return 0;
    }

    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }
}

export function createEnhancedVectorStore(options: EnhancedVectorStoreOptions): EnhancedVectorStore {
  return new EnhancedVectorStore(options);
}
