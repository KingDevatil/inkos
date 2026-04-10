import { useState, useEffect } from "react";
import { Sidebar } from "./components/Sidebar";
import { ChatPanel } from "./components/ChatBar";
import { Dashboard } from "./pages/Dashboard";
import { BookDetail } from "./pages/BookDetail";
import { BookCreate } from "./pages/BookCreate";
import { ChapterReader } from "./pages/ChapterReader";
import { Analytics } from "./pages/Analytics";
import { ConfigView } from "./pages/ConfigView";
import { TruthFiles } from "./pages/TruthFiles";
import { DaemonControl } from "./pages/DaemonControl";
import { LogViewer } from "./pages/LogViewer";
import { GenreManager } from "./pages/GenreManager";
import { StyleManager } from "./pages/StyleManager";
import { ImportManager } from "./pages/ImportManager";
import { RadarView } from "./pages/RadarView";
import { DoctorView } from "./pages/DoctorView";
import { LanguageSelector } from "./pages/LanguageSelector";
import { useSSE } from "./hooks/use-sse";
import { useTheme } from "./hooks/use-theme";
import { useI18n } from "./hooks/use-i18n";
import { postApi, useApi } from "./hooks/use-api";
import { Sun, Moon, Bell, MessageSquare, HelpCircle } from "lucide-react";

export type Route =
  | { page: "dashboard" }
  | { page: "book"; bookId: string }
  | { page: "book-create" }
  | { page: "chapter"; bookId: string; chapterNumber: number }
  | { page: "analytics"; bookId: string }
  | { page: "config" }
  | { page: "truth"; bookId: string }
  | { page: "daemon" }
  | { page: "logs" }
  | { page: "genres" }
  | { page: "style" }
  | { page: "import" }
  | { page: "radar" }
  | { page: "doctor" };

export function deriveActiveBookId(route: Route): string | undefined {
  return route.page === "book" || route.page === "chapter" || route.page === "truth" || route.page === "analytics"
    ? route.bookId
    : undefined;
}

