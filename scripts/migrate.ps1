#requires -Version 5.1
<#
.SYNOPSIS
    opencodex thin bootstrap shim.

.DESCRIPTION
    从 GitHub raw URL 拉 ocx-start.py，再 exec `python --bootstrap`。
    首次在新机器上跑一条命令搞定（克隆 + 装依赖 + init + 后台启动）。
    之后日常可直接在 clone 内跑 `python ocx-start.py`。

.PARAMETER RepoUrl
    仓库 URL（透传给 ocx-start.py --bootstrap-repo）

.PARAMETER TargetDir
    本地 clone 路径（透传给 --bootstrap-dir；默认 $HOME\opencodex）

.PARAMETER Port
    代理端口（透传给 --port）

.EXAMPLE
    irm https://raw.githubusercontent.com/zamelee/opencodex/main/scripts/migrate.ps1 | iex
#>

[CmdletBinding()]
param(
    [string]$RepoUrl   = "https://github.com/zamelee/opencodex.git",
    [string]$TargetDir = "",
    [int]   $Port      = 10100
)

$ErrorActionPreference = "Stop"

$python = (Get-Command python -ErrorAction SilentlyContinue).Source
if (-not $python) {
    Write-Error "找不到 python。请先装 Python 3.10+：https://python.org/downloads/"
    exit 1
}

$tmp = Join-Path $env:TEMP ("ocx-bootstrap-" + [guid]::NewGuid().ToString("N").Substring(0,8))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
try {
    $script = Join-Path $tmp "ocx-start.py"
    Write-Host "==> 下载 ocx-start.py ..." -ForegroundColor Cyan
    irm "https://raw.githubusercontent.com/zamelee/opencodex/main/ocx-start.py" -OutFile $script
    if (-not (Test-Path $script)) { Write-Error "下载失败"; exit 1 }

    $args = @($script, "--bootstrap", "--port", $Port,
              "--bootstrap-repo", $RepoUrl)
    if ($TargetDir) { $args += @("--bootstrap-dir", $TargetDir) }

    Write-Host "==> python ocx-start.py --bootstrap ..." -ForegroundColor Cyan
    & $python @args
    exit $LASTEXITCODE
} finally {
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
