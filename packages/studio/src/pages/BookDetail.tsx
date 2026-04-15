import { fetchJson, useApi, postApi, putApi } from "../hooks/use-api";
import { useEffect, useMemo, useState, useRef } from "react";
import { createPortal } from "react-dom";
import type { Theme } from "../hooks/use-theme";
import type { TFunction } from "../hooks/use-i18n";
import type { SSEMessage } from "../hooks/use-sse";
import { useColors } from "../hooks/use-colors";
import { deriveBookActivity, shouldRefetchBookView } from "../hooks/use-book-activity";
import { ConfirmDialog } from "../components/ConfirmDialog";
import {
  ChevronLeft,
  Zap,
  FileText,
  CheckCheck,
  BarChart2,
  Download,
  Search,
  Wand2,
  Eye,
  Database,
  Check,
  X,
  ShieldCheck,
  RotateCcw,
  RefreshCw,
  Sparkles,
  Trash2,
  Save,
  ChevronDown,
  Edit3,
  CheckCircle,
  XCircle,
  AlertTriangle,
  Send,
  BookOpen,
  List,
  Play,
  MessageSquare
} from "lucide-react";

interface ChapterMeta {
  readonly number: number;
  readonly title: string;
  readonly status: string;
  readonly wordCount: number;
}

interface BookData {
  readonly book: {
    readonly id: string;
    readonly title: string;
    readonly genre: string;
    readonly status: string;
    readonly chapterWordCount: number;
    readonly targetChapters?: number;
    readonly language?: string;
    readonly fanficMode?: string;
  };
  readonly chapters: ReadonlyArray<ChapterMeta>;
  readonly nextChapter: number;
}

interface GenreInfo {
  readonly id: string;
  readonly name: string;
  readonly source: "project" | "builtin";
  readonly language: "zh" | "en";
}

type ReviseMode = "spot-fix" | "polish" | "rewrite" | "rework" | "anti-detect";
type ExportFormat = "txt" | "md" | "epub";
type BookStatus = "active" | "paused" | "outlining" | "completed" | "dropped";

interface Nav {
  toDashboard: () => void;
  toChapter: (bookId: string, num: number) => void;
  toAnalytics: (bookId: string) => void;
  toChat: () => void;
}

function translateChapterStatus(status: string, t: TFunction): string {
  const map: Record<string, () => string> = {
    "card-generated": () => t("chapter.cardGenerated"),
    "drafting": () => t("chapter.drafting"),
    "drafted": () => t("chapter.drafted"),
    "auditing": () => t("chapter.auditing"),
    "audit-passed": () => t("chapter.auditPassed"),
    "audit-failed": () => t("chapter.auditFailed"),
    "state-degraded": () => t("chapter.stateDegraded"),
    "revising": () => t("chapter.revising"),
    "ready-for-review": () => t("chapter.readyForReview"),
    "approved": () => t("chapter.approved"),
    "rejected": () => t("chapter.rejected"),
    "published": () => t("chapter.published"),
    "imported": () => t("chapter.imported"),
  };
  return map[status]?.() ?? status;
}

const STATUS_CONFIG: Record<string, { color: string; icon: React.ReactNode }> = {
  "card-generated": { color: "text-slate-600 bg-slate-100", icon: <FileText size={12} /> },
  "drafting": { color: "text-blue-600 bg-blue-50", icon: <Edit3 size={12} /> },
  "drafted": { color: "text-blue-600 bg-blue-50", icon: <FileText size={12} /> },
  "auditing": { color: "text-purple-600 bg-purple-50", icon: <Search size={12} /> },
  "audit-passed": { color: "text-emerald-600 bg-emerald-50", icon: <CheckCircle size={12} /> },
  "audit-failed": { color: "text-red-600 bg-red-50", icon: <XCircle size={12} /> },
  "state-degraded": { color: "text-amber-600 bg-amber-50", icon: <AlertTriangle size={12} /> },
  "revising": { color: "text-orange-600 bg-orange-50", icon: <RotateCcw size={12} /> },
  "ready-for-review": { color: "text-yellow-600 bg-yellow-50", icon: <Eye size={12} /> },
  "approved": { color: "text-teal-600 bg-teal-50", icon: <Check size={12} /> },
  "rejected": { color: "text-rose-600 bg-rose-50", icon: <X size={12} /> },
  "published": { color: "text-indigo-600 bg-indigo-50", icon: <Send size={12} /> },
  "imported": { color: "text-gray-600 bg-gray-50", icon: <Download size={12} /> },
};

