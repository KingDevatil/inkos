# 章节规划审计功能实施计划

## 1. 需求分析

### 1.1 核心需求

* 章节规划生成后需要进行审计

* 审计通过的章节规划才允许落盘保存

* 审计不通过则自动根据审计结果重新生成，最多重复3次

* 超过3次则自动终止

* 用户可手动点击"生成缺失规划"继续生成

### 1.2 参考现有功能

* 章节创作与审计流程（`runner.ts` 中的 `withFoundationReview` 方法）

* 基础设定审核流程（多轮审核，最多重试3次）

## 2. 章节规划审计维度设计（精简版）

参考章节审计维度，结合章节规划阶段特点，采用精简后的10个核心维度：

### 2.1 Critical 维度（严重问题）- 4个

| 维度ID | 维度名称 | 说明 | 检测内容 |
|--------|----------|------|----------|
| outlineDeviation | 大纲偏离检测 | 章节规划是否偏离卷纲设定 | 章节目标是否与卷纲中的章节描述一致 |
| timeline | 时间线一致性 | 章节时间线是否与整体时间线冲突 | 章节时间设定是否与前序章节冲突 |
| settingConflict | 设定冲突 | 章节设定是否与世界观冲突 | 章节中的设定是否违反世界观规则 |
| mainPlotConflict | 主线冲突 | 章节是否与主线剧情冲突 | 章节内容是否与主线剧情发展冲突 |

### 2.2 Warning 维度（警告问题）- 4个

| 维度ID | 维度名称 | 说明 | 检测内容 |
|--------|----------|------|----------|
| foreshadowing | 伏笔处理 | 章节是否合理处理伏笔 | 是否处理了前期埋下的活跃伏笔 |
| plotContinuity | 剧情连贯性 | 章节与前后章节的连贯性 | 与前一章的结尾和后一章的开头是否连贯 |
| hookAlignment | 钩子对齐 | 章节是否与活跃钩子对齐 | 是否对齐了当前活跃的钩子议程 |
| pacing | 节奏合理性 | 章节节奏是否合理 | 章节类型（过渡/高潮）与内容设定是否匹配 |

### 2.3 Info 维度（提示问题）- 2个

| 维度ID | 维度名称 | 说明 | 检测内容 |
|--------|----------|------|----------|
| goalClarity | 目标清晰度 | 章节目标是否清晰 | 章节目标是否明确、可执行 |
| characterConsistency | 角色一致性 | 角色行为是否符合人设 | 角色行为是否符合其当前状态和性格 |

### 2.4 移除的维度说明

以下维度在章节规划阶段检测必要性较低，已移除：

| 移除维度 | 原因 |
|----------|------|
| writingStyle（文风一致性） | 章节规划无实际叙事文本，无法判断文风 |
| emotionalArc（情感弧线） | 情感发展需在内容创作阶段体现 |
| sceneCompleteness（场景完整性） | 相对次要，可在内容阶段检测 |

**总计：10个核心维度**（Critical 4个 + Warning 4个 + Info 2个）

## 3. 技术架构

### 3.1 数据模型扩展

