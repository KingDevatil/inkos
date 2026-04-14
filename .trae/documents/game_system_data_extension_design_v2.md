# 系统流/网游流小说数据存储扩展设计方案（精简版）

## 1. 设计目标

为系统流、网游流小说提供轻量化的角色数据、技能、物品等数据存储，核心目标：
1. **数据持久化**：创作过程中产生的角色属性、技能、装备等数据保存到本地
2. **一致性保障**：写作和审核时可查询历史数据，避免前后矛盾
3. **RAG集成**：将数据纳入RAG检索范围，支持智能上下文关联

## 2. 存储架构

### 2.1 目录结构

```
books/
├── {book-id}/
│   ├── book.json
│   ├── story_bible.md
│   ├── ...
│   └── extensions/              # 扩展数据目录（新增）
│       ├── characters.json      # 角色数据库（单文件）
│       ├── skills.json          # 技能数据库
│       ├── items.json           # 物品数据库
│       └── snapshots/           # 章节快照（按章节保存角色状态）
│           ├── chapter_001.json
│           ├── chapter_002.json
│           └── ...
```

### 2.2 简化原则

- **单文件存储**：每类数据一个JSON文件，便于读写和版本控制
- **扁平结构**：避免复杂嵌套，关键数据直接存取
- **章节快照**：每章结束后保存角色状态，支持历史回溯

## 3. 数据模型

### 3.1 角色数据（characters.json）

```typescript
// extensions/characters/types.ts

export interface Character {
  id: string;                    // 唯一标识
  name: string;                  // 角色名
  aliases: string[];             // 别名
  role: "protagonist" | "supporting" | "antagonist" | "npc";
  description: string;           // 角色描述
  firstAppearance: number;       // 首次出场章节
  
  // 系统流核心数据
  panel?: {
    level: number;               // 等级
    exp: number;                 // 经验值
    attributes: Record<string, number>;  // 属性：力量、敏捷等
    stats?: {
      hp?: { current: number; max: number };
      mp?: { current: number; max: number };
    };
  };
  
  // 技能列表（存skillId）
  skills: {
    skillId: string;
    level: number;
    acquiredAt: number;          // 获得章节
  }[];
  
  // 装备（装备位 -> 物品ID）
  equipment?: Record<string, string>;
  
  // 背包关键物品
  inventory?: string[];
  
  // 元数据
  tags: string[];
  notes: string;
  updatedAt: string;
}

// 角色数据库结构
export interface CharactersDB {
  version: number;
  updatedAt: string;
  characters: Character[];
}
```

### 3.2 技能数据（skills.json）

```typescript
// extensions/skills/types.ts

export interface Skill {
  id: string;
  name: string;
  description: string;
  category: "combat" | "magic" | "passive" | "active" | "ultimate";
  
  // 效果描述（文本，便于LLM理解）
  effects: string[];
  
  // 等级信息
  maxLevel: number;
  levelDescriptions?: Record<number, string>;  // 各等级效果描述
  
  // 学习条件（文本描述）
  requirements?: string;
  
  // 来源
  source?: string;  // 系统奖励、技能书、NPC传授等
  
  tags: string[];
  notes: string;
}

export interface SkillsDB {
  version: number;
  updatedAt: string;
  skills: Skill[];
}
```

### 3.3 物品数据（items.json）

```typescript
// extensions/items/types.ts

export interface Item {
  id: string;
  name: string;
  description: string;
  category: "weapon" | "armor" | "accessory" | "consumable" | "material" | "quest";
  rarity: "common" | "uncommon" | "rare" | "epic" | "legendary" | "mythic";
  
  // 属性加成
  attributes?: Record<string, number>;
  
  // 效果描述
  effects?: string[];
  
  // 装备信息
  equippable?: boolean;
  slot?: string;  // 装备槽位
  
  // 来源
  source?: string;
  
  tags: string[];
  notes: string;
}

export interface ItemsDB {
  version: number;
  updatedAt: string;
  items: Item[];
}
```

### 3.4 章节快照（snapshots/chapter_{n}.json）

