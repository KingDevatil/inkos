# Volume Outline 拆分方法设计

## 背景

当前需要从 `volume_outline.md` 文件中拆分出每个分卷的独立卷纲内容，以便在前端按卷展示和管理。

## 解决方案：使用 ArchitectAgent 生成单卷卷纲

**推荐使用 ArchitectAgent 的 `generateVolumeDetail` 方法来生成单卷的详细卷纲**，而不是通过解析已有的 `volume_outline.md` 来拆分。这样做的好处是：

1. **格式统一**：由同一个 Agent 生成，保证格式一致性
2. **内容详细**：生成的卷纲包含更详细的章节分组、角色发展等信息
3. **上下文完整**：Agent 会参考故事设定、书籍规则等完整上下文
4. **可扩展性**：可以根据需要调整 prompt 来优化输出格式

### ArchitectAgent 方法

**位置**: `packages/core/src/agents/architect.ts`

**方法**: `generateVolumeDetail(book, bookDir, volumeId)`

**功能**: 根据已有的 `volume_outline.md` 和故事设定，生成指定分卷的详细卷纲

**输出格式**:

```markdown
### 第{N}卷：{卷名}

**章节范围**：{start}-{end}

**核心冲突**：{冲突}

**章节分组**：
- 第{start}-{start+2} 章：{第一组标题}
  - 核心事件：...
  - 关键转折：...
  - 悬念钩子：...
  
- 第{start+3}-{start+5} 章：{第二组标题}
  - ...

**角色发展**：{角色弧线}

**收益目标**：{目标}
```

### 使用示例

```typescript
import { ArchitectAgent } from "@actalk/inkos-core";

const architect = new ArchitectAgent(context);
const result = await architect.generateVolumeDetail(
  bookConfig,      // 书籍配置
  bookDir,         // 书籍目录
  volumeId         // 要生成的卷 ID（1, 2, 3...）
);

console.log(result.volumeDetail); // 输出单卷的详细卷纲
```

### API 端点

在 `packages/studio/src/api/server.ts` 中添加了相应的 API 端点：

```typescript
POST /api/books/:bookId/volumes/:volumeId/generate
```

**请求示例**:

```bash
curl -X POST http://localhost:3000/api/books/my-book/volumes/1/generate
```

**响应**:

```json
{
  "success": true,
  "volumeDetail": "### 第一卷：幽冥初开（1-50 章）\n\n**章节范围**：1-50 章\n..."
}
```

## 备选方案：解析已有卷纲

如果已有大量的 `volume_outline.md` 文件，可以使用解析器来拆分已有的卷纲。
- 资源：...

---

### 第二卷：...（51-100 章）

...
```

## 拆分方法设计

### 核心思路：多策略解析 + 启发式规则

**不要依赖单一的正则表达式**，而是采用多层解析策略：

1. **第一层：识别分卷边界**（使用宽松的正则）
2. **第二层：提取结构化信息**（兼容多种字段名和格式）
3. **第三层：启发式补全**（当某些信息缺失时智能推断）

### 方案一：健壮的解析器实现

#### 实现逻辑

```typescript
interface VolumeOutline {
  volumeId: number;
  title: string;
  chapterRange: {
    start: number;
    end: number;
  };
  coreConflict?: string;
  keyTurningPoints?: string;
  payoffGoals?: string;
  outline: string; // 完整卷纲内容
}

function parseVolumeOutline(content: string): VolumeOutline[] {
  const volumes: VolumeOutline[] = [];
  
  // 策略 1：先尝试识别分卷标题（多种格式兼容）
  const volumeBoundaries = detectVolumeBoundaries(content);
  
  if (volumeBoundaries.length === 0) {
    // 如果没有找到明确的分卷标记，尝试从表格中提取
    return extractVolumesFromTable(content);
  }
  
  // 对每个分卷区域进行解析
  for (let i = 0; i < volumeBoundaries.length; i++) {
    const boundary = volumeBoundaries[i];
    const nextBoundary = volumeBoundaries[i + 1];
    const volumeContent = content.substring(
      boundary.startIndex,
      nextBoundary ? nextBoundary.startIndex : content.length
    ).trim();
    
    const volume = parseSingleVolume(volumeContent, boundary);
    if (volume) {
      volumes.push(volume);
    }
  }
  
  return volumes;
}

