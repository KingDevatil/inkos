import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { join } from "node:path";
import type { VectorDocument, VectorSearchResult, VectorStore } from "./types.js";
import type { EmbeddingClient } from "./types.js";

interface IndexedDocument extends VectorDocument {
  readonly vector: ReadonlyArray<number>;
}

export class InMemoryVectorStore implements VectorStore {
  private readonly documents: Map<string, IndexedDocument> = new Map();
  private readonly embeddingClient: EmbeddingClient;
  private readonly savePath?: string;

  constructor(embeddingClient: EmbeddingClient, savePath?: string) {
    this.embeddingClient = embeddingClient;
    this.savePath = savePath;
  }

  static async load(
    embeddingClient: EmbeddingClient,
    savePath: string,
  ): Promise<InMemoryVectorStore> {
    const store = new InMemoryVectorStore(embeddingClient, savePath);
    try {
      await access(savePath);
      const data = JSON.parse(await readFile(savePath, "utf-8")) as {
        documents: Array<{
          id: string;
          type: "summary" | "fact" | "hook";
          content: string;
          metadata: Record<string, unknown>;
          chapterNumber?: number;
          vector: number[];
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
        });
      }
    } catch {
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
      })),
    };
    await writeFile(this.savePath, JSON.stringify(data, null, 2), "utf-8");
  }

  async addDocument(doc: VectorDocument): Promise<void> {
    const vector = await this.embeddingClient.embed(doc.content);
    this.documents.set(doc.id, { ...doc, vector });
    await this.save();
  }

  async addDocuments(docs: ReadonlyArray<VectorDocument>): Promise<void> {
    const vectors = await this.embeddingClient.embedBatch(docs.map((d) => d.content));
    for (let i = 0; i < docs.length; i++) {
      this.documents.set(docs[i].id, { ...docs[i], vector: vectors[i] });
    }
    await this.save();
  }

  async search(query: string, limit: number): Promise<ReadonlyArray<VectorSearchResult>> {
    const queryVector = await this.embeddingClient.embed(query);
    return this.searchByVector(queryVector, limit);
  }

  async searchByVector(
    queryVector: ReadonlyArray<number>,
    limit: number,
  ): Promise<ReadonlyArray<VectorSearchResult>> {
    const results: Array<{ doc: IndexedDocument; score: number }> = [];

    for (const doc of this.documents.values()) {
      const score = this.cosineSimilarity(queryVector, doc.vector);
      results.push({ doc, score });
    }

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
    this.documents.delete(id);
    await this.save();
  }

  async clear(): Promise<void> {
    this.documents.clear();
    await this.save();
  }

  async close(): Promise<void> {
    await this.save();
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
