/**
 * Staged Foundation Generation
 * 
 * Generates foundation in multiple stages to ensure consistency:
 * 1. Story Bible (core world-building and characters)
 * 2. Volume Outline (based on story bible)
 * 3. Book Rules (based on story bible)
 * 4. Current State (based on story bible)
 * 5. Pending Hooks (based on all above)
 * 
 * Each stage receives the output of previous stages as context.
 */

import { ArchitectAgent, type ArchitectOutput } from "./architect.js";
import type { BookConfig } from "../models/book.js";
import { readGenreProfile } from "./rules-reader.js";
import { LlmOutputCache } from "../utils/llm-output-cache.js";

interface StagedGenerationContext {
  storyBible?: string;
  volumeOutline?: string;
  bookRules?: string;
  currentState?: string;
  pendingHooks?: string;
}

export class StagedArchitectAgent extends ArchitectAgent {
  /**
   * Generate foundation in stages to ensure consistency
   */
  async generateFoundationStaged(
    book: BookConfig,
    externalContext?: string,
    reviewFeedback?: string,
  ): Promise<ArchitectOutput> {
    const ctx: StagedGenerationContext = {};
    const cache = new LlmOutputCache(this.ctx.projectRoot);
    await cache.initialize();

    this.ctx.logger?.info("[generateFoundationStaged] Starting staged generation...");

    // Stage 1: Generate Story Bible (core foundation)
    this.ctx.logger?.info("[generateFoundationStaged] Stage 1: Generating Story Bible...");
    ctx.storyBible = await this.generateStoryBible(book, externalContext, reviewFeedback);
    await cache.savePart(`=== STAGE 1: STORY_BIBLE ===\n\n${ctx.storyBible}`, 0);

    // Stage 2: Generate Volume Outline (based on story bible)
    this.ctx.logger?.info("[generateFoundationStaged] Stage 2: Generating Volume Outline...");
    ctx.volumeOutline = await this.generateVolumeOutline(book, ctx.storyBible!);
    await cache.savePart(`=== STAGE 2: VOLUME_OUTLINE ===\n\n${ctx.volumeOutline}`, 1);

    // Stage 3: Generate Book Rules (based on story bible)
    this.ctx.logger?.info("[generateFoundationStaged] Stage 3: Generating Book Rules...");
    ctx.bookRules = await this.generateBookRules(book, ctx.storyBible!);
    await cache.savePart(`=== STAGE 3: BOOK_RULES ===\n\n${ctx.bookRules}`, 2);

    // Stage 4: Generate Current State (based on story bible)
    this.ctx.logger?.info("[generateFoundationStaged] Stage 4: Generating Current State...");
    ctx.currentState = await this.generateCurrentState(book, ctx.storyBible!);
    await cache.savePart(`=== STAGE 4: CURRENT_STATE ===\n\n${ctx.currentState}`, 3);

    // Stage 5: Generate Pending Hooks (based on all previous)
    this.ctx.logger?.info("[generateFoundationStaged] Stage 5: Generating Pending Hooks...");
    ctx.pendingHooks = await this.generatePendingHooks(book, ctx);
    await cache.savePart(`=== STAGE 5: PENDING_HOOKS ===\n\n${ctx.pendingHooks}`, 4);

    this.ctx.logger?.info("[generateFoundationStaged] All stages completed!");

    return {
      storyBible: ctx.storyBible!,
      volumeOutline: ctx.volumeOutline!,
      bookRules: ctx.bookRules!,
      currentState: ctx.currentState!,
      pendingHooks: ctx.pendingHooks!,
    };
  }

