@echo off
chcp 65001 >nul
cd /d %~dp0
rem 开发模式：后端 :8787 + 前端 :5173（vite 代理 /api），两边都热更新
rem 改代码用这个；只是想看效果用 start.bat（单端口、不用等 vite）
node scripts\launch.mjs dev
if errorlevel 1 pause
