# 系统流/网游流/数据流小说数据存储扩展设计方案

## 1. 设计目标

为系统流、网游流、数据流等类型小说提供标准化的角色数据、面板属性、技能系统、物品装备等扩展数据存储能力，使 InkOS 能够更好地支持这类小说的创作和管理。

## 2. 核心概念

### 2.1 小说类型标识
在书籍配置中增加类型标识，用于启用不同的数据扩展模块：

```typescript
// BookConfig 扩展
export const BookGenreTypeSchema = z.enum([
  "general",      // 常规小说
  "system",       // 系统流
  "mmo",          // 网游流
  "data",         // 数据流
  "cultivation",  // 修真流（可扩展）
]);
```

### 2.2 数据存储架构

采用**模块化存储**设计，核心数据仍存储于原有文件体系，扩展数据存储于独立的 JSON/Markdown 文件中：

```
books/
├── {book-id}/
│   ├── book.json                 # 书籍配置（扩展 genreType 字段）
│   ├── story_bible.md           # 故事圣经
│   ├── volume_outline.md        # 卷纲
│   ├── current_state.md         # 当前状态
│   ├── pending_hooks.md         # 待埋伏笔
│   ├── book_rules.md            # 书籍规则
│   │
│   ├── extensions/              # 扩展数据目录（新增）
│   │   ├── characters/          # 角色数据
│   │   │   ├── index.json       # 角色索引
│   │   │   ├── {char-id}.json   # 单个角色完整数据
│   │   │   └── {char-id}.md     # 角色背景故事（可选）
│   │   ├── system/              # 系统配置（系统流）
│   │   │   ├── config.json      # 系统基础配置
│   │   │   ├── panels/          # 面板模板
│   │   │   └── logs/            # 系统日志
│   │   ├── skills/              # 技能数据库
│   │   │   ├── index.json       # 技能索引
│   │   │   ├── categories.json  # 技能分类
│   │   │   └── {skill-id}.json  # 单个技能详情
│   │   ├── items/               # 物品装备库
│   │   │   ├── index.json       # 物品索引
│   │   │   ├── categories.json  # 物品分类
│   │   │   └── {item-id}.json   # 单个物品详情
│   │   ├── factions/            # 势力/公会数据（网游流）
│   │   ├── quests/              # 任务系统（网游流）
│   │   └── instances/           # 副本/地图数据（网游流）
│   │
│   └── chapters/                # 章节内容
```

## 3. 数据模型设计

### 3.1 角色扩展数据模型

```typescript
// extensions/characters/types.ts

// 角色基础信息（与原有角色系统兼容）
export const CharacterBaseSchema = z.object({
  id: z.string(),
  name: z.string(),
  aliases: z.array(z.string()).default([]),
  gender: z.enum(["male", "female", "unknown"]).optional(),
  age: z.number().optional(),
  description: z.string(),
  role: z.enum(["protagonist", "supporting", "antagonist", "npc", "system"]),
  importance: z.enum(["main", "major", "minor", "background"]),
  firstAppearance: z.number().int().min(1), // 首次出现章节
  status: z.enum(["alive", "dead", "missing", "unknown"]).default("alive"),
  tags: z.array(z.string()).default([]),
});

// 属性系统（数据流/系统流）
export const AttributeSchema = z.object({
  id: z.string(),
  name: z.string(),
  category: z.enum([
    "basic",      // 基础属性：力量、敏捷、智力等
    "combat",     // 战斗属性：攻击力、防御力、暴击率等
    "special",    // 特殊属性：幸运、魅力、感知等
    "custom",     // 自定义属性
  ]),
  value: z.union([z.number(), z.string()]),
  maxValue: z.number().optional(),
  minValue: z.number().optional(),
  unit: z.string().optional(), // 单位，如 %、点、级
  description: z.string().optional(),
  visible: z.boolean().default(true), // 是否对角色可见
  editable: z.boolean().default(true), // 是否可修改
  source: z.string().optional(), // 属性来源
});

// 角色面板（系统流核心）
export const CharacterPanelSchema = z.object({
  characterId: z.string(),
  panelType: z.enum([
    "system",     // 系统面板
    "status",     // 状态面板
    "combat",     // 战斗面板
    "profession", // 职业面板
    "custom",     // 自定义面板
  ]),
  level: z.object({
    current: z.number().int().min(1),
    max: z.number().int().optional(),
    title: z.string().optional(), // 等级称号
    exp: z.object({
      current: z.number(),
      required: z.number(),
    }).optional(),
  }).optional(),
  attributes: z.array(AttributeSchema).default([]),
  stats: z.object({
    hp: z.object({ current: z.number(), max: z.number() }).optional(),
    mp: z.object({ current: z.number(), max: z.number() }).optional(),
    stamina: z.object({ current: z.number(), max: z.number() }).optional(),
    custom: z.record(z.string(), z.number()).optional(),
  }).optional(),
  derivedStats: z.record(z.string(), z.number()).optional(), // 衍生属性
  buffs: z.array(z.object({
    id: z.string(),
    name: z.string(),
    type: z.enum(["buff", "debuff", "neutral"]),
    duration: z.union([z.number(), z.literal("permanent")]),
    effects: z.array(z.string()),
    source: z.string(),
    stackable: z.boolean().default(false),
    stacks: z.number().int().default(1),
  })).default([]),
  lastUpdated: z.string().datetime(),
});

// 角色完整数据
export const CharacterDataSchema = z.object({
  base: CharacterBaseSchema,
  panels: z.array(CharacterPanelSchema).default([]),
  skills: z.array(z.object({
    skillId: z.string(),
    level: z.number().int().min(1).default(1),
    exp: z.number().default(0),
    acquiredAt: z.number().int(), // 章节号
    proficiency: z.enum(["novice", "practiced", "proficient", "master", "grandmaster"]).default("novice"),
    cooldown: z.number().default(0), // 冷却回合/时间
    isActive: z.boolean().default(true),
    notes: z.string().optional(),
  })).default([]),
  inventory: z.object({
    capacity: z.number().int().default(20),
    items: z.array(z.object({
      itemId: z.string(),
      quantity: z.number().int().min(1).default(1),
      slot: z.number().int().optional(), // 背包位置
      equipped: z.boolean().default(false),
      bound: z.boolean().default(false), // 是否绑定
      durability: z.object({
        current: z.number(),
        max: z.number(),
      }).optional(),
      acquiredAt: z.number().int(),
      notes: z.string().optional(),
    })).default([]),
    currency: z.record(z.string(), z.number()).default({}), // 各种货币
  }).optional(),
  equipment: z.record(z.string(), z.string()).optional(), // 装备槽位 -> 物品ID
  relationships: z.array(z.object({
    targetId: z.string(),
    type: z.enum([
      "friend", "enemy", "neutral", "family", "master", "disciple",
      "lover", "rival", "ally", "subordinate", "leader"
    ]),
    level: z.number().min(-100).max(100).default(0), // 好感度/关系值
    description: z.string().optional(),
    history: z.array(z.object({
      chapter: z.number().int(),
      event: z.string(),
      delta: z.number(),
    })).default([]),
  })).default([]),
  achievements: z.array(z.object({
    id: z.string(),
    name: z.string(),
    unlockedAt: z.number().int(),
    description: z.string(),
    rewards: z.array(z.string()).optional(),
  })).default([]),
  history: z.array(z.object({
    chapter: z.number().int(),
    type: z.enum([
      "level_up", "skill_acquired", "skill_leveled", "item_acquired",
      "item_lost", "attribute_changed", "status_changed", "relationship_changed",
      "panel_unlocked", "achievement_unlocked"
    ]),
    description: z.string(),
    data: z.record(z.unknown()).optional(), // 详细变化数据
  })).default([]),
});
```