interface VolumeBoundary {
  volumeId: number;
  title: string;
  chapterStart?: number;
  chapterEnd?: number;
  startIndex: number;
  endIndex: number;
}

function detectVolumeBoundaries(content: string): VolumeBoundary[] {
  const boundaries: VolumeBoundary[] = [];
  const lines = content.split('\n');
  
  // 多种分卷标题格式兼容
  const patterns = [
    // ### 第一卷：幽冥初开（1-50 章）
    /^#{2,4}\s*第 ([一二三四五六七八九十\d]+) 卷 [：:]\s*([^\n（]+?)(?:[（(](\d+)[-–](\d+) 章？[)）])?/,
    // ### 第一卷·鹤卿阁（1-50 章）
    /^#{2,4}\s*第 ([一二三四五六七八九十\d]+) 卷 [·]\s*([^\n（]+?)(?:[（(](\d+)[-–](\d+) 章？[)）])?/,
    // ### 卷一：幽冥初开
    /^#{2,4}\s*卷 ([一二三四五六七八九十\d]+)[：:]\s*(.+?)$/,
    // ### Volume 1: Title
    /^#{2,4}\s*Volume\s+(\d+)[：:]\s*(.+?)$/i
  ];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    
    for (const pattern of patterns) {
      const match = line.match(pattern);
      if (match) {
        const volumeId = parseVolumeNumber(match[1]);
        const title = match[2]?.trim() || '';
        const chapterStart = match[3] ? parseInt(match[3], 10) : undefined;
        const chapterEnd = match[4] ? parseInt(match[4], 10) : undefined;
        
        boundaries.push({
          volumeId,
          title,
          chapterStart,
          chapterEnd,
          startIndex: content.split('\n').slice(0, i).join('\n').length,
          endIndex: 0 // 稍后计算
        });
        break;
      }
    }
  }
  
  // 计算每个分卷的结束位置
  for (let i = 0; i < boundaries.length; i++) {
    if (i < boundaries.length - 1) {
      boundaries[i]!.endIndex = boundaries[i + 1]!.startIndex;
    } else {
      boundaries[i]!.endIndex = content.length;
    }
  }
  
  return boundaries;
}

function parseSingleVolume(content: string, boundary: VolumeBoundary): VolumeOutline | null {
  // 提取章节范围（如果标题中没有，尝试从内容中提取）
  let chapterStart = boundary.chapterStart;
  let chapterEnd = boundary.chapterEnd;
  
  if (chapterStart === undefined || chapterEnd === undefined) {
    const rangeInfo = extractChapterRange(content);
    if (chapterStart === undefined) chapterStart = rangeInfo.start;
    if (chapterEnd === undefined) chapterEnd = rangeInfo.end;
  }
  
  // 提取各个字段（兼容多种字段名）
  const coreConflict = extractField(content, [
    '核心冲突', 'Core Conflict', '冲突', 'Conflict'
  ]);
  
  const keyTurningPoints = extractField(content, [
    '关键转折', 'Key Turning Points', '转折点', 'Turning Points', '关键事件'
  ]);
  
  const payoffGoals = extractField(content, [
    '收益目标', 'Payoff Goal', '目标', 'Goals', '收益', '收获'
  ]);
  
  return {
    volumeId: boundary.volumeId,
    title: boundary.title,
    chapterRange: {
      start: chapterStart || 0,
      end: chapterEnd || 0
    },
    coreConflict,
    keyTurningPoints,
    payoffGoals,
    outline: content
  };
}

