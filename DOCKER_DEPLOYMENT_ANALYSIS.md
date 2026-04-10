# InkOS Docker 部署可行性分析报告

## 项目概述

InkOS 是一个基于 Node.js 的自主小说创作 CLI AI Agent，采用 pnpm monorepo 架构，包含以下核心包：
- **cli**: 命令行工具
- **core**: 核心逻辑（Agent、状态管理、流水线）
- **studio**: Web UI 界面（基于 Vite + React）

---

## Docker 部署可行性评估

### ✅ 适合 Docker 部署的因素

#### 1. 技术栈兼容性
| 项目 | 说明 |
|------|------|
| 运行时 | Node.js 20（.node-version 指定） |
| 包管理器 | pnpm（支持 workspace） |
| 架构 | Monorepo（3 个 packages） |
| 数据库 | 内存数据库 + 文件系统（无需外部 DB） |
| Web UI | 自包含（Vite + Express 混合） |

#### 2. 部署模式分析

**模式一：CLI 工具容器化** ⭐⭐⭐⭐⭐
```
适用场景: CI/CD 自动化写作
特点: 无状态、命令执行完即退出
Docker 类型: 一次性容器
```

**模式二：Studio Web 服务容器化** ⭐⭐⭐⭐⭐
```
适用场景: 提供 Web UI 服务
特点: 长期运行、有状态（书籍数据）
Docker 类型: 常驻服务容器
端口: 默认 3000（可配置）
```

**模式三：混合模式** ⭐⭐⭐⭐
```
适用场景: 同时提供 CLI 和 Web UI
特点: 一个镜像支持两种运行模式
Docker 类型: 多用途容器
```

---

### ⚠️ 需要注意的挑战

#### 1. 数据持久化需求
```
必需挂载的目录:
├── /app/books          # 书籍数据（必须持久化）
├── /app/.config/inkos  # 全局配置（可选）
└── /app/logs           # 日志文件（可选）
```

#### 2. 配置文件位置
| 配置类型 | 默认位置 | Docker 建议 |
|---------|---------|------------|
| 全局配置 | `~/.config/inkos/` | 挂载卷或环境变量 |
| 项目配置 | `<books>/<book>/` | 随书籍数据持久化 |
| 审计配置 | `<books>/<book>/audit-config.json` | 随书籍数据持久化 |

#### 3. 环境变量需求
```bash
# 必需
INKOS_BOOKS_DIR=/app/books

# 可选
INKOS_STUDIO_PORT=3000
INKOS_LOG_LEVEL=info
INKOS_CONFIG_DIR=/app/.config/inkos

# AI Provider（必需）
OPENAI_API_KEY=xxx
OPENAI_BASE_URL=https://api.openai.com/v1
```

---

## 推荐 Docker 部署方案

### 方案一：Studio Web 服务（推荐）

#### Dockerfile
```dockerfile
# 阶段一：构建
FROM node:20-alpine AS builder
WORKDIR /app

# 安装 pnpm
RUN npm install -g pnpm

# 复制 workspace 配置
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/cli/package.json ./packages/cli/
COPY packages/core/package.json ./packages/core/
COPY packages/studio/package.json ./packages/studio/

# 安装依赖
RUN pnpm install --frozen-lockfile

# 复制源码并构建
COPY . .
RUN pnpm run build

# 阶段二：运行
FROM node:20-alpine AS runner
WORKDIR /app

# 安装 pnpm
RUN npm install -g pnpm

# 从构建阶段复制产物
COPY --from=builder /app/packages/cli/dist ./packages/cli/dist
COPY --from=builder /app/packages/core/dist ./packages/core/dist
COPY --from=builder /app/packages/studio/dist ./packages/studio/dist
COPY --from=builder /app/packages/studio/package.json ./packages/studio/
COPY --from=builder /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=builder /app/node_modules ./node_modules

# 创建数据目录
RUN mkdir -p /app/books /app/.config/inkos

# 暴露端口
EXPOSE 3000

# 健康检查
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/api/health || exit 1

# 启动命令
CMD ["pnpm", "--filter", "@actalk/inkos-studio", "start"]
```

