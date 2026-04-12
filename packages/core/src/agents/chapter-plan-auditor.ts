import { BaseAgent, type AgentContext } from "./base.js";
import type { ChapterIntent } from "../models/input-governance.js";
import type { BookRules } from "../models/book-rules.js";
import type {
  ChapterPlanAuditConfig,
  ChapterPlanAuditResult,
  ChapterPlanAuditDimensionResult,
  ChapterPlanAuditIssue,
} from "../config/audit-config.js";

export interface ChapterPlanAuditParams {
  chapterNumber: number;
  chapterPlan: ChapterIntent;
  volumeOutline: string;
  volumeDetail?: string;
  previousChapterPlans?: ChapterIntent[];
  bookRules: BookRules;
  config: ChapterPlanAuditConfig;
}

/**
 * 章节规划审计 Agent
 * 用于审计生成的章节规划是否符合要求
 */
export class ChapterPlanAuditor extends BaseAgent {
  get name(): string {
    return "ChapterPlanAuditor";
  }

  constructor(ctx: AgentContext) {
    super(ctx);
  }

  /**
   * 审计章节规划
   */
  async audit(params: ChapterPlanAuditParams): Promise<ChapterPlanAuditResult> {
    const { chapterNumber, chapterPlan, volumeOutline, volumeDetail, previousChapterPlans, bookRules, config } = params;

    // 如果审计未启用，直接返回通过
    if (!config.enabled) {
      return {
        passed: true,
        score: 100,
        dimensions: [],
        issues: [],
        summary: "章节规划审计已禁用",
      };
    }

    // 构建审计 Prompt
    const prompt = this.buildAuditPrompt({
      chapterNumber,
      chapterPlan,
      volumeOutline,
      volumeDetail,
      previousChapterPlans,
      bookRules,
      config,
    });

    // 调用 LLM 进行审计
    const response = await this.chat([
      { role: "system", content: this.getSystemPrompt(config) },
      { role: "user", content: prompt },
    ], {
      maxTokens: 4096,
      temperature: 0.3,
    });

    // 解析审计结果
    const auditResult = this.parseAuditResult(response.content, config);

    // 计算是否通过
    auditResult.passed = this.calculatePassStatus(auditResult, config);

    return auditResult;
  }

  /**
   * 获取系统 Prompt
   */
  private getSystemPrompt(config: ChapterPlanAuditConfig): string {
    const enabledDimensions = config.dimensions.filter(d => d.enabled);
    
    const dimensionList = enabledDimensions
      .map(d => `- ${d.name} (${d.severity}): ${d.description}`)
      .join("\n");

    return `你是一位专业的章节规划审计专家。你的任务是审计章节规划是否符合要求。

## 审计维度

${dimensionList}

## 评分标准

- 每个维度满分 100 分
- Critical 维度低于 ${config.dimensionFloor} 分直接判定为不通过
- 总分低于 ${config.passThreshold} 分判定为不通过

## 输出格式

请以 JSON 格式输出审计结果：

{
  "score": 85,
  "dimensions": [
    {
      "id": "outlineDeviation",
      "score": 90,
      "feedback": "章节目标与卷纲描述一致"
    }
  ],
  "issues": [
    {
      "dimensionId": "timeline",
      "severity": "warning",
      "description": "时间线描述不够清晰",
      "suggestion": "建议明确标注具体时间点"
    }
  ],
  "summary": "章节规划整体符合要求，时间线描述可以更加清晰"
}`;
  }

  /**
   * 构建审计 Prompt
   */
  private buildAuditPrompt(params: ChapterPlanAuditParams): string {
    const { chapterNumber, chapterPlan, volumeOutline, volumeDetail, previousChapterPlans, bookRules, config } = params;

    let prompt = `## 审计章节规划

### 章节信息
- 章节编号: 第 ${chapterNumber} 章

### 卷纲信息
${volumeOutline}

`;

    if (volumeDetail) {
      prompt += `### 详细卷纲
${volumeDetail}

`;
    }

    if (previousChapterPlans && previousChapterPlans.length > 0) {
      prompt += `### 前序章节规划
${previousChapterPlans.map((p, i) => `第 ${chapterNumber - previousChapterPlans.length + i} 章: ${p.goal}`).join("\n")}

`;
    }

    prompt += `### 书籍规则
${JSON.stringify(bookRules, null, 2)}

### 待审计的章节规划
${JSON.stringify(chapterPlan, null, 2)}

### 审计要求

请对以上章节规划进行审计，重点关注：

${config.dimensions
  .filter(d => d.enabled)
  .map(d => `- ${d.name}: ${d.checkContent}`)
  .join("\n")}

请给出详细的审计结果。`;

    return prompt;
  }

  /**
   * 解析审计结果
   */
  private parseAuditResult(content: string, config: ChapterPlanAuditConfig): ChapterPlanAuditResult {
    try {
      // 尝试提取 JSON
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error("无法解析审计结果");
      }

      const result = JSON.parse(jsonMatch[0]);

      // 构建维度结果
      const dimensionResults: ChapterPlanAuditDimensionResult[] = config.dimensions
        .filter(d => d.enabled)
        .map(d => {
          const dimResult = result.dimensions?.find((dr: any) => dr.id === d.id);
          return {
            id: d.id,
            name: d.name,
            score: dimResult?.score ?? 100,
            passed: (dimResult?.score ?? 100) >= config.dimensionFloor,
            feedback: dimResult?.feedback,
          };
        });

      // 构建问题列表
      const issues: ChapterPlanAuditIssue[] = (result.issues || []).map((issue: any) => ({
        dimensionId: issue.dimensionId,
        severity: issue.severity,
        description: issue.description,
        suggestion: issue.suggestion,
      }));

      return {
        passed: false, // 稍后计算
        score: result.score || 0,
        dimensions: dimensionResults,
        issues,
        summary: result.summary || "",
      };
    } catch (error) {
      // 解析失败，返回默认结果
      return {
        passed: false,
        score: 0,
        dimensions: config.dimensions
          .filter(d => d.enabled)
          .map(d => ({
            id: d.id,
            name: d.name,
            score: 0,
            passed: false,
            feedback: "审计结果解析失败",
          })),
        issues: [{
          dimensionId: "system",
          severity: "critical",
          description: `审计结果解析失败: ${error instanceof Error ? error.message : String(error)}`,
        }],
        summary: "审计过程出现错误，请重试",
      };
    }
  }

  /**
   * 计算是否通过
   */
  private calculatePassStatus(result: ChapterPlanAuditResult, config: ChapterPlanAuditConfig): boolean {
    // 检查总分
    if (result.score < config.passThreshold) {
      return false;
    }

    // 检查单个维度
    for (const dim of result.dimensions) {
      if (dim.score < config.dimensionFloor) {
        return false;
      }
    }

    // 检查是否有 critical 问题
    const hasCriticalIssue = result.issues.some(i => i.severity === "critical");
    if (hasCriticalIssue) {
      return false;
    }

    return true;
  }
}