### 3.2 技能系统模型

```typescript
// extensions/skills/types.ts

export const SkillSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  category: z.enum([
    "combat",       // 战斗技能
    "magic",        // 魔法技能
    "crafting",     // 制造技能
    "gathering",    // 采集技能
    "social",       // 社交技能
    "passive",      // 被动技能
    "active",       // 主动技能
    "ultimate",     // 终极技能
    "system",       // 系统技能
    "custom",       // 自定义
  ]),
  subcategory: z.string().optional(),
  rarity: z.enum(["common", "uncommon", "rare", "epic", "legendary", "mythic"]).default("common"),
  
  // 等级系统
  maxLevel: z.number().int().min(1).default(1),
  levelScaling: z.object({
    description: z.string(),
    effects: z.array(z.object({
      level: z.number().int(),
      effect: z.string(),
      value: z.union([z.number(), z.string()]).optional(),
    })),
  }).optional(),
  
  // 消耗与冷却
  cost: z.object({
    hp: z.number().default(0),
    mp: z.number().default(0),
    stamina: z.number().default(0),
    custom: z.record(z.string(), z.number()).default({}),
  }).default({}),
  cooldown: z.object({
    turns: z.number().int().optional(),
    seconds: z.number().optional(),
    global: z.boolean().default(false), // 是否触发全局冷却
  }).optional(),
  
  // 效果
  effects: z.array(z.object({
    type: z.enum([
      "damage", "heal", "buff", "debuff", "control", "summon",
      "teleport", "transform", "shield", "reflect", "drain"
    ]),
    target: z.enum(["self", "single", "aoe", "party", "enemy", "all"]),
    value: z.union([z.number(), z.string()]), // 数值或公式
    duration: z.number().optional(),
    conditions: z.array(z.string()).optional(),
  })).default([]),
  
  // 学习条件
  requirements: z.object({
    level: z.number().int().optional(),
    attributes: z.record(z.string(), z.number()).optional(),
    skills: z.array(z.object({
      skillId: z.string(),
      level: z.number().int().default(1),
    })).optional(),
    quests: z.array(z.string()).optional(),
    achievements: z.array(z.string()).optional(),
    custom: z.array(z.string()).optional(),
  }).optional(),
  
  // 视觉效果
  visual: z.object({
    icon: z.string().optional(),
    animation: z.string().optional(),
    sound: z.string().optional(),
  }).optional(),
  
  // 元数据
  tags: z.array(z.string()).default([]),
  source: z.string().optional(), // 来源：系统奖励、NPC传授、技能书等
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
```

### 3.3 物品装备模型

