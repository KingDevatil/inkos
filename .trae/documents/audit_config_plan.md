# 审计维度与评分设置配置化实现计划

## 1. 项目现状分析

### 当前审计系统实现
- 审计维度硬编码在系统中（33个维度）
- 评分规则硬编码在 `packages/cli/src/commands/eval.ts` 中
- 审计逻辑在 `packages/core/src/agents/continuity.ts` 和 `packages/core/src/pipeline/runner.ts` 中实现
- 缺乏配置机制，无法自定义审计维度和评分规则

### 需求分析
- 支持全局配置和项目级配置
- 项目配置优先于全局配置
- 创建书籍时可选择使用全局默认配置或自定义项目配置
- 已创建书籍可在设置中修改审计配置

## 2. 实现计划

### 2.1 配置文件结构设计

#### 全局配置文件
- **路径**：`~/.inkos/audit-config.json`
- **结构**：
  ```json
  {
    "dimensions": [
      {
        "id": "ooc",
        "name": "OOC检查",
        "enabled": true,
        "weight": 1.0
      },
      // 其他32个维度...
    ],
    "scoring": {
      "baseScore": 100,
      "penalties": {
        "auditIssue": 5,
        "aiTellDensity": 20,
        "paragraphWarning": 3
      },
      "weights": {
        "auditPassRate": 0.3,
        "aiTellDensity": 0.25,
        "paragraphWarnings": 0.15,
        "hookResolveRate": 0.2,
        "duplicateTitles": 0.1
      }
    },
    "validationRules": {
      "bannedPatterns": ["不是……而是……"],
      "bannedDashes": true,
      "transitionWordDensity": 1,
      "fatigueWordLimit": 1,
      "maxConsecutiveLe": 6,
      "maxParagraphLength": 300
    }
  }
  ```

#### 项目配置文件
- **路径**：`{bookDir}/audit-config.json`
- **结构**：与全局配置相同，但只包含需要覆盖的部分

### 2.2 代码修改

#### 1. 核心配置加载模块
- **文件**：`packages/core/src/config/audit-config.ts`
- **功能**：
  - 加载全局配置
  - 加载项目配置
  - 合并配置（项目配置优先）
  - 提供配置访问接口

#### 2. 审计系统修改
- **文件**：`packages/core/src/agents/continuity.ts`
- **修改**：
  - 从配置中读取审计维度
  - 根据配置启用/禁用维度
  - 使用配置的权重计算分数

#### 3. 评分规则修改
- **文件**：`packages/cli/src/commands/eval.ts`
- **修改**：
  - 从配置中读取评分规则
  - 使用配置的权重和惩罚值

#### 4. 状态管理器修改
- **文件**：`packages/core/src/state/state-manager.ts`
- **修改**：
  - 加载和保存项目级审计配置
  - 提供配置读写接口

#### 5. CLI 命令添加
- **文件**：`packages/cli/src/commands/config.ts`
- **修改**：
  - 添加 `inkos config audit` 命令
  - 支持查看和修改全局审计配置

#### 6. Studio 前端修改
- **文件**：`packages/studio/src/pages/BookDetail.tsx`
- **修改**：
  - 添加审计配置页面
  - 支持编辑项目级审计配置

- **文件**：`packages/studio/src/pages/BookCreate.tsx`
- **修改**：
  - 添加审计配置选择选项
  - 支持创建时自定义审计配置

### 2.3 实现步骤

1. **创建配置加载模块**
   - 实现 `audit-config.ts` 模块
   - 支持加载全局和项目配置

2. **修改审计系统**
   - 更新 `continuity.ts` 使用配置的审计维度
   - 实现基于配置的评分计算

3. **修改评分规则**
   - 更新 `eval.ts` 使用配置的评分规则

4. **修改状态管理器**
   - 添加审计配置的读写功能

5. **添加 CLI 命令**
   - 实现 `inkos config audit` 命令

6. **修改 Studio 前端**
   - 添加审计配置页面
   - 修改书籍创建页面

7. **测试和验证**
   - 测试配置加载和合并
   - 测试审计系统使用配置
   - 测试前端配置界面

## 3. 技术实现要点

### 3.1 配置优先级
- 项目配置存在时，优先使用项目配置
- 项目配置中未定义的部分，使用全局配置
- 全局配置未定义的部分，使用默认值

### 3.2 配置默认值
- 提供完整的默认配置，确保系统在无配置时正常运行
- 默认配置包含所有33个审计维度

### 3.3 前端界面设计
- 审计配置页面使用表单形式
- 支持启用/禁用每个审计维度
- 支持调整评分权重和惩罚值
- 提供配置预览和保存功能

### 3.4 向后兼容性
- 确保现有书籍在无配置文件时正常运行
- 自动为现有书籍生成默认配置文件

## 4. 风险评估

### 4.1 潜在风险
- 配置文件格式错误导致系统崩溃
- 配置项缺失导致功能异常
- 前端配置界面复杂度高

### 4.2 风险缓解
- 添加配置验证机制
- 提供详细的配置文档
- 实现配置错误处理和默认值回退
- 前端界面添加配置验证

## 5. 预期成果

### 5.1 功能特性
- 支持全局和项目级审计配置
- 创建书籍时可选择配置方式
- 已创建书籍可修改审计配置
- 配置优先级明确（项目 > 全局 > 默认）

### 5.2 用户体验
- 提供直观的配置界面
- 配置修改实时生效
- 配置错误有明确提示
- 支持配置导入/导出

### 5.3 技术指标
- 配置加载时间 < 100ms
- 审计系统性能不受配置影响
- 配置文件大小 < 10KB

## 6. 实施时间表

1. **配置加载模块**：1-2 天
2. **审计系统修改**：2-3 天
3. **评分规则修改**：1 天
4. **状态管理器修改**：1 天
5. **CLI 命令添加**：1 天
6. **Studio 前端修改**：2-3 天
7. **测试和验证**：1-2 天

总计：约 9-13 天完成全部实现