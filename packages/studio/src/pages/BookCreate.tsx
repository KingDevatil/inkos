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
  const [savingAuditConfig, setSavingAuditConfig] = useState(false);

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

        {/* Genre — filtered by language */}
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

        {/* Platform — filtered by language */}
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

        {/* Audit Config */}
        <div>
          <label className="block text-sm text-muted-foreground mb-2">审计配置</label>
          <div className="flex items-center justify-between p-4 border border-border/50 rounded-md bg-secondary/30">
            <div>
              <div className="font-medium">使用全局默认配置</div>
              <div className="text-xs text-muted-foreground">如果选择否，将展开配置页面设置项目级审计配置</div>
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
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-card rounded-2xl shadow-xl max-w-4xl w-full max-h-[80vh] overflow-y-auto p-6">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-xl font-bold">审计配置</h2>
              <button
                onClick={() => setShowAuditConfigForm(false)}
                className="p-2 rounded-lg hover:bg-primary/10 transition-colors"
              >
                <X size={20} />
              </button>
            </div>

            <div className="space-y-6">
              {/* Dimensions */}
              <div>
                <h3 className="text-sm font-bold mb-3">审计维度</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {auditConfig.dimensions.map((dim: any, index: number) => (
                    <div key={dim.id} className="flex items-center gap-2 p-3 rounded-lg border border-border/50">
                      <input
                        type="checkbox"
                        checked={dim.enabled}
                        onChange={(e) => {
                          const updated = [...auditConfig.dimensions];
                          updated[index] = { ...updated[index], enabled: e.target.checked };
                          setAuditConfig({ ...auditConfig, dimensions: updated });
                        }}
                        className="rounded border-border/50"
                      />
                      <div className="flex-1">
                        <div className="font-medium">{dim.name}</div>
                        <div className="text-xs text-muted-foreground">ID: {dim.id}</div>
                      </div>
                      <div className="w-20">
                        <input
                          type="number"
                          value={dim.weight}
                          onChange={(e) => {
                            const updated = [...auditConfig.dimensions];
                            updated[index] = { ...updated[index], weight: Number(e.target.value) };
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

              {/* Scoring */}
              <div>
                <h3 className="text-sm font-bold mb-3">评分规则</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div className="p-3 rounded-lg border border-border/50">
                    <h4 className="text-xs font-bold text-muted-foreground mb-2">基础分</h4>
                    <input
                      type="number"
                      value={auditConfig.scoring.baseScore}
                      onChange={(e) => {
                        setAuditConfig({
                          ...auditConfig,
                          scoring: {
                            ...auditConfig.scoring,
                            baseScore: Number(e.target.value)
                          }
                        });
                      }}
                      className="w-full px-2 py-1 text-sm rounded border border-border/50 bg-secondary/30"
                    />
                  </div>
                  <div className="p-3 rounded-lg border border-border/50">
                    <h4 className="text-xs font-bold text-muted-foreground mb-2">惩罚值</h4>
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="text-xs">审计问题:</span>
                        <input
                          type="number"
                          value={auditConfig.scoring.penalties.auditIssue}
                          onChange={(e) => {
                            setAuditConfig({
                              ...auditConfig,
                              scoring: {
                                ...auditConfig.scoring,
                                penalties: {
                                  ...auditConfig.scoring.penalties,
                                  auditIssue: Number(e.target.value)
                                }
                              }
                            });
                          }}
                          className="w-16 px-2 py-1 text-sm rounded border border-border/50 bg-secondary/30"
                        />
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs">AI痕迹:</span>
                        <input
                          type="number"
                          value={auditConfig.scoring.penalties.aiTellDensity}
                          onChange={(e) => {
                            setAuditConfig({
                              ...auditConfig,
                              scoring: {
                                ...auditConfig.scoring,
                                penalties: {
                                  ...auditConfig.scoring.penalties,
                                  aiTellDensity: Number(e.target.value)
                                }
                              }
                            });
                          }}
                          className="w-16 px-2 py-1 text-sm rounded border border-border/50 bg-secondary/30"
                        />
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs">段落问题:</span>
                        <input
                          type="number"
                          value={auditConfig.scoring.penalties.paragraphWarning}
                          onChange={(e) => {
                            setAuditConfig({
                              ...auditConfig,
                              scoring: {
                                ...auditConfig.scoring,
                                penalties: {
                                  ...auditConfig.scoring.penalties,
                                  paragraphWarning: Number(e.target.value)
                                }
                              }
                            });
                          }}
                          className="w-16 px-2 py-1 text-sm rounded border border-border/50 bg-secondary/30"
                        />
                      </div>
                    </div>
                  </div>
                  <div className="p-3 rounded-lg border border-border/50 md:col-span-2">
                    <h4 className="text-xs font-bold text-muted-foreground mb-2">权重</h4>
                    <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
                      <div>
                        <span className="text-xs block mb-1">审计通过率</span>
                        <input
                          type="number"
                          value={auditConfig.scoring.weights.auditPassRate}
                          onChange={(e) => {
                            setAuditConfig({
                              ...auditConfig,
                              scoring: {
                                ...auditConfig.scoring,
                                weights: {
                                  ...auditConfig.scoring.weights,
                                  auditPassRate: Number(e.target.value)
                                }
                              }
                            });
                          }}
                          min="0"
                          max="1"
                          step="0.05"
                          className="w-full px-2 py-1 text-sm rounded border border-border/50 bg-secondary/30"
                        />
                      </div>
                      <div>
                        <span className="text-xs block mb-1">AI痕迹</span>
                        <input
                          type="number"
                          value={auditConfig.scoring.weights.aiTellDensity}
                          onChange={(e) => {
                            setAuditConfig({
                              ...auditConfig,
                              scoring: {
                                ...auditConfig.scoring,
                                weights: {
                                  ...auditConfig.scoring.weights,
                                  aiTellDensity: Number(e.target.value)
                                }
                              }
                            });
                          }}
                          min="0"
                          max="1"
                          step="0.05"
                          className="w-full px-2 py-1 text-sm rounded border border-border/50 bg-secondary/30"
                        />
                      </div>
                      <div>
                        <span className="text-xs block mb-1">段落问题</span>
                        <input
                          type="number"
                          value={auditConfig.scoring.weights.paragraphWarnings}
                          onChange={(e) => {
                            setAuditConfig({
                              ...auditConfig,
                              scoring: {
                                ...auditConfig.scoring,
                                weights: {
                                  ...auditConfig.scoring.weights,
                                  paragraphWarnings: Number(e.target.value)
                                }
                              }
                            });
                          }}
                          min="0"
                          max="1"
                          step="0.05"
                          className="w-full px-2 py-1 text-sm rounded border border-border/50 bg-secondary/30"
                        />
                      </div>
                      <div>
                        <span className="text-xs block mb-1">伏笔回收</span>
                        <input
                          type="number"
                          value={auditConfig.scoring.weights.hookResolveRate}
                          onChange={(e) => {
                            setAuditConfig({
                              ...auditConfig,
                              scoring: {
                                ...auditConfig.scoring,
                                weights: {
                                  ...auditConfig.scoring.weights,
                                  hookResolveRate: Number(e.target.value)
                                }
                              }
                            });
                          }}
                          min="0"
                          max="1"
                          step="0.05"
                          className="w-full px-2 py-1 text-sm rounded border border-border/50 bg-secondary/30"
                        />
                      </div>
                      <div>
                        <span className="text-xs block mb-1">标题重复</span>
                        <input
                          type="number"
                          value={auditConfig.scoring.weights.duplicateTitles}
                          onChange={(e) => {
                            setAuditConfig({
                              ...auditConfig,
                              scoring: {
                                ...auditConfig.scoring,
                                weights: {
                                  ...auditConfig.scoring.weights,
                                  duplicateTitles: Number(e.target.value)
                                }
                              }
                            });
                          }}
                          min="0"
                          max="1"
                          step="0.05"
                          className="w-full px-2 py-1 text-sm rounded border border-border/50 bg-secondary/30"
                        />
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Validation Rules */}
              <div>
                <h3 className="text-sm font-bold mb-3">验证规则</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div className="p-3 rounded-lg border border-border/50">
                    <h4 className="text-xs font-bold text-muted-foreground mb-2">禁止句式</h4>
                    <input
                      type="text"
                      value={auditConfig.validationRules.bannedPatterns.join(", ")}
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
                      checked={auditConfig.validationRules.bannedDashes}
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
                      value={auditConfig.validationRules.transitionWordDensity}
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
                      value={auditConfig.validationRules.dialogueDensity}
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

              {/* Save Button */}
              <div className="flex justify-end">
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
        </div>
      )}
    </div>
  );
}