#### docker-compose.yml
```yaml
version: '3.8'

services:
  inkos-studio:
    build:
      context: .
      dockerfile: Dockerfile
    container_name: inkos-studio
    ports:
      - "3000:3000"
    volumes:
      - ./data/books:/app/books
      - ./data/config:/app/.config/inkos
      - ./data/logs:/app/logs
    environment:
      - INKOS_BOOKS_DIR=/app/books
      - INKOS_CONFIG_DIR=/app/.config/inkos
      - OPENAI_API_KEY=${OPENAI_API_KEY}
      - OPENAI_BASE_URL=${OPENAI_BASE_URL:-https://api.openai.com/v1}
    restart: unless-stopped
    networks:
      - inkos-network

networks:
  inkos-network:
    driver: bridge
```

### 方案二：CLI 工具容器

#### Dockerfile.cli
```dockerfile
FROM node:20-alpine
WORKDIR /app

# 安装 pnpm
RUN npm install -g pnpm

# 复制并安装依赖
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/cli/package.json ./packages/cli/
COPY packages/core/package.json ./packages/core/
RUN pnpm install --frozen-lockfile

# 复制源码并构建
COPY . .
RUN pnpm run build

# 设置入口点
ENTRYPOINT ["node", "./packages/cli/dist/index.js"]
CMD ["--help"]
```

#### 使用示例
```bash
# 创建书籍
docker run --rm \
  -v $(pwd)/books:/app/books \
  -e OPENAI_API_KEY=$OPENAI_API_KEY \
  inkos-cli book create --title "我的小说" --genre xianxia

# 写作下一章
docker run --rm \
  -v $(pwd)/books:/app/books \
  -e OPENAI_API_KEY=$OPENAI_API_KEY \
  inkos-cli book write --id my-book
```

---

## 部署步骤

### 1. 准备工作
```bash
# 克隆项目
git clone https://github.com/KingDevatil/inkos.git
cd inkos

# 创建数据目录
mkdir -p data/books data/config data/logs

# 创建环境变量文件
cat > .env << EOF
OPENAI_API_KEY=your-api-key-here
OPENAI_BASE_URL=https://api.openai.com/v1
EOF
```

### 2. 构建镜像
```bash
# Studio 服务
docker-compose build

# 或单独构建
docker build -t inkos-studio -f Dockerfile .
```

### 3. 启动服务
```bash
docker-compose up -d

# 查看日志
docker-compose logs -f inkos-studio
```

### 4. 访问服务
```
URL: http://localhost:3000
API: http://localhost:3000/api
```

---

## 生产环境建议

### 1. 反向代理（Nginx）
```nginx
server {
    listen 80;
    server_name inkos.example.com;
    
    location / {
        proxy_pass http://inkos-studio:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

### 2. 自动备份
```bash
#!/bin/bash
# backup.sh
BACKUP_DIR="/backup/inkos/$(date +%Y%m%d)"
mkdir -p $BACKUP_DIR

docker run --rm \
  -v inkos_books:/data \
  -v $BACKUP_DIR:/backup \
  alpine tar czf /backup/books-$(date +%H%M).tar.gz -C /data .
```

### 3. 监控
```yaml
# docker-compose.monitoring.yml
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
      - "3001:3000"
    volumes:
      - grafana_data:/var/lib/grafana
```

---

## 总结

### 可行性评级: ⭐⭐⭐⭐⭐ (强烈推荐)

**优势**:
1. ✅ 无外部数据库依赖，部署简单
2. ✅ Node.js 应用容器化成熟
3. ✅ 单端口暴露，易于反向代理
4. ✅ 数据目录清晰，易于持久化
5. ✅ 支持环境变量配置，符合 12-Factor

**注意事项**:
1. ⚠️ 必须挂载 books 目录持久化
2. ⚠️ AI API Key 通过环境变量注入
3. ⚠️ 内存数据库重启后需重新加载
4. ⚠️ 大文件上传需调整 Nginx 配置

**推荐场景**:
- 个人写作服务器
- 团队协作平台
- CI/CD 自动化写作流水线

---

*分析时间: 2026-04-10*  
*基于版本: eb0191a*
