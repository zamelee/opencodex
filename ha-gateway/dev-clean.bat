@echo off
REM 清掉开发用数据库
del /q "%TEMP%\ha-gateway-dev.db" 2>nul
echo dev db cleaned
