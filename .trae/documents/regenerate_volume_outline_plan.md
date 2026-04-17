# 重新生成卷纲功能实现计划（修订版）

## 需求理解

用户希望在**保留现有设定**（story_bible.md、characters/、book_rules.md 等）的基础上，**完全重写剧情规划部分**：
- `volume_outline.md`（卷纲规划）
- `current_state.md`（当前状态）
- `pending_hooks.md`（待填坑）

**关键点**：
1. 不给 LLM 当前卷纲作为参考（避免被原有结构限制）
2. 严格按照 Architect 生成大纲的完整格式输出
3. 类似重写大纲流程，但跳过设定生成步骤

## 实现方案

### 方案一：新增 CLI 命令 `inkos plan regenerate`

#### 1. 核心流程

```
用户执行: inkos plan regenerate <bookId> [--instruction "优化节奏，增加反转"]

执行流程:
1. 读取现有设定文件（story_bible.md、characters/、book_rules.md）
2. 备份现有剧情规划文件（volume_outline.md、current_state.md、pending_hooks.md）
3. 构建 Prompt（只包含设定，不包含当前卷纲）
4. 调用 LLM 生成新的剧情规划三件套
5. 保存新文件，更新 book.json 中的 chapters 信息
```

### 方案二：Studio 操作按钮 + Agent 对话调用（推荐）

#### 1. 操作按钮位置
在书籍详情页的操作区添加按钮：
- **位置**: `packages/studio/src/pages/BookDetailPage.tsx` 的操作按钮组
- **按钮文案**: "重新规划剧情"
- **图标**: RefreshCw 或 RotateCcw
- **确认弹窗**: 提示用户此操作会重新生成卷纲/状态/待填坑，但保留设定

#### 2. Agent 对话调用方式
用户也可以在 AI 助手对话中通过工具调用：
```
用户: 我对当前卷纲不满意，重新规划一下
Agent: 我将为您重新生成剧情规划，保留现有设定...
[调用 regenerate_outline 工具]
```

**实现**: 在 `agent-tools.ts` 中已有 `sub_agent`，可以扩展支持 `agent="planner"` 或添加新的工具

#### 3. 涉及的文件变更

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `packages/studio/src/pages/BookDetailPage.tsx` | 修改 | 添加"重新规划剧情"按钮 |
| `packages/studio/src/hooks/useBooks.ts` | 修改 | 添加 regenerateOutline API 调用 |
| `packages/studio/src/server.ts` | 修改 | 添加 POST /api/books/:bookId/regenerate-outline 端点 |
| `packages/core/src/agent/agent-tools.ts` | 修改 | 添加 regenerate_outline 工具 |

#### 2. Prompt 设计

```
你是一位专业的小说大纲规划师。请基于以下已确定的设定，重新规划小说的完整剧情结构。

【世界观设定】
{{story_bible_content}}

【角色设定】
{{characters_content}}

【本书规则】（必须遵守）
{{book_rules_content}}

【基础信息】
- 书名: {{title}}
- 类型: {{genre}}
- 平台: {{platform}}
- 语言: {{language}}
- 目标章节数: {{targetChapters}}
- 每章字数: {{chapterWordCount}}

【用户额外要求】
{{instruction}}

请严格按照以下格式输出三个文件的内容：

=== volume_outline.md ===
（卷纲规划，包含卷划分、每卷主题、章节安排）

=== current_state.md ===
（当前状态，包含当前剧情进度、待解决问题）

=== pending_hooks.md ===
（待填坑清单，包含所有伏笔和后续需要回收的线索）

要求：
1. 严格基于提供的设定，不要修改或扩展世界观、角色
2. 严格遵守【本书规则】中的写作风格、禁忌和约束
3. 重新设计剧情结构，确保有清晰的主线和节奏
4. 每卷有明确的起承转合
5. 章节安排合理，符合目标平台的特点
6. 伏笔和线索要前后呼应

注意：
- 题材预设(genre)已经体现在世界观设定中，无需单独处理
- 本书规则(book_rules)必须严格遵守，影响剧情走向和写作风格
```

## 详细实现步骤

### 第一步：修改 ArchitectAgent

**文件**: `packages/core/src/agents/architect.ts`

添加新方法 `regenerateOutline()`：

