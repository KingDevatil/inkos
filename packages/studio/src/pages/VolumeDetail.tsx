import { fetchJson, useApi, postApi } from "../hooks/use-api";
import { useEffect, useState } from "react";
import type { Theme } from "../hooks/use-theme";
import type { TFunction } from "../hooks/use-i18n";
import type { SSEMessage } from "../hooks/use-sse";
import { useColors } from "../hooks/use-colors";
import { deriveBookActivity, shouldRefetchBookView } from "../hooks/use-book-activity";
import {
  ChevronLeft,
  RefreshCw,
  Sparkles,
  Trash2,
  CheckCheck,
  AlertTriangle,
  CheckCircle,
  XCircle,
  Send,
  Eye,
  RotateCcw,
  Search,
  Edit3,
  FileText
} from "lucide-react";

interface ChapterMeta {
  readonly number: number;
  readonly title: string;
  readonly status: string;
  readonly wordCount: number;
}

interface VolumeData {
  readonly volume: {
    readonly id: string;
    readonly title: string;
    readonly description: string;
    readonly chapterPlans?: Array<{
      readonly title: string;
      readonly description: string;
    }>;
  };
  readonly chapters: ReadonlyArray<ChapterMeta>;
}

interface Nav {
  toDashboard: () => void;
  toBookDetail: (bookId: string) => void;
  toChapter: (bookId: string, num: number) => void;
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
    "needs-audit": () => "需要审计",
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
  "approved": { color: "text-teal-600 bg-teal-50", icon: <CheckCircle size={12} /> },
  "rejected": { color: "text-rose-600 bg-rose-50", icon: <XCircle size={12} /> },
  "published": { color: "text-indigo-600 bg-indigo-50", icon: <Send size={12} /> },
  "imported": { color: "text-gray-600 bg-gray-50", icon: <FileText size={12} /> },
  "needs-audit": { color: "text-amber-600 bg-amber-50", icon: <AlertTriangle size={12} /> },
};

