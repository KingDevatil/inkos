/**
 * State Dimensions Management
 * 
 * Provides genre-aware state dimensions for current_state.md generation.
 * Combines hardcoded default dimensions with LLM-extracted custom dimensions.
 */

import type { GenreProfile } from "../models/genre-profile.js";

export interface StateDimension {
  readonly category: string;
  readonly fields: ReadonlyArray<{
    readonly key: string;
    readonly label: string;
    readonly description?: string;
  }>;
}

// Default dimensions for all genres
const DEFAULT_DIMENSIONS: StateDimension[] = [
  {
    category: "protagonist",
    fields: [
      { key: "name", label: "主角姓名", description: "主角的完整姓名" },
      { key: "identity", label: "主角身份", description: "主角的社会身份/职业" },
      { key: "initial_state", label: "初始状态", description: "主角开书时的处境" },
    ],
  },
  {
    category: "world",
    fields: [
      { key: "location", label: "起始地点", description: "故事开始的主要地点" },
      { key: "world_rules", label: "核心规则", description: "影响前期的重要世界规则" },
    ],
  },
  {
    category: "progression",
    fields: [
      { key: "current_goal", label: "当前目标", description: "主角的第一个具体目标" },
      { key: "initial_conflict", label: "初始冲突", description: "开书时的核心矛盾" },
    ],
  },
];

