import { BookOpen, Users } from "lucide-react";
import { SidebarCard } from "./SidebarCard";

interface SummarySectionProps {
  readonly worldSummary?: string;
  readonly characterSummary?: string;
}

export function SummarySection({ worldSummary, characterSummary }: SummarySectionProps) {
  return (
    <SidebarCard title="摘要信息" defaultOpen={false}>
      <div className="space-y-3">
        {worldSummary && (
          <div className="space-y-1">
            <div className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
              <BookOpen className="w-3.5 h-3.5" />
              世界观
            </div>
            <p className="text-sm text-foreground/80 line-clamp-4">{worldSummary}</p>
          </div>
        )}
        {characterSummary && (
          <div className="space-y-1">
            <div className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
              <Users className="w-3.5 h-3.5" />
              主要角色
            </div>
            <p className="text-sm text-foreground/80 line-clamp-4">{characterSummary}</p>
          </div>
        )}
        {!worldSummary && !characterSummary && (
          <div className="text-sm text-muted-foreground py-2">暂无摘要信息</div>
        )}
      </div>
    </SidebarCard>
  );
}