  /**
   * Stage 1: Generate Story Bible
   */
  private async generateStoryBible(
    book: BookConfig,
    externalContext?: string,
    reviewFeedback?: string,
  ): Promise<string> {
    const { profile: gp } = await readGenreProfile(this.ctx.projectRoot, book.genre);
    const resolvedLanguage = (book.language ?? gp.language) === "en" ? "en" : "zh";

    const systemPrompt = resolvedLanguage === "en"
      ? `You are a professional web-fiction architect. Your task is to generate the core world-building and character settings for a new ${gp.name} novel.

Requirements:
- Book Title: ${book.title}
- Platform: ${book.platform}
- Genre: ${gp.name}
- Target Chapters: ${book.targetChapters}

${externalContext ? `\n【Creative Brief】\n${externalContext}\n` : ""}
${reviewFeedback ? `\n【Review Feedback】\n${reviewFeedback}\n` : ""}

Please generate the following content:

1. World-building (power system, core mechanics, world rules)
2. Protagonist setup (name, identity, personality, advantage/golden finger)
3. Important supporting characters (antagonists, allies, mentors, etc.)
4. Faction distribution (sects, families, organizations, etc.)
5. Geography and environment (key scenes)
6. Title and blurb

### Format Requirements (Strict)
- Use structured second-level headings: ## 01_Worldview, ## 02_Protagonist, etc.
- Use simple Markdown format only: headings, lists, tables
- DO NOT use decorative symbols like: ┌─┐│└┘═║╔╗╚╝╠╣╦╩╬
- DO NOT use ASCII art or box-drawing characters
- DO NOT use emoji or special Unicode symbols for decoration
- Keep the format clean and readable

### Title Methodology
- Keep the title clear, direct, and easy to understand
- Use a format that immediately signals genre and core appeal
- Avoid overly literary or misleading titles

### Blurb Methodology (within 300 words, choose one):
1. Open with conflict, then reveal the hook, then leave suspense
2. Summarize only the main line and keep a clear suspense gap
3. Use a miniature scene that captures the book's strongest pull

Core blurb principle:
- The blurb is product copy that must make readers want to click

Notes:
- Once the protagonist's name is determined, all subsequent content must use this name
- The power system must be clear and consistent
- All settings must have clear boundaries and costs`
      : `你是一个专业的网络小说架构师。你的任务是为一本新的${gp.name}小说生成核心世界观和人物设定。

要求：
- 书名：${book.title}
- 平台：${book.platform}
- 题材：${gp.name}
- 目标章数：${book.targetChapters}章

${externalContext ? `\n【创作简报】\n${externalContext}\n` : ""}
${reviewFeedback ? `\n【审核反馈】\n${reviewFeedback}\n` : ""}

请生成以下内容：

1. 世界观设定（力量体系、核心机制、世界规则）
2. 主角设定（姓名、身份、性格、金手指）
3. 重要配角（反派、盟友、导师等）
4. 势力分布（宗门、家族、组织等）
5. 地理与环境（关键场景）
6. 书名与简介

### 格式要求（严格遵守）
- 使用结构化二级标题：## 01_世界观、## 02_主角 等
- 仅使用简单Markdown格式：标题、列表、表格
- 禁止使用装饰性符号如：┌─┐│└┘═║╔╗╚╝╠╣╦╩╬
- 禁止使用ASCII艺术或制表符边框
- 禁止使用emoji或特殊Unicode符号作为装饰
- 保持格式简洁清晰

### 书名方法论
- 书名必须简单扼要、通俗易懂，读者看到书名就能知道题材和主题
- 采用"题材+核心爽点+主角行为"的长书名格式，避免文艺化
- 融入平台当下热点词汇，吸引精准流量
- 禁止题材错位（都市文取玄幻书名会导致读者流失）
- 参考热榜书名风格：俏皮、通俗、有记忆点

### 简介方法论（300字内，三种写法任选其一）：
1. 冲突开篇法：第一句抛困境/冲突，第二句亮金手指/核心能力，第三句留悬念
2. 高度概括法：只挑主线概括（不是全篇概括），必须留悬念
3. 小剧场法：提炼故事中最经典的桥段，作为引子

简介核心原则：
- 简介 = 产品宣传语，必须让读者产生"我要点开看"的冲动
- 可以从剧情设定、人设、或某个精彩片段切入
- 必须有噱头（如"凡是被写在笔记本上的名字，最后都得死"）

注意：
- 主角姓名一旦确定，后续所有内容必须使用此姓名
- 力量体系必须明确且一致
- 所有设定必须有明确的边界和代价`;

    const userMessage = resolvedLanguage === "en"
      ? `Generate the story bible for "${book.title}".`
      : `请为《${book.title}》生成故事圣经（核心设定）。`;

    const response = await this.chat([
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ], { maxTokens: 8000, temperature: 0.8 });

    return response.content;
  }