```typescript
// extensions/items/types.ts

export const ItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  category: z.enum([
    "weapon",       // 武器
    "armor",        // 防具
    "accessory",    // 饰品
    "consumable",   // 消耗品
    "material",     // 材料
    "quest",        // 任务物品
    "currency",     // 货币
    "skill_book",   // 技能书
    "blueprint",    // 图纸
    "pet",          // 宠物/召唤物
    "mount",        // 坐骑
    "housing",      // 家园物品
    "custom",       // 自定义
  ]),
  subcategory: z.string().optional(),
  rarity: z.enum(["common", "uncommon", "rare", "epic", "legendary", "mythic", "unique"]).default("common"),
  
  // 堆叠与绑定
  stackable: z.boolean().default(false),
  maxStack: z.number().int().min(1).default(1),
  bindOnAcquire: z.boolean().default(false),
  bindOnEquip: z.boolean().default(false),
  tradable: z.boolean().default(true),
  
  // 装备属性
  equippable: z.boolean().default(false),
  equipmentSlot: z.enum([
    "head", "body", "legs", "feet", "hands",
    "main_hand", "off_hand", "two_hands",
    "neck", "ring", "earring", "bracelet",
    "cape", "belt", "accessory"
  ]).optional(),
  levelRequirement: z.number().int().optional(),
  classRequirement: z.array(z.string()).optional(),
  
  // 属性加成
  attributes: z.record(z.string(), z.number()).default({}),
  stats: z.object({
    hp: z.number().optional(),
    mp: z.number().optional(),
    attack: z.number().optional(),
    defense: z.number().optional(),
    speed: z.number().optional(),
    crit: z.number().optional(),
    custom: z.record(z.string(), z.number()).optional(),
  }).optional(),
  
  // 特殊效果
  effects: z.array(z.object({
    type: z.string(),
    description: z.string(),
    trigger: z.enum(["equip", "use", "combat", "passive", "condition"]),
    value: z.union([z.number(), z.string()]).optional(),
  })).default([]),
  
  // 耐久度
  durability: z.object({
    max: z.number().int(),
    degradeRate: z.number().default(1), // 每次使用损耗
    repairable: z.boolean().default(true),
  }).optional(),
  
  // 使用次数
  uses: z.object({
    max: z.number().int(),
    current: z.number().int(),
    rechargeable: z.boolean().default(false),
  }).optional(),
  
  // 使用效果（消耗品）
  useEffect: z.object({
    description: z.string(),
    effects: z.array(z.string()),
    cooldown: z.number().optional(),
    castTime: z.number().optional(),
  }).optional(),
  
  // 合成/制造
  crafting: z.object({
    recipe: z.array(z.object({
      itemId: z.string(),
      quantity: z.number().int(),
    })),
    skillRequired: z.object({
      skillId: z.string(),
      level: z.number().int(),
    }).optional(),
    time: z.number().optional(), // 制造时间
    successRate: z.number().min(0).max(100).default(100),
  }).optional(),
  
  // 掉落信息
  dropInfo: z.array(z.object({
    source: z.string(), // 怪物/NPC/副本名称
    sourceType: z.enum(["monster", "boss", "npc", "instance", "quest", "event"]),
    dropRate: z.number().min(0).max(100),
    conditions: z.array(z.string()).optional(),
  })).optional(),
  
  // 价值
  value: z.object({
    buy: z.number().optional(),
    sell: z.number().optional(),
    currency: z.string().default("gold"),
  }).optional(),
  
  // 外观
  appearance: z.object({
    icon: z.string().optional(),
    model: z.string().optional(),
    effects: z.array(z.string()).optional(),
  }).optional(),
  
  // 元数据
  tags: z.array(z.string()).default([]),
  source: z.string().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
```

### 3.4 系统配置模型（系统流）

```typescript
// extensions/system/types.ts

export const SystemConfigSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  type: z.enum([
    "status",       // 状态面板系统
    "leveling",     // 升级系统
    "quest",        // 任务系统
    "crafting",     // 制造系统
    "trading",      // 交易系统
    "guild",        // 公会系统
    "pvp",          // PvP系统
    "achievement",  // 成就系统
    "gacha",        // 抽卡/抽奖系统
    "custom",       // 自定义系统
  ]),
  
  // 系统基础配置
  settings: z.record(z.unknown()),
  
  // 等级体系
  leveling: z.object({
    enabled: z.boolean().default(false),
    maxLevel: z.number().int(),
    expFormula: z.string(), // 经验值计算公式
    levelTitles: z.array(z.object({
      level: z.number().int(),
      title: z.string(),
      rewards: z.array(z.string()).optional(),
    })).optional(),
    statGrowth: z.record(z.string(), z.string()), // 每级属性成长
  }).optional(),
  
  // 任务系统
  questSystem: z.object({
    enabled: z.boolean().default(false),
    maxActiveQuests: z.number().int().default(10),
    dailyResetTime: z.string().optional(),
    questTypes: z.array(z.enum([
      "main", "side", "daily", "weekly", "event", "chain", "hidden"
    ])),
  }).optional(),
  
  // 成就系统
  achievementSystem: z.object({
    enabled: z.boolean().default(false),
    categories: z.array(z.object({
      id: z.string(),
      name: z.string(),
      description: z.string(),
    })),
    pointRewards: z.record(z.number(), z.array(z.string())), // 成就点数奖励
  }).optional(),
  
  // 商店系统
  shopSystem: z.object({
    enabled: z.boolean().default(false),
    refreshInterval: z.number().optional(), // 刷新间隔（小时）
    currencyTypes: z.array(z.string()),
    discountEvents: z.array(z.object({
      name: z.string(),
      discount: z.number().min(0).max(100),
      conditions: z.array(z.string()),
    })).optional(),
  }).optional(),
  
  // 惩罚机制
  penalties: z.object({
    death: z.object({
      expLoss: z.number().default(0), // 经验损失百分比
      itemDrop: z.boolean().default(false),
      respawnTime: z.number().default(0),
    }).optional(),
    pk: z.object({
      karmaSystem: z.boolean().default(false),
      penalties: z.array(z.string()).optional(),
    }).optional(),
  }).optional(),
  
  // 系统提示配置
  notifications: z.object({
    levelUp: z.boolean().default(true),
    skillAcquired: z.boolean().default(true),
    itemAcquired: z.boolean().default(true),
    questUpdate: z.boolean().default(true),
    achievementUnlocked: z.boolean().default(true),
    custom: z.record(z.boolean()).default({}),
  }).default({}),
  
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

// 系统日志（用于追踪系统事件）
export const SystemLogSchema = z.object({
  id: z.string(),
  timestamp: z.string().datetime(),
  chapter: z.number().int(),
  characterId: z.string().optional(),
  type: z.enum([
    "level_up", "exp_gain", "skill_acquired", "skill_level_up",
    "item_acquired", "item_used", "item_lost", "item_crafted",
    "quest_accepted", "quest_completed", "quest_failed",
    "achievement_unlocked", "system_message", "custom"
  ]),
  title: z.string(),
  description: z.string(),
  data: z.record(z.unknown()).optional(),
  relatedIds: z.array(z.string()).optional(), // 关联的技能/物品/任务ID
});
```

### 3.5 任务系统模型（网游流）