```typescript
// extensions/snapshots/types.ts

export interface ChapterSnapshot {
  chapter: number;
  createdAt: string;
  
  // 该章节所有角色的状态
  characters: {
    characterId: string;
    name: string;
    panel?: Character["panel"];
    skills: string[];  // 当前拥有的技能ID列表
    equipment?: Record<string, string>;
    inventory?: string[];
    status?: string;   // 特殊状态：受伤、中毒等
  }[];
  
  // 章节关键数据
  chapterData: {
    expGained: Record<string, number>;     // 角色 -> 获得经验
    itemsAcquired: Record<string, string[]>; // 角色 -> 获得物品
    skillsLearned: Record<string, string[]>; // 角色 -> 习得技能
  };
}
```

## 4. 数据访问层

### 4.1 存储管理器

```typescript
// extensions/storage/simple-storage.ts

export class SimpleExtensionStorage {
  private extensionsDir: string;
  
  constructor(bookDir: string) {
    this.extensionsDir = path.join(bookDir, "extensions");
  }
  
  // 初始化目录
  async init(): Promise<void> {
    await fs.mkdir(this.extensionsDir, { recursive: true });
    await fs.mkdir(path.join(this.extensionsDir, "snapshots"), { recursive: true });
    
    // 初始化空数据库文件
    await this.initIfNotExists("characters.json", { version: 1, characters: [] });
    await this.initIfNotExists("skills.json", { version: 1, skills: [] });
    await this.initIfNotExists("items.json", { version: 1, items: [] });
  }
  
  // 角色操作
  async getCharacters(): Promise<CharactersDB> {
    return this.readJson<CharactersDB>("characters.json");
  }
  
  async saveCharacter(char: Character): Promise<void> {
    const db = await this.getCharacters();
    const index = db.characters.findIndex(c => c.id === char.id);
    
    if (index >= 0) {
      db.characters[index] = { ...char, updatedAt: new Date().toISOString() };
    } else {
      db.characters.push({ ...char, updatedAt: new Date().toISOString() });
    }
    
    db.updatedAt = new Date().toISOString();
    await this.writeJson("characters.json", db);
  }
  
  async getCharacter(id: string): Promise<Character | undefined> {
    const db = await this.getCharacters();
    return db.characters.find(c => c.id === id);
  }
  
  // 技能操作
  async getSkills(): Promise<SkillsDB> {
    return this.readJson<SkillsDB>("skills.json");
  }
  
  async saveSkill(skill: Skill): Promise<void> {
    const db = await this.getSkills();
    const index = db.skills.findIndex(s => s.id === skill.id);
    
    if (index >= 0) {
      db.skills[index] = skill;
    } else {
      db.skills.push(skill);
    }
    
    db.updatedAt = new Date().toISOString();
    await this.writeJson("skills.json", db);
  }
  
  // 物品操作
  async getItems(): Promise<ItemsDB> {
    return this.readJson<ItemsDB>("items.json");
  }
  
  async saveItem(item: Item): Promise<void> {
    const db = await this.getItems();
    const index = db.items.findIndex(i => i.id === item.id);
    
    if (index >= 0) {
      db.items[index] = item;
    } else {
      db.items.push(item);
    }
    
    db.updatedAt = new Date().toISOString();
    await this.writeJson("items.json", db);
  }
  
  // 章节快照
  async saveSnapshot(snapshot: ChapterSnapshot): Promise<void> {
    const filename = `chapter_${String(snapshot.chapter).padStart(3, "0")}.json`;
    await this.writeJson(path.join("snapshots", filename), snapshot);
  }
  
  async getSnapshot(chapter: number): Promise<ChapterSnapshot | null> {
    const filename = `chapter_${String(chapter).padStart(3, "0")}.json`;
    return this.readJson<ChapterSnapshot>(path.join("snapshots", filename));
  }
  
  // 获取角色在指定章节的状态
  async getCharacterAtChapter(characterId: string, chapter: number): Promise<ChapterSnapshot["characters"][0] | null> {
    const snapshot = await this.getSnapshot(chapter);
    if (!snapshot) return null;
    return snapshot.characters.find(c => c.characterId === characterId) || null;
  }
  
  // 工具方法
  private async initIfNotExists(filename: string, defaultData: unknown): Promise<void> {
    const filepath = path.join(this.extensionsDir, filename);
    try {
      await fs.access(filepath);
    } catch {
      await this.writeJson(filename, defaultData);
    }
  }
  
  private async readJson<T>(filename: string): Promise<T> {
    const filepath = path.join(this.extensionsDir, filename);
    const content = await fs.readFile(filepath, "utf-8");
    return JSON.parse(content) as T;
  }
  
  private async writeJson(filename: string, data: unknown): Promise<void> {
    const filepath = path.join(this.extensionsDir, filename);
    await fs.writeFile(filepath, JSON.stringify(data, null, 2), "utf-8");
  }
}
```

