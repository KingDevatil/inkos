import { FileText, ChevronRight } from "lucide-react";
import { SidebarCard } from "./SidebarCard";

interface Chapter {
  readonly number: number;
  readonly title: string;
  readonly status?: "draft" | "audited" | "revised";
}

interface ChaptersSectionProps {
  readonly chapters?: Chapter[];
  readonly currentChapter?: number;
  readonly onChapterClick?: (chapterNumber: number) => void;
}

export function ChaptersSection({ chapters = [], currentChapter, onChapterClick }: ChaptersSectionProps) {
  return (
    <SidebarCard title="章节列表" defaultOpen={true}>
      <div className="space-y-1 max-h-64 overflow-y-auto">
        {chapters.length === 0 ? (
          <div className="text-sm text-muted-foreground py-2">暂无章节</div>
        ) : (
          chapters.map((chapter) => {
            const isCurrent = chapter.number === currentChapter;
            return (
              <button
                key={chapter.number}
                onClick={() => onChapterClick?.(chapter.number)}
                className={`w-full flex items-center gap-2 px-2 py-1.5 text-sm rounded-lg transition-colors text-left ${
                  isCurrent
                    ? "bg-primary/10 text-primary"
                    : "hover:bg-accent text-foreground"
                }`}
              >
                <FileText className="w-4 h-4 flex-shrink-0" />
                <span className="flex-1 truncate">
                  第{chapter.number}章 {chapter.title}
                </span>
                <ChevronRight className="w-3 h-3 text-muted-foreground" />
              </button>
            );
          })
        )}
      </div>
    </SidebarCard>
  );
}