```typescript
// extensions/quests/types.ts

export const QuestSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  type: z.enum(["main", "side", "daily", "weekly", "event", "chain", "hidden"]),
  difficulty: z.enum(["easy", "normal", "hard", "extreme", "legendary"]).default("normal"),
  
  // 任务链
  chainInfo: z.object({
    chainId: z.string(),
    order: z.number().int(),
    isStart: z.boolean().default(false),
    isEnd: z.boolean().default(false),
    branches: z.array(z.string()).optional(), // 分支任务ID
  }).optional(),
  
  // 接取条件
  requirements: z.object({
    level: z.object({ min: z.number().int(), max: z.number().int().optional() }).optional(),
    class: z.array(z.string()).optional(),
    skills: z.array(z.object({ skillId: z.string(), level: z.number().int() })).optional(),
    items: z.array(z.object({ itemId: z.string(), quantity: z.number().int() })).optional(),
    quests: z.array(z.object({ questId: z.string(), status: z.enum(["completed", "active"]) })).optional(),
    reputation: z.array(z.object({ factionId: z.string(), value: z.number() })).optional(),
    custom: z.array(z.string()).optional(),
  }).optional(),
  
  // 任务目标
  objectives: z.array(z.object({
    id: z.string(),
    type: z.enum([
      "kill", "collect", "deliver", "escort", "explore",
      "craft", "talk", "protect", "survive", "custom"
    ]),
    description: z.string(),
    target: z.string(), // 目标ID或名称
    quantity: z.number().int().default(1),
    current: z.number().int().default(0),
    optional: z.boolean().default(false),
    location: z.string().optional(),
    conditions: z.array(z.string()).optional(),
  })),
  
  // 奖励
  rewards: z.object({
    exp: z.number().default(0),
    currency: z.record(z.string(), z.number()).default({}),
    items: z.array(z.object({
      itemId: z.string(),
      quantity: z.number().int(),
      chance: z.number().min(0).max(100).default(100),
    })).default([]),
    skills: z.array(z.string()).default([]),
    reputation: z.array(z.object({ factionId: z.string(), value: z.number() })).default([]),
    attributes: z.record(z.string(), z.number()).default({}),
    unlocks: z.array(z.string()).default([]), // 解锁内容
  }),
  
  // 时间限制
  timeLimit: z.object({
    duration: z.number(), // 分钟
    failOnTimeout: z.boolean().default(true),
  }).optional(),
  
  // 重复性
  repeatable: z.object({
    enabled: z.boolean().default(false),
    cooldown: z.number(), // 小时
    maxRepeats: z.number().int().optional(),
  }).optional(),
  
  // 元数据
  giver: z.object({
    name: z.string(),
    npcId: z.string().optional(),
    location: z.string(),
  }).optional(),
  tags: z.array(z.string()).default([]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
```

### 3.6 势力/公会模型（网游流）

```typescript
// extensions/factions/types.ts

export const FactionSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  type: z.enum([
    "guild",        // 玩家公会
    "npc_faction",  // NPC势力
    "nation",       // 国家/阵营
    "religion",     // 宗教/信仰
    "family",       // 家族/门派
    "organization", // 组织/协会
    "custom",
  ]),
  
  // 阵营关系
  alignment: z.enum(["good", "evil", "neutral", "lawful", "chaotic"]).optional(),
  relations: z.array(z.object({
    factionId: z.string(),
    relation: z.enum(["ally", "friendly", "neutral", "hostile", "enemy", "war"]),
    value: z.number().min(-100).max(100).default(0),
  })).default([]),
  
  // 等级结构
  ranks: z.array(z.object({
    level: z.number().int(),
    name: z.string(),
    permissions: z.array(z.string()),
    maxMembers: z.number().int().optional(),
    benefits: z.array(z.string()).optional(),
  })).optional(),
  
  // 成员
  members: z.array(z.object({
    characterId: z.string(),
    rank: z.number().int(),
    joinedAt: z.string().datetime(),
    contribution: z.number().default(0),
    status: z.enum(["active", "inactive", "suspended", "left"]).default("active"),
  })).default([]),
  
  // 资源
  resources: z.object({
    currency: z.record(z.string(), z.number()).default({}),
    influence: z.number().default(0),
    territory: z.array(z.string()).default([]),
    assets: z.array(z.string()).default([]),
  }).default({}),
  
  // 领地
  territory: z.array(z.object({
    id: z.string(),
    name: z.string(),
    type: z.enum(["headquarters", "outpost", "territory", "resource"]),
    location: z.string(),
    benefits: z.array(z.string()),
    upgrades: z.array(z.object({
      level: z.number().int(),
      name: z.string(),
      cost: z.record(z.string(), z.number()),
      benefits: z.array(z.string()),
    })).optional(),
  })).optional(),
  
  // 科技/技能树
  techTree: z.array(z.object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    requiredLevel: z.number().int(),
    cost: z.record(z.string(), z.number()),
    effects: z.array(z.string()),
    prerequisites: z.array(z.string()).optional(),
    unlocked: z.boolean().default(false),
  })).optional(),
  
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
```

## 4. 数据访问层设计

### 4.1 存储管理器

