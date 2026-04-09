// 简化的审计配置组件 - 用于替换 BookCreate.tsx 中的审计配置部分
// 这个文件展示了新的结构，需要手动合并到 BookCreate.tsx

// 新增状态
const [activeAuditTab, setActiveAuditTab] = useState<"dimensions" | "validation" | "chapter" | "foundation">("dimensions");

// 页签导航
<div className="flex gap-2 mb-6 border-b border-border/50 pb-2">
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
</div>

// Tab 内容
{activeAuditTab === "dimensions" && (
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
)}

{activeAuditTab === "validation" && (
  <div className="space-y-4">
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
