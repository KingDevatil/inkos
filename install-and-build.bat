@echo off

REM 自动安装依赖、构建并链接全局的脚本
echo === InkOS 安装和构建脚本 ===

REM 检查 pnpm 是否已安装
where pnpm >nul 2>nul
if %errorlevel% neq 0 (
    echo 错误: pnpm 未安装，请先安装 pnpm
    echo 可以通过 npm install -g pnpm 安装
    pause
    exit /b 1
)

echo 1. 安装依赖...
pnpm install

if %errorlevel% neq 0 (
    echo 错误: 依赖安装失败
    pause
    exit /b 1
)

echo 2. 构建项目...
pnpm build

if %errorlevel% neq 0 (
    echo 错误: 项目构建失败
    pause
    exit /b 1
)

echo 3. 链接到全局...
pnpm link --global

if %errorlevel% neq 0 (
    echo 错误: 全局链接失败
    pause
    exit /b 1
)

echo.
echo ✅ 安装和构建完成！
echo 现在可以在任何目录使用 'inkos' 命令
echo.
echo 示例用法:
echo   inkos book create --title "我的小说" --genre xuanhuan
echo   inkos write next
echo   inkos studio
echo.
pause
