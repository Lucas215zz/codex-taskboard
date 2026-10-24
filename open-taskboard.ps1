# Codex 任务面板 · 一键打开（浏览器模式，安全版）
#
# 设计目标（给完全不懂技术的人用）：
#   - 双击一定能看见东西：面板会在默认浏览器里打开
#   - 永远不关、永远不重启 Codex，聊天窗口不会被打断
#   - 引擎没起就后台静默启动；已经起着就直接复用
#   - 出错才弹窗，弹窗里写清楚怎么办

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$dataDir = Join-Path $root '.data'
$logFile = Join-Path $dataDir 'open-taskboard.log'

New-Item -ItemType Directory -Force -Path $dataDir | Out-Null

# Node writes UTF-8; PowerShell 5.1 decodes captured native output with the
# console codepage (936 here), which turns every Chinese line into mojibake.
# Forcing UTF-8 decoding keeps the log readable.
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

function Write-Log($message) {
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $message"
    Add-Content -LiteralPath $logFile -Value $line -Encoding UTF8
}

function Show-Fail($message) {
    Write-Log "ERROR: $message"
    try {
        Add-Type -AssemblyName System.Windows.Forms
        [System.Windows.Forms.MessageBox]::Show(
            "任务面板没启动成功。`r`n`r`n$message`r`n`r`n技术日志：`r`n$logFile",
            'Codex 任务面板'
        ) | Out-Null
    } catch { }
}

# --------------------------------------------------------------- 定位 Node
$nodeExe = $null
$onPath = Get-Command node.exe -ErrorAction SilentlyContinue
if ($onPath) { $nodeExe = $onPath.Source }
if (-not $nodeExe -and (Test-Path 'C:\Program Files\nodejs\node.exe')) {
    $nodeExe = 'C:\Program Files\nodejs\node.exe'
}
if (-not $nodeExe) {
    $versions = Join-Path $env:USERPROFILE '.workbuddy\binaries\node\versions'
    if (Test-Path $versions) {
        $found = Get-ChildItem $versions -Directory -ErrorAction SilentlyContinue |
            Sort-Object Name -Descending |
            ForEach-Object { Join-Path $_.FullName 'node.exe' } |
            Where-Object { Test-Path $_ } |
            Select-Object -First 1
        if ($found) { $nodeExe = $found }
    }
}
if (-not $nodeExe) {
    Show-Fail '找不到 Node.js。请安装 Node.js 22 以上版本后重试。'
    exit 1
}

Write-Log "启动，node = $nodeExe"

# --------------------------------------------------------------- 启动面板
$ErrorActionPreference = 'Continue'
$output = & $nodeExe (Join-Path $root 'open-panel-browser.mjs') 2>&1
foreach ($line in $output) { if ("$line") { Write-Log "  $line" } }
$code = $LASTEXITCODE

if ($code -ne 0) {
    Show-Fail ("面板引擎启动失败（退出码 $code）。`r`n最常见原因：47823 端口被别的程序占用，关掉那个程序再双击一次即可。")
    exit 1
}

Write-Log '完成，面板已在浏览器打开。'
exit 0
