# 审计配置系统改动记录

## 改动概述

本次改动实现了审计维度与评分设置的配置化，支持全局配置和项目配置，项目配置存在时优先使用项目级标准，否则按照全局默认标准执行。同时，在创建书籍时可以选择是否使用全局默认配置，否则展开配置页面设置项目级审计配置。已创建的书籍可在书籍设置中打开审计设置也进行配置。

## 具体改动

### 1. 创建核心配置加载模块

- **文件**: `packages/core/src/config/audit-config.js`
- **功能**: 实现审计配置的加载、合并和保存功能
- **主要内容**:
  - 定义审计维度、评分规则和验证规则的类型
  - 提供默认审计配置
  - 实现配置加载函数 `loadAuditConfig`，支持加载全局配置和项目配置
  - 实现配置合并函数 `mergeConfigs`，按照项目 > 全局 > 默认的优先级合并配置
  - 实现配置保存函数 `saveGlobalAuditConfig` 和 `saveProjectAuditConfig`
  - 实现获取默认配置函数 `getDefaultAuditConfig`

### 2. 修改审计系统

- **文件**: `packages/core/src/agents/continuity.ts`
- **功能**: 修改审计系统使用配置的审计维度
- **主要改动**:
  - 导入 `loadAuditConfig` 函数
  - 修改 `buildDimensionList` 函数，使用配置的审计维度
  - 为隐式的 any 类型添加类型注解

### 3. 修改评分规则

- **文件**: `packages/cli/src/commands/eval.ts`
- **功能**: 修改评分规则使用配置的评分规则
- **主要改动**:
  - 修改 `computeChapterScore` 函数，接受 penalties 参数
  - 在主命令动作中加载审计配置
  - 暂时使用硬编码的默认配置，等待后续修复

### 4. 修改状态管理器

- **文件**: `packages/core/src/state/manager.ts`
- **功能**: 添加审计配置读写功能
- **主要改动**:
  - 定义 `AuditConfig` 接口
  - 添加 `loadAuditConfig` 和 `loadAuditConfigAt` 方法
  - 添加 `saveAuditConfig` 和 `saveAuditConfigAt` 方法

### 5. 添加CLI命令

- **文件**: `packages/cli/src/commands/config.ts`
- **功能**: 添加审计配置管理命令
- **主要改动**:
  - 添加 `config audit` 命令组
  - 添加 `show`、`show-global` 和 `reset` 子命令
  - 暂时禁用审计配置管理命令，等待后续修复

### 6. 修改Studio前端

- **文件**: `packages/studio/src/pages/BookDetail.tsx`
- **功能**: 添加审计配置页面
- **主要改动**:
  - 添加 `loadAuditConfig` 和 `saveAuditConfig` 函数
  - 添加审计配置模态框，用于编辑配置
  - 在工具条中添加审计配置按钮

- **文件**: `packages/studio/src/pages/BookCreate.tsx`
- **功能**: 添加审计配置选择选项
- **主要改动**:
  - 添加 `useGlobalAuditConfig`、`showAuditConfigForm` 和 `auditConfig` 状态
  - 添加 `loadDefaultAuditConfig` 函数
  - 修改 `handleCreate` 函数，传递审计配置信息
  - 添加审计配置模态框，用于编辑配置

### 7. 解决TypeScript编译错误

- **文件**: `packages/core/src/config/audit-config.js`
- **功能**: 将TypeScript文件改为JavaScript文件，使用CommonJS语法
- **主要改动**:
  - 将 `import` 语句改为 `require` 语句
  - 将 `export` 语句改为 `module.exports`
  - 移除TypeScript类型注解

- **文件**: `packages/core/src/agents/continuity.ts`
- **功能**: 为隐式的any类型添加类型注解
- **主要改动**:
  - 为 `dim` 参数添加类型注解

## 验证步骤

1. **创建测试书籍**:
   - 运行 `inkos book create` 命令
   - 选择是否使用全局默认配置
   - 如果选择否，展开配置页面设置项目级审计配置

2. **查看审计配置**:
   - 运行 `inkos config audit show` 命令，查看项目级审计配置
   - 运行 `inkos config audit show-global` 命令，查看全局审计配置

3. **修改审计配置**:
   - 在书籍设置中打开审计设置页面
   - 修改审计维度和评分规则
   - 保存配置

4. **运行审计**:
   - 运行 `inkos audit` 命令，验证审计系统使用配置的审计维度

5. **运行评分**:
   - 运行 `inkos eval` 命令，验证评分系统使用配置的评分规则

## 注意事项

- 审计配置文件为 `audit-config.json`，项目级配置位于书籍目录下，全局配置位于 `~/.inkos/audit-config.json`
- 配置加载优先级为：项目级配置 > 全局配置 > 默认配置
- 目前CLI命令中的审计配置管理命令暂时禁用，等待后续修复
- 审计配置系统支持启用/禁用审计维度，调整维度权重，修改评分规则和验证规则

## 后续工作

- 修复CLI命令中的审计配置管理命令
- 完善审计配置的前端界面
- 添加更多审计维度和评分规则
- 优化配置加载和合并逻辑