```typescript
// extensions/storage/manager.ts

export interface ExtensionStorageManager {
  // 角色数据操作
  characters: {
    list(): Promise<CharacterData[]>;
    get(id: string): Promise<CharacterData | null>;
    save(data: CharacterData): Promise<void>;
    delete(id: string): Promise<void>;
    getByChapter(chapter: number): Promise<CharacterData[]>; // 获取某章出现的角色
  };
  
  // 技能数据操作
  skills: {
    list(): Promise<Skill[]>;
    get(id: string): Promise<Skill | null>;
    save(data: Skill): Promise<void>;
    delete(id: string): Promise<void>;
    search(query: string): Promise<Skill[]>;
  };
  
  // 物品数据操作
  items: {
    list(): Promise<Item[]>;
    get(id: string): Promise<Item | null>;
    save(data: Item): Promise<void>;
    delete(id: string): Promise<void>;
    search(query: string): Promise<Item[]>;
  };
  
  // 系统配置操作
  systems: {
    list(): Promise<SystemConfig[]>;
    get(id: string): Promise<SystemConfig | null>;
    save(data: SystemConfig): Promise<void>;
    delete(id: string): Promise<void>;
    getLogs(filters?: LogFilters): Promise<SystemLog[]>;
    addLog(log: SystemLog): Promise<void>;
  };
  
  // 任务数据操作
  quests: {
    list(): Promise<Quest[]>;
    get(id: string): Promise<Quest | null>;
    save(data: Quest): Promise<void>;
    delete(id: string): Promise<void>;
    getByType(type: QuestType): Promise<Quest[]>;
  };
  
  // 势力数据操作
  factions: {
    list(): Promise<Faction[]>;
    get(id: string): Promise<Faction | null>;
    save(data: Faction): Promise<void>;
    delete(id: string): Promise<void>;
  };
  
  // 批量操作
  bulk: {
    import(data: ExtensionDataExport): Promise<void>;
    export(): Promise<ExtensionDataExport>;
    validate(): Promise<ValidationResult[]>;
  };
}

// 数据导出格式
export interface ExtensionDataExport {
  version: string;
  bookId: string;
  exportedAt: string;
  characters: CharacterData[];
  skills: Skill[];
  items: Item[];
  systems: SystemConfig[];
  quests: Quest[];
  factions: Faction[];
}
```

### 4.2 文件存储实现

```typescript
// extensions/storage/file-storage.ts

export class FileExtensionStorage implements ExtensionStorageManager {
  private bookDir: string;
  private extensionsDir: string;
  
  constructor(bookDir: string) {
    this.bookDir = bookDir;
    this.extensionsDir = path.join(bookDir, "extensions");
  }
  
  async init(): Promise<void> {
    // 创建必要的目录结构
    const dirs = [
      "characters",
      "skills",
      "items",
      "system/panels",
      "system/logs",
      "quests",
      "factions",
    ];
    
    for (const dir of dirs) {
      await fs.mkdir(path.join(this.extensionsDir, dir), { recursive: true });
    }
  }
  
  // 角色数据实现示例
  characters = {
    list: async (): Promise<CharacterData[]> => {
      const indexPath = path.join(this.extensionsDir, "characters", "index.json");
      const index = await this.readJson<CharacterIndex>(indexPath) || { characters: [] };
      
      const characters: CharacterData[] = [];
      for (const entry of index.characters) {
        const data = await this.readJson<CharacterData>(
          path.join(this.extensionsDir, "characters", `${entry.id}.json`)
        );
        if (data) characters.push(data);
      }
      return characters;
    },
    
    get: async (id: string): Promise<CharacterData | null> => {
      return this.readJson<CharacterData>(
        path.join(this.extensionsDir, "characters", `${id}.json`)
      );
    },
    
    save: async (data: CharacterData): Promise<void> => {
      // 保存角色数据
      await this.writeJson(
        path.join(this.extensionsDir, "characters", `${data.base.id}.json`),
        data
      );
      
      // 更新索引
      await this.updateIndex("characters", data.base.id, {
        id: data.base.id,
        name: data.base.name,
        role: data.base.role,
        firstAppearance: data.base.firstAppearance,
      });
    },
    
    delete: async (id: string): Promise<void> => {
      await fs.unlink(path.join(this.extensionsDir, "characters", `${id}.json`));
      await this.removeFromIndex("characters", id);
    },
    
    getByChapter: async (chapter: number): Promise<CharacterData[]> => {
      const all = await this.characters.list();
      return all.filter(c => c.base.firstAppearance <= chapter);
    },
  };
  
  // ... 其他方法的实现
  
  private async readJson<T>(filePath: string): Promise<T | null> {
    try {
      const content = await fs.readFile(filePath, "utf-8");
      return JSON.parse(content) as T;
    } catch {
      return null;
    }
  }
  
  private async writeJson(filePath: string, data: unknown): Promise<void> {
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
  }
  
  private async updateIndex(
    type: string,
    id: string,
    entry: Record<string, unknown>
  ): Promise<void> {
    const indexPath = path.join(this.extensionsDir, type, "index.json");
    const index = await this.readJson<{ [key: string]: unknown[] }>(indexPath) || {};
    
    if (!index[type]) index[type] = [];
    const existingIndex = (index[type] as Array<{ id: string }>).findIndex(e => e.id === id);
    
    if (existingIndex >= 0) {
      index[type][existingIndex] = entry;
    } else {
      index[type].push(entry);
    }
    
    await this.writeJson(indexPath, index);
  }
}
```

## 5. 与现有系统的集成

### 5.1 与 Story Bible 的集成

```typescript
// extensions/integration/story-bible.ts

/**
 * 将扩展数据同步到 Story Bible
 * 保持 Story Bible 作为"人类可读"的主要文档
 */
export class StoryBibleIntegration {
  constructor(
    private storage: ExtensionStorageManager,
    private bookDir: string
  ) {}
  
  /**
   * 更新 Story Bible 中的角色部分
   */
  async syncCharactersToBible(): Promise<void> {
    const characters = await this.storage.characters.list();
    const biblePath = path.join(this.bookDir, "story_bible.md");
    
    // 生成角色 Markdown 表格
    const characterTable = this.generateCharacterTable(characters);
    
    // 读取现有 Story Bible
    let bibleContent = await fs.readFile(biblePath, "utf-8");
    
    // 更新或插入角色部分
    bibleContent = this.updateSection(
      bibleContent,
      "## 角色数据",
      characterTable
    );
    
    await fs.writeFile(biblePath, bibleContent, "utf-8");
  }
  
  /**
   * 从 Story Bible 解析角色数据
   */
  async parseCharactersFromBible(): Promise<Partial<CharacterData>[]> {
    const biblePath = path.join(this.bookDir, "story_bible.md");
    const content = await fs.readFile(biblePath, "utf-8");
    
    // 解析角色部分
    const characterSection = this.extractSection(content, "## 角色数据");
    return this.parseCharacterTable(characterSection);
  }
  
  private generateCharacterTable(characters: CharacterData[]): string {
    const lines = [
      "| 角色名 | 身份 | 等级 | 关键属性 | 技能数 | 首次登场 |",
      "|--------|------|------|----------|--------|----------|",
    ];
    
    for (const char of characters) {
      const panel = char.panels.find(p => p.panelType === "system");
      const keyAttrs = panel?.attributes.slice(0, 3).map(a => `${a.name}:${a.value}`).join(", ") || "-";
      
      lines.push(
        `| ${char.base.name} | ${char.base.role} | ${panel?.level?.current || "-"} | ${keyAttrs} | ${char.skills.length} | 第${char.base.firstAppearance}章 |`
      );
    }
    
    return lines.join("\n");
  }
}
```