function extractChapterRange(content: string): { start?: number; end?: number } {
  // 尝试从"**章节范围**：1-50 章"中提取
  const rangePattern = /\*\*章节范围\*\*[：:]\s*(\d+)[-–](\d+)/i;
  const match = content.match(rangePattern);
  if (match) {
    return {
      start: parseInt(match[1], 10),
      end: parseInt(match[2], 10)
    };
  }
  
  // 尝试从表格中提取
  const tablePattern = /(\d+)[-–](\d+) 章/;
  const tableMatch = content.match(tablePattern);
  if (tableMatch) {
    return {
      start: parseInt(tableMatch[1], 10),
      end: parseInt(tableMatch[2], 10)
    };
  }
  
  return {};
}

function extractField(content: string, fieldNames: string[]): string {
  for (const fieldName of fieldNames) {
    // 尝试粗体格式：**字段名**：内容
    const boldPattern = new RegExp(
      `\\*\\*${fieldName}\\*\\*[：:]\\s*([\\s\\S]*?)(?=\\n\\*\\*|\\n---|$)`,
      'i'
    );
    const boldMatch = content.match(boldPattern);
    if (boldMatch && boldMatch[1]) {
      return boldMatch[1].trim();
    }
    
    // 尝试普通格式：字段名：内容
    const normalPattern = new RegExp(
      `${fieldName}[：:]\\s*([\\s\\S]*?)(?=\\n\\w|$)`,
      'i'
    );
    const normalMatch = content.match(normalPattern);
    if (normalMatch && normalMatch[1]) {
      return normalMatch[1].trim();
    }
  }
  
  return '';
}

function parseVolumeNumber(numStr: string): number {
  const chineseNumbers = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
  
  // 如果是阿拉伯数字
  if (/^\d+$/.test(numStr)) {
    return parseInt(numStr, 10);
  }
  
  // 如果是中文数字（简化处理，只处理 1-10）
  let result = 0;
  for (const char of numStr) {
    const index = chineseNumbers.indexOf(char);
    if (index > 0) {
      result = result * 10 + index;
    }
  }
  return result || 1;
}

function extractVolumesFromTable(content: string): VolumeOutline[] {
  // 尝试从 Markdown 表格中提取分卷信息
  const tableRegex = /\|([^|\n]+)\|([^|\n]+)\|([^|\n]+)\|([^|\n]+)\|([^|\n]+)\|/g;
  const volumes: VolumeOutline[] = [];
  let match;
  let volumeId = 1;
  
  while ((match = tableRegex.exec(content)) !== null) {
    const cells = match.slice(1).map(c => c.trim());
    // 跳过表头
    if (cells[0]?.includes('卷名') || cells[0]?.includes('Volume')) {
      continue;
    }
    
    // 尝试从卷名中提取章节范围
    const chapterRange = extractChapterRangeFromCell(cells[1] || '');
    
    volumes.push({
      volumeId: volumeId++,
      title: cells[0] || `第${volumeId}卷`,
      chapterRange: {
        start: chapterRange.start || 0,
        end: chapterRange.end || 0
      },
      coreConflict: cells[2] || '',
      keyTurningPoints: cells[3] || '',
      payoffGoals: cells[4] || '',
      outline: `### ${cells[0] || `第${volumeId}卷`}\n\n**核心冲突**：${cells[2] || ''}`
    });
  }
  
  return volumes;
}

function extractChapterRangeFromCell(cell: string): { start: number; end: number } {
  const match = cell.match(/(\d+)[-–](\d+)/);
  if (match) {
    return {
      start: parseInt(match[1], 10),
      end: parseInt(match[2], 10)
    };
  }
  return { start: 0, end: 0 };
}
```

### 方案二：基于 Markdown 解析器

#### 优点
- 更健壮，能处理格式变化
- 可以保留 Markdown 结构
- 易于扩展

#### 缺点
- 需要额外依赖（如 `marked` 或 `markdown-it`）
- 实现相对复杂

#### 实现逻辑

```typescript
import { marked } from 'marked';

interface VolumeOutline {
  volumeId: number;
  title: string;
  chapterRange: {
    start: number;
    end: number;
  };
  outline: string;
}

