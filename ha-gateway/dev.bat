@echo off
REM 开发调试：无控制台窗口，用临时数据库，不动正式配置
cd /d "%~dp0"
set HA_GATEWAY_DB=%TEMP%\ha-gateway-dev.db
start "" pythonw -m ha_gateway
