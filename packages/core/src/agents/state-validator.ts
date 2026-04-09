import { BaseAgent } from "./base.js";

export interface ValidationWarning {
  readonly category: string;
  readonly description: string;
}

export interface ValidationResult {
  readonly warnings: ReadonlyArray<ValidationWarning>;
  readonly passed: boolean;
}

/**
 * Validates Settler output by comparing old and new truth files via LLM.
 * Catches contradictions, missing state changes, and temporal inconsistencies.
 *
 * Uses a minimal verdict protocol instead of requiring structured JSON:
 *   Line 1: PASS or FAIL
 *   Remaining lines: free-form warnings (one per line, optional category prefix)
 */
export class StateValidatorAgent extends BaseAgent {
  get name(): string {
    return "state-validator";
  }

  async validate(
    chapterContent: string,
    chapterNumber: number,
    oldState: string,
    newState: string,
    oldHooks: string,
    newHooks: string,
    language: "zh" | "en" = "zh",
  ): Promise<ValidationResult> {
    const stateDiff = this.computeDiff(oldState, newState, "State Card");
    const hooksDiff = this.computeDiff(oldHooks, newHooks, "Hooks Pool");

    // Skip validation if nothing changed
    if (!stateDiff && !hooksDiff) {
      return { warnings: [], passed: true };
    }

    const langInstruction = language === "en"
      ? "Respond in English."
      : "用中文回答。";

    const systemPrompt = `You are a continuity validator for a novel writing system. ${langInstruction}

Given the chapter text and the CHANGES made to truth files (state card + hooks pool), check for contradictions:

1. State change without narrative support — truth file says something changed but the chapter text doesn't describe it
2. Missing state change — chapter text describes something happening but the truth file didn't capture it
3. Temporal impossibility — character moves locations without transition, injury heals without time passing
4. Hook anomaly — a hook disappeared without being marked resolved, or a new hook has no basis in the chapter
5. Retroactive edit — truth file change implies something happened in a PREVIOUS chapter, not the current one

Please strictly follow this output format:
- First line: ONLY "PASS" or "FAIL" (no other text on this line)
- Starting from the second line: list any warnings, one per line, optionally prefixed with [category]
- If no issues at all, just output: PASS

Example 1 (no contradictions):
PASS
[unsupported_change] State card says character moved to the forest, but text only shows intent
[minor] Hook H03 advanced but text mention is brief

Example 2 (with contradictions):
FAIL
[contradiction] State says character is dead but chapter text shows them speaking
[unsupported_change] New location not mentioned anywhere in chapter text

IMPORTANT RULES:
1. Output FAIL ONLY for hard contradictions — facts that directly conflict with the chapter text
2. Do NOT fail for:
   - Slightly ahead-of-text inferences
   - Missing details that the state card didn't capture
   - Reasonable extrapolations from text
   - Hook management differences that don't contradict text
3. These should be warnings with PASS, not FAIL
4. Make sure the first line is exactly "PASS" or "FAIL"
5. Do not include any other text before or after the PASS/FAIL line`;

    const userPrompt = `Chapter ${chapterNumber} validation:

## State Card Changes
${stateDiff || "(no changes)"}

## Hooks Pool Changes
${hooksDiff || "(no changes)"}

## Chapter Text (for reference)
${chapterContent.slice(0, 6000)}`;

    try {
      const response = await this.chat(
        [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        { temperature: 0.1, maxTokens: 2048 },
      );

      // Debug: Log the raw LLM response
      this.log?.warn(`Raw LLM response for state validation: ${JSON.stringify(response.content)}`);

      return this.parseResult(response.content);
    } catch (error) {
      this.log?.warn(`State validation failed: ${error}`);
      throw error;
    }
  }

  private computeDiff(oldText: string, newText: string, label: string): string | null {
    if (oldText === newText) return null;

    const oldLines = oldText.split("\n").filter((l) => l.trim());
    const newLines = newText.split("\n").filter((l) => l.trim());

    const added = newLines.filter((l) => !oldLines.includes(l));
    const removed = oldLines.filter((l) => !newLines.includes(l));

    if (added.length === 0 && removed.length === 0) return null;

    const parts = [`### ${label}`];
    if (removed.length > 0) parts.push("Removed:\n" + removed.map((l) => `- ${l}`).join("\n"));
    if (added.length > 0) parts.push("Added:\n" + added.map((l) => `+ ${l}`).join("\n"));
    return parts.join("\n");
  }

  private parseResult(content: string): ValidationResult {
    // Debug: Log the raw content for analysis
    this.log?.warn(`Raw state validation content: ${JSON.stringify(content)}`);

    const trimmed = content.trim();
    if (!trimmed) {
      this.log?.warn(`LLM returned empty response, defaulting to PASS`);
      return { warnings: [], passed: true };
    }

    const jsonResult = this.tryParseJsonResult(trimmed);
    if (jsonResult) {
      return jsonResult;
    }

    const lines = trimmed.split("\n").map((line) => line.trim()).filter(Boolean);
    if (lines.length === 0) {
      this.log?.warn(`LLM returned empty response after processing, defaulting to PASS`);
      return { warnings: [], passed: true };
    }

    // Try to find PASS/FAIL in the response
    let verdictLine = lines[0];
    let passed = true;
    
    // Look for PASS/FAIL in any line, case-insensitive
    for (const line of lines) {
      if (/^(PASS|FAIL)$/i.test(line)) {
        verdictLine = line;
        passed = /^PASS$/i.test(line);
        break;
      }
      // Also check for PASS/FAIL within a line
      if (line.toLowerCase().includes("pass")) {
        passed = true;
        break;
      }
      if (line.toLowerCase().includes("fail")) {
        passed = false;
        break;
      }
      // Check for Chinese equivalents
      if (line.includes("通过")) {
        passed = true;
        break;
      }
      if (line.includes("失败")) {
        passed = false;
        break;
      }
    }

    // If no PASS/FAIL found, default to PASS
    if (!/^(PASS|FAIL)$/i.test(verdictLine) && !verdictLine.toLowerCase().includes("pass") && !verdictLine.toLowerCase().includes("fail")) {
      this.log?.warn(`No PASS/FAIL found in response, defaulting to PASS`);
      passed = true;
    }

    const warnings: ValidationWarning[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (/^(PASS|FAIL)$/i.test(line)) continue;

      const categoryMatch = line.match(/^\[([^\]]+)\]\s*(.+)$/);
      if (categoryMatch) {
        warnings.push({
          category: categoryMatch[1]!.trim(),
          description: categoryMatch[2]!.trim(),
        });
      } else if (line.startsWith("- ") || line.startsWith("* ")) {
        warnings.push({
          category: "general",
          description: line.slice(2).trim(),
        });
      } else if (line.length > 5) {
        warnings.push({
          category: "general",
          description: line,
        });
      }
    }

    return { warnings, passed };
  }

  private tryParseJsonResult(text: string): ValidationResult | null {
    const direct = this.tryParseExactJsonResult(text);
    if (direct) {
      return direct;
    }

    const candidate = extractBalancedJsonObject(text);
    if (!candidate) {
      return null;
    }
    return this.tryParseExactJsonResult(candidate);
  }

  private tryParseExactJsonResult(text: string): ValidationResult | null {
    try {
      const parsed = JSON.parse(text) as {
        warnings?: Array<{ category?: string; description?: string }>;
        passed?: boolean;
      };
      if (typeof parsed.passed !== "boolean") return null;
      return {
        warnings: (parsed.warnings ?? []).map((w) => ({
          category: w.category ?? "unknown",
          description: w.description ?? "",
        })),
        passed: parsed.passed,
      };
    } catch {
      return null;
    }
  }
}

function extractBalancedJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index]!;

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "{") {
      depth += 1;
      continue;
    }

    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, index + 1);
      }
      if (depth < 0) {
        return null;
      }
    }
  }

  return null;
}