  /**
   * Stage 2: Generate Volume Outline
   */
  private async generateVolumeOutline(
    book: BookConfig,
    storyBible: string,
  ): Promise<string> {
    const { profile: gp } = await readGenreProfile(this.ctx.projectRoot, book.genre);
    const resolvedLanguage = (book.language ?? gp.language) === "en" ? "en" : "zh";

    const systemPrompt = resolvedLanguage === "en"
      ? `You are a professional web-fiction architect. Your task is to generate the volume outline based on the established story bible.

【Established Core Settings】
${storyBible}

Requirements:
- Book Title: ${book.title}
- Target Chapters: ${book.targetChapters}
- Chapter Length: ${book.chapterWordCount} words

Generate the following content:

1. Overall volume plan (volume breakdown)
2. Detailed chapter planning for Volume 1 (first 50 chapters)
   - Label each chapter type (battle/info/transition/climax/hook)
   - Specify conflict density and pacing
   - Mark key turning points and payoff moments
3. Key turning points explanation
4. Payoff goals checklist

### Format Requirements (Strict)
- Use simple Markdown format only: headings, lists, tables
- DO NOT use decorative symbols like: ┌─┐│└┘═║╔╗╚╝╠╣╦╩╬
- DO NOT use ASCII art or box-drawing characters
- DO NOT use emoji or special Unicode symbols for decoration
- Keep the format clean and readable

### Golden First Three Chapters Rule
- Chapter 1: throw the core conflict immediately; no large background dump
- Chapter 2: show the core edge / ability / leverage that answers Chapter 1's pressure
- Chapter 3: establish the first concrete short-term goal that gives readers a reason to continue

Notes:
- Must strictly follow the story bible settings
- Protagonist name, power system, and faction distribution must be completely consistent with the story bible
- Conflict design must match the protagonist's personality`
      : `你是一个专业的网络小说架构师。你的任务是基于已有设定生成卷纲。

【已确定的核心设定】
${storyBible}

要求：
- 书名：${book.title}
- 目标章数：${book.targetChapters}章
- 每章字数：${book.chapterWordCount}字

请生成以下内容：

1. 全书卷纲总览（分卷规划）
2. 第一卷详细章节规划（前50章）
   - 每章标注类型（战斗/信息/过渡/高潮/钩子）
   - 明确冲突密度和节奏
   - 标注关键转折点和爽点
3. 关键转折点说明
4. 收益目标清单

### 格式要求（严格遵守）
- 仅使用简单Markdown格式：标题、列表、表格
- 禁止使用装饰性符号如：┌─┐│└┘═║╔╗╚╝╠╣╦╩╬
- 禁止使用ASCII艺术或制表符边框
- 禁止使用emoji或特殊Unicode符号作为装饰
- 保持格式简洁清晰

### 黄金三章法则（前三章必须遵循）
- 第1章：抛出核心冲突（主角立即面临困境/危机/选择），禁止大段背景灌输
- 第2章：展示金手指/核心能力（主角如何应对第1章的困境），让读者看到爽点预期
- 第3章：明确短期目标（主角确立第一个具体可达成的目标），给读者追读理由

注意：
- 必须严格遵循故事圣经中的设定
- 主角姓名、力量体系、势力分布必须与故事圣经完全一致
- 冲突设计必须符合主角性格设定`;

    const userMessage = resolvedLanguage === "en"
      ? `Generate the volume outline based on the story bible above.`
      : `请基于上述故事圣经生成卷纲。`;

    const response = await this.chat([
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ], { maxTokens: 8000, temperature: 0.8 });

    return response.content;
  }

  /**
   * Stage 3: Generate Book Rules
   */
  private async generateBookRules(
    book: BookConfig,
    storyBible: string,
  ): Promise<string> {
    const { profile: gp } = await readGenreProfile(this.ctx.projectRoot, book.genre);
    const resolvedLanguage = (book.language ?? gp.language) === "en" ? "en" : "zh";

    const systemPrompt = `你是一个专业的网络小说架构师。你的任务是基于已有设定生成书籍规则。

【已确定的核心设定】
${storyBible}

请生成以下规则文档：

1. 主角锁定（姓名、性格锁定、行为约束）
2. 题材锁定（禁止混入的文风）
3. 数值系统覆盖（资源类型、上限设定）
4. 禁忌事项（写作红线）
5. 章节类型定义
6. 疲劳词汇列表
7. 额外审核维度

注意：
- 主角姓名必须与故事圣经中完全一致
- 性格锁定必须与故事圣经中描述一致
- 数值系统必须与故事圣经中的力量体系一致`;

    const userMessage = resolvedLanguage === "en"
      ? `Generate the book rules based on the story bible above.`
      : `请基于上述故事圣经生成书籍规则。`;

    const response = await this.chat([
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ], { maxTokens: 6000, temperature: 0.8 });

    return response.content;
  }

