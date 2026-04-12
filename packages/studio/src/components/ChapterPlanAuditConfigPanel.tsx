import { useState, useEffect } from "react";
import { Switch } from "./ui/switch";
import { Slider } from "./ui/slider";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Badge } from "./ui/badge";
import { AlertCircle, Info, AlertTriangle, CheckCircle2 } from "lucide-react";

interface ChapterPlanAuditDimension {
  id: string;
  name: string;
  enabled: boolean;
  weight: number;
  severity: "critical" | "warning" | "info";
  description: string;
  checkContent: string;
}

interface ChapterPlanAuditConfig {
  enabled: boolean;
  maxRetries: number;
  passThreshold: number;
  dimensionFloor: number;
  dimensions: ChapterPlanAuditDimension[];
}

interface ChapterPlanAuditConfigPanelProps {
  config: ChapterPlanAuditConfig;
  onChange: (config: ChapterPlanAuditConfig) => void;
}

const severityIcons = {
  critical: <AlertCircle className="w-4 h-4 text-red-500" />,
  warning: <AlertTriangle className="w-4 h-4 text-amber-500" />,
  info: <Info className="w-4 h-4 text-blue-500" />,
};

const severityLabels = {
  critical: "严重",
  warning: "警告",
  info: "提示",
};

const severityColors = {
  critical: "bg-red-100 text-red-800 border-red-200",
  warning: "bg-amber-100 text-amber-800 border-amber-200",
  info: "bg-blue-100 text-blue-800 border-blue-200",
};

export function ChapterPlanAuditConfigPanel({ config, onChange }: ChapterPlanAuditConfigPanelProps) {
  const [localConfig, setLocalConfig] = useState<ChapterPlanAuditConfig>(config);

  useEffect(() => {
    setLocalConfig(config);
  }, [config]);

  const updateConfig = (updates: Partial<ChapterPlanAuditConfig>) => {
    const newConfig = { ...localConfig, ...updates };
    setLocalConfig(newConfig);
    onChange(newConfig);
  };

  const updateDimension = (id: string, updates: Partial<ChapterPlanAuditDimension>) => {
    const newDimensions = localConfig.dimensions.map((d) =>
      d.id === id ? { ...d, ...updates } : d
    );
    updateConfig({ dimensions: newDimensions });
  };

  const criticalDimensions = localConfig.dimensions.filter((d) => d.severity === "critical");
  const warningDimensions = localConfig.dimensions.filter((d) => d.severity === "warning");
  const infoDimensions = localConfig.dimensions.filter((d) => d.severity === "info");

  return (
    <div className="space-y-6">
      {/* 启用开关 */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            <span>启用章节规划审计</span>
            <Switch
              checked={localConfig.enabled}
              onCheckedChange={(checked) => updateConfig({ enabled: checked })}
            />
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            启用后，生成的章节规划将自动进行审计，只有通过审计的规划才会被保存。
          </p>
        </CardContent>
      </Card>

      {localConfig.enabled && (
        <>
          {/* 基本设置 */}
          <Card>
            <CardHeader>
              <CardTitle>基本设置</CardTitle>
            </CardHeader>
            <CardContent className="space-y-6">
              {/* 最大重试次数 */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-sm font-medium">最大重试次数</label>
                  <span className="text-sm text-muted-foreground">{localConfig.maxRetries} 次</span>
                </div>
                <Slider
                  value={[localConfig.maxRetries]}
                  onValueChange={(value) => updateConfig({ maxRetries: Array.isArray(value) ? value[0] : value })}
                  min={1}
                  max={5}
                  step={1}
                />
                <p className="text-xs text-muted-foreground">
                  审计不通过时的最大重试次数，超过此次数将标记为失败
                </p>
              </div>

              {/* 通过阈值 */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-sm font-medium">通过阈值</label>
                  <span className="text-sm text-muted-foreground">{localConfig.passThreshold} 分</span>
                </div>
                <Slider
                  value={[localConfig.passThreshold]}
                  onValueChange={(value) => updateConfig({ passThreshold: Array.isArray(value) ? value[0] : value })}
                  min={60}
                  max={100}
                  step={5}
                />
                <p className="text-xs text-muted-foreground">
                  总分达到此分数才算通过审计
                </p>
              </div>

              {/* 单个维度最低分 */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-sm font-medium">单个维度最低分</label>
                  <span className="text-sm text-muted-foreground">{localConfig.dimensionFloor} 分</span>
                </div>
                <Slider
                  value={[localConfig.dimensionFloor]}
                  onValueChange={(value) => updateConfig({ dimensionFloor: Array.isArray(value) ? value[0] : value })}
                  min={40}
                  max={80}
                  step={5}
                />
                <p className="text-xs text-muted-foreground">
                  单个维度低于此分数将直接判定为不通过
                </p>
              </div>
            </CardContent>
          </Card>

          {/* 审计维度 */}
          <Card>
            <CardHeader>
              <CardTitle>审计维度</CardTitle>
            </CardHeader>
            <CardContent className="space-y-6">
              {/* Critical 维度 */}
              <div className="space-y-3">
                <h4 className="text-sm font-semibold flex items-center gap-2">
                  {severityIcons.critical}
                  严重问题（{criticalDimensions.filter((d) => d.enabled).length}/{criticalDimensions.length}）
                </h4>
                <div className="space-y-2">
                  {criticalDimensions.map((dimension) => (
                    <DimensionCard
                      key={dimension.id}
                      dimension={dimension}
                      onToggle={(enabled) => updateDimension(dimension.id, { enabled })}
                    />
                  ))}
                </div>
              </div>

              {/* Warning 维度 */}
              <div className="space-y-3">
                <h4 className="text-sm font-semibold flex items-center gap-2">
                  {severityIcons.warning}
                  警告问题（{warningDimensions.filter((d) => d.enabled).length}/{warningDimensions.length}）
                </h4>
                <div className="space-y-2">
                  {warningDimensions.map((dimension) => (
                    <DimensionCard
                      key={dimension.id}
                      dimension={dimension}
                      onToggle={(enabled) => updateDimension(dimension.id, { enabled })}
                    />
                  ))}
                </div>
              </div>

              {/* Info 维度 */}
              <div className="space-y-3">
                <h4 className="text-sm font-semibold flex items-center gap-2">
                  {severityIcons.info}
                  提示问题（{infoDimensions.filter((d) => d.enabled).length}/{infoDimensions.length}）
                </h4>
                <div className="space-y-2">
                  {infoDimensions.map((dimension) => (
                    <DimensionCard
                      key={dimension.id}
                      dimension={dimension}
                      onToggle={(enabled) => updateDimension(dimension.id, { enabled })}
                    />
                  ))}
                </div>
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

interface DimensionCardProps {
  dimension: ChapterPlanAuditDimension;
  onToggle: (enabled: boolean) => void;
}

function DimensionCard({ dimension, onToggle }: DimensionCardProps) {
  return (
    <div
      className={`p-3 rounded-lg border transition-all ${
        dimension.enabled ? "bg-card" : "bg-muted/50 opacity-60"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="font-medium text-sm">{dimension.name}</span>
            <Badge variant="outline" className={severityColors[dimension.severity]}>
              {severityLabels[dimension.severity]}
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground mb-1">{dimension.description}</p>
          <p className="text-xs text-muted-foreground">
            <span className="font-medium">检测内容：</span>
            {dimension.checkContent}
          </p>
        </div>
        <Switch checked={dimension.enabled} onCheckedChange={onToggle} />
      </div>
    </div>
  );
}
