# InkOS Studio API 完整功能列表

本文档列出了 Studio API 中已实现的所有端点，以及与 CLI 功能的对比。

## API 端点概览

### 书籍管理 (Books)

| 方法 | 端点 | 描述 | 对应 CLI 命令 |
|------|------|------|--------------|
| GET | `/api/books` | 列出所有书籍 | `inkos book list` |
| POST | `/api/books/create` | 创建新书籍 | `inkos book create` |
| GET | `/api/books/:id` | 获取书籍详情 | - |
| PUT | `/api/books/:id` | 更新书籍设置 | `inkos book update` |
| DELETE | `/api/books/:id` | 删除书籍 | `inkos book delete` |
| GET | `/api/books/:id/create-status` | 获取书籍创建状态 | - |

### 章节管理 (Chapters)

| 方法 | 端点 | 描述 | 对应 CLI 命令 |
|------|------|------|--------------|
| GET | `/api/books/:id/chapters/:num` | 获取章节内容 | - |
| PUT | `/api/books/:id/chapters/:num` | 保存章节内容 | - |
| DELETE | `/api/books/:id/chapters/:chapter` | 删除章节 | - |
| PUT | `/api/books/:id/chapters/order` | 更新章节顺序 | - |
| POST | `/api/books/:id/chapters/fix-order` | 修复章节顺序 | - |

### 章节操作 (Chapter Operations)

| 方法 | 端点 | 描述 | 对应 CLI 命令 |
|------|------|------|--------------|
| POST | `/api/books/:id/write-next` | 写下一章 | `inkos write next` |
| POST | `/api/books/:id/draft` | 起草章节 | `inkos draft` |
| POST | `/api/books/:id/rewrite/:chapter` | 重写章节 | - |
| POST | `/api/books/:id/resync/:chapter` | 重新同步章节 | - |

### 审核与修订 (Audit & Revise)

| 方法 | 端点 | 描述 | 对应 CLI 命令 |
|------|------|------|--------------|
| POST | `/api/books/:id/audit/:chapter` | 审核章节 | `inkos audit` |
| POST | `/api/books/:id/revise/:chapter` | 修订章节 | `inkos revise` |
| POST | `/api/books/:id/chapters/:num/approve` | 批准章节 | `inkos review approve` |
| POST | `/api/books/:id/chapters/:num/reject` | 拒绝章节 | `inkos review reject` |
| POST | `/api/books/:id/approve-all` | 批量批准所有待审核章节 | `inkos review approve-all` |

### AI 检测 (AI Detection)

| 方法 | 端点 | 描述 | 对应 CLI 命令 |
|------|------|------|--------------|
| POST | `/api/books/:id/detect/:chapter` | 检测章节 AI 痕迹 | `inkos detect` |
| POST | `/api/books/:id/detect-all` | 检测所有章节 | `inkos detect --all` |
| GET | `/api/books/:id/detect/stats` | 获取检测统计 | `inkos detect --stats` |

### 导出 (Export)

| 方法 | 端点 | 描述 | 对应 CLI 命令 |
|------|------|------|--------------|
| GET | `/api/books/:id/export` | 导出书籍（下载） | `inkos export` |
| POST | `/api/books/:id/export-save` | 保存导出到项目目录 | - |
| POST | `/api/batch/export` | 批量导出多本书籍 | - |

### 大纲与设定 (Outline & Foundation)

| 方法 | 端点 | 描述 | 对应 CLI 命令 |
|------|------|------|--------------|
| POST | `/api/books/:id/regenerate-outline` | 重新生成大纲 | - |
| GET | `/api/books/:id/truth/:file` | 获取 truth 文件内容 | - |
| PUT | `/api/books/:id/truth/:file` | 更新 truth 文件 | - |
| GET | `/api/books/:id/truth` | 列出所有 truth 文件 | - |

### 题材管理 (Genres)

| 方法 | 端点 | 描述 | 对应 CLI 命令 |
|------|------|------|--------------|
| GET | `/api/genres` | 列出所有题材 | `inkos genre list` |
| GET | `/api/genres/:id` | 获取题材详情 | `inkos genre show` |
| POST | `/api/genres/:id/copy` | 复制内置题材到项目 | `inkos genre copy` |
| POST | `/api/genres/create` | 创建新题材 | - |
| PUT | `/api/genres/:id` | 编辑题材 | - |
| DELETE | `/api/genres/:id` | 删除题材 | - |

### 同人/Canon 管理 (Fanfic)

| 方法 | 端点 | 描述 | 对应 CLI 命令 |
|------|------|------|--------------|
| POST | `/api/fanfic/init` | 初始化同人书籍 | `inkos fanfic init` |
| GET | `/api/books/:id/fanfic` | 获取同人设定 | `inkos fanfic show` |
| POST | `/api/books/:id/fanfic/refresh` | 刷新同人设定 | `inkos fanfic refresh` |
| POST | `/api/books/:id/import/canon` | 导入 canon | `inkos import canon` |

### 样式与导入 (Style & Import)

| 方法 | 端点 | 描述 | 对应 CLI 命令 |
|------|------|------|--------------|
| POST | `/api/style/analyze` | 分析文本样式 | `inkos style analyze` |
| POST | `/api/books/:id/style/import` | 导入样式到书籍 | `inkos style import` |
| POST | `/api/books/:id/import/chapters` | 导入章节 | `inkos import chapters` |

### 计划与整合 (Plan & Consolidate)

