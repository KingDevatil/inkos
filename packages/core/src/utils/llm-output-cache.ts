/**
 * LLM Output Cache and Parser
 *
 * Handles caching, filtering, and parsing of LLM output content.
 * Features:
 * - Save multiple outputs to temporary files
 * - Filter out thinking tags (<think>, <thinking>, etc.)
 * - Remove duplicate content from continuation outputs
 * - Parse sections using multiple delimiter formats (=== SECTION:, ##, XML tags, etc.)
 */

import { writeFile, readFile, mkdir, unlink } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";

export interface CachedOutput {
  readonly content: string;
  readonly timestamp: number;
  readonly partIndex: number;
}

export interface ParseResult {
  readonly sections: Map<string, string>;
  readonly rawContent: string;
  readonly filteredContent: string;
}

// Supported section delimiter patterns
interface DelimiterPattern {
  readonly name: string;
  readonly regex: RegExp;
  readonly extractName: (match: RegExpMatchArray) => string;
}

// Define multiple delimiter patterns for flexibility
const DELIMITER_PATTERNS: DelimiterPattern[] = [
  // Pattern 1: === SECTION: name === or === SECTION：name ===
  {
    name: "triple-equals",
    regex: /\s*===\s*SECTION\s*[：:]?\s*([^\n=]+?)\s*===\s*/gim,
    extractName: (m) => m[1] ?? "",
  },
  // Pattern 2: ## SECTION: name or ## name
  {
    name: "markdown-header",
    regex: /\s*##\s*(?:SECTION\s*[：:]?\s*)?([^\n#]+?)\s*\n/gim,
    extractName: (m) => m[1] ?? "",
  },
  // Pattern 3: ### name (h3 header)
  {
    name: "markdown-h3",
    regex: /\s*###\s*([^\n#]+?)\s*\n/gim,
    extractName: (m) => m[1] ?? "",
  },
  // Pattern 4: <section name="xxx"> or <file name="xxx">
  {
    name: "xml-tag",
    regex: /\s*<(?:section|file)\s+name=["']([^"']+)["']\s*>\s*/gim,
    extractName: (m) => m[1] ?? "",
  },
  // Pattern 5: [SECTION: name] or 【SECTION: name】
  {
    name: "bracket",
    regex: /\s*[\[【]\s*SECTION\s*[：:]?\s*([^\]】]+?)\s*[\]】]\s*/gim,
    extractName: (m) => m[1] ?? "",
  },
  // Pattern 6: --- name --- or *** name ***
  {
    name: "dash-asterisk",
    regex: /\s*(?:---|\*\*\*)\s*([^\n\-*]+?)\s*(?:---|\*\*\*)\s*/gim,
    extractName: (m) => m[1] ?? "",
  },
  // Pattern 7: # name (for specific section names at start of line)
  {
    name: "specific-headers",
    regex: /^(?:story_bible|volume_outline|book_rules|current_state|pending_hooks)[：:]\s*/gim,
    extractName: (m) => m[0].replace(/[：:]\s*$/, ""),
  },
];

export class LlmOutputCache {
  private cacheDir: string;
  private sessionId: string;

  constructor(projectRoot: string, sessionId?: string) {
    this.sessionId = sessionId || this.generateSessionId();
    this.cacheDir = join(projectRoot, ".inkos", "cache", "llm-output", this.sessionId);
  }

  private generateSessionId(): string {
    return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  }

  /**
   * Initialize cache directory
   */
  async initialize(): Promise<void> {
    await mkdir(this.cacheDir, { recursive: true });
  }

  /**
   * Save a part of LLM output to cache
   */
  async savePart(content: string, partIndex: number): Promise<string> {
    const filePath = join(this.cacheDir, `part-${partIndex.toString().padStart(3, "0")}.md`);
    await writeFile(filePath, content, "utf-8");
    return filePath;
  }

