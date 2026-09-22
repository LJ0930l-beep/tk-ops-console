@echo off
chcp 65001 >nul
cd /d %~dp0
rem 一键启动：装依赖（首次）→ 构建（首次）→ 单端口起服务 → 自动开浏览器
rem 关掉这个窗口就是停止服务。数据用的是 runtime\tk_ops.db，不会写脏仓库里那份演示库。
node scripts\launch.mjs start
if errorlevel 1 pause
