import { BookOpen, FileText, Scroll, Settings } from "lucide-react";
import { SidebarCard } from "./SidebarCard";

interface FoundationFile {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
}

interface FoundationSectionProps {
  readonly files?: FoundationFile[];
  readonly onFileClick?: (fileId: string) => void;
}

const DEFAULT_FILES: FoundationFile[] = [
  { id: "story_bible", name: "世界观设定", description: "故事背景、规则、势力" },
  { id: "volume_outline", name: "卷纲规划", description: "分卷结构、章节安排" },
  { id: "book_rules", name: "本书规则", description: "写作规范、风格要求" },
  { id: "style_guide", name: "文风指南", description: "语言风格、叙事特点" },
];

export function FoundationSection({ files = DEFAULT_FILES, onFileClick }: FoundationSectionProps) {
  const getIcon = (id: string) => {
    switch (id) {
      case "story_bible":
        return <BookOpen className="w-4 h-4" />;
      case "volume_outline":
        return <Scroll className="w-4 h-4" />;
      case "book_rules":
        return <Settings className="w-4 h-4" />;
      default:
        return <FileText className="w-4 h-4" />;
    }
  };

  return (
    <SidebarCard title="核心文件" defaultOpen={true}>
      <div className="space-y-1">
        {files.map((file) => (
          <button
            key={file.id}
            onClick={() => onFileClick?.(file.id)}
            className="w-full flex items-center gap-2 px-2 py-2 text-sm rounded-lg hover:bg-accent transition-colors text-left"
          >
            <span className="text-muted-foreground">{getIcon(file.id)}</span>
            <div className="flex-1 min-w-0">
              <div className="font-medium truncate">{file.name}</div>
              {file.description && (
                <div className="text-xs text-muted-foreground truncate">{file.description}</div>
              )}
            </div>
          </button>
        ))}
      </div>
    </SidebarCard>
  );
}
