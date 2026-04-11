import { fetchJson, useApi, postApi, putApi } from "../hooks/use-api";
import { useEffect, useMemo, useState, useRef } from "react";
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
  Send
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
  const [activeAuditTab, setActiveAuditTab] = useState<"dimensions" | "validation" | "chapter" | "foundation" | "help">("dimensions");
  const [showOutlineRegenerate, setShowOutlineRegenerate] = useState(false);
  const [outlineGenre, setOutlineGenre] = useState("");
  const [outlineBrief, setOutlineBrief] = useState("");
  const [outlineFileName, setOutlineFileName] = useState("");
  const [regeneratingOutline, setRegeneratingOutline] = useState(false);
  
  // 卷纲重生成状态
  const [showVolumeOutlineRegenerate, setShowVolumeOutlineRegenerate] = useState(false);
  const [authorIntent, setAuthorIntent] = useState("");
  const [rewriteLevel, setRewriteLevel] = useState<"low" | "medium" | "high">("medium");
  const [regeneratingVolumeOutline, setRegeneratingVolumeOutline] = useState(false);
  const [generatedVolumeOutline, setGeneratedVolumeOutline] = useState("");
  const [showVolumeOutlinePreview, setShowVolumeOutlinePreview] = useState(false);
  const [volumePlans, setVolumePlans] = useState<any>(null);
  const [loadingVolumePlans, setLoadingVolumePlans] = useState(false);
  const [activeTab, setActiveTab] = useState<"chapters" | "volume-plans">('chapters');
  
  // Volume outline modal states
  const [showVolumeOutlineModal, setShowVolumeOutlineModal] = useState(false);
  const [selectedVolumeOutline, setSelectedVolumeOutline] = useState<any>(null);
  const [loadingVolumeOutline, setLoadingVolumeOutline] = useState(false);
  
  // Chapter plans modal states
  const [showChapterPlansModal, setShowChapterPlansModal] = useState(false);
  const [selectedVolumeChapterPlans, setSelectedVolumeChapterPlans] = useState<any>(null);
  const [loadingChapterPlans, setLoadingChapterPlans] = useState(false);
  const activity = useMemo(() => deriveBookActivity(sse.messages, bookId), [bookId, sse.messages]);
  const writing = writeRequestPending || activity.writing;
  const drafting = draftRequestPending || activity.drafting;
  const latestPersistedChapter = data ? data.nextChapter - 1 : 0;

  const loadVolumePlans = async () => {
    setLoadingVolumePlans(true);
    try {
      const response = await fetchJson(`/books/${bookId}/volume-plans`);
      setVolumePlans(response.volumePlans);
    } catch (e) {
      console.error('Failed to load volume plans:', e);
    } finally {
      setLoadingVolumePlans(false);
    }
  };

  const viewVolumeOutline = async (volumeId: number) => {
    setLoadingVolumeOutline(true);
    setShowVolumeOutlineModal(true);
    try {
      const response = await fetchJson(`/books/${bookId}/volumes/${volumeId}/outline`);
      setSelectedVolumeOutline(response);
    } catch (e) {
      console.error('Failed to load volume outline:', e);
      setSelectedVolumeOutline(null);
    } finally {
      setLoadingVolumeOutline(false);
    }
  };

  const rewriteVolumeOutline = async (volumeId: number) => {
    if (!confirm('确定要重写本卷卷纲吗？')) return;
    try {
      await postApi(`/books/${bookId}/volumes/${volumeId}/rewrite-outline`);
      alert('卷纲重写已开始，请等待完成');
      loadVolumePlans();
    } catch (e) {
      alert(e instanceof Error ? e.message : '卷纲重写失败');
    }
  };

  const viewChapterPlans = async (volumeId: number) => {
    setLoadingChapterPlans(true);
    setShowChapterPlansModal(true);
    try {
      // TODO: Implement API to get chapter plans for a volume
      // For now, just show a placeholder
      setSelectedVolumeChapterPlans({ volumeId, plans: [] });
    } catch (e) {
      console.error('Failed to load chapter plans:', e);
      setSelectedVolumeChapterPlans(null);
    } finally {
      setLoadingChapterPlans(false);
    }
  };

  const generateChapterPlans = async (volumeId: string) => {
    try {
      await postApi(`/books/${bookId}/volumes/${volumeId}/generate-plans`);
      alert('章节规划生成成功');
      loadVolumePlans();
    } catch (e) {
      alert(e instanceof Error ? e.message : '章节规划生成失败');
    }
  };

  const rewriteVolumeChapters = async (volumeId: string) => {
    if (!confirm('确定要重写本卷所有章节吗？')) return;
    try {
      await postApi(`/books/${bookId}/volumes/${volumeId}/rewrite-chapters`);
      alert('本卷章节重写已开始，请等待完成');
      refetch();
    } catch (e) {
      alert(e instanceof Error ? e.message : '章节重写失败');
    }
  };

  const markAffectedChapters = async (volumeId: string) => {
    try {
      await postApi(`/books/${bookId}/volumes/${volumeId}/mark-affected`);
      alert('受影响章节已标记，需要重新审计');
      refetch();
    } catch (e) {
      alert(e instanceof Error ? e.message : '标记受影响章节失败');
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
      await postApi(`/books/${bookId}/write`, {});
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed to start writing");
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
      alert(e instanceof Error ? e.message : "Failed to start drafting");
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
      alert(e instanceof Error ? e.message : "Failed to delete book");
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
      await postApi(`/books/${bookId}/fix-order`, {});
      alert("章节顺序已修复");
      refetch();
    } catch (e) {
      alert(e instanceof Error ? e.message : "修复章节顺序失败");
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
      alert(e instanceof Error ? e.message : "Failed to save settings");
    } finally {
      setSavingSettings(false);
    }
  };

  const loadAuditConfig = async () => {
    setLoadingAuditConfig(true);
    try {
      const config = await fetchJson(`/books/${bookId}/audit-config`);
      setAuditConfig(config);
      setShowAuditConfig(true);
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed to load audit config");
    } finally {
      setLoadingAuditConfig(false);
    }
  };

  const handleOutlineFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const ext = file.name.split(".").pop()?.toLowerCase();
    if (ext !== "txt" && ext !== "md") {
      alert("仅支持 .txt 和 .md 格式的简报文件");
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
      alert("请选择书籍题材");
      return;
    }
    setRegeneratingOutline(true);
    try {
      await postApi(`/books/${bookId}/regenerate-outline`, {
        genre: outlineGenre,
        brief: outlineBrief || undefined,
      });
      setShowOutlineRegenerate(false);
      setOutlineGenre("");
      setOutlineBrief("");
      setOutlineFileName("");
      alert("大纲重生成已开始，请等待完成");
    } catch (e) {
      alert(e instanceof Error ? e.message : "大纲重生成失败");
    } finally {
      setRegeneratingOutline(false);
    }
  };

  const handleRegenerateVolumeOutline = async () => {
    if (!authorIntent.trim()) {
      alert("请输入作者意图");
      return;
    }
    setRegeneratingVolumeOutline(true);
    try {
      const response = await postApi(`/books/${bookId}/regenerate-outline`, {
        intent: authorIntent,
        rewriteLevel,
      });
      setGeneratedVolumeOutline(response.volumeOutline);
      setShowVolumeOutlinePreview(true);
    } catch (e) {
      alert(e instanceof Error ? e.message : "卷纲重生成失败");
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
      alert("卷纲更新确认成功，已提前生成章节规划");
    } catch (e) {
      alert(e instanceof Error ? e.message : "卷纲确认失败");
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
      alert(e instanceof Error ? e.message : "Failed to save audit config");
    } finally {
      setSavingAuditConfig(false);
    }
  };

  const reviewCount = chapters.filter((ch) => ch.status === "ready-for-review").length;
  const currentStatus = settingsStatus ?? (book.status as BookStatus);

  return (
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
                alert(`${t("common.exportSuccess")}\n${data.path}\n(${data.chapters} ${t("dash.chapters")})`);
              } catch (e) {
                alert(e instanceof Error ? e.message : "Export failed");
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
            卷纲和章节规划
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
                  <tr key={ch.number} className="border-b border-border/20 hover:bg-secondary/20 transition-colors">
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
                      {ch.status === "ready-for-review" && (
                        <div className="flex items-center gap-1 mt-1">
                          <button
                            onClick={async () => {
                              try {
                                await postApi(`/books/${bookId}/chapters/${ch.number}/approve`, {});
                                refetch();
                              } catch (e) {
                                alert(e instanceof Error ? e.message : "Failed to approve");
                              }
                            }}
                            className="px-2 py-0.5 text-[10px] font-bold bg-emerald-500/10 text-emerald-600 rounded hover:bg-emerald-500/20 transition-colors"
                          >
                            {t("book.approve")}
                          </button>
                          <button
                            onClick={async () => {
                              try {
                                await postApi(`/books/${bookId}/chapters/${ch.number}/reject`, {});
                                refetch();
                              } catch (e) {
                                alert(e instanceof Error ? e.message : "Failed to reject");
                              }
                            }}
                            className="px-2 py-0.5 text-[10px] font-bold bg-destructive/10 text-destructive rounded hover:bg-destructive/20 transition-colors"
                          >
                            {t("book.reject")}
                          </button>
                        </div>
                      )}
                    </td>
                    <td className="px-6 py-4 text-right">
                      <div className="relative" ref={dropdownRef}>
                        <button
                          onClick={() => setOpenDropdown(openDropdown === ch.number ? null : ch.number)}
                          className="p-1.5 rounded-lg hover:bg-secondary/50 transition-colors"
                        >
                          <ChevronDown size={16} />
                        </button>
                        {openDropdown === ch.number && (
                          <div className="absolute right-0 top-full mt-1 w-48 bg-card border border-border/50 rounded-lg shadow-lg z-10 py-1">
                            <button
                              onClick={async () => {
                                setOpenDropdown(null);
                                try {
                                  await postApi(`/books/${bookId}/chapters/${ch.number}/audit`, {});
                                  refetch();
                                } catch (e) {
                                  alert(e instanceof Error ? e.message : "Failed to audit");
                                }
                              }}
                              className="w-full px-3 py-2 text-left text-sm hover:bg-secondary/50 transition-colors flex items-center gap-2"
                            >
                              <Search size={14} />
                              {t("book.audit")}
                            </button>
                            <button
                              onClick={async () => {
                                setOpenDropdown(null);
                                setRewritingChapters((prev) => [...prev, ch.number]);
                                try {
                                  await postApi(`/books/${bookId}/chapters/${ch.number}/rewrite`, {});
                                  refetch();
                                } catch (e) {
                                  alert(e instanceof Error ? e.message : "Failed to rewrite");
                                } finally {
                                  setRewritingChapters((prev) => prev.filter((n) => n !== ch.number));
                                }
                              }}
                              disabled={rewritingChapters.includes(ch.number)}
                              className="w-full px-3 py-2 text-left text-sm hover:bg-secondary/50 transition-colors flex items-center gap-2 disabled:opacity-50"
                            >
                              {rewritingChapters.includes(ch.number) ? <div className="w-4 h-4 border-2 border-muted-foreground/20 border-t-muted-foreground rounded-full animate-spin" /> : <RefreshCw size={14} />}
                              {t("book.rewrite")}
                            </button>
                            <button
                              onClick={async () => {
                                setOpenDropdown(null);
                                setSyncingChapters((prev) => [...prev, ch.number]);
                                try {
                                  await postApi(`/books/${bookId}/chapters/${ch.number}/sync`, {});
                                  refetch();
                                } catch (e) {
                                  alert(e instanceof Error ? e.message : "Failed to sync");
                                } finally {
                                  setSyncingChapters((prev) => prev.filter((n) => n !== ch.number));
                                }
                              }}
                              disabled={syncingChapters.includes(ch.number)}
                              className="w-full px-3 py-2 text-left text-sm hover:bg-secondary/50 transition-colors flex items-center gap-2 disabled:opacity-50"
                            >
                              {syncingChapters.includes(ch.number) ? <div className="w-4 h-4 border-2 border-muted-foreground/20 border-t-muted-foreground rounded-full animate-spin" /> : <Sparkles size={14} />}
                              {t("book.sync")}
                            </button>
                            <div className="border-t border-border/50 my-1" />
                            <button
                              onClick={async () => {
                                setOpenDropdown(null);
                                if (!confirm(t("book.confirmDelete"))) return;
                                setDeletingChapters((prev) => [...prev, ch.number]);
                                try {
                                  await fetchJson(`/books/${bookId}/chapters/${ch.number}`, { method: "DELETE" });
                                  refetch();
                                } catch (e) {
                                  alert(e instanceof Error ? e.message : "Failed to delete");
                                } finally {
                                  setDeletingChapters((prev) => prev.filter((n) => n !== ch.number));
                                }
                              }}
                              disabled={deletingChapters.includes(ch.number)}
                              className="w-full px-3 py-2 text-left text-sm hover:bg-destructive/10 text-destructive transition-colors flex items-center gap-2 disabled:opacity-50"
                            >
                              {deletingChapters.includes(ch.number) ? <div className="w-4 h-4 border-2 border-destructive/20 border-t-destructive rounded-full animate-spin" /> : <Trash2 size={14} />}
                              {t("book.delete")}
                            </button>
                          </div>
                        )}
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
                {volumePlans.map((volume: any) => (
                  <div key={volume.volumeId} className="border border-border/40 rounded-xl p-6">
                    <div className="flex items-center justify-between mb-4">
                      <div className="flex items-center gap-4">
                        <h3 className="text-xl font-bold">{volume.title}</h3>
                        <div className="text-sm text-muted-foreground">
                          章节范围：{volume.chapterRange.start}-{volume.chapterRange.end} 章
                        </div>
                      </div>
                      <div className="flex gap-2">
                        <button
                          onClick={() => viewVolumeOutline(volume.volumeId)}
                          className="flex items-center gap-2 px-4 py-2 text-xs font-bold bg-primary/10 text-primary rounded-lg hover:bg-primary/20 transition-all"
                        >
                          <BookOpen size={14} />
                          查看卷纲
                        </button>
                        <button
                          onClick={() => viewChapterPlans(volume.volumeId)}
                          className="flex items-center gap-2 px-4 py-2 text-xs font-bold bg-secondary text-secondary-foreground rounded-lg hover:bg-secondary/80 transition-all"
                        >
                          <List size={14} />
                          章节规划
                        </button>
                        <button
                          onClick={() => rewriteVolumeOutline(volume.volumeId)}
                          className="flex items-center gap-2 px-4 py-2 text-xs font-bold bg-amber-500/10 text-amber-600 rounded-lg hover:bg-amber-500/20 transition-all"
                        >
                          <RefreshCw size={14} />
                          重写卷纲
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center h-64 text-center text-muted-foreground">
                <Database size={48} className="mb-4 opacity-50" />
                <p>未加载卷纲和章节规划</p>
                <button
                  onClick={loadVolumePlans}
                  className="mt-4 px-4 py-2 text-sm font-bold bg-primary text-primary-foreground rounded-lg hover:scale-105 active:scale-95 transition-all"
                >
                  加载卷纲和章节规划
                </button>
              </div>
            )}
          </div>
        )}

        {/* Volume Outline Modal */}
        {showVolumeOutlineModal && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
            <div className="bg-card rounded-xl max-w-4xl w-full max-h-[80vh] overflow-hidden flex flex-col">
              <div className="flex items-center justify-between p-6 border-b border-border/40">
                <h3 className="text-xl font-bold">
                  {selectedVolumeOutline?.title || `第${selectedVolumeOutline?.volumeId}卷 卷纲`}
                </h3>
                <button
                  onClick={() => setShowVolumeOutlineModal(false)}
                  className="p-2 hover:bg-secondary rounded-lg transition-all"
                >
                  <X size={20} />
                </button>
              </div>
              <div className="flex-1 overflow-y-auto p-6">
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
              <div className="flex items-center justify-end gap-2 p-6 border-t border-border/40">
                <button
                  onClick={() => setShowVolumeOutlineModal(false)}
                  className="px-4 py-2 text-sm font-bold bg-secondary text-secondary-foreground rounded-lg hover:bg-secondary/80 transition-all"
                >
                  关闭
                </button>
                {selectedVolumeOutline && (
                  <button
                    onClick={() => {
                      rewriteVolumeOutline(selectedVolumeOutline.volumeId);
                      setShowVolumeOutlineModal(false);
                    }}
                    className="flex items-center gap-2 px-4 py-2 text-sm font-bold bg-amber-500/10 text-amber-600 rounded-lg hover:bg-amber-500/20 transition-all"
                  >
                    <RefreshCw size={14} />
                    重写卷纲
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Chapter Plans Modal */}
        {showChapterPlansModal && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
            <div className="bg-card rounded-xl max-w-4xl w-full max-h-[80vh] overflow-hidden flex flex-col">
              <div className="flex items-center justify-between p-6 border-b border-border/40">
                <h3 className="text-xl font-bold">
                  第{selectedVolumeChapterPlans?.volumeId}卷 章节规划
                </h3>
                <button
                  onClick={() => setShowChapterPlansModal(false)}
                  className="p-2 hover:bg-secondary rounded-lg transition-all"
                >
                  <X size={20} />
                </button>
              </div>
              <div className="flex-1 overflow-y-auto p-6">
                {loadingChapterPlans ? (
                  <div className="flex items-center justify-center h-64">
                    <div className="w-8 h-8 border-2 border-primary/20 border-t-primary rounded-full animate-spin" />
                  </div>
                ) : selectedVolumeChapterPlans?.plans && selectedVolumeChapterPlans.plans.length > 0 ? (
                  <div className="space-y-3">
                    {selectedVolumeChapterPlans.plans.map((chapter: any, index: number) => (
                      <div key={index} className="flex items-center gap-3 p-3 border border-border/20 rounded-lg">
                        <div className="w-8 h-8 flex items-center justify-center bg-primary/10 text-primary rounded-full text-sm font-bold">
                          {index + 1}
                        </div>
                        <div className="flex-1">
                          <div className="font-medium">{chapter.title}</div>
                          <div className="text-xs text-muted-foreground">{chapter.description}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="flex flex-col items-center justify-center h-64 text-center text-muted-foreground">
                    <List size={48} className="mb-4 opacity-50" />
                    <p>暂无章节规划</p>
                    <button
                      onClick={() => generateChapterPlans(String(selectedVolumeChapterPlans?.volumeId))}
                      className="mt-4 px-4 py-2 text-sm font-bold bg-primary text-primary-foreground rounded-lg hover:scale-105 active:scale-95 transition-all"
                    >
                      生成章节规划
                    </button>
                  </div>
                )}
              </div>
              <div className="flex items-center justify-end gap-2 p-6 border-t border-border/40">
                <button
                  onClick={() => setShowChapterPlansModal(false)}
                  className="px-4 py-2 text-sm font-bold bg-secondary text-secondary-foreground rounded-lg hover:bg-secondary/80 transition-all"
                >
                  关闭
                </button>
                {selectedVolumeChapterPlans && (
                  <button
                    onClick={() => {
                      generateChapterPlans(String(selectedVolumeChapterPlans.volumeId));
                      setShowChapterPlansModal(false);
                    }}
                    className="flex items-center gap-2 px-4 py-2 text-sm font-bold bg-primary text-primary-foreground rounded-lg hover:scale-105 active:scale-95 transition-all"
                  >
                    <Plus size={14} />
                    生成章节规划
                  </button>
                )}
              </div>
            </div>
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
        <div className="fixed inset-0 flex items-start justify-center z-[100] pt-20">
          <div className="bg-card rounded-2xl shadow-xl max-w-2xl w-full mx-4 flex flex-col" style={{ height: 'clamp(400px, 80vh, 800px)' }}>
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
        <div className="fixed inset-0 flex items-start justify-center z-[100] pt-20">
          <div className="bg-card rounded-2xl shadow-xl max-w-3xl w-full mx-4 flex flex-col" style={{ height: 'clamp(400px, 80vh, 800px)' }}>
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
    </div>
  );
}