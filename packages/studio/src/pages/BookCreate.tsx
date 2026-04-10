import { useEffect, useState } from "react";
import { fetchJson, useApi, postApi } from "../hooks/use-api";
import type { Theme } from "../hooks/use-theme";
import type { TFunction } from "../hooks/use-i18n";
import { useColors } from "../hooks/use-colors";
import { X, Save } from "lucide-react";

interface Nav {
  toDashboard: () => void;
  toBook: (id: string) => void;
}

interface GenreInfo {
  readonly id: string;
  readonly name: string;
  readonly source: "project" | "builtin";
  readonly language: "zh" | "en";
}

interface PlatformOption {
  readonly value: string;
  readonly label: string;
}

const PLATFORMS_ZH: ReadonlyArray<PlatformOption> = [
  { value: "tomato", label: "番茄小说" },
  { value: "qidian", label: "起点中文网" },
  { value: "feilu", label: "飞卢" },
  { value: "other", label: "其他" },
];

const PLATFORMS_EN: ReadonlyArray<PlatformOption> = [
  { value: "royal-road", label: "Royal Road" },
  { value: "kindle-unlimited", label: "Kindle Unlimited" },
  { value: "scribble-hub", label: "Scribble Hub" },
  { value: "other", label: "Other" },
];

export function pickValidValue(current: string, available: ReadonlyArray<string>): string {
  if (current && available.includes(current)) {
    return current;
  }
  return available[0] ?? "";
}

export function defaultChapterWordsForLanguage(language: "zh" | "en"): string {
  return language === "en" ? "2000" : "3000";
}

export function platformOptionsForLanguage(language: "zh" | "en"): ReadonlyArray<PlatformOption> {
  return language === "en" ? PLATFORMS_EN : PLATFORMS_ZH;
}

interface WaitForBookReadyOptions {
  readonly fetchBook?: (bookId: string) => Promise<unknown>;
  readonly fetchStatus?: (bookId: string) => Promise<{ status: string; error?: string }>;
  readonly maxAttempts?: number;
  readonly delayMs?: number;
  readonly waitImpl?: (ms: number) => Promise<void>;
}

const DEFAULT_BOOK_READY_MAX_ATTEMPTS = 120;
const DEFAULT_BOOK_READY_DELAY_MS = 250;

export async function waitForBookReady(
  bookId: string,
  options: WaitForBookReadyOptions = {},
): Promise<void> {
  const fetchBook = options.fetchBook ?? ((id: string) => fetchJson(`/books/${id}`));
  const fetchStatus = options.fetchStatus ?? ((id: string) => fetchJson<{ status: string; error?: string }>(`/books/${id}/create-status`));
  const maxAttempts = options.maxAttempts ?? DEFAULT_BOOK_READY_MAX_ATTEMPTS;
  const delayMs = options.delayMs ?? DEFAULT_BOOK_READY_DELAY_MS;
  const waitImpl = options.waitImpl ?? ((ms: number) => new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  }));

  let lastError: unknown;
  let lastKnownStatus: string | undefined;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      await fetchBook(bookId);
      return;
    } catch (error) {
      lastError = error;
      try {
        const status = await fetchStatus(bookId);
        lastKnownStatus = status.status;
        if (status.status === "error") {
          throw new Error(status.error ?? `Book "${bookId}" failed to create`);
        }
      } catch (statusError) {
        if (statusError instanceof Error && statusError.message !== "404 Not Found") {
          throw statusError;
        }
      }
      if (attempt === maxAttempts - 1) {
        if (lastKnownStatus === "creating") {
          break;
        }
        throw error;
      }
      await waitImpl(delayMs);
    }
  }

  if (lastKnownStatus === "creating") {
    throw new Error(`Book "${bookId}" is still being created. Wait a moment and refresh.`);
  }

  throw lastError instanceof Error ? lastError : new Error(`Book "${bookId}" was not ready`);
}