## 5. RAG集成

### 5.1 数据索引

```typescript
// extensions/rag/indexing.ts

export class ExtensionRAGIndexer {
  constructor(
    private storage: SimpleExtensionStorage,
    private ragManager: RAGManager
  ) {}
  
  // 索引所有扩展数据到RAG
  async indexAll(): Promise<void> {
    await this.indexCharacters();
    await this.indexSkills();
    await this.indexItems();
    await this.indexSnapshots();
  }
  
  // 索引角色数据
  async indexCharacters(): Promise<void> {
    const db = await this.storage.getCharacters();
    
    for (const char of db.characters) {
      // 构建角色文档内容
      const content = this.buildCharacterDocument(char);
      
      await this.ragManager.addDocument({
        id: `char:${char.id}`,
        type: "fact",
        content,
        metadata: {
          type: "character",
          characterId: char.id,
          name: char.name,
          role: char.role,
          firstAppearance: char.firstAppearance,
          fileName: "characters.json",
        },
      });
    }
  }
  
  // 索引技能数据
  async indexSkills(): Promise<void> {
    const db = await this.storage.getSkills();
    
    for (const skill of db.skills) {
      const content = this.buildSkillDocument(skill);
      
      await this.ragManager.addDocument({
        id: `skill:${skill.id}`,
        type: "fact",
        content,
        metadata: {
          type: "skill",
          skillId: skill.id,
          name: skill.name,
          category: skill.category,
          fileName: "skills.json",
        },
      });
    }
  }
  
  // 索引物品数据
  async indexItems(): Promise<void> {
    const db = await this.storage.getItems();
    
    for (const item of db.items) {
      const content = this.buildItemDocument(item);
      
      await this.ragManager.addDocument({
        id: `item:${item.id}`,
        type: "fact",
        content,
        metadata: {
          type: "item",
          itemId: item.id,
          name: item.name,
          category: item.category,
          rarity: item.rarity,
          fileName: "items.json",
        },
      });
    }
  }
  
  // 索引章节快照（用于追踪角色状态变化）
  async indexSnapshots(): Promise<void> {
    // 获取所有快照文件
    const snapshotsDir = path.join(this.storage["extensionsDir"], "snapshots");
    const files = await fs.readdir(snapshotsDir);
    
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      
      const chapter = parseInt(file.match(/chapter_(\d+)/)?.[1] || "0");
      const snapshot = await this.storage.getSnapshot(chapter);
      if (!snapshot) continue;
      
      // 为每个角色的状态创建文档
      for (const charState of snapshot.characters) {
        const content = this.buildSnapshotDocument(charState, chapter);
        
        await this.ragManager.addDocument({
          id: `snapshot:${charState.characterId}:ch${chapter}`,
          type: "fact",
          content,
          metadata: {
            type: "character_snapshot",
            characterId: charState.characterId,
            name: charState.name,
            chapter: chapter,
            fileName: `snapshots/chapter_${String(chapter).padStart(3, "0")}.json`,
          },
        });
      }
    }
  }
  
  // 构建文档内容
  private buildCharacterDocument(char: Character): string {
    const lines = [
      `角色：${char.name}`,
      `身份：${char.role}`,
      `描述：${char.description}`,
    ];
    
    if (char.aliases.length > 0) {
      lines.push(`别名：${char.aliases.join("、")}`);
    }
    
    if (char.panel) {
      lines.push(`等级：${char.panel.level}`);
      lines.push(`经验值：${char.panel.exp}`);
      lines.push(`属性：${Object.entries(char.panel.attributes).map(([k, v]) => `${k}:${v}`).join(", ")}`);
      
      if (char.panel.stats?.hp) {
        lines.push(`HP：${char.panel.stats.hp.current}/${char.panel.stats.hp.max}`);
      }
    }
    
    if (char.skills.length > 0) {
      lines.push(`技能：${char.skills.map(s => `${s.skillId}(Lv.${s.level})`).join(", ")}`);
    }
    
    if (char.equipment && Object.keys(char.equipment).length > 0) {
      lines.push(`装备：${Object.entries(char.equipment).map(([k, v]) => `${k}:${v}`).join(", ")}`);
    }
    
    return lines.join("\n");
  }
  
  private buildSkillDocument(skill: Skill): string {
    const lines = [
      `技能：${skill.name}`,
      `分类：${skill.category}`,
      `描述：${skill.description}`,
      `最高等级：${skill.maxLevel}`,
    ];
    
    if (skill.effects.length > 0) {
      lines.push(`效果：${skill.effects.join("；")}`);
    }
    
    if (skill.requirements) {
      lines.push(`学习条件：${skill.requirements}`);
    }
    
    return lines.join("\n");
  }
  
  private buildItemDocument(item: Item): string {
    const lines = [
      `物品：${item.name}`,
      `分类：${item.category}`,
      `品质：${item.rarity}`,
      `描述：${item.description}`,
    ];
    
    if (item.attributes && Object.keys(item.attributes).length > 0) {
      lines.push(`属性加成：${Object.entries(item.attributes).map(([k, v]) => `${k}+${v}`).join(", ")}`);
    }
    
    if (item.effects && item.effects.length > 0) {
      lines.push(`效果：${item.effects.join("；")}`);
    }
    
    return lines.join("\n");
  }
  
  private buildSnapshotDocument(charState: ChapterSnapshot["characters"][0], chapter: number): string {
    const lines = [
      `第${chapter}章角色状态：${charState.name}`,
    ];
    
    if (charState.panel) {
      lines.push(`等级：${charState.panel.level}`);
      lines.push(`属性：${Object.entries(charState.panel.attributes).map(([k, v]) => `${k}:${v}`).join(", ")}`);
    }
    
    if (charState.skills.length > 0) {
      lines.push(`当前技能：${charState.skills.join(", ")}`);
    }
    
    if (charState.status) {
      lines.push(`状态：${charState.status}`);
    }
    
    return lines.join("\n");
  }
}
```