  /**
   * Stage 4: Generate Current State
   */
  private async generateCurrentState(
    book: BookConfig,
    storyBible: string,
  ): Promise<string> {
    const { profile: gp } = await readGenreProfile(this.ctx.projectRoot, book.genre);
    const resolvedLanguage = (book.language ?? gp.language) === "en" ? "en" : "zh";

    const systemPrompt = `你是一个专业的网络小说架构师。你的任务是基于已有设定生成初始状态卡。

【已确定的核心设定】
${storyBible}

请生成以下内容（Markdown表格格式）：

| 字段 | 值 |
|------|-----|
| 当前章节 | 0 |
| 主角姓名 | （必须与故事圣经一致）|
| 主角身份 | （必须与故事圣经一致）|
| 初始状态 | （开书时的处境）|
| 修为境界 | （必须与故事圣经一致）|
| 能力/金手指 | （必须与故事圣经一致）|
| 所属势力 | （必须与故事圣经一致）|
| 师父 | （如有）|
| 出身 | （必须与故事圣经一致）|
| 起始地点 | （必须与故事圣经一致）|
| 核心规则 | （当前面临的主要规则约束）|
| 当前位面 | （世界名称）|
| 力量体系 | （必须与故事圣经一致）|
| 势力分布 | （必须与故事圣经一致）|
| 当前目标 | （开书时的短期目标）|
| 初始冲突 | （开书时的核心矛盾）|
| 修炼路径 | （必须与故事圣经一致）|
| 修炼资源 | （开书时的资源状况）|
| 敌对势力 | （开书时的主要敌人）|

注意：
- 所有字段必须与故事圣经完全一致
- 主角姓名、修为、能力等关键信息不能有任何偏差`;

    const userMessage = resolvedLanguage === "en"
      ? `Generate the current state card based on the story bible above.`
      : `请基于上述故事圣经生成初始状态卡。`;

    const response = await this.chat([
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ], { maxTokens: 4000, temperature: 0.8 });

    return response.content;
  }

  /**
   * Stage 5: Generate Pending Hooks
   */
  private async generatePendingHooks(
    book: BookConfig,
    ctx: StagedGenerationContext,
  ): Promise<string> {
    const { profile: gp } = await readGenreProfile(this.ctx.projectRoot, book.genre);
    const resolvedLanguage = (book.language ?? gp.language) === "en" ? "en" : "zh";

    const systemPrompt = resolvedLanguage === "en"
      ? `You are a professional web-fiction architect. Your task is to generate the initial hook pool based on established settings.

【Established Core Settings】
${ctx.storyBible}

【Established Volume Outline】
${ctx.volumeOutline}

Generate initial hook pool (Markdown table):
| hook_id | start_chapter | type | status | last_advanced_chapter | expected_payoff | payoff_timing | notes |

### Format Requirements (Strict)
- Use simple Markdown table format only
- DO NOT use decorative symbols like: ┌─┐│└┘═║╔╗╚╝╠╣╦╩╬
- DO NOT use ASCII art or box-drawing characters
- DO NOT use emoji or special Unicode symbols for decoration
- Keep the format clean and readable

### Hook Table Rules:
- Column 5 must be a pure chapter number, never natural-language description
- During book creation, all planned hooks are still unapplied, so last_advanced_chapter = 0
- Column 7 must be one of: immediate / near-term / mid-arc / slow-burn / endgame
- If you want to describe the initial clue/signal, put it in notes instead of column 5

Notes:
- Hooks must be consistent with settings in story bible and volume outline
- Hooks must cover main characters, key items, and core rules
- Expected payoff chapters must match the volume outline planning`
      : `你是一个专业的网络小说架构师。你的任务是基于已有设定生成初始伏笔池。

【已确定的核心设定】
${ctx.storyBible}

【已确定的卷纲】
${ctx.volumeOutline}

生成初始伏笔池（Markdown表格）：
| hook_id | 起始章节 | 类型 | 状态 | 最近推进 | 预期回收 | 回收节奏 | 备注 |

### 格式要求（严格遵守）
- 仅使用简单Markdown表格格式
- 禁止使用装饰性符号如：┌─┐│└┘═║╔╗╚╝╠╣╦╩╬
- 禁止使用ASCII艺术或制表符边框
- 禁止使用emoji或特殊Unicode符号作为装饰
- 保持格式简洁清晰

### 伏笔表规则：
- 第5列必须是纯数字章节号，不能写自然语言描述
- 建书阶段所有伏笔都还没正式推进，所以第5列统一填 0
- 第7列必须填写：立即 / 近期 / 中程 / 慢烧 / 终局 之一
- 如果要说明"初始线索/最初信号"，写进备注，不要写进第5列

注意：
- 伏笔必须与故事圣经和卷纲中的设定一致
- 伏笔必须覆盖主要角色、关键物品、核心规则
- 预期回收章节必须与卷纲规划匹配`;

    const userMessage = resolvedLanguage === "en"
      ? `Generate the initial hook pool based on the materials above.`
      : `请基于上述材料生成初始伏笔池。`;

    const response = await this.chat([
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ], { maxTokens: 6000, temperature: 0.8 });

    return response.content;
  }
}
