@echo off
chcp 65001 >nul
title TikTok Ops Console - one-click start
cd /d %~dp0
rem One-click: deps -> build -> single-port server -> open browser.
rem Close this window (or Ctrl+C) to stop. Data lives in runtime\tk_ops.db,
rem so the tracked demo DB under apps\data stays untouched.
node scripts\launch.mjs start
if errorlevel 1 pause
