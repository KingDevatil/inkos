import { BaseAgent } from "./base.js";
import type { ArchitectOutput } from "./architect.js";

export interface FoundationReviewResult {
  readonly passed: boolean;
  readonly totalScore: number;
  readonly dimensions: ReadonlyArray<{
    readonly name: string;
    readonly score: number;
    readonly feedback: string;
  }>;
  readonly overallFeedback: string;
}

// 默认值
const DEFAULT_PASS_THRESHOLD = 80;
const DEFAULT_DIMENSION_FLOOR = 60;

export class FoundationReviewerAgent extends BaseAgent {
  get name(): string {
    return "foundation-reviewer";
  }

  async review(params: {
    readonly foundation: ArchitectOutput;
    readonly mode: "original" | "fanfic" | "series";
    readonly sourceCanon?: string;
    readonly styleGuide?: string;
    readonly language: "zh" | "en";
    readonly passThreshold?: number;
    readonly dimensionFloor?: number;
  }): Promise<FoundationReviewResult> {
    const canonBlock = params.sourceCanon
      ? `\n## 原作正典参照\n${params.sourceCanon.slice(0, 8000)}\n`
      : "";
    const styleBlock = params.styleGuide
      ? `\n## 原作风格参照\n${params.styleGuide.slice(0, 2000)}\n`
      : "";

    const dimensions = params.mode === "original"
      ? this.originalDimensions(params.language)
      : this.derivativeDimensions(params.language, params.mode);

    const systemPrompt = params.language === "en"
      ? this.buildEnglishReviewPrompt(dimensions, canonBlock, styleBlock)
      : this.buildChineseReviewPrompt(dimensions, canonBlock, styleBlock);

    const userPrompt = this.buildFoundationExcerpt(params.foundation, params.language);

    const response = await this.chat([
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ], { maxTokens: 4096, temperature: 0.3 });

    const passThreshold = params.passThreshold ?? DEFAULT_PASS_THRESHOLD;
    const dimensionFloor = params.dimensionFloor ?? DEFAULT_DIMENSION_FLOOR;

    return this.parseReviewResult(response.content, dimensions, passThreshold, dimensionFloor, params.language);
  }

  private originalDimensions(language: "zh" | "en"): ReadonlyArray<string> {
    return language === "en"
      ? [
          "Core Conflict (Is there a clear, compelling central conflict that can sustain 40 chapters?)",
          "Opening Momentum (Can the first 5 chapters create a page-turning hook?)",
          "World Coherence (Is the worldbuilding internally consistent and specific?)",
          "Character Differentiation (Are the main characters distinct in voice and motivation?)",
          "Pacing Feasibility (Does the volume outline have enough variety — not the same beat for 10 chapters?)",
        ]
      : [
          "核心冲突（是否有清晰且有足够张力的核心冲突支撑40章？）",
          "开篇节奏（前5章能否形成翻页驱动力？）",
          "世界一致性（世界观是否内洽且具体？）",
          "角色区分度（主要角色的声音和动机是否各不相同？）",
          "节奏可行性（卷纲是否有足够变化——不会连续10章同一种节拍？）",
        ];
  }

  private derivativeDimensions(language: "zh" | "en", mode: "fanfic" | "series"): ReadonlyArray<string> {
    const modeLabel = mode === "fanfic"
      ? (language === "en" ? "Fan Fiction" : "同人")
      : (language === "en" ? "Series" : "系列");

    return language === "en"
      ? [
          `Source DNA Preservation (Does the ${modeLabel} respect the original's world rules, character personalities, and established facts?)`,
          `New Narrative Space (Is there a clear divergence point or new territory that gives the story room to be ORIGINAL, not a retelling?)`,
          "Core Conflict (Is the new story's central conflict compelling and distinct from the original?)",
          "Opening Momentum (Can the first 5 chapters create a page-turning hook without requiring 3 chapters of setup?)",
          `Pacing Feasibility (Does the outline avoid the trap of re-walking the original's plot beats?)`,
        ]
      : [
          `原作DNA保留（${modeLabel}是否尊重原作的世界规则、角色性格、已确立事实？）`,
          `新叙事空间（是否有明确的分岔点或新领域，让故事有原创空间，而非复述原作？）`,
          "核心冲突（新故事的核心冲突是否有足够张力且区别于原作？）",
          "开篇节奏（前5章能否形成翻页驱动力，不需要3章铺垫？）",
          `节奏可行性（卷纲是否避免了重走原作剧情节拍的陷阱？）`,
        ];
  }