### 5.2 RAG检索增强

```typescript
// extensions/rag/retrieval.ts

export class ExtensionRAGRetrieval {
  constructor(private ragManager: RAGManager) {}
  
  // 检索角色相关信息
  async searchCharacter(query: string, characterId?: string): Promise<string> {
    const filters: Record<string, unknown> = { type: "character" };
    if (characterId) filters["characterId"] = characterId;
    
    const results = await this.ragManager.retrieveRelevantContent(query, {
      limit: 5,
      filters,
    });
    
    if (results.length === 0) return "";
    
    return results.map(r => r.content).join("\n\n---\n\n");
  }
  
  // 检索角色在特定章节的状态
  async searchCharacterAtChapter(characterId: string, chapter: number): Promise<string> {
    const query = `第${chapter}章 ${characterId} 角色状态`;
    
    const results = await this.ragManager.retrieveRelevantContent(query, {
      limit: 3,
      filters: {
        type: "character_snapshot",
        characterId,
        chapter,
      },
    });
    
    return results.map(r => r.content).join("\n");
  }
  
  // 检索技能信息
  async searchSkills(query: string): Promise<string> {
    const results = await this.ragManager.retrieveRelevantContent(query, {
      limit: 5,
      filters: { type: "skill" },
    });
    
    return results.map(r => r.content).join("\n\n---\n\n");
  }
  
  // 检索物品信息
  async searchItems(query: string): Promise<string> {
    const results = await this.ragManager.retrieveRelevantContent(query, {
      limit: 5,
      filters: { type: "item" },
    });
    
    return results.map(r => r.content).join("\n\n---\n\n");
  }
  
  // 综合检索（用于写作时获取上下文）
  async searchForWriting(query: string, chapter: number): Promise<string> {
    const results = await this.ragManager.retrieveRelevantContent(query, {
      limit: 10,
      filters: {
        type: ["character", "character_snapshot", "skill", "item"],
      },
    });
    
    // 按类型分组
    const grouped: Record<string, string[]> = {
      character: [],
      skill: [],
      item: [],
    };
    
    for (const result of results) {
      const type = result.metadata?.type as string;
      if (grouped[type]) {
        grouped[type].push(result.content);
      }
    }
    
    const sections: string[] = [];
    
    if (grouped.character.length > 0) {
      sections.push("### 相关角色\n" + grouped.character.join("\n\n"));
    }
    
    if (grouped.skill.length > 0) {
      sections.push("### 相关技能\n" + grouped.skill.join("\n\n"));
    }
    
    if (grouped.item.length > 0) {
      sections.push("### 相关物品\n" + grouped.item.join("\n\n"));
    }
    
    return sections.join("\n\n");
  }
}
```