  /**
   * Read all cached parts and merge them
   */
  async readAllParts(): Promise<string> {
    if (!existsSync(this.cacheDir)) {
      return "";
    }

    const { readdir } = await import("fs/promises");
    const files = await readdir(this.cacheDir);
    const partFiles = files
      .filter(f => f.startsWith("part-") && f.endsWith(".md"))
      .sort();

    let mergedContent = "";
    for (const file of partFiles) {
      const content = await readFile(join(this.cacheDir, file), "utf-8");
      mergedContent = this.mergeWithDeduplication(mergedContent, content);
    }

    return mergedContent;
  }

  /**
   * Check if content is truncated (incomplete)
   * Returns true if content appears to be cut off
   */
  isContentTruncated(content: string): boolean {
    // Check for unclosed XML/HTML tags
    const unclosedTagPattern = /<[^>]+\b[^>]*>[^<]*$/;
    if (unclosedTagPattern.test(content)) {
      return true;
    }

    // Check for unclosed markdown code blocks
    const codeBlockMatches = content.match(/```/g);
    if (codeBlockMatches && codeBlockMatches.length % 2 !== 0) {
      return true;
    }

    // Check for incomplete sentences (ending without proper punctuation)
    const trimmed = content.trim();
    const lastChar = trimmed.slice(-1);
    const incompleteEndings = ['', ',', ';', ':', '-', '—', '…'];
    if (incompleteEndings.includes(lastChar)) {
      // Check if it's actually incomplete or just ends with a list/item
      const lastLine = trimmed.split('\n').pop() || '';
      if (!lastLine.match(/^[\s\-*\d]/) && !lastLine.match(/\|\s*$/)) {
        return true;
      }
    }

    // Check for unclosed parentheses, brackets, quotes
    const openParens = (content.match(/\(/g) || []).length;
    const closeParens = (content.match(/\)/g) || []).length;
    if (openParens !== closeParens) return true;

    const openBrackets = (content.match(/\[/g) || []).length;
    const closeBrackets = (content.match(/\]/g) || []).length;
    if (openBrackets !== closeBrackets) return true;

    const openBraces = (content.match(/\{/g) || []).length;
    const closeBraces = (content.match(/\}/g) || []).length;
    if (openBraces !== closeBraces) return true;

    // Check for unclosed quotes (simplified)
    const doubleQuotes = (content.match(/"/g) || []).length;
    if (doubleQuotes % 2 !== 0) return true;

    // Check if content ends mid-word (no space or punctuation at end)
    if (/\w$/.test(trimmed) && !trimmed.endsWith('...')) {
      // Check last few characters
      const lastFew = trimmed.slice(-20);
      if (!lastFew.match(/[.!?。！？…]\s*$/)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Get the last part index from cache
   */
  async getLastPartIndex(): Promise<number> {
    if (!existsSync(this.cacheDir)) {
      return -1;
    }

    const { readdir } = await import("fs/promises");
    const files = await readdir(this.cacheDir);
    const partFiles = files.filter(f => f.startsWith("part-") && f.endsWith(".md"));

    if (partFiles.length === 0) {
      return -1;
    }

    // Extract indices and find max
    const indices = partFiles.map(f => {
      const match = f.match(/part-(\d+)/);
      return match ? parseInt(match[1], 10) : -1;
    });

    return Math.max(...indices);
  }

  /**
   * Get continuation prompt for resuming generation
   */
  getContinuationPrompt(originalPrompt: string, lastContent: string): string {
    return `${originalPrompt}

[继续生成 - 从以下内容接着完成，不要重复已生成的内容]

已生成内容的最后部分：
${lastContent.slice(-500)}

请继续完成剩余内容。`;
  }

  /**
   * Merge two content pieces, removing duplicate overlap
   */
  mergeWithDeduplication(existing: string, newContent: string): string {
    if (!existing) {
      return newContent;
    }

    // Try to find overlap at the end of existing and start of newContent
    const overlapLength = this.findOverlapLength(existing, newContent);

    if (overlapLength > 10) { // Minimum overlap to consider
      return existing + newContent.substring(overlapLength);
    }

    // No significant overlap, just concatenate
    return existing + "\n\n" + newContent;
  }

  /**
   * Find the length of overlapping content between end of a and start of b
   * Uses multiple strategies to detect overlap with reduced false positives
   */
  private findOverlapLength(a: string, b: string): number {
    const maxOverlap = Math.min(a.length, b.length, 1000); // Max 1000 chars to check
    const minOverlap = 30; // Minimum meaningful overlap (increased from 10)

    // Strategy 1: Exact match for longer overlaps (most reliable)
    for (let len = Math.min(maxOverlap, 200); len >= minOverlap; len--) {
      const endOfA = a.slice(-len);
      const startOfB = b.slice(0, len);
      if (endOfA === startOfB) {
        // Verify: check if the match ends at a natural boundary
        const nextChar = b[len];
        if (!nextChar || nextChar === '\n' || nextChar === ' ' || nextChar === '.' || nextChar === '。') {
          return len;
        }
      }
    }

    // Strategy 2: Line-based matching for structured content
    const linesA = a.split('\n').slice(-10); // Last 10 lines
    const linesB = b.split('\n').slice(0, 10); // First 10 lines
    
    for (let i = Math.min(linesA.length, linesB.length); i >= 2; i--) {
      const endLinesA = linesA.slice(-i).join('\n');
      const startLinesB = linesB.slice(0, i).join('\n');
      if (endLinesA === startLinesB && endLinesA.length >= minOverlap) {
        return endLinesA.length + (i - 1); // Account for newline characters
      }
    }

    // Strategy 3: Paragraph-based fuzzy matching
    const parasA = a.split(/\n\n+/).slice(-3); // Last 3 paragraphs
    const parasB = b.split(/\n\n+/).slice(0, 3); // First 3 paragraphs
    
    for (let i = Math.min(parasA.length, parasB.length); i >= 1; i--) {
      const endParasA = parasA.slice(-i).join('\n\n');
      const startParasB = parasB.slice(0, i).join('\n\n');
      if (endParasA === startParasB && endParasA.length >= minOverlap) {
        return endParasA.length + (i - 1) * 2; // Account for paragraph separators
      }
    }

    return 0;
  }

  /**
   * Filter out thinking tags and clean content
   */
  filterThinkingTags(content: string): string {
    let filtered = content;

    // Remove <think>...</think> tags (used by DeepSeek and other models)
    // Handle both closed and unclosed tags
    const thinkRegex = /<think>[\s\S]*?(?:<\/think>|$)/gi;
    filtered = filtered.replace(thinkRegex, "");

    // Remove <thinking>...</thinking> tags (alternative format)
    const thinkingRegex = /<thinking>[\s\S]*?(?:<\/thinking>|$)/gi;
    filtered = filtered.replace(thinkingRegex, "");

    // Remove <thought>...</thought> tags (another alternative)
    const thoughtRegex = /<thought>[\s\S]*?(?:<\/thought>|$)/gi;
    filtered = filtered.replace(thoughtRegex, "");

    // Remove <RichMediaReference>... tags (special format)
    const richMediaRegex = /<RichMediaReference>[\s\S]*?<\/RichMediaReference>/gi;
    filtered = filtered.replace(richMediaRegex, "");

    // Remove self-closing think tags with attributes
    const selfClosingThinkRegex = /<think\s+[^>]*\/>/gi;
    filtered = filtered.replace(selfClosingThinkRegex, "");

    // Clean up excessive empty lines
    filtered = filtered.replace(/\n{3,}/g, "\n\n");

    return filtered.trim();
  }

  /**
   * Parse sections from content using multiple delimiter formats
   * Tries different patterns and uses the one that finds the most valid sections
   */
  parseSections(content: string): ParseResult {
    const filteredContent = this.filterThinkingTags(content);

    // Try each delimiter pattern and find the best match
    let bestResult: ParseResult | null = null;
    let bestScore = 0;

    for (const pattern of DELIMITER_PATTERNS) {
      const result = this.tryParseWithPattern(filteredContent, pattern);
      const score = this.evaluateParseResult(result);

      if (score > bestScore) {
        bestScore = score;
        bestResult = result;
      }
    }

    // If no pattern worked well, try to extract sections by looking for known section names
    if (!bestResult || bestScore < 2) {
      bestResult = this.extractByKnownNames(filteredContent);
    }

    return {
      sections: bestResult?.sections ?? new Map(),
      rawContent: content,
      filteredContent,
    };
  }

  /**
   * Try to parse sections using a specific delimiter pattern
   */
  private tryParseWithPattern(content: string, pattern: DelimiterPattern): ParseResult {
    const sections = new Map<string, string>();
    const matches = [...content.matchAll(pattern.regex)];

    for (let i = 0; i < matches.length; i++) {
      const match = matches[i]!;
      const rawName = pattern.extractName(match);
      const normalizedName = this.normalizeSectionName(rawName);

      // Skip if name is empty or too short
      if (!normalizedName || normalizedName.length < 2) continue;

      const start = (match.index ?? 0) + match[0].length;
      const end = matches[i + 1]?.index ?? content.length;
      const sectionContent = content.slice(start, end).trim();

      // Only store if content is meaningful
      if (sectionContent.length > 10) {
        sections.set(normalizedName, sectionContent);
      }
    }

    return {
      sections,
      rawContent: content,
      filteredContent: content,
    };
  }

  /**
   * Evaluate the quality of a parse result
   */
  private evaluateParseResult(result: ParseResult): number {
    const knownSections = ['story_bible', 'volume_outline', 'book_rules', 'current_state', 'pending_hooks'];
    let score = 0;

    for (const [name, content] of result.sections.entries()) {
      // Bonus for known section names
      if (knownSections.some(ks => name.includes(ks) || ks.includes(name))) {
        score += 3;
      }
      // Bonus for content length
      if (content.length > 100) score += 1;
      if (content.length > 500) score += 1;
    }

    return score;
  }

  /**
   * Fallback: Extract sections by looking for known section names directly
   */
  private extractByKnownNames(content: string): ParseResult {
    const sections = new Map<string, string>();
    const knownSections = [
      { name: 'story_bible', patterns: [/story[_\s]bible/i, /storybible/i, /故事设定/i, /故事圣经/i] },
      { name: 'volume_outline', patterns: [/volume[_\s]outline/i, /volumeoutline/i, /卷纲/i, /大纲/i] },
      { name: 'book_rules', patterns: [/book[_\s]rules/i, /bookrules/i, /书籍规则/i, /规则/i] },
      { name: 'current_state', patterns: [/current[_\s]state/i, /currentstate/i, /当前状态/i, /状态卡/i] },
      { name: 'pending_hooks', patterns: [/pending[_\s]hooks/i, /pendinghooks/i, /初始伏笔/i, /伏笔池/i] },
    ];

    for (const section of knownSections) {
      for (const pattern of section.patterns) {
        // Try multiple extraction strategies
        const extracted = this.tryExtractSection(content, pattern, knownSections);
        if (extracted) {
          sections.set(section.name, extracted);
          break;
        }
      }
    }

    return {
      sections,
      rawContent: content,
      filteredContent: content,
    };
  }

  /**
   * Try multiple strategies to extract a section
   */
  private tryExtractSection(
    content: string,
    pattern: RegExp,
    allSections: Array<{ name: string; patterns: RegExp[] }>
  ): string | null {
    // Strategy 1: Look for section header followed by content until next section
    const otherSectionNames = allSections
      .flatMap(s => s.patterns.map(p => p.source))
      .join('|');
    
    const regex1 = new RegExp(
      `(?:^|\\n)\\s*(?:#{1,4}\\s*)?(?:SECTION\\s*[：:]\\s*)?${pattern.source}\\s*[：:]?\\s*\\n?([\\s\\S]*?)(?=(?:^|\\n)\\s*(?:#{1,4}\\s*)?(?:SECTION\\s*[：:]\\s*)?(?:${otherSectionNames})[：:]?|\\s*$)`,
      'im'
    );
    
    const match1 = content.match(regex1);
    if (match1 && match1[1] && match1[1].trim().length > 10) {
      return match1[1].trim();
    }

    // Strategy 2: Look for section with === delimiter
    const regex2 = new RegExp(
      `===\\s*SECTION\\s*[：:]?\\s*${pattern.source}\\s*===\\s*([\\s\\S]*?)(?=\\s*===|$)`,
      'i'
    );
    
    const match2 = content.match(regex2);
    if (match2 && match2[1] && match2[1].trim().length > 10) {
      return match2[1].trim();
    }

    // Strategy 3: Look for section with ## or ### header
    const regex3 = new RegExp(
      `##+\\s*${pattern.source}\\s*[：:]?\\s*\\n([\\s\\S]*?)(?=\\n##+|\\s*$)`,
      'i'
    );
    
    const match3 = content.match(regex3);
    if (match3 && match3[1] && match3[1].trim().length > 10) {
      return match3[1].trim();
    }

    return null;
  }

  /**
   * Normalize section name for consistent lookup
   */
  private normalizeSectionName(name: string): string {
    return name
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[`"'*_]/g, " ")
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
  }

  /**
   * Extract a specific section with fallback and validation
   * Supports multiple delimiter formats
   */
  extractSection(
    parseResult: ParseResult,
    sectionName: string,
    options?: {
      required?: boolean;
      validateBoundary?: boolean;
      otherSections?: string[];
    }
  ): string | null {
    const normalizedName = this.normalizeSectionName(sectionName);
    let section = parseResult.sections.get(normalizedName);

    // Try fuzzy match if exact match not found
    if (!section) {
      for (const [key, value] of parseResult.sections.entries()) {
        if (key.includes(normalizedName) || normalizedName.includes(key)) {
          section = value;
          break;
        }
      }
    }

    // Fallback: try to extract from filtered content using multiple patterns
    if (!section) {
      const fallbackResult = this.fallbackExtract(parseResult.filteredContent, sectionName);
      if (fallbackResult) {
        section = fallbackResult;
      }
    }

    if (!section) {
      if (options?.required) {
        throw new Error(`Required section not found: ${sectionName}`);
      }
      return null;
    }

    // Validate and fix boundary issues
    if (options?.validateBoundary && options?.otherSections) {
      section = this.validateAndFixBoundary(section, sectionName, options.otherSections);
    }

    return section;
  }

  /**
   * Fallback extraction using multiple delimiter patterns
   */
  private fallbackExtract(content: string, sectionName: string): string | null {
    const normalizedName = this.normalizeSectionName(sectionName);

    // Define fallback patterns for different delimiter styles
    const fallbackPatterns = [
      // === SECTION: name ===
      new RegExp(
        `===\\s*SECTION\\s*[：:]?\\s*${normalizedName.replace(/_/g, "[_\\s]*")}\\s*===\\s*([\\s\\S]*?)(?=\\s*===|$)`,
        "i"
      ),
      // ## name or ## SECTION: name
      new RegExp(
        `##\\s*(?:SECTION\\s*[：:]?\\s*)?${normalizedName.replace(/_/g, "[_\\s]*")}\\s*[：:]?\\s*\\n([\\s\\S]*?)(?=\\n##|$)`,
        "i"
      ),
      // ### name
      new RegExp(
        `###\\s*${normalizedName.replace(/_/g, "[_\\s]*")}\\s*[：:]?\\s*\\n([\\s\\S]*?)(?=\\n###|\\n##|$)`,
        "i"
      ),
      // <section name="xxx"> or <file name="xxx">
      new RegExp(
        `<(?:section|file)\\s+name=["']${normalizedName.replace(/_/g, "[_\\s]*")}["']\\s*>([\\s\\S]*?)</(?:section|file)>`,
        "i"
      ),
      // [SECTION: name] or 【SECTION: name】
      new RegExp(
        `[\\[【]\\s*SECTION\\s*[：:]?\\s*${normalizedName.replace(/_/g, "[_\\s]*")}\\s*[\\]】]\\s*([\\s\\S]*?)(?=[\\[【]|$)`,
        "i"
      ),
      // --- name --- or *** name ***
      new RegExp(
        `(?:---|\\*\\*\\*)\\s*${normalizedName.replace(/_/g, "[_\\s]*")}\\s*(?:---|\\*\\*\\*)\\s*([\\s\\S]*?)(?=(?:---|\\*\\*\\*)|$)`,
        "i"
      ),
    ];

    for (const pattern of fallbackPatterns) {
      const match = content.match(pattern);
      if (match && match[1] && match[1].trim().length > 10) {
        return match[1].trim();
      }
    }

    return null;
  }