// Genre-specific dimension extensions
const GENRE_DIMENSIONS: Record<string, StateDimension[]> = {
  urban: [
    {
      category: "protagonist",
      fields: [
        { key: "age", label: "年龄", description: "主角年龄" },
        { key: "company", label: "公司/单位", description: "所在公司或工作单位" },
        { key: "position", label: "职位", description: "职务/岗位" },
        { key: "financial_status", label: "经济状况", description: "资产、收入等级" },
        { key: "social_network", label: "关键人脉", description: "重要人际关系" },
      ],
    },
    {
      category: "world",
      fields: [
        { key: "era", label: "年代", description: "故事发生的具体年代" },
        { key: "industry", label: "行业", description: "主角所在行业" },
        { key: "city", label: "城市", description: "故事发生城市" },
      ],
    },
  ],
  xuanhuan: [
    {
      category: "protagonist",
      fields: [
        { key: "cultivation_level", label: "修为境界", description: "当前修炼等级" },
        { key: "abilities", label: "能力/金手指", description: "特殊能力或金手指" },
        { key: "sect", label: "所属势力", description: "宗门/家族/势力" },
        { key: "master", label: "师父", description: "导师或引路人" },
        { key: "background", label: "出身", description: "家族背景/出身" },
      ],
    },
    {
      category: "world",
      fields: [
        { key: "realm", label: "当前位面", description: "所在世界/位面/地图" },
        { key: "power_system", label: "力量体系", description: "修炼体系规则" },
        { key: "factions", label: "势力分布", description: "主要势力格局" },
      ],
    },
    {
      category: "progression",
      fields: [
        { key: "cultivation_path", label: "修炼路径", description: "主角的修炼方向" },
        { key: "resources", label: "修炼资源", description: "可用的修炼资源" },
        { key: "enemies", label: "敌对势力", description: "主要敌人或对手" },
      ],
    },
  ],
  xianxia: [
    {
      category: "protagonist",
      fields: [
        { key: "cultivation_level", label: "修为境界", description: "当前仙道境界" },
        { key: "spiritual_root", label: "灵根", description: "灵根属性/品质" },
        { key: "sect", label: "所属门派", description: "修仙门派" },
        { key: "master", label: "师承", description: "师父/师门" },
        { key: "magical_treasures", label: "法宝", description: "拥有的法器/法宝" },
        { key: "spirit_pet", label: "灵宠", description: "契约灵宠" },
      ],
    },
    {
      category: "world",
      fields: [
        { key: "realm", label: "当前界域", description: "人界/灵界/仙界等" },
        { key: "cultivation_system", label: "修仙体系", description: "境界划分规则" },
        { key: "immortal_forces", label: "仙门势力", description: "各大仙门分布" },
      ],
    },
  ],
  "sci-fi": [
    {
      category: "protagonist",
      fields: [
        { key: "identity", label: "身份", description: "职业/军衔/身份编号" },
        { key: "equipment", label: "装备", description: "高科技装备/义体" },
        { key: "skills", label: "技能", description: "专业技能/战斗技能" },
        { key: "faction", label: "所属阵营", description: "国家/组织/公司" },
      ],
    },
    {
      category: "world",
      fields: [
        { key: "era", label: "年代", description: "具体年份/纪元" },
        { key: "tech_level", label: "科技水平", description: "科技发展程度" },
        { key: "location", label: "地点", description: "星球/空间站/城市" },
        { key: "political_landscape", label: "政治格局", description: "势力分布/政治体制" },
      ],
    },
  ],
  isekai: [
    {
      category: "protagonist",
      fields: [
        { key: "original_world", label: "原世界身份", description: "穿越前的身份" },
        { key: "new_identity", label: "异世界身份", description: "穿越后的身份" },
        { key: "cheat_ability", label: "外挂能力", description: "穿越带来的特殊能力" },
        { key: "companions", label: "同伴", description: "初始同伴/召唤物" },
      ],
    },
    {
      category: "world",
      fields: [
        { key: "world_type", label: "世界类型", description: "魔法/游戏/修仙等" },
        { key: "world_rules", label: "世界规则", description: "异世界特殊规则" },
        { key: "starting_location", label: "起始地点", description: "穿越后的初始位置" },
      ],
    },
  ],
  "system-apocalypse": [
    {
      category: "protagonist",
      fields: [
        { key: "system_abilities", label: "系统能力", description: "末日系统赋予的能力" },
        { key: "survival_skills", label: "生存技能", description: "战斗/生存技能" },
        { key: "team_members", label: "团队成员", description: "初始团队成员" },
      ],
    },
    {
      category: "world",
      fields: [
        { key: "apocalypse_type", label: "末日类型", description: "丧尸/天灾/异兽等" },
        { key: "safe_zone", label: "安全区", description: "当前安全区域" },
        { key: "resources", label: "生存物资", description: "食物/水/武器等" },
        { key: "threats", label: "威胁", description: "主要危险来源" },
      ],
    },
  ],
  litrpg: [
    {
      category: "protagonist",
      fields: [
        { key: "game_class", label: "职业", description: "游戏职业/职业" },
        { key: "level", label: "等级", description: "当前等级" },
        { key: "stats", label: "属性", description: "主要属性值" },
        { key: "skills", label: "技能", description: "已学技能" },
        { key: "equipment", label: "装备", description: "当前装备" },
        { key: "guild", label: "公会", description: "所属公会/队伍" },
      ],
    },
    {
      category: "world",
      fields: [
        { key: "game_world", label: "游戏世界", description: "游戏名称/世界" },
        { key: "game_mechanics", label: "游戏机制", description: "核心游戏规则" },
        { key: "starting_area", label: "起始区域", description: "新手村/起始地图" },
      ],
    },
  ],
  cozy: [
    {
      category: "protagonist",
      fields: [
        { key: "occupation", label: "职业", description: "主角职业/身份" },
        { key: "personality", label: "性格", description: "性格特点" },
        { key: "daily_routine", label: "日常", description: "日常生活状态" },
      ],
    },
    {
      category: "world",
      fields: [
        { key: "setting", label: "场景", description: "小镇/店铺/家园" },
        { key: "community", label: "社群", description: "邻里/社区关系" },
        { key: "atmosphere", label: "氛围", description: "温馨/治愈/慢节奏" },
      ],
    },
  ],
  horror: [
    {
      category: "protagonist",
      fields: [
        { key: "mental_state", label: "精神状态", description: "初始心理状态" },
        { key: "vulnerabilities", label: "弱点", description: "恐惧/弱点" },
        { key: "connections", label: "人际关系", description: "与他人的联系" },
      ],
    },
    {
      category: "world",
      fields: [
        { key: "horror_element", label: "恐怖要素", description: "鬼怪/克苏鲁/心理等" },
        { key: "setting", label: "场景", description: "鬼屋/小镇/异空间" },
        { key: "threat_level", label: "威胁等级", description: "初始危险程度" },
      ],
    },
  ],
};

