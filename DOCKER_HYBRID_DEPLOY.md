# InkOS 混合部署方案

同时支持 **Web UI 访问** 和 **Agent API 调用** 的 Docker 部署方案。

---

## 架构图

```
┌─────────────────────────────────────────────────────────────┐
│                         用户访问                              │
└──────────────────────┬──────────────────────────────────────┘
                       │
       ┌───────────────┴───────────────┐
       │                               │
       ▼                               ▼
┌──────────────┐              ┌──────────────┐
│   Web 浏览器  │              │  Agent 客户端 │
│  ( humans )  │              │  ( scripts ) │
└──────┬───────┘              └──────┬───────┘
       │                             │
       │  http://localhost:8080      │  http://localhost:3001
       │                             │
       └──────────────┬──────────────┘
                      │
              ┌───────▼────────┐
              │ Nginx (8080)   │  ← 统一入口
              └───────┬────────┘
                      │
       ┌──────────────┼──────────────┐
       │              │              │
       ▼              ▼              ▼
┌──────────┐  ┌──────────┐  ┌──────────┐
│  Studio  │  │  Studio  │  │  Agent   │
│  Web UI  │  │   API    │  │   API    │
│  :3000   │  │  :3000   │  │  :3001   │
└────┬─────┘  └────┬─────┘  └────┬─────┘
     │             │             │
     └─────────────┴─────────────┘
                   │
          ┌────────▼────────┐
          │  共享数据卷      │
          │  /app/books     │
          └─────────────────┘
```

---

## 服务说明

| 服务 | 端口 | 用途 | 访问方式 |
|------|------|------|----------|
| **nginx** | 80/443 | 统一入口 | http://localhost |
| **inkos-studio** | 3000 | Web UI + API | 内部访问 |
| **inkos-agent** | 3001 | Agent API | http://localhost:3001 |

---

## 快速开始

### 1. 准备环境

```bash
# 克隆项目
git clone https://github.com/KingDevatil/inkos.git
cd inkos

# 创建环境变量文件
cat > .env << EOF
OPENAI_API_KEY=your-api-key-here
OPENAI_BASE_URL=https://api.openai.com/v1
EOF
```

### 2. 启动服务

```bash
# 使用混合部署配置
docker-compose -f docker-compose.hybrid.yml up -d

# 查看服务状态
docker-compose -f docker-compose.hybrid.yml ps

# 查看日志
docker-compose -f docker-compose.hybrid.yml logs -f
```

### 3. 验证部署

```bash
# 检查 Web UI
curl http://localhost

# 检查 Agent API
curl http://localhost:3001/health

# 检查 Studio API
curl http://localhost/api/health
```

---

## 使用方式

### 方式一：Web UI（人工操作）

```
浏览器访问: http://localhost

功能:
- 创建/管理书籍
- 查看章节列表
- 审计配置
- 重新生成大纲
- 导出书籍
```

### 方式二：Agent API（程序调用）

```bash
# 创建书籍
curl -X POST http://localhost:3001/api/books/create \
  -H "Content-Type: application/json" \
  -d '{
    "title": "我的小说",
    "genre": "xianxia",
    "chapterWordCount": 3000,
    "targetChapters": 100
  }'

# 写作下一章
curl -X POST http://localhost:3001/api/books/{bookId}/write

# 获取书籍列表
curl http://localhost:3001/api/books

# 获取章节内容
curl http://localhost:3001/api/books/{bookId}/chapters/{number}
```

### 方式三：CLI 工具（本地调用远程服务）

```bash
# 配置远程 API 地址
export INKOS_API_URL=http://localhost:3001

# 使用 CLI 调用远程服务
inkos book list
inkos book write --id my-book
```

---

## API 端点列表