async function parseVolumeOutlineWithMarkdown(content: string): Promise<VolumeOutline[]> {
  const tokens = marked.lexer(content);
  const volumes: VolumeOutline[] = [];
  let currentVolume: Partial<VolumeOutline> | null = null;
  let currentContent: string[] = [];
  
  for (const token of tokens) {
    if (token.type === 'heading' && token.depth === 3) {
      // 保存上一个卷
      if (currentVolume) {
        currentVolume.outline = currentContent.join('\n').trim();
        volumes.push(currentVolume as VolumeOutline);
      }
      
      // 解析新卷的标题
      const titleMatch = (token.text || '').match(/第 ([一二三四五六七八九十\d]+) 卷 [：:]\s*([^\n（]+)(?:（(\d+)-(\d+) 章）)?/);
      
      currentVolume = {
        volumeId: parseVolumeNumber(titleMatch?.[1] || '0'),
        title: titleMatch?.[2]?.trim() || '',
        chapterRange: {
          start: parseInt(titleMatch?.[3] || '0', 10),
          end: parseInt(titleMatch?.[4] || '0', 10)
        }
      };
      currentContent = [];
    } else if (currentVolume) {
      // 收集当前卷的内容
      currentContent.push((token as any).raw || '');
    }
  }
  
  // 保存最后一个卷
  if (currentVolume) {
    currentVolume.outline = currentContent.join('\n').trim();
    volumes.push(currentVolume as VolumeOutline);
  }
  
  return volumes;
}
```

## 推荐方案

**推荐使用方案一（正则表达式解析）**，原因如下：

1. **简单高效**：不需要额外依赖，实现简单
2. **足够健壮**：volume_outline.md 的格式由 ArchitectAgent 严格控制，变化可能性小
3. **易于调试**：正则表达式容易测试和验证
4. **性能更好**：不需要解析整个 Markdown AST

## API 设计

### 后端 API

在 `packages/studio/src/api/server.ts` 中添加：

```typescript
// Get specific volume outline
app.get("/api/books/:id/volumes/:volumeId/outline", async (c) => {
  const id = c.req.param("id");
  const volumeId = parseInt(c.req.param("volumeId"), 10);

  try {
    const pipeline = new PipelineRunner(await buildPipelineConfig());
    const bookDir = pipeline["state"].bookDir(id);
    const outlinePath = join(bookDir, "story", "volume_outline.md");
    
    const outlineContent = await readFile(outlinePath, "utf-8");
    const volumes = parseVolumeOutline(outlineContent);
    
    const volume = volumes.find(v => v.volumeId === volumeId);
    if (!volume) {
      return c.json({ error: `Volume ${volumeId} not found` }, 404);
    }
    
    return c.json({
      ok: true,
      volumeId: volume.volumeId,
      title: volume.title,
      chapterRange: volume.chapterRange,
      outline: volume.outline
    });
  } catch (e) {
    return c.json({ error: String(e) }, 500);
  }
});

// Get all volume outlines
app.get("/api/books/:id/volume-outlines", async (c) => {
  const id = c.req.param("id");

  try {
    const pipeline = new PipelineRunner(await buildPipelineConfig());
    const bookDir = pipeline["state"].bookDir(id);
    const outlinePath = join(bookDir, "story", "volume_outline.md");
    
    const outlineContent = await readFile(outlinePath, "utf-8");
    const volumes = parseVolumeOutline(outlineContent);
    
    return c.json({
      ok: true,
      volumes: volumes.map(v => ({
        volumeId: v.volumeId,
        title: v.title,
        chapterRange: v.chapterRange
      }))
    });
  } catch (e) {
    return c.json({ error: String(e) }, 500);
  }
});
```

### 前端使用

```typescript
// 加载所有分卷
const loadVolumeOutlines = async (bookId: string) => {
  const response = await fetchJson(`/books/${bookId}/volume-outlines`);
  return response.volumes;
};