  private buildChineseReviewPrompt(
    dimensions: ReadonlyArray<string>,
    canonBlock: string,
    styleBlock: string,
  ): string {
    return `你是一位资深小说编辑，正在审核一本新书的基础设定（世界观 + 大纲 + 规则）。

你需要从以下维度逐项打分（0-100），并给出具体意见：

${dimensions.map((dim, i) => `${i + 1}. ${dim}`).join("\n")}

## 评分标准
- 80+ 通过，可以开始写作
- 60-79 有明显问题，需要修改
- <60 方向性错误，需要重新设计

## 输出格式（严格遵守）
=== DIMENSION: 1 ===
分数：{0-100}
意见：{具体反馈}

=== DIMENSION: 2 ===
分数：{0-100}
意见：{具体反馈}

...（每个维度一个 block）

=== OVERALL ===
总分：{加权平均}
通过：{是/否}
总评：{1-2段总结，指出最大的问题和最值得保留的优点}
${canonBlock}${styleBlock}

审核时要严格。不要因为"还行"就给高分。80分意味着"可以直接开写，不需要改"。`;
  }

  private buildEnglishReviewPrompt(
    dimensions: ReadonlyArray<string>,
    canonBlock: string,
    styleBlock: string,
  ): string {
    return `You are a senior fiction editor reviewing a new book's foundation (worldbuilding + outline + rules).

Score each dimension (0-100) with specific feedback:

${dimensions.map((dim, i) => `${i + 1}. ${dim}`).join("\n")}

## Scoring
- 80+ Pass — ready to write
- 60-79 Needs revision
- <60 Fundamental direction problem

## Output format (strict)
=== DIMENSION: 1 ===
Score: {0-100}
Feedback: {specific feedback}

=== DIMENSION: 2 ===
Score: {0-100}
Feedback: {specific feedback}

...

=== OVERALL ===
Total: {weighted average}
Passed: {yes/no}
Summary: {1-2 paragraphs — biggest problem and best quality}
${canonBlock}${styleBlock}

Be strict. 80 means "ready to write without changes."`;
  }

  private buildFoundationExcerpt(foundation: ArchitectOutput, language: "zh" | "en"): string {
    return language === "en"
      ? `=== SECTION: story_bible ===\n${foundation.storyBible.slice(0, 3000)}\n\n=== SECTION: volume_outline ===\n${foundation.volumeOutline.slice(0, 3000)}\n\n=== SECTION: book_rules ===\n${foundation.bookRules.slice(0, 1500)}\n\n=== SECTION: current_state ===\n${foundation.currentState.slice(0, 1000)}\n\n=== SECTION: pending_hooks ===\n${foundation.pendingHooks.slice(0, 1000)}`
      : `=== SECTION: story_bible ===\n${foundation.storyBible.slice(0, 3000)}\n\n=== SECTION: volume_outline ===\n${foundation.volumeOutline.slice(0, 3000)}\n\n=== SECTION: book_rules ===\n${foundation.bookRules.slice(0, 1500)}\n\n=== SECTION: current_state ===\n${foundation.currentState.slice(0, 1000)}\n\n=== SECTION: pending_hooks ===\n${foundation.pendingHooks.slice(0, 1000)}`;
  }

