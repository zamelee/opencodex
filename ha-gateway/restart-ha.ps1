<#
HA Gateway 的自包含重启脚本。

为什么要它：Codex 的模型请求就走 HA 自己的 10110 端口，
也就是说"重启 HA"这个动作的发起者，挂在被重启的那台服务上。
如果靠 LLM 一步步发命令，进程一停，LLM 的推理链路先断，
重启就成了半截工程。

所以规矩是：把 kill -> 等待端口释放 -> 重建 -> 拉起 -> 等端口就绪
整条链写进一个脚本，一次执行完，中途 LLM 断不断都无所谓；
LLM 只负责"发起"和"读结果"。

用法：
  pwsh -NoProfile -File restart-ha.ps1                 # 只重启（最快）
  pwsh -NoProfile -File restart-ha.ps1 -Mode rebuild    # 重建 + 重启
  pwsh -NoProfile -File restart-ha.ps1 -Mode restart -KeepWindow
#>

param(
  [ValidateSet("restart", "rebuild")]
  [string]$Mode = "restart",
  [switch]$KeepWindow,
  [int]$TimeoutSec = 90
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Exe = Join-Path $Root "dist\HA-Gateway.exe"
$LogDir = Join-Path $Root "tmp"
$Log = Join-Path $LogDir "restart-ha.log"

if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir | Out-Null }

function Say([string]$msg) {
  $line = "[{0}] {1}" -f (Get-Date -Format "HH:mm:ss"), $msg
  Write-Host $line
  Add-Content -Path $Log -Value $line -Encoding UTF8
}

function Get-HaProcs {
  Get-CimInstance Win32_Process -Filter "Name='HA-Gateway.exe'" -ErrorAction SilentlyContinue
}

function Get-PortOwner([int]$port) {
  Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue |
    Select-Object -First 1
}

Say "=== HA 重启（模式=$Mode）==="

# ---- 1. 停掉现有实例 ----
$procs = @(Get-HaProcs)
if ($procs.Count -gt 0) {
  Say "发现 $($procs.Count) 个 HA 进程：$(($procs.ProcessId) -join ',')"
  # 先停子进程再停父进程（PyInstaller 单文件：父=bootloader，子=真正干活的）
  $ordered = $procs | Sort-Object { if ($_.ParentProcessId -in $procs.ProcessId) { 1 } else { 0 } }
  foreach ($p in $ordered) {
    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
  }
  Say "已停止"
} else {
  Say "没有运行中的实例"
}

# ---- 2. 等端口腾出来 ----
$deadline = (Get-Date).AddSeconds(20)
while ((Get-Date) -lt $deadline) {
  $p1 = Get-PortOwner 10110
  $p2 = Get-PortOwner 10111
  if (-not $p1 -and -not $p2) { break }
  Start-Sleep -Milliseconds 300
}
if ((Get-PortOwner 10110) -or (Get-PortOwner 10111)) {
  Say "端口 10110/10111 还被占着，硬来"
} else {
  Say "端口 10110/10111 已释放"
}

# ---- 3. 重建（可选） ----
if ($Mode -eq "rebuild") {
  Say "开始重建（这一步最慢，别在此时等 LLM 回应）"
  Push-Location $Root
  try {
    cmd /c build.bat 2>&1 | Select-Object -Last 3 | ForEach-Object { Say "  build: $_" }
  } finally {
    Pop-Location
  }
  if (-not (Test-Path $Exe)) {
    Say "重建失败：$Exe 不存在"
    exit 1
  }
  Say ("重建完成，exe 时间戳 {0}" -f (Get-Item $Exe).LastWriteTime)
}

# ---- 4. 拉起 ----
$env:HA_GATEWAY_NO_BROWSER = if ($KeepWindow) { "0" } else { "1" }
Start-Process -FilePath $Exe -WorkingDirectory $Root -WindowStyle Hidden
Say "已拉起，等待端口就绪……"

# ---- 5. 等就绪 ----
$deadline = (Get-Date).AddSeconds($TimeoutSec)
$ready = $false
while ((Get-Date) -lt $deadline) {
  $c1 = Get-PortOwner 10110
  $c2 = Get-PortOwner 10111
  if ($c1 -and $c2) { $ready = $true; break }
  Start-Sleep -Milliseconds 400
}

$procs2 = @(Get-HaProcs)
if ($ready) {
  $c1 = Get-PortOwner 10110
  Say "就绪：10110/10111 已监听（进程 $($procs2.ProcessId -join ',')，端口归属 $($c1.OwningProcess)）"
  Say "=== 重启成功 ==="
  exit 0
} else {
  Say "超时：端口没起来（进程 $($procs2.ProcessId -join ',')）"
  Say "=== 重启失败 ==="
  exit 1
}
