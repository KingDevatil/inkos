import { useApi, fetchJson } from "../hooks/use-api";
import type { Theme } from "../hooks/use-theme";
import type { TFunction } from "../hooks/use-i18n";
import { useColors } from "../hooks/use-colors";
import { Stethoscope, CheckCircle2, XCircle, Loader2, Database, HelpCircle, X, Power } from "lucide-react";
import { useState } from "react";
import { createPortal } from "react-dom";

interface RAGStatus {
  readonly enabled: boolean;
  readonly available: boolean;
  readonly embeddingModel: string | null;
  readonly configPath: string | null;
}

interface DoctorChecks {
  readonly inkosJson: boolean;
  readonly projectEnv: boolean;
  readonly globalEnv: boolean;
  readonly booksDir: boolean;
  readonly llmConnected: boolean;
  readonly bookCount: number;
  readonly rag: RAGStatus;
}

interface Nav { toDashboard: () => void }

function CheckRow({ label, ok, detail }: { label: string; ok: boolean; detail?: string }) {
  return (
    <div className="flex items-center gap-3 py-3 border-b border-border/30 last:border-0">
      {ok ? (
        <CheckCircle2 size={18} className="text-emerald-500 shrink-0" />
      ) : (
        <XCircle size={18} className="text-destructive shrink-0" />
      )}
      <span className="text-sm font-medium flex-1">{label}</span>
      {detail && <span className="text-xs text-muted-foreground">{detail}</span>}
    </div>
  );
}