  private parseReviewResult(
    content: string,
    dimensions: ReadonlyArray<string>,
    passThreshold: number,
    dimensionFloor: number,
    language: "zh" | "en",
  ): FoundationReviewResult {
    const parsedDimensions: Array<{ readonly name: string; readonly score: number; readonly feedback: string }> = [];

    // Debug: log the raw content for troubleshooting
    console.log("[FoundationReviewer] Raw AI response:");
    console.log(content.slice(0, 2000));
    console.log("...");

    for (let i = 0; i < dimensions.length; i++) {
      // Match dimension block: === DIMENSION: N === followed by score and feedback
      // The feedback ends before the next dimension header (=== DIMENSION:) or end of string
      const regex = new RegExp(
        `=== DIMENSION: ${i + 1} ===\\s*(?:分数|Score)?[：:]?\\s*(\\d+)?[\\s\\S]*?(?:意见|Feedback)[：:]\\s*([\\s\\S]*?)(?=\\n=== DIMENSION:|$)`,
        "i"
      );
      const match = content.match(regex);

      if (!match) {
        console.log(`[FoundationReviewer] Failed to parse dimension ${i + 1}: ${dimensions[i]?.slice(0, 50)}`);
        // Try to find what actually appears in the content for this dimension
        const dimHeader = content.match(new RegExp(`=== DIMENSION: ${i + 1} ===`, "i"));
        if (dimHeader) {
          const startIdx = dimHeader.index ?? 0;
          const endIdx = content.indexOf("=== DIMENSION:", startIdx + 20);
          const snippet = content.slice(startIdx, endIdx > 0 ? endIdx : startIdx + 500);
          console.log(`[FoundationReviewer] Found dimension header, snippet:\n${snippet}`);
        } else {
          console.log(`[FoundationReviewer] Dimension header not found in content`);
        }
      }

      // Try alternative parsing if first regex fails
      let score = 50;
      let feedback = "(parse failed)";

      if (match && match[1]) {
        score = parseInt(match[1], 10);
        feedback = match[2]?.trim() || "(no feedback)";
      } else {
        // Try alternative: look for the dimension header and extract score/feedback manually
        const dimHeader = content.match(new RegExp(`=== DIMENSION: ${i + 1} ===`, "i"));
        if (dimHeader) {
          const startIdx = dimHeader.index ?? 0;
          const endIdx = content.indexOf("=== DIMENSION:", startIdx + 20);
          const block = content.slice(startIdx, endIdx > 0 ? endIdx : undefined);

          // Try to find score
          const scoreMatch = block.match(/(?:分数|Score)[：:]\s*(\d+)/i);
          if (scoreMatch) {
            score = parseInt(scoreMatch[1], 10);
          }

          // Try to find feedback
          const feedbackMatch = block.match(/(?:意见|Feedback)[：:]\s*([\s\S]*?)(?=\n===|$)/i);
          if (feedbackMatch) {
            feedback = feedbackMatch[1].trim();
          }

          console.log(`[FoundationReviewer] Alternative parsing for dimension ${i + 1}: score=${score}`);
        }
      }

      parsedDimensions.push({
        name: dimensions[i]!,
        score,
        feedback,
      });
    }

    // Check if parsing failed for all dimensions
    const failedDimensions = parsedDimensions.filter(d => d.feedback === "(parse failed)");
    if (failedDimensions.length === parsedDimensions.length && parsedDimensions.length > 0) {
      // All dimensions failed to parse - this is a parsing error, not a review rejection
      const errorMessage = language === "en"
        ? `Foundation review parsing failed. AI response format does not match expected format.\n\nRaw response (first 2000 chars):\n${content.slice(0, 2000)}`
        : `基础设定审核解析失败。AI返回的格式不符合预期格式。\n\n原始响应（前2000字符）：\n${content.slice(0, 2000)}`;
      throw new Error(errorMessage);
    }

    const totalScore = parsedDimensions.length > 0
      ? Math.round(parsedDimensions.reduce((sum, d) => sum + d.score, 0) / parsedDimensions.length)
      : 0;
    const anyBelowFloor = parsedDimensions.some((d) => d.score < dimensionFloor);
    const passed = totalScore >= passThreshold && !anyBelowFloor;

    const overallMatch = content.match(
      /=== OVERALL ===[\s\S]*?(?:总评|Summary)[：:]\s*([\s\S]*?)$/,
    );
    const overallFeedback = overallMatch ? overallMatch[1]!.trim() : "(parse failed)";

    return { passed, totalScore, dimensions: parsedDimensions, overallFeedback };
  }
}
