@echo off
chcp 65001 >nul
cd /d %~dp0
rem 清掉 runtime\（运行时库等临时文件）。下次启动会重新从演示库复制一份干净的。
rem 演示过程中把数据改乱了就用它复位，仓库里 apps\data\tk_ops.db 不受影响。
node scripts\launch.mjs reset
pause