export function VolumeDetail({
  bookId,
  volumeId,
  nav,
  theme,
  t,
  sse,
}: {
  bookId: string;
  volumeId: string;
  nav: Nav;
  theme: Theme;
  t: TFunction;
  sse: { messages: ReadonlyArray<SSEMessage> };
}) {
  const c = useColors(theme);
  const [volumeData, setVolumeData] = useState<VolumeData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rewritingChapters, setRewritingChapters] = useState<ReadonlyArray<number>>([]);
  const [syncingChapters, setSyncingChapters] = useState<ReadonlyArray<number>>([]);
  const [deletingChapters, setDeletingChapters] = useState<ReadonlyArray<number>>([]);
  const [openDropdown, setOpenDropdown] = useState<number | null>(null);
  const [rewritingVolume, setRewritingVolume] = useState(false);
  const [generatingPlans, setGeneratingPlans] = useState(false);
  const [markingAffected, setMarkingAffected] = useState(false);
  const activity = useApi(() => deriveBookActivity(sse.messages, bookId), [bookId, sse.messages]);

  const loadVolumeData = async () => {
    setLoading(true);
    setError(null);
    try {
      const volumePlansResponse = await fetchJson(`/books/${bookId}/volume-plans`);
      const volume = volumePlansResponse.volumePlans.find((v: any) => v.id === volumeId);
      if (!volume) {
        throw new Error("Volume not found");
      }
      
      const bookResponse = await fetchJson(`/books/${bookId}`);
      const chapters = bookResponse.chapters.filter((ch: ChapterMeta) => {
        // 这里需要根据实际的章节与卷的关联逻辑来过滤
        // 暂时返回所有章节，实际实现时需要根据卷的章节范围进行过滤
        return true;
      });
      
      setVolumeData({ volume, chapters });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load volume data");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadVolumeData();
  }, [bookId, volumeId]);

  useEffect(() => {
    if (shouldRefetchBookView(sse.messages, bookId)) {
      loadVolumeData();
    }
  }, [sse.messages, bookId, loadVolumeData]);

  const handleRewriteVolumeChapters = async () => {
    if (!confirm('确定要重写本卷所有章节吗？')) return;
    setRewritingVolume(true);
    try {
      await postApi(`/books/${bookId}/volumes/${volumeId}/rewrite-chapters`);
      alert('本卷章节重写已开始，请等待完成');
      loadVolumeData();
    } catch (e) {
      alert(e instanceof Error ? e.message : '章节重写失败');
    } finally {
      setRewritingVolume(false);
    }
  };

  const handleGenerateChapterPlans = async () => {
    setGeneratingPlans(true);
    try {
      await postApi(`/books/${bookId}/volumes/${volumeId}/generate-plans`);
      alert('章节规划生成成功');
      loadVolumeData();
    } catch (e) {
      alert(e instanceof Error ? e.message : '章节规划生成失败');
    } finally {
      setGeneratingPlans(false);
    }
  };

  const handleMarkAffectedChapters = async () => {
    setMarkingAffected(true);
    try {
      await postApi(`/books/${bookId}/volumes/${volumeId}/mark-affected`);
      alert('受影响章节已标记，需要重新审计');
      loadVolumeData();
    } catch (e) {
      alert(e instanceof Error ? e.message : '标记受影响章节失败');
    } finally {
      setMarkingAffected(false);
    }
  };

  const handleApproveChapter = async (chapterNumber: number) => {
    try {
      await postApi(`/books/${bookId}/chapters/${chapterNumber}/approve`, {});
      loadVolumeData();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to approve');
    }
  };

  const handleRejectChapter = async (chapterNumber: number) => {
    try {
      await postApi(`/books/${bookId}/chapters/${chapterNumber}/reject`, {});
      loadVolumeData();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to reject');
    }
  };

  const handleAuditChapter = async (chapterNumber: number) => {
    try {
      await postApi(`/books/${bookId}/chapters/${chapterNumber}/audit`, {});
      loadVolumeData();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to audit');
    }
  };

  const handleRewriteChapter = async (chapterNumber: number) => {
    setRewritingChapters((prev) => [...prev, chapterNumber]);
    try {
      await postApi(`/books/${bookId}/chapters/${chapterNumber}/rewrite`, {});
      loadVolumeData();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to rewrite');
    } finally {
      setRewritingChapters((prev) => prev.filter((n) => n !== chapterNumber));
    }
  };

  const handleSyncChapter = async (chapterNumber: number) => {
    setSyncingChapters((prev) => [...prev, chapterNumber]);
    try {
      await postApi(`/books/${bookId}/chapters/${chapterNumber}/sync`, {});
      loadVolumeData();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to sync');
    } finally {
      setSyncingChapters((prev) => prev.filter((n) => n !== chapterNumber));
    }
  };

  const handleDeleteChapter = async (chapterNumber: number) => {
    if (!confirm(t("book.confirmDelete"))) return;
    setDeletingChapters((prev) => [...prev, chapterNumber]);
    try {
      await fetchJson(`/books/${bookId}/chapters/${chapterNumber}`, { method: "DELETE" });
      loadVolumeData();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to delete');
    } finally {
      setDeletingChapters((prev) => prev.filter((n) => n !== chapterNumber));
    }
  };

  const handleApproveAll = async () => {
    if (!volumeData) return;
    const reviewable = volumeData.chapters.filter((ch) => ch.status === "ready-for-review");
    for (const ch of reviewable) {
      try {
        await postApi(`/books/${bookId}/chapters/${ch.number}/approve`, {});
      } catch (e) {
        console.error(`Failed to approve chapter ${ch.number}:`, e);
      }
    }
    loadVolumeData();
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-2 border-primary/20 border-t-primary rounded-full animate-spin" />
      </div>
    );
  }

  if (error || !volumeData) {
    return (
      <div className="max-w-3xl mx-auto p-6">
        <div className={`border ${c.error} rounded-lg px-4 py-3`}>
          {error || "Volume not found"}
        </div>
        <button onClick={() => nav.toBookDetail(bookId)} className={`mt-4 ${c.link}`}>
          返回书籍详情
        </button>
      </div>
    );
  }

  const { volume, chapters } = volumeData;
  const reviewCount = chapters.filter((ch) => ch.status === "ready-for-review").length;

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <button onClick={nav.toDashboard} className={c.link}>{t("bread.books")}</button>
        <span className="text-border">/</span>
        <button onClick={() => nav.toBookDetail(bookId)} className={c.link}>{bookId}</button>
        <span className="text-border">/</span>
        <span className="truncate max-w-[200px]">{volume.title}</span>
      </div>

      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="font-serif text-3xl">{volume.title}</h1>
          <p className="mt-2 text-muted-foreground">{volume.description}</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => nav.toBookDetail(bookId)}
            className="flex items-center gap-2 px-4 py-2 text-sm font-bold bg-secondary text-secondary-foreground rounded-lg hover:scale-105 active:scale-95 transition-all"
          >
            <ChevronLeft size={16} />
            返回书籍详情
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
          onClick={handleGenerateChapterPlans}
          disabled={generatingPlans}
          className="flex items-center gap-2 px-4 py-2 text-xs font-bold bg-secondary text-secondary-foreground rounded-lg hover:bg-secondary/80 transition-all disabled:opacity-50"
        >
          {generatingPlans ? <div className="w-4 h-4 border-2 border-secondary-foreground/20 border-t-secondary-foreground rounded-full animate-spin" /> : <Sparkles size={14} />}
          生成章节规划
        </button>
        <button
          onClick={handleRewriteVolumeChapters}
          disabled={rewritingVolume}
          className="flex items-center gap-2 px-4 py-2 text-xs font-bold bg-primary text-primary-foreground rounded-lg hover:scale-105 active:scale-95 transition-all disabled:opacity-50"
        >
          {rewritingVolume ? <div className="w-4 h-4 border-2 border-primary-foreground/20 border-t-primary-foreground rounded-full animate-spin" /> : <RefreshCw size={14} />}
          重写本卷章节
        </button>
        <button
          onClick={handleMarkAffectedChapters}
          disabled={markingAffected}
          className="flex items-center gap-2 px-4 py-2 text-xs font-bold bg-amber-500/10 text-amber-600 rounded-lg hover:bg-amber-500/20 transition-all disabled:opacity-50"
        >
          {markingAffected ? <div className="w-4 h-4 border-2 border-amber-600/20 border-t-amber-600 rounded-full animate-spin" /> : <AlertTriangle size={14} />}
          标记受影响章节
        </button>
      </div>

      {/* Chapter Plans */}
      {volume.chapterPlans && volume.chapterPlans.length > 0 && (
        <div className="paper-sheet rounded-2xl border border-border/40 shadow-sm p-6">
          <h2 className="text-sm font-bold uppercase tracking-widest text-muted-foreground mb-4">章节规划</h2>
          <div className="space-y-3">
            {volume.chapterPlans.map((chapter, index) => (
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
        </div>
      )}

      {/* Chapters Table */}
      <div className="paper-sheet rounded-2xl border border-border/40 shadow-sm overflow-hidden">
        <div className="p-6 border-b border-border/40">
          <h2 className="text-sm font-bold uppercase tracking-widest text-muted-foreground">本卷章节</h2>
        </div>
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
              {chapters.length > 0 ? (
                chapters.map((ch) => (
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
                            onClick={() => handleApproveChapter(ch.number)}
                            className="px-2 py-0.5 text-[10px] font-bold bg-emerald-500/10 text-emerald-600 rounded hover:bg-emerald-500/20 transition-colors"
                          >
                            {t("book.approve")}
                          </button>
                          <button
                            onClick={() => handleRejectChapter(ch.number)}
                            className="px-2 py-0.5 text-[10px] font-bold bg-destructive/10 text-destructive rounded hover:bg-destructive/20 transition-colors"
                          >
                            {t("book.reject")}
                          </button>
                        </div>
                      )}
                    </td>
                    <td className="px-6 py-4 text-right">
                      <div className="relative">
                        <button
                          onClick={() => setOpenDropdown(openDropdown === ch.number ? null : ch.number)}
                          className="p-1.5 rounded-lg hover:bg-secondary/50 transition-colors"
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M6 9l6 6 6-6" />
                          </svg>
                        </button>
                        {openDropdown === ch.number && (
                          <div className="absolute right-0 top-full mt-1 w-48 bg-card border border-border/50 rounded-lg shadow-lg z-10 py-1">
                            <button
                              onClick={() => {
                                setOpenDropdown(null);
                                handleAuditChapter(ch.number);
                              }}
                              className="w-full px-3 py-2 text-left text-sm hover:bg-secondary/50 transition-colors flex items-center gap-2"
                            >
                              <Search size={14} />
                              {t("book.audit")}
                            </button>
                            <button
                              onClick={() => {
                                setOpenDropdown(null);
                                handleRewriteChapter(ch.number);
                              }}
                              disabled={rewritingChapters.includes(ch.number)}
                              className="w-full px-3 py-2 text-left text-sm hover:bg-secondary/50 transition-colors flex items-center gap-2 disabled:opacity-50"
                            >
                              {rewritingChapters.includes(ch.number) ? <div className="w-4 h-4 border-2 border-muted-foreground/20 border-t-muted-foreground rounded-full animate-spin" /> : <RefreshCw size={14} />}
                              {t("book.rewrite")}
                            </button>
                            <button
                              onClick={() => {
                                setOpenDropdown(null);
                                handleSyncChapter(ch.number);
                              }}
                              disabled={syncingChapters.includes(ch.number)}
                              className="w-full px-3 py-2 text-left text-sm hover:bg-secondary/50 transition-colors flex items-center gap-2 disabled:opacity-50"
                            >
                              {syncingChapters.includes(ch.number) ? <div className="w-4 h-4 border-2 border-muted-foreground/20 border-t-muted-foreground rounded-full animate-spin" /> : <Sparkles size={14} />}
                              {t("book.sync")}
                            </button>
                            <div className="border-t border-border/50 my-1" />
                            <button
                              onClick={() => {
                                setOpenDropdown(null);
                                handleDeleteChapter(ch.number);
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
                ))
              ) : (
                <tr>
                  <td colSpan={5} className="px-6 py-8 text-center text-muted-foreground">
                    本卷暂无章节
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