### 5.2 与 Runtime State 的集成

```typescript
// extensions/integration/runtime-state.ts

/**
 * 将角色数据变化同步到 Runtime State
 */
export class RuntimeStateIntegration {
  constructor(private storage: ExtensionStorageManager) {}
  
  /**
   * 在章节写作时获取角色的当前状态
   */
  async getCharacterStateForChapter(
    characterId: string,
    chapter: number
  ): Promise<CharacterData | null> {
    const character = await this.storage.characters.get(characterId);
    if (!character) return null;
    
    // 过滤到指定章节为止的数据
    return {
      ...character,
      skills: character.skills.filter(s => s.acquiredAt <= chapter),
      history: character.history.filter(h => h.chapter <= chapter),
      panels: character.panels.map(panel => ({
        ...panel,
        // 根据历史记录重建该章节时的面板状态
        ...this.reconstructPanelAtChapter(panel, character.history, chapter),
      })),
    };
  }
  
  /**
   * 从 RuntimeStateDelta 更新角色数据
   */
  async applyDeltaToCharacter(
    characterId: string,
    delta: CharacterDelta,
    chapter: number
  ): Promise<void> {
    const character = await this.storage.characters.get(characterId);
    if (!character) return;
    
    // 应用属性变化
    if (delta.attributeChanges) {
      for (const change of delta.attributeChanges) {
        character.history.push({
          chapter,
          type: "attribute_changed",
          description: `${change.attribute} ${change.oldValue} → ${change.newValue}`,
          data: change,
        });
      }
    }
    
    // 应用技能变化
    if (delta.skillChanges) {
      for (const change of delta.skillChanges) {
        if (change.type === "acquired") {
          character.skills.push({
            skillId: change.skillId,
            level: 1,
            exp: 0,
            acquiredAt: chapter,
            proficiency: "novice",
          });
          character.history.push({
            chapter,
            type: "skill_acquired",
            description: `习得技能：${change.skillName}`,
            data: change,
          });
        } else if (change.type === "leveled") {
          const skill = character.skills.find(s => s.skillId === change.skillId);
          if (skill) {
            skill.level = change.newLevel;
            character.history.push({
              chapter,
              type: "skill_leveled",
              description: `技能升级：${change.skillName} Lv.${change.oldLevel} → Lv.${change.newLevel}`,
              data: change,
            });
          }
        }
      }
    }
    
    await this.storage.characters.save(character);
  }
  
  private reconstructPanelAtChapter(
    panel: CharacterPanel,
    history: CharacterHistory[],
    chapter: number
  ): Partial<CharacterPanel> {
    // 根据历史记录重建面板状态
    const relevantHistory = history.filter(
      h => h.chapter <= chapter && h.type === "attribute_changed"
    );
    
    // 应用所有相关的属性变化
    const attributes = [...panel.attributes];
    for (const entry of relevantHistory) {
      if (entry.data?.attribute) {
        const attr = attributes.find(a => a.id === entry.data.attribute);
        if (attr) {
          attr.value = entry.data.newValue;
        }
      }
    }
    
    return { attributes };
  }
}
```

### 5.3 与 Writer Agent 的集成