## 6. 与Writer Agent集成

### 6.1 Prompt增强

```typescript
// extensions/integration/writer-prompts.ts

export class ExtensionWriterPrompts {
  constructor(
    private storage: SimpleExtensionStorage,
    private ragRetrieval: ExtensionRAGRetrieval
  ) {}
  
  // 生成角色数据Prompt
  async generateCharacterPrompt(characterIds: string[], chapter: number): Promise<string> {
    const lines: string[] = ["### 角色数据", ""];
    
    for (const id of characterIds) {
      // 从RAG获取最新数据
      const charData = await this.ragRetrieval.searchCharacter("", id);
      
      if (charData) {
        lines.push(charData);
      } else {
        // 回退到直接读取
        const char = await this.storage.getCharacter(id);
        if (char) {
          lines.push(this.formatCharacterSimple(char));
        }
      }
      
      // 获取该章节的角色状态
      const snapshot = await this.storage.getCharacterAtChapter(id, chapter);
      if (snapshot?.status) {
        lines.push(`当前状态：${snapshot.status}`);
      }
      
      lines.push("");
    }
    
    return lines.join("\n");
  }
  
  // 生成技能相关Prompt
  async generateSkillPrompt(skillIds: string[]): Promise<string> {
    if (skillIds.length === 0) return "";
    
    const lines: string[] = ["### 技能信息", ""];
    
    for (const id of skillIds) {
      const skillData = await this.ragRetrieval.searchSkills(id);
      if (skillData) {
        lines.push(skillData);
        lines.push("");
      }
    }
    
    return lines.join("\n");
  }
  
  // 生成上下文检索Prompt
  async generateContextPrompt(scene: string, chapter: number): Promise<string> {
    const context = await this.ragRetrieval.searchForWriting(scene, chapter);
    
    if (!context) return "";
    
    return [
      "### 相关设定数据",
      "",
      context,
      "",
      "请确保写作内容与上述设定保持一致。",
    ].join("\n");
  }
  
  private formatCharacterSimple(char: Character): string {
    const lines = [
      `角色：${char.name}`,
      `描述：${char.description}`,
    ];
    
    if (char.panel) {
      lines.push(`等级：${char.panel.level}`);
      lines.push(`属性：${Object.entries(char.panel.attributes).map(([k, v]) => `${k}:${v}`).join(", ")}`);
    }
    
    return lines.join("\n");
  }
}
```

### 6.2 章节完成时保存快照

