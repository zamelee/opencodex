@echo off
REM ============================================================
REM  Bun-on-a-no-AVX-CPU reproduction harness
REM
REM  Run this ON THE MACHINE THAT CRASHED (the 8 GB box without AVX).
REM  It answers one question: does a BLANK Bun program also die with
REM  "Illegal instruction" there? If yes, the application is not the cause.
REM
REM  Usage:  run.cmd            (short 10-minute smoke run, both modes)
REM          run.cmd long       (2 hours, plain + pressure)
REM          run.cmd <bun.exe>  (use a specific bun binary)
REM          run.cmd soak [minutes] [targetMB]
REM              Only the memory-pressure soak, e.g.
REM                  run.cmd soak 120 1536
REM              grows the heap to 1536 MB, HOLDS it, and reports the exit code.
REM              Use this one for the long run -- the four-experiment sweep is
REM              for the first look, not for a several-hour soak.
REM ============================================================
setlocal
cd /d "%~dp0"

set "BUNEXE="
REM The crash log on the affected box named this exact binary:
REM   D:\VibeCoding\opencodex\node_modules\bun\bin\bun.exe
REM so look there FIRST -- the pinned 1.3.14 is the version that crashed.
if not "%~1"=="" (
  if exist "%~1" set "BUNEXE=%~1"
)
if not defined BUNEXE if exist "%~dp0..\..\node_modules\bun\bin\bun.exe" (
  set "BUNEXE=%~dp0..\..\node_modules\bun\bin\bun.exe"
)
if not defined BUNEXE (
  for /d %%D in ("%~dp0..\..\node_modules\.pnpm\bun@*") do (
    if exist "%%D\node_modules\bun\bin\bun.exe" set "BUNEXE=%%D\node_modules\bun\bin\bun.exe"
  )
)
if not defined BUNEXE (
  where bun >nul 2>nul && set "BUNEXE=bun"
)
if not defined BUNEXE (
  echo [run] bun not found
  exit /b 1
)

echo [run] bun binary: %BUNEXE%
"%BUNEXE%" --version
echo [run] NOTE: the crash we are chasing was Bun 1.3.14 (baseline build).
echo [run]       If the version above is not 1.3.14, say so -- the comparison matters.
REM Prove whether this CPU has AVX at all. Bun only says "CPU lacks AVX support"
REM inside a crash banner, so read the CPU features directly (same API the
REM launcher uses to decide whether Bun is safe here).
where python >nul 2>nul && python "%~dp0cpuinfo.py"
if errorlevel 1 echo [run] (python not found -- cannot read CPU features)
echo.

if /i "%~1"=="soak" goto soak

if /i "%~1"=="long" (
  set "MINUTES=120"
) else (
  set "MINUTES=10"
)

echo [run] ---- experiment 1/4: blank program, default memory settings ----
"%BUNEXE%" run repro.ts plain %MINUTES%
echo [run] exit code: %errorlevel%

echo [run] ---- experiment 2/4: blank program, --smol ----
"%BUNEXE%" --smol run repro.ts plain %MINUTES%
echo [run] exit code: %errorlevel%

echo [run] ---- experiment 3/4: blank program with deliberate heap growth ----
"%BUNEXE%" run repro.ts pressure %MINUTES%
echo [run] exit code: %errorlevel%

echo [run] ---- experiment 4/4: same, --smol ----
"%BUNEXE%" --smol run repro.ts pressure %MINUTES%
echo [run] exit code: %errorlevel%

echo.
echo [run] done. Copy the whole output back, including any crash banner.
endlocal
goto :eof

:soak
set "MINUTES=%~2"
if "%MINUTES%"=="" set "MINUTES=120"
set "TARGET=%~3"
if "%TARGET%"=="" set "TARGET=1536"
echo [run] ---- soak: heap pressure, %MINUTES% minutes, target %TARGET% MB ----
echo [run] NOTE: this box also serves live traffic. Keep the target below what
echo [run]       the service needs; 1536 MB is the conservative choice here.
"%BUNEXE%" run repro.ts pressure %MINUTES% %TARGET%
echo [run] exit code: %errorlevel%
echo [run] done. Copy the output back, including any crash banner.
endlocal
