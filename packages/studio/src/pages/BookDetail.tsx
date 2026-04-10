import { fetchJson, useApi, postApi } from "../hooks/use-api";
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
  const activity = useMemo(() => deriveBookActivity(sse.messages, bookId), [bookId, sse.messages]);
  const writing = writeRequestPending || activity.writing;
  const drafting = draftRequestPending || activity.drafting;
  const latestPersistedChapter = data ? data.nextChapter - 1 : 0;

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpenDropdown(null);
      }
    };
    if (openDropdown !== null) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [openDropdown]);

  useEffect(() => {
    const recent = sse.messages.at(-1);
    if (!recent) return;

    const data = recent.data as { bookId?: string } | null;
    if (data?.bookId !== bookId) return;

    if (recent.event === "write:start") {
      setWriteRequestPending(false);
      return;
    }

    if (recent.event === "draft:start") {
      setDraftRequestPending(false);
      return;
    }

    if (shouldRefetchBookView(recent, bookId)) {
      setWriteRequestPending(false);
      setDraftRequestPending(false);
      refetch();
    }
  }, [bookId, refetch, sse.messages]);

  const handleWriteNext = async () => {
    setWriteRequestPending(true);
    try {
      await postApi(`/books/${bookId}/write-next`);
    } catch (e) {
      setWriteRequestPending(false);
      alert(e instanceof Error ? e.message : "Failed");
    }
  };

  const handleDraft = async () => {
    setDraftRequestPending(true);
    try {
      await postApi(`/books/${bookId}/draft`);
    } catch (e) {
      setDraftRequestPending(false);
      alert(e instanceof Error ? e.message : "Failed");
    }
  };

  const handleDeleteBook = async () => {
    setConfirmDeleteOpen(false);
    setDeleting(true);
    try {
      const res = await fetch(`/api/books/${bookId}`, { method: "DELETE" });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error((json as { error?: string }).error ?? `${res.status}`);
      }
      nav.toDashboard();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setDeleting(false);
    }
  };

  const handleRewrite = async (chapterNum: number) => {
    const brief = window.prompt(
      data?.book.language === "en"
        ? "Optional rewrite brief for this run only. Leave blank to use existing focus."
        : "可选：输入这次重写要遵循的补充想法。留空则沿用现有 focus。",
      "",
    );
    if (brief === null) return;
    setRewritingChapters((prev) => [...prev, chapterNum]);
    try {
      await fetchJson(`/books/${bookId}/rewrite/${chapterNum}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brief: brief.trim() || undefined }),
      });
      refetch();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Rewrite failed");
    } finally {
      setRewritingChapters((prev) => prev.filter((n) => n !== chapterNum));
    }
  };

  const handleRevise = async (chapterNum: number, mode: ReviseMode) => {
    const brief = window.prompt(
      data?.book.language === "en"
        ? "Optional revise brief for this run only. Leave blank to use existing focus."
        : "可选：输入这次修订要遵循的补充想法。留空则沿用现有 focus。",
      "",
    );
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
      alert(e instanceof Error ? e.message : "Revision failed");
    } finally {
      setRevisingChapters((prev) => prev.filter((n) => n !== chapterNum));
    }
  };

  const handleSync = async (chapterNum: number) => {
    const brief = window.prompt(
      data?.book.language === "en"
        ? "Optional sync brief for interpreting the edited chapter body. Leave blank to sync directly from the text."
        : "可选：输入这次同步时要遵循的补充说明。留空则直接按正文同步。",
      "",
    );
    if (brief === null) return;
    setSyncingChapters((prev) => [...prev, chapterNum]);
    try {
      await fetchJson(`/books/${bookId}/resync/${chapterNum}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brief: brief.trim() || undefined }),
      });
      refetch();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Sync failed");
    } finally {
      setSyncingChapters((prev) => prev.filter((n) => n !== chapterNum));
    }
  };

  const handleDeleteChapter = async (chapterNum: number) => {
    if (!window.confirm(data?.book.language === "en" ? `Are you sure you want to delete chapter ${chapterNum}?` : `确定要删除第 ${chapterNum} 章吗？`)) {
      return;
    }
    setDeletingChapters((prev) => [...prev, chapterNum]);
    try {
      await fetchJson(`/books/${bookId}/chapters/${chapterNum}`, {
        method: "DELETE",
      });
      refetch();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setDeletingChapters((prev) => prev.filter((n) => n !== chapterNum));
    }
  };

  const handleFixChapterOrder = async () => {
    if (!window.confirm(data?.book.language === "en" ? "Are you sure you want to fix chapter order? This will renumber all chapters sequentially." : "确定要修复章节顺序吗？这将按顺序重新编号所有章节。")) {
      return;
    }
    try {
      const result = await fetchJson(`/books/${bookId}/chapters/fix-order`, {
        method: "POST",
      });
      alert(data?.book.language === "en" ? `Chapter order fixed. ${result.chapterCount} chapters renumbered.` : `章节顺序已修复。${result.chapterCount} 个章节已重新编号。`);
      refetch();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Fix order failed");
    }
  };

  const handleSaveSettings = async () => {
    if (!data) return;
    setSavingSettings(true);
    try {
      const body: Record<string, unknown> = {};
      if (settingsWordCount !== null) body.chapterWordCount = settingsWordCount;
      if (settingsTargetChapters !== null) body.targetChapters = settingsTargetChapters;
      if (settingsStatus !== null) body.status = settingsStatus;
      await fetchJson(`/books/${bookId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      refetch();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSavingSettings(false);
    }
  };

  const handleApproveAll = async () => {
    if (!data) return;
    const reviewable = data.chapters.filter((ch) => ch.status === "ready-for-review");
    for (const ch of reviewable) {
      await postApi(`/books/${bookId}/chapters/${ch.number}/approve`);
    }
    refetch();
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

  const saveAuditConfig = async () => {
    if (!auditConfig) return;
    setSavingAuditConfig(true);
    try {
      await fetchJson(`/books/${bookId}/audit-config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(auditConfig),
      });
      alert(t("common.saveSuccess"));
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed to save audit config");
    } finally {
      setSavingAuditConfig(false);
    }
  };

  if (loading) return (
    <div className="flex flex-col items-center justify-center py-32 space-y-4">
      <div className="w-8 h-8 border-2 border-primary/20 border-t-primary rounded-full animate-spin" />
      <span className="text-sm text-muted-foreground">{t("common.loading")}</span>
    </div>
  );

  if (error) return <div className="text-destructive p-8 bg-destructive/5 rounded-xl border border-destructive/20">Error: {error}</div>;
  if (!data) return null;

  const { book, chapters } = data;
  const totalWords = chapters.reduce((sum, ch) => sum + (ch.wordCount ?? 0), 0);
  const reviewCount = chapters.filter((ch) => ch.status === "ready-for-review").length;

  const currentWordCount = settingsWordCount ?? book.chapterWordCount;
  const currentTargetChapters = settingsTargetChapters ?? book.targetChapters ?? 0;
  const currentStatus = settingsStatus ?? (book.status as BookStatus);

  const exportHref = `/api/books/${bookId}/export?format=${exportFormat}${exportApprovedOnly ? "&approvedOnly=true" : ""}`;

  return (
    <div className="space-y-8 fade-in">
      {/* Breadcrumbs */}
      <nav className="flex items-center gap-2 text-[13px] font-medium text-muted-foreground">
        <button
          onClick={nav.toDashboard}
          className="hover:text-primary transition-colors flex items-center gap-1"
        >
          <ChevronLeft size={14} />
          {t("bread.books")}
        </button>
        <span className="text-border">/</span>
        <span className="text-foreground">{book.title}</span>
      </nav>

      {/* Header Section */}
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-6 border-b border-border/40 pb-8">
        <div className="space-y-2">
          <div className="flex items-center gap-3">
            <h1 className="text-4xl font-serif font-medium">{book.title}</h1>
            {book.language === "en" && (
              <span className="px-1.5 py-0.5 rounded border border-primary/20 text-primary text-[10px] font-bold">EN</span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-muted-foreground font-medium">
            <span className="px-2 py-0.5 rounded bg-secondary/50 text-foreground/70 uppercase tracking-wider text-xs">{book.genre}</span>
            <div className="flex items-center gap-1.5">
              <FileText size={14} />
              <span>{chapters.length} {t("dash.chapters")}</span>
            </div>
            <div className="flex items-center gap-1.5">
              <Zap size={14} />
              <span>{totalWords.toLocaleString()} {t("book.words")}</span>
            </div>
            {book.fanficMode && (
              <span className="flex items-center gap-1 text-purple-500">
                <Sparkles size={12} />
                <span className="italic">fanfic:{book.fanficMode}</span>
              </span>
            )}
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            onClick={handleWriteNext}
            disabled={writing || drafting}
            className="flex items-center gap-2 px-5 py-2.5 text-sm font-bold bg-primary text-primary-foreground rounded-xl hover:scale-105 active:scale-95 transition-all shadow-lg shadow-primary/20 disabled:opacity-50"
          >
            {writing ? <div className="w-4 h-4 border-2 border-primary-foreground/20 border-t-primary-foreground rounded-full animate-spin" /> : <Zap size={16} />}
            {writing ? t("dash.writing") : t("book.writeNext")}
          </button>
          <button
            onClick={handleDraft}
            disabled={writing || drafting}
            className="flex items-center gap-2 px-5 py-2.5 text-sm font-bold bg-secondary text-foreground rounded-xl hover:bg-secondary/80 transition-all border border-border/50 disabled:opacity-50"
          >
            {drafting ? <div className="w-4 h-4 border-2 border-muted-foreground/20 border-t-muted-foreground rounded-full animate-spin" /> : <Wand2 size={16} />}
            {drafting ? t("book.drafting") : t("book.draftOnly")}
          </button>
          <button
            onClick={() => setConfirmDeleteOpen(true)}
            disabled={deleting}
            className="flex items-center gap-2 px-5 py-2.5 text-sm font-bold bg-destructive/10 text-destructive rounded-xl hover:bg-destructive hover:text-white transition-all border border-destructive/20 disabled:opacity-50"
          >
            {deleting ? <div className="w-4 h-4 border-2 border-destructive/20 border-t-destructive rounded-full animate-spin" /> : <Trash2 size={16} />}
            {deleting ? t("common.loading") : t("book.deleteBook")}
          </button>
        </div>
      </div>

      {(writing || drafting || activity.lastError) && (
        <div
          className={`rounded-2xl border px-4 py-3 text-sm ${
            activity.lastError
              ? "border-destructive/30 bg-destructive/5 text-destructive"
              : "border-primary/20 bg-primary/[0.04] text-foreground"
          }`}
        >
          {activity.lastError ? (
            <span>
              {t("book.pipelineFailed")}: {activity.lastError}
            </span>
          ) : writing ? (
            <span>{t("book.pipelineWriting")}</span>
          ) : (
            <span>{t("book.pipelineDrafting")}</span>
          )}
        </div>
      )}

      {/* Tool Strip */}
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
          <button
            onClick={handleSaveSettings}
            disabled={savingSettings}
            className="flex items-center gap-2 px-4 py-2 text-sm font-bold bg-primary text-primary-foreground rounded-lg hover:scale-105 active:scale-95 transition-all disabled:opacity-50"
          >
            {savingSettings ? <div className="w-4 h-4 border-2 border-primary-foreground/20 border-t-primary-foreground rounded-full animate-spin" /> : <Save size={14} />}
            {savingSettings ? t("book.saving") : t("book.save")}
          </button>
        </div>
      </div>

      {/* Chapters Table */}
      <div className="paper-sheet rounded-2xl overflow-hidden border border-border/40 shadow-xl shadow-primary/5">
        <div className="overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="bg-muted/30 border-b border-border/50">
                <th className="text-left px-6 py-4 font-bold text-[11px] uppercase tracking-widest text-muted-foreground w-16">#</th>
                <th className="text-left px-6 py-4 font-bold text-[11px] uppercase tracking-widest text-muted-foreground">{t("book.manuscriptTitle")}</th>
                <th className="text-left px-6 py-4 font-bold text-[11px] uppercase tracking-widest text-muted-foreground w-28">{t("book.words")}</th>
                <th className="text-left px-6 py-4 font-bold text-[11px] uppercase tracking-widest text-muted-foreground w-36">{t("book.status")}</th>
                <th className="text-right px-6 py-4 font-bold text-[11px] uppercase tracking-widest text-muted-foreground">{t("book.curate")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/30">
              {chapters.map((ch, index) => {
                const staggerClass = `stagger-${Math.min(index + 1, 5)}`;
                return (
                <tr key={ch.number} className={`group hover:bg-primary/[0.02] transition-colors fade-in ${staggerClass}`}>
                  <td className="px-6 py-4 text-muted-foreground/60 font-mono text-xs">{ch.number.toString().padStart(2, '0')}</td>
                  <td className="px-6 py-4">
                    <button
                      onClick={() => nav.toChapter(bookId, ch.number)}
                      className="font-serif text-lg font-medium hover:text-primary transition-colors text-left"
                    >
                      {ch.title || t("chapter.label").replace("{n}", String(ch.number))}
                    </button>
                  </td>
                  <td className="px-6 py-4 text-muted-foreground font-medium tabular-nums text-xs">{(ch.wordCount ?? 0).toLocaleString()}</td>
                  <td className="px-6 py-4">
                    <div className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-tight ${STATUS_CONFIG[ch.status]?.color ?? "bg-muted text-muted-foreground"}`}>
                      {STATUS_CONFIG[ch.status]?.icon}
                      {translateChapterStatus(ch.status, t)}
                    </div>
                  </td>
                  <td className="px-6 py-4 text-right">
                    <div className="flex gap-1.5 justify-end opacity-0 group-hover:opacity-100 transition-opacity">
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
                      <button
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          handleDeleteChapter(ch.number);
                        }}
                        disabled={deletingChapters.includes(ch.number)}
                        className="p-2 rounded-lg bg-destructive/10 text-destructive hover:bg-destructive hover:text-white transition-all shadow-sm disabled:opacity-50"
                        title={t("book.delete")}
                      >
                        {deletingChapters.includes(ch.number)
                          ? <div className="w-3.5 h-3.5 border-2 border-destructive/20 border-t-destructive rounded-full animate-spin" />
                          : <Trash2 size={14} />}
                      </button>
                      <div ref={openDropdown === ch.number ? dropdownRef : undefined} className="relative">
                        <button
                          disabled={revisingChapters.includes(ch.number)}
                          onClick={() => setOpenDropdown(openDropdown === ch.number ? null : ch.number)}
                          className="px-2 py-1.5 text-[11px] font-bold rounded-lg bg-card text-foreground border border-border/50 outline-none hover:text-primary hover:bg-primary/10 transition-all disabled:opacity-50 cursor-pointer flex items-center gap-1"
                          title="Revise with AI"
                        >
                          {revisingChapters.includes(ch.number) ? t("common.loading") : t("book.curate")}
                          <ChevronDown size={10} />
                        </button>
                        {openDropdown === ch.number && (
                          <div className="absolute right-0 top-full mt-1 bg-card border border-border rounded-lg shadow-lg z-50 min-w-[120px] overflow-hidden">
                            <button
                              onClick={() => { handleRevise(ch.number, "spot-fix"); setOpenDropdown(null); }}
                              className="w-full px-3 py-2 text-[11px] font-bold text-left hover:bg-primary/10 hover:text-primary transition-colors"
                            >
                              {t("book.spotFix")}
                            </button>
                            <button
                              onClick={() => { handleRevise(ch.number, "polish"); setOpenDropdown(null); }}
                              className="w-full px-3 py-2 text-[11px] font-bold text-left hover:bg-primary/10 hover:text-primary transition-colors"
                            >
                              {t("book.polish")}
                            </button>
                            <button
                              onClick={() => { handleRevise(ch.number, "rewrite"); setOpenDropdown(null); }}
                              className="w-full px-3 py-2 text-[11px] font-bold text-left hover:bg-primary/10 hover:text-primary transition-colors"
                            >
                              {t("book.rewrite")}
                            </button>
                            <button
                              onClick={() => { handleRevise(ch.number, "rework"); setOpenDropdown(null); }}
                              className="w-full px-3 py-2 text-[11px] font-bold text-left hover:bg-primary/10 hover:text-primary transition-colors"
                            >
                              {t("book.rework")}
                            </button>
                            <button
                              onClick={() => { handleRevise(ch.number, "anti-detect"); setOpenDropdown(null); }}
                              className="w-full px-3 py-2 text-[11px] font-bold text-left hover:bg-primary/10 hover:text-primary transition-colors"
                            >
                              {t("book.antiDetect")}
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {chapters.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <div className="w-12 h-12 rounded-full bg-muted/20 flex items-center justify-center mb-4">
               <FileText size={20} className="text-muted-foreground/40" />
            </div>
            <p className="text-sm italic font-serif text-muted-foreground">
              {t("book.noChapters")}
            </p>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={confirmDeleteOpen}
        title={t("book.deleteBook")}
        message={t("book.confirmDelete")}
        confirmLabel={t("common.delete")}
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
                <div className="space-y-4">
                  <h3 className="text-sm font-bold mb-3">验证规则</h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div className="p-3 rounded-lg border border-border/50">
                      <h4 className="text-xs font-bold text-muted-foreground mb-2">禁止句式</h4>
                      <input
                        type="text"
                        value={auditConfig.validationRules?.bannedPatterns?.join(", ") || ""}
                        onChange={(e) => {
                          setAuditConfig({
                            ...auditConfig,
                            validationRules: {
                              ...auditConfig.validationRules,
                              bannedPatterns: e.target.value.split(",").map((p) => p.trim()).filter(Boolean)
                            }
                          });
                        }}
                        className="w-full px-2 py-1 text-sm rounded border border-border/50 bg-secondary/30"
                        placeholder="例如: 不是……而是……"
                      />
                    </div>
                    <div className="p-3 rounded-lg border border-border/50">
                      <h4 className="text-xs font-bold text-muted-foreground mb-2">禁止破折号</h4>
                      <input
                        type="checkbox"
                        checked={auditConfig.validationRules?.bannedDashes || false}
                        onChange={(e) => {
                          setAuditConfig({
                            ...auditConfig,
                            validationRules: {
                              ...auditConfig.validationRules,
                              bannedDashes: e.target.checked
                            }
                          });
                        }}
                        className="rounded border-border/50"
                      />
                    </div>
                    <div className="p-3 rounded-lg border border-border/50">
                      <h4 className="text-xs font-bold text-muted-foreground mb-2">转折词密度</h4>
                      <input
                        type="number"
                        value={auditConfig.validationRules?.transitionWordDensity || 1}
                        onChange={(e) => {
                          setAuditConfig({
                            ...auditConfig,
                            validationRules: {
                              ...auditConfig.validationRules,
                              transitionWordDensity: Number(e.target.value)
                            }
                          });
                        }}
                        min="0"
                        max="1"
                        step="0.01"
                        className="w-full px-2 py-1 text-sm rounded border border-border/50 bg-secondary/30"
                      />
                    </div>
                    <div className="p-3 rounded-lg border border-border/50">
                      <h4 className="text-xs font-bold text-muted-foreground mb-2">对话密度</h4>
                      <input
                        type="number"
                        value={auditConfig.validationRules?.dialogueDensity || 0.5}
                        onChange={(e) => {
                          setAuditConfig({
                            ...auditConfig,
                            validationRules: {
                              ...auditConfig.validationRules,
                              dialogueDensity: Number(e.target.value)
                            }
                          });
                        }}
                        min="0"
                        max="1"
                        step="0.01"
                        className="w-full px-2 py-1 text-sm rounded border border-border/50 bg-secondary/30"
                      />
                    </div>
                  </div>
                </div>
              )}

              {activeAuditTab === "chapter" && (
                <div className="space-y-4">
                  <h3 className="text-sm font-bold mb-3">章节审计通过标准</h3>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                    <div className="p-3 rounded-lg border border-border/50">
                      <div className="text-xs text-muted-foreground mb-1">最多 Critical 问题</div>
                      <input
                        type="number"
                        value={auditConfig.passCriteria?.chapterAudit?.maxCriticalIssues ?? 0}
                        onChange={(e) => {
                          setAuditConfig({
                            ...auditConfig,
                            passCriteria: {
                              ...auditConfig.passCriteria,
                              chapterAudit: {
                                ...auditConfig.passCriteria?.chapterAudit,
                                maxCriticalIssues: Number(e.target.value)
                              }
                            }
                          });
                        }}
                        min="0"
                        className="w-full px-2 py-1 text-sm rounded border border-border/50 bg-secondary/30"
                      />
                    </div>
                    <div className="p-3 rounded-lg border border-border/50">
                      <div className="text-xs text-muted-foreground mb-1">最多 Warning 问题</div>
                      <input
                        type="number"
                        value={auditConfig.passCriteria?.chapterAudit?.maxWarningIssues ?? 5}
                        onChange={(e) => {
                          setAuditConfig({
                            ...auditConfig,
                            passCriteria: {
                              ...auditConfig.passCriteria,
                              chapterAudit: {
                                ...auditConfig.passCriteria?.chapterAudit,
                                maxWarningIssues: Number(e.target.value)
                              }
                            }
                          });
                        }}
                        min="0"
                        className="w-full px-2 py-1 text-sm rounded border border-border/50 bg-secondary/30"
                      />
                    </div>
                    <div className="p-3 rounded-lg border border-border/50">
                      <div className="text-xs text-muted-foreground mb-1">最多总问题数</div>
                      <input
                        type="number"
                        value={auditConfig.passCriteria?.chapterAudit?.maxTotalIssues ?? 10}
                        onChange={(e) => {
                          setAuditConfig({
                            ...auditConfig,
                            passCriteria: {
                              ...auditConfig.passCriteria,
                              chapterAudit: {
                                ...auditConfig.passCriteria?.chapterAudit,
                                maxTotalIssues: Number(e.target.value)
                              }
                            }
                          });
                        }}
                        min="0"
                        className="w-full px-2 py-1 text-sm rounded border border-border/50 bg-secondary/30"
                      />
                    </div>
                  </div>
                  <h4 className="text-xs font-bold text-muted-foreground mb-2 mt-4">分值计算规则</h4>
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
                    <div className="p-3 rounded-lg border border-border/50">
                      <div className="text-xs text-muted-foreground mb-1">Critical 扣分权重</div>
                      <input
                        type="number"
                        value={auditConfig.passCriteria?.scoringRules?.criticalIssueWeight ?? 3}
                        onChange={(e) => {
                          setAuditConfig({
                            ...auditConfig,
                            passCriteria: {
                              ...auditConfig.passCriteria,
                              scoringRules: {
                                ...auditConfig.passCriteria?.scoringRules,
                                criticalIssueWeight: Number(e.target.value)
                              }
                            }
                          });
                        }}
                        min="0"
                        step="0.5"
                        className="w-full px-2 py-1 text-sm rounded border border-border/50 bg-secondary/30"
                      />
                    </div>
                    <div className="p-3 rounded-lg border border-border/50">
                      <div className="text-xs text-muted-foreground mb-1">Warning 扣分权重</div>
                      <input
                        type="number"
                        value={auditConfig.passCriteria?.scoringRules?.warningIssueWeight ?? 1}
                        onChange={(e) => {
                          setAuditConfig({
                            ...auditConfig,
                            passCriteria: {
                              ...auditConfig.passCriteria,
                              scoringRules: {
                                ...auditConfig.passCriteria?.scoringRules,
                                warningIssueWeight: Number(e.target.value)
                              }
                            }
                          });
                        }}
                        min="0"
                        step="0.5"
                        className="w-full px-2 py-1 text-sm rounded border border-border/50 bg-secondary/30"
                      />
                    </div>
                    <div className="p-3 rounded-lg border border-border/50">
                      <div className="text-xs text-muted-foreground mb-1">Info 扣分权重</div>
                      <input
                        type="number"
                        value={auditConfig.passCriteria?.scoringRules?.infoIssueWeight ?? 0.5}
                        onChange={(e) => {
                          setAuditConfig({
                            ...auditConfig,
                            passCriteria: {
                              ...auditConfig.passCriteria,
                              scoringRules: {
                                ...auditConfig.passCriteria?.scoringRules,
                                infoIssueWeight: Number(e.target.value)
                              }
                            }
                          });
                        }}
                        min="0"
                        step="0.5"
                        className="w-full px-2 py-1 text-sm rounded border border-border/50 bg-secondary/30"
                      />
                    </div>
                    <div className="p-3 rounded-lg border border-border/50">
                      <div className="text-xs text-muted-foreground mb-1">最低通过分数</div>
                      <input
                        type="number"
                        value={auditConfig.passCriteria?.scoringRules?.minPassScore ?? 60}
                        onChange={(e) => {
                          setAuditConfig({
                            ...auditConfig,
                            passCriteria: {
                              ...auditConfig.passCriteria,
                              scoringRules: {
                                ...auditConfig.passCriteria?.scoringRules,
                                minPassScore: Number(e.target.value)
                              }
                            }
                          });
                        }}
                        min="0"
                        max="100"
                        className="w-full px-2 py-1 text-sm rounded border border-border/50 bg-secondary/30"
                      />
                    </div>
                  </div>
                </div>
              )}

              {activeAuditTab === "foundation" && (
                <div className="space-y-4">
                  <h3 className="text-sm font-bold mb-3">基础审核（大纲审核）通过标准</h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div className="p-3 rounded-lg border border-border/50">
                      <h4 className="text-xs font-bold text-muted-foreground mb-2">总分通过阈值</h4>
                      <input
                        type="number"
                        value={auditConfig.foundationReview?.passThreshold ?? 80}
                        onChange={(e) => {
                          setAuditConfig({
                            ...auditConfig,
                            foundationReview: {
                              ...auditConfig.foundationReview,
                              passThreshold: Number(e.target.value)
                            }
                          });
                        }}
                        min="0"
                        max="100"
                        className="w-full px-2 py-1 text-sm rounded border border-border/50 bg-secondary/30"
                      />
                    </div>
                    <div className="p-3 rounded-lg border border-border/50">
                      <h4 className="text-xs font-bold text-muted-foreground mb-2">单个维度最低分</h4>
                      <input
                        type="number"
                        value={auditConfig.foundationReview?.dimensionFloor ?? 60}
                        onChange={(e) => {
                          setAuditConfig({
                            ...auditConfig,
                            foundationReview: {
                              ...auditConfig.foundationReview,
                              dimensionFloor: Number(e.target.value)
                            }
                          });
                        }}
                        min="0"
                        max="100"
                        className="w-full px-2 py-1 text-sm rounded border border-border/50 bg-secondary/30"
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
                        onChange={(e) => {
                          setAuditConfig({
                            ...auditConfig,
                            foundationReview: {
                              ...auditConfig.foundationReview,
                              weights: {
                                ...auditConfig.foundationReview?.weights,
                                coreConflict: Number(e.target.value)
                              }
                            }
                          });
                        }}
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
                        onChange={(e) => {
                          setAuditConfig({
                            ...auditConfig,
                            foundationReview: {
                              ...auditConfig.foundationReview,
                              weights: {
                                ...auditConfig.foundationReview?.weights,
                                openingMomentum: Number(e.target.value)
                              }
                            }
                          });
                        }}
                        min="0"
                        step="0.1"
                        className="w-full px-2 py-1 text-sm rounded border border-border/50 bg-secondary/30"
                      />
                    </div>
                    <div className="p-3 rounded-lg border border-border/50">
                      <div className="text-xs text-muted-foreground mb-1">世界一致性</div>
                      <input
                        type="number"
                        value={auditConfig.foundationReview?.weights?.worldCoherence ?? 1}
                        onChange={(e) => {
                          setAuditConfig({
                            ...auditConfig,
                            foundationReview: {
                              ...auditConfig.foundationReview,
                              weights: {
                                ...auditConfig.foundationReview?.weights,
                                worldCoherence: Number(e.target.value)
                              }
                            }
                          });
                        }}
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
                        onChange={(e) => {
                          setAuditConfig({
                            ...auditConfig,
                            foundationReview: {
                              ...auditConfig.foundationReview,
                              weights: {
                                ...auditConfig.foundationReview?.weights,
                                characterDifferentiation: Number(e.target.value)
                              }
                            }
                          });
                        }}
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
                        onChange={(e) => {
                          setAuditConfig({
                            ...auditConfig,
                            foundationReview: {
                              ...auditConfig.foundationReview,
                              weights: {
                                ...auditConfig.foundationReview?.weights,
                                pacingFeasibility: Number(e.target.value)
                              }
                            }
                          });
                        }}
                        min="0"
                        step="0.1"
                        className="w-full px-2 py-1 text-sm rounded border border-border/50 bg-secondary/30"
                      />
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
    </div>
  );
}