// RAG配置说明弹窗
function RAGConfigModal({ onClose, theme }: { onClose: () => void; theme: Theme }) {
  const c = useColors(theme);
  
  return createPortal(
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-background rounded-xl shadow-2xl max-w-3xl w-full max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between p-6 border-b border-border/40">
          <div className="flex items-center gap-2">
            <HelpCircle size={20} className="text-primary" />
            <h2 className="text-lg font-bold">RAG 系统配置说明</h2>
          </div>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground transition-colors"
          >
            <X size={20} />
          </button>
        </div>

        <div className="flex-1 overflow-auto p-6 space-y-6 text-sm">
          <div className={`p-4 rounded-lg ${c.cardStatic}`}>
            <p className="text-muted-foreground">
              RAG（检索增强生成）系统用于在写作时检索相关上下文，提高内容一致性。
              启用后会自动索引书籍的基础设定和章节内容。
            </p>
          </div>

          <div>
            <h3 className="font-medium mb-3">环境变量配置</h3>
            <p className="text-muted-foreground mb-2">
              在 <code className="bg-muted px-1 py-0.5 rounded">.env</code> 文件中设置以下环境变量。
              <span className="text-amber-600">注意：以 # 开头的行是注释，不会生效。如需启用某项配置，请删除该行前面的 #。</span>
            </p>
            <pre className="bg-muted p-3 rounded-lg text-xs overflow-x-auto">
{`# RAG 系统开关（必需）
RAG_ENABLED=true

# Embedding 模型类型（可选，默认 openai）
# 支持: openai, huggingface, lmstudio, mota, modelscope, siliconflow, zhipu, dashscope, local
# 使用哪个模型，就取消哪一行的注释，其他保持注释状态
#RAG_MODEL_TYPE=openai
#RAG_MODEL_TYPE=lmstudio
#RAG_MODEL_TYPE=siliconflow
RAG_MODEL_TYPE=openai

# Embedding 模型名称（根据上面的类型选择对应的模型名称）
# OpenAI: text-embedding-3-small, text-embedding-3-large
# LM Studio: text-embedding-nomic-embed-text-v1.5, text-embedding-qwen3-embedding-0.6b
# SiliconFlow: BAAI/bge-m3, BAAI/bge-large-zh-v1.5
RAG_MODEL_NAME=text-embedding-3-small

# API Key（根据模型类型选择，取消对应行的注释）
#OPENAI_API_KEY=sk-...
#SILICONFLOW_API_KEY=sk-...
#MOTA_API_KEY=your-api-key
# 等...

# 本地模型配置（使用 lmstudio 或 local 类型时，取消下面一行的注释）
# LM Studio 默认地址
#RAG_BASE_URL=http://127.0.0.1:1234/v1/embeddings
# Ollama 默认地址
#RAG_BASE_URL=http://localhost:11434/api/embeddings`}
            </pre>
          </div>

          <div>
            <h3 className="font-medium mb-3">支持的 Embedding 模型</h3>
            <ul className="list-disc list-inside space-y-1 text-muted-foreground">
              <li><strong>OpenAI</strong>: text-embedding-3-small, text-embedding-3-large, text-embedding-ada-002</li>
              <li><strong>HuggingFace</strong>: sentence-transformers/all-MiniLM-L6-v2 等</li>
              <li><strong>魔塔社区 (Mota)</strong>: m3e-small, m3e-base 等中文模型</li>
              <li><strong>ModelScope</strong>: iic/nlp_gte_sentence-embedding_chinese-base 等</li>
              <li><strong>SiliconFlow</strong>: BAAI/bge-m3, BAAI/bge-large-zh-v1.5 等</li>
              <li><strong>智谱 AI (Zhipu)</strong>: embedding-3, embedding-2</li>
              <li><strong>阿里云 DashScope</strong>: text-embedding-v2, text-embedding-v1</li>
              <li><strong>LM Studio</strong>: 本地运行的 OpenAI 兼容 embedding 服务</li>
              <li><strong>本地模型 (Ollama)</strong>: Ollama, Xinference 等本地 embedding 服务</li>
            </ul>
          </div>

          <div>
            <h3 className="font-medium mb-3">配置示例</h3>
            <div className="space-y-3">
              <div>
                <p className="text-xs text-muted-foreground mb-1">OpenAI（默认）:</p>
                <pre className="bg-muted p-2 rounded text-xs">
{`RAG_ENABLED=true
RAG_MODEL_TYPE=openai
RAG_MODEL_NAME=text-embedding-3-small
OPENAI_API_KEY=sk-...`}
                </pre>
              </div>
              <div>
                <p className="text-xs text-muted-foreground mb-1">SiliconFlow:</p>
                <pre className="bg-muted p-2 rounded text-xs">
{`RAG_ENABLED=true
RAG_MODEL_TYPE=siliconflow
RAG_MODEL_NAME=BAAI/bge-m3
SILICONFLOW_API_KEY=sk-...`}
                </pre>
              </div>
              <div>
                <p className="text-xs text-muted-foreground mb-1">LM Studio:</p>
                <pre className="bg-muted p-2 rounded text-xs">
{`RAG_ENABLED=true
RAG_MODEL_TYPE=lmstudio
RAG_MODEL_NAME=text-embedding-nomic-embed-text-v1.5
RAG_BASE_URL=http://127.0.0.1:1234/v1/embeddings`}
                </pre>
              </div>
              <div>
                <p className="text-xs text-muted-foreground mb-1">本地 Ollama:</p>
                <pre className="bg-muted p-2 rounded text-xs">
{`RAG_ENABLED=true
RAG_MODEL_TYPE=local
RAG_MODEL_NAME=nomic-embed-text
RAG_BASE_URL=http://localhost:11434/api/embeddings`}
                </pre>
              </div>
            </div>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 p-6 border-t border-border/40">
          <button
            onClick={onClose}
            className={`px-4 py-2 text-sm font-bold rounded-lg ${c.btnSecondary}`}
          >
            关闭
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

export function DoctorView({ nav, theme, t }: { nav: Nav; theme: Theme; t: TFunction }) {
  const c = useColors(theme);
  const { data, refetch } = useApi<DoctorChecks>("/doctor");
  const [showRAGConfig, setShowRAGConfig] = useState(false);
  const [togglingRAG, setTogglingRAG] = useState(false);

  const toggleRAG = async () => {
    setTogglingRAG(true);
    try {
      const newEnabled = !data?.rag?.enabled;
      await fetchJson("/rag-toggle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: newEnabled }),
      });
      await refetch();
    } catch (e) {
      alert(e instanceof Error ? e.message : "操作失败");
    }
    setTogglingRAG(false);
  };

  return (
    <div className="space-y-8">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <button onClick={nav.toDashboard} className={c.link}>{t("bread.home")}</button>
        <span className="text-border">/</span>
        <span>{t("nav.doctor")}</span>
      </div>

      <div className="flex items-center justify-between">
        <h1 className="font-serif text-3xl flex items-center gap-3">
          <Stethoscope size={28} className="text-primary" />
          {t("doctor.title")}
        </h1>
        <button onClick={() => refetch()} className={`px-4 py-2 text-sm rounded-lg ${c.btnSecondary}`}>
          {t("doctor.recheck")}
        </button>
      </div>

      {!data ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 size={24} className="animate-spin text-primary" />
        </div>
      ) : (
        <div className={`border ${c.cardStatic} rounded-lg p-5`}>
          <CheckRow label={t("doctor.inkosJson")} ok={data.inkosJson} />
          <CheckRow label={t("doctor.projectEnv")} ok={data.projectEnv} />
          <CheckRow label={t("doctor.globalEnv")} ok={data.globalEnv} />
          <CheckRow label={t("doctor.booksDir")} ok={data.booksDir} detail={`${data.bookCount} book(s)`} />
          <CheckRow label={t("doctor.llmApi")} ok={data.llmConnected} detail={data.llmConnected ? t("doctor.connected") : t("doctor.failed")} />
          
          {/* RAG System Status */}
          <div className="mt-4 pt-4 border-t border-border/30">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Database size={18} className="text-primary" />
                <span className="font-medium">RAG 系统</span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setShowRAGConfig(true)}
                  className="flex items-center gap-1 px-3 py-1.5 text-xs font-bold bg-secondary/50 text-muted-foreground rounded-lg hover:bg-secondary transition-all"
                >
                  <HelpCircle size={12} />
                  配置说明
                </button>
                <button
                  onClick={toggleRAG}
                  disabled={togglingRAG}
                  className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-lg transition-all ${
                    data.rag?.enabled
                      ? "bg-emerald-500/10 text-emerald-600 hover:bg-emerald-500/20"
                      : "bg-muted text-muted-foreground hover:bg-secondary"
                  } disabled:opacity-50`}
                >
                  {togglingRAG ? (
                    <div className="w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" />
                  ) : (
                    <Power size={12} />
                  )}
                  {data.rag?.enabled ? "已启用" : "已禁用"}
                </button>
              </div>
            </div>
            
            {data.rag?.enabled && (
              <>
                <CheckRow 
                  label="Embedding 服务可用" 
                  ok={data.rag?.available ?? false} 
                  detail={data.rag?.available ? "可用" : "不可用 - 请检查环境变量配置"}
                />
                {data.rag?.embeddingModel && (
                  <div className="flex items-center gap-3 py-2 text-sm">
                    <span className="text-muted-foreground w-24">模型:</span>
                    <span className="font-mono text-xs bg-muted px-2 py-1 rounded">{data.rag.embeddingModel}</span>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {data && (
        <div className={`px-4 py-3 rounded-lg text-sm font-medium ${
          data.inkosJson && (data.projectEnv || data.globalEnv) && data.llmConnected && (!data.rag?.enabled || data.rag?.available)
            ? "bg-emerald-500/10 text-emerald-600"
            : "bg-amber-500/10 text-amber-600"
        }`}>
          {data.inkosJson && (data.projectEnv || data.globalEnv) && data.llmConnected && (!data.rag?.enabled || data.rag?.available)
            ? t("doctor.allPassed")
            : t("doctor.someFailed")
          }
        </div>
      )}

      {showRAGConfig && (
        <RAGConfigModal onClose={() => setShowRAGConfig(false)} theme={theme} />
      )}
    </div>
  );
}