```typescript
// extensions/integration/writer-prompts.ts

/**
 * 为 Writer Agent 生成包含扩展数据的 Prompt
 */
export class ExtensionPromptIntegration {
  constructor(private storage: ExtensionStorageManager) {}
  
  /**
   * 生成角色数据相关的写作提示
   */
  async generateCharacterPrompt(
    characterIds: string[],
    chapter: number
  ): Promise<string> {
    const characters: CharacterData[] = [];
    
    for (const id of characterIds) {
      const char = await this.storage.characters.get(id);
      if (char) characters.push(char);
    }
    
    const lines: string[] = ["### 角色数据", ""];
    
    for (const char of characters) {
      lines.push(`#### ${char.base.name}`);
      lines.push(`- 身份：${char.base.role}`);
      lines.push(`- 描述：${char.base.description}`);
      
      // 添加面板数据
      const panel = char.panels.find(p => p.panelType === "system");
      if (panel) {
        lines.push(`- 等级：${panel.level?.current || "?"}`);
        lines.push(`- 状态：`);
        if (panel.stats) {
          if (panel.stats.hp) lines.push(`  - HP: ${panel.stats.hp.current}/${panel.stats.hp.max}`);
          if (panel.stats.mp) lines.push(`  - MP: ${panel.stats.mp.current}/${panel.stats.mp.max}`);
        }
        
        // 关键属性
        const keyAttrs = panel.attributes.filter(a => a.visible).slice(0, 5);
        if (keyAttrs.length > 0) {
          lines.push(`- 属性：${keyAttrs.map(a => `${a.name}:${a.value}`).join(", ")}`);
        }
      }
      
      // 当前技能
      const activeSkills = char.skills
        .filter(s => s.acquiredAt <= chapter && s.isActive)
        .slice(0, 5);
      if (activeSkills.length > 0) {
        const skillDetails = await Promise.all(
          activeSkills.map(async s => {
            const skill = await this.storage.skills.get(s.skillId);
            return skill ? `${skill.name}(Lv.${s.level})` : s.skillId;
          })
        );
        lines.push(`- 主要技能：${skillDetails.join(", ")}`);
      }
      
      // 装备
      if (char.equipment && Object.keys(char.equipment).length > 0) {
        const equipDetails = await Promise.all(
          Object.entries(char.equipment).map(async ([slot, itemId]) => {
            const item = await this.storage.items.get(itemId);
            return `${slot}:${item?.name || itemId}`;
          })
        );
        lines.push(`- 装备：${equipDetails.join(", ")}`);
      }
      
      lines.push("");
    }
    
    return lines.join("\n");
  }
  
  /**
   * 生成系统提示（系统流小说）
   */
  async generateSystemPrompt(systemId: string): Promise<string> {
    const system = await this.storage.systems.get(systemId);
    if (!system) return "";
    
    const lines: string[] = ["### 系统设定", ""];
    lines.push(`**${system.name}**`);
    lines.push(system.description);
    lines.push("");
    
    if (system.leveling?.enabled) {
      lines.push("#### 等级体系");
      lines.push(`- 最高等级：${system.leveling.maxLevel}`);
      lines.push(`- 经验公式：${system.leveling.expFormula}`);
      if (system.leveling.levelTitles) {
        lines.push("- 等级称号：");
        for (const title of system.leveling.levelTitles.slice(0, 5)) {
          lines.push(`  - Lv.${title.level}: ${title.title}`);
        }
      }
      lines.push("");
    }
    
    if (system.notifications) {
      lines.push("#### 系统提示");
      const enabledNotifications = Object.entries(system.notifications)
        .filter(([_, enabled]) => enabled)
        .map(([name, _]) => name);
      lines.push(`系统会在以下情况发出提示：${enabledNotifications.join(", ")}`);
      lines.push("");
    }
    
    return lines.join("\n");
  }
}
```

## 6. UI 界面设计

### 6.1 Studio 界面扩展

```typescript
// studio/src/pages/extensions/CharacterManager.tsx

/**
 * 角色管理页面
 */
export function CharacterManager({ bookId }: { bookId: string }) {
  const [characters, setCharacters] = useState<CharacterData[]>([]);
  const [selectedChar, setSelectedChar] = useState<CharacterData | null>(null);
  const [activeTab, setActiveTab] = useState<"list" | "detail" | "panel" | "skills" | "inventory">("list");
  
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="font-serif text-2xl">角色管理</h1>
        <button className="btn-primary">+ 新建角色</button>
      </div>
      
      {/* 角色列表 */}
      {activeTab === "list" && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {characters.map(char => (
            <CharacterCard
              key={char.base.id}
              data={char}
              onClick={() => {
                setSelectedChar(char);
                setActiveTab("detail");
              }}
            />
          ))}
        </div>
      )}
      
      {/* 角色详情 */}
      {activeTab === "detail" && selectedChar && (
        <CharacterDetailView
          data={selectedChar}
          onBack={() => setActiveTab("list")}
          onEdit={() => {/* 编辑 */}}
        />
      )}
      
      {/* 面板编辑器 */}
      {activeTab === "panel" && selectedChar && (
        <PanelEditor
          characterId={selectedChar.base.id}
          panels={selectedChar.panels}
          onSave={/* 保存 */}
        />
      )}
    </div>
  );
}

// CharacterCard 组件
function CharacterCard({ data, onClick }: { data: CharacterData; onClick: () => void }) {
  const panel = data.panels.find(p => p.panelType === "system");
  
  return (
    <div
      className="border rounded-lg p-4 cursor-pointer hover:border-primary transition-colors"
      onClick={onClick}
    >
      <div className="flex items-center gap-3 mb-3">
        <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center text-lg font-bold">
          {data.base.name[0]}
        </div>
        <div>
          <h3 className="font-medium">{data.base.name}</h3>
          <span className="text-xs text-muted-foreground">{data.base.role}</span>
        </div>
      </div>
      
      {panel && (
        <div className="space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">等级</span>
            <span className="font-medium">{panel.level?.current || "-"}</span>
          </div>
          {panel.stats?.hp && (
            <div className="flex justify-between">
              <span className="text-muted-foreground">HP</span>
              <span>{panel.stats.hp.current}/{panel.stats.hp.max}</span>
            </div>
          )}
          <div className="flex justify-between">
            <span className="text-muted-foreground">技能</span>
            <span>{data.skills.length}个</span>
          </div>
        </div>
      )}
    </div>
  );
}
```

### 6.2 技能编辑器界面

```typescript
// studio/src/pages/extensions/SkillEditor.tsx