### Studio API (通过 Nginx 代理)
| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/books` | GET | 获取书籍列表 |
| `/api/books/create` | POST | 创建书籍 |
| `/api/books/:id` | GET | 获取书籍详情 |
| `/api/books/:id/write` | POST | 写作下一章 |
| `/api/books/:id/draft` | POST | 草稿模式写作 |
| `/api/books/:id/chapters/:num` | GET | 获取章节内容 |
| `/api/books/:id/chapters/:num/approve` | POST | 批准章节 |
| `/api/books/:id/regenerate-outline` | POST | 重新生成大纲 |
| `/api/sse` | GET | 实时事件流 |

### Agent API (独立端口 3001)
| 端点 | 方法 | 说明 |
|------|------|------|
| `/health` | GET | 健康检查 |
| `/api/books` | GET | 获取书籍列表 |
| `/api/books/create` | POST | 创建书籍 |
| `/api/books/:id/write` | POST | 写作下一章 |
| `/api/books/:id/export-save` | POST | 导出书籍 |

---

## 数据持久化

### 数据卷挂载
```yaml
volumes:
  - inkos_books:/app/books      # 书籍数据（必须）
  - inkos_config:/app/.config/inkos  # 全局配置
  - inkos_logs:/app/logs        # 日志文件
```

### 备份策略
```bash
#!/bin/bash
# backup.sh - 定时备份脚本

BACKUP_DIR="/backup/inkos/$(date +%Y%m%d_%H%M%S)"
mkdir -p $BACKUP_DIR

# 备份书籍数据
docker run --rm \
  -v inkos_books:/data:ro \
  -v $BACKUP_DIR:/backup \
  alpine tar czf /backup/books.tar.gz -C /data .

# 备份配置
docker run --rm \
  -v inkos_config:/data:ro \
  -v $BACKUP_DIR:/backup \
  alpine tar czf /backup/config.tar.gz -C /data .

echo "备份完成: $BACKUP_DIR"
```

---

## 生产环境优化

### 1. HTTPS 配置
```nginx
# nginx.conf 中添加 SSL
server {
    listen 443 ssl http2;
    server_name inkos.example.com;

    ssl_certificate /etc/nginx/ssl/cert.pem;
    ssl_certificate_key /etc/nginx/ssl/key.pem;

    # ... 其他配置
}
```

### 2. 自动伸缩
```yaml
# docker-compose.hybrid.yml
services:
  inkos-agent:
    deploy:
      replicas: 2
      resources:
        limits:
          cpus: '2'
          memory: 4G
```

### 3. 监控告警
```yaml
# 添加监控服务
services:
  prometheus:
    image: prom/prometheus
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml
    ports:
      - "9090:9090"

  grafana:
    image: grafana/grafana
    ports:
      - "3002:3000"
    volumes:
      - grafana_data:/var/lib/grafana
```

---

## 常见问题

### Q1: Web UI 和 Agent API 数据是否同步？
**A:** 是的，两个服务共享同一个 `inkos_books` 数据卷，数据完全同步。

### Q2: 可以只部署其中一个服务吗？
**A:** 可以：
- 只部署 Web UI: `docker-compose up -d inkos-studio nginx`
- 只部署 Agent: `docker-compose up -d inkos-agent`

### Q3: 如何扩展 Agent 服务？
**A:** 可以运行多个 Agent 实例：
```bash
docker-compose up -d --scale inkos-agent=3
```

### Q4: 如何更新部署？
**A:** 
```bash
# 拉取最新代码
git pull

# 重新构建并启动
docker-compose -f docker-compose.hybrid.yml up -d --build
```

---

## 总结

### 优势
- ✅ **双模式支持**: 同时满足人工操作和自动化需求
- ✅ **数据共享**: 两个服务共享数据，无缝协作
- ✅ **独立扩展**: 可以单独扩展 Web 或 Agent 服务
- ✅ **统一入口**: Nginx 提供统一访问入口

### 适用场景
- 个人写作服务器（Web）+ 定时自动写作（Agent）
- 团队协作平台（Web）+ CI/CD 集成（Agent）
- 多客户端接入（Web 给人用，Agent 给系统用）

---

*文档版本: 1.0*  
*更新时间: 2026-04-10*