```typescript
// audit-config.ts 扩展
export interface AuditConfig {
  dimensions: AuditDimension[];
  scoring: ScoringConfig;
  validationRules: ValidationRules;
  passCriteria: AuditPassCriteria;
  foundationReview: FoundationReviewConfig;
  chapterPlanAudit: ChapterPlanAuditConfig; // 新增
}

// 章节规划审计配置
export interface ChapterPlanAuditConfig {
  enabled: boolean;                    // 是否启用章节规划审计
  maxRetries: number;                  // 最大重试次数（默认3）
  passThreshold: number;               // 通过阈值（默认80）
  dimensionFloor: number;              // 单个维度最低分（默认60）
  dimensions: ChapterPlanAuditDimension[];  // 10个维度：Critical 4个 + Warning 4个 + Info 2个
}

// 章节规划审计维度（精简版10个维度）
export interface ChapterPlanAuditDimension {
  id: string;                          // 维度ID
  name: string;                        // 维度名称
  enabled: boolean;                    // 是否启用
  weight: number;                      // 权重
  severity: "critical" | "warning" | "info";  // 严重程度
  description: string;                 // 维度说明
  checkContent: string;                // 检测内容说明
}

// 默认章节规划审计维度（10个精简维度）
const DEFAULT_CHAPTER_PLAN_DIMENSIONS: ChapterPlanAuditDimension[] = [
  // Critical - 严重问题（4个）
  {
    id: "outlineDeviation",
    name: "大纲偏离检测",
    enabled: true,
    weight: 1.0,
    severity: "critical",
    description: "章节规划是否偏离卷纲设定",
    checkContent: "章节目标是否与卷纲中的章节描述一致"
  },
  {
    id: "timeline",
    name: "时间线一致性",
    enabled: true,
    weight: 1.0,
    severity: "critical",
    description: "章节时间线是否与整体时间线冲突",
    checkContent: "章节时间设定是否与前序章节冲突"
  },
  {
    id: "settingConflict",
    name: "设定冲突",
    enabled: true,
    weight: 1.0,
    severity: "critical",
    description: "章节设定是否与世界观冲突",
    checkContent: "章节中的设定是否违反世界观规则"
  },
  {
    id: "mainPlotConflict",
    name: "主线冲突",
    enabled: true,
    weight: 1.0,
    severity: "critical",
    description: "章节是否与主线剧情冲突",
    checkContent: "章节内容是否与主线剧情发展冲突"
  },
  // Warning - 警告问题（4个）
  {
    id: "foreshadowing",
    name: "伏笔处理",
    enabled: true,
    weight: 1.0,
    severity: "warning",
    description: "章节是否合理处理伏笔",
    checkContent: "是否处理了前期埋下的活跃伏笔"
  },
  {
    id: "plotContinuity",
    name: "剧情连贯性",
    enabled: true,
    weight: 1.0,
    severity: "warning",
    description: "章节与前后章节的连贯性",
    checkContent: "与前一章的结尾和后一章的开头是否连贯"
  },
  {
    id: "hookAlignment",
    name: "钩子对齐",
    enabled: true,
    weight: 1.0,
    severity: "warning",
    description: "章节是否与活跃钩子对齐",
    checkContent: "是否对齐了当前活跃的钩子议程"
  },
  {
    id: "pacing",
    name: "节奏合理性",
    enabled: true,
    weight: 1.0,
    severity: "warning",
    description: "章节节奏是否合理",
    checkContent: "章节类型（过渡/高潮）与内容设定是否匹配"
  },
  // Info - 提示问题（2个）
  {
    id: "goalClarity",
    name: "目标清晰度",
    enabled: true,
    weight: 1.0,
    severity: "info",
    description: "章节目标是否清晰",
    checkContent: "章节目标是否明确、可执行"
  },
  {
    id: "characterConsistency",
    name: "角色一致性",
    enabled: true,
    weight: 1.0,
    severity: "info",
    description: "角色行为是否符合人设",
    checkContent: "角色行为是否符合其当前状态和性格"
  }
];

// 章节规划审计结果
export interface ChapterPlanAuditResult {
  passed: boolean;
  score: number;
  dimensions: ChapterPlanAuditDimensionResult[];
  issues: ChapterPlanAuditIssue[];
  summary: string;
}

export interface ChapterPlanAuditDimensionResult {
  id: string;
  name: string;
  score: number;
  passed: boolean;
  feedback?: string;
}

export interface ChapterPlanAuditIssue {
  dimensionId: string;
  severity: "critical" | "warning" | "info";
  description: string;
  suggestion?: string;
}
```

### 3.2 审计Agent设计

创建新的 `ChapterPlanAuditor` Agent：

```typescript
// agents/chapter-plan-auditor.ts
export class ChapterPlanAuditor extends BaseAgent {
  async audit(params: {
    chapterNumber: number;
    chapterPlan: ChapterIntent;      // 章节规划内容
    volumeOutline: string;            // 卷纲
    volumeDetail?: string;            // 详细卷纲（可选）
    previousChapterPlans?: ChapterIntent[]; // 前序章节规划
    bookRules: BookRules;
    config: ChapterPlanAuditConfig;
  }): Promise<ChapterPlanAuditResult>;
}
```

## 4. 前端实现

### 4.1 审计配置页面扩展

在 `ConfigView.tsx` 中新增"章节规划审计"页签：