/**
 * Get state dimensions for a genre
 * Combines default dimensions with genre-specific dimensions
 */
export function getStateDimensions(genreId: string): StateDimension[] {
  const genreSpecific = GENRE_DIMENSIONS[genreId] ?? [];
  
  // Merge default with genre-specific, with genre-specific taking precedence
  const merged = new Map<string, StateDimension>();
  
  // Add defaults first
  for (const dim of DEFAULT_DIMENSIONS) {
    merged.set(dim.category, dim);
  }
  
  // Merge genre-specific dimensions
  for (const dim of genreSpecific) {
    if (merged.has(dim.category)) {
      // Merge fields within the same category
      const existing = merged.get(dim.category)!;
      const existingKeys = new Set(existing.fields.map(f => f.key));
      const newFields = dim.fields.filter(f => !existingKeys.has(f.key));
      merged.set(dim.category, {
        category: dim.category,
        fields: [...existing.fields, ...newFields],
      });
    } else {
      merged.set(dim.category, dim);
    }
  }
  
  return Array.from(merged.values());
}

/**
 * Build current state prompt with hardcoded dimensions
 * Includes instruction for LLM to extract additional dimensions
 */
export function buildCurrentStatePrompt(
  genreProfile: GenreProfile,
  language: "zh" | "en"
): string {
  const dimensions = getStateDimensions(genreProfile.id);
  
  // Build dimension fields table
  const dimensionRows = dimensions
    .flatMap(d => d.fields)
    .map(f => {
      const desc = f.description ? ` (${f.description})` : "";
      return language === "en"
        ? `| ${f.label}${desc} | (from story_bible) |`
        : `| ${f.label}${desc} | (从story_bible提取) |`;
    })
    .join("\n");

  const baseInstruction = language === "en"
    ? `Initial state card (Chapter 0). Fill ALL fields by extracting from story_bible:

| Field | Value |
| --- | --- |
| Current Chapter | 0 |
${dimensionRows}

CRITICAL REQUIREMENTS:
1. Extract ALL protagonist attributes from story_bible (name, identity, abilities, etc.)
2. Extract starting world state, location, and key rules
3. Extract initial relationships, factions, and possessions
4. Identify any OTHER important dimensions specific to this story and add them
5. Be SPECIFIC - no vague descriptions like "strong" or "mysterious"`
    : `初始状态卡（第0章）。从story_bible中提取并填写所有字段：

| 字段 | 值 |
|------|-----|
| 当前章节 | 0 |
${dimensionRows}

重要要求：
1. 从story_bible中提取主角的所有属性（姓名、身份、能力等）
2. 提取世界观初始状态、地点和关键规则
3. 提取起始时的人物关系、所属势力、持有物品
4. 识别本故事特有的其他重要维度并添加
5. 必须具体明确 - 禁止模糊描述如"很强"、"神秘"等`;

  return baseInstruction;
}

/**
 * Build current state prompt for continuation/import mode
 * Uses existing chapters to derive state
 */
export function buildContinuationStatePrompt(
  genreProfile: GenreProfile,
  language: "zh" | "en",
  latestChapter: number
): string {
  const dimensions = getStateDimensions(genreProfile.id);
  
  const dimensionRows = dimensions
    .flatMap(d => d.fields)
    .map(f => {
      const desc = f.description ? ` (${f.description})` : "";
      return language === "en"
        ? `| ${f.label}${desc} | (from latest chapter) |`
        : `| ${f.label}${desc} | (从最新章节提取) |`;
    })
    .join("\n");

  return language === "en"
    ? `Current state card at end of Chapter ${latestChapter}:

| Field | Value |
| --- | --- |
| Current Chapter | ${latestChapter} |
${dimensionRows}

Extract the state from the latest chapter content. Include any new dimensions that emerged in the story.`
    : `第${latestChapter}章结束时的当前状态卡：

| 字段 | 值 |
|------|-----|
| 当前章节 | ${latestChapter} |
${dimensionRows}

从最新章节内容中提取状态。包含故事中出现的任何新维度。`;
}