  /**
   * Validate section content and fix boundary issues
   * Supports multiple delimiter formats
   */
  private validateAndFixBoundary(
    content: string,
    currentName: string,
    otherSections: string[]
  ): string {
    let fixed = content;

    for (const otherName of otherSections) {
      if (otherName === currentName) continue;

      const normalizedOther = this.normalizeSectionName(otherName);

      // Check for various delimiter patterns
      const boundaryPatterns = [
        // === SECTION: name ===
        new RegExp(
          `===\\s*SECTION\\s*[：:]?\\s*${normalizedOther.replace(/_/g, "[_\\s]*")}\\s*===`,
          "i"
        ),
        // ## name or ## SECTION: name
        new RegExp(
          `##\\s*(?:SECTION\\s*[：:]?\\s*)?${normalizedOther.replace(/_/g, "[_\\s]*")}\\s*[：:]?\\s*\\n`,
          "i"
        ),
        // ### name
        new RegExp(
          `###\\s*${normalizedOther.replace(/_/g, "[_\\s]*")}\\s*[：:]?\\s*\\n`,
          "i"
        ),
        // <section name="xxx">
        new RegExp(
          `<(?:section|file)\\s+name=["']${normalizedOther.replace(/_/g, "[_\\s]*")}["']\\s*>`,
          "i"
        ),
      ];

      for (const pattern of boundaryPatterns) {
        if (pattern.test(fixed)) {
          // Truncate at the other section marker
          const truncatePattern = new RegExp(
            `([\\s\\S]*?)(?=${pattern.source})`,
            "i"
          );
          const truncateMatch = fixed.match(truncatePattern);
          if (truncateMatch) {
            fixed = truncateMatch[1].trim();
            break;
          }
        }
      }
    }

    return fixed;
  }

  /**
   * Clean up cache files
   */
  async cleanup(): Promise<void> {
    if (!existsSync(this.cacheDir)) {
      return;
    }

    const { readdir } = await import("fs/promises");
    const files = await readdir(this.cacheDir);

    for (const file of files) {
      await unlink(join(this.cacheDir, file)).catch(() => {});
    }
  }

  /**
   * Get cache directory path
   */
  getCacheDir(): string {
    return this.cacheDir;
  }
}

/**
 * Convenience function to quickly parse LLM output
 */
export function parseLlmOutput(content: string): ParseResult {
  const cache = new LlmOutputCache("");
  return cache.parseSections(content);
}

/**
 * Convenience function to filter thinking tags
 */
export function filterThinkingContent(content: string): string {
  const cache = new LlmOutputCache("");
  return cache.filterThinkingTags(content);
}
