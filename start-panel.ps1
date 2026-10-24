$ErrorActionPreference = "Stop"

# 项目目录由脚本自身位置推导（移动项目不会失效）
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path

# Node 路径自动探测：先找 PATH，再找 WorkBuddy 托管版本
$nodeExe = $null
$nodeOnPath = Get-Command node -ErrorAction SilentlyContinue
if ($nodeOnPath) { $nodeExe = $nodeOnPath.Source }
if (-not $nodeExe) {
    $wbVersions = Join-Path $env:USERPROFILE ".workbuddy\binaries\node\versions"
    if (Test-Path $wbVersions) {
        $candidate = Get-ChildItem -Path $wbVersions -Directory -ErrorAction SilentlyContinue |
            Sort-Object Name -Descending |
            ForEach-Object { Join-Path $_.FullName "node.exe" } |
            Where-Object { Test-Path $_ } |
            Select-Object -First 1
        if ($candidate) { $nodeExe = $candidate }
    }
}
if (-not $nodeExe) {
    Write-Host "[错误] 找不到 Node.js，请安装 Node.js 22+ 或确保 node 在 PATH 中。" -ForegroundColor Red
    Read-Host "按任意键关闭"
    exit 1
}

# Codex 应用路径动态解析：Store 版会自动更新，不能硬编码版本号
$codexApp = $null
$appx = Get-AppxPackage -Name "OpenAI.Codex" -ErrorAction SilentlyContinue |
    ForEach-Object { Join-Path $_.InstallLocation "app\ChatGPT.exe" } |
    Where-Object { Test-Path $_ } |
    Select-Object -First 1
if ($appx) { $codexApp = $appx }
if (-not $codexApp) {
    $windowsApps = "C:\Program Files\WindowsApps"
    if (Test-Path $windowsApps) {
        $codexApp = Get-ChildItem -Path $windowsApps -Directory -Filter "OpenAI.Codex_*" -ErrorAction SilentlyContinue |
            Sort-Object Name -Descending |
            ForEach-Object { Join-Path $_.FullName "app\ChatGPT.exe" } |
            Where-Object { Test-Path $_ } |
            Select-Object -First 1
    }
}
if (-not $codexApp) {
    Write-Host "[错误] 找不到 Codex 应用（ChatGPT.exe）" -ForegroundColor Red
    Write-Host "        请确认 Microsoft Store 版 Codex 已安装。"
    Read-Host "按任意键关闭"
    exit 1
}

$profileDir = Join-Path $env:APPDATA "codex-taskboard-profile"
$cdpPort = 9231

function Write-Step($text) { Write-Host $text }

Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  Codex 任务面板启动器" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""

# 1. 停掉旧的注入器
$oldInjectors = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
  Where-Object { $_.CommandLine -match "codex-injector" }
if ($oldInjectors) {
  Write-Step "[1/3] 清理旧的注入器进程..."
  $oldInjectors | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 2
} else {
  Write-Step "[1/3] 没有旧注入器，跳过清理"
}

# 2. 停掉所有 Codex 实例（无调试端口的实例无法注入面板）
$codexProcesses = Get-CimInstance Win32_Process -Filter "Name = 'ChatGPT.exe'" |
  Where-Object { $_.CommandLine -notmatch "--type=" }
if ($codexProcesses) {
  Write-Step "[2/3] 关闭已有 Codex 窗口（带面板的实例必须重新启动）..."
  Get-Process ChatGPT -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 3
} else {
  Write-Step "[2/3] 没有运行中的 Codex，跳过关闭"
}

# 3. 释放端口
$listener = Get-NetTCPConnection -LocalPort 47823 -State Listen -ErrorAction SilentlyContinue
if ($listener) {
  Write-Step "[3/3] 释放面板服务端口..."
  $listener | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 2
} else {
  Write-Step "[3/3] 面板端口空闲，直接启动"
}

Write-Host ""
Write-Step "正在启动带任务面板的 Codex（首次可能需要几秒）..."
Write-Host ""
Write-Host "  >> 出现一个黑色窗口是正常的，那是面板的引擎" -ForegroundColor Yellow
Write-Host "  >> 它会一直运行，请不要关闭" -ForegroundColor Yellow
Write-Host "  >> Codex 窗口打开后，左侧栏找 Taskboard 图标" -ForegroundColor Yellow
Write-Host ""

$env:PATH = "$(Split-Path -Parent $nodeExe);$env:PATH"
$env:CODEX_TASKBOARD_HOST = "127.0.0.1"
$env:CODEX_TASKBOARD_CODEX_PROFILE = $profileDir

Set-Location $projectRoot
$injector = Start-Process -FilePath $nodeExe -ArgumentList @(
  "scripts\codex-injector.mjs", "--launch", "--watch", "--open",
  "--port", $cdpPort, "--app-path", $codexApp
) -PassThru -NoNewWindow

Start-Sleep -Seconds 12
Write-Step "正在刷新面板加载..."
& $nodeExe "refresh-panel.mjs"
Start-Sleep -Seconds 2

Write-Host ""
Write-Step "面板已就绪，Codex 左侧栏找 Taskboard 图标即可。" -ForegroundColor Green
Write-Host "  >> 黑色窗口是引擎，请保持运行" -ForegroundColor Yellow
Write-Host ""

$injector.WaitForExit()
Write-Host ""
Write-Host "面板服务已退出。按任意键关闭此窗口。" -ForegroundColor Yellow
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
