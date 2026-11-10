@echo off
REM 打包成单文件 exe
cd /d "%~dp0"
python -m PyInstaller --noconfirm --onefile --windowed ^
  --name HA-Gateway ^
  --hidden-import ha_gateway.ui ^
  --hidden-import ha_gateway.tray ^
  main.py
echo.
echo 构建完成：dist\HA-Gateway.exe
