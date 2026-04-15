import { CheckCircle2, Circle, Loader2 } from "lucide-react";
import { SidebarCard } from "./SidebarCard";

interface ProgressStep {
  readonly label: string;
  readonly status: "pending" | "running" | "completed" | "error";
}

interface ProgressSectionProps {
  readonly steps?: ProgressStep[];
  readonly currentStep?: number;
  readonly isRunning?: boolean;
}

export function ProgressSection({ steps = [], currentStep = -1, isRunning = false }: ProgressSectionProps) {
  if (!isRunning && steps.length === 0) {
    return (
      <SidebarCard title="执行进度" defaultOpen={false}>
        <div className="text-sm text-muted-foreground py-2">暂无执行中的任务</div>
      </SidebarCard>
    );
  }

  return (
    <SidebarCard title="执行进度" defaultOpen={true}>
      <div className="space-y-2">
        {steps.map((step, index) => {
          const isActive = index === currentStep;
          const isCompleted = step.status === "completed";
          const isError = step.status === "error";
          const isRunningStep = step.status === "running";

          return (
            <div
              key={index}
              className={`flex items-center gap-2 text-sm ${
                isActive ? "text-primary" : isCompleted ? "text-muted-foreground" : "text-muted-foreground/60"
              }`}
            >
              {isCompleted ? (
                <CheckCircle2 className="w-4 h-4 text-green-500" />
              ) : isError ? (
                <Circle className="w-4 h-4 text-red-500" />
              ) : isRunningStep || (isActive && isRunning) ? (
                <Loader2 className="w-4 h-4 animate-spin text-primary" />
              ) : (
                <Circle className="w-4 h-4" />
              )}
              <span className={isActive ? "font-medium" : ""}>{step.label}</span>
            </div>
          );
        })}
      </div>
    </SidebarCard>
  );
}