// RAG检测补充按钮组件
function RAGSupplementButton({ bookId }: { bookId: string }) {
  const [showModal, setShowModal] = useState(false);
  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState(false);
  const [status, setStatus] = useState<{
    foundationStatus: string;
    summary: { total: number; indexed: number; missing: number; outdated: number };
    chapters: Array<{ chapter: number; status: string; indexedAt?: string }>;
  } | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [progress, setProgress] = useState<{ current: number; total: number; chapter: number } | null>(null);

  const checkStatus = async () => {
    setChecking(true);
    try {
      const data = await fetchJson<{
        status: unknown;
        check: {
          foundationStatus: string;
          summary: { total: number; indexed: number; missing: number; outdated: number };
          chapters: Array<{ chapter: number; status: string; indexedAt?: string }>;
        };
      }>(`/books/${bookId}/rag-status`);
      setStatus(data.check);
    } catch (e) {
      setLogs(prev => [...prev, `检查失败: ${e instanceof Error ? e.message : String(e)}`]);
    }
    setChecking(false);
  };

  const supplement = async (forceReindex = false) => {
    setLoading(true);
    setLogs([]);
    setProgress(null);

    try {
      const response = await fetch(`/api/books/${bookId}/rag-supplement`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ forceReindex }),
      });

      const data = await response.json();

      if (data.ok) {
        setLogs(prev => [
          ...prev,
          `检测完成: 共 ${data.checked} 章`,
          `基础设定: ${data.foundationStatus === "indexed" ? "已索引" : "未索引"}`,
          `已索引: ${data.summary.indexed} 章`,
          `缺失: ${data.summary.missing} 章`,
          `补充成功: ${data.results.filter((r: { success: boolean }) => r.success).length} 章`,
          `失败: ${data.results.filter((r: { success: boolean }) => !r.success).length} 章`,
        ]);

        // 显示详细结果
        data.results.forEach((result: { chapter: number; success: boolean; error?: string }) => {
          if (result.success) {
            setLogs(prev => [...prev, `✓ 第${result.chapter}章 索引成功`]);
          } else {
            setLogs(prev => [...prev, `✗ 第${result.chapter}章 索引失败: ${result.error || "未知错误"}`]);
          }
        });

        // 刷新状态
        await checkStatus();
      } else {
        const errorMsg = data.error || "未知错误";
        const details = data.details || "";
        const config = data.config ? `\n配置: ${JSON.stringify(data.config, null, 2)}` : "";
        setLogs(prev => [...prev, `补充失败: ${errorMsg}${details ? "\n" + details : ""}${config}`]);
      }
    } catch (e) {
      setLogs(prev => [...prev, `请求失败: ${e instanceof Error ? e.message : String(e)}`]);
    }

    setLoading(false);
    setProgress(null);
  };

  const rebuild = async () => {
    const confirmed = window.confirm("确定要重建所有RAG索引吗？这将清空现有索引并重新索引所有内容。");
    if (!confirmed) return;

    setLoading(true);
    setLogs([]);

    try {
      const response = await fetch(`/api/books/${bookId}/rag-rebuild`, {
        method: "POST",
      });

      const data = await response.json();

      if (data.ok) {
        setLogs(prev => [
          ...prev,
          `重建完成: 共 ${data.total} 章`,
          `索引成功: ${data.indexed} 章`,
          `失败: ${data.failed} 章`,
        ]);

        // 刷新状态
        await checkStatus();
      } else {
        const errorMsg = data.error || "未知错误";
        const details = data.details || "";
        const config = data.config ? `\n配置: ${JSON.stringify(data.config, null, 2)}` : "";
        setLogs(prev => [...prev, `重建失败: ${errorMsg}${details ? "\n" + details : ""}${config}`]);
      }
    } catch (e) {
      setLogs(prev => [...prev, `请求失败: ${e instanceof Error ? e.message : String(e)}`]);
    }

    setLoading(false);
  };

  return (
    <>
      <button
        onClick={() => {
          setShowModal(true);
          checkStatus();
        }}
        className="flex items-center gap-2 px-4 py-2 text-xs font-bold bg-secondary/50 text-muted-foreground rounded-lg hover:text-foreground hover:bg-secondary transition-all border border-border/50"
      >
        <Database size={14} />
        RAG检测补充
      </button>

      {showModal && createPortal(
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-background rounded-xl shadow-2xl max-w-2xl w-full max-h-[80vh] flex flex-col">
            <div className="flex items-center justify-between p-6 border-b border-border/40">
              <h2 className="text-lg font-bold">RAG 检测补充</h2>
              <button
                onClick={() => setShowModal(false)}
                className="text-muted-foreground hover:text-foreground transition-colors"
              >
                <X size={20} />
              </button>
            </div>

            <div className="flex-1 overflow-auto p-6 space-y-4">
              {checking ? (
                <div className="flex items-center justify-center py-8">
                  <div className="w-6 h-6 border-2 border-primary/20 border-t-primary rounded-full animate-spin mr-2" />
                  正在检测状态...
                </div>
              ) : status ? (
                <div className="space-y-4">
                  {/* 统计信息 */}
                  <div className="grid grid-cols-4 gap-4">
                    <div className="bg-secondary/30 rounded-lg p-4 text-center">
                      <div className="text-2xl font-bold">{status.summary.total}</div>
                      <div className="text-xs text-muted-foreground">总章节</div>
                    </div>
                    <div className="bg-emerald-500/10 rounded-lg p-4 text-center">
                      <div className="text-2xl font-bold text-emerald-600">{status.summary.indexed}</div>
                      <div className="text-xs text-muted-foreground">已索引</div>
                    </div>
                    <div className="bg-amber-500/10 rounded-lg p-4 text-center">
                      <div className="text-2xl font-bold text-amber-600">{status.summary.missing}</div>
                      <div className="text-xs text-muted-foreground">缺失</div>
                    </div>
                    <div className="bg-blue-500/10 rounded-lg p-4 text-center">
                      <div className="text-2xl font-bold text-blue-600">{status.summary.outdated}</div>
                      <div className="text-xs text-muted-foreground">过期</div>
                    </div>
                  </div>

                  {/* 基础设定状态 */}
                  <div className="flex items-center gap-2 p-3 bg-secondary/30 rounded-lg">
                    <span className="text-sm font-medium">基础设定:</span>
                    <span className={`text-sm ${status.foundationStatus === "indexed" ? "text-emerald-600" : "text-amber-600"}`}>
                      {status.foundationStatus === "indexed" ? "✓ 已索引" : "⚠ 未索引"}
                    </span>
                  </div>

                  {/* 章节列表 */}
                  <div className="border border-border/40 rounded-lg overflow-hidden">
                    <div className="bg-secondary/30 px-4 py-2 text-sm font-medium border-b border-border/40">
                      章节索引状态
                    </div>
                    <div className="max-h-48 overflow-auto">
                      {status.chapters.map(ch => (
                        <div
                          key={ch.chapter}
                          className="flex items-center justify-between px-4 py-2 border-b border-border/20 last:border-0 text-sm"
                        >
                          <span>第{ch.chapter}章</span>
                          <span className={`text-xs ${
                            ch.status === "indexed" ? "text-emerald-600" : "text-amber-600"
                          }`}>
                            {ch.status === "indexed" ? "✓ 已索引" : "⚠ 未索引"}
                            {ch.indexedAt && ` (${new Date(ch.indexedAt).toLocaleDateString()})`}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* 日志输出 */}
                  {logs.length > 0 && (
                    <div className="border border-border/40 rounded-lg overflow-hidden">
                      <div className="bg-secondary/30 px-4 py-2 text-sm font-medium border-b border-border/40">
                        操作日志
                      </div>
                      <div className="max-h-48 overflow-auto p-4 space-y-1 text-xs font-mono bg-black/5">
                        {logs.map((log, i) => (
                          <div key={i} className="text-muted-foreground">{log}</div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* 进度条 */}
                  {progress && (
                    <div className="space-y-2">
                      <div className="flex justify-between text-sm">
                        <span>正在处理...</span>
                        <span>{progress.current} / {progress.total}</span>
                      </div>
                      <div className="h-2 bg-secondary rounded-full overflow-hidden">
                        <div
                          className="h-full bg-primary transition-all"
                          style={{ width: `${(progress.current / progress.total) * 100}%` }}
                        />
                      </div>
                    </div>
                  )}
                </div>
              ) : null}
            </div>

            <div className="flex items-center justify-end gap-2 p-6 border-t border-border/40">
              <button
                onClick={() => setShowModal(false)}
                className="px-4 py-2 text-sm font-bold bg-secondary text-secondary-foreground rounded-lg hover:bg-secondary/80 transition-all"
              >
                关闭
              </button>
              <button
                onClick={() => supplement(false)}
                disabled={loading || !status || status.summary.missing === 0}
                className="flex items-center gap-2 px-4 py-2 text-sm font-bold bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {loading ? <div className="w-4 h-4 border-2 border-primary-foreground/20 border-t-primary-foreground rounded-full animate-spin" /> : <RefreshCw size={14} />}
                补充缺失
              </button>
              <button
                onClick={() => supplement(true)}
                disabled={loading}
                className="flex items-center gap-2 px-4 py-2 text-sm font-bold bg-amber-500/10 text-amber-600 rounded-lg hover:bg-amber-500/20 transition-all disabled:opacity-50"
              >
                {loading ? <div className="w-4 h-4 border-2 border-amber-600/20 border-t-amber-600 rounded-full animate-spin" /> : <RotateCcw size={14} />}
                强制重新索引
              </button>
              <button
                onClick={rebuild}
                disabled={loading}
                className="flex items-center gap-2 px-4 py-2 text-sm font-bold bg-destructive text-destructive-foreground rounded-lg hover:bg-destructive/90 transition-all disabled:opacity-50"
              >
                {loading ? <div className="w-4 h-4 border-2 border-destructive-foreground/20 border-t-destructive-foreground rounded-full animate-spin" /> : <Database size={14} />}
                重建索引
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  );
}

export function BookDetail({
  bookId,
  nav,
  theme,
  t,
  sse,
}: {
  bookId: string;
  nav: Nav;
  theme: Theme;
  t: TFunction;
  sse: { messages: ReadonlyArray<SSEMessage> };
}) {
  const c = useColors(theme);
  const { data, loading, error, refetch } = useApi<BookData>(`/books/${bookId}`);
  const { data: genreData } = useApi<{ genres: ReadonlyArray<GenreInfo> }>("/genres");
  const [writeRequestPending, setWriteRequestPending] = useState(false);
  const [draftRequestPending, setDraftRequestPending] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [rewritingChapters, setRewritingChapters] = useState<ReadonlyArray<number>>([]);
  const [revisingChapters, setRevisingChapters] = useState<ReadonlyArray<number>>([]);
  const [syncingChapters, setSyncingChapters] = useState<ReadonlyArray<number>>([]);
  const [deletingChapters, setDeletingChapters] = useState<ReadonlyArray<number>>([]);
  const [openDropdown, setOpenDropdown] = useState<number | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [savingSettings, setSavingSettings] = useState(false);
  const [settingsWordCount, setSettingsWordCount] = useState<number | null>(null);
  const [settingsTargetChapters, setSettingsTargetChapters] = useState<number | null>(null);
  const [settingsStatus, setSettingsStatus] = useState<BookStatus | null>(null);
  const [exportFormat, setExportFormat] = useState<ExportFormat>("txt");
  const [exportApprovedOnly, setExportApprovedOnly] = useState(false);
  const [auditConfig, setAuditConfig] = useState<any>(null);
  const [loadingAuditConfig, setLoadingAuditConfig] = useState(false);
  const [savingAuditConfig, setSavingAuditConfig] = useState(false);
  const [showAuditConfig, setShowAuditConfig] = useState(false);
  const [activeAuditTab, setActiveAuditTab] = useState<"dimensions" | "validation" | "chapter" | "chapterPlan" | "foundation" | "help">("dimensions");
  const [showOutlineRegenerate, setShowOutlineRegenerate] = useState(false);
  const [outlineGenre, setOutlineGenre] = useState("");
  const [outlineBrief, setOutlineBrief] = useState("");
  const [outlineFileName, setOutlineFileName] = useState("");
  const [regeneratingOutline, setRegeneratingOutline] = useState(false);
  const [outlineRunId, setOutlineRunId] = useState<string | null>(null);

  // 卷纲重生成状态
  const [showVolumeOutlineRegenerate, setShowVolumeOutlineRegenerate] = useState(false);
  const [authorIntent, setAuthorIntent] = useState("");
  const [rewriteLevel, setRewriteLevel] = useState<"low" | "medium" | "high">("medium");
  const [regeneratingVolumeOutline, setRegeneratingVolumeOutline] = useState(false);
  const [volumeOutlineRunId, setVolumeOutlineRunId] = useState<string | null>(null);
  const [generatedVolumeOutline, setGeneratedVolumeOutline] = useState("");
  const [showVolumeOutlinePreview, setShowVolumeOutlinePreview] = useState(false);
  const [volumePlans, setVolumePlans] = useState<any>(null);
  const [loadingVolumePlans, setLoadingVolumePlans] = useState(false);
  const [reparsingVolumePlans, setReparsingVolumePlans] = useState(false);
  const [activeTab, setActiveTab] = useState<"chapters" | "volume-plans">('chapters');
  
  // Volume outline modal states
  const [showVolumeOutlineModal, setShowVolumeOutlineModal] = useState(false);
  const [selectedVolumeOutline, setSelectedVolumeOutline] = useState<any>(null);
  const [loadingVolumeOutline, setLoadingVolumeOutline] = useState(false);
  
  // Volume detail outline states (generated by ArchitectAgent)
  const [volumeDetailOutlines, setVolumeDetailOutlines] = useState<Record<number, { exists: boolean; content: string | null }>>({});
  const [loadingVolumeDetail, setLoadingVolumeDetail] = useState<Record<number, boolean>>({});
  

  
  // Custom confirm/alert dialog states
  const [showConfirm, setShowConfirm] = useState(false);
  const [confirmTitle, setConfirmTitle] = useState("");
  const [confirmMessage, setConfirmMessage] = useState("");
  const [confirmCallback, setConfirmCallback] = useState<(() => void) | null>(null);
  const [showAlert, setShowAlert] = useState(false);
  const [alertMessage, setAlertMessage] = useState("");
  
  // Custom input dialog states
  const [showInputDialog, setShowInputDialog] = useState(false);
  const [inputDialogTitle, setInputDialogTitle] = useState("");
  const [inputDialogMessage, setInputDialogMessage] = useState("");
  const [inputDialogValue, setInputDialogValue] = useState("");
  const [inputDialogCallback, setInputDialogCallback] = useState<((value: string | null) => void) | null>(null);

  // Custom confirm dialog helper
  const showConfirmDialog = (title: string, message: string, onConfirm: () => void) => {
    setConfirmTitle(title);
    setConfirmMessage(message);
    setConfirmCallback(() => onConfirm);
    setShowConfirm(true);
  };

  // Custom alert dialog helper
  const showAlertDialog = (message: string) => {
    setAlertMessage(message);
    setShowAlert(true);
  };

  const activity = useMemo(() => deriveBookActivity(sse.messages, bookId), [bookId, sse.messages]);
  const writing = writeRequestPending || activity.writing;
  const drafting = draftRequestPending || activity.drafting;
  const latestPersistedChapter = data ? data.nextChapter - 1 : 0;

  const loadVolumePlans = async () => {
    setLoadingVolumePlans(true);
    try {
      const response = await fetchJson(`/books/${bookId}/volume-plans`);
      setVolumePlans(response.volumePlans);
      // Check detail outline for each volume
      for (const volume of response.volumePlans) {
        await checkVolumeDetailOutline(volume.volumeId);
      }
    } catch (e) {
      console.error('Failed to load volume plans:', e);
    } finally {
      setLoadingVolumePlans(false);
    }
  };

  // 重新根据卷纲拆分分卷（用于重写大纲后）
  const reparseVolumePlans = async () => {
    showConfirmDialog(
      '确认重新拆分分卷',
      '确定要根据最新的卷纲重新拆分分卷吗？\n\n这将：\n1. 重新解析 volume_outline.md\n2. 根据最新卷纲更新分卷结构\n3. 保留已有的分卷详细卷纲文件（如果存在）\n\n注意：如果卷数发生变化（如从7卷变为5卷），多余的分卷将被移除。',
      async () => {
        setReparsingVolumePlans(true);
        try {
          const response = await postApi(`/books/${bookId}/reparse-volume-plans`);
          setVolumePlans(response.volumePlans);
          // Check detail outline for each volume
          for (const volume of response.volumePlans) {
            await checkVolumeDetailOutline(volume.volumeId);
          }
          showAlertDialog(`已成功重新拆分为 ${response.volumePlans.length} 个分卷`);
        } catch (e) {
          showAlertDialog(e instanceof Error ? e.message : '重新拆分分卷失败');
        } finally {
          setReparsingVolumePlans(false);
        }
      }
    );
  };

  // Custom input dialog helper
  const openInputDialog = (title: string, message: string, defaultValue: string, onConfirm: (value: string | null) => void) => {
    setInputDialogTitle(title);
    setInputDialogMessage(message);
    setInputDialogValue(defaultValue);
    setInputDialogCallback(() => onConfirm);
    setShowInputDialog(true);
  };

  const viewVolumeOutline = async (volumeId: number) => {
    setLoadingVolumeOutline(true);
    setShowVolumeOutlineModal(true);
    try {
      // First try to load detail outline
      const detailResponse = await fetchJson(`/books/${bookId}/volumes/${volumeId}/detail-outline`);
      if (detailResponse.exists && detailResponse.content) {
        setSelectedVolumeOutline({
          volumeId,
          title: `第${volumeId}卷 详细卷纲`,
          outline: detailResponse.content,
          isDetail: true
        });
      } else {
        // Fallback to regular outline
        const response = await fetchJson(`/books/${bookId}/volumes/${volumeId}/outline`);
        setSelectedVolumeOutline({
          ...response,
          isDetail: false
        });
      }
    } catch (e) {
      console.error('Failed to load volume outline:', e);
      setSelectedVolumeOutline(null);
    } finally {
      setLoadingVolumeOutline(false);
    }
  };

  const rewriteVolumeOutline = async (volumeId: number) => {
    showConfirmDialog('确认重写卷纲', '确定要重写本卷卷纲吗？', async () => {
      setRegeneratingVolumeOutline(true);
      try {
        await postApi(`/books/${bookId}/volumes/${volumeId}/rewrite-outline`);
        showAlertDialog('卷纲重写已开始，请等待完成');
        loadVolumePlans();
      } catch (e) {
        showAlertDialog(e instanceof Error ? e.message : '卷纲重写失败');
      } finally {
        setRegeneratingVolumeOutline(false);
      }
    });
  };

  const checkVolumeDetailOutline = async (volumeId: number) => {
    setLoadingVolumeDetail(prev => ({ ...prev, [volumeId]: true }));
    try {
      const response = await fetchJson(`/books/${bookId}/volumes/${volumeId}/detail-outline`);
      setVolumeDetailOutlines(prev => ({
        ...prev,
        [volumeId]: { exists: response.exists, content: response.content }
      }));
      return response.exists;
    } catch (e) {
      console.error('Failed to check volume detail outline:', e);
      return false;
    } finally {
      setLoadingVolumeDetail(prev => ({ ...prev, [volumeId]: false }));
    }
  };

  const generateVolumeDetailOutline = async (volumeId: number) => {
    // No confirmation needed for single volume, only for batch
    setLoadingVolumeDetail(prev => ({ ...prev, [volumeId]: true }));
    try {
      await postApi(`/books/${bookId}/volumes/${volumeId}/generate-detail`);
      // Refresh status after generation
      await checkVolumeDetailOutline(volumeId);
    } catch (e) {
      showAlertDialog(e instanceof Error ? e.message : '分卷卷纲生成失败');
    } finally {
      setLoadingVolumeDetail(prev => ({ ...prev, [volumeId]: false }));
    }
  };

  const generateAllVolumeDetailOutlines = async () => {
    if (!volumePlans || volumePlans.length === 0) return;
    
    // Only one confirmation for all volumes
    showConfirmDialog('确认生成所有分卷卷纲', `确定要生成所有${volumePlans.length}个分卷的详细卷纲吗？\n\n这将依次为每个分卷生成详细卷纲，可能需要较长时间。`, async () => {
      try {
        // Generate for all volumes without auto-refresh
        for (const volume of volumePlans) {
          await postApi(`/books/${bookId}/volumes/${volume.volumeId}/generate-detail`);
        }
        showAlertDialog('所有分卷卷纲生成已开始，请等待完成。生成完成后请手动刷新卷纲列表。');
        // Don't auto-refresh here to avoid infinite loop
        // User can manually refresh or wait for SSE notification
      } catch (e) {
        showAlertDialog(e instanceof Error ? e.message : '分卷卷纲生成失败');
      }
    });
  };

  const rewriteVolumeChapters = async (volumeId: string) => {
    showConfirmDialog('确认重写章节', '确定要重写本卷所有章节吗？', async () => {
      try {
        await postApi(`/books/${bookId}/volumes/${volumeId}/rewrite-chapters`);
        showAlertDialog('本卷章节重写已开始，请等待完成');
        refetch();
      } catch (e) {
        showAlertDialog(e instanceof Error ? e.message : '章节重写失败');
      }
    });
  };

  const markAffectedChapters = async (volumeId: string) => {
    try {
      await postApi(`/books/${bookId}/volumes/${volumeId}/mark-affected`);
      showAlertDialog('受影响章节已标记，需要重新审计');
      refetch();
    } catch (e) {
      showAlertDialog(e instanceof Error ? e.message : '标记受影响章节失败');
    }
  };

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpenDropdown(null);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    if (shouldRefetchBookView(sse.messages, bookId)) {
      refetch();
    }
  }, [sse.messages, bookId, refetch]);

  // 监听 SSE 事件，处理异步错误和完成事件
  useEffect(() => {
    const recentMessages = sse.messages.slice(-10);
    for (const message of recentMessages) {
      const data = message.data as { bookId?: string; volumeId?: number; error?: string; runId?: string } | null;

      // 处理 run 完成事件
      if (data?.runId) {
        if (data.runId === outlineRunId) {
          setOutlineRunId(null);
        }
        if (data.runId === volumeOutlineRunId) {
          setVolumeOutlineRunId(null);
        }
      }

      // 处理分卷卷纲生成事件
      if (data?.bookId === bookId && data?.volumeId) {
        switch (message.event) {
          case "volume:generate-detail:complete":
            // 生成完成，刷新状态
            checkVolumeDetailOutline(data.volumeId);
            setLoadingVolumeDetail(prev => ({ ...prev, [data.volumeId!]: false }));
            break;
          case "volume:generate-detail:error":
            // 生成出错，重置状态并显示错误
            setLoadingVolumeDetail(prev => ({ ...prev, [data.volumeId!]: false }));
            showAlertDialog(data.error || '分卷卷纲生成失败');
            break;
        }
      }
    }
  }, [sse.messages, bookId, outlineRunId, volumeOutlineRunId]);

  // 自动加载卷纲
  useEffect(() => {
    loadVolumePlans();
  }, [bookId]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-2 border-primary/20 border-t-primary rounded-full animate-spin" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="max-w-3xl mx-auto p-6">
        <div className={`border ${c.error} rounded-lg px-4 py-3`}>
          {error || "Book not found"}
        </div>
        <button onClick={nav.toDashboard} className={`mt-4 ${c.link}`}>
          {t("bread.books")}
        </button>
      </div>
    );
  }

  const { book, chapters } = data;
  const currentWordCount = settingsWordCount ?? book.chapterWordCount;
  const currentTargetChapters = settingsTargetChapters ?? book.targetChapters ?? 200;

  const handleWriteNext = async () => {
    setWriteRequestPending(true);
    try {
      await postApi(`/books/${bookId}/write-next`, {});
    } catch (e) {
      showAlertDialog(e instanceof Error ? e.message : "Failed to start writing");
    } finally {
      setWriteRequestPending(false);
    }
    refetch();
  };

  const handleDraftNext = async () => {
    setDraftRequestPending(true);
    try {
      await postApi(`/books/${bookId}/draft`, {});
    } catch (e) {
      showAlertDialog(e instanceof Error ? e.message : "Failed to start drafting");
    } finally {
      setDraftRequestPending(false);
    }
    refetch();
  };

  const handleDeleteBook = async () => {
    setDeleting(true);
    try {
      await fetchJson(`/books/${bookId}`, { method: "DELETE" });
      nav.toDashboard();
    } catch (e) {
      showAlertDialog(e instanceof Error ? e.message : "Failed to delete book");
      setDeleting(false);
    }
  };

  const handleApproveAll = async () => {
    const reviewable = data.chapters.filter((ch) => ch.status === "ready-for-review");
    for (const ch of reviewable) {
      try {
        await postApi(`/books/${bookId}/chapters/${ch.number}/approve`, {});
      } catch (e) {
        console.error(`Failed to approve chapter ${ch.number}:`, e);
      }
    }
    refetch();
  };

  const handleFixChapterOrder = async () => {
    try {
      await postApi(`/books/${bookId}/chapters/fix-order`, {});
      showAlertDialog("章节顺序已修复");
      refetch();
    } catch (e) {
      showAlertDialog(e instanceof Error ? e.message : "修复章节顺序失败");
    }
  };

  const handleSaveSettings = async () => {
    setSavingSettings(true);
    try {
      const body: Record<string, unknown> = {};
      if (settingsWordCount !== null) body.chapterWordCount = settingsWordCount;
      if (settingsTargetChapters !== null) body.targetChapters = settingsTargetChapters;
      if (settingsStatus !== null) body.status = settingsStatus;
      await postApi(`/books/${bookId}/settings`, body);
      setSettingsWordCount(null);
      setSettingsTargetChapters(null);
      setSettingsStatus(null);
      refetch();
    } catch (e) {
      showAlertDialog(e instanceof Error ? e.message : "Failed to save settings");
    } finally {
      setSavingSettings(false);
    }
  };

  const handleSync = async (chapterNum: number) => {
    setSyncingChapters((prev) => [...prev, chapterNum]);
    try {
      await postApi(`/books/${bookId}/chapters/${chapterNum}/sync`, {});
      refetch();
    } catch (e) {
      showAlertDialog(e instanceof Error ? e.message : "Failed to sync");
    } finally {
      setSyncingChapters((prev) => prev.filter((n) => n !== chapterNum));
    }
  };

  const handleRevise = async (chapterNum: number, mode: ReviseMode) => {
    const title = data?.book.language === "en" ? "Revise Chapter" : "修订章节";
    const message = data?.book.language === "en"
      ? "Optional revise brief for this run only. Leave blank to use existing focus."
      : "可选：输入这次修订要遵循的补充想法。留空则沿用现有 focus。";

    openInputDialog(title, message, "", async (brief) => {
      if (brief === null) return;
      setRevisingChapters((prev) => [...prev, chapterNum]);
      try {
        await fetchJson(`/books/${bookId}/revise/${chapterNum}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode, brief: brief.trim() || undefined }),
        });
        refetch();
      } catch (e) {
        showAlertDialog(e instanceof Error ? e.message : "Failed to revise");
      } finally {
        setRevisingChapters((prev) => prev.filter((n) => n !== chapterNum));
      }
    });
  };

  const handleDeleteChapter = async (chapterNum: number) => {
    showConfirmDialog(
      data?.book.language === "en" ? "Confirm Delete Chapter" : "确认删除章节",
      data?.book.language === "en"
        ? `Are you sure you want to delete chapter ${chapterNum}? This action cannot be undone.`
        : `确定要删除第 ${chapterNum} 章吗？此操作不可撤销。`,
      async () => {
        setDeletingChapters((prev) => [...prev, chapterNum]);
        try {
          await fetchJson(`/books/${bookId}/chapters/${chapterNum}`, { method: "DELETE" });
          refetch();
        } catch (e) {
          showAlertDialog(e instanceof Error ? e.message : "Failed to delete chapter");
        } finally {
          setDeletingChapters((prev) => prev.filter((n) => n !== chapterNum));
        }
      }
    );
  };

  const handleRewrite = async (chapterNum: number) => {
    showConfirmDialog(
      data?.book.language === "en" ? "Confirm Rewrite Chapter" : "确认重写章节",
      data?.book.language === "en"
        ? `Are you sure you want to rewrite chapter ${chapterNum}? This will regenerate the chapter content.`
        : `确定要重写第 ${chapterNum} 章吗？这将重新生成章节内容。`,
      async () => {
        setRewritingChapters((prev) => [...prev, chapterNum]);
        try {
          await postApi(`/books/${bookId}/chapters/${chapterNum}/rewrite`, {});
          showAlertDialog(data?.book.language === "en" ? "Chapter rewrite started" : "章节重写已开始");
          refetch();
        } catch (e) {
          showAlertDialog(e instanceof Error ? e.message : "Failed to rewrite chapter");
        } finally {
          setRewritingChapters((prev) => prev.filter((n) => n !== chapterNum));
        }
      }
    );
  };

  const loadAuditConfig = async () => {
    setLoadingAuditConfig(true);
    try {
      const config = await fetchJson(`/books/${bookId}/audit-config`);
      setAuditConfig(config);
      setShowAuditConfig(true);
    } catch (e) {
      showAlertDialog(e instanceof Error ? e.message : "Failed to load audit config");
    } finally {
      setLoadingAuditConfig(false);
    }
  };

  const handleOutlineFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const ext = file.name.split(".").pop()?.toLowerCase();
    if (ext !== "txt" && ext !== "md") {
      showAlertDialog("仅支持 .txt 和 .md 格式的简报文件");
      return;
    }
    const reader = new FileReader();
    reader.onload = (event) => {
      setOutlineBrief(event.target?.result as string || "");
      setOutlineFileName(file.name);
    };
    reader.readAsText(file);
  };

  const handleRegenerateOutline = async () => {
    if (!outlineGenre) {
      showAlertDialog("请选择书籍题材");
      return;
    }
    setRegeneratingOutline(true);
    try {
      const response = await postApi(`/books/${bookId}/regenerate-foundation`, {
        genre: outlineGenre,
        brief: outlineBrief || undefined,
      });
      setOutlineRunId(response.runId);
      setShowOutlineRegenerate(false);
      setOutlineGenre("");
      setOutlineBrief("");
      setOutlineFileName("");
      showAlertDialog("大纲重生成已开始，请等待完成");
    } catch (e) {
      showAlertDialog(e instanceof Error ? e.message : "大纲重生成失败");
    } finally {
      setRegeneratingOutline(false);
    }
  };

  const handleRegenerateVolumeOutline = async () => {
    if (!authorIntent.trim()) {
      showAlertDialog("请输入作者意图");
      return;
    }
    setRegeneratingVolumeOutline(true);
    try {
      const response = await postApi(`/books/${bookId}/regenerate-outline`, {
        intent: authorIntent,
        rewriteLevel,
      });
      setVolumeOutlineRunId(response.runId);
      setGeneratedVolumeOutline(response.volumeOutline);
      setShowVolumeOutlinePreview(true);
    } catch (e) {
      showAlertDialog(e instanceof Error ? e.message : "卷纲重生成失败");
    } finally {
      setRegeneratingVolumeOutline(false);
    }
  };

  const handleConfirmVolumeOutline = async () => {
    setRegeneratingVolumeOutline(true);
    try {
      await postApi(`/books/${bookId}/confirm-outline`);
      setShowVolumeOutlinePreview(false);
      setShowVolumeOutlineRegenerate(false);
      setAuthorIntent("");
      setRewriteLevel("medium");
      setGeneratedVolumeOutline("");
      showAlertDialog("卷纲更新确认成功，已提前生成章节规划");
    } catch (e) {
      showAlertDialog(e instanceof Error ? e.message : "卷纲确认失败");
    } finally {
      setRegeneratingVolumeOutline(false);
    }
  };

  const saveAuditConfig = async () => {
    if (!auditConfig) return;
    setSavingAuditConfig(true);
    try {
      await putApi(`/books/${bookId}/audit-config`, auditConfig);
      setShowAuditConfig(false);
    } catch (e) {
      showAlertDialog(e instanceof Error ? e.message : "Failed to save audit config");
    } finally {
      setSavingAuditConfig(false);
    }
  };

  const reviewCount = chapters.filter((ch) => ch.status === "ready-for-review").length;
  const currentStatus = settingsStatus ?? (book.status as BookStatus);

  return (
    <>
      {/* Volume Outline Modal - Portal to body */}
      {showVolumeOutlineModal && createPortal(
        <div className="fixed inset-0 bg-black/50 z-[9999] p-4" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div className="bg-card rounded-xl max-w-4xl w-full max-h-[90vh] overflow-hidden flex flex-col relative" style={{ minHeight: '400px' }}>
            <div className="flex items-center justify-between p-6 border-b border-border/40 shrink-0">
              <h3 className="text-xl font-bold">
                {selectedVolumeOutline?.title || `第${selectedVolumeOutline?.volumeId}卷 卷纲`}
              </h3>
              <button
                onClick={() => setShowVolumeOutlineModal(false)}
                className="p-2 hover:bg-secondary rounded-lg transition-all shrink-0"
              >
                <X size={20} />
              </button>
            </div>
            <div
              className="flex-1 overflow-y-auto p-6 min-h-0 overscroll-contain"
              onWheel={(e) => {
                const target = e.currentTarget;
                const isAtTop = target.scrollTop === 0;
                const isAtBottom = target.scrollHeight - target.scrollTop === target.clientHeight;

                // Prevent scroll propagation when at boundaries
                if ((isAtTop && e.deltaY < 0) || (isAtBottom && e.deltaY > 0)) {
                  e.stopPropagation();
                }
              }}
              onTouchMove={(e) => {
                // Prevent touch scroll propagation
                e.stopPropagation();
              }}
            >
              {loadingVolumeOutline ? (
                <div className="flex items-center justify-center h-64">
                  <div className="w-8 h-8 border-2 border-primary/20 border-t-primary rounded-full animate-spin" />
                </div>
              ) : selectedVolumeOutline?.outline ? (
                <div className="prose prose-sm max-w-none dark:prose-invert">
                  <div className="whitespace-pre-wrap text-sm text-muted-foreground">
                    {selectedVolumeOutline.outline}
                  </div>
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center h-64 text-center text-muted-foreground">
                  <FileText size={48} className="mb-4 opacity-50" />
                  <p>暂无卷纲内容</p>
                </div>
              )}
            </div>
            <div className="flex items-center justify-end gap-2 p-6 border-t border-border/40 relative shrink-0">
              <button
                onClick={() => setShowVolumeOutlineModal(false)}
                className="px-4 py-2 text-sm font-bold bg-secondary text-secondary-foreground rounded-lg hover:bg-secondary/80 transition-all shrink-0"
              >
                关闭
              </button>
              {selectedVolumeOutline && (
                <button
                  onClick={() => {
                    if (selectedVolumeOutline.isDetail) {
                      generateVolumeDetailOutline(selectedVolumeOutline.volumeId);
                    } else {
                      rewriteVolumeOutline(selectedVolumeOutline.volumeId);
                    }
                    setShowVolumeOutlineModal(false);
                  }}
                  className="flex items-center gap-2 px-4 py-2 text-sm font-bold bg-amber-500/10 text-amber-600 rounded-lg hover:bg-amber-500/20 transition-all shrink-0"
                >
                  <RefreshCw size={14} />
                  {selectedVolumeOutline.isDetail ? '重写详细卷纲' : '重写卷纲'}
                </button>
              )}
            </div>
          </div>
        </div>,
        document.body
      )}

      <div className="max-w-5xl mx-auto space-y-6">
        {/* Breadcrumb */}
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <button onClick={nav.toDashboard} className={c.link}>{t("bread.books")}</button>
          <span className="text-border">/</span>
          <span className="truncate max-w-[200px]">{book.title}</span>
        </div>

      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="font-serif text-3xl">{book.title}</h1>
          <div className="flex items-center gap-3 mt-2 text-sm text-muted-foreground">
            <span className="px-2 py-0.5 rounded bg-secondary text-secondary-foreground text-xs font-medium">
              {book.genre}
            </span>
            <span>{chapters.length} {t("dash.chapters")}</span>
            <span>·</span>
            <span>{book.chapterWordCount} {t("book.wordsPerChapter")}</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={nav.toChat}
            className="flex items-center gap-2 px-4 py-2 text-sm font-bold bg-secondary text-secondary-foreground rounded-lg hover:scale-105 active:scale-95 transition-all"
          >
            <MessageSquare size={16} />
            AI 助手
          </button>
          <button
            onClick={handleWriteNext}
            disabled={writing}
            className={`flex items-center gap-2 px-4 py-2 text-sm font-bold rounded-lg transition-all ${
              writing
                ? "bg-muted text-muted-foreground cursor-not-allowed"
                : "bg-primary text-primary-foreground hover:scale-105 active:scale-95"
            }`}
          >
            {writing ? <div className="w-4 h-4 border-2 border-primary-foreground/20 border-t-primary-foreground rounded-full animate-spin" /> : <Zap size={16} />}
            {writing ? t("dash.writing") : t("dash.writeNext")}
          </button>
          <button
            onClick={() => setConfirmDeleteOpen(true)}
            disabled={deleting}
            className="flex items-center gap-2 px-4 py-2 text-sm font-bold bg-destructive text-destructive-foreground rounded-lg hover:scale-105 active:scale-95 transition-all disabled:opacity-50"
          >
            {deleting ? <div className="w-4 h-4 border-2 border-destructive-foreground/20 border-t-destructive-foreground rounded-full animate-spin" /> : <Trash2 size={16} />}
            {t("book.deleteBook")}
          </button>
        </div>
      </div>

      {/* Action Bar */}
      <div className="flex flex-wrap items-center gap-2 py-1">
        {reviewCount > 0 && (
          <button
            onClick={handleApproveAll}
            className="flex items-center gap-2 px-4 py-2 text-xs font-bold bg-emerald-500/10 text-emerald-600 rounded-lg hover:bg-emerald-500/20 transition-all border border-emerald-500/20"
          >
            <CheckCheck size={14} />
            {t("book.approveAll")} ({reviewCount})
          </button>
        )}
        <button
          onClick={() => (nav as { toTruth?: (id: string) => void }).toTruth?.(bookId)}
          className="flex items-center gap-2 px-4 py-2 text-xs font-bold bg-secondary/50 text-muted-foreground rounded-lg hover:text-foreground hover:bg-secondary transition-all border border-border/50"
        >
          <Database size={14} />
          {t("book.truthFiles")}
        </button>
        <button
          onClick={() => nav.toAnalytics(bookId)}
          className="flex items-center gap-2 px-4 py-2 text-xs font-bold bg-secondary/50 text-muted-foreground rounded-lg hover:text-foreground hover:bg-secondary transition-all border border-border/50"
        >
          <BarChart2 size={14} />
          {t("book.analytics")}
        </button>
        <button
          onClick={handleFixChapterOrder}
          className="flex items-center gap-2 px-4 py-2 text-xs font-bold bg-secondary/50 text-muted-foreground rounded-lg hover:text-foreground hover:bg-secondary transition-all border border-border/50"
        >
          <RefreshCw size={14} />
          {t("book.fixOrder")}
        </button>
        <button
          onClick={() => setShowOutlineRegenerate(true)}
          className="flex items-center gap-2 px-4 py-2 text-xs font-bold bg-secondary/50 text-muted-foreground rounded-lg hover:text-foreground hover:bg-secondary transition-all border border-border/50"
        >
          <Wand2 size={14} />
          重新生成大纲
        </button>
        <button
          onClick={loadAuditConfig}
          disabled={loadingAuditConfig}
          className="flex items-center gap-2 px-4 py-2 text-xs font-bold bg-secondary/50 text-muted-foreground rounded-lg hover:text-foreground hover:bg-secondary transition-all border border-border/50 disabled:opacity-50"
        >
          {loadingAuditConfig ? <div className="w-4 h-4 border-2 border-muted-foreground/20 border-t-muted-foreground rounded-full animate-spin" /> : <ShieldCheck size={14} />}
          审计配置
        </button>
        <RAGSupplementButton bookId={bookId} />
        <div className="flex items-center gap-2">
          <select
            value={exportFormat}
            onChange={(e) => setExportFormat(e.target.value as ExportFormat)}
            className="px-2 py-2 text-xs font-bold bg-secondary/50 text-muted-foreground rounded-lg border border-border/50 outline-none"
          >
            <option value="txt">TXT</option>
            <option value="md">MD</option>
            <option value="epub">EPUB</option>
          </select>
          <label className="flex items-center gap-1.5 text-xs font-bold text-muted-foreground cursor-pointer select-none">
            <input
              type="checkbox"
              checked={exportApprovedOnly}
              onChange={(e) => setExportApprovedOnly(e.target.checked)}
              className="rounded border-border/50"
            />
            {t("book.approvedOnly")}
          </label>
          <button
            onClick={async () => {
              try {
                const data = await fetchJson<{ path?: string; chapters?: number }>(`/books/${bookId}/export-save`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ format: exportFormat, approvedOnly: exportApprovedOnly }),
                });
                showAlertDialog(`${t("common.exportSuccess")}\n${data.path}\n(${data.chapters} ${t("dash.chapters")})`);
              } catch (e) {
                showAlertDialog(e instanceof Error ? e.message : "Export failed");
              }
            }}
            className="flex items-center gap-2 px-4 py-2 text-xs font-bold bg-secondary/50 text-muted-foreground rounded-lg hover:text-foreground hover:bg-secondary transition-all border border-border/50"
          >
            <Download size={14} />
            {t("book.export")}
          </button>
        </div>
      </div>

      {/* Book Settings */}
      <div className="paper-sheet rounded-2xl border border-border/40 shadow-sm p-6">
        <h2 className="text-sm font-bold uppercase tracking-widest text-muted-foreground mb-4">{t("book.settings")}</h2>
        <div className="flex flex-wrap items-end gap-4">
          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">{t("create.wordsPerChapter")}</label>
            <input
              type="number"
              value={currentWordCount}
              onChange={(e) => setSettingsWordCount(Number(e.target.value))}
              className="px-3 py-2 text-sm rounded-lg border border-border/50 bg-secondary/30 outline-none focus:border-primary/50 w-32"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">{t("create.targetChapters")}</label>
            <input
              type="number"
              value={currentTargetChapters}
              onChange={(e) => setSettingsTargetChapters(Number(e.target.value))}
              className="px-3 py-2 text-sm rounded-lg border border-border/50 bg-secondary/30 outline-none focus:border-primary/50 w-32"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">{t("book.status")}</label>
            <select
              value={currentStatus}
              onChange={(e) => setSettingsStatus(e.target.value as BookStatus)}
              className="px-3 py-2 text-sm rounded-lg border border-border/50 bg-secondary/30 outline-none focus:border-primary/50"
            >
              <option value="active">{t("book.statusActive")}</option>
              <option value="paused">{t("book.statusPaused")}</option>
              <option value="outlining">{t("book.statusOutlining")}</option>
              <option value="completed">{t("book.statusCompleted")}</option>
              <option value="dropped">{t("book.statusDropped")}</option>
            </select>
          </div>
          {(settingsWordCount !== null || settingsTargetChapters !== null || settingsStatus !== null) && (
            <button
              onClick={handleSaveSettings}
              disabled={savingSettings}
              className="flex items-center gap-2 px-4 py-2 text-xs font-bold bg-primary text-primary-foreground rounded-lg hover:scale-105 active:scale-95 transition-all disabled:opacity-50"
            >
              {savingSettings ? <div className="w-4 h-4 border-2 border-primary-foreground/20 border-t-primary-foreground rounded-full animate-spin" /> : <Save size={14} />}
              {t("common.save")}
            </button>
          )}
        </div>
      </div>

      {/* Tabs for Chapters and Volume Plans */}
      <div className="paper-sheet rounded-2xl border border-border/40 shadow-sm overflow-hidden">
        <div className="flex border-b border-border/40">
          <button
            onClick={() => setActiveTab('chapters')}
            className={`flex-1 py-4 px-6 text-sm font-bold uppercase tracking-widest transition-colors ${activeTab === 'chapters' ? 'bg-primary/10 text-primary border-b-2 border-primary' : 'text-muted-foreground hover:text-foreground'}`}
          >
            {t("book.chapters")}
          </button>
          <button
            onClick={() => {
              setActiveTab('volume-plans');
              loadVolumePlans();
            }}
            className={`flex-1 py-4 px-6 text-sm font-bold uppercase tracking-widest transition-colors ${activeTab === 'volume-plans' ? 'bg-primary/10 text-primary border-b-2 border-primary' : 'text-muted-foreground hover:text-foreground'}`}
          >
            卷纲
          </button>
        </div>

        {/* Chapters Tab */}
        {activeTab === 'chapters' && (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border/40">
                  <th className="text-left px-6 py-4 font-bold text-[11px] uppercase tracking-widest text-muted-foreground w-20">{t("book.chapter")}</th>
                  <th className="text-left px-6 py-4 font-bold text-[11px] uppercase tracking-widest text-muted-foreground">{t("book.title")}</th>
                  <th className="text-left px-6 py-4 font-bold text-[11px] uppercase tracking-widest text-muted-foreground w-24">{t("book.words")}</th>
                  <th className="text-left px-6 py-4 font-bold text-[11px] uppercase tracking-widest text-muted-foreground w-36">{t("book.status")}</th>
                  <th className="text-right px-6 py-4 font-bold text-[11px] uppercase tracking-widest text-muted-foreground w-24">{t("book.actions")}</th>
                </tr>
              </thead>
              <tbody>
                {chapters.map((ch) => (
                  <tr key={ch.number} className="border-b border-border/20 hover:bg-secondary/20 transition-colors group">
                    <td className="px-6 py-4 text-sm font-medium">{ch.number}</td>
                    <td className="px-6 py-4">
                      <button
                        onClick={() => nav.toChapter(bookId, ch.number)}
                        className={`text-sm font-medium text-left hover:underline ${c.link}`}
                      >
                        {ch.title || `${t("chapter.label", { n: ch.number })}`}
                      </button>
                    </td>
                    <td className="px-6 py-4 text-sm text-muted-foreground">{ch.wordCount.toLocaleString()}</td>
                    <td className="px-6 py-4">
                      <div className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-tight ${STATUS_CONFIG[ch.status]?.color ?? "bg-muted text-muted-foreground"}`}>
                        {STATUS_CONFIG[ch.status]?.icon}
                        {translateChapterStatus(ch.status, t)}
                      </div>
                    </td>
                    <td className="px-6 py-4 text-right">
                      <div className="flex gap-1.5 justify-end">
                        {ch.status === "ready-for-review" && (
                          <>
                            <button
                              onClick={async () => { await postApi(`/books/${bookId}/chapters/${ch.number}/approve`); refetch(); }}
                              className="p-2 rounded-lg bg-emerald-500/10 text-emerald-600 hover:bg-emerald-500 hover:text-white transition-all shadow-sm"
                              title={t("book.approve")}
                            >
                              <Check size={14} />
                            </button>
                            <button
                              onClick={async () => { await postApi(`/books/${bookId}/chapters/${ch.number}/reject`); refetch(); }}
                              className="p-2 rounded-lg bg-destructive/10 text-destructive hover:bg-destructive hover:text-white transition-all shadow-sm"
                              title={t("book.reject")}
                            >
                              <X size={14} />
                            </button>
                          </>
                        )}
                        <button
                          onClick={async () => {
                            const auditResult = await fetchJson<{ passed?: boolean; issues?: unknown[] }>(`/books/${bookId}/audit/${ch.number}`, { method: "POST" });
                            alert(auditResult.passed ? "Audit passed" : `Audit failed: ${auditResult.issues?.length ?? 0} issues`);
                            refetch();
                          }}
                          className="p-2 rounded-lg bg-secondary text-muted-foreground hover:text-primary hover:bg-primary/10 transition-all shadow-sm"
                          title={t("book.audit")}
                        >
                          <ShieldCheck size={14} />
                        </button>
                        <button
                          onClick={() => handleRewrite(ch.number)}
                          disabled={rewritingChapters.includes(ch.number)}
                          className="p-2 rounded-lg bg-secondary text-muted-foreground hover:text-primary hover:bg-primary/10 transition-all shadow-sm disabled:opacity-50"
                          title={t("book.rewrite")}
                        >
                          {rewritingChapters.includes(ch.number)
                            ? <div className="w-3.5 h-3.5 border-2 border-muted-foreground/20 border-t-muted-foreground rounded-full animate-spin" />
                            : <RotateCcw size={14} />}
                        </button>
                        <button
                          onClick={() => handleSync(ch.number)}
                          disabled={syncingChapters.includes(ch.number) || ch.number !== latestPersistedChapter}
                          className="p-2 rounded-lg bg-secondary text-muted-foreground hover:text-primary hover:bg-primary/10 transition-all shadow-sm disabled:opacity-50"
                          title={data?.book.language === "en" ? "Sync truth/state from edited chapter" : "根据已编辑章节同步 truth/state"}
                        >
                          {syncingChapters.includes(ch.number)
                            ? <div className="w-3.5 h-3.5 border-2 border-muted-foreground/20 border-t-muted-foreground rounded-full animate-spin" />
                            : <RefreshCw size={14} />}
                        </button>
                        <select
                          disabled={revisingChapters.includes(ch.number)}
                          value=""
                          onChange={(e) => {
                            const mode = e.target.value as ReviseMode;
                            if (mode) handleRevise(ch.number, mode);
                          }}
                          className="px-2 py-1.5 text-[11px] font-bold rounded-lg bg-secondary text-muted-foreground border border-border/50 outline-none hover:text-primary hover:bg-primary/10 transition-all disabled:opacity-50 cursor-pointer"
                          title="Revise with AI"
                        >
                          <option value="" disabled>{revisingChapters.includes(ch.number) ? t("common.loading") : t("book.curate")}</option>
                          <option value="spot-fix">{t("book.spotFix")}</option>
                          <option value="polish">{t("book.polish")}</option>
                          <option value="rewrite">{t("book.rewrite")}</option>
                          <option value="rework">{t("book.rework")}</option>
                          <option value="anti-detect">{t("book.antiDetect")}</option>
                        </select>
                        <button
                          onClick={() => handleDeleteChapter(ch.number)}
                          disabled={deletingChapters.includes(ch.number)}
                          className="p-2 rounded-lg bg-destructive/10 text-destructive hover:bg-destructive hover:text-white transition-all shadow-sm disabled:opacity-50"
                          title={t("book.delete")}
                        >
                          {deletingChapters.includes(ch.number)
                            ? <div className="w-3.5 h-3.5 border-2 border-destructive/20 border-t-destructive rounded-full animate-spin" />
                            : <Trash2 size={14} />}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Volume Plans Tab */}
        {activeTab === 'volume-plans' && (
          <div className="p-6">
            {loadingVolumePlans ? (
              <div className="flex items-center justify-center h-64">
                <div className="w-8 h-8 border-2 border-primary/20 border-t-primary rounded-full animate-spin" />
              </div>
            ) : volumePlans && volumePlans.length > 0 ? (
              <div className="space-y-4">
                {/* 批量操作栏 */}
                <div className="flex items-center justify-between p-4 bg-secondary/20 rounded-lg border border-border/20">
                  <div className="flex items-center gap-2">
                    <Database size={20} className="text-primary" />
                    <span className="font-bold">卷纲管理</span>
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={reparseVolumePlans}
                      disabled={reparsingVolumePlans}
                      className="flex items-center gap-2 px-4 py-2 text-sm font-bold bg-secondary text-secondary-foreground rounded-lg hover:bg-secondary/80 transition-all disabled:opacity-50"
                      title="重写大纲后使用：根据最新的 volume_outline.md 重新拆分分卷"
                    >
                      {reparsingVolumePlans ? (
                        <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                      ) : (
                        <RefreshCw size={16} />
                      )}
                      重新拆分分卷
                    </button>
                    <button
                      onClick={generateAllVolumeDetailOutlines}
                      className="flex items-center gap-2 px-4 py-2 text-sm font-bold bg-primary text-primary-foreground rounded-lg hover:bg-primary/80 transition-all"
                    >
                      <Sparkles size={16} />
                      生成所有详细卷纲
                    </button>
                  </div>
                </div>
                
                {volumePlans.map((volume: any) => {
                  const detailOutline = volumeDetailOutlines[volume.volumeId];
                  const isLoading = loadingVolumeDetail[volume.volumeId];
                  
                  return (
                    <div key={volume.volumeId} className="border border-border/40 rounded-xl p-6">
                      <div className="flex items-center justify-between mb-4">
                        <div className="flex items-center gap-4">
                          <h3 className="text-xl font-bold">{volume.title}</h3>
                          {detailOutline?.exists && (
                            <div className="text-xs text-emerald-600 bg-emerald-50 px-2 py-1 rounded">
                              已生成详细卷纲
                            </div>
                          )}
                        </div>
                        <div className="flex flex-col items-end gap-2">
                          <div className="flex gap-2">
                            {isLoading ? (
                              <div className="w-6 h-6 border-2 border-primary/20 border-t-primary rounded-full animate-spin" />
                            ) : detailOutline?.exists ? (
                              <>
                                <button
                                  onClick={() => viewVolumeOutline(volume.volumeId)}
                                  className="flex items-center gap-2 px-4 py-2 text-xs font-bold bg-primary/10 text-primary rounded-lg hover:bg-primary/20 transition-all"
                                >
                                  <BookOpen size={14} />
                                  查看卷纲
                                </button>
                                <button
                                  onClick={() => generateVolumeDetailOutline(volume.volumeId)}
                                  disabled={isLoading}
                                  className="flex items-center gap-2 px-4 py-2 text-xs font-bold bg-amber-500/10 text-amber-600 rounded-lg hover:bg-amber-500/20 transition-all disabled:opacity-50"
                                >
                                  <RefreshCw size={14} />
                                  重写卷纲
                                </button>
                              </>
                            ) : (
                              <button
                                onClick={() => generateVolumeDetailOutline(volume.volumeId)}
                                disabled={isLoading}
                                className="flex items-center gap-2 px-4 py-2 text-xs font-bold bg-primary text-primary-foreground rounded-lg hover:bg-primary/80 transition-all disabled:opacity-50"
                              >
                                <Sparkles size={14} />
                                生成分卷卷纲
                              </button>
                            )}
                          </div>
                          {isLoading && (
                            <span className="text-xs text-amber-600 animate-pulse">
                              {detailOutline?.exists ? '重写卷纲中...' : '生成卷纲中...'}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="text-sm text-muted-foreground">
                        章节范围：{volume.chapterRange.start}-{volume.chapterRange.end} 章
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center h-64 text-center text-muted-foreground">
                <Database size={48} className="mb-4 opacity-50" />
                <p>未加载卷纲和章节规划</p>
                <div className="flex gap-2 mt-4">
                  <button
                    onClick={loadVolumePlans}
                    className="px-4 py-2 text-sm font-bold bg-primary text-primary-foreground rounded-lg hover:scale-105 active:scale-95 transition-all"
                  >
                    加载卷纲和章节规划
                  </button>
                  {volumePlans && volumePlans.length > 0 && (
                    <button
                      onClick={generateAllVolumeDetailOutlines}
                      className="px-4 py-2 text-sm font-bold bg-secondary text-secondary-foreground rounded-lg hover:scale-105 active:scale-95 transition-all"
                    >
                      <Sparkles size={16} className="inline mr-2" />
                      生成所有分卷卷纲
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>



      {/* Delete Confirmation */}
      <ConfirmDialog
        open={confirmDeleteOpen}
        title={t("book.confirmDeleteTitle")}
        message={t("book.confirmDeleteMessage")}
        confirmLabel={t("book.deleteBook")}
        cancelLabel={t("common.cancel")}
        variant="danger"
        onConfirm={handleDeleteBook}
        onCancel={() => setConfirmDeleteOpen(false)}
      />

      {/* Audit Config Modal */}
      {showAuditConfig && auditConfig && (
        <div className="fixed inset-0 flex items-start justify-center z-[100] pt-20">
          <div className="bg-card rounded-2xl shadow-xl max-w-4xl w-full mx-4 flex flex-col" style={{ height: 'clamp(400px, 80vh, 1200px)' }}>
            {/* Header */}
            <div className="flex items-center justify-between p-6 border-b border-border/50 shrink-0">
              <h2 className="text-xl font-bold">审计配置</h2>
              <button
                onClick={() => setShowAuditConfig(false)}
                className="p-2 rounded-lg hover:bg-primary/10 transition-colors"
              >
                <X size={20} />
              </button>
            </div>

            {/* Tabs */}
            <div className="flex gap-2 px-6 pt-4 border-b border-border/50 pb-2 shrink-0">
              <button
                onClick={() => setActiveAuditTab("dimensions")}
                className={`px-4 py-2 text-sm font-medium rounded-t-lg transition-colors ${
                  activeAuditTab === "dimensions"
                    ? "bg-primary/10 text-primary border-b-2 border-primary"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                审计维度
              </button>
              <button
                onClick={() => setActiveAuditTab("validation")}
                className={`px-4 py-2 text-sm font-medium rounded-t-lg transition-colors ${
                  activeAuditTab === "validation"
                    ? "bg-primary/10 text-primary border-b-2 border-primary"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                验证规则
              </button>
              <button
                onClick={() => setActiveAuditTab("chapter")}
                className={`px-4 py-2 text-sm font-medium rounded-t-lg transition-colors ${
                  activeAuditTab === "chapter"
                    ? "bg-primary/10 text-primary border-b-2 border-primary"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                章节审计标准
              </button>
              <button
                onClick={() => setActiveAuditTab("foundation")}
                className={`px-4 py-2 text-sm font-medium rounded-t-lg transition-colors ${
                  activeAuditTab === "foundation"
                    ? "bg-primary/10 text-primary border-b-2 border-primary"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                基础审核标准
              </button>
              <button
                onClick={() => setActiveAuditTab("help")}
                className={`px-4 py-2 text-sm font-medium rounded-t-lg transition-colors ${
                  activeAuditTab === "help"
                    ? "bg-primary/10 text-primary border-b-2 border-primary"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                配置说明
              </button>
            </div>

            {/* Tab Content - Scrollable */}
            <div className="flex-1 overflow-y-auto px-6 py-4">
              {activeAuditTab === "dimensions" && (
                <div className="space-y-6">
                  {/* Critical */}
                  <div>
                    <h3 className="text-sm font-bold mb-3 flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full bg-red-500"></span>
                      Critical - 严重问题
                    </h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      {auditConfig.dimensions.filter((d: any) => d.severity === "critical").map((dim: any) => (
                        <div key={dim.id} className="flex items-center gap-2 p-3 rounded-lg border border-red-200 bg-red-50/30">
                          <input
                            type="checkbox"
                            checked={dim.enabled}
                            onChange={(e) => {
                              const updated = [...auditConfig.dimensions];
                              const realIndex = auditConfig.dimensions.findIndex((d: any) => d.id === dim.id);
                              updated[realIndex] = { ...updated[realIndex], enabled: e.target.checked };
                              setAuditConfig({ ...auditConfig, dimensions: updated });
                            }}
                            className="rounded border-border/50"
                          />
                          <div className="flex-1">
                            <div className="font-medium">{dim.name}</div>
                            <div className="text-xs text-muted-foreground">ID: {dim.id}</div>
                          </div>
                          <div className="w-16">
                            <input
                              type="number"
                              value={dim.weight}
                              onChange={(e) => {
                                const updated = [...auditConfig.dimensions];
                                const realIndex = auditConfig.dimensions.findIndex((d: any) => d.id === dim.id);
                                updated[realIndex] = { ...updated[realIndex], weight: Number(e.target.value) };
                                setAuditConfig({ ...auditConfig, dimensions: updated });
                              }}
                              min="0"
                              step="0.1"
                              className="w-full px-2 py-1 text-sm rounded border border-border/50 bg-secondary/30"
                            />
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Warning */}
                  <div>
                    <h3 className="text-sm font-bold mb-3 flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full bg-yellow-500"></span>
                      Warning - 警告问题
                    </h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      {auditConfig.dimensions.filter((d: any) => d.severity === "warning").map((dim: any) => (
                        <div key={dim.id} className="flex items-center gap-2 p-3 rounded-lg border border-yellow-200 bg-yellow-50/30">
                          <input
                            type="checkbox"
                            checked={dim.enabled}
                            onChange={(e) => {
                              const updated = [...auditConfig.dimensions];
                              const realIndex = auditConfig.dimensions.findIndex((d: any) => d.id === dim.id);
                              updated[realIndex] = { ...updated[realIndex], enabled: e.target.checked };
                              setAuditConfig({ ...auditConfig, dimensions: updated });
                            }}
                            className="rounded border-border/50"
                          />
                          <div className="flex-1">
                            <div className="font-medium">{dim.name}</div>
                            <div className="text-xs text-muted-foreground">ID: {dim.id}</div>
                          </div>
                          <div className="w-16">
                            <input
                              type="number"
                              value={dim.weight}
                              onChange={(e) => {
                                const updated = [...auditConfig.dimensions];
                                const realIndex = auditConfig.dimensions.findIndex((d: any) => d.id === dim.id);
                                updated[realIndex] = { ...updated[realIndex], weight: Number(e.target.value) };
                                setAuditConfig({ ...auditConfig, dimensions: updated });
                              }}
                              min="0"
                              step="0.1"
                              className="w-full px-2 py-1 text-sm rounded border border-border/50 bg-secondary/30"
                            />
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Info */}
                  <div>
                    <h3 className="text-sm font-bold mb-3 flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full bg-blue-500"></span>
                      Info - 提示问题
                    </h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      {auditConfig.dimensions.filter((d: any) => d.severity === "info").map((dim: any) => (
                        <div key={dim.id} className="flex items-center gap-2 p-3 rounded-lg border border-blue-200 bg-blue-50/30">
                          <input
                            type="checkbox"
                            checked={dim.enabled}
                            onChange={(e) => {
                              const updated = [...auditConfig.dimensions];
                              const realIndex = auditConfig.dimensions.findIndex((d: any) => d.id === dim.id);
                              updated[realIndex] = { ...updated[realIndex], enabled: e.target.checked };
                              setAuditConfig({ ...auditConfig, dimensions: updated });
                            }}
                            className="rounded border-border/50"
                          />
                          <div className="flex-1">
                            <div className="font-medium">{dim.name}</div>
                            <div className="text-xs text-muted-foreground">ID: {dim.id}</div>
                          </div>
                          <div className="w-16">
                            <input
                              type="number"
                              value={dim.weight}
                              onChange={(e) => {
                                const updated = [...auditConfig.dimensions];
                                const realIndex = auditConfig.dimensions.findIndex((d: any) => d.id === dim.id);
                                updated[realIndex] = { ...updated[realIndex], weight: Number(e.target.value) };
                                setAuditConfig({ ...auditConfig, dimensions: updated });
                              }}
                              min="0"
                              step="0.1"
                              className="w-full px-2 py-1 text-sm rounded border border-border/50 bg-secondary/30"
                            />
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {activeAuditTab === "validation" && (
                <div className="space-y-6">
                  <div>
                    <h3 className="text-sm font-bold mb-3">禁止句式</h3>
                    <div className="space-y-2">
                      {auditConfig.validationRules.bannedPatterns.map((pattern: string, index: number) => (
                        <div key={index} className="flex items-center gap-2">
                          <input
                            type="text"
                            value={pattern}
                            onChange={(e) => {
                              const updated = [...auditConfig.validationRules.bannedPatterns];
                              updated[index] = e.target.value;
                              setAuditConfig({
                                ...auditConfig,
                                validationRules: { ...auditConfig.validationRules, bannedPatterns: updated }
                              });
                            }}
                            className="flex-1 px-3 py-2 text-sm rounded border border-border/50 bg-secondary/30"
                            placeholder="输入正则表达式"
                          />
                          <button
                            onClick={() => {
                              const updated = auditConfig.validationRules.bannedPatterns.filter((_: string, i: number) => i !== index);
                              setAuditConfig({
                                ...auditConfig,
                                validationRules: { ...auditConfig.validationRules, bannedPatterns: updated }
                              });
                            }}
                            className="p-2 text-destructive hover:bg-destructive/10 rounded-lg transition-colors"
                          >
                            <X size={16} />
                          </button>
                        </div>
                      ))}
                      <button
                        onClick={() => {
                          setAuditConfig({
                            ...auditConfig,
                            validationRules: {
                              ...auditConfig.validationRules,
                              bannedPatterns: [...auditConfig.validationRules.bannedPatterns, ""]
                            }
                          });
                        }}
                        className="w-full py-2 text-sm text-primary border border-dashed border-primary/30 rounded-lg hover:bg-primary/5 transition-colors"
                      >
                        + 添加禁止句式
                      </button>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div>
                      <label className="flex items-center gap-2 mb-2">
                        <input
                          type="checkbox"
                          checked={auditConfig.validationRules.bannedDashes}
                          onChange={(e) => setAuditConfig({
                            ...auditConfig,
                            validationRules: { ...auditConfig.validationRules, bannedDashes: e.target.checked }
                          })}
                          className="rounded border-border/50"
                        />
                        <span className="text-sm font-medium">禁止破折号</span>
                      </label>
                    </div>

                    <div>
                      <label className="block text-sm font-medium mb-2">转折词密度限制</label>
                      <input
                        type="number"
                        value={auditConfig.validationRules.transitionWordDensity}
                        onChange={(e) => setAuditConfig({
                          ...auditConfig,
                          validationRules: { ...auditConfig.validationRules, transitionWordDensity: Number(e.target.value) }
                        })}
                        min="0"
                        max="1"
                        step="0.01"
                        className="w-full px-3 py-2 text-sm rounded border border-border/50 bg-secondary/30"
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium mb-2">疲劳词限制</label>
                      <input
                        type="number"
                        value={auditConfig.validationRules.fatigueWordLimit}
                        onChange={(e) => setAuditConfig({
                          ...auditConfig,
                          validationRules: { ...auditConfig.validationRules, fatigueWordLimit: Number(e.target.value) }
                        })}
                        min="1"
                        className="w-full px-3 py-2 text-sm rounded border border-border/50 bg-secondary/30"
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium mb-2">最大连续"了"字数</label>
                      <input
                        type="number"
                        value={auditConfig.validationRules.maxConsecutiveLe}
                        onChange={(e) => setAuditConfig({
                          ...auditConfig,
                          validationRules: { ...auditConfig.validationRules, maxConsecutiveLe: Number(e.target.value) }
                        })}
                        min="1"
                        className="w-full px-3 py-2 text-sm rounded border border-border/50 bg-secondary/30"
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium mb-2">最大段落长度</label>
                      <input
                        type="number"
                        value={auditConfig.validationRules.maxParagraphLength}
                        onChange={(e) => setAuditConfig({
                          ...auditConfig,
                          validationRules: { ...auditConfig.validationRules, maxParagraphLength: Number(e.target.value) }
                        })}
                        min="1"
                        className="w-full px-3 py-2 text-sm rounded border border-border/50 bg-secondary/30"
                      />
                    </div>
                  </div>
                </div>
              )}

              {activeAuditTab === "chapter" && (
                <div className="space-y-6">
                  <div>
                    <h3 className="text-sm font-bold mb-3">章节审核通过标准</h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div>
                        <label className="block text-xs text-muted-foreground mb-1">最低通过分数</label>
                        <input
                          type="number"
                          value={auditConfig.chapterAudit?.minPassScore ?? 60}
                          onChange={(e) => setAuditConfig({
                            ...auditConfig,
                            chapterAudit: { ...auditConfig.chapterAudit, minPassScore: Number(e.target.value) }
                          })}
                          min="0"
                          max="100"
                          className="w-full px-3 py-2 text-sm rounded border border-border/50 bg-secondary/30"
                        />
                      </div>
                      <div>
                        <label className="block text-xs text-muted-foreground mb-1">最大 Critical 问题数</label>
                        <input
                          type="number"
                          value={auditConfig.chapterAudit?.maxCriticalIssues ?? 0}
                          onChange={(e) => setAuditConfig({
                            ...auditConfig,
                            chapterAudit: { ...auditConfig.chapterAudit, maxCriticalIssues: Number(e.target.value) }
                          })}
                          min="0"
                          className="w-full px-3 py-2 text-sm rounded border border-border/50 bg-secondary/30"
                        />
                      </div>
                      <div>
                        <label className="block text-xs text-muted-foreground mb-1">最大 Warning 问题数</label>
                        <input
                          type="number"
                          value={auditConfig.chapterAudit?.maxWarningIssues ?? 3}
                          onChange={(e) => setAuditConfig({
                            ...auditConfig,
                            chapterAudit: { ...auditConfig.chapterAudit, maxWarningIssues: Number(e.target.value) }
                          })}
                          min="0"
                          className="w-full px-3 py-2 text-sm rounded border border-border/50 bg-secondary/30"
                        />
                      </div>
                      <div>
                        <label className="block text-xs text-muted-foreground mb-1">最大总问题数</label>
                        <input
                          type="number"
                          value={auditConfig.chapterAudit?.maxTotalIssues ?? 5}
                          onChange={(e) => setAuditConfig({
                            ...auditConfig,
                            chapterAudit: { ...auditConfig.chapterAudit, maxTotalIssues: Number(e.target.value) }
                          })}
                          min="0"
                          className="w-full px-3 py-2 text-sm rounded border border-border/50 bg-secondary/30"
                        />
                      </div>
                    </div>
                  </div>

                  <div>
                    <h3 className="text-sm font-bold mb-3">分值计算规则</h3>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                      <div>
                        <label className="block text-xs text-muted-foreground mb-1">Critical 扣分权重</label>
                        <input
                          type="number"
                          value={auditConfig.chapterAudit?.scoring?.criticalIssueWeight ?? 5}
                          onChange={(e) => setAuditConfig({
                            ...auditConfig,
                            chapterAudit: {
                              ...auditConfig.chapterAudit,
                              scoring: { ...auditConfig.chapterAudit?.scoring, criticalIssueWeight: Number(e.target.value) }
                            }
                          })}
                          min="0"
                          step="0.1"
                          className="w-full px-3 py-2 text-sm rounded border border-border/50 bg-secondary/30"
                        />
                      </div>
                      <div>
                        <label className="block text-xs text-muted-foreground mb-1">Warning 扣分权重</label>
                        <input
                          type="number"
                          value={auditConfig.chapterAudit?.scoring?.warningIssueWeight ?? 2}
                          onChange={(e) => setAuditConfig({
                            ...auditConfig,
                            chapterAudit: {
                              ...auditConfig.chapterAudit,
                              scoring: { ...auditConfig.chapterAudit?.scoring, warningIssueWeight: Number(e.target.value) }
                            }
                          })}
                          min="0"
                          step="0.1"
                          className="w-full px-3 py-2 text-sm rounded border border-border/50 bg-secondary/30"
                        />
                      </div>
                      <div>
                        <label className="block text-xs text-muted-foreground mb-1">Info 扣分权重</label>
                        <input
                          type="number"
                          value={auditConfig.chapterAudit?.scoring?.infoIssueWeight ?? 0.5}
                          onChange={(e) => setAuditConfig({
                            ...auditConfig,
                            chapterAudit: {
                              ...auditConfig.chapterAudit,
                              scoring: { ...auditConfig.chapterAudit?.scoring, infoIssueWeight: Number(e.target.value) }
                            }
                          })}
                          min="0"
                          step="0.1"
                          className="w-full px-3 py-2 text-sm rounded border border-border/50 bg-secondary/30"
                        />
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {activeAuditTab === "foundation" && (
                <div className="space-y-6">
                  <div>
                    <h3 className="text-sm font-bold mb-3">基础审核（大纲审核）通过标准</h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                      <div>
                        <label className="block text-xs text-muted-foreground mb-1">总分通过阈值</label>
                        <input
                          type="number"
                          value={auditConfig.foundationReview?.passThreshold ?? 80}
                          onChange={(e) => setAuditConfig({
                            ...auditConfig,
                            foundationReview: { ...auditConfig.foundationReview, passThreshold: Number(e.target.value) }
                          })}
                          min="0"
                          max="100"
                          className="w-full px-3 py-2 text-sm rounded border border-border/50 bg-secondary/30"
                        />
                      </div>
                      <div>
                        <label className="block text-xs text-muted-foreground mb-1">单个维度最低分</label>
                        <input
                          type="number"
                          value={auditConfig.foundationReview?.dimensionFloor ?? 60}
                          onChange={(e) => setAuditConfig({
                            ...auditConfig,
                            foundationReview: { ...auditConfig.foundationReview, dimensionFloor: Number(e.target.value) }
                          })}
                          min="0"
                          max="100"
                          className="w-full px-3 py-2 text-sm rounded border border-border/50 bg-secondary/30"
                        />
                      </div>
                    </div>
                    <h4 className="text-xs font-bold text-muted-foreground mb-2 mt-4">各维度权重</h4>
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                      <div className="p-3 rounded-lg border border-border/50">
                        <div className="text-xs text-muted-foreground mb-1">核心冲突</div>
                        <input
                          type="number"
                          value={auditConfig.foundationReview?.weights?.coreConflict ?? 1}
                          onChange={(e) => setAuditConfig({
                            ...auditConfig,
                            foundationReview: {
                              ...auditConfig.foundationReview,
                              weights: { ...auditConfig.foundationReview?.weights, coreConflict: Number(e.target.value) }
                            }
                          })}
                          min="0"
                          step="0.1"
                          className="w-full px-2 py-1 text-sm rounded border border-border/50 bg-secondary/30"
                        />
                      </div>
                      <div className="p-3 rounded-lg border border-border/50">
                        <div className="text-xs text-muted-foreground mb-1">开篇节奏</div>
                        <input
                          type="number"
                          value={auditConfig.foundationReview?.weights?.openingMomentum ?? 1}
                          onChange={(e) => setAuditConfig({
                            ...auditConfig,
                            foundationReview: {
                              ...auditConfig.foundationReview,
                              weights: { ...auditConfig.foundationReview?.weights, openingMomentum: Number(e.target.value) }
                            }
                          })}
                          min="0"
                          step="0.1"
                          className="w-full px-2 py-1 text-sm rounded border border-border/50 bg-secondary/30"
                        />
                      </div>
                      <div className="p-3 rounded-lg border border-border/50">
                        <div className="text-xs text-muted-foreground mb-1">世界一致性</div>
                        <input
                          type="number"
                          value={auditConfig.foundationReview?.weights?.worldConsistency ?? 1}
                          onChange={(e) => setAuditConfig({
                            ...auditConfig,
                            foundationReview: {
                              ...auditConfig.foundationReview,
                              weights: { ...auditConfig.foundationReview?.weights, worldConsistency: Number(e.target.value) }
                            }
                          })}
                          min="0"
                          step="0.1"
                          className="w-full px-2 py-1 text-sm rounded border border-border/50 bg-secondary/30"
                        />
                      </div>
                      <div className="p-3 rounded-lg border border-border/50">
                        <div className="text-xs text-muted-foreground mb-1">角色区分度</div>
                        <input
                          type="number"
                          value={auditConfig.foundationReview?.weights?.characterDifferentiation ?? 1}
                          onChange={(e) => setAuditConfig({
                            ...auditConfig,
                            foundationReview: {
                              ...auditConfig.foundationReview,
                              weights: { ...auditConfig.foundationReview?.weights, characterDifferentiation: Number(e.target.value) }
                            }
                          })}
                          min="0"
                          step="0.1"
                          className="w-full px-2 py-1 text-sm rounded border border-border/50 bg-secondary/30"
                        />
                      </div>
                      <div className="p-3 rounded-lg border border-border/50">
                        <div className="text-xs text-muted-foreground mb-1">节奏可行性</div>
                        <input
                          type="number"
                          value={auditConfig.foundationReview?.weights?.pacingFeasibility ?? 1}
                          onChange={(e) => setAuditConfig({
                            ...auditConfig,
                            foundationReview: {
                              ...auditConfig.foundationReview,
                              weights: { ...auditConfig.foundationReview?.weights, pacingFeasibility: Number(e.target.value) }
                            }
                          })}
                          min="0"
                          step="0.1"
                          className="w-full px-2 py-1 text-sm rounded border border-border/50 bg-secondary/30"
                        />
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {activeAuditTab === "help" && (
                <div className="space-y-6 text-sm">
                  <div>
                    <h3 className="text-base font-bold mb-3 flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full bg-primary"></span>
                      审计维度权重
                    </h3>
                    <p className="text-muted-foreground mb-2">影响该维度在 AI 审核时的重要性提示。</p>
                    <ul className="list-disc list-inside space-y-1 text-muted-foreground ml-2">
                      <li><strong>权重 = 1.0</strong>：正常审核该维度</li>
                      <li><strong>权重 &gt; 1.0</strong>：AI 会更加关注该维度的问题（如 1.5、2.0）</li>
                      <li><strong>权重 &lt; 1.0</strong>：AI 会相对放宽该维度的检查（如 0.5）</li>
                    </ul>
                  </div>

                  <div>
                    <h3 className="text-base font-bold mb-3 flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full bg-red-500"></span>
                      Critical / Warning / Info 分类
                    </h3>
                    <ul className="list-disc list-inside space-y-1 text-muted-foreground ml-2">
                      <li><strong className="text-red-500">Critical</strong>：严重问题，直接影响内容质量，必须修复</li>
                      <li><strong className="text-yellow-500">Warning</strong>：警告问题，影响阅读体验，建议修复</li>
                      <li><strong className="text-blue-500">Info</strong>：提示问题，轻微影响，可选修复</li>
                    </ul>
                  </div>

                  <div>
                    <h3 className="text-base font-bold mb-3 flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full bg-emerald-500"></span>
                      章节审计通过标准
                    </h3>
                    <p className="text-muted-foreground mb-2">章节审核必须同时满足以下条件才算通过：</p>
                    <ol className="list-decimal list-inside space-y-1 text-muted-foreground ml-2">
                      <li>Critical 问题数 ≤ 设定的最大值</li>
                      <li>Warning 问题数 ≤ 设定的最大值</li>
                      <li>总问题数 ≤ 设定的最大值</li>
                      <li><strong>加权评分 ≥ 最低通过分数</strong></li>
                    </ol>
                    <div className="mt-2 p-3 bg-secondary/30 rounded-lg text-xs">
                      <strong>加权评分计算公式：</strong><br/>
                      分数 = 100 - (Critical数 × Critical权重) - (Warning数 × Warning权重) - (Info数 × Info权重)
                    </div>
                  </div>

                  <div>
                    <h3 className="text-base font-bold mb-3 flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full bg-purple-500"></span>
                      基础审核（大纲审核）标准
                    </h3>
                    <ul className="list-disc list-inside space-y-1 text-muted-foreground ml-2">
                      <li><strong>总分通过阈值</strong>：大纲审核的总分必须达到此分数才算通过（默认80）</li>
                      <li><strong>单个维度最低分</strong>：每个维度的得分不能低于此分数（默认60）</li>
                      <li><strong>各维度权重</strong>：影响该维度在总分计算中的占比</li>
                    </ul>
                  </div>

                  <div>
                    <h3 className="text-base font-bold mb-3 flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full bg-orange-500"></span>
                      验证规则
                    </h3>
                    <ul className="list-disc list-inside space-y-1 text-muted-foreground ml-2">
                      <li><strong>禁止句式</strong>：检测并标记特定的句式模式</li>
                      <li><strong>禁止破折号</strong>：是否允许使用破折号</li>
                      <li><strong>转折词密度</strong>：控制"但是"、"然而"等转折词的使用频率</li>
                      <li><strong>对话密度</strong>：控制对话在章节中的占比</li>
                    </ul>
                  </div>

                  <div>
                    <h3 className="text-base font-bold mb-3 flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full bg-teal-500"></span>
                      章节状态说明
                    </h3>
                    <p className="text-muted-foreground mb-3">章节在其生命周期中会经历以下状态：</p>
                    <div className="space-y-2">
                      <div className="grid grid-cols-2 gap-2 text-xs">
                        <div className="p-2 rounded bg-slate-100">
                          <span className="font-medium text-slate-700">card-generated</span>
                          <span className="text-slate-500 ml-2">卡片已生成</span>
                        </div>
                        <div className="p-2 rounded bg-blue-50">
                          <span className="font-medium text-blue-600">drafting</span>
                          <span className="text-blue-500 ml-2">创作中</span>
                        </div>
                        <div className="p-2 rounded bg-blue-50">
                          <span className="font-medium text-blue-600">drafted</span>
                          <span className="text-blue-500 ml-2">已创作</span>
                        </div>
                        <div className="p-2 rounded bg-purple-50">
                          <span className="font-medium text-purple-600">auditing</span>
                          <span className="text-purple-500 ml-2">审核中</span>
                        </div>
                        <div className="p-2 rounded bg-emerald-50">
                          <span className="font-medium text-emerald-600">audit-passed</span>
                          <span className="text-emerald-500 ml-2">审核通过</span>
                        </div>
                        <div className="p-2 rounded bg-red-50">
                          <span className="font-medium text-red-600">audit-failed</span>
                          <span className="text-red-500 ml-2">审核失败</span>
                        </div>
                        <div className="p-2 rounded bg-amber-50">
                          <span className="font-medium text-amber-600">state-degraded</span>
                          <span className="text-amber-500 ml-2">状态降级</span>
                        </div>
                        <div className="p-2 rounded bg-orange-50">
                          <span className="font-medium text-orange-600">revising</span>
                          <span className="text-orange-500 ml-2">修订中</span>
                        </div>
                        <div className="p-2 rounded bg-yellow-50">
                          <span className="font-medium text-yellow-600">ready-for-review</span>
                          <span className="text-yellow-500 ml-2">待审核</span>
                        </div>
                        <div className="p-2 rounded bg-teal-50">
                          <span className="font-medium text-teal-600">approved</span>
                          <span className="text-teal-500 ml-2">已批准</span>
                        </div>
                        <div className="p-2 rounded bg-rose-50">
                          <span className="font-medium text-rose-600">rejected</span>
                          <span className="text-rose-500 ml-2">已拒绝</span>
                        </div>
                        <div className="p-2 rounded bg-indigo-50">
                          <span className="font-medium text-indigo-600">published</span>
                          <span className="text-indigo-500 ml-2">已发布</span>
                        </div>
                        <div className="p-2 rounded bg-gray-50">
                          <span className="font-medium text-gray-600">imported</span>
                          <span className="text-gray-500 ml-2">已导入</span>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="p-4 bg-blue-50/50 border border-blue-200 rounded-lg">
                    <h3 className="text-base font-bold mb-2 text-blue-700">配置建议</h3>
                    <ul className="list-disc list-inside space-y-1 text-blue-600/80 text-xs ml-2">
                      <li>严格审核：Critical 权重设为 3-5，minPassScore 设为 70-80</li>
                      <li>宽松审核：Critical 权重设为 1-2，minPassScore 设为 50-60</li>
                      <li>重点关注某维度：将该维度 weight 设为 1.5-2.0</li>
                      <li>忽略某维度：将该维度 weight 设为 0.5 或直接禁用</li>
                    </ul>
                  </div>
                </div>
              )}
            </div>

            {/* Save Button - Fixed at bottom */}
            <div className="flex justify-end p-6 border-t border-border/50 shrink-0 bg-card rounded-b-2xl">
              <button
                onClick={() => setShowAuditConfig(false)}
                className="px-4 py-2 text-sm font-bold bg-secondary text-foreground rounded-lg hover:bg-secondary/80 transition-all border border-border/50 mr-2"
              >
                取消
              </button>
              <button
                onClick={saveAuditConfig}
                disabled={savingAuditConfig}
                className="flex items-center gap-2 px-4 py-2 text-sm font-bold bg-primary text-primary-foreground rounded-lg hover:scale-105 active:scale-95 transition-all disabled:opacity-50"
              >
                {savingAuditConfig ? <div className="w-4 h-4 border-2 border-primary-foreground/20 border-t-primary-foreground rounded-full animate-spin" /> : <Save size={14} />}
                {savingAuditConfig ? "保存中" : "保存"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Outline Regenerate Modal */}
      {showOutlineRegenerate && (
        <div className="fixed inset-0 flex items-start justify-center z-[100] pt-20">
          <div className="bg-card rounded-2xl shadow-xl max-w-2xl w-full mx-4 flex flex-col" style={{ height: 'clamp(400px, 80vh, 800px)' }}>
            {/* Header */}
            <div className="flex items-center justify-between p-6 border-b border-border/50 shrink-0">
              <h2 className="text-xl font-bold flex items-center gap-2">
                <Wand2 size={20} className="text-primary" />
                重新生成大纲
              </h2>
              <button
                onClick={() => setShowOutlineRegenerate(false)}
                className="p-2 rounded-lg hover:bg-primary/10 transition-colors"
              >
                <X size={20} />
              </button>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto px-6 py-6 space-y-6">
              {/* Genre Selection */}
              <div>
                <label className="block text-sm font-medium mb-2">书籍题材 <span className="text-destructive">*</span></label>
                <div className="grid grid-cols-3 gap-2">
                  {genreData?.genres?.filter((g: GenreInfo) => g.language === (book.language ?? "zh") || g.source === "project").map((g: GenreInfo) => (
                    <button
                      key={g.id}
                      onClick={() => setOutlineGenre(g.id)}
                      className={`px-3 py-2.5 rounded-md text-sm text-left transition-all ${
                        outlineGenre === g.id
                          ? "bg-primary/15 text-primary border border-primary/30 font-medium"
                          : "bg-secondary text-secondary-foreground border border-transparent hover:border-border"
                      }`}
                    >
                      {g.name}
                      {g.source === "project" && <span className="text-xs text-muted-foreground ml-1">✦</span>}
                    </button>
                  ))}
                </div>
              </div>

              {/* Brief File Upload */}
              <div>
                <label className="block text-sm font-medium mb-2">创作简报（可选）</label>
                <div className="flex items-center gap-3 p-3 border border-border/50 rounded-md bg-secondary/30">
                  <label className="flex items-center gap-2 px-3 py-2 text-sm bg-primary/10 text-primary rounded-md hover:bg-primary/20 cursor-pointer transition-colors">
                    <input
                      type="file"
                      accept=".txt,.md"
                      onChange={handleOutlineFileChange}
                      className="hidden"
                    />
                    <span className="text-lg">📁</span>
                    <span>上传简报文件</span>
                  </label>
                  {outlineFileName && (
                    <span className="text-sm text-muted-foreground truncate max-w-[200px]">
                      {outlineFileName}
                    </span>
                  )}
                  <span className="text-xs text-muted-foreground ml-auto">支持 .txt, .md</span>
                </div>
              </div>

              {/* Brief Text Input */}
              <div>
                <label className="block text-sm font-medium mb-2">大纲设定（可选）</label>
                <div className="relative">
                  <textarea
                    value={outlineBrief}
                    onChange={(e) => {
                      setOutlineBrief(e.target.value);
                      setOutlineFileName("");
                    }}
                    placeholder="在此输入大纲设定、创作方向、核心设定等内容...&#10;&#10;这些信息将帮助 Architect 更好地理解你的创作意图，生成符合预期的大纲。"
                    className={`w-full ${c.input} rounded-md px-4 py-3 focus:outline-none min-h-[200px] resize-y`}
                  />
                  {outlineBrief && (
                    <button
                      onClick={() => {
                        setOutlineBrief("");
                        setOutlineFileName("");
                      }}
                      className="absolute top-2 right-2 p-1 text-muted-foreground hover:text-foreground transition-colors"
                      title="清除内容"
                    >
                      ✕
                    </button>
                  )}
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  💡 提示：上传文件与手动输入二选一，优先使用文件内容。设定越详细，生成的大纲越符合预期。
                </p>
              </div>
            </div>

            {/* Footer */}
            <div className="flex justify-end p-6 border-t border-border/50 shrink-0 bg-card rounded-b-2xl">
              <button
                onClick={() => setShowOutlineRegenerate(false)}
                className="px-4 py-2 text-sm font-bold bg-secondary text-foreground rounded-lg hover:bg-secondary/80 transition-all border border-border/50 mr-2"
              >
                取消
              </button>
              <button
                onClick={handleRegenerateOutline}
                disabled={regeneratingOutline || !outlineGenre}
                className="flex items-center gap-2 px-4 py-2 text-sm font-bold bg-primary text-primary-foreground rounded-lg hover:scale-105 active:scale-95 transition-all disabled:opacity-50"
              >
                {regeneratingOutline ? <div className="w-4 h-4 border-2 border-primary-foreground/20 border-t-primary-foreground rounded-full animate-spin" /> : <Wand2 size={14} />}
                {regeneratingOutline ? "生成中..." : "开始生成"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Volume Outline Regenerate Modal */}
      {showVolumeOutlineRegenerate && (
        <div className="fixed inset-0 flex items-center justify-center z-[100] p-4">
          <div className="bg-card rounded-2xl shadow-xl max-w-2xl w-full flex flex-col" style={{ height: 'clamp(400px, 80vh, 800px)' }}>
            {/* Header */}
            <div className="flex items-center justify-between p-6 border-b border-border/50 shrink-0">
              <h2 className="text-xl font-bold flex items-center gap-2">
                <Wand2 size={20} className="text-primary" />
                重生成卷纲
              </h2>
              <button
                onClick={() => setShowVolumeOutlineRegenerate(false)}
                className="p-2 rounded-lg hover:bg-primary/10 transition-colors"
              >
                <X size={20} />
              </button>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto px-6 py-6 space-y-6">
              {/* Author Intent Input */}
              <div>
                <label className="block text-sm font-medium mb-2">作者意图 <span className="text-destructive">*</span></label>
                <div className="relative">
                  <textarea
                    value={authorIntent}
                    onChange={(e) => setAuthorIntent(e.target.value)}
                    placeholder="请输入你的创作意图，例如：\n- 希望增加更多动作场景\n- 强化主角与反派的冲突\n- 调整故事节奏，加快情节发展\n- 增加更多情感描写"
                    className={`w-full ${c.input} rounded-md px-4 py-3 focus:outline-none min-h-[200px] resize-y`}
                  />
                  {authorIntent && (
                    <button
                      onClick={() => setAuthorIntent("")}
                      className="absolute top-2 right-2 p-1 text-muted-foreground hover:text-foreground transition-colors"
                      title="清除内容"
                    >
                      ✕
                    </button>
                  )}
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  💡 提示：作者意图越详细，生成的卷纲越符合你的预期。
                </p>
              </div>

              {/* Rewrite Level Selection */}
              <div>
                <label className="block text-sm font-medium mb-2">重写幅度</label>
                <div className="grid grid-cols-3 gap-2">
                  <button
                    onClick={() => setRewriteLevel("low")}
                    className={`px-3 py-2.5 rounded-md text-sm text-left transition-all ${
                      rewriteLevel === "low"
                        ? "bg-primary/15 text-primary border border-primary/30 font-medium"
                        : "bg-secondary text-secondary-foreground border border-transparent hover:border-border"
                    }`}
                  >
                    低
                    <div className="text-xs text-muted-foreground mt-1">保留大部分原有情节</div>
                  </button>
                  <button
                    onClick={() => setRewriteLevel("medium")}
                    className={`px-3 py-2.5 rounded-md text-sm text-left transition-all ${
                      rewriteLevel === "medium"
                        ? "bg-primary/15 text-primary border border-primary/30 font-medium"
                        : "bg-secondary text-secondary-foreground border border-transparent hover:border-border"
                    }`}
                  >
                    中
                    <div className="text-xs text-muted-foreground mt-1">适度调整情节结构</div>
                  </button>
                  <button
                    onClick={() => setRewriteLevel("high")}
                    className={`px-3 py-2.5 rounded-md text-sm text-left transition-all ${
                      rewriteLevel === "high"
                        ? "bg-primary/15 text-primary border border-primary/30 font-medium"
                        : "bg-secondary text-secondary-foreground border border-transparent hover:border-border"
                    }`}
                  >
                    高
                    <div className="text-xs text-muted-foreground mt-1">重新设计情节结构</div>
                  </button>
                </div>
              </div>
            </div>

            {/* Footer */}
            <div className="flex justify-end p-6 border-t border-border/50 shrink-0 bg-card rounded-b-2xl">
              <button
                onClick={() => setShowVolumeOutlineRegenerate(false)}
                className="px-4 py-2 text-sm font-bold bg-secondary text-foreground rounded-lg hover:bg-secondary/80 transition-all border border-border/50 mr-2"
              >
                取消
              </button>
              <button
                onClick={handleRegenerateVolumeOutline}
                disabled={regeneratingVolumeOutline || !authorIntent.trim()}
                className="flex items-center gap-2 px-4 py-2 text-sm font-bold bg-primary text-primary-foreground rounded-lg hover:scale-105 active:scale-95 transition-all disabled:opacity-50"
              >
                {regeneratingVolumeOutline ? <div className="w-4 h-4 border-2 border-primary-foreground/20 border-t-primary-foreground rounded-full animate-spin" /> : <Wand2 size={14} />}
                {regeneratingVolumeOutline ? "生成中..." : "开始生成"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Volume Outline Preview Modal */}
      {showVolumeOutlinePreview && (
        <div className="fixed inset-0 flex items-center justify-center z-[100] p-4">
          <div className="bg-card rounded-2xl shadow-xl max-w-3xl w-full flex flex-col" style={{ height: 'clamp(400px, 80vh, 800px)' }}>
            {/* Header */}
            <div className="flex items-center justify-between p-6 border-b border-border/50 shrink-0">
              <h2 className="text-xl font-bold flex items-center gap-2">
                <FileText size={20} className="text-primary" />
                卷纲预览
              </h2>
              <button
                onClick={() => setShowVolumeOutlinePreview(false)}
                className="p-2 rounded-lg hover:bg-primary/10 transition-colors"
              >
                <X size={20} />
              </button>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto px-6 py-6">
              <div className="prose max-w-none">
                {generatedVolumeOutline.split('\n').map((line, index) => (
                  <p key={index}>{line}</p>
                ))}
              </div>
            </div>

            {/* Footer */}
            <div className="flex justify-end p-6 border-t border-border/50 shrink-0 bg-card rounded-b-2xl">
              <button
                onClick={() => setShowVolumeOutlinePreview(false)}
                className="px-4 py-2 text-sm font-bold bg-secondary text-foreground rounded-lg hover:bg-secondary/80 transition-all border border-border/50 mr-2"
              >
                取消
              </button>
              <button
                onClick={handleConfirmVolumeOutline}
                disabled={regeneratingVolumeOutline}
                className="flex items-center gap-2 px-4 py-2 text-sm font-bold bg-primary text-primary-foreground rounded-lg hover:scale-105 active:scale-95 transition-all disabled:opacity-50"
              >
                {regeneratingVolumeOutline ? <div className="w-4 h-4 border-2 border-primary-foreground/20 border-t-primary-foreground rounded-full animate-spin" /> : <Check size={14} />}
                {regeneratingVolumeOutline ? "确认中..." : "确认更新"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Custom Alert Dialog */}
      {showAlert && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[9999] p-4" style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0 }}>
          <div className="bg-card rounded-xl max-w-md w-full overflow-hidden flex flex-col relative" style={{ zIndex: 10000 }}>
            <div className="flex items-center justify-between p-6 border-b border-border/40 shrink-0">
              <h3 className="text-xl font-bold">提示</h3>
              <button
                onClick={() => setShowAlert(false)}
                className="p-2 hover:bg-secondary rounded-lg transition-all shrink-0"
              >
                <X size={20} />
              </button>
            </div>
            <div className="p-6">
              <p className="text-sm text-muted-foreground whitespace-pre-wrap">{alertMessage}</p>
            </div>
            <div className="flex items-center justify-end gap-2 p-6 border-t border-border/40 shrink-0">
              <button
                onClick={() => setShowAlert(false)}
                className="px-4 py-2 text-sm font-bold bg-primary text-primary-foreground rounded-lg hover:bg-primary/80 transition-all shrink-0"
              >
                确定
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Custom Confirm Dialog */}
      {showConfirm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[9999] p-4" style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0 }}>
          <div className="bg-card rounded-xl max-w-md w-full overflow-hidden flex flex-col relative" style={{ zIndex: 10000 }}>
            <div className="flex items-center justify-between p-6 border-b border-border/40 shrink-0">
              <h3 className="text-xl font-bold">{confirmTitle}</h3>
              <button
                onClick={() => {
                  setShowConfirm(false);
                  setConfirmCallback(null);
                }}
                className="p-2 hover:bg-secondary rounded-lg transition-all shrink-0"
              >
                <X size={20} />
              </button>
            </div>
            <div className="p-6">
              <p className="text-sm text-muted-foreground whitespace-pre-wrap">{confirmMessage}</p>
            </div>
            <div className="flex items-center justify-end gap-2 p-6 border-t border-border/40 shrink-0">
              <button
                onClick={() => {
                  setShowConfirm(false);
                  setConfirmCallback(null);
                }}
                className="px-4 py-2 text-sm font-bold bg-secondary text-secondary-foreground rounded-lg hover:bg-secondary/80 transition-all shrink-0"
              >
                取消
              </button>
              <button
                onClick={() => {
                  setShowConfirm(false);
                  if (confirmCallback) {
                    confirmCallback();
                  }
                }}
                className="px-4 py-2 text-sm font-bold bg-primary text-primary-foreground rounded-lg hover:bg-primary/80 transition-all shrink-0"
              >
                确定
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Custom Input Dialog */}
      {showInputDialog && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[9999] p-4" style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0 }}>
          <div className="bg-card rounded-xl max-w-md w-full overflow-hidden flex flex-col relative" style={{ zIndex: 10000 }}>
            <div className="flex items-center justify-between p-6 border-b border-border/40 shrink-0">
              <h3 className="text-xl font-bold">{inputDialogTitle}</h3>
              <button
                onClick={() => {
                  setShowInputDialog(false);
                  if (inputDialogCallback) {
                    inputDialogCallback(null);
                  }
                  setInputDialogCallback(null);
                }}
                className="p-2 hover:bg-secondary rounded-lg transition-all shrink-0"
              >
                <X size={20} />
              </button>
            </div>
            <div className="p-6 space-y-4">
              <p className="text-sm text-muted-foreground">{inputDialogMessage}</p>
              <textarea
                value={inputDialogValue}
                onChange={(e) => setInputDialogValue(e.target.value)}
                className="w-full px-3 py-2 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary resize-none"
                rows={4}
                placeholder=""
                autoFocus
              />
            </div>
            <div className="flex items-center justify-end gap-2 p-6 border-t border-border/40 shrink-0">
              <button
                onClick={() => {
                  setShowInputDialog(false);
                  if (inputDialogCallback) {
                    inputDialogCallback(null);
                  }
                  setInputDialogCallback(null);
                }}
                className="px-4 py-2 text-sm font-bold bg-secondary text-secondary-foreground rounded-lg hover:bg-secondary/80 transition-all shrink-0"
              >
                取消
              </button>
              <button
                onClick={() => {
                  setShowInputDialog(false);
                  if (inputDialogCallback) {
                    inputDialogCallback(inputDialogValue);
                  }
                  setInputDialogCallback(null);
                }}
                className="px-4 py-2 text-sm font-bold bg-primary text-primary-foreground rounded-lg hover:bg-primary/80 transition-all shrink-0"
              >
                确定
              </button>
            </div>
          </div>
        </div>
      )}
      </div>
    </>
  );
}

// Default chapter plan audit dimensions
const defaultChapterPlanDimensions = [
  // Critical - 严重问题（4个）
  {
    id: "outlineDeviation",
    name: "大纲偏离检测",
    enabled: true,
    weight: 5,
    severity: "critical" as const,
    description: "检测章节规划是否偏离大纲设定的核心情节和角色发展",
    checkContent: "章节目标是否与大纲节点一致，角色行为是否符合设定"
  },
  {
    id: "plotConsistency",
    name: "剧情逻辑一致性",
    enabled: true,
    weight: 5,
    severity: "critical" as const,
    description: "检测章节内部情节逻辑是否自洽，无矛盾",
    checkContent: "事件因果关系是否合理，时间线是否正确"
  },
  {
    id: "characterConsistency",
    name: "角色行为一致性",
    enabled: true,
    weight: 5,
    severity: "critical" as const,
    description: "检测角色行为是否与其性格、能力、背景设定一致",
    checkContent: "角色决策是否符合其性格，能力使用是否合理"
  },
  {
    id: "foreshadowingLogic",
    name: "伏笔逻辑合理性",
    enabled: true,
    weight: 4,
    severity: "critical" as const,
    description: "检测伏笔设置和回收是否符合逻辑",
    checkContent: "伏笔是否自然融入情节，回收是否合乎逻辑"
  },
  // Warning - 警告问题（4个）
  {
    id: "pacingCheck",
    name: "节奏把控",
    enabled: true,
    weight: 3,
    severity: "warning" as const,
    description: "检测章节节奏是否合理，避免拖沓或仓促",
    checkContent: "情节推进速度是否适中，详略分配是否合理"
  },
  {
    id: "tensionMaintenance",
    name: "悬念维护",
    enabled: true,
    weight: 3,
    severity: "warning" as const,
    description: "检测章节是否保持适当的悬念和吸引力",
    checkContent: "是否有足够的冲突和悬念，读者是否有继续阅读的动力"
  },
  {
    id: "sceneEffectiveness",
    name: "场景有效性",
    enabled: true,
    weight: 2,
    severity: "warning" as const,
    description: "检测场景设置是否服务于情节和角色",
    checkContent: "场景是否推动情节发展，是否有助于角色塑造"
  },
  {
    id: "emotionalCoherence",
    name: "情绪连贯性",
    enabled: true,
    weight: 2,
    severity: "warning" as const,
    description: "检测章节情绪基调是否连贯自然",
    checkContent: "情绪转换是否自然，是否符合情节发展"
  },
  // Info - 提示问题（2个）
  {
    id: "hookQuality",
    name: "钩子质量",
    enabled: true,
    weight: 1,
    severity: "info" as const,
    description: "检测章节开头和结尾的钩子是否有效",
    checkContent: "开头是否吸引读者，结尾是否留下悬念"
  },
  {
    id: "transitionSmoothness",
    name: "过渡平滑度",
    enabled: true,
    weight: 1,
    severity: "info" as const,
    description: "检测章节与前后文的过渡是否自然",
    checkContent: "与上一章的衔接是否流畅，是否为下一章做好铺垫"
  }
];