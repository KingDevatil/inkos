# ==========================================
# InkOS Docker Image
# 在源码目录中直接构建
# ==========================================

FROM node:20-bookworm

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

# 复制项目文件
COPY . .

# 配置 pnpm 使用国内镜像源并安装依赖
RUN pnpm config set registry https://registry.npmmirror.com && \
    pnpm install

# 安装缺失的类型定义
RUN pnpm --filter @actalk/inkos-core add -D @types/node@^22.0.0

# 构建项目
RUN pnpm run build

# 创建数据目录
RUN mkdir -p /app/books /app/.config/inkos /app/logs

# 暴露端口
EXPOSE 3000

# 环境变量
ENV INKOS_PROJECT_ROOT=/app/books
ENV INKOS_STUDIO_PORT=3000

# 启动命令
CMD ["pnpm", "--filter", "@actalk/inkos-studio", "start"]
