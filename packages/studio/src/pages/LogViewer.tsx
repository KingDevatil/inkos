import { useApi, postApi } from "../hooks/use-api";
import type { Theme } from "../hooks/use-theme";
import type { TFunction } from "../hooks/use-i18n";
import { useColors } from "../hooks/use-colors";
import { useSSE } from "../hooks/use-sse";
import { useEffect, useState, useCallback } from "react";
import { RefreshCw, Square } from "lucide-react";

interface LogEntry {
  readonly level?: string;
  readonly tag?: string;
  readonly message: string;
  readonly timestamp?: string;
}

interface Nav {
  toDashboard: () => void;
}

const LEVEL_COLORS: Record<string, string> = {
  error: "text-destructive",
  warn: "text-amber-500",
  info: "text-primary/70",
  debug: "text-muted-foreground/50",
};

export function LogViewer({ nav, theme, t }: { nav: Nav; theme: Theme; t: TFunction }) {
  const c = useColors(theme);
  const { data, refetch } = useApi<{ entries: ReadonlyArray<LogEntry> }>("/logs");
  const { messages, connected } = useSSE("/api/events");
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [hasActiveRun, setHasActiveRun] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  // Merge initial logs with SSE logs
  useEffect(() => {
    if (data?.entries) {
      // Sort by timestamp to ensure correct order
      const sorted = [...data.entries].sort((a, b) => {
        const timeA = a.timestamp ? new Date(a.timestamp).getTime() : 0;
        const timeB = b.timestamp ? new Date(b.timestamp).getTime() : 0;
        return timeA - timeB;
      });
      setLogs(sorted);
    }
  }, [data]);

  // Add SSE log messages
  useEffect(() => {
    const logMessages = messages.filter(m => m.event === "log");
    if (logMessages.length > 0) {
      const newEntries = logMessages.map(m => {
        const data = m.data as { level?: string; tag?: string; message?: string };
        return {
          level: data?.level || "info",
          tag: data?.tag,
          message: data?.message || String(m.data),
          timestamp: new Date(m.timestamp).toISOString(),
        };
      });
      setLogs(prev => {
        // Merge and deduplicate based on timestamp + message
        const combined = [...prev, ...newEntries];
        const seen = new Set<string>();
        const unique = combined.filter(entry => {
          const key = `${entry.timestamp}-${entry.message}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        // Sort by timestamp
        unique.sort((a, b) => {
          const timeA = a.timestamp ? new Date(a.timestamp).getTime() : 0;
          const timeB = b.timestamp ? new Date(b.timestamp).getTime() : 0;
          return timeA - timeB;
        });
        return unique.slice(-500);
      });
    }
  }, [messages]);

  // Check for active runs
  const checkActiveRun = useCallback(async () => {
    try {
      const result = await fetch("/api/runs/active");
      const data = await result.json();
      setHasActiveRun(data.active);
    } catch {
      setHasActiveRun(false);
    }
  }, []);

  useEffect(() => {
    checkActiveRun();
    const interval = setInterval(checkActiveRun, 2000);
    return () => clearInterval(interval);
  }, [checkActiveRun]);

  const handleCancel = async () => {
    if (!hasActiveRun) return;
    setCancelling(true);
    try {
      await postApi("/runs/cancel", {});
      setHasActiveRun(false);
    } catch (e) {
      console.error("Failed to cancel run:", e);
    } finally {
      setCancelling(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <button onClick={nav.toDashboard} className={c.link}>{t("bread.home")}</button>
        <span className="text-border">/</span>
        <span className="text-foreground">{t("logs.title")}</span>
      </div>

      <div className="flex items-baseline justify-between">
        <div className="flex items-center gap-3">
          <h1 className="font-serif text-3xl">{t("logs.title")}</h1>
          <span className={`text-xs px-2 py-1 rounded-full ${connected ? "bg-emerald-500/10 text-emerald-600" : "bg-amber-500/10 text-amber-600"}`}>
            {connected ? "实时连接" : "连接断开"}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => refetch()}
            className={`flex items-center gap-2 px-4 py-2.5 text-sm rounded-md ${c.btnSecondary}`}
          >
            <RefreshCw size={16} />
            {t("common.refresh")}
          </button>
          <button
            onClick={handleCancel}
            disabled={!hasActiveRun || cancelling}
            className={`flex items-center gap-2 px-4 py-2.5 text-sm rounded-md transition-all ${
              hasActiveRun
                ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
                : "bg-muted text-muted-foreground cursor-not-allowed"
            }`}
          >
            <Square size={16} />
            {cancelling ? "终止中..." : "终止进程"}
          </button>
        </div>
      </div>

      <div className={`border ${c.cardStatic} rounded-lg overflow-hidden`}>
        <div className="p-4 max-h-[600px] overflow-y-auto">
          {logs.length > 0 ? (
            <div className="space-y-1 font-mono text-sm leading-relaxed">
              {[...logs].reverse().map((entry, i) => (
                <div key={`${entry.timestamp}-${i}`} className="flex gap-2">
                  {entry.timestamp && (
                    <span className="text-muted-foreground shrink-0 w-20 tabular-nums">
                      {new Date(entry.timestamp).toLocaleTimeString()}
                    </span>
                  )}
                  {entry.level && (
                    <span className={`shrink-0 w-12 uppercase ${LEVEL_COLORS[entry.level] ?? "text-muted-foreground"}`}>
                      {entry.level}
                    </span>
                  )}
                  {entry.tag && (
                    <span className="text-primary/70 shrink-0">[{entry.tag}]</span>
                  )}
                  <span className="text-foreground/80">{entry.message}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-muted-foreground text-sm italic py-12 text-center">
              {t("logs.empty")}
            </div>
          )}
        </div>
      </div>

      <p className="text-sm text-muted-foreground">
        {t("logs.showingRecent")}
      </p>
    </div>
  );
}