| 方法 | 端点 | 描述 | 对应 CLI 命令 |
|------|------|------|--------------|
| POST | `/api/books/:id/plan` | 计划下一章 | `inkos plan chapter` |
| POST | `/api/books/:id/consolidate` | 整合章节摘要 | `inkos consolidate` |

### 项目配置 (Project Config)

| 方法 | 端点 | 描述 | 对应 CLI 命令 |
|------|------|------|--------------|
| GET | `/api/project` | 获取项目信息 | `inkos status` |
| PUT | `/api/project` | 更新项目配置 | - |
| POST | `/api/project/language` | 设置项目语言 | - |
| GET | `/api/project/model-overrides` | 获取模型覆盖配置 | - |
| PUT | `/api/project/model-overrides` | 更新模型覆盖配置 | - |
| GET | `/api/project/notify` | 获取通知渠道 | - |
| PUT | `/api/project/notify` | 更新通知渠道 | - |

### 全局配置 (Global Config)

| 方法 | 端点 | 描述 | 对应 CLI 命令 |
|------|------|------|--------------|
| GET | `/api/config/global` | 获取全局配置 | `inkos config global` |
| PUT | `/api/config/global` | 更新全局配置 | `inkos config global` |
| DELETE | `/api/config/global` | 删除全局配置 | - |

### 审核配置 (Audit Config)

| 方法 | 端点 | 描述 | 对应 CLI 命令 |
|------|------|------|--------------|
| GET | `/api/audit-config/default` | 获取默认审核配置 | - |
| GET | `/api/books/:id/audit-config` | 获取书籍审核配置 | - |
| PUT | `/api/books/:id/audit-config` | 更新书籍审核配置 | - |

### 守护进程 (Daemon)

| 方法 | 端点 | 描述 | 对应 CLI 命令 |
|------|------|------|--------------|
| GET | `/api/daemon` | 获取守护进程状态 | `inkos daemon status` |
| POST | `/api/daemon/start` | 启动守护进程 | `inkos daemon start` |
| POST | `/api/daemon/stop` | 停止守护进程 | `inkos daemon stop` |

### 雷达 (Radar)

| 方法 | 端点 | 描述 | 对应 CLI 命令 |
|------|------|------|--------------|
| POST | `/api/radar/scan` | 执行雷达扫描 | `inkos radar` |

### 工具与诊断 (Tools & Diagnostics)

| 方法 | 端点 | 描述 | 对应 CLI 命令 |
|------|------|------|--------------|
| GET | `/api/doctor` | 环境健康检查 | `inkos doctor` |
| GET | `/api/logs` | 获取日志 | - |
| GET | `/api/books/:id/analytics` | 获取分析数据 | `inkos analytics` |
| POST | `/api/books/:id/repair-state` | 修复书籍状态 | - |

### Agent 与事件 (Agent & Events)

| 方法 | 端点 | 描述 | 对应 CLI 命令 |
|------|------|------|--------------|
| POST | `/api/agent` | 执行 Agent 指令 | `inkos agent` |
| GET | `/api/events` | SSE 事件流 | - |

## CLI 与 Studio API 功能对比总结

### 已完全覆盖的 CLI 功能

- ✅ `inkos book create/list/update/delete`
- ✅ `inkos write next`
- ✅ `inkos draft`
- ✅ `inkos audit`
- ✅ `inkos revise`
- ✅ `inkos review approve/reject/approve-all`
- ✅ `inkos detect`
- ✅ `inkos export`
- ✅ `inkos genre list/show/copy`
- ✅ `inkos fanfic init/show/refresh`
- ✅ `inkos style analyze/import`
- ✅ `inkos import chapters/canon`
- ✅ `inkos plan chapter`
- ✅ `inkos consolidate`
- ✅ `inkos daemon start/stop/status`
- ✅ `inkos radar`
- ✅ `inkos doctor`
- ✅ `inkos analytics`
- ✅ `inkos agent`
- ✅ `inkos config global`
- ✅ `inkos status`

### Studio API 特有功能

- 实时 SSE 事件流 (`/api/events`)
- 批量操作 API (`/api/batch/export`)
- 章节顺序管理 (`/api/books/:id/chapters/order`, `/api/books/:id/chapters/fix-order`)
- 书籍创建状态查询 (`/api/books/:id/create-status`)
- 大纲重新生成 (`/api/books/:id/regenerate-outline`)
- 题材创建/编辑/删除 (`/api/genres/create`, `/api/genres/:id`, `DELETE /api/genres/:id`)
- 全局配置管理 (`/api/config/global`)
- 审核配置管理 (`/api/audit-config/*`)
- Truth 文件浏览器 (`/api/books/:id/truth`)

## 最近更新

### 2025-04-10

1. **修复了构建错误**
   - 修复了 `approve-all` 端点中使用的 `updateChapterStatus` 方法不存在的问题
   - 修复了 `repair-state` 端点中使用的 `rebuildChapterIndex` 方法不存在的问题

2. **新增 API 端点**
   - `POST /api/books/:id/plan` - 计划下一章内容
   - `POST /api/books/:id/consolidate` - 整合章节摘要

3. **新增批量操作端点**
   - `POST /api/books/:id/approve-all` - 批量批准所有待审核章节
   - `POST /api/books/:id/repair-state` - 修复书籍状态不一致问题
   - `POST /api/batch/export` - 批量导出多本书籍

4. **新增全局配置管理**
   - `GET /api/config/global` - 获取全局配置
   - `PUT /api/config/global` - 更新全局配置
   - `DELETE /api/config/global` - 删除全局配置

---

*文档生成时间: 2025-04-10*