export function BookCreate({ nav, theme, t }: { nav: Nav; theme: Theme; t: TFunction }) {
  const c = useColors(theme);
  const { data: genreData } = useApi<{ genres: ReadonlyArray<GenreInfo> }>("/genres");
  const { data: project } = useApi<{ language: string }>("/project");

  const projectLang = (project?.language ?? "zh") as "zh" | "en";

  const [title, setTitle] = useState("");
  const [genre, setGenre] = useState("");
  const [platform, setPlatform] = useState("");
  const [chapterWords, setChapterWords] = useState(defaultChapterWordsForLanguage(projectLang));
  const [chapterWordsTouched, setChapterWordsTouched] = useState(false);
  const [targetChapters, setTargetChapters] = useState("200");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [useGlobalAuditConfig, setUseGlobalAuditConfig] = useState(true);
  const [showAuditConfigForm, setShowAuditConfigForm] = useState(false);
  const [auditConfig, setAuditConfig] = useState<any>(null);
  const [loadingAuditConfig, setLoadingAuditConfig] = useState(false);
  const [activeAuditTab, setActiveAuditTab] = useState<"dimensions" | "validation" | "chapter" | "foundation" | "help">("dimensions");
  const [briefContent, setBriefContent] = useState("");
  const [briefFileName, setBriefFileName] = useState("");

  const handleBriefFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const ext = file.name.split(".").pop()?.toLowerCase();
    if (ext !== "txt" && ext !== "md") {
      setError("仅支持 .txt 和 .md 格式的简报文件");
      return;
    }
    const reader = new FileReader();
    reader.onload = (event) => {
      setBriefContent(event.target?.result as string || "");
      setBriefFileName(file.name);
    };
    reader.readAsText(file);
  };

  // Filter genres by project language + custom genres (always show)
  const allGenres = genreData?.genres ?? [];
  const genres = allGenres.filter((g) => g.language === projectLang || g.source === "project");
  const platforms = platformOptionsForLanguage(projectLang);
  const genreSignature = genres.map((g) => g.id).join("|");
  const platformSignature = platforms.map((p) => `${p.value}:${p.label}`).join("|");

  useEffect(() => {
    setGenre((current) => pickValidValue(current, genres.map((g) => g.id)));
  }, [genreSignature]);

  useEffect(() => {
    setPlatform((current) => pickValidValue(current, platforms.map((p) => p.value)));
  }, [platformSignature]);

  useEffect(() => {
    if (!chapterWordsTouched) {
      setChapterWords(defaultChapterWordsForLanguage(projectLang));
    }
  }, [projectLang, chapterWordsTouched]);

  const loadDefaultAuditConfig = async () => {
    setLoadingAuditConfig(true);
    try {
      const config = await fetchJson("/audit-config/default");
      setAuditConfig(config);
      setShowAuditConfigForm(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load default audit config");
    } finally {
      setLoadingAuditConfig(false);
    }
  };

  const handleCreate = async () => {
    if (!title.trim()) {
      setError(t("create.titleRequired"));
      return;
    }
    if (!genre) {
      setError(t("create.genreRequired"));
      return;
    }
    setCreating(true);
    setError(null);
    try {
      const result = await postApi<{ bookId: string }>("/books/create", {
        title: title.trim(),
        genre,
        language: projectLang,
        platform,
        chapterWordCount: parseInt(chapterWords, 10),
        targetChapters: parseInt(targetChapters, 10),
        useGlobalAuditConfig,
        auditConfig: useGlobalAuditConfig ? undefined : auditConfig,
        brief: briefContent || undefined,
      });
      await waitForBookReady(result.bookId);
      nav.toBook(result.bookId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create book");
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="max-w-lg mx-auto space-y-8">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <button onClick={nav.toDashboard} className={c.link}>{t("bread.books")}</button>
        <span className="text-border">/</span>
        <span>{t("bread.newBook")}</span>
      </div>

      <h1 className="font-serif text-3xl">{t("create.title")}</h1>

      {error && (
        <div className={`border ${c.error} rounded-md px-4 py-3`}>
          {error}
        </div>
      )}

      <div className="space-y-5">
        {/* Title */}
        <div>
          <label className="block text-sm text-muted-foreground mb-2">{t("create.bookTitle")}</label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className={`w-full ${c.input} rounded-md px-4 py-3 focus:outline-none text-base`}
            placeholder={t("create.placeholder")}
          />
        </div>

        {/* Genre */}
        <div>
          <label className="block text-sm text-muted-foreground mb-2">{t("create.genre")}</label>
          <div className="grid grid-cols-3 gap-2">
            {genres.map((g) => (
              <button
                key={g.id}
                onClick={() => setGenre(g.id)}
                className={`px-3 py-2.5 rounded-md text-sm text-left transition-all ${
                  genre === g.id
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

        {/* Platform */}
        <div>
          <label className="block text-sm text-muted-foreground mb-2">
            {t("create.platform")}
          </label>
          <div className="flex gap-2">
            {platforms.map((p) => (
              <button
                key={p.value}
                onClick={() => setPlatform(p.value)}
                className={`px-3 py-2 rounded-md text-sm transition-all ${
                  platform === p.value
                    ? "bg-primary/15 text-primary border border-primary/30"
                    : "bg-secondary text-secondary-foreground border border-transparent hover:border-border"
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        {/* Word count + chapters */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm text-muted-foreground mb-2">{t("create.wordsPerChapter")}</label>
            <input
              type="number"
              value={chapterWords}
              onChange={(e) => {
                setChapterWordsTouched(true);
                setChapterWords(e.target.value);
              }}
              className={`w-full ${c.input} rounded-md px-4 py-3 focus:outline-none`}
            />
          </div>
          <div>
            <label className="block text-sm text-muted-foreground mb-2">{t("create.targetChapters")}</label>
            <input
              type="number"
              value={targetChapters}
              onChange={(e) => setTargetChapters(e.target.value)}
              className={`w-full ${c.input} rounded-md px-4 py-3 focus:outline-none`}
            />
          </div>
        </div>

        {/* Creative Brief */}
        <div>
          <label className="block text-sm text-muted-foreground mb-2">创作简报</label>
          <div className="space-y-3">
            <div className="flex items-center gap-3 p-3 border border-border/50 rounded-md bg-secondary/30">
              <label className="flex items-center gap-2 px-3 py-2 text-sm bg-primary/10 text-primary rounded-md hover:bg-primary/20 cursor-pointer transition-colors">
                <input
                  type="file"
                  accept=".txt,.md"
                  onChange={handleBriefFileChange}
                  className="hidden"
                />
                <span className="text-lg">📁</span>
                <span>上传简报文件</span>
              </label>
              {briefFileName && (
                <span className="text-sm text-muted-foreground truncate max-w-[200px]">
                  {briefFileName}
                </span>
              )}
              <span className="text-xs text-muted-foreground ml-auto">支持 .txt, .md</span>
            </div>
            <div className="relative">
              <textarea
                value={briefContent}
                onChange={(e) => {
                  setBriefContent(e.target.value);
                  setBriefFileName("");
                }}
                placeholder="或者直接在此输入创作简报内容...&#10;&#10;简报将帮助 Architect 理解你的创作想法，基于你的设定构建大纲，而非从头生成。"
                className={`w-full ${c.input} rounded-md px-4 py-3 focus:outline-none min-h-[120px] resize-y`}
              />
              {briefContent && (
                <button
                  onClick={() => {
                    setBriefContent("");
                    setBriefFileName("");
                  }}
                  className="absolute top-2 right-2 p-1 text-muted-foreground hover:text-foreground transition-colors"
                  title="清除内容"
                >
                  ✕
                </button>
              )}
            </div>
            <div className="text-xs text-muted-foreground flex items-start gap-1">
              <span className="mt-0.5">💡</span>
              <span>简报内容会作为创作方向参考，Architect 会根据你的设定构建大纲。上传文件与手动输入二选一，优先使用文件内容。</span>
            </div>
          </div>
        </div>

        {/* Audit Config */}
        <div>
          <label className="block text-sm text-muted-foreground mb-2">审计配置</label>
          <div className="flex items-start justify-between p-4 border border-border/50 rounded-md bg-secondary/30">
            <div>
              <div className="font-medium">使用全局默认配置</div>
              <div className="text-xs text-muted-foreground">如果选择否，将展开配置页面设置项目级审计配置</div>
              {!useGlobalAuditConfig && (
                <button
                  onClick={loadDefaultAuditConfig}
                  disabled={loadingAuditConfig}
                  className="mt-2 text-xs text-primary hover:underline flex items-center gap-1"
                >
                  {loadingAuditConfig ? "加载中..." : "打开审计设置"}
                </button>
              )}
            </div>
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                checked={useGlobalAuditConfig}
                onChange={(e) => {
                  setUseGlobalAuditConfig(e.target.checked);
                  if (!e.target.checked) {
                    loadDefaultAuditConfig();
                  } else {
                    setShowAuditConfigForm(false);
                  }
                }}
                className="sr-only peer"
              />
              <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-primary"></div>
            </label>
          </div>
        </div>
      </div>

      <button
        onClick={handleCreate}
        disabled={creating || !title.trim()}
        className={`w-full px-4 py-3 ${c.btnPrimary} rounded-md disabled:opacity-50 font-medium text-base`}
      >
        {creating ? t("create.creating") : t("create.submit")}
      </button>

      {/* Audit Config Modal */}
      {showAuditConfigForm && auditConfig && (
        <div className="fixed inset-0 flex items-center justify-center z-[100] p-4">
          <div className="bg-card rounded-2xl shadow-2xl max-w-4xl w-full flex flex-col border border-border" style={{ height: 'clamp(400px, 80vh, 1200px)' }}>
            {/* Header */}
            <div className="flex items-center justify-between p-6 border-b border-border/50 shrink-0">
              <h2 className="text-xl font-bold">审计配置</h2>
              <button
                onClick={() => setShowAuditConfigForm(false)}
                className="p-2 rounded-lg hover:bg-primary/10 transition-colors"
              >
                <X size={20} />
              </button>
            </div>

            {/* Tabs */}
            <div className="flex gap-2 px-6 pt-4 border-b border-border/50 shrink-0">
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
                      {auditConfig.dimensions.filter((d: any) => d.severity === "critical").map((dim: any, index: number) => (
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
                      {auditConfig.dimensions.filter((d: any) => d.severity === "warning").map((dim: any, index: number) => (
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
                      {auditConfig.dimensions.filter((d: any) => d.severity === "info").map((dim: any, index: number) => (
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
                onClick={() => setShowAuditConfigForm(false)}
                className="px-4 py-2 text-sm font-bold bg-secondary text-foreground rounded-lg hover:bg-secondary/80 transition-all border border-border/50 mr-2"
              >
                取消
              </button>
              <button
                onClick={() => setShowAuditConfigForm(false)}
                className="flex items-center gap-2 px-4 py-2 text-sm font-bold bg-primary text-primary-foreground rounded-lg hover:scale-105 active:scale-95 transition-all"
              >
                <Save size={14} />
                保存配置
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