```typescript
// 页签结构
<Tabs>
  <Tab value="general">通用配置</Tab>
  <Tab value="audit">章节审计</Tab>
  <Tab value="chapter-plan-audit">章节规划审计</Tab>  // 新增
  <Tab value="foundation">基础设定审核</Tab>
</Tabs>

// 章节规划审计配置面板
<ChapterPlanAuditConfigPanel
  config={chapterPlanAuditConfig}
  onChange={setChapterPlanAuditConfig}
/>
```

### 4.2 章节规划审计配置组件

功能包括：

* **启用/禁用章节规划审计开关** - 控制是否启用审计

* **最大重试次数设置**（1-5次，默认3次）- 审计不通过时的最大重试次数

* **通过阈值设置**（60-100，默认80）- 总分通过阈值

* **单个维度最低分设置**（默认60）- 单个维度最低通过分数

* **审计维度列表**（10个维度）- 可启用/禁用、调整权重：
  * **Critical（4个）**：大纲偏离检测、时间线一致性、设定冲突、主线冲突
  * **Warning（4个）**：伏笔处理、剧情连贯性、钩子对齐、节奏合理性
  * **Info（2个）**：目标清晰度、角色一致性

* **每个维度的详细说明** - 显示维度的检测内容和标准

### 4.3 章节规划页面增强

在 `BookDetail.tsx` 的章节规划部分：

```typescript
// 显示审计状态
{chapterPlanStatus[chapterNumber]?.auditStatus === 'auditing' && (
  <span className="text-blue-600 animate-pulse">审计中...</span>
)}

{chapterPlanStatus[chapterNumber]?.auditStatus === 'failed' && (
  <span className="text-red-600">审计失败</span>
)}

{chapterPlanStatus[chapterNumber]?.auditStatus === 'passed' && (
  <span className="text-green-600">审计通过</span>
)}

// 生成缺失规划按钮（右下角）
<button onClick={generateMissingPlans}>
  生成缺失规划
</button>
```

## 5. 后端实现

### 5.1 API 扩展

```typescript
// server.ts 新增端点

// 获取章节规划审计配置
app.get("/api/audit-config/chapter-plan", async (c) => {
  const config = loadAuditConfig();
  return c.json({ config: config.chapterPlanAudit });
});

// 保存章节规划审计配置
app.put("/api/audit-config/chapter-plan", async (c) => {
  const body = await c.req.json();
  const config = loadAuditConfig();
  config.chapterPlanAudit = body.config;
  saveGlobalAuditConfig(config);
  return c.json({ ok: true });
});

// 审计单个章节规划
app.post("/api/books/:id/chapters/:chapterNumber/plan-audit", async (c) => {
  const bookId = c.req.param("id");
  const chapterNumber = parseInt(c.req.param("chapterNumber"), 10);
  const result = await auditChapterPlan(bookId, chapterNumber);
  return c.json(result);
});
```

### 5.2 Pipeline Runner 扩展

修改 `generateChapterPlansForVolume` 方法：

