import type { EmbeddingClient, VectorModelConfig } from "./types.js";

class OpenAIEmbeddingClient implements EmbeddingClient {
  private readonly apiKey: string;
  private readonly model: string;

  constructor(config: VectorModelConfig) {
    this.apiKey = config.apiKey ?? process.env.OPENAI_API_KEY ?? "";
    this.model = config.model ?? "text-embedding-3-small";
  }

  async embed(text: string): Promise<ReadonlyArray<number>> {
    const response = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        input: text,
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenAI embedding API error: ${response.statusText}`);
    }

    const data = await response.json() as { data: Array<{ embedding: ReadonlyArray<number> }> };
    return data.data[0].embedding;
  }

  async embedBatch(texts: ReadonlyArray<string>): Promise<ReadonlyArray<ReadonlyArray<number>>> {
    const response = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        input: texts,
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenAI embedding API error: ${response.statusText}`);
    }

    const data = await response.json() as { data: Array<{ embedding: ReadonlyArray<number> }> };
    return data.data.map((item) => item.embedding);
  }

  async isAvailable(): Promise<boolean> {
    return this.apiKey.length > 0;
  }
}

class HuggingFaceEmbeddingClient implements EmbeddingClient {
  private readonly apiKey: string;
  private readonly model: string;

  constructor(config: VectorModelConfig) {
    this.apiKey = config.apiKey ?? process.env.HUGGINGFACE_API_KEY ?? "";
    this.model = config.model ?? "sentence-transformers/all-MiniLM-L6-v2";
  }

  async embed(text: string): Promise<ReadonlyArray<number>> {
    const response = await fetch(`https://api-inference.huggingface.co/pipeline/feature-extraction/${this.model}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ inputs: text }),
    });

    if (!response.ok) {
      throw new Error(`HuggingFace embedding API error: ${response.statusText}`);
    }

    const embedding = await response.json() as ReadonlyArray<number>;
    return embedding;
  }

  async embedBatch(texts: ReadonlyArray<string>): Promise<ReadonlyArray<ReadonlyArray<number>>> {
    const response = await fetch(`https://api-inference.huggingface.co/pipeline/feature-extraction/${this.model}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ inputs: texts }),
    });

    if (!response.ok) {
      throw new Error(`HuggingFace embedding API error: ${response.statusText}`);
    }

    const embeddings = await response.json() as ReadonlyArray<ReadonlyArray<number>>;
    return embeddings;
  }

  async isAvailable(): Promise<boolean> {
    return this.apiKey.length > 0;
  }
}

class LocalEmbeddingClient implements EmbeddingClient {
  private readonly model: string;
  private readonly baseUrl: string;

  constructor(config: VectorModelConfig) {
    this.model = config.model ?? "BAAI/bge-small-zh-v1.5";
    this.baseUrl = config.baseUrl ?? "http://localhost:11434/api/embeddings";
  }

  async embed(text: string): Promise<ReadonlyArray<number>> {
    const response = await fetch(this.baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        prompt: text,
      }),
    });

    if (!response.ok) {
      throw new Error(`Local embedding API error: ${response.statusText}`);
    }

    const data = await response.json() as { embedding: ReadonlyArray<number> };
    return data.embedding;
  }

  async embedBatch(texts: ReadonlyArray<string>): Promise<ReadonlyArray<ReadonlyArray<number>>> {
    const embeddings = await Promise.all(
      texts.map((text) => this.embed(text))
    );
    return embeddings;
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.embed("test");
      return true;
    } catch {
      return false;
    }
  }
}

class MotaEmbeddingClient implements EmbeddingClient {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;

  constructor(config: VectorModelConfig) {
    this.apiKey = config.apiKey ?? process.env.MOTA_API_KEY ?? "";
    this.model = config.model ?? "m3e-small";
    this.baseUrl = config.baseUrl ?? "https://api.motachinese.com/v1/embeddings";
  }

  async embed(text: string): Promise<ReadonlyArray<number>> {
    const response = await fetch(this.baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        input: text,
      }),
    });

    if (!response.ok) {
      throw new Error(`Mota embedding API error: ${response.statusText}`);
    }

    const data = await response.json() as { data: Array<{ embedding: ReadonlyArray<number> }> };
    return data.data[0].embedding;
  }

  async embedBatch(texts: ReadonlyArray<string>): Promise<ReadonlyArray<ReadonlyArray<number>>> {
    const response = await fetch(this.baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        input: texts,
      }),
    });

    if (!response.ok) {
      throw new Error(`Mota embedding API error: ${response.statusText}`);
    }

    const data = await response.json() as { data: Array<{ embedding: ReadonlyArray<number> }> };
    return data.data.map((item) => item.embedding);
  }

  async isAvailable(): Promise<boolean> {
    return this.apiKey.length > 0;
  }
}

