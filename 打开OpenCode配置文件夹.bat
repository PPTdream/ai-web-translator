@echo off
chcp 936 >nul
title 打开 OpenCode 配置文件夹
set "AUTH=%USERPROFILE%\.local\share\opencode\auth.json"
if exist "%AUTH%" (
  echo %AUTH%| clip >nul 2>&1
  explorer /select,"%AUTH%"
  echo 已打开 auth.json 所在文件夹，并已把完整路径复制到剪贴板。
  echo.
  echo 接下来：
  echo   1. 扩展设置 - AI 引擎 - 点「从 OpenCode 导入 Key」
  echo   2. 在文件选择框里按 Ctrl+V 粘贴路径，回车
) else (
  echo 没有找到：
  echo   %AUTH%
  echo 请确认已经在本机登录 OpenCode Go。
  if exist "%USERPROFILE%\.local\share\opencode" (
    explorer "%USERPROFILE%\.local\share\opencode"
  ) else (
    echo 配置目录也不存在，先运行一次 OpenCode 并登录。
  )
)
echo.
pause
exit /b 0
