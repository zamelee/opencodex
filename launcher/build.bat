@echo off
REM Build a windowed single-file exe: launcher\dist\opencodex-launcher.exe
REM NOTE: keep this file ASCII-only with CRLF endings, cmd.exe mangles UTF-8.
setlocal
cd /d "%~dp0\.."
set ROOT=%~dp0..
set ENTRY=%ROOT%\launcher\entry.py
set WEB=%ROOT%\launcher\web

if not exist "launcher\web" (
  echo [build] missing launcher\web
  exit /b 1
)

python -m PyInstaller ^
  --noconfirm --clean ^
  --onefile --windowed ^
  --name opencodex-launcher ^
  --distpath "launcher\dist" ^
  --workpath "launcher\build" ^
  --specpath "launcher" ^
  --paths "." ^
  --add-data "%WEB%;launcher\web" ^
  --hidden-import webview.platforms.edgechromium ^
  "%ENTRY%"

if errorlevel 1 (
  echo [build] PyInstaller failed
  exit /b 1
)

echo [build] done: launcher\dist\opencodex-launcher.exe
endlocal
