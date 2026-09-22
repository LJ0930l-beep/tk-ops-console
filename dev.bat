@echo off
chcp 65001 >nul
title TikTok Ops Console - dev mode
cd /d %~dp0
rem Dev mode: API :8787 + vite :5173 (proxies /api), both hot-reload.
node scripts\launch.mjs dev
if errorlevel 1 pause
