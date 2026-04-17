import { BaseAgent } from "./base.js";
import type { BookConfig, FanficMode } from "../models/book.js";
import type { GenreProfile } from "../models/genre-profile.js";
import { readGenreProfile } from "./rules-reader.js";
import { writeFile, mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { renderHookSnapshot } from "../utils/memory-retrieval.js";
import { buildCurrentStatePrompt, buildContinuationStatePrompt } from "../utils/state-dimensions.js";
import { LlmOutputCache, type ParseResult } from "../utils/llm-output-cache.js";

export interface ArchitectOutput {
  readonly storyBible: string;
  readonly volumeOutline: string;
  readonly bookRules: string;
  readonly currentState: string;
  readonly pendingHooks: string;
}

export class ArchitectAgent extends BaseAgent {
  get name(): string {
    return "architect";
  }

  async generateFoundation(
    book: BookConfig,
    externalContext?: string,
    reviewFeedback?: string,
  ): Promise<ArchitectOutput> {
    const { profile: gp, body: genreBody } =
      await readGenreProfile(this.ctx.projectRoot, book.genre);
    const resolvedLanguage = book.language ?? gp.language;

    const contextBlock = externalContext
      ? `\n\n## 外部指令\n以下是来自外部系统的创作指令，请将其融入设定中：\n\n${externalContext}\n`
      : "";
    const reviewFeedbackBlock = this.buildReviewFeedbackBlock(reviewFeedback, resolvedLanguage);

    const numericalBlock = gp.numericalSystem
      ? `- 有明确的数值/资源体系可追踪
- 在 book_rules 中定义 numericalSystemOverrides（hardCap、resourceTypes）`
      : "- 本题材无数值系统，不需要资源账本";

    const powerBlock = gp.powerScaling
      ? "- 有明确的战力等级体系"
      : "";

    const eraBlock = gp.eraResearch
      ? "- 需要年代考据支撑（在 book_rules 中设置 eraConstraints）"
      : "";

    const storyBiblePrompt = resolvedLanguage === "en"
      ? `Use structured second-level headings:
## 01_Worldview
World setting, historical-social frame, and core rules

## 02_Protagonist
Protagonist setup (identity / advantage / personality core / behavioral boundaries)

## 03_Factions_and_Characters
Major factions and important supporting characters (for each: name, identity, motivation, relationship to protagonist, independent goal)

## 04_Geography_and_Environment
Map / scene design and environmental traits

## 05_Title_and_Blurb
Title method:
- Keep the title clear, direct, and easy to understand
- Use a format that immediately signals genre and core appeal
- Avoid overly literary or misleading titles

Blurb method (within 300 words, choose one):
1. Open with conflict, then reveal the hook, then leave suspense
2. Summarize only the main line and keep a clear suspense gap
3. Use a miniature scene that captures the book's strongest pull

Core blurb principle:
- The blurb is product copy that must make readers want to click`
      : `用结构化二级标题组织：
## 01_世界观
世界观设定、核心规则体系

## 02_主角
主角设定（身份/金手指/性格底色/行为边界）

## 03_势力与人物
势力分布、重要配角（每人：名字、身份、动机、与主角关系、独立目标）

## 04_地理与环境
地图/场景设定、环境特色

## 05_书名与简介
书名方法论：
- 书名必须简单扼要、通俗易懂，读者看到书名就能知道题材和主题
- 采用"题材+核心爽点+主角行为"的长书名格式，避免文艺化
- 融入平台当下热点词汇，吸引精准流量
- 禁止题材错位（都市文取玄幻书名会导致读者流失）
- 参考热榜书名风格：俏皮、通俗、有记忆点

简介方法论（300字内，三种写法任选其一）：
1. 冲突开篇法：第一句抛困境/冲突，第二句亮金手指/核心能力，第三句留悬念
2. 高度概括法：只挑主线概括（不是全篇概括），必须留悬念
3. 小剧场法：提炼故事中最经典的桥段，作为引子

简介核心原则：
- 简介 = 产品宣传语，必须让读者产生"我要点开看"的冲动
- 可以从剧情设定、人设、或某个精彩片段切入
- 必须有噱头（如"凡是被写在笔记本上的名字，最后都得死"）`;

    const volumeOutlinePrompt = resolvedLanguage === "en"
      ? `Volume plan. For each volume include: title, chapter range, core conflict, key turning points, and payoff goal

### Golden First Three Chapters Rule
- Chapter 1: throw the core conflict immediately; no large background dump
- Chapter 2: show the core edge / ability / leverage that answers Chapter 1's pressure
- Chapter 3: establish the first concrete short-term goal that gives readers a reason to continue`
      : `卷纲规划，每卷包含：卷名、章节范围、核心冲突、关键转折、收益目标

### 黄金三章法则（前三章必须遵循）
- 第1章：抛出核心冲突（主角立即面临困境/危机/选择），禁止大段背景灌输
- 第2章：展示金手指/核心能力（主角如何应对第1章的困境），让读者看到爽点预期
- 第3章：明确短期目标（主角确立第一个具体可达成的目标），给读者追读理由`;

    const bookRulesPrompt = resolvedLanguage === "en"
      ? `Generate book_rules.md as YAML frontmatter plus narrative guidance:
\`\`\`
---
version: "1.0"
protagonist:
  name: (protagonist name)
  personalityLock: [(3-5 personality keywords)]
  behavioralConstraints: [(3-5 behavioral constraints)]
genreLock:
  primary: ${book.genre}
  forbidden: [(2-3 forbidden style intrusions)]
${gp.numericalSystem ? `numericalSystemOverrides:
  hardCap: (decide from the setting)
  resourceTypes: [(core resource types)]` : ""}
prohibitions:
  - (3-5 book-specific prohibitions)
chapterTypesOverride: []
fatigueWordsOverride: []
additionalAuditDimensions: []
enableFullCastTracking: false
---

## Narrative Perspective
(Describe the narrative perspective and style)

## Core Conflict Driver
(Describe the book's core conflict and propulsion)
\`\`\``
      : `生成 book_rules.md 格式的 YAML frontmatter + 叙事指导，包含：
\`\`\`
---
version: "1.0"
protagonist:
  name: (主角名)
  personalityLock: [(3-5个性格关键词)]
  behavioralConstraints: [(3-5条行为约束)]
genreLock:
  primary: ${book.genre}
  forbidden: [(2-3种禁止混入的文风)]
${gp.numericalSystem ? `numericalSystemOverrides:
  hardCap: (根据设定确定)
  resourceTypes: [(核心资源类型列表)]` : ""}
prohibitions:
  - (3-5条本书禁忌)
chapterTypesOverride: []
fatigueWordsOverride: []
additionalAuditDimensions: []
enableFullCastTracking: false
---

## 叙事视角
(描述本书叙事视角和风格)

## 核心冲突驱动
(描述本书的核心矛盾和驱动力)
\`\`\``;

    const currentStatePrompt = buildCurrentStatePrompt(gp, resolvedLanguage);

    const pendingHooksPrompt = resolvedLanguage === "en"
      ? `Initial hook pool (Markdown table):
| hook_id | start_chapter | type | status | last_advanced_chapter | expected_payoff | payoff_timing | notes |

Rules for the hook table:
- Column 5 must be a pure chapter number, never natural-language description
- During book creation, all planned hooks are still unapplied, so last_advanced_chapter = 0
- Column 7 must be one of: immediate / near-term / mid-arc / slow-burn / endgame
- If you want to describe the initial clue/signal, put it in notes instead of column 5`
      : `初始伏笔池（Markdown表格）：
| hook_id | 起始章节 | 类型 | 状态 | 最近推进 | 预期回收 | 回收节奏 | 备注 |

伏笔表规则：
- 第5列必须是纯数字章节号，不能写自然语言描述
- 建书阶段所有伏笔都还没正式推进，所以第5列统一填 0
- 第7列必须填写：立即 / 近期 / 中程 / 慢烧 / 终局 之一
- 如果要说明“初始线索/最初信号”，写进备注，不要写进第5列`;

    const finalRequirementsPrompt = resolvedLanguage === "en"
      ? `Generated content must:
1. Fit the ${book.platform} platform taste
2. Fit the ${gp.name} genre traits
${numericalBlock}
${powerBlock}
${eraBlock}
3. Give the protagonist a clear personality and behavioral boundaries
4. Keep hooks and payoffs coherent
5. Make supporting characters independently motivated rather than pure tools`
      : `生成内容必须：
1. 符合${book.platform}平台口味
2. 符合${gp.name}题材特征
${numericalBlock}
${powerBlock}
${eraBlock}
3. 主角人设鲜明，有明确行为边界
4. 伏笔前后呼应，不留悬空线
5. 配角有独立动机，不是工具人`;

    const systemPrompt = `你是一个专业的网络小说架构师。你的任务是为一本新的${gp.name}小说生成完整的基础设定。${contextBlock}${reviewFeedbackBlock}

要求：
- 平台：${book.platform}
- 题材：${gp.name}（${book.genre}）
- 目标章数：${book.targetChapters}章
- 每章字数：${book.chapterWordCount}字

## 题材特征

${genreBody}

## 生成要求

你需要生成以下内容，每个部分用 === SECTION: <name> === 分隔：

=== SECTION: story_bible ===
${storyBiblePrompt}

=== SECTION: volume_outline ===
${volumeOutlinePrompt}

=== SECTION: book_rules ===
${bookRulesPrompt}

=== SECTION: current_state ===
${currentStatePrompt}

=== SECTION: pending_hooks ===
${pendingHooksPrompt}

${finalRequirementsPrompt}`;

    const langPrefix = resolvedLanguage === "en"
      ? `【LANGUAGE OVERRIDE】ALL output (story_bible, volume_outline, book_rules, current_state, pending_hooks) MUST be written in English. Character names, place names, and all prose must be in English. The === SECTION: === tags remain unchanged.\n\n`
      : "";
    const userMessage = resolvedLanguage === "en"
      ? `Generate the complete foundation for a ${gp.name} novel titled "${book.title}". Write everything in English.`
      : `请为标题为"${book.title}"的${gp.name}小说生成完整基础设定。`;

    // Initialize cache for storing LLM output (for debugging only)
    const cache = new LlmOutputCache(this.ctx.projectRoot);
    await cache.initialize();

    // Generate foundation in a single call
    // Note: We don't use auto-continuation for foundation generation because:
    // 1. Foundation requires consistency (characters, world-building, etc.)
    // 2. Continuation may cause inconsistencies between parts
    // 3. If content is truncated, we should warn and use what we have
    this.ctx.logger?.info(`[generateFoundation] Generating foundation with maxTokens=32000`);

    const response = await this.chat([
      { role: "system", content: langPrefix + systemPrompt },
      { role: "user", content: userMessage },
    ], { maxTokens: 32000, temperature: 0.8 }); // Increased from 24000 to 32000

    // Save to cache for debugging
    const tempFilePath = await cache.savePart(response.content, 0);
    this.ctx.logger?.info(`[generateFoundation] LLM output saved to: ${tempFilePath}`);

    // Check if content appears truncated (for warning purposes only)
    if (cache.isContentTruncated(response.content)) {
      this.ctx.logger?.warn(`[generateFoundation] Content may be truncated. Consider increasing maxTokens or reducing content scope.`);
    }

    return this.parseSections(response.content);
  }

  async writeFoundationFiles(
    bookDir: string,
    output: ArchitectOutput,
    numericalSystem: boolean = true,
    language: "zh" | "en" = "zh",
  ): Promise<void> {
    const storyDir = join(bookDir, "story");
    await mkdir(storyDir, { recursive: true });

    // Combine current_state with pending_hooks for comprehensive state tracking
    // This ensures hooks are visible both in the state card and in the dedicated hooks file
    const combinedCurrentState = this.combineStateWithHooks(
      output.currentState,
      output.pendingHooks,
      language
    );

    const writes: Array<Promise<void>> = [
      writeFile(join(storyDir, "story_bible.md"), output.storyBible, "utf-8"),
      writeFile(join(storyDir, "volume_outline.md"), output.volumeOutline, "utf-8"),
      writeFile(join(storyDir, "book_rules.md"), output.bookRules, "utf-8"),
      writeFile(join(storyDir, "current_state.md"), combinedCurrentState, "utf-8"),
      writeFile(join(storyDir, "pending_hooks.md"), output.pendingHooks, "utf-8"),
    ];

    if (numericalSystem) {
      writes.push(
        writeFile(
          join(storyDir, "particle_ledger.md"),
          language === "en"
            ? "# Resource Ledger\n\n| Chapter | Opening Value | Source | Integrity | Delta | Closing Value | Evidence |\n| --- | --- | --- | --- | --- | --- | --- |\n| 0 | 0 | Initialization | - | 0 | 0 | Initial book state |\n"
            : "# 资源账本\n\n| 章节 | 期初值 | 来源 | 完整度 | 增量 | 期末值 | 依据 |\n|------|--------|------|--------|------|--------|------|\n| 0 | 0 | 初始化 | - | 0 | 0 | 开书初始 |\n",
          "utf-8",
        ),
      );
    }

    // Initialize new truth files
    writes.push(
      writeFile(
        join(storyDir, "subplot_board.md"),
        language === "en"
          ? "# Subplot Board\n\n| Subplot ID | Subplot | Related Characters | Start Chapter | Last Active Chapter | Chapters Since | Status | Progress Summary | Payoff ETA |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- |\n"
          : "# 支线进度板\n\n| 支线ID | 支线名 | 相关角色 | 起始章 | 最近活跃章 | 距今章数 | 状态 | 进度概述 | 回收ETA |\n|--------|--------|----------|--------|------------|----------|------|----------|---------|\n",
        "utf-8",
      ),
      writeFile(
        join(storyDir, "emotional_arcs.md"),
        language === "en"
          ? "# Emotional Arcs\n\n| Character | Chapter | Emotional State | Trigger Event | Intensity (1-10) | Arc Direction |\n| --- | --- | --- | --- | --- | --- |\n"
          : "# 情感弧线\n\n| 角色 | 章节 | 情绪状态 | 触发事件 | 强度(1-10) | 弧线方向 |\n|------|------|----------|----------|------------|----------|\n",
        "utf-8",
      ),
      writeFile(
        join(storyDir, "character_matrix.md"),
        language === "en"
          ? "# Character Matrix\n\n### Character Profiles\n| Character | Core Tags | Contrast Detail | Speech Style | Personality Core | Relationship to Protagonist | Core Motivation | Current Goal |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n\n### Encounter Log\n| Character A | Character B | First Meeting Chapter | Latest Interaction Chapter | Relationship Type | Relationship Change |\n| --- | --- | --- | --- | --- | --- |\n\n### Information Boundaries\n| Character | Known Information | Unknown Information | Source Chapter |\n| --- | --- | --- | --- |\n"
          : "# 角色交互矩阵\n\n### 角色档案\n| 角色 | 核心标签 | 反差细节 | 说话风格 | 性格底色 | 与主角关系 | 核心动机 | 当前目标 |\n|------|----------|----------|----------|----------|------------|----------|----------|\n\n### 相遇记录\n| 角色A | 角色B | 首次相遇章 | 最近交互章 | 关系性质 | 关系变化 |\n|-------|-------|------------|------------|----------|----------|\n\n### 信息边界\n| 角色 | 已知信息 | 未知信息 | 信息来源章 |\n|------|----------|----------|------------|\n",
        "utf-8",
      ),
    );

    await Promise.all(writes);
  }

  /**
   * Reverse-engineer foundation from existing chapters.
   * Reads all chapters as a single text block and asks LLM to extract story_bible,
   * volume_outline, book_rules, current_state, and pending_hooks.
   */
  async generateFoundationFromImport(
    book: BookConfig,
    chaptersText: string,
    externalContext?: string,
    reviewFeedback?: string,
    options?: { readonly importMode?: "continuation" | "series" },
  ): Promise<ArchitectOutput> {
    const { profile: gp, body: genreBody } =
      await readGenreProfile(this.ctx.projectRoot, book.genre);
    const resolvedLanguage = book.language ?? gp.language;
    const reviewFeedbackBlock = this.buildReviewFeedbackBlock(reviewFeedback, resolvedLanguage);

    const contextBlock = externalContext
      ? (resolvedLanguage === "en"
          ? `\n\n## External Instructions\n${externalContext}\n`
          : `\n\n## 外部指令\n${externalContext}\n`)
      : "";

    const numericalBlock = gp.numericalSystem
      ? (resolvedLanguage === "en"
          ? `- The story uses a trackable numerical/resource system
- Define numericalSystemOverrides in book_rules (hardCap, resourceTypes)`
          : `- 有明确的数值/资源体系可追踪
- 在 book_rules 中定义 numericalSystemOverrides（hardCap、resourceTypes）`)
      : (resolvedLanguage === "en"
          ? "- This genre has no explicit numerical system and does not need a resource ledger"
          : "- 本题材无数值系统，不需要资源账本");

    const powerBlock = gp.powerScaling
      ? (resolvedLanguage === "en" ? "- The story has an explicit power-scaling ladder" : "- 有明确的战力等级体系")
      : "";

    const eraBlock = gp.eraResearch
      ? (resolvedLanguage === "en"
          ? "- The story needs era/historical grounding (set eraConstraints in book_rules)"
          : "- 需要年代考据支撑（在 book_rules 中设置 eraConstraints）")
      : "";

    const storyBiblePrompt = resolvedLanguage === "en"
      ? `Extract from the source text and organize with structured second-level headings:
## 01_Worldview
Extracted world setting, core rules, and frame

## 02_Protagonist
Inferred protagonist setup (identity / advantage / personality core / behavioral boundaries)

## 03_Factions_and_Characters
Factions and important supporting characters that appear in the source text

## 04_Geography_and_Environment
Locations, environments, and scene traits drawn from the source text

## 05_Title_and_Blurb
Keep the original title "${book.title}" and generate a matching blurb from the source text`
      : `从正文中提取，用结构化二级标题组织：
## 01_世界观
从正文中提取的世界观设定、核心规则体系

## 02_主角
从正文中推断的主角设定（身份/金手指/性格底色/行为边界）

## 03_势力与人物
从正文中出现的势力分布、重要配角（每人：名字、身份、动机、与主角关系、独立目标）

## 04_地理与环境
从正文中出现的地图/场景设定、环境特色

## 05_书名与简介
保留原书名"${book.title}"，根据正文内容生成简介`;

    const volumeOutlinePrompt = resolvedLanguage === "en"
      ? `Infer the volume plan from existing text:
- Existing chapters: review the actual structure already present
- Future projection: predict later directions from active hooks and plot momentum
For each volume include: title, chapter range, core conflict, and key turning points`
      : `基于已有正文反推卷纲：
- 已有章节部分：根据实际内容回顾每卷的结构
- 后续预测部分：基于已有伏笔和剧情走向预测未来方向
每卷包含：卷名、章节范围、核心冲突、关键转折`;

    const bookRulesPrompt = resolvedLanguage === "en"
      ? `Infer book_rules.md as YAML frontmatter plus narrative guidance from character behavior in the source text:
\`\`\`
---
version: "1.0"
protagonist:
  name: (extract protagonist name from the text)
  personalityLock: [(infer 3-5 personality keywords from behavior)]
  behavioralConstraints: [(infer 3-5 behavioral constraints from behavior)]
genreLock:
  primary: ${book.genre}
  forbidden: [(2-3 forbidden style intrusions)]
${gp.numericalSystem ? `numericalSystemOverrides:
  hardCap: (infer from the text)
  resourceTypes: [(extract core resource types from the text)]` : ""}
prohibitions:
  - (infer 3-5 book-specific prohibitions from the text)
chapterTypesOverride: []
fatigueWordsOverride: []
additionalAuditDimensions: []
enableFullCastTracking: false
---

## Narrative Perspective
(Infer the narrative perspective and style from the text)

## Core Conflict Driver
(Infer the book's core conflict and propulsion from the text)
\`\`\``
      : `从正文中角色行为反推 book_rules.md 格式的 YAML frontmatter + 叙事指导：
\`\`\`
---
version: "1.0"
protagonist:
  name: (从正文提取主角名)
  personalityLock: [(从行为推断3-5个性格关键词)]
  behavioralConstraints: [(从行为推断3-5条行为约束)]
genreLock:
  primary: ${book.genre}
  forbidden: [(2-3种禁止混入的文风)]
${gp.numericalSystem ? `numericalSystemOverrides:
  hardCap: (从正文推断)
  resourceTypes: [(从正文提取核心资源类型)]` : ""}
prohibitions:
  - (从正文推断3-5条本书禁忌)
chapterTypesOverride: []
fatigueWordsOverride: []
additionalAuditDimensions: []
enableFullCastTracking: false
---

## 叙事视角
(从正文推断本书叙事视角和风格)

## 核心冲突驱动
(从正文推断本书的核心矛盾和驱动力)
\`\`\``;

    // For import mode, we need to detect the latest chapter number from chaptersText
    const latestChapterMatch = chaptersText.match(/第\s*(\d+)\s*章|Chapter\s*(\d+)/i);
    const latestChapter = latestChapterMatch 
      ? parseInt(latestChapterMatch[1] || latestChapterMatch[2] || "0", 10)
      : 0;
    const currentStatePrompt = buildContinuationStatePrompt(gp, resolvedLanguage, latestChapter);

    const pendingHooksPrompt = resolvedLanguage === "en"
      ? `Identify all active hooks from the source text (Markdown table):
| hook_id | start_chapter | type | status | latest_progress | expected_payoff | payoff_timing | notes |`
      : `从正文中识别的所有伏笔（Markdown表格）：
| hook_id | 起始章节 | 类型 | 状态 | 最近推进 | 预期回收 | 回收节奏 | 备注 |`;

    const keyPrinciplesPrompt = resolvedLanguage === "en"
      ? `## Key Principles

1. Derive everything from the source text; do not invent unsupported settings
2. Hook extraction must be complete: unresolved clues, hints, and foreshadowing all count
3. Character inference must come from dialogue and behavior, not assumption
4. Accuracy first; detailed is better than missing crucial information
${numericalBlock}
${powerBlock}
${eraBlock}`
      : `## 关键原则

1. 一切从正文出发，不要臆造正文中没有的设定
2. 伏笔识别要完整：悬而未决的线索、暗示、预告都算
3. 角色推断要准确：从对话和行为推断性格，不要想当然
4. 准确性优先，宁可详细也不要遗漏
${numericalBlock}
${powerBlock}
${eraBlock}`;

    const isSeries = options?.importMode === "series";
    const continuationDirectiveEn = isSeries
      ? `## Continuation Direction Requirements (Critical)
The continuation portion (chapters in volume_outline that have not happened yet) must open up **new narrative space**:
1. **New conflict dimension**: Do not merely stretch the imported conflict longer. Introduce at least one new conflict vector not yet covered by the source text (new character, new faction, new location, or new time horizon)
2. **Ignite within 5 chapters**: The first continuation volume must establish a fresh suspense engine within 5 chapters. Do not spend 3 chapters recapping known information
3. **Scene freshness**: At least 50% of key continuation scenes must happen in locations or situations not already used in the imported chapters
4. **No repeated meeting rooms**: If the imported chapters end on a meeting/discussion beat, the continuation must restart from action instead of opening another meeting`
      : `## Continuation Direction
The volume_outline should naturally extend the existing narrative arc. Continue from where the imported chapters left off — advance existing conflicts, pay off planted hooks, and introduce new complications that arise organically from the current situation. Do not recap known information.`;
    const continuationDirectiveZh = isSeries
      ? `## 续写方向要求（关键）
续写部分（volume_outline 中尚未发生的章节）必须设计**新的叙事空间**：
1. **新冲突维度**：续写不能只是把导入章节的冲突继续拉长。必须引入至少一个原文未涉及的新冲突方向（新角色、新势力、新地点、新时间跨度）
2. **5章内引爆**：续写的第一卷必须在前5章内建立新悬念，不允许用3章回顾已知信息
3. **场景新鲜度**：续写部分至少50%的关键场景发生在导入章节未出现的地点或情境中
4. **不重复会议**：如果导入章节以会议/讨论结束，续写必须从行动开始，不能再开一轮会`
      : `## 续写方向
卷纲应自然延续已有叙事弧线。从导入章节的结尾处接续——推进现有冲突、兑现已埋伏笔、引入从当前局势中有机产生的新变数。不要回顾已知信息。`;

    const workingModeEn = isSeries
      ? `## Working Mode

This is not a zero-to-one foundation pass. You must extract durable story truth from the imported chapters **and design a continuation path**. You need to:
1. Extract worldbuilding, factions, characters, and systems from the source text -> generate story_bible
2. Infer narrative structure and future arc direction -> generate volume_outline (review existing chapters + design a **new continuation direction**)
3. Infer protagonist lock, prohibitions, and narrative constraints from character behavior -> generate book_rules
4. Reflect the latest chapter state -> generate current_state
5. Extract all active hooks already planted in the text -> generate pending_hooks`
      : `## Working Mode

This is not a zero-to-one foundation pass. You must extract durable story truth from the imported chapters **and preserve a clean continuation path**. You need to:
1. Extract worldbuilding, factions, characters, and systems from the source text -> generate story_bible
2. Infer narrative structure and near-future arc direction -> generate volume_outline (review existing chapters + continue naturally from where the imported chapters stop)
3. Infer protagonist lock, prohibitions, and narrative constraints from character behavior -> generate book_rules
4. Reflect the latest chapter state -> generate current_state
5. Extract all active hooks already planted in the text -> generate pending_hooks`;
    const workingModeZh = isSeries
      ? `## 工作模式

这不是从零创建，而是从已有正文中提取和推导，**并设计续写方向**。你需要：
1. 从正文中提取世界观、势力、角色、力量体系 → 生成 story_bible
2. 从叙事结构推断卷纲 → 生成 volume_outline（已有章节的回顾 + **续写部分的新方向设计**）
3. 从角色行为推断主角锁定和禁忌 → 生成 book_rules
4. 从最新章节状态推断 current_state（反映最后一章结束时的状态）
5. 从正文中识别已埋伏笔 → 生成 pending_hooks`
      : `## 工作模式

这不是从零创建，而是从已有正文中提取和推导，**并为自然续写保留清晰延续路径**。你需要：
1. 从正文中提取世界观、势力、角色、力量体系 → 生成 story_bible
2. 从叙事结构推断卷纲 → 生成 volume_outline（回顾已有章节，并从导入章节结束处自然接续）
3. 从角色行为推断主角锁定和禁忌 → 生成 book_rules
4. 从最新章节状态推断 current_state（反映最后一章结束时的状态）
5. 从正文中识别已埋伏笔 → 生成 pending_hooks`;

    const systemPrompt = resolvedLanguage === "en"
      ? `You are a professional web-fiction architect. Your task is to reverse-engineer a complete foundation from existing chapters.${contextBlock}

${workingModeEn}

All output sections — story_bible, volume_outline, book_rules, current_state, and pending_hooks — MUST be written in English. Keep the === SECTION: === tags unchanged.

${continuationDirectiveEn}
${reviewFeedbackBlock}
## Book Metadata

- Title: ${book.title}
- Platform: ${book.platform}
- Genre: ${gp.name} (${book.genre})
- Target Chapters: ${book.targetChapters}
- Chapter Target Length: ${book.chapterWordCount}

## Genre Profile

${genreBody}

## Output Contract

Generate the following sections. Separate every section with === SECTION: <name> ===:

=== SECTION: story_bible ===
${storyBiblePrompt}

=== SECTION: volume_outline ===
${volumeOutlinePrompt}

=== SECTION: book_rules ===
${bookRulesPrompt}

=== SECTION: current_state ===
${currentStatePrompt}

=== SECTION: pending_hooks ===
${pendingHooksPrompt}

${keyPrinciplesPrompt}`
      : `你是一个专业的网络小说架构师。你的任务是从已有的小说正文中反向推导完整的基础设定。${contextBlock}

${workingModeZh}

${continuationDirectiveZh}
${reviewFeedbackBlock}
## 书籍信息

- 标题：${book.title}
- 平台：${book.platform}
- 题材：${gp.name}（${book.genre}）
- 目标章数：${book.targetChapters}章
- 每章字数：${book.chapterWordCount}字

## 题材特征

${genreBody}

## 生成要求

你需要生成以下内容，每个部分用 === SECTION: <name> === 分隔：

=== SECTION: story_bible ===
${storyBiblePrompt}

=== SECTION: volume_outline ===
${volumeOutlinePrompt}

=== SECTION: book_rules ===
${bookRulesPrompt}

=== SECTION: current_state ===
${currentStatePrompt}

=== SECTION: pending_hooks ===
${pendingHooksPrompt}

${keyPrinciplesPrompt}`;
    const userMessage = resolvedLanguage === "en"
      ? `Generate the complete foundation for an imported ${gp.name} novel titled "${book.title}". Write everything in English.\n\n${chaptersText}`
      : `以下是《${book.title}》的全部已有正文，请从中反向推导完整基础设定：\n\n${chaptersText}`;

    const response = await this.chat([
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: userMessage,
      },
    ], { maxTokens: 16384, temperature: 0.5 });

    return this.parseSections(response.content);
  }

  async generateFanficFoundation(
    book: BookConfig,
    fanficCanon: string,
    fanficMode: FanficMode,
    reviewFeedback?: string,
  ): Promise<ArchitectOutput> {
    const { profile: gp, body: genreBody } =
      await readGenreProfile(this.ctx.projectRoot, book.genre);
    const reviewFeedbackBlock = this.buildReviewFeedbackBlock(reviewFeedback, book.language ?? "zh");

    const MODE_INSTRUCTIONS: Record<FanficMode, string> = {
      canon: "剧情发生在原作空白期或未详述的角度。不可改变原作已确立的事实。",
      au: "标注AU设定与原作的关键分歧点，分歧后的世界线自由发展。保留角色核心性格。",
      ooc: "标注角色性格偏离的起点和驱动事件。偏离必须有逻辑驱动。",
      cp: "以配对角色的关系线为主线规划卷纲。每卷必须有关系推进节点。",
    };

    const systemPrompt = `你是一个专业的同人小说架构师。你的任务是基于原作正典为同人小说生成基础设定。

## 同人模式：${fanficMode}
${MODE_INSTRUCTIONS[fanficMode]}

## 新时空要求（关键）
你必须为这本同人设计一个**原创的叙事空间**，而不是复述原作剧情。具体要求：
1. **明确分岔点**：story_bible 必须标注"本作从原作的哪个节点分岔"，或"本作发生在原作未涉及的什么时空"
2. **独立核心冲突**：volume_outline 的核心冲突必须是原创的，不是原作情节的翻版。原作角色可以出现，但他们面对的是新问题
3. **5章内引爆**：volume_outline 的第1卷必须在前5章内建立核心悬念，不允许用3章做铺垫才到引爆点
4. **场景新鲜度**：至少50%的关键场景发生在原作未出现的地点或情境中

${reviewFeedbackBlock}

## 原作正典
${fanficCanon}

## 题材特征
${genreBody}

## 关键原则
1. **不发明主要角色** — 主要角色必须来自原作正典的角色档案
2. 可以添加原创配角，但必须在 story_bible 中标注为"原创角色"
3. story_bible 保留原作世界观，标注同人的改动/扩展部分，并明确写出**分岔点**和**新时空设定**
4. volume_outline 不得复述原作剧情节拍。每卷的核心事件必须是原创的，标注"原创"
5. book_rules 的 fanficMode 必须设为 "${fanficMode}"
6. 主角设定来自原作角色档案中的第一个角色（或用户在标题中暗示的角色）

你需要生成以下内容，每个部分用 === SECTION: <name> === 分隔：

=== SECTION: story_bible ===
世界观（基于原作正典）+ 角色列表（原作角色标注来源，原创角色标注"原创"）

=== SECTION: volume_outline ===
卷纲规划。每卷标注：卷名、章节范围、核心事件（标注原作/原创）、关系发展节点

=== SECTION: book_rules ===
\`\`\`
---
version: "1.0"
protagonist:
  name: (从原作角色中选择)
  personalityLock: [(从正典角色档案提取)]
  behavioralConstraints: [(基于原作行为模式)]
genreLock:
  primary: ${book.genre}
  forbidden: []
fanficMode: "${fanficMode}"
allowedDeviations: []
prohibitions:
  - (3-5条同人特有禁忌)
---
(叙事视角和风格指导)
\`\`\`

=== SECTION: current_state ===
初始状态卡（基于正典起始点）

=== SECTION: pending_hooks ===
初始伏笔池（从正典关键事件和关系中提取）`;

    const response = await this.chat([
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: `请为标题为"${book.title}"的${fanficMode}模式同人小说生成基础设定。目标${book.targetChapters}章，每章${book.chapterWordCount}字。`,
      },
    ], { maxTokens: 16384, temperature: 0.7 });

    return this.parseSections(response.content);
  }

  async regenerateOutline(
    book: BookConfig,
    bookDir: string,
    authorIntent: string,
    rewriteLevel: "low" | "medium" | "high" = "medium",
  ): Promise<{ readonly volumeOutline: string }> {
    const { profile: gp, body: genreBody } =
      await readGenreProfile(this.ctx.projectRoot, book.genre);
    const resolvedLanguage = book.language ?? gp.language;

    // 读取现有卷纲和相邻卷内容
    const existingOutline = await this.readFileSafe(join(bookDir, "story/volume_outline.md"));
    const existingChapters = await this.loadExistingChapters(bookDir);
    const adjacentVolumes = this.extractAdjacentVolumes(existingOutline);

    const rewriteLevelInstructions = {
      low: "保留大部分原有情节结构，只做小幅度调整以符合新的作者意图",
      medium: "在保留核心情节的基础上，根据新的作者意图进行适度调整",
      high: "根据新的作者意图，重新设计情节结构，只保留必要的核心元素",
    };

    const systemPrompt = resolvedLanguage === "en"
      ? `You are a professional web fiction architect. Your task is to regenerate the volume outline based on the author's new intent.

## Author Intent
${authorIntent}

## Rewrite Level: ${rewriteLevel}
${rewriteLevelInstructions[rewriteLevel]}

## Existing Outline
${existingOutline}

## Existing Chapters
${existingChapters}

## Adjacent Volumes
${adjacentVolumes}

## Requirements
1. Regenerate the volume outline based on the author's intent
2. Ensure smooth transition with adjacent volumes
3. Preserve key plot elements according to the rewrite level
4. Maintain consistency with the existing story bible and character settings
5. Generate a comprehensive volume outline with clear chapter ranges, core conflicts, and key turning points
6. Follow the golden first three chapters rule for new volumes

Output only the regenerated volume outline in Markdown format.`
      : `你是一个专业的网络小说架构师。你的任务是根据作者的新意图重新生成卷纲。

## 作者意图
${authorIntent}

## 重写幅度：${rewriteLevel}
${rewriteLevelInstructions[rewriteLevel]}

## 现有卷纲
${existingOutline}

## 现有章节
${existingChapters}

## 相邻卷内容
${adjacentVolumes}

## 要求
1. 根据作者意图重新生成卷纲
2. 确保与相邻卷的内容衔接自然
3. 根据重写幅度保留关键情节元素
4. 保持与现有故事设定和角色设定的一致性
5. 生成完整的卷纲，包含清晰的章节范围、核心冲突和关键转折点
6. 新卷遵循黄金三章法则

只输出重新生成的卷纲，使用Markdown格式。`;

    const response = await this.chat([
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: resolvedLanguage === "en"
          ? "Please regenerate the volume outline based on the author's intent and the provided context."
          : "请根据作者意图和提供的上下文重新生成卷纲。",
      },
    ], { maxTokens: 8192, temperature: 0.7 });

    // Filter out <think> and <thinking> tags from LLM response
    let filteredContent = response.content.trim();
    // Remove <think>...</think> tags (used by some LLM models)
    const thinkRegex = /<think>[\s\S]*?<\/think>/gi;
    filteredContent = filteredContent.replace(thinkRegex, "");
    // Remove <thinking>...</thinking> tags (used by some LLM models)
    const thinkingRegex = /<thinking>[\s\S]*?<\/thinking>/gi;
    filteredContent = filteredContent.replace(thinkingRegex, "");
    // Clean up any empty lines left after removal
    filteredContent = filteredContent.replace(/\n{3,}/g, "\n\n").trim();

    return { volumeOutline: filteredContent };
  }

  private async loadExistingChapters(bookDir: string): Promise<string> {
    try {
      const chaptersDir = join(bookDir, "chapters");
      const files = await readdir(chaptersDir);
      const chapterFiles = files.filter(f => f.endsWith(".md")).sort();
      
      let chaptersContent = "";
      for (const file of chapterFiles.slice(-3)) { // 只加载最近3章
        const content = await readFile(join(chaptersDir, file), "utf-8");
        chaptersContent += `## ${file}\n${content}\n\n`;
      }
      
      return chaptersContent || "(No existing chapters)";
    } catch {
      return "(No existing chapters)";
    }
  }

  private extractAdjacentVolumes(outline: string): string {
    // 简单提取相邻卷的信息
    const lines = outline.split("\n");
    let volumes = [];
    let currentVolume = "";
    
    for (const line of lines) {
      if (line.startsWith("#") && line.includes("卷")) {
        if (currentVolume) {
          volumes.push(currentVolume);
        }
        currentVolume = line + "\n";
      } else if (currentVolume) {
        currentVolume += line + "\n";
      }
    }
    
    if (currentVolume) {
      volumes.push(currentVolume);
    }
    
    return volumes.slice(-2).join("\n") || "(No adjacent volumes)";
  }

  private buildReviewFeedbackBlock(
    reviewFeedback: string | undefined,
    language: "zh" | "en",
  ): string {
    const trimmed = reviewFeedback?.trim();
    if (!trimmed) return "";

    if (language === "en") {
      return `\n\n## Previous Review Feedback
The previous foundation draft was rejected. You must explicitly fix the following issues in this regeneration instead of paraphrasing the same design:

${trimmed}\n`;
    }

    return `\n\n## 上一轮审核反馈
上一轮基础设定未通过审核。你必须在这次重生中明确修复以下问题，不能只换措辞重写同一套方案：

${trimmed}\n`;
  }

  async generateVolumeDetail(
    book: BookConfig,
    bookDir: string,
    volumeId: number,
  ): Promise<{ readonly volumeDetail: string }> {
    const { profile: gp, body: genreBody } =
      await readGenreProfile(this.ctx.projectRoot, book.genre);
    const resolvedLanguage = book.language ?? gp.language;

    // 读取现有卷纲
    const existingOutline = await this.readFileSafe(join(bookDir, "story/volume_outline.md"));
    
    // 解析卷纲，提取目标卷的信息
    const targetVolumeInfo = this.extractVolumeInfo(existingOutline, volumeId);
    
    // 读取故事设定和书籍规则
    const storyBible = await this.readFileSafe(join(bookDir, "story/story_bible.md"));
    const bookRules = await this.readFileSafe(join(bookDir, "story/book_rules.md"));

    const systemPrompt = resolvedLanguage === "en"
      ? `You are a professional web fiction architect. Your task is to generate a detailed outline for a specific volume based on the overall story plan.

## Story Bible (Core Settings)
${storyBible}

## Book Rules
${bookRules}

## Overall Volume Outline (Full Story Plan)
${existingOutline}

## Target Volume (Basic Info)
${targetVolumeInfo}

## Important Instructions
1. **Based on Overall Plan**: The target volume's detailed outline must strictly follow the overall volume outline's plot direction and major events. Do not deviate from the overall story plan.

2. **Expand and Detail**: The target volume info above may be brief. Your job is to expand it into a detailed, chapter-by-chapter outline (3-5 chapters per group) with specific events, conflicts, and developments.

3. **Chapter Planning**: For each chapter group, define:
   - Core events and plot progression
   - Key turning points that drive the story forward
   - Payoff goals and reader satisfaction moments
   - Cliffhangers to maintain engagement

4. **Consistency Requirements**:
   - Maintain consistency with story bible and book rules
   - Ensure smooth transitions between chapters
   - Connect logically with previous and next volumes (as outlined in the overall plan)
   - Follow the golden first three chapters rule if this is volume 1

5. **Character Development**: Include character arcs and growth within this volume that align with the overall story plan.

6. **Volume Positioning**: Understand this volume's role in the overall story - is it setup, rising action, climax, or resolution? Adjust pacing accordingly.

Output only the detailed volume outline in Markdown format, using the following structure:

### Volume {N}: {Title}

**Chapter Range**: {start}-{end}

**Volume Positioning**: {This volume's role in the overall story arc}

**Core Conflict**: {Main conflict of this volume}

**Key Turning Points**:
- Turning point 1: ...
- Turning point 2: ...

**Chapter Groups**:
- Chapters {start}-{start+2}: {group1 title}
  - Core events: ...
  - Key turning points: ...
  - Payoff goals: ...
  - Cliffhanger: ...
  
- Chapters {start+3}-{start+5}: {group2 title}
  - ...

**Character Development**: {Character arcs within this volume}

**Payoff Goals**: {Reader satisfaction goals for this volume}

**Connection to Overall Plot**: {How this volume advances the overall story}`
      : `你是一个专业的网络小说架构师。你的任务是基于整体故事规划，为特定分卷生成详细的卷纲。

## 故事设定（核心设定）
${storyBible}

## 书籍规则
${bookRules}

## 总体卷纲（完整故事规划）
${existingOutline}

## 目标分卷（基础信息）
${targetVolumeInfo}

## 重要说明
1. **基于整体规划**：目标分卷的详细卷纲必须严格遵循总体卷纲的剧情走向和重大事件安排，不得偏离整体故事规划。

2. **扩展细化**：上面的目标分卷信息可能比较简略，你的任务是将其扩展为详细的逐章卷纲（每 3-5 章为一组），包含具体的事件、冲突和发展。

3. **章节规划**：为每组章节定义：
   - 核心事件和剧情推进
   - 推动故事前进的关键转折点
   - 收益目标和读者爽点
   - 维持阅读兴趣的悬念钩子

4. **一致性要求**：
   - 保持与故事设定和书籍规则的一致性
   - 确保章节间过渡自然流畅
   - 与前后卷逻辑衔接（按照总体卷纲的规划）
   - 如果是第一卷，遵循黄金三章法则

5. **角色发展**：包含本卷内的角色弧线和成长，但要符合整体故事规划。

6. **分卷定位**：理解本分卷在整体故事中的定位——是铺垫、发展、高潮还是结局？相应调整节奏。

只输出详细的分卷卷纲，使用 Markdown 格式，结构如下：

### 第{N}卷：{卷名}

**章节范围**：{start}-{end}

**分卷定位**：{本分卷在整体故事线中的角色}

**核心冲突**：{本分卷的主要冲突}

**关键转折点**：
- 转折点1：...
- 转折点2：...

**章节分组**：
- 第{start}-{start+2} 章：{第一组标题}
  - 核心事件：...
  - 关键转折：...
  - 收益目标：...
  - 悬念钩子：...
  
- 第{start+3}-{start+5} 章：{第二组标题}
  - ...

**角色发展**：{本分卷内的角色弧线}

**收益目标**：{本分卷的读者爽点目标}

**与主线的关联**：{本分卷如何推进整体故事}`;

    const response = await this.chat([
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: resolvedLanguage === "en"
          ? `Please generate a detailed outline for volume ${volumeId}.`
          : `请生成第${volumeId}卷的详细卷纲。`,
      },
    ], { maxTokens: 8192, temperature: 0.7 });

    // Filter out <think> and <thinking> tags from LLM response
    let filteredContent = response.content.trim();
    // Remove <think>...</think> tags (used by some LLM models)
    const thinkRegex = /<think>[\s\S]*?<\/think>/gi;
    filteredContent = filteredContent.replace(thinkRegex, "");
    // Remove <thinking>...</thinking> tags (used by some LLM models)
    const thinkingRegex = /<thinking>[\s\S]*?<\/thinking>/gi;
    filteredContent = filteredContent.replace(thinkingRegex, "");
    // Clean up any empty lines left after removal
    filteredContent = filteredContent.replace(/\n{3,}/g, "\n\n").trim();

    return { volumeDetail: filteredContent };
  }

  private extractVolumeInfo(outline: string, volumeId: number): string {
    const lines = outline.split("\n");
    let currentVolume = "";
    let found = false;
    let volumeContent = "";
    
    const volumePattern = new RegExp(`第.*?${volumeId}卷 | 卷${volumeId}|Volume\\s*${volumeId}`, "i");
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      
      if (line.startsWith("#") && volumePattern.test(line)) {
        if (found) {
          break;
        }
        found = true;
        currentVolume = line + "\n";
      } else if (found) {
        if (line.startsWith("#") && line.includes("卷")) {
          break;
        }
        currentVolume += line + "\n";
      }
    }
    
    return found ? currentVolume.trim() : `(Volume ${volumeId} not found in outline)`;
  }

  async parseVolumeOutline(
    outlineContent: string,
  ): Promise<{ readonly volumePlans: Array<{ volumeId: number; title: string; chapterRange: { start: number; end: number }; outline: string }> }> {
    // 使用中文作为默认语言（因为卷纲通常是中文）
    const resolvedLanguage: "zh" | "en" = outlineContent.includes("卷") ? "zh" : "en";

    const systemPrompt = resolvedLanguage === "en"
      ? `You are a professional web fiction architect. Your task is to parse a volume outline document and extract structured information.

## Input Format
The input is a Markdown document containing volume outlines. It may have various formats:
- Table format with columns: Volume Name, Chapters, Core Conflict, etc.
- Section format with headers like: ### Volume 1: Title (Chapters 1-50)
- Mixed format with both tables and sections

## Your Task
Parse the document and extract each volume's information:
1. Volume ID (1, 2, 3, ...)
2. Volume Title
3. Chapter Range (start and end)
4. Volume Outline (the full content of that volume section)

## Output Format
Return ONLY a JSON object with this exact structure. No additional text, no markdown code blocks:
{
  "volumePlans": [
    {
      "volumeId": 1,
      "title": "Volume Title",
      "chapterRange": { "start": 1, "end": 50 },
      "outline": "Full volume outline content..."
    }
  ]
}

Be flexible with format variations. If chapter range is not explicit, infer from context.
IMPORTANT: Output ONLY the JSON, no explanations, no markdown formatting.`
      : `你是一个专业的网络小说架构师。你的任务是解析卷纲文档并提取结构化信息。

## 输入格式
输入是一个 Markdown 文档，包含卷纲内容。可能有多种格式：
- 表格格式：卷名、章节、核心冲突等列
- 分卷标题格式：### 第一卷：卷名（1-50 章）
- 混合格式：表格 + 分卷标题

## 你的任务
解析文档并提取每个分卷的信息：
1. 卷 ID（1, 2, 3, ...）
2. 卷名
3. 章节范围（起始和结束）
4. 分卷卷纲（该分卷的完整内容）

## 输出格式
返回 ONLY 一个 JSON 对象，使用以下精确结构。不要额外文本，不要 markdown 代码块：
{
  "volumePlans": [
    {
      "volumeId": 1,
      "title": "卷名",
      "chapterRange": { "start": 1, "end": 50 },
      "outline": "完整的分卷卷纲内容..."
    }
  ]
}

灵活处理各种格式变体。如果章节范围不明确，从上下文中推断。
重要：只输出 JSON，不要解释，不要 markdown 格式。`;

    const response = await this.chat([
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: resolvedLanguage === "en"
          ? `Please parse this volume outline document:\n\n${outlineContent.substring(0, 8000)}`
          : `请解析以下卷纲文档：\n\n${outlineContent.substring(0, 8000)}`,
      },
    ], { maxTokens: 4096, temperature: 0.1 });

    // Parse the JSON response with multiple extraction strategies
    const parsedResult = this.extractJsonFromResponse(response.content);
    if (parsedResult && parsedResult.volumePlans && parsedResult.volumePlans.length > 0) {
      return {
        volumePlans: parsedResult.volumePlans.map((v: any) => ({
          volumeId: v.volumeId || 0,
          title: v.title || `第${v.volumeId}卷`,
          chapterRange: v.chapterRange || { start: 0, end: 0 },
          outline: v.outline || ""
        }))
      };
    }

    // Fallback to simple regex parsing
    return { volumePlans: this.simpleParseVolumeOutline(outlineContent) };
  }

  private extractJsonFromResponse(content: string): any {
    // Strategy 1: Try to find JSON object in the response
    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
    } catch (e) {
      console.warn(`Strategy 1 failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    // Strategy 2: Remove markdown code blocks if present
    try {
      const codeBlockMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (codeBlockMatch) {
        const jsonContent = codeBlockMatch[1]?.trim();
        if (jsonContent) {
          return JSON.parse(jsonContent);
        }
      }
    } catch (e) {
      console.warn(`Strategy 2 failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    // Strategy 3: Try to extract array from text
    try {
      const arrayMatch = content.match(/\[[\s\S]*\]/);
      if (arrayMatch) {
        const parsed = JSON.parse(arrayMatch[0]);
        if (Array.isArray(parsed)) {
          return { volumePlans: parsed };
        }
      }
    } catch (e) {
      console.warn(`Strategy 3 failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    // Strategy 4: Try to find volumePlans key
    try {
      const volumePlansMatch = content.match(/"volumePlans"\s*:\s*([\s\S]*?)(?=,\s*"[^"]+"\s*:|\s*\}|\s*$)/);
      if (volumePlansMatch) {
        const jsonStr = `{ "volumePlans": ${volumePlansMatch[1]} }`;
        return JSON.parse(jsonStr);
      }
    } catch (e) {
      console.warn(`Strategy 4 failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    return null;
  }

  private simpleParseVolumeOutline(outlineContent: string): Array<{ volumeId: number; title: string; chapterRange: { start: number; end: number }; outline: string }> {
    const volumePlans: Array<{ volumeId: number; title: string; chapterRange: { start: number; end: number }; outline: string }> = [];
    const lines = outlineContent.split("\n");
    const chineseNumbers = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
    
    const patterns = [
      /^#{2,4}\s*第.*?卷 [：:]([^(]+)[（(](\d+)-(\d+) 章 [)）]/,
      /^#{2,4}\s*第.*?卷 [：:]([^(]+)[（(](?:第)?(\d+)-(\d+) 章 [)）]/,
      /^#{2,4}\s*第.*?卷 [：:]([^(]+)$/,
      /^#{2,4}\s*卷 ([一二三四五六七八九十\d]+)[：:]\s*(.+?)$/,
      /^#{2,4}\s*Volume\s+(\d+)[：:]\s*(.+?)$/i
    ];
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      
      for (const pattern of patterns) {
        const match = line.match(pattern);
        if (match) {
          let volumeId: number;
          let title: string;
          let chapterStart = 0;
          let chapterEnd = 0;
          
          if (pattern.source.includes('Volume')) {
            volumeId = parseInt(match[1], 10);
            title = match[2]?.trim() || '';
          } else if (pattern.source.includes('卷 ([一二三四五六七八九十\\d]+)')) {
            const numStr = match[1];
            volumeId = chineseNumbers.indexOf(numStr) || parseInt(numStr, 10) || 1;
            title = match[2]?.trim() || '';
          } else {
            const titlePart = match[1]?.trim() || '';
            const titleMatch = titlePart.match(/([一二三四五六七八九十\d]+)[·.:\s:](.+)/);
            if (titleMatch) {
              const numStr = titleMatch[1];
              volumeId = chineseNumbers.indexOf(numStr) || parseInt(numStr, 10) || volumePlans.length + 1;
              title = titleMatch[2]?.trim() || titlePart;
            } else {
              volumeId = volumePlans.length + 1;
              title = titlePart;
            }
            if (match[2] && /^\d+$/.test(match[2])) {
              chapterStart = parseInt(match[2], 10);
              chapterEnd = parseInt(match[3] || '0', 10);
            }
          }
          
          volumePlans.push({
            volumeId,
            title,
            chapterRange: { start: chapterStart, end: chapterEnd },
            outline: ""
          });
          break;
        }
      }
    }
    
    return volumePlans;
  }

  private parseSections(content: string): ArchitectOutput {
    // Use the new LlmOutputCache for consistent filtering and parsing
    const cache = new LlmOutputCache(this.ctx.projectRoot);
    const parseResult = cache.parseSections(content);

    this.ctx.logger?.info(`[parseSections] Found ${parseResult.sections.size} sections`);
    for (const [name, sectionContent] of parseResult.sections.entries()) {
      this.ctx.logger?.info(`[parseSections] Section "${name}": ${sectionContent.length} chars`);
    }

    // Log filtered content preview for debugging
    const filteredPreview = parseResult.filteredContent.slice(0, 500);
    this.ctx.logger?.info(`[parseSections] Filtered content preview: ${filteredPreview}...`);

    const allSectionNames = ['story_bible', 'volume_outline', 'book_rules', 'current_state', 'pending_hooks'];

    const extract = (name: string): string => {
      this.ctx.logger?.info(`[parseSections] Extracting section: ${name}`);
      
      const section = cache.extractSection(parseResult, name, {
        required: false, // Don't throw here, handle it below for better error message
        validateBoundary: true,
        otherSections: allSectionNames.filter(n => n !== name),
      });

      if (!section) {
        // Log available sections for debugging
        this.ctx.logger?.error(`[parseSections] Failed to extract "${name}". Available sections: ${Array.from(parseResult.sections.keys()).join(', ')}`);
        this.ctx.logger?.error(`[parseSections] Raw content preview: ${content.slice(0, 1000)}...`);
        throw new Error(`Architect output missing required section: ${name}. Available sections: ${Array.from(parseResult.sections.keys()).join(', ')}`);
      }

      this.ctx.logger?.info(`[parseSections] Successfully extracted "${name}": ${section.length} chars`);

      if (name !== "pending_hooks") {
        return section;
      }
      return this.normalizePendingHooksSection(this.stripTrailingAssistantCoda(section));
    };

    return {
      storyBible: extract("story_bible"),
      volumeOutline: extract("volume_outline"),
      bookRules: extract("book_rules"),
      currentState: extract("current_state"),
      pendingHooks: extract("pending_hooks"),
    };
  }

  private normalizeSectionName(name: string): string {
    return name
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[`"'*_]/g, " ")
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
  }

  private stripTrailingAssistantCoda(section: string): string {
    const lines = section.split("\n");
    const cutoff = lines.findIndex((line) => {
      const trimmed = line.trim();
      if (!trimmed) return false;
      return /^(如果(?:你愿意|需要|想要|希望)|If (?:you(?:'d)? like|you want|needed)|I can (?:continue|next))/i.test(trimmed);
    });

    if (cutoff < 0) {
      return section;
    }

    return lines.slice(0, cutoff).join("\n").trimEnd();
  }

  private normalizePendingHooksSection(section: string): string {
    const rows = section
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("|"))
      .filter((line) => !line.includes("---"))
      .map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()))
      .filter((cells) => cells.some(Boolean));

    if (rows.length === 0) {
      return section;
    }

    const dataRows = rows.filter((row) => (row[0] ?? "").toLowerCase() !== "hook_id");
    if (dataRows.length === 0) {
      return section;
    }

    const language: "zh" | "en" = /[\u4e00-\u9fff]/.test(section) ? "zh" : "en";
    const normalizedHooks = dataRows.map((row, index) => {
      const rawProgress = row[4] ?? "";
      const normalizedProgress = this.parseHookChapterNumber(rawProgress);
      const seedNote = normalizedProgress === 0 && this.hasNarrativeProgress(rawProgress)
        ? (language === "zh" ? `初始线索：${rawProgress}` : `initial signal: ${rawProgress}`)
        : "";
      const notes = this.mergeHookNotes(row[6] ?? "", seedNote, language);

      return {
        hookId: row[0] || `hook-${index + 1}`,
        startChapter: this.parseHookChapterNumber(row[1]),
        type: row[2] ?? "",
        status: row[3] ?? "open",
        lastAdvancedChapter: normalizedProgress,
        expectedPayoff: row[5] ?? "",
        payoffTiming: row.length >= 8 ? row[6] ?? "" : "",
        notes: row.length >= 8 ? this.mergeHookNotes(row[7] ?? "", seedNote, language) : notes,
      };
    });

    return renderHookSnapshot(normalizedHooks, language);
  }

  private parseHookChapterNumber(value: string | undefined): number {
    if (!value) return 0;
    const match = value.match(/\d+/);
    return match ? parseInt(match[0], 10) : 0;
  }

  private hasNarrativeProgress(value: string | undefined): boolean {
    const normalized = (value ?? "").trim().toLowerCase();
    if (!normalized) return false;
    return !["0", "none", "n/a", "na", "-", "无", "未推进"].includes(normalized);
  }

  private mergeHookNotes(notes: string, seedNote: string, language: "zh" | "en"): string {
    const trimmedNotes = notes.trim();
    const trimmedSeed = seedNote.trim();
    if (!trimmedSeed) {
      return trimmedNotes;
    }
    if (!trimmedNotes) {
      return trimmedSeed;
    }
    return language === "zh"
      ? `${trimmedNotes}（${trimmedSeed}）`
      : `${trimmedNotes} (${trimmedSeed})`;
  }

  private async readFileSafe(filePath: string): Promise<string> {
    try {
      const content = await readFile(filePath, "utf-8");
      return content;
    } catch {
      return "";
    }
  }

  /**
   * Combine current_state with pending_hooks for comprehensive state tracking.
   * This ensures hooks are visible both in the state card and in the dedicated hooks file.
   */
  private combineStateWithHooks(
    currentState: string,
    pendingHooks: string,
    language: "zh" | "en"
  ): string {
    // Check if current_state already contains hooks section
    const hasHooksSection = /##\s*(初始伏笔|Pending Hooks|Hooks)/i.test(currentState);

    if (hasHooksSection) {
      // Current state already has hooks, return as-is
      return currentState;
    }

    // Add hooks section to current_state
    const hooksHeader = language === "en"
      ? "\n\n## Pending Hooks\n\nInitial hooks planted at book creation:\n\n"
      : "\n\n## 初始伏笔\n\n开书时埋下的初始伏笔：\n\n";

    return currentState + hooksHeader + pendingHooks;
  }

  /**
   * 基于现有设定重新生成剧情规划（卷纲、当前状态、待填坑）
   * 用于：对初始卷纲不满意，但满意设定时重新规划剧情
   */
  async regeneratePlotPlanning(
    book: BookConfig,
    existingFoundation: {
      storyBible: string;
      characters: string;
      bookRules?: string;
      originalVolumeOutline?: string;
    },
    options?: {
      instruction?: string;
      temperature?: number;
      rewriteLevel?: "low" | "medium" | "high" | "extend";
    }
  ): Promise<ArchitectOutput> {
    const { profile: gp, body: genreBody } =
      await readGenreProfile(this.ctx.projectRoot, book.genre);
    const resolvedLanguage = book.language ?? gp.language;

    const instructionBlock = options?.instruction
      ? (resolvedLanguage === "en"
          ? `\n\n## Author's Additional Requirements\n${options.instruction}\n`
          : `\n\n## 作者的额外要求\n${options.instruction}\n`)
      : "";

    // 重写幅度说明
    const rewriteLevelDesc = {
      low: resolvedLanguage === "en" 
        ? "LOW rewrite level: Keep most of the original plot structure, only make minor adjustments to pacing and details."
        : "低重写幅度：保留大部分原有情节结构，只对节奏和细节进行微调。",
      medium: resolvedLanguage === "en"
        ? "MEDIUM rewrite level: Moderately adjust the plot structure, optimize chapter arrangement and conflict settings."
        : "中重写幅度：适度调整情节结构，优化章节安排和冲突设置。",
      high: resolvedLanguage === "en"
        ? "HIGH rewrite level: Completely redesign the plot structure, create a brand new storyline that fits the existing settings."
        : "高重写幅度：完全重新设计情节结构，创建与现有设定兼容的全新剧情线。",
      extend: resolvedLanguage === "en"
        ? "EXTEND mode: Keep all existing plot up to a certain point, remove the current ending, and continue expanding the story with new subsequent plotlines that maintain consistency with the established settings and characters."
        : "扩写续写模式：保留截至某点的所有现有剧情，删除当前结尾，继续扩展后续剧情，确保与已建立的设定和角色保持一致。",
    };
    const rewriteLevelBlock = options?.rewriteLevel
      ? `\n\n## Rewrite Level\n${rewriteLevelDesc[options.rewriteLevel]}\n`
      : "";

    const systemPrompt = resolvedLanguage === "en"
      ? `You are a professional web-fiction architect. Your task is to regenerate the plot planning (volume outline, current state, pending hooks) based on the existing story settings.

## Story Bible (World Settings - MUST PRESERVE)
${existingFoundation.storyBible}

## Character Settings (MUST PRESERVE)
${existingFoundation.characters}

## Book Rules (Writing Constraints - MUST FOLLOW)
${existingFoundation.bookRules || "(No specific rules)"}

## Original Volume Outline (Reference Only)
The following is the original volume outline for reference. Depending on the rewrite level, you may use it as a basis for modification or completely redesign:

${existingFoundation.originalVolumeOutline || "(No original outline available)"}

## Book Info
- Title: ${book.title}
- Genre: ${book.genre}
- Platform: ${book.platform}
- Language: ${book.language}
- Target Chapters: ${book.targetChapters}
- Chapter Word Count: ${book.chapterWordCount}
${instructionBlock}${rewriteLevelBlock}

## Your Task
Based on the above settings (which you MUST preserve exactly)${options?.rewriteLevel ? ` and the specified rewrite level` : ``}, regenerate the complete plot planning:

1. **volume_outline.md** - Volume plan (STRICTLY follow this format):
   - For each volume include: title, chapter range, core conflict, key turning points, and payoff goal
   - DO NOT write detailed chapter-by-chapter summaries - keep it volume-level only

   ### Golden First Three Chapters Rule (MUST follow for chapters 1-3)
   - Chapter 1: throw the core conflict immediately; no large background dump
   - Chapter 2: show the core edge / ability / leverage that answers Chapter 1's pressure
   - Chapter 3: establish the first concrete short-term goal that gives readers a reason to continue

2. **current_state.md** - Current narrative state:
   - Current plot position
   - Immediate challenges
   - Active story threads

3. **pending_hooks.md** - Pending plot hooks:
   - All planted hooks that need payoff
   - Expected resolution chapters
   - Hook types and statuses

## Output Format
You must output ONLY the following 3 sections with exact markers. DO NOT output story_bible or book_rules sections - they will be preserved separately.

=== volume_outline ===
(Regenerated volume outline with complete volume and chapter structure)

=== current_state ===
(Regenerated current state)

=== pending_hooks ===
(Regenerated pending hooks in table format)

## CRITICAL RULES
1. ONLY output the 3 sections above (volume_outline, current_state, pending_hooks)
2. DO NOT output story_bible or book_rules - they are preserved separately
3. DO NOT use <think> tags or include thinking process in output
4. Start immediately with "=== volume_outline ===" marker
5. Ensure each section has substantial content (at least 500 characters)
6. Create a fresh plot structure that works with the existing settings`
      : `你是一位专业的网络小说架构师。你的任务是基于现有设定重新生成剧情规划（卷纲、当前状态、待填坑）。

【世界观设定】（必须保留）
${existingFoundation.storyBible}

【角色设定】（必须保留）
${existingFoundation.characters}

【本书规则】（必须遵守）
${existingFoundation.bookRules || "（无特定规则）"}

【原始卷纲】（仅供参考）
以下是原始卷纲，仅供参考。根据重写幅度，你可以在其基础上修改或完全重新设计：

${existingFoundation.originalVolumeOutline || "（无原始卷纲）"}

【书籍信息】
- 书名：${book.title}
- 类型：${book.genre}
- 平台：${book.platform}
- 语言：${book.language}
- 目标章节数：${book.targetChapters}
- 每章字数：${book.chapterWordCount}
${instructionBlock}${rewriteLevelBlock}

【你的任务】
基于以上设定（必须严格保留）${options?.rewriteLevel ? `和指定的重写幅度` : ``}，重新生成完整的剧情规划：

1. **volume_outline.md** - 卷纲规划（严格按照以下格式）：
   - 每卷包含：卷名、章节范围、核心冲突、关键转折、收益目标
   - 不需要详细的每章剧情，只保留卷级概览

   ### 黄金三章法则（前三章必须遵循）
   - 第1章：抛出核心冲突（主角立即面临困境/危机/选择），禁止大段背景灌输
   - 第2章：展示金手指/核心能力（主角如何应对第1章的困境），让读者看到爽点预期
   - 第3章：明确短期目标（主角确立第一个具体可达成的目标），给读者追读理由

2. **current_state.md** - 当前状态：
   - 当前剧情位置
   - 当前面临的挑战
   - 活跃的故事线

3. **pending_hooks.md** - 待填坑清单：
   - 所有已埋下待回收的伏笔
   - 预期回收章节
   - 伏笔类型和状态

【输出格式】
你必须只输出以下3个部分，使用精确的章节标记。不要输出 story_bible 或 book_rules 部分 - 它们会被单独保留。

=== volume_outline ===
（重新生成的卷纲，包含完整的分卷和章节结构）

=== current_state ===
（重新生成的当前状态）

=== pending_hooks ===
（重新生成的待填坑清单，使用表格格式）

【关键规则】
1. 只输出上述3个部分（volume_outline, current_state, pending_hooks）
2. 不要输出 story_bible 或 book_rules - 它们会被单独保留
3. 不要使用 <think> 标签或在输出中包含思考过程
4. 立即以 "=== volume_outline ===" 标记开始输出
5. 确保每个部分都有实质性内容（至少500字符）
6. 创建与现有设定兼容的全新剧情结构`;

    this.ctx.logger?.info(`[regenerateOutline] Regenerating outline for book "${book.id}"`);

    // Save raw LLM output to cache for debugging (keep think tags for analysis)
    const cache = new LlmOutputCache(this.ctx.projectRoot);
    await cache.initialize();

    const userPrompt = resolvedLanguage === "en"
      ? `Please regenerate the complete plot planning for "${book.title}" based on the existing settings.`
      : `请基于现有设定，为《${book.title}》重新生成完整的剧情规划。`;

    const response = await this.chat([
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ], { maxTokens: 64000, temperature: options?.temperature ?? 0.8 }); // Increased to 64000 for large books

    // Save raw content (with think tags) for debugging
    await cache.savePart(response.content, 0);
    this.ctx.logger?.info(`[regenerateOutline] Raw LLM output saved, length: ${response.content.length}`);

    // Filter think tags when parsing
    const filteredContent = cache.filterThinkingTags(response.content);

    // Check if content is truncated
    if (cache.isContentTruncated(response.content)) {
      this.ctx.logger?.warn(`[regenerateOutline] Content may be truncated. Consider reducing target chapters or increasing maxTokens.`);
    }

    return this.parseSectionsRegenerate(filteredContent);
  }

  private parseSectionsRegenerate(content: string): ArchitectOutput {
    const cache = new LlmOutputCache(this.ctx.projectRoot);
    const parseResult = cache.parseSections(content);

    // Log available sections for debugging
    this.ctx.logger?.info(`[parseSectionsRegenerate] Available sections: ${Array.from(parseResult.sections.keys()).join(', ')}`);
    this.ctx.logger?.info(`[parseSectionsRegenerate] Filtered content preview: ${parseResult.filteredContent.slice(0, 500)}...`);

    const volumeOutline = cache.extractSection(parseResult, 'volume_outline', { required: false }) || "";
    const currentState = cache.extractSection(parseResult, 'current_state', { required: false }) || "";
    const pendingHooks = cache.extractSection(parseResult, 'pending_hooks', { required: false }) || "";

    // If any section is missing, try fallback extraction from raw content
    if (!volumeOutline || !currentState || !pendingHooks) {
      this.ctx.logger?.warn(`[parseSectionsRegenerate] Some sections missing, attempting fallback extraction`);

      // Try to extract sections using simple regex patterns
      const volumeOutlineMatch = content.match(/(?:volume_outline|卷纲)[\s\S]*?(?=(?:current_state|pending_hooks|当前状态|待填坑)|\s*$)/i);
      const currentStateMatch = content.match(/(?:current_state|当前状态)[\s\S]*?(?=(?:pending_hooks|待填坑)|\s*$)/i);
      const pendingHooksMatch = content.match(/(?:pending_hooks|待填坑)[\s\S]*?$/i);

      return {
        storyBible: "",
        volumeOutline: volumeOutline || volumeOutlineMatch?.[0] || "",
        bookRules: "",
        currentState: currentState || currentStateMatch?.[0] || "",
        pendingHooks: pendingHooks || pendingHooksMatch?.[0] || "",
      };
    }

    return {
      storyBible: "", // Not regenerated, will be ignored by caller
      volumeOutline,
      bookRules: "", // Not regenerated, will be ignored by caller
      currentState,
      pendingHooks,
    };
  }
}
