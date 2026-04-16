# ==========================================
# InkOS Docker Image
# 在源码目录中直接构建
# ==========================================

FROM node:20-slim

WORKDIR /app

# 安装必要的工具和 pnpm
RUN apt-get update && apt-get install -y \
    git \
    curl \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g pnpm

# 复制项目文件
COPY . .

# 安装依赖并构建
RUN pnpm install && pnpm run build

# 创建数据目录
RUN mkdir -p /app/books /app/.config/inkos /app/logs

# 暴露端口
EXPOSE 3000

# 环境变量
ENV INKOS_PROJECT_ROOT=/app/books
ENV INKOS_STUDIO_PORT=3000

# 启动命令
CMD ["pnpm", "--filter", "@actalk/inkos-studio", "start"]
