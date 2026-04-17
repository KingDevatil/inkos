# ==========================================
# InkOS Docker Image - Multi-stage Build
# 优化构建缓存，避免每次重新安装依赖
# ==========================================

# --------------------
# Stage 1: Dependencies
# 只安装依赖，不构建
# --------------------
FROM node:20-bookworm AS deps

WORKDIR /app

# 配置国内镜像源并安装 git
RUN echo "deb https://mirrors.aliyun.com/debian bookworm main contrib non-free non-free-firmware" > /etc/apt/sources.list && \
    echo "deb https://mirrors.aliyun.com/debian bookworm-updates main contrib non-free non-free-firmware" >> /etc/apt/sources.list && \
    echo "deb https://mirrors.aliyun.com/debian-security bookworm-security main contrib non-free non-free-firmware" >> /etc/apt/sources.list && \
    apt-get update -qq && \
    apt-get install -y -qq --no-install-recommends git && \
    rm -rf /var/lib/apt/lists/*

# 配置 npm 使用国内镜像源，然后安装 pnpm
RUN npm config set registry https://registry.npmmirror.com && \
    corepack enable && \
    corepack install --global pnpm@10.33.0 && \
    pnpm --version

# 先只复制 package.json 和 pnpm-workspace.yaml
# 这样只有当这些文件变化时才重新安装依赖
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY packages/core/package.json ./packages/core/
COPY packages/studio/package.json ./packages/studio/
COPY packages/cli/package.json ./packages/cli/

# 配置 pnpm 使用国内镜像源并安装依赖
RUN pnpm config set registry https://registry.npmmirror.com && \
    pnpm install --frozen-lockfile

# 安装缺失的类型定义
RUN pnpm --filter @actalk/inkos-core add -D @types/node@^22.0.0

# --------------------
# Stage 2: Builder
# 构建项目
# --------------------
FROM node:20-bookworm AS builder

WORKDIR /app

# 从 deps 阶段复制已安装的依赖
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/core/node_modules ./packages/core/node_modules
COPY --from=deps /app/packages/studio/node_modules ./packages/studio/node_modules
COPY --from=deps /app/packages/cli/node_modules ./packages/cli/node_modules

# 复制所有源码
COPY . .

# 重新链接依赖（确保 bin 链接正确）
RUN corepack enable && corepack install --global pnpm@10.33.0

# 构建项目
RUN pnpm run build

# --------------------
# Stage 3: Runtime
# 运行时环境
# --------------------
FROM node:20-bookworm AS runtime

WORKDIR /app

# 安装运行时必要的工具
RUN echo "deb https://mirrors.aliyun.com/debian bookworm main contrib non-free non-free-firmware" > /etc/apt/sources.list && \
    echo "deb https://mirrors.aliyun.com/debian bookworm-updates main contrib non-free non-free-firmware" >> /etc/apt/sources.list && \
    echo "deb https://mirrors.aliyun.com/debian-security bookworm-security main contrib non-free non-free-firmware" >> /etc/apt/sources.list && \
    apt-get update -qq && \
    apt-get install -y -qq --no-install-recommends git && \
    rm -rf /var/lib/apt/lists/*

# 安装 pnpm
RUN npm config set registry https://registry.npmmirror.com && \
    corepack enable && \
    corepack install --global pnpm@10.33.0

# 从 builder 阶段复制构建产物
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/core/node_modules ./packages/core/node_modules
COPY --from=builder /app/packages/studio/node_modules ./packages/studio/node_modules
COPY --from=builder /app/packages/cli/node_modules ./packages/cli/node_modules
COPY --from=builder /app/packages/core/dist ./packages/core/dist
COPY --from=builder /app/packages/studio/dist ./packages/studio/dist
COPY --from=builder /app/packages/cli/dist ./packages/cli/dist
COPY --from=builder /app/packages/core/package.json ./packages/core/
COPY --from=builder /app/packages/studio/package.json ./packages/studio/
COPY --from=builder /app/packages/cli/package.json ./packages/cli/
COPY --from=builder /app/package.json ./
COPY --from=builder /app/pnpm-workspace.yaml ./

# 创建数据目录
RUN mkdir -p /app/books /app/.config/inkos /app/logs

# 暴露端口
EXPOSE 3000

# 环境变量
ENV INKOS_PROJECT_ROOT=/app/books
ENV INKOS_STUDIO_PORT=3000

# 启动命令
CMD ["pnpm", "--filter", "@actalk/inkos-studio", "start"]
