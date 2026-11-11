@echo off
REM 打包成单文件 exe
cd /d "%~dp0"
python -m PyInstaller --noconfirm --onefile --windowed --name HA-Gateway --collect-all webview --hidden-import clr --hidden-import clr_loader --hidden-import ha_gateway.tray --hidden-import ha_gateway.branding --hidden-import ha_gateway.desktop --add-data "ha_gateway\web;ha_gateway\web" main.py
echo.
echo 构建完成：dist\HA-Gateway.exe
