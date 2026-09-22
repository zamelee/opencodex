#requires -Version 5.1
<#
.SYNOPSIS
    Rebuilds the GUI then stops and restarts the local opencodex proxy so
    the newly built gui/dist is what the proxy serves.

.DESCRIPTION
    Dev-loop helper for when the GUI has been edited but the running
    proxy still serves the stale gui/dist/* snapshot. The local
    nvm-installed bun.exe errors out with "This version of bun.exe is
    not compatible with the version of Windows you're running" on
    Win10 1909, so we explicitly use the D:\AiSystem\nvm bun binary
    (1.4.x, Windows-compatible) instead of the broken one.

    We also run the build via `cmd /c bun run build` rather than `&
    $bun run build`, because PowerShell 7+ can't capture $LASTEXITCODE
    from a `& $bun run` invocation under some sandbox configurations
    (the script execution returns immediately, the captured code is
    the wrapper's not bun's).

.PARAMETER SkipBuild
    Skip the `gui/dist` rebuild. Useful when you only edited server-side
    code that does not need a GUI refresh.

.EXAMPLE
    pwsh ./scripts/dev-restart.ps1
    Full dev-loop: rebuild gui/dist, stop the running proxy, restart
    it detached so this turn can end without killing it, wait for the
    proxy to bind port 10100 and respond to /healthz.

.EXAMPLE
    pwsh ./scripts/dev-restart.ps1 -SkipBuild
    Server-only change: skip the GUI rebuild and just bounce the proxy.

.NOTES
    - Idempotent: safe to run repeatedly.
    - Stops the current proxy via `ocx stop` if available, then kills
      any bun still bound to port 10100 as defense in depth.
    - Writes a small status line at the end so the agent can verify the
      new build was loaded.
#>

param(
  [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$ProgressPreference    = "SilentlyContinue"

$repoRoot = (Resolve-Path "$PSScriptRoot/..").Path
Write-Host "[dev-restart] repo: $repoRoot"

# --- Step 1: locate a working bun --------------------------------------
$candidates = @(
  $env:OCX_BIN_BUN,
  "D:\AiSystem\nvm\nodejs\bun.exe",
  "D:\AiSystem\nvm\nodejs\bun",
  (Get-Command bun.exe -ErrorAction SilentlyContinue).Source,
  (Get-Command bun -ErrorAction SilentlyContinue).Source
) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1

if (-not $candidates) {
  Write-Host "[dev-restart] no bun binary found in candidates; aborting." -ForegroundColor Red
  exit 1
}
$bun = $candidates
Write-Host "[dev-restart] using bun: $bun"

# --- Step 2: rebuild gui/dist ----------------------------------------
if (-not $SkipBuild) {
  $guiDir = Join-Path $repoRoot "gui"
  $bldLog  = Join-Path $repoRoot "tmp" "_dev_bld_out.log"
  $bldErr  = Join-Path $repoRoot "tmp" "_dev_bld_err.log"
  Write-Host "[dev-restart] rebuilding gui/dist via: $bun run build (cwd: $guiDir)"
  # Use cmd /c wrapper because PowerShell `& $bun run build` does not
  # propagate $LASTEXITCODE reliably in some sandbox configurations.
  cmd /c "cd /d `"$guiDir`" && `"$bun`" run build > `"$bldLog`" 2> `"$bldErr`""
  if ($LASTEXITCODE -ne 0) {
    Write-Host "[dev-restart] gui build failed (exit=$LASTEXITCODE); aborting" -ForegroundColor Red
    if (Test-Path $bldErr) {
      Write-Host "[dev-restart] --- stderr ---"
      Get-Content $bldErr -Tail 30
    }
    exit 1
  }
  Write-Host "[dev-restart] gui/dist rebuilt at $(Get-Date -Format 'HH:mm:ss')"
} else {
  Write-Host "[dev-restart] -SkipBuild: not rebuilding gui/dist"
}

# --- Step 3: stop the current proxy ---------------------------------
$port = 10100
$stopped = $false

# 3a. Try the canonical ocx CLI
$ocxCmd = Get-Command ocx -ErrorAction SilentlyContinue
if ($ocxCmd) {
  Write-Host "[dev-restart] running 'ocx stop' via $($ocxCmd.Source)"
  & ocx stop 2>&1 | Out-Null
  $stopped = $true
}

# 3b. Kill any bun still bound to port 10100 (defense in depth)
$listener = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue
if ($listener) {
  $pids = $listener | Select-Object -ExpandProperty OwningProcess -Unique
  foreach ($ownerPid in $pids) {
    $proc = Get-Process -Id $pid -ErrorAction SilentlyContinue
    if ($proc -and $proc.ProcessName -eq 'bun') {
      Write-Host "[dev-restart] killing bun pid=$pid (still bound to :$port)"
      Stop-Process -Id $ownerPid -Force -ErrorAction SilentlyContinue
      $stopped = $true
    }
  }
}

# 3c. Clean stale pidfile (ocx-start.py leaves these behind if it was killed mid-write)
$pidfile = Join-Path $HOME ".opencodex/ocx.pid"
if (Test-Path $pidfile) { Remove-Item $pidfile -Force -ErrorAction SilentlyContinue }

if (-not $stopped) {
  Write-Host "[dev-restart] no running proxy found on :$port"
}
Start-Sleep -Seconds 2

# --- Step 4: start the new proxy detached ----------------------------
$logFile = $env:OCX_RESTART_LOG
if (-not $logFile) {
  $logFile = if ($env:TEMP) { Join-Path $env:TEMP "ocx-restart.log" } else { "/tmp/ocx-restart.log" }
}
Write-Host "[dev-restart] starting proxy detached; log: $logFile"

$py = (Get-Command python.exe -ErrorAction SilentlyContinue).Source
if (-not $py) {
  Write-Host "[dev-restart] python not found on PATH" -ForegroundColor Red
  exit 1
}

$startScript = Join-Path $repoRoot "ocx-start.py"
$proc = Start-Process -FilePath $py `
  -ArgumentList @($startScript, "--hostname", "0.0.0.0") `
  -WorkingDirectory $repoRoot `
  -RedirectStandardOutput $logFile `
  -RedirectStandardError  "$logFile.err" `
  -PassThru -NoNewWindow
Write-Host "[dev-restart] proxy launched, pid=$($proc.Id)"

# --- Step 5: wait for the new port and verify health ----------------
$deadline = (Get-Date).AddSeconds(20)
$ok = $false
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 500
  $listener = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue
  if ($listener) {
    try {
      $h = Invoke-WebRequest -Uri "http://127.0.0.1:$port/healthz" -UseBasicParsing -TimeoutSec 3
      if ($h.StatusCode -eq 200) {
        $body = ($h.Content | ConvertFrom-Json -ErrorAction SilentlyContinue)
        Write-Host "[dev-restart] healthz OK: pid=$($body.pid) uptime=$($body.uptime) version=$($body.version)" -ForegroundColor Green
        $ok = $true
        break
      }
    } catch {}
  }
}

if (-not $ok) {
  Write-Host "[dev-restart] proxy did not become healthy within 20s" -ForegroundColor Red
  Write-Host "[dev-restart] last 30 lines of $logFile.err:"
  if (Test-Path "$logFile.err") {
    Get-Content "$logFile.err" -Tail 30 -ErrorAction SilentlyContinue
  }
  exit 1
}

Write-Host "[dev-restart] done."