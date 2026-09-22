@echo off
chcp 65001 >nul
title TikTok Ops Console - reset demo data
cd /d %~dp0
rem Delete runtime\ so the next start copies a clean demo DB again.
node scripts\launch.mjs reset
pause
