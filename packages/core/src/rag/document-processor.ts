export interface DocumentChunk {
  readonly id: string;
  readonly content: string;
  readonly metadata: Record<string, unknown>;
  readonly level: "chapter" | "paragraph" | "sentence";
  readonly qualityScore: number;
  readonly relevanceScore: number;
}

export interface DocumentProcessorOptions {
  readonly maxChunkSize?: number;
  readonly minChunkSize?: number;
  readonly chunkOverlap?: number;
  readonly qualityThreshold?: number;
  readonly enableQualityFilter?: boolean;
  readonly enableMetadataExtraction?: boolean;
}

export class DocumentProcessor {
  private readonly maxChunkSize: number;
  private readonly minChunkSize: number;
  private readonly chunkOverlap: number;
  private readonly qualityThreshold: number;
  private readonly enableQualityFilter: boolean;
  private readonly enableMetadataExtraction: boolean;

  constructor(options: DocumentProcessorOptions = {}) {
    this.maxChunkSize = options.maxChunkSize ?? 500;
    this.minChunkSize = options.minChunkSize ?? 50;
    this.chunkOverlap = options.chunkOverlap ?? 50;
    this.qualityThreshold = options.qualityThreshold ?? 0.3;
    this.enableQualityFilter = options.enableQualityFilter ?? true;
    this.enableMetadataExtraction = options.enableMetadataExtraction ?? true;
  }

  processDocument(content: string, metadata: Record<string, unknown>): DocumentChunk[] {
    const chunks: DocumentChunk[] = [];
    
    // 按段落分割
    const paragraphs = content.split(/\n\s*\n/).filter(p => p.trim().length > 0);
    
    for (let i = 0; i < paragraphs.length; i++) {
      const paragraph = paragraphs[i].trim();
      
      if (paragraph.length <= this.maxChunkSize) {
        // 段落长度合适，直接作为一个块
        const chunk = this.createChunk(paragraph, metadata, "paragraph", i);
        if (!this.enableQualityFilter || chunk.qualityScore >= this.qualityThreshold) {
          chunks.push(chunk);
        }
      } else {
        // 段落过长，进一步分割
        const sentenceChunks = this.splitIntoSentences(paragraph);
        const mergedChunks = this.mergeSentences(sentenceChunks);
        
        for (let j = 0; j < mergedChunks.length; j++) {
          const chunk = this.createChunk(mergedChunks[j], metadata, "sentence", i * 100 + j);
          if (!this.enableQualityFilter || chunk.qualityScore >= this.qualityThreshold) {
            chunks.push(chunk);
          }
        }
      }
    }
    
    return chunks;
  }

  private splitIntoSentences(text: string): string[] {
    // 简单的句子分割
    return text.split(/[。！？.!?]/).filter(s => s.trim().length > 0);
  }

  private mergeSentences(sentences: string[]): string[] {
    const merged: string[] = [];
    let current = "";
    
    for (const sentence of sentences) {
      const sentenceWithPunctuation = sentence.trim() + "。";
      
      if (current.length + sentenceWithPunctuation.length <= this.maxChunkSize) {
        current += sentenceWithPunctuation;
      } else {
        if (current.length >= this.minChunkSize) {
          merged.push(current);
        }
        current = sentenceWithPunctuation;
      }
    }
    
    if (current.length >= this.minChunkSize) {
      merged.push(current);
    }
    
    return merged;
  }

  private createChunk(content: string, metadata: Record<string, unknown>, level: "chapter" | "paragraph" | "sentence", index: number): DocumentChunk {
    const id = `chunk-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 10)}`;
    const qualityScore = this.calculateQualityScore(content);
    const relevanceScore = this.calculateRelevanceScore(content, metadata);
    
    return {
      id,
      content,
      metadata: this.enableMetadataExtraction ? this.extractMetadata(content, metadata) : metadata,
      level,
      qualityScore,
      relevanceScore,
    };
  }

  private calculateQualityScore(content: string): number {
    // 简单的质量评分算法
    const lengthScore = Math.min(content.length / this.maxChunkSize, 1);
    const punctuationScore = (content.match(/[。！？.!?]/g)?.length || 0) / (content.length / 50);
    const complexityScore = (content.match(/[,，;；:：]/g)?.length || 0) / (content.length / 30);
    
    return Math.min((lengthScore + punctuationScore + complexityScore) / 3, 1);
  }

  private calculateRelevanceScore(content: string, metadata: Record<string, unknown>): number {
    // 简单的相关性评分
    const hasKeywords = content.includes(metadata.title as string || "") || 
                      content.includes(metadata.chapterTitle as string || "");
    return hasKeywords ? 1 : 0.5;
  }

  private extractMetadata(content: string, baseMetadata: Record<string, unknown>): Record<string, unknown> {
    // 从内容中提取额外的元数据
    const metadata = { ...baseMetadata };
    
    // 提取标题
    const titleMatch = content.match(/^#\s+(.*)$/m);
    if (titleMatch) {
      metadata.extractedTitle = titleMatch[1];
    }
    
    // 提取人物名（简单实现）
    const characterMatch = content.match(/[\u4e00-\u9fa5]{2,4}/g);
    if (characterMatch) {
      metadata.characters = [...new Set(characterMatch)];
    }
    
    return metadata;
  }
}

export function createDocumentProcessor(options: DocumentProcessorOptions = {}): DocumentProcessor {
  return new DocumentProcessor(options);
}