export function SkillEditor({ skill, onSave }: { skill?: Skill; onSave: (s: Skill) => void }) {
  const [formData, setFormData] = useState<Partial<Skill>>(skill || {
    category: "active",
    rarity: "common",
    maxLevel: 1,
    effects: [],
    requirements: {},
  });
  
  return (
    <div className="space-y-6">
      <h2 className="font-serif text-xl">{skill ? "编辑技能" : "新建技能"}</h2>
      
      {/* 基础信息 */}
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="label">技能名称</label>
          <input
            className="input"
            value={formData.name || ""}
            onChange={e => setFormData({ ...formData, name: e.target.value })}
          />
        </div>
        <div>
          <label className="label">技能分类</label>
          <select
            className="input"
            value={formData.category}
            onChange={e => setFormData({ ...formData, category: e.target.value as SkillCategory })}
          >
            <option value="combat">战斗技能</option>
            <option value="magic">魔法技能</option>
            <option value="passive">被动技能</option>
            <option value="active">主动技能</option>
            <option value="ultimate">终极技能</option>
          </select>
        </div>
      </div>
      
      {/* 效果编辑器 */}
      <div>
        <label className="label">技能效果</label>
        <SkillEffectEditor
          effects={formData.effects || []}
          onChange={effects => setFormData({ ...formData, effects })}
        />
      </div>
      
      {/* 等级成长 */}
      <div>
        <label className="label">等级成长</label>
        <LevelScalingEditor
          scaling={formData.levelScaling}
          maxLevel={formData.maxLevel || 1}
          onChange={levelScaling => setFormData({ ...formData, levelScaling })}
        />
      </div>
      
      {/* 学习条件 */}
      <div>
        <label className="label">学习条件</label>
        <SkillRequirementsEditor
          requirements={formData.requirements}
          onChange={requirements => setFormData({ ...formData, requirements })}
        />
      </div>
      
      <div className="flex justify-end gap-3">
        <button className="btn-secondary">取消</button>
        <button className="btn-primary" onClick={() => onSave(formData as Skill)}>
          保存
        </button>
      </div>
    </div>
  );
}
```

## 7. 实施计划

### 7.1 第一阶段：基础架构（2-3周）

1. **数据模型定义**
   - 完成所有 TypeScript 类型定义和 Zod Schema
   - 设计数据验证规则

2. **存储层实现**
   - 实现 FileExtensionStorage
   - 实现索引管理和缓存机制
   - 编写单元测试

3. **基础 API 层**
   - 实现 StorageManager 接口
   - 添加数据导入/导出功能

### 7.2 第二阶段：核心功能（3-4周）

1. **角色系统**
   - 角色 CRUD 操作
   - 面板编辑器
   - 属性系统

2. **技能系统**
   - 技能数据库
   - 效果编辑器
   - 等级成长配置

3. **物品系统**
   - 物品数据库
   - 装备系统
   - 合成配方

### 7.3 第三阶段：系统集成（2-3周）

1. **与现有系统集成**
   - Story Bible 同步
   - Runtime State 集成
   - Writer Agent Prompt 集成

2. **数据导入导出**
   - 批量导入工具
   - 数据验证
   - 版本迁移

### 7.4 第四阶段：UI 界面（2-3周）

1. **Studio 界面**
   - 角色管理页面
   - 技能编辑器
   - 物品管理器
   - 系统配置界面

2. **数据可视化**
   - 角色关系图
   - 技能树展示
   - 属性变化曲线

### 7.5 第五阶段：高级功能（2-3周）

1. **网游流特性**
   - 任务系统
   - 公会/势力系统
   - 副本/地图数据

2. **系统流特性**
   - 系统配置
   - 系统日志
   - 成就系统

## 8. 技术要点

### 8.1 数据一致性

- 使用事务机制确保多文件操作的原子性
- 实现数据变更日志，支持回滚
- 定期进行数据完整性检查

### 8.2 性能优化

- 索引文件缓存，减少磁盘 IO
- 延迟加载大数据对象
- 批量操作支持

### 8.3 版本兼容

- 数据模型版本控制
- 自动迁移脚本
- 向后兼容支持

### 8.4 扩展性

- 插件化架构，支持自定义扩展
- 开放 API 供第三方工具集成
- 支持多种存储后端（文件、数据库、云存储）

## 9. 使用示例

### 9.1 创建系统流小说角色

```typescript
// 创建主角
const protagonist = await storage.characters.save({
  base: {
    id: "char_001",
    name: "林凡",
    description: "意外获得系统的普通大学生",
    role: "protagonist",
    importance: "main",
    firstAppearance: 1,
  },
  panels: [{
    characterId: "char_001",
    panelType: "system",
    level: { current: 1, title: "菜鸟" },
    attributes: [
      { id: "str", name: "力量", category: "basic", value: 10 },
      { id: "agi", name: "敏捷", category: "basic", value: 12 },
      { id: "int", name: "智力", category: "basic", value: 15 },
    ],
    stats: {
      hp: { current: 100, max: 100 },
      mp: { current: 50, max: 50 },
    },
    lastUpdated: new Date().toISOString(),
  }],
  skills: [],
  inventory: {
    capacity: 20,
    items: [],
    currency: { gold: 0, points: 100 },
  },
  history: [],
});

// 创建系统配置
const gameSystem = await storage.systems.save({
  id: "sys_001",
  name: "至尊修炼系统",
  description: "通过完成任务获得经验值升级的系统",
  type: "leveling",
  leveling: {
    enabled: true,
    maxLevel: 100,
    expFormula: "base * 1.5^(level-1)",
    levelTitles: [
      { level: 1, title: "菜鸟", rewards: ["新手礼包"] },
      { level: 10, title: "入门", rewards: ["技能点*1"] },
      { level: 30, title: "高手", rewards: ["专属技能"] },
    ],
  },
  notifications: {
    levelUp: true,
    skillAcquired: true,
    questUpdate: true,
  },
});
```

### 9.2 在写作中使用

```typescript
// Writer Agent 获取角色数据
const charPrompt = await extensionPrompts.generateCharacterPrompt(
  ["char_001"],
  currentChapter
);

// 生成的 Prompt 示例：
// ### 角色数据
//
// #### 林凡
// - 身份：protagonist
// - 描述：意外获得系统的普通大学生
// - 等级：1
// - 状态：
//   - HP: 100/100
//   - MP: 50/50
// - 属性：力量:10, 敏捷:12, 智力:15
// - 主要技能：（暂无）
// - 装备：（暂无）
```

## 10. 总结

本设计方案为 InkOS 提供了完整的系统流/网游流/数据流小说数据存储扩展能力：

1. **模块化架构**：与现有系统解耦，按需启用
2. **完整的数据模型**：覆盖角色、技能、物品、任务、系统等核心要素
3. **无缝集成**：与 Story Bible、Runtime State、Writer Agent 深度集成
4. **友好的 UI**：提供直观的可视化编辑界面
5. **可扩展性**：支持自定义扩展和第三方集成

实施后，作者可以：
- 系统化管理小说中的角色数据和成长轨迹
- 设计复杂的技能体系和物品系统
- 追踪角色的属性变化和装备更替
- 在写作时自动获取准确的当前状态数据
- 生成一致性的系统提示和面板展示