```typescript
async regenerateOutline(
  bookConfig: BookConfig,
  existingFoundation: {
    storyBible: string;
    characters: string;
    bookRules?: string;
  },
  options?: {
    instruction?: string;
    temperature?: number;
  }
): Promise<{
  volumeOutline: string;
  currentState: string;
  pendingHooks: string;
  chapters: Array<{
    number: number;
    title: string;
    volume: number;
    status: 'pending' | 'writing' | 'auditing' | 'revising' | 'approved';
  }>;
}>
```

**实现逻辑**：
1. 复用现有的 `_buildFoundationPrompt` 逻辑，但只读取设定部分
2. 构建专门的 `regenerateOutlinePrompt`
3. 调用 LLM 生成三个文件内容
4. 解析返回内容，提取各文件和章节信息

### 第二步：修改 PipelineRunner

**文件**: `packages/core/src/pipeline/runner.ts`

添加新方法 `regenerateOutline()`：

```typescript
async regenerateOutline(
  bookId: string,
  options?: {
    instruction?: string;
  }
): Promise<void> {
  // 1. 加载书籍配置
  const bookConfig = await this.state.loadBookConfig(bookId);
  
  // 2. 读取现有设定文件
  const storyBible = await this.readStoryFile(bookId, 'story_bible.md');
  const characters = await this.readCharacters(bookId);
  const bookRules = await this.readStoryFile(bookId, 'book_rules.md');
  
  // 3. 备份现有剧情规划文件
  await this.backupRuntimeFiles(bookId);
  
  // 4. 调用 architect.regenerateOutline
  const result = await this.architect.regenerateOutline(
    bookConfig,
    { storyBible, characters, bookRules },
    options
  );
  
  // 5. 保存新文件
  await this.writeStoryFile(bookId, 'volume_outline.md', result.volumeOutline);
  await this.writeStoryFile(bookId, 'current_state.md', result.currentState);
  await this.writeStoryFile(bookId, 'pending_hooks.md', result.pendingHooks);
  
  // 6. 解析 volume_outline 生成分卷元数据
  const { volumePlans } = await this.architect.parseVolumeOutline(result.volumeOutline);
  
  // 7. 保存 .volume-plans-meta.json（供后续生成分卷列表使用）
  const metaPath = join(bookDir, "story", ".volume-plans-meta.json");
  await writeFile(metaPath, JSON.stringify({ volumePlans }, null, 2), "utf-8");
  
  // 8. 清理 runtime 缓存（卷纲变了，章节规划需要重新生成）
  await this.clearRuntimeCache(bookId);
  
  // 9. 更新 book.json
  await this.state.updateBookConfig(bookId, {
    updatedAt: new Date().toISOString(),
  });
}
```

### 第三步：添加 CLI 命令

**文件**: `packages/cli/src/commands/plan.ts`（新增）

```typescript
import { Command } from "commander";
import { createPipelineRunner } from "@actalk/inkos-core";
import { loadProjectConfig } from "../utils/config.js";

export const planCommand = new Command("plan")
  .description("大纲管理相关命令");

planCommand
  .command("regenerate")
  .description("重新生成剧情规划（保留设定，重写卷纲/状态/待填坑）")
  .argument("<bookId>", "书籍ID")
  .option("-i, --instruction <text>", "额外的生成指导，如：优化节奏、增加反转等")
  .option("--no-backup", "不备份现有文件（危险操作）")
  .action(async (bookId, options) => {
    try {
      const config = await loadProjectConfig();
      const runner = await createPipelineRunner(config);
      
      // 确认提示
      if (!options.noBackup) {
        console.log(`即将重新生成 "${bookId}" 的剧情规划...`);
        console.log("- 保留：story_bible.md、characters/、book_rules.md");
        console.log("- 重写：volume_outline.md、current_state.md、pending_hooks.md");
        console.log("");
      }
      
      await runner.regenerateOutline(bookId, {
        instruction: options.instruction,
      });
      
      console.log(`✅ "${bookId}" 剧情规划重新生成完成！`);
      console.log(`备份文件位于: backups/${bookId}/`);
    } catch (error) {
      console.error("❌ 重新生成失败:", error);
      process.exit(1);
    }
  });
```

### 第四步：注册命令

**文件**: `packages/cli/src/index.ts`

```typescript
import { planCommand } from "./commands/plan.js";

// ... 其他导入

program.addCommand(planCommand);
```

### 第五步：添加备份功能

**文件**: `packages/core/src/pipeline/runner.ts`

添加 `backupRuntimeFiles()` 方法：

