#!/bin/bash

# 自动安装依赖、构建并链接全局的脚本
echo "=== InkOS 安装和构建脚本 ==="

# 检查 pnpm 是否已安装
if ! command -v pnpm &> /dev/null; then
    echo "错误: pnpm 未安装，请先安装 pnpm"
    echo "可以通过 npm install -g pnpm 安装"
    exit 1
fi

echo "1. 安装依赖..."
pnpm install

if [ $? -ne 0 ]; then
    echo "错误: 依赖安装失败"
    exit 1
fi

echo "2. 构建项目..."
pnpm build

if [ $? -ne 0 ]; then
    echo "错误: 项目构建失败"
    exit 1
fi

echo "3. 链接到全局..."
pnpm link --global

if [ $? -ne 0 ]; then
    echo "错误: 全局链接失败"
    exit 1
fi

echo ""
echo "✅ 安装和构建完成！"
echo "现在可以在任何目录使用 'inkos' 命令"
echo ""
echo "示例用法:"
echo "  inkos book create --title "我的小说" --genre xuanhuan"
echo "  inkos write next"
echo "  inkos studio"
