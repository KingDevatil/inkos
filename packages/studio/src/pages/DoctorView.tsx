import { useApi } from "../hooks/use-api";
import type { Theme } from "../hooks/use-theme";
import type { TFunction } from "../hooks/use-i18n";
import { useColors } from "../hooks/use-colors";
import { Stethoscope, CheckCircle2, XCircle, Loader2, Database, HelpCircle } from "lucide-react";

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

export function DoctorView({ nav, theme, t }: { nav: Nav; theme: Theme; t: TFunction }) {
  const c = useColors(theme);
  const { data, refetch } = useApi<DoctorChecks>("/doctor");

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
            <div className="flex items-center gap-2 mb-3">
              <Database size={18} className="text-primary" />
              <span className="font-medium">RAG 系统状态</span>
            </div>
            <CheckRow 
              label="RAG 已启用" 
              ok={data.rag?.enabled ?? false} 
              detail={data.rag?.enabled ? "已启用" : "未启用"}
            />
            {data.rag?.enabled && (
              <CheckRow 
                label="Embedding 模型可用" 
                ok={data.rag?.available ?? false} 
                detail={data.rag?.available ? "可用" : "不可用"}
              />
            )}
            {data.rag?.embeddingModel && (
              <div className="flex items-center gap-3 py-2 text-sm">
                <span className="text-muted-foreground w-24">Embedding 模型:</span>
                <span className="font-mono text-xs bg-muted px-2 py-1 rounded">{data.rag.embeddingModel}</span>
              </div>
            )}
            {data.rag?.configPath && (
              <div className="flex items-center gap-3 py-2 text-sm">
                <span className="text-muted-foreground w-24">配置文件:</span>
                <span className="font-mono text-xs">{data.rag.configPath}</span>
              </div>
            )}
          </div>
        </div>
      )}

      {data && (
        <div className={`px-4 py-3 rounded-lg text-sm font-medium ${
          data.inkosJson && (data.projectEnv || data.globalEnv) && data.llmConnected
            ? "bg-emerald-500/10 text-emerald-600"
            : "bg-amber-500/10 text-amber-600"
        }`}>
          {data.inkosJson && (data.projectEnv || data.globalEnv) && data.llmConnected
            ? t("doctor.allPassed")
            : t("doctor.someFailed")
          }
        </div>
      )}

      {/* RAG Configuration Help */}
      <div className={`border ${c.cardStatic} rounded-lg p-5 mt-6`}>
        <div className="flex items-center gap-2 mb-4">
          <HelpCircle size={18} className="text-primary" />
          <span className="font-medium">RAG 系统配置说明</span>
        </div>
        
        <div className="space-y-4 text-sm">
          <div>
            <p className="text-muted-foreground mb-2">启用 RAG 系统需要在项目配置文件 <code className="bg-muted px-1 py-0.5 rounded">inkos.json</code> 中添加以下配置：</p>
            <pre className="bg-muted p-3 rounded-lg text-xs overflow-x-auto">
{`{
  "vectorRetrieval": {
    "enabled": true,
    "model": "text-embedding-3-small",
    "topK": 10,
    "minScore": 0.5,
    "storePath": "./rag-vector-index.json"
  }
}`}
            </pre>
          </div>
          
          <div>
            <p className="text-muted-foreground mb-2">支持的 Embedding 模型：</p>
            <ul className="list-disc list-inside space-y-1 text-muted-foreground">
              <li><code className="bg-muted px-1 rounded">text-embedding-3-small</code> (OpenAI, 推荐)</li>
              <li><code className="bg-muted px-1 rounded">text-embedding-3-large</code> (OpenAI)</li>
              <li><code className="bg-muted px-1 rounded">text-embedding-ada-002</code> (OpenAI)</li>
            </ul>
          </div>
          
          <div>
            <p className="text-muted-foreground mb-2">环境变量配置：</p>
            <p className="text-muted-foreground">确保在 <code className="bg-muted px-1 rounded">.env</code> 文件中设置了对应的 API Key：</p>
            <pre className="bg-muted p-3 rounded-lg text-xs mt-2">
{`# OpenAI (用于 Embedding)
OPENAI_API_KEY=sk-...`}
            </pre>
          </div>
          
          <div className="pt-2 border-t border-border/30">
            <p className="text-muted-foreground">
              <strong className="text-foreground">注意：</strong> 
              RAG 系统用于在写作时检索相关上下文，提高内容一致性。
              启用后会自动索引书籍的基础设定和章节内容。
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