export function App() {
  const [route, setRoute] = useState<Route>({ page: "dashboard" });
  const sse = useSSE();
  const { theme, setTheme } = useTheme();
  const { t } = useI18n();
  const { data: project, refetch: refetchProject } = useApi<{ language: string; languageExplicit: boolean }>("/project");
  const [showLanguageSelector, setShowLanguageSelector] = useState(false);
  const [ready, setReady] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [showNotifications, setShowNotifications] = useState(false);

  const isDark = theme === "dark";

  useEffect(() => {
    document.documentElement.classList.toggle("dark", isDark);
  }, [isDark]);

  useEffect(() => {
    if (project) {
      if (!project.languageExplicit) {
        setShowLanguageSelector(true);
      }
      setReady(true);
    }
  }, [project]);

  const nav = {
    toDashboard: () => setRoute({ page: "dashboard" }),
    toBook: (bookId: string) => setRoute({ page: "book", bookId }),
    toBookCreate: () => setRoute({ page: "book-create" }),
    toChapter: (bookId: string, chapterNumber: number) =>
      setRoute({ page: "chapter", bookId, chapterNumber }),
    toAnalytics: (bookId: string) => setRoute({ page: "analytics", bookId }),
    toConfig: () => setRoute({ page: "config" }),
    toTruth: (bookId: string) => setRoute({ page: "truth", bookId }),
    toDaemon: () => setRoute({ page: "daemon" }),
    toLogs: () => setRoute({ page: "logs" }),
    toGenres: () => setRoute({ page: "genres" }),
    toStyle: () => setRoute({ page: "style" }),
    toImport: () => setRoute({ page: "import" }),
    toRadar: () => setRoute({ page: "radar" }),
    toDoctor: () => setRoute({ page: "doctor" }),
  };

  const activeBookId = deriveActiveBookId(route);
  const activePage =
    activeBookId
      ? `book:${activeBookId}`
      : route.page;

  if (!ready) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="w-12 h-12 border-4 border-primary/20 border-t-primary rounded-full animate-spin" />
      </div>
    );
  }

  if (showLanguageSelector) {
    return (
      <LanguageSelector
        onSelect={async (lang) => {
          await postApi("/project/language", { language: lang });
          setShowLanguageSelector(false);
          refetchProject();
        }}
      />
    );
  }

  return (
    <div className="h-screen bg-background text-foreground flex overflow-hidden font-sans">
      {/* Left Sidebar */}
      <Sidebar nav={nav} activePage={activePage} sse={sse} t={t} />

      {/* Center Content */}
      <div className="flex-1 flex flex-col min-w-0 bg-background/30 backdrop-blur-sm">
        {/* Header Strip */}
        <header className="h-14 shrink-0 flex items-center justify-between px-8 border-b border-border/40">
          <div className="flex items-center gap-2">
             <span className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground font-bold">
               InkOS Studio
             </span>
          </div>

          <div className="flex items-center gap-3">

            <button
              onClick={() => setShowHelp(true)}
              className="w-8 h-8 flex items-center justify-center rounded-lg bg-secondary text-muted-foreground hover:text-primary hover:bg-primary/10 transition-all shadow-sm"
              title={t("dash.help")}
            >
              <HelpCircle size={16} />
            </button>

            <button
              onClick={() => setTheme(isDark ? "light" : "dark")}
              className="w-8 h-8 flex items-center justify-center rounded-lg bg-secondary text-muted-foreground hover:text-primary hover:bg-primary/10 transition-all shadow-sm"
              title={isDark ? "Switch to Light Mode" : "Switch to Dark Mode"}
            >
              {isDark ? <Sun size={16} /> : <Moon size={16} />}
            </button>

            <div className="relative">
              <button
                onClick={() => setShowNotifications((prev) => !prev)}
                className="w-8 h-8 flex items-center justify-center rounded-lg bg-secondary text-muted-foreground hover:text-foreground transition-all relative"
                title="Notifications"
              >
                <Bell size={16} />
              </button>
              {showNotifications && (
                <div className="absolute right-0 top-full mt-1 w-80 bg-card border border-border rounded-xl shadow-lg shadow-primary/5 py-2 z-50 fade-in">
                  <div className="px-4 py-2 border-b border-border/50">
                    <h3 className="text-sm font-semibold">{t("dash.notifications")}</h3>
                  </div>
                  <div className="max-h-60 overflow-y-auto">
                    <div className="px-4 py-3 text-center text-sm text-muted-foreground">
                      {t("dash.noNotifications")}
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Chat Panel Toggle */}
            <button
              onClick={() => setChatOpen((prev) => !prev)}
              className={`w-8 h-8 flex items-center justify-center rounded-lg transition-all shadow-sm ${
                chatOpen
                  ? "bg-primary text-primary-foreground shadow-primary/20"
                  : "bg-secondary text-muted-foreground hover:text-primary hover:bg-primary/10"
              }`}
              title="Toggle AI Assistant"
            >
              <MessageSquare size={16} />
            </button>
          </div>
        </header>

        {/* Main Content Area */}
        <main className="flex-1 overflow-y-auto scroll-smooth">
          <div className="max-w-4xl mx-auto px-6 py-12 md:px-12 lg:py-16 fade-in">
            {route.page === "dashboard" && <Dashboard nav={nav} sse={sse} theme={theme} t={t} />}
            {route.page === "book" && <BookDetail bookId={route.bookId} nav={nav} theme={theme} t={t} sse={sse} />}
            {route.page === "book-create" && <BookCreate nav={nav} theme={theme} t={t} />}
            {route.page === "chapter" && <ChapterReader bookId={route.bookId} chapterNumber={route.chapterNumber} nav={nav} theme={theme} t={t} />}
            {route.page === "analytics" && <Analytics bookId={route.bookId} nav={nav} theme={theme} t={t} />}
            {route.page === "config" && <ConfigView nav={nav} theme={theme} t={t} />}
            {route.page === "truth" && <TruthFiles bookId={route.bookId} nav={nav} theme={theme} t={t} />}
            {route.page === "daemon" && <DaemonControl nav={nav} theme={theme} t={t} sse={sse} />}
            {route.page === "logs" && <LogViewer nav={nav} theme={theme} t={t} />}
            {route.page === "genres" && <GenreManager nav={nav} theme={theme} t={t} />}
            {route.page === "style" && <StyleManager nav={nav} theme={theme} t={t} />}
            {route.page === "import" && <ImportManager nav={nav} theme={theme} t={t} />}
            {route.page === "radar" && <RadarView nav={nav} theme={theme} t={t} />}
            {route.page === "doctor" && <DoctorView nav={nav} theme={theme} t={t} />}
          </div>
        </main>
      </div>

      {/* Right Chat Panel */}
      <ChatPanel
        open={chatOpen}
        onClose={() => setChatOpen(false)}
        t={t}
        sse={sse}
        activeBookId={activeBookId}
      />

      {/* Help Modal */}
      {showHelp && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-card border border-border rounded-2xl shadow-2xl max-w-4xl w-full max-h-[80vh] flex flex-col">
            {/* Fixed Header */}
            <div className="p-6 border-b border-border/50 shrink-0">
              <div className="flex items-center justify-between">
                <h2 className="text-2xl font-bold flex items-center gap-2">
                  <HelpCircle size={20} className="text-primary" />
                  {t("dash.helpTitle")}
                </h2>
                <button
                  onClick={() => setShowHelp(false)}
                  className="p-2 rounded-lg hover:bg-secondary/50 transition-colors"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M18 6 6 18" />
                    <path d="m6 6 12 12" />
                  </svg>
                </button>
              </div>
            </div>
            {/* Scrollable Content */}
            <div className="p-6 space-y-6 overflow-y-auto flex-1">
              <section>
                <h3 className="text-lg font-semibold mb-3">{t("dash.helpBookStatus")}</h3>
                <ul className="space-y-2 text-sm text-muted-foreground">
                  <li className="flex items-start gap-2">
                    <span className="w-2 h-2 rounded-full bg-emerald-500 mt-2 flex-shrink-0" />
                    <span><strong>{t("book.statusActive")}</strong> - {t("dash.helpStatusActive")}</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="w-2 h-2 rounded-full bg-amber-500 mt-2 flex-shrink-0" />
                    <span><strong>{t("book.statusPaused")}</strong> - {t("dash.helpStatusPaused")}</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="w-2 h-2 rounded-full bg-muted-foreground mt-2 flex-shrink-0" />
                    <span><strong>{t("book.statusOutlining")}</strong> - {t("dash.helpStatusOutlining")}</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="w-2 h-2 rounded-full bg-muted-foreground mt-2 flex-shrink-0" />
                    <span><strong>{t("book.statusCompleted")}</strong> - {t("dash.helpStatusCompleted")}</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="w-2 h-2 rounded-full bg-muted-foreground mt-2 flex-shrink-0" />
                    <span><strong>{t("book.statusDropped")}</strong> - {t("dash.helpStatusDropped")}</span>
                  </li>
                </ul>
              </section>

              <section>
                <h3 className="text-lg font-semibold mb-3">章节状态说明</h3>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <div className="p-2 rounded bg-slate-100 flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-slate-500" />
                    <span className="text-slate-700">card-generated</span>
                    <span className="text-slate-500 ml-auto">卡片已生成</span>
                  </div>
                  <div className="p-2 rounded bg-blue-50 flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-blue-500" />
                    <span className="text-blue-600">drafting</span>
                    <span className="text-blue-500 ml-auto">创作中</span>
                  </div>
                  <div className="p-2 rounded bg-blue-50 flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-blue-500" />
                    <span className="text-blue-600">drafted</span>
                    <span className="text-blue-500 ml-auto">已创作</span>
                  </div>
                  <div className="p-2 rounded bg-purple-50 flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-purple-500" />
                    <span className="text-purple-600">auditing</span>
                    <span className="text-purple-500 ml-auto">审核中</span>
                  </div>
                  <div className="p-2 rounded bg-emerald-50 flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-emerald-500" />
                    <span className="text-emerald-600">audit-passed</span>
                    <span className="text-emerald-500 ml-auto">审核通过</span>
                  </div>
                  <div className="p-2 rounded bg-red-50 flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-red-500" />
                    <span className="text-red-600">audit-failed</span>
                    <span className="text-red-500 ml-auto">审核失败</span>
                  </div>
                  <div className="p-2 rounded bg-amber-50 flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-amber-500" />
                    <span className="text-amber-600">state-degraded</span>
                    <span className="text-amber-500 ml-auto">状态降级</span>
                  </div>
                  <div className="p-2 rounded bg-orange-50 flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-orange-500" />
                    <span className="text-orange-600">revising</span>
                    <span className="text-orange-500 ml-auto">修订中</span>
                  </div>
                  <div className="p-2 rounded bg-yellow-50 flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-yellow-500" />
                    <span className="text-yellow-600">ready-for-review</span>
                    <span className="text-yellow-500 ml-auto">待审核</span>
                  </div>
                  <div className="p-2 rounded bg-teal-50 flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-teal-500" />
                    <span className="text-teal-600">approved</span>
                    <span className="text-teal-500 ml-auto">已批准</span>
                  </div>
                  <div className="p-2 rounded bg-rose-50 flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-rose-500" />
                    <span className="text-rose-600">rejected</span>
                    <span className="text-rose-500 ml-auto">已拒绝</span>
                  </div>
                  <div className="p-2 rounded bg-indigo-50 flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-indigo-500" />
                    <span className="text-indigo-600">published</span>
                    <span className="text-indigo-500 ml-auto">已发布</span>
                  </div>
                  <div className="p-2 rounded bg-gray-50 flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-gray-500" />
                    <span className="text-gray-600">imported</span>
                    <span className="text-gray-500 ml-auto">已导入</span>
                  </div>
                </div>
              </section>

              <section>
                <h3 className="text-lg font-semibold mb-3">{t("dash.helpChapterActions")}</h3>
                <ul className="space-y-2 text-sm text-muted-foreground">
                  <li className="flex items-start gap-2">
                    <span className="w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center text-primary flex-shrink-0">✓</span>
                    <span><strong>{t("book.approve")}</strong> - {t("dash.helpApprove")}</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="w-6 h-6 rounded-full bg-destructive/10 flex items-center justify-center text-destructive flex-shrink-0">✗</span>
                    <span><strong>{t("book.reject")}</strong> - {t("dash.helpReject")}</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="w-6 h-6 rounded-full bg-secondary flex items-center justify-center text-muted-foreground flex-shrink-0">🔍</span>
                    <span><strong>{t("book.audit")}</strong> - {t("dash.helpAudit")}</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="w-6 h-6 rounded-full bg-secondary flex items-center justify-center text-muted-foreground flex-shrink-0">🔄</span>
                    <span><strong>{t("book.rewrite")}</strong> - {t("dash.helpRewrite")}</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="w-6 h-6 rounded-full bg-secondary flex items-center justify-center text-muted-foreground flex-shrink-0">📝</span>
                    <span><strong>{t("book.sync")}</strong> - {t("dash.helpSync")}</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="w-6 h-6 rounded-full bg-destructive/10 flex items-center justify-center text-destructive flex-shrink-0">🗑️</span>
                    <span><strong>{t("book.delete")}</strong> - {t("dash.helpDelete")}</span>
                  </li>
                </ul>
              </section>

              <section>
                <h3 className="text-lg font-semibold mb-3">{t("dash.helpReviseModes")}</h3>
                <ul className="space-y-4 text-sm text-muted-foreground">
                  <li className="p-3 border border-border/50 rounded-lg bg-secondary/20">
                    <strong className="block mb-1">{t("book.spotFix")}</strong>
                    <p>{t("dash.helpSpotFix")}</p>
                  </li>
                  <li className="p-3 border border-border/50 rounded-lg bg-secondary/20">
                    <strong className="block mb-1">{t("book.polish")}</strong>
                    <p>{t("dash.helpPolish")}</p>
                  </li>
                  <li className="p-3 border border-border/50 rounded-lg bg-secondary/20">
                    <strong className="block mb-1">{t("book.rewrite")}</strong>
                    <p>{t("dash.helpRewriteMode")}</p>
                  </li>
                  <li className="p-3 border border-border/50 rounded-lg bg-secondary/20">
                    <strong className="block mb-1">{t("book.rework")}</strong>
                    <p>{t("dash.helpRework")}</p>
                  </li>
                  <li className="p-3 border border-border/50 rounded-lg bg-secondary/20">
                    <strong className="block mb-1">{t("book.antiDetect")}</strong>
                    <p>{t("dash.helpAntiDetect")}</p>
                  </li>
                </ul>
              </section>

              <section>
                <h3 className="text-lg font-semibold mb-3">{t("dash.helpBookActions")}</h3>
                <ul className="space-y-2 text-sm text-muted-foreground">
                  <li className="flex items-start gap-2">
                    <span className="w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center text-primary flex-shrink-0">⚡</span>
                    <span><strong>{t("dash.writeNext")}</strong> - {t("dash.helpWriteNext")}</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="w-6 h-6 rounded-full bg-secondary flex items-center justify-center text-muted-foreground flex-shrink-0">📊</span>
                    <span><strong>{t("dash.stats")}</strong> - {t("dash.helpStats")}</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="w-6 h-6 rounded-full bg-secondary flex items-center justify-center text-muted-foreground flex-shrink-0">⚙️</span>
                    <span><strong>{t("book.settings")}</strong> - {t("dash.helpSettings")}</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="w-6 h-6 rounded-full bg-secondary flex items-center justify-center text-muted-foreground flex-shrink-0">📥</span>
                    <span><strong>{t("book.export")}</strong> - {t("dash.helpExport")}</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="w-6 h-6 rounded-full bg-destructive/10 flex items-center justify-center text-destructive flex-shrink-0">🗑️</span>
                    <span><strong>{t("book.deleteBook")}</strong> - {t("dash.helpDeleteBook")}</span>
                  </li>
                </ul>
              </section>
            </div>
          </div>
        </div>
      )}


    </div>
  );
}