// 加载特定分卷的卷纲
const loadVolumeOutline = async (bookId: string, volumeId: number) => {
  const response = await fetchJson(`/books/${bookId}/volumes/${volumeId}/outline`);
  return response;
};
```

## 测试用例

### 测试数据 1：黄泉格式

```typescript
const testContent1 = `## 卷纲总览

### 第一卷：幽冥初开（1-50 章）

**章节范围**：1-50 章
**核心冲突**：顾家遗孤身份暴露，血煞宗追杀
**关键转折**：
- 第 10 章：首次吞噬亡魂
- 第 20 章：妹妹被绑架

**收益目标**：
- 境界：炼气→筑基

---

### 第二卷：幽冥渊（51-100 章）

**章节范围**：51-100 章
**核心冲突**：闯入幽冥渊

---`;

// 期望输出
const expectedOutput1 = [
  {
    volumeId: 1,
    title: '幽冥初开',
    chapterRange: { start: 1, end: 50 },
    coreConflict: '顾家遗孤身份暴露，血煞宗追杀',
    keyTurningPoints: '- 第 10 章：首次吞噬亡魂\n- 第 20 章：妹妹被绑架',
    payoffGoals: '- 境界：炼气→筑基',
    outline: '### 第一卷：幽冥初开（1-50 章）\n\n**章节范围**：1-50 章\n**核心冲突**：顾家遗孤身份暴露，血煞宗追杀\n**关键转折**：\n- 第 10 章：首次吞噬亡魂\n- 第 20 章：妹妹被绑架\n\n**收益目标**：\n- 境界：炼气→筑基\n\n---'
  },
  {
    volumeId: 2,
    title: '幽冥渊',
    chapterRange: { start: 51, end: 100 },
    coreConflict: '闯入幽冥渊',
    outline: '### 第二卷：幽冥渊（51-100 章）\n\n**章节范围**：51-100 章\n**核心冲突**：闯入幽冥渊\n\n---'
  }
];
```

### 测试数据 2：无限回响格式（表格 + 简化）

```typescript
const testContent2 = `## 卷纲总览

| 卷名 | 章节 | 核心冲突 | 关键转折 | 收益目标 |
|------|------|----------|----------|----------|
| 第一卷：寂静入门 | 1-10 | 生存规则学习 | 发现妹妹的线索 | 建立世界观 |

---

### 第一卷：寂静入门（第 1-10 章）

**核心冲突**：如何在原点中生存 72 小时

**章节规划**：
- 第 1-3 章：进入原点
- 第 4-6 章：遇见沈听雨

**关键转折**：第 6 章发现妹妹留下的标记

---`;

// 期望输出
const expectedOutput2 = [
  {
    volumeId: 1,
    title: '寂静入门',
    chapterRange: { start: 1, end: 10 },
    coreConflict: '如何在原点中生存 72 小时',
    keyTurningPoints: '第 6 章发现妹妹留下的标记',
    outline: '...'
  }
];
```

### 测试数据 3：符道天途格式（超详细）

```typescript
const testContent3 = `### 第一卷：鹤卿阁（1-50 章）

**卷名**：鹤卿阁·禁忌之地

**章节范围**：1-50 章

**核心冲突**：父亲之死的初步线索 + 墨老暧昧身份的揭露

**章节节奏**：

| 章节 | 核心事件 | 翻页钩子 |
|------|----------|----------|
| 1 | 深夜加班触发地下室符印 | 那个血符残片上的纹路——父亲在害怕什么？ |

**关键转折**：第 31 章温小棠透露二十年前事故

**收益目标**：主角确立调查方向

---`;

// 期望输出
const expectedOutput3 = [
  {
    volumeId: 1,
    title: '鹤卿阁',
    chapterRange: { start: 1, end: 50 },
    coreConflict: '父亲之死的初步线索 + 墨老暧昧身份的揭露',
    keyTurningPoints: '第 31 章温小棠透露二十年前事故',
    payoffGoals: '主角确立调查方向',
    outline: '...'
  }
];
```

## 实现步骤

1. 在 `packages/core/src/utils/volume-outline-parser.ts` 创建解析工具函数
2. 在 `packages/studio/src/api/server.ts` 添加 API 端点
3. 在 `packages/studio/src/pages/BookDetail.tsx` 修改前端显示逻辑
4. 编写单元测试验证解析正确性
5. 测试不同格式的 volume_outline.md 文件
