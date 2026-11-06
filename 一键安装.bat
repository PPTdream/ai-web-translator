@echo off
chcp 936 >nul
title AI 网页翻译助手 v2.0 - 安装引导
setlocal
set "EXT=%~dp0extension"

if not exist "%EXT%\manifest.json" (
  echo ==========================================================
  echo [错误] 找不到 extension\manifest.json
  echo 请确认压缩包已经完整解压，并且本文件就在 extension 的上一层。
  echo ==========================================================
  pause
  exit /b 1
)

echo ==========================================================
echo        AI 网页翻译助手 v2.0  安装引导
echo ==========================================================
echo.
echo Edge 137 以后不再支持命令行自动加载扩展，需要手动加载一次。
echo.
echo 扩展文件夹：
echo   %EXT%
echo.
echo 正在复制路径，并打开扩展管理页和文件夹...
echo %EXT%| clip >nul 2>&1
start "" explorer "%EXT%"

set "EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" set "EDGE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if exist "%EDGE%" (
  start "" "%EDGE%" "edge://extensions"
) else (
  start "" "msedge" "edge://extensions"
)

echo.
echo 请按下面 5 步操作：
echo   1. 在打开的 edge://extensions 页面，打开「开发人员模式」
echo   2. 点「加载解压缩的扩展」
echo   3. 在地址栏粘贴刚才复制的路径，回车
echo   4. 选择 extension 文件夹（能看到 manifest.json 的那一层）
echo   5. 在工具栏扩展菜单里固定「AI 网页翻译助手」
echo.
echo 装好后刷新已打开的网页，点「译」图标 →「翻译此页」。
echo AI 配置、术语库、站点规则见「使用说明.txt」。
echo.
echo 提示：装好后不要把文件夹移来移去，否则扩展 ID 会变，
echo       设置和术语库会读不到。建议先用「数据与备份」导出备份。
echo.
pause
exit /b 0