```typescript
// extensions/integration/chapter-completion.ts

export async function saveChapterSnapshot(
  storage: SimpleExtensionStorage,
  chapter: number,
  characterUpdates: CharacterUpdate[]
): Promise<void> {
  const snapshot: ChapterSnapshot = {
    chapter,
    createdAt: new Date().toISOString(),
    characters: [],
    chapterData: {
      expGained: {},
      itemsAcquired: {},
      skillsLearned: {},
    },
  };
  
  for (const update of characterUpdates) {
    const char = await storage.getCharacter(update.characterId);
    if (!char) continue;
    
    // 应用更新
    if (update.expGained) {
      if (!char.panel) char.panel = { level: 1, exp: 0, attributes: {} };
      char.panel.exp += update.expGained;
      snapshot.chapterData.expGained[char.id] = update.expGained;
    }
    
    if (update.newSkills) {
      for (const skillId of update.newSkills) {
        char.skills.push({
          skillId,
          level: 1,
          acquiredAt: chapter,
        });
      }
      snapshot.chapterData.skillsLearned[char.id] = update.newSkills;
    }
    
    if (update.newItems) {
      if (!char.inventory) char.inventory = [];
      char.inventory.push(...update.newItems);
      snapshot.chapterData.itemsAcquired[char.id] = update.newItems;
    }
    
    if (update.attributeChanges) {
      if (!char.panel) char.panel = { level: 1, exp: 0, attributes: {} };
      for (const [attr, delta] of Object.entries(update.attributeChanges)) {
        char.panel.attributes[attr] = (char.panel.attributes[attr] || 0) + delta;
      }
    }
    
    // 保存更新后的角色
    await storage.saveCharacter(char);
    
    // 添加到快照
    snapshot.characters.push({
      characterId: char.id,
      name: char.name,
      panel: char.panel,
      skills: char.skills.map(s => s.skillId),
      equipment: char.equipment,
      inventory: char.inventory,
      status: update.status,
    });
  }
  
  // 保存快照
  await storage.saveSnapshot(snapshot);
}
```

## 7. 使用流程

### 7.1 创建书籍时初始化

```typescript
// 在书籍创建流程中
async function initializeExtensions(bookDir: string): Promise<void> {
  const storage = new SimpleExtensionStorage(bookDir);
  await storage.init();
  
  // 如果有RAG，索引初始数据
  const ragManager = await getRAGManager(bookId);
  if (ragManager?.isAvailable()) {
    const indexer = new ExtensionRAGIndexer(storage, ragManager);
    await indexer.indexAll();
  }
}
```

### 7.2 写作时使用

```typescript
// Writer Agent 中
async function writeWithExtensions(
  chapter: number,
  characterIds: string[],
  scene: string
): Promise<string> {
  const storage = new SimpleExtensionStorage(bookDir);
  const ragRetrieval = new ExtensionRAGRetrieval(ragManager);
  const prompts = new ExtensionWriterPrompts(storage, ragRetrieval);
  
  // 生成增强Prompt
  const characterPrompt = await prompts.generateCharacterPrompt(characterIds, chapter);
  const contextPrompt = await prompts.generateContextPrompt(scene, chapter);
  
  // 组合到Writer Prompt中
  const fullPrompt = [
    basePrompt,
    characterPrompt,
    contextPrompt,
    writingInstruction,
  ].join("\n\n");
  
  // 调用LLM写作...
}
```

### 7.3 章节完成后保存

```typescript
// 章节审核通过后
await saveChapterSnapshot(storage, chapter, [
  {
    characterId: "char_001",
    expGained: 100,
    newSkills: ["skill_001"],
    attributeChanges: { str: 2, agi: 1 },
  },
]);

// 重新索引到RAG
await indexer.indexSnapshots();
```

## 8. 实施步骤

### 8.1 第一阶段：基础存储（1周）

1. 创建数据类型定义
2. 实现 SimpleExtensionStorage
3. 添加初始化逻辑到书籍创建流程

### 8.2 第二阶段：RAG集成（1周）

1. 实现 ExtensionRAGIndexer
2. 实现 ExtensionRAGRetrieval
3. 在RAGManager中集成扩展数据索引

### 8.3 第三阶段：Writer集成（1周）

1. 实现 ExtensionWriterPrompts
2. 修改 Writer Agent 调用扩展数据
3. 章节完成后自动保存快照

### 8.4 第四阶段：Studio界面（可选，1周）

1. 简单的角色/技能/物品查看页面
2. 数据编辑功能

## 9. 总结

精简后的方案核心特点：

1. **轻量级存储**：单文件JSON，易于维护和版本控制
2. **自动快照**：每章自动保存角色状态，支持历史回溯
3. **深度RAG集成**：所有数据自动索引，支持智能检索
4. **透明使用**：Writer Agent 自动获取相关数据，无需手动干预
5. **一致性保障**：通过RAG检索历史状态，避免数据矛盾

实施后效果：
- 角色等级、属性、技能变化自动记录
- 写作时自动获取角色当前状态
- 审核时可查询历史数据验证一致性
- RAG检索自动关联相关角色、技能、物品信息