class CustomEmbeddingClient implements EmbeddingClient {
  private readonly config: VectorModelConfig;

  constructor(config: VectorModelConfig) {
    this.config = config;
  }

  async embed(text: string): Promise<ReadonlyArray<number>> {
    const endpoint = this.config.custom?.embeddingEndpoint;
    if (!endpoint) {
      throw new Error("Custom embedding endpoint is not configured");
    }

    const method = this.config.custom?.embeddingMethod ?? "POST";
    const headers = this.config.custom?.embeddingHeaders ?? { "Content-Type": "application/json" };
    const bodyTemplate = this.config.custom?.embeddingBodyTemplate ?? '{"input": "{{text}}"}';
    const responsePath = this.config.custom?.embeddingResponsePath ?? "embedding";

    const body = bodyTemplate.replace("{{text}}", text);

    const response = await fetch(endpoint, {
      method,
      headers,
      body: method === "POST" ? body : undefined,
      ...(method === "GET" ? { params: { text } } : {}),
    });

    if (!response.ok) {
      throw new Error(`Custom embedding API error: ${response.statusText}`);
    }

    const data = await response.json();
    const embedding = this.extractFromResponse(data, responsePath);
    return embedding;
  }

  async embedBatch(texts: ReadonlyArray<string>): Promise<ReadonlyArray<ReadonlyArray<number>>> {
    const maxBatchSize = this.config.custom?.maxBatchSize ?? 1;
    const batches: string[][] = [];

    for (let i = 0; i < texts.length; i += maxBatchSize) {
      batches.push(texts.slice(i, i + maxBatchSize));
    }

    const embeddings: ReadonlyArray<number>[] = [];
    for (const batch of batches) {
      if (batch.length === 1) {
        const embedding = await this.embed(batch[0]);
        embeddings.push(embedding);
      } else {
        const endpoint = this.config.custom?.embeddingEndpoint;
        if (!endpoint) {
          throw new Error("Custom embedding endpoint is not configured");
        }

        const method = this.config.custom?.embeddingMethod ?? "POST";
        const headers = this.config.custom?.embeddingHeaders ?? { "Content-Type": "application/json" };
        const bodyTemplate = this.config.custom?.embeddingBodyTemplate ?? '{"inputs": {{texts}}}';
        const responsePath = this.config.custom?.embeddingResponsePath ?? "embeddings";

        const body = bodyTemplate.replace("{{texts}}", JSON.stringify(batch));

        const response = await fetch(endpoint, {
          method,
          headers,
          body: method === "POST" ? body : undefined,
        });

        if (!response.ok) {
          throw new Error(`Custom embedding API error: ${response.statusText}`);
        }

        const data = await response.json();
        const batchEmbeddings = this.extractFromResponse(data, responsePath);
        if (Array.isArray(batchEmbeddings)) {
          embeddings.push(...batchEmbeddings);
        }
      }
    }

    return embeddings;
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.embed("test");
      return true;
    } catch {
      return false;
    }
  }

  private extractFromResponse(data: any, path: string): ReadonlyArray<number> {
    const parts = path.split(".");
    let value = data;

    for (const part of parts) {
      if (value == null) {
        throw new Error(`Response path not found: ${path}`);
      }
      value = value[part];
    }

    if (!Array.isArray(value)) {
      throw new Error(`Response path does not contain an array: ${path}`);
    }

    return value;
  }
}

export function createEmbeddingClient(config: VectorModelConfig): EmbeddingClient {
  switch (config.type) {
    case "openai":
      return new OpenAIEmbeddingClient(config);
    case "huggingface":
      return new HuggingFaceEmbeddingClient(config);
    case "local":
      return new LocalEmbeddingClient(config);
    case "mota":
      return new MotaEmbeddingClient(config);
    case "custom":
      return new CustomEmbeddingClient(config);
    default:
      throw new Error(`Unsupported embedding model type: ${config.type}`);
  }
}
