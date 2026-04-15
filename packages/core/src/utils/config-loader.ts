import { readFile, access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { ProjectConfigSchema, type ProjectConfig } from "../models/project.js";

export const GLOBAL_CONFIG_DIR = join(homedir(), ".inkos");
export const GLOBAL_ENV_PATH = join(GLOBAL_CONFIG_DIR, ".env");

export function isApiKeyOptionalForEndpoint(params: {
  readonly provider?: string | undefined;
  readonly baseUrl?: string | undefined;
}): boolean {
  if (params.provider === "anthropic") {
    return false;
  }
  if (!params.baseUrl) {
    return false;
  }

  try {
    const url = new URL(params.baseUrl);
    const hostname = url.hostname.toLowerCase();

    return (
      hostname === "localhost"
      || hostname === "127.0.0.1"
      || hostname === "::1"
      || hostname === "0.0.0.0"
      || hostname === "host.docker.internal"
      || hostname.endsWith(".local")
      || isPrivateIpv4(hostname)
    );
  } catch {
    return false;
  }
}

/**
 * Load project config from inkos.json with .env overrides.
 * Shared by CLI and Studio — single source of truth for config loading.
 */
export async function loadProjectConfig(
  root: string,
  options?: { readonly requireApiKey?: boolean },
): Promise<ProjectConfig> {
  // Load global ~/.inkos/.env first, then project .env overrides
  const { config: loadEnv } = await import("dotenv");
  loadEnv({ path: GLOBAL_ENV_PATH });
  loadEnv({ path: join(root, ".env"), override: true });

  const configPath = join(root, "inkos.json");

  try {
    await access(configPath);
  } catch {
    throw new Error(
      `inkos.json not found in ${root}.\nMake sure you are inside an InkOS project directory (cd into the project created by 'inkos init').`,
    );
  }

  const raw = await readFile(configPath, "utf-8");

  let config: Record<string, unknown>;
  try {
    config = JSON.parse(raw);
  } catch {
    throw new Error(`inkos.json in ${root} is not valid JSON. Check the file for syntax errors.`);
  }

  // .env overrides inkos.json for LLM settings
  const env = process.env;
  const llm = (config.llm ?? {}) as Record<string, unknown>;
  if (env.INKOS_LLM_PROVIDER) llm.provider = env.INKOS_LLM_PROVIDER;
  if (env.INKOS_LLM_BASE_URL) llm.baseUrl = env.INKOS_LLM_BASE_URL;
  if (env.INKOS_LLM_MODEL) llm.model = env.INKOS_LLM_MODEL;
  if (env.INKOS_LLM_TEMPERATURE) llm.temperature = parseFloat(env.INKOS_LLM_TEMPERATURE);
  if (env.INKOS_LLM_MAX_TOKENS) llm.maxTokens = parseInt(env.INKOS_LLM_MAX_TOKENS, 10);
  if (env.INKOS_LLM_THINKING_BUDGET) llm.thinkingBudget = parseInt(env.INKOS_LLM_THINKING_BUDGET, 10);
  // Extra params from env: INKOS_LLM_EXTRA_<key>=<value>
  const extraFromEnv: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith("INKOS_LLM_EXTRA_") && value) {
      const paramName = key.slice("INKOS_LLM_EXTRA_".length);
      // Auto-coerce: numbers, booleans, JSON objects
      if (/^\d+(\.\d+)?$/.test(value)) extraFromEnv[paramName] = parseFloat(value);
      else if (value === "true") extraFromEnv[paramName] = true;
      else if (value === "false") extraFromEnv[paramName] = false;
      else if (value.startsWith("{") || value.startsWith("[")) {
        try { extraFromEnv[paramName] = JSON.parse(value); } catch { extraFromEnv[paramName] = value; }
      }
      else extraFromEnv[paramName] = value;
    }
  }
  if (Object.keys(extraFromEnv).length > 0) {
    llm.extra = { ...(llm.extra as Record<string, unknown> ?? {}), ...extraFromEnv };
  }
  if (env.INKOS_LLM_API_FORMAT) llm.apiFormat = env.INKOS_LLM_API_FORMAT;
  config.llm = llm;

  // Global language override
  if (env.INKOS_DEFAULT_LANGUAGE) config.language = env.INKOS_DEFAULT_LANGUAGE;

  // Vector Retrieval (RAG) config from env
  const vectorRetrieval = (config.vectorRetrieval ?? {}) as Record<string, unknown>;
  if (env.RAG_ENABLED === "true") {
    vectorRetrieval.enabled = true;
    if (env.RAG_MODEL_TYPE) vectorRetrieval.modelType = env.RAG_MODEL_TYPE;
    if (env.RAG_MODEL_NAME) vectorRetrieval.modelName = env.RAG_MODEL_NAME;
    if (env.RAG_BASE_URL) vectorRetrieval.baseUrl = env.RAG_BASE_URL;
    if (env.RAG_TOP_K) vectorRetrieval.topK = parseInt(env.RAG_TOP_K, 10);
    if (env.RAG_MIN_SCORE) vectorRetrieval.minScore = parseFloat(env.RAG_MIN_SCORE);
    if (env.RAG_STORE_PATH) vectorRetrieval.storePath = env.RAG_STORE_PATH;
    // API keys for different providers
    if (env.OPENAI_API_KEY) vectorRetrieval.openaiApiKey = env.OPENAI_API_KEY;
    if (env.SILICONFLOW_API_KEY) vectorRetrieval.siliconflowApiKey = env.SILICONFLOW_API_KEY;
    if (env.MOTA_API_KEY) vectorRetrieval.motaApiKey = env.MOTA_API_KEY;
    if (env.MODELSCOPE_API_KEY) vectorRetrieval.modelscopeApiKey = env.MODELSCOPE_API_KEY;
    if (env.ZHIPU_API_KEY) vectorRetrieval.zhipuApiKey = env.ZHIPU_API_KEY;
    if (env.DASHSCOPE_API_KEY) vectorRetrieval.dashscopeApiKey = env.DASHSCOPE_API_KEY;
    config.vectorRetrieval = vectorRetrieval;
  }

  // API key ONLY from env — never stored in inkos.json
  const apiKey = env.INKOS_LLM_API_KEY;
  const provider = typeof llm.provider === "string" ? llm.provider : undefined;
  const baseUrl = typeof llm.baseUrl === "string" ? llm.baseUrl : undefined;
  const apiKeyOptional = isApiKeyOptionalForEndpoint({ provider, baseUrl });

  if (!apiKey && options?.requireApiKey !== false && !apiKeyOptional) {
    throw new Error(
      "INKOS_LLM_API_KEY not set. Run 'inkos config set-global' or add it to project .env file.",
    );
  }
  if (options?.requireApiKey === false) {
    // Use env values if available, otherwise use config values
    llm.provider = process.env.INKOS_LLM_PROVIDER || (typeof llm.provider === "string" && llm.provider.length > 0
      ? llm.provider
      : "openai");
    llm.baseUrl = process.env.INKOS_LLM_BASE_URL || (typeof llm.baseUrl === "string" && llm.baseUrl.length > 0
      ? llm.baseUrl
      : "https://api.openai.com/v1");
    llm.model = process.env.INKOS_LLM_MODEL || (typeof llm.model === "string" && llm.model.length > 0
      ? llm.model
      : "gpt-3.5-turbo");
    // Use env API key if available
    llm.apiKey = process.env.INKOS_LLM_API_KEY ?? "";
  } else {
    llm.apiKey = apiKey ?? "";
  }

  return ProjectConfigSchema.parse(config);
}

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split(".").map((segment) => Number.parseInt(segment, 10));
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part) || part < 0 || part > 255)) {
    return false;
  }

  if (parts[0] === 10) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  return false;
}
