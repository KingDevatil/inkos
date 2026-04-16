import { useEffect } from "react";
import { useChatStore } from "../../store/chat";
import type { BookSummary } from "../../store/chat";
import { fetchJson } from "../../hooks/use-api";
import { SidebarCard } from "./SidebarCard";

function parseStoryBible(content: string): BookSummary {
  const sections = content.split(/^##\s+/m);
  let world = "";
  let protagonist = "";
  let cast = "";

  for (const section of sections) {
    if (/^0?1[_\s]|世界观|world/i.test(section)) {
      world = extractFirstContentParagraph(section);
    } else if (/^0?2[_\s]|主角|protagonist/i.test(section)) {
      protagonist = extractFirstContentParagraph(section);
    } else if (/^0?3[_\s]|配角|supporting|cast|势力|人物/i.test(section)) {
      cast = extractFirstContentParagraph(section);
    }
  }

  return { world, protagonist, cast };
}

// 提取第一个真正的内容段落（跳过标题、空行、表格等）
function extractFirstContentParagraph(section: string): string {
  // 去掉章节标题行
  const lines = section.split("\n").slice(1);
  
  for (const line of lines) {
    const trimmed = line.trim();
    // 跳过空行
    if (!trimmed) continue;
    // 跳过标题行（### 开头）
    if (trimmed.startsWith("#")) continue;
    // 跳过表格行
    if (trimmed.startsWith("|") || trimmed.startsWith("+")) continue;
    // 跳过分隔线
    if (/^[-=]{3,}$/.test(trimmed)) continue;
    // 跳过纯加粗的标题
    if (/^\*\*[^*]+\*\*$/.test(trimmed)) continue;
    // 找到第一个内容行，返回它
    return trimmed;
  }
  
  return "";
}

interface SummarySectionProps {
  readonly bookId: string;
}

export function SummarySection({ bookId }: SummarySectionProps) {
  const summary = useChatStore((s) => s.bookSummary);
  const setBookSummary = useChatStore((s) => s.setBookSummary);
  const bookDataVersion = useChatStore((s) => s.bookDataVersion);

  useEffect(() => {
    setBookSummary(null);
    fetchJson<{ content: string | null }>(`/books/${bookId}/truth/story_bible.md`)
      .then((data) => {
        if (data.content) setBookSummary(parseStoryBible(data.content));
      })
      .catch(() => {});
  }, [bookId, bookDataVersion, setBookSummary]);

  if (!summary) return null;

  return (
    <>
      {summary.world && (
        <SidebarCard title="世界观">
          <p className="text-xs text-muted-foreground leading-relaxed line-clamp-4">
            {summary.world}
          </p>
        </SidebarCard>
      )}
      {(summary.protagonist || summary.cast) && (
        <SidebarCard title="角色">
          {summary.protagonist && (
            <p className="text-xs text-muted-foreground leading-relaxed line-clamp-3">
              {summary.protagonist}
            </p>
          )}
          {summary.cast && (
            <p className="text-xs text-muted-foreground leading-relaxed line-clamp-3 mt-2">
              {summary.cast}
            </p>
          )}
        </SidebarCard>
      )}
    </>
  );
}