```typescript
async generateChapterPlansForVolume(bookId: string, volumeId: number): Promise<void> {
  // ... 原有代码 ...
  
  const auditConfig = loadAuditConfig().chapterPlanAudit;
  
  // 生成章节规划
  for (let chapterNumber = startChapter; chapterNumber <= endChapter; chapterNumber++) {
    let attempt = 0;
    let auditResult: ChapterPlanAuditResult | null = null;
    
    do {
      // 生成章节规划
      const plan = await this.generateChapterPlan(bookId, chapterNumber);
      
      // 审计章节规划
      if (auditConfig.enabled) {
        auditResult = await this.auditChapterPlan(bookId, chapterNumber, plan);
        
        if (auditResult.passed) {
          // 审计通过，保存规划
          await this.saveChapterPlan(bookId, chapterNumber, plan);
          break;
        } else if (attempt < auditConfig.maxRetries) {
          // 审计未通过，根据反馈重新生成
          this.logWarn(language, {
            zh: `第${chapterNumber}章规划审计未通过（${auditResult.score}分），正在重新生成...`,
            en: `Chapter ${chapterNumber} plan audit failed (${auditResult.score}), regenerating...`,
          });
        }
      } else {
        // 审计未启用，直接保存
        await this.saveChapterPlan(bookId, chapterNumber, plan);
        break;
      }
      
      attempt++;
    } while (attempt <= auditConfig.maxRetries);
    
    // 超过最大重试次数
    if (auditConfig.enabled && auditResult && !auditResult.passed && attempt > auditConfig.maxRetries) {
      this.logError(language, {
        zh: `第${chapterNumber}章规划审计连续${auditConfig.maxRetries}次未通过，已终止`,
        en: `Chapter ${chapterNumber} plan audit failed ${auditConfig.maxRetries} times, terminated`,
      });
      // 标记为需要手动处理
      await this.markChapterPlanAsFailed(bookId, chapterNumber, auditResult);
    }
  }
}

// 新增方法：审计章节规划
async auditChapterPlan(
  bookId: string, 
  chapterNumber: number, 
  plan: ChapterIntent
): Promise<ChapterPlanAuditResult> {
  const book = await this.state.loadBookConfig(bookId);
  const bookDir = this.state.bookDir(bookId);
  const config = loadAuditConfig().chapterPlanAudit;
  
  const auditor = new ChapterPlanAuditor(this.agentCtxFor("chapter-plan-auditor", bookId));
  
  return await auditor.audit({
    chapterNumber,
    chapterPlan: plan,
    volumeOutline: await this.readVolumeOutline(bookDir),
    volumeDetail: await this.readVolumeDetail(bookDir, this.getVolumeId(chapterNumber)),
    previousChapterPlans: await this.readPreviousChapterPlans(bookDir, chapterNumber),
    bookRules: await this.readBookRules(bookDir),
    config,
  });
}
```

## 6. 实施步骤

### Phase 1: 数据模型和配置（1-2天）

1. [ ] 扩展 `audit-config.ts`，添加 `ChapterPlanAuditConfig` 类型（10个精简维度）
2. [ ] 创建 `ChapterPlanAuditor` Agent 基础结构
3. [ ] 更新默认配置，添加章节规划审计默认维度（Critical 4个 + Warning 4个 + Info 2个）

### Phase 2: 后端实现（2-3天）

1. [ ] 实现 `ChapterPlanAuditor` Agent 的审计逻辑
2. [ ] 修改 `generateChapterPlansForVolume` 方法，集成审计流程
3. [ ] 添加 API 端点：获取/保存章节规划审计配置
4. [ ] 添加 API 端点：手动触发单个章节规划审计

### Phase 3: 前端实现（2-3天）

1. [ ] 创建 `ChapterPlanAuditConfigPanel` 组件
2. [ ] 在 `ConfigView.tsx` 中添加"章节规划审计"页签
3. [ ] 增强 `BookDetail.tsx` 章节规划部分，显示审计状态
4. [ ] 添加"生成缺失规划"按钮功能

### Phase 4: 测试和优化（1-2天）

1. [ ] 单元测试：ChapterPlanAuditor
2. [ ] 集成测试：章节规划生成+审计流程
3. [ ] 前端测试：配置页面和状态显示
4. [ ] 性能优化：审计Prompt优化

## 7. 文件变更清单

### 新增文件

* `packages/core/src/agents/chapter-plan-auditor.ts` - 章节规划审计Agent

* `packages/core/src/agents/chapter-plan-auditor-prompts.ts` - 审计Prompt

### 修改文件

* `packages/core/src/config/audit-config.ts` - 扩展审计配置类型

* `packages/core/src/pipeline/runner.ts` - 集成审计流程

* `packages/studio/src/api/server.ts` - 新增API端点

* `packages/studio/src/pages/ConfigView.tsx` - 添加审计配置页签

* `packages/studio/src/pages/BookDetail.tsx` - 显示审计状态

## 8. 风险评估

| 风险               | 影响 | 缓解措施             |
| ---------------- | -- | ---------------- |
| 审计Prompt设计不当导致误报 | 高  | 多轮测试，参考章节审计经验    |
| 审计增加生成时间         | 中  | 可配置禁用，优化Prompt   |
| 与现有章节审计重复        | 低  | 明确分工：规划审意图，章节审内容 |

## 9. 验收标准

* [ ] 章节规划审计配置页面正常显示和保存

* [ ] 启用审计后，章节规划生成后会自动审计

* [ ] 审计不通过时自动重试，最多3次

* [ ] 超过3次后标记为失败，显示"生成缺失规划"按钮

* [ ] 用户可以手动触发单个章节规划审计

* [ ] 审计结果正确显示在

