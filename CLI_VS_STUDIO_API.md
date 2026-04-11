# CLI 与 Studio API 功能对比

## 功能覆盖情况

### ✅ Studio API 已支持的功能

| 功能 | API 端点 | 说明 |
|------|----------|------|
| 创建书籍 | POST /api/books/create | 支持 brief 参数 |
| 获取书籍列表 | GET /api/books | |
| 获取书籍详情 | GET /api/books/:id | |
| 更新书籍 | PUT /api/books/:id | 状态、字数、目标章节数 |
| 删除书籍 | DELETE /api/books/:id | |
| 写作下一章 | POST /api/books/:id/write-next | |
| 草稿模式 | POST /api/books/:id/draft | |
| 获取章节内容 | GET /api/books/:id/chapters/:num | |
| 更新章节 | PUT /api/books/:id/chapters/:num | |
| 删除章节 | DELETE /api/books/:id/chapters/:chapter | |
| 批准章节 | POST /api/books/:id/chapters/:num/approve | |
| 拒绝章节 | POST /api/books/:id/chapters/:num/reject | |
| 重写章节 | POST /api/books/:id/rewrite/:chapter | |
| 重新同步章节 | POST /api/books/:id/resync/:chapter | |
| 审核章节 | POST /api/books/:id/audit/:chapter | |
| 修订章节 | POST /api/books/:id/revise/:chapter | |
| 修复章节顺序 | POST /api/books/:id/chapters/fix-order | |
| 调整章节顺序 | PUT /api/books/:id/chapters/order | |
| 导出书籍 | POST /api/books/:id/export-save | txt/md/epub |
| 重新生成大纲 | POST /api/books/:id/regenerate-outline | |
| 获取题材列表 | GET /api/genres | |
| 获取题材详情 | GET /api/genres/:id | |
| 复制题材 | POST /api/genres/:id/copy | |
| 创建题材 | POST /api/genres/create | |
| 更新题材 | PUT /api/genres/:id | |
| 删除题材 | DELETE /api/genres/:id | |
| 获取审计配置 | GET /api/books/:id/audit-config | |
| 更新审计配置 | PUT /api/books/:id/audit-config | |
| 获取默认审计配置 | GET /api/audit-config/default | |
| 获取 Truth 文件 | GET /api/books/:id/truth/:file | |
| 更新 Truth 文件 | PUT /api/books/:id/truth/:file | |
| 获取数据分析 | GET /api/books/:id/analytics | |
| 导入章节 | POST /api/books/:id/import/chapters | |
| 导入 Canon | POST /api/books/:id/import/canon | |
| 反检测分析 | POST /api/books/:id/detect/:chapter | |
| 全书籍反检测 | POST /api/books/:id/detect-all | |
| 获取反检测统计 | GET /api/books/:id/detect/stats | |
| 同人初始化 | POST /api/fanfic/init | |
| 获取同人 Canon | GET /api/books/:id/fanfic | |
| 刷新同人 Canon | POST /api/books/:id/fanfic/refresh | |
| 风格分析 | POST /api/style/analyze | |
| 导入风格 | POST /api/books/:id/style/import | |
| 扫描项目 | POST /api/radar/scan | |
| 项目诊断 | GET /api/doctor | |
| 获取项目配置 | GET /api/project | |
| 更新项目配置 | PUT /api/project | |
| 获取模型覆盖 | GET /api/project/model-overrides | |
| 更新模型覆盖 | PUT /api/project/model-overrides | |
| 获取通知配置 | GET /api/project/notify | |
| 更新通知配置 | PUT /api/project/notify | |
| 设置语言 | POST /api/project/language | |
| 启动守护进程 | POST /api/daemon/start | |
| 停止守护进程 | POST /api/daemon/stop | |
| 获取守护进程状态 | GET /api/daemon | |
| 获取日志 | GET /api/logs | |
| SSE 事件流 | GET /api/events | |

---

### ❌ Studio API 缺失的功能（仅 CLI 支持）

| 功能 | CLI 命令 | 说明 | 优先级 |
|------|----------|------|--------|
| **一键批准所有** | `inkos review approve-all` | 批量批准所有待审核章节 | ⭐⭐⭐⭐⭐ |
| **修复状态** | `inkos write repair-state` | 修复章节状态不一致 | ⭐⭐⭐⭐ |
| **Daemon 模式** | `inkos daemon` | 后台自动写作 | ⭐⭐⭐⭐ |
| **批量导出** | `inkos book export` | 批量导出多本书籍 | ⭐⭐⭐ |
| **计划章节** | `inkos plan chapter` | 规划下一章内容 | ⭐⭐⭐ |
| **合成章节** | `inkos compose chapter` | 合成指定章节 | ⭐⭐⭐ |
| **配置管理** | `inkos config *` | 全局/项目配置管理 | ⭐⭐ |
| **模型配置** | `inkos config set-model` | 设置模型覆盖 | ⭐⭐ |

---

## 建议的 Agent API 增强

### 高优先级（立即实现）

#### 1. 一键批准所有
```http
POST /api/books/:id/approve-all
```
批量批准所有 `ready-for-review` 状态的章节。

#### 2. 修复状态
```http
POST /api/books/:id/repair-state
```
修复书籍状态不一致问题。

#### 3. Daemon 模式控制
```http
POST /api/daemon/enable-auto-write
POST /api/daemon/disable-auto-write
GET  /api/daemon/auto-write-status
```
控制后台自动写作功能。

### 中优先级（后续实现）

#### 4. 批量操作
```http
POST /api/batch/export
POST /api/batch/approve
```

#### 5. 配置管理 API
```http
GET    /api/config
PUT    /api/config
GET    /api/config/global
PUT    /api/config/global
```

---

## 当前架构建议

### 方案 1：扩展 Studio API（推荐）
在现有的 server.ts 中添加缺失的 API 端点，让 Agent 直接调用 Studio 服务。

**优点**:
- 代码复用，维护简单
- 数据一致性保证
- 实时事件通知（SSE）

**缺点**:
- 需要修改现有代码
- API 和 Web 耦合

### 方案 2：独立 Agent 服务
创建独立的 Agent 服务，直接调用 core 包的功能。

**优点**:
- 完全独立，可单独扩展
- 不依赖 Studio 服务

**缺点**:
- 代码重复
- 需要处理数据同步
- 增加系统复杂度

### 方案 3：CLI 容器化（最简单）
直接将 CLI 容器化，通过 volume 共享数据。

**优点**:
- 无需开发，立即可用
- 功能完整（100% CLI 功能）

**缺点**:
- 不是 HTTP API，调用不便
- 需要处理并发问题

---

## 推荐实现

**短期**：方案 3（CLI 容器化）
- 立即满足自动化需求
- 所有 CLI 命令可用

**中期**：方案 1（扩展 Studio API）
- 添加缺失的高优先级 API
- 提供更好的 HTTP 接口

**长期**：方案 2（独立 Agent 服务）
- 当需要大规模扩展时
- 微服务架构

---

*分析时间: 2026-04-10*