```typescript
private async backupRuntimeFiles(bookId: string): Promise<void> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = join(this.projectRoot, "backups", bookId, timestamp);
  
  const filesToBackup = [
    "story/volume_outline.md",
    "story/current_state.md",
    "story/pending_hooks.md",
  ];
  
  for (const file of filesToBackup) {
    const sourcePath = join(this.state.bookDir(bookId), file);
    const targetPath = join(backupDir, file);
    
    try {
      const content = await readFile(sourcePath, "utf-8");
      await mkdir(dirname(targetPath), { recursive: true });
      await writeFile(targetPath, content, "utf-8");
    } catch (error) {
      // 文件不存在则跳过
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }
  
  console.log(`已备份到: ${backupDir}`);
}
```

## 涉及的文件变更

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `packages/core/src/agents/architect.ts` | 修改 | 添加 `regenerateOutline()` 方法 |
| `packages/core/src/pipeline/runner.ts` | 修改 | 添加 `regenerateOutline()` 和 `backupRuntimeFiles()` |
| `packages/cli/src/commands/plan.ts` | 新增 | plan 命令及 regenerate 子命令 |
| `packages/cli/src/index.ts` | 修改 | 注册 planCommand |

## 使用示例

```bash
# 基本使用
inkos plan regenerate my-book

# 带额外指导
inkos plan regenerate my-book --instruction "增加一个中期反转，让主角陷入困境"

# 不备份（危险）
inkos plan regenerate my-book --no-backup
```

## 与现有流程的对比

| 步骤 | 初始建书 (initBook) | 重新生成卷纲 (regenerateOutline) |
|------|---------------------|----------------------------------|
| story_bible.md | ❌ 生成 | ✅ 保留现有 |
| characters/ | ❌ 生成 | ✅ 保留现有 |
| book_rules.md | ❌ 生成 | ✅ 保留现有 |
| volume_outline.md | ❌ 生成 | ❌ 重新生成 |
| current_state.md | ❌ 生成 | ❌ 重新生成 |
| pending_hooks.md | ❌ 生成 | ❌ 重新生成 |

## 测试计划

1. **单元测试**: ArchitectAgent.regenerateOutline 方法
2. **集成测试**: CLI 命令完整流程
3. **边界测试**:
   - 书籍不存在
   - 设定文件缺失
   - 多次重新生成（备份管理）
   - LLM 返回格式异常

## 注意事项

1. **备份策略**: 每次重新生成自动备份，保留历史版本
2. **幂等性**: 支持多次执行，每次基于最新设定
3. **错误处理**: 生成失败时保留原文件不变
4. **Token 消耗**: 
   - 初始建书：LLM 需生成 6 个文件（story_bible + characters + book_rules + volume_outline + current_state + pending_hooks）
   - 重写卷纲：LLM 只需生成 3 个文件（volume_outline + current_state + pending_hooks），**输出 token 减少约 50%**
   - 虽然输入 token 增加（需发送设定文件），但总体 token 消耗**明显低于**初始建书

## volume_outline 变更的影响范围

### 1. 运行时状态（需要清理）
- `story/runtime/` 下的章节规划缓存需要清理（卷纲变了，原有章节规划失效）
- `story/snapshots/` 可能需要重新生成或标记为过期

### 2. 其他 truth 文件（已包含在重新生成中）
- ✅ current_state.md（重新生成）
- ✅ pending_hooks.md（重新生成）

### 3. 缓存/元数据文件（需要更新）
- ✅ `.volume-plans-meta.json`（从新的 volume_outline 解析并更新，供后续分卷列表使用）

### 4. 不涉及变更的文件
- ❌ chapters/index.json（章节列表不变，无需更新）
- ❌ story_bible.md（保留现有设定）
- ❌ characters/（保留现有角色）
- ❌ book_rules.md（保留现有规则）

## FAQ

### Q1: book_rules.md 需要发给 LLM 吗？
**A**: 需要。book_rules 包含本书的写作风格、禁忌、约束规则等，必须发给 LLM 参考，否则生成的卷纲可能不符合原定的写作要求。

### Q2: 题材预设(genres)在什么时候发生影响？
**A**: genres 在**初始建书**时发生影响：
- 初始阶段：genres → 影响 story_bible 和 characters 的生成
- 重新生成卷纲时：genres 的影响已经体现在 story_bible 中，无需单独处理

举例：
- 如果 genre="xuanhuan"（玄幻），初始生成的 story_bible 会包含修真体系、境界划分等
- 重新生成卷纲时，LLM 从 story_bible 中读取到修真体系，自然会在卷纲中安排相应的剧情
