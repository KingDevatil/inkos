import { useState, useEffect, useCallback, useRef } from "react";
import type { Theme } from "../../hooks/use-theme";
import type { TFunction } from "../../hooks/use-i18n";
import type { SSEMessage } from "../../hooks/use-sse";
import { useChatStore } from "../../store/chat";
import { fetchJson } from "../../hooks/use-api";
import { PanelRightClose, PanelRightOpen, ArrowLeft, Loader2, Pencil, Save, X } from "lucide-react";
import { Streamdown } from "streamdown";
import { cjk } from "@streamdown/cjk";
import { ProgressSection } from "../sidebar/ProgressSection";
import { FoundationSection } from "../sidebar/FoundationSection";
import { SummarySection } from "../sidebar/SummarySection";
import { ChaptersSection } from "../sidebar/ChaptersSection";
import { CharacterSection } from "../sidebar/CharacterSection";

export interface BookSidebarProps {
  readonly bookId: string;
  readonly theme: Theme;
  readonly t: TFunction;
  readonly sse: { messages: ReadonlyArray<SSEMessage>; connected: boolean };
}

const FOUNDATION_LABELS: Record<string, string> = {
  "story_bible.md": "世界观设定",
  "volume_outline.md": "卷纲规划",
  "book_rules.md": "叙事规则",
  "current_state.md": "状态卡",
  "pending_hooks.md": "伏笔池",
  "subplot_board.md": "支线进度",
  "emotional_arcs.md": "感情线",
  "character_matrix.md": "角色矩阵",
};

const streamdownPlugins = { cjk };

interface Chapter {
  number: number;
  title: string;
  status?: "draft" | "audited" | "revised";
}

interface Character {
  name: string;
  role?: string;
  description?: string;
}

function ArtifactView({ bookId }: { readonly bookId: string }) {
  const artifactFile = useChatStore((s) => s.artifactFile);
  const artifactChapter = useChatStore((s) => s.artifactChapter);
  const closeArtifact = useChatStore((s) => s.closeArtifact);
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState("");
  const [saving, setSaving] = useState(false);

  const isChapter = artifactChapter !== null;
  const label = isChapter
    ? `第 ${artifactChapter} 章`
    : artifactFile ? FOUNDATION_LABELS[artifactFile] ?? artifactFile : "";

  useEffect(() => {
    setEditing(false);
    setLoading(true);
    if (isChapter) {
      fetchJson<{ content: string }>(`/books/${bookId}/chapters/${artifactChapter}`)
        .then((data) => setContent(data.content ?? ""))
        .catch(() => setContent(null))
        .finally(() => setLoading(false));
    } else if (artifactFile) {
      fetchJson<{ content: string | null }>(`/books/${bookId}/truth/${artifactFile}`)
        .then((data) => setContent(data.content ?? ""))
        .catch(() => setContent(null))
        .finally(() => setLoading(false));
    }
  }, [bookId, artifactFile, artifactChapter, isChapter]);

  const handleEdit = useCallback(() => {
    setEditContent(content ?? "");
    setEditing(true);
  }, [content]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      if (isChapter) {
        await fetchJson(`/books/${bookId}/chapters/${artifactChapter}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: editContent }),
        });
      } else if (artifactFile) {
        await fetchJson(`/books/${bookId}/truth/${artifactFile}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: editContent }),
        });
      }
      setContent(editContent);
      setEditing(false);
    } catch {
      // keep editing state on error
    } finally {
      setSaving(false);
    }
  }, [bookId, artifactFile, artifactChapter, isChapter, editContent]);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-border/20 shrink-0">
        <button
          onClick={closeArtifact}
          className="w-6 h-6 rounded-md flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-secondary/