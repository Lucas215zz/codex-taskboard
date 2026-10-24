param([switch]$DryRun)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"   # 关掉 Invoke-WebRequest 的进度条刷屏

# ============================================================
#  Codex Taskboard - one-click launcher (single window mode)
#
#  Safe to run at any time, it always picks the cheapest fix:
#    1. Codex already carries the panel -> show it again, nothing restarts
#    2. Codex has the debug port       -> start the injector only, nothing restarts
#    3. Codex has neither              -> restart Codex once with the debug port
#  Only case 3 closes your windows, and it warns + counts down 10s first.
#
#  The injector runs detached and hidden, so closing this console never kills
#  the panel. Re-run this file (or the desktop shortcut) any time to repair it.
#
#  -DryRun reports what would happen and changes nothing.
# ============================================================

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$cdpPort = 9231
$servicePort = 47823
$logFile = Join-Path $projectRoot ".data\single-injector.log"

function Say($text, $color = "Gray") { Write-Host $text -ForegroundColor $color }

function Show-Error($message) {
    Write-Host ""
    Say "  [X] 出错了" "Red"
    Say "      $message" "Red"
    Write-Host ""
    # 弹窗仅限真实交互桌面（双击场景）；后台/无头环境下 MessageBox
    # 会永远挂住等待点击，必须跳过。
    if ([Environment]::UserInteractive -and $Host.Name -eq "ConsoleHost") {
        try {
            Add-Type -AssemblyName System.Windows.Forms
            [System.Windows.Forms.MessageBox]::Show(
                "Codex 任务面板启动失败：`r`n`r`n$message`r`n`r`n日志：$logFile.err",
                "Codex 任务面板"
            ) | Out-Null
        } catch { }
    }
    Say "  按任意键关闭这个窗口..." "DarkGray"
    try { $null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown") } catch { }
}

function Finish {
    Write-Host ""
    Say "  本窗口 5 秒后自动关闭，任务面板引擎继续在后台运行。" "DarkGray"
    for ($i = 5; $i -gt 0; $i--) {
        Write-Host ("      {0} ...（按任意键立即关闭）" -f $i) -NoNewline
        try {
            if ($Host.UI.RawUI.KeyAvailable) { break }
        } catch { break }   # 非交互控制台没有 KeyAvailable，直接结束等待
        Start-Sleep -Seconds 1
        Write-Host "`r`r"
    }
}

# ------------------------------------------------------------------ locate node
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
if (-not $nodeExe) { throw "找不到 Node.js。请安装 Node.js 22+ 后重试。" }

# ------------------------------------------------------------------ locate Codex
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
if (-not $codexApp) { throw "找不到 Codex 应用（ChatGPT.exe）。请确认已安装微软商店版 Codex。" }

# An argument containing spaces (C:\Program Files\...) must keep its quotes.
# Otherwise node receives "Files\WindowsApps\..." as a separate argument and the
# injector dies with "Unknown option". That bug is what broke the old shortcut.
$appArg = '"' + $codexApp + '"'

function Test-TcpPort($port) {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $async = $client.BeginConnect("127.0.0.1", $port, $null, $null)
        return $async.AsyncWaitHandle.WaitOne(800, $false)
    } catch {
        return $false
    } finally {
        $client.Close()
    }
}

function Test-Cdp($port) {
    try {
        # -UseBasicParsing 必不可少：PS 5.1 首次用 Invoke-WebRequest 会弹
        # 「安全警告」要求交互确认，双击场景直接卡死在这里。
        $null = Invoke-WebRequest "http://127.0.0.1:$port/json/version" -TimeoutSec 2 -UseBasicParsing
        return $true
    } catch {
        return $false
    }
}

function Get-CodexRoots {
    return @(Get-CimInstance Win32_Process -Filter "Name = 'ChatGPT.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -notmatch '--type=' })
}

function Get-InjectorCount {
    return @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -match 'codex-injector' }).Count
}

function Start-InjectorDetached {
    $env:CODEX_TASKBOARD_HOST = "127.0.0.1"
    $env:PATH = "$(Split-Path -Parent $nodeExe);$env:PATH"
    New-Item -ItemType Directory -Force -Path (Join-Path $projectRoot ".data") | Out-Null
    # 不能用 Start-Process：本机 HTTP_PROXY/http_proxy 大小写并存会让它抛
    # 「已添加项。字典中的关键字」异常 —— 改用 node spawn-detached.mjs 脱离启动。
    # 同时放宽 ErrorActionPreference，避免 spawn-detached 的 stderr 误伤脚本。
    $previous = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $pidText = & $nodeExe (Join-Path $projectRoot "spawn-detached.mjs") `
            "scripts\codex-injector.mjs" "--launch" "--watch" "--open" `
            "--port" "$cdpPort" "--app-path" $appArg 2>&1
    } finally {
        $ErrorActionPreference = $previous
    }
    $childPid = 0
    foreach ($line in $pidText) { if ("$line" -match '^\s*(\d+)\s*$') { $childPid = [int]$Matches[1] } }
    if ($childPid -le 0) { throw "注入器没能启动：$pidText" }
    return @{ Id = $childPid }
}

function Start-ProxyManager {
    # 自定义模型（kkidc / zhipu / agentaipilot）走本地 Responses->Chat 协议代理，
    # 面板挂上了但代理没跑的话，对话照样失败 —— 所以必须补上这一步。
    # proxy-manager.mjs 幂等：已在跑则复用端口，不会重复启动。
    # 同样必须走 spawn-detached.mjs（Start-Process 会因代理变量大小写重复而炸）。
    Say "  正在确保模型代理已启动..."
    $previous = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $null = & $nodeExe (Join-Path $projectRoot "spawn-detached.mjs") "proxy-manager.mjs" 2>&1
    } finally {
        $ErrorActionPreference = $previous
    }
    Start-Sleep -Seconds 6
}

function Wait-For($seconds, $test) {
    for ($i = 0; $i -lt $seconds; $i++) {
        if (& $test) { return $true }
        Start-Sleep -Seconds 1
    }
    return (& $test)
}

# 调用 node 脚本并把输出透传到控制台。
# 关键：本脚本 $ErrorActionPreference = "Stop"，而 PS 5.1 中外部命令的
# stderr 输出（如 Node 的 SQLite ExperimentalWarning）经 2>&1 混入管道后
# 会被当成「终止错误」抛出，直接炸掉整个脚本 —— 所以调用期间必须临时放宽。
# $LASTEXITCODE 是全局的，函数返回后依然可读。
function Invoke-NodeLogOutput {
    param([Parameter(Mandatory = $true)][string[]]$NodeArgs)
    $previous = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        & $nodeExe @NodeArgs 2>&1 | ForEach-Object { if ("$_") { Say "       $_" } }
    } finally {
        $ErrorActionPreference = $previous
    }
}

function Show-Panel {
    Push-Location $projectRoot
    # 注入刚完成时 iframe 可能还在加载（页面显示「服务未就绪」），重试几次
    $ready = $false
    for ($i = 1; $i -le 3; $i++) {
        Invoke-NodeLogOutput @("refresh-panel.mjs")
        if ($LASTEXITCODE -eq 0) { $ready = $true; break }
        if ($i -lt 3) {
            Say "       面板还在初始化，5 秒后重试（$i/3）..." "DarkGray"
            Start-Sleep -Seconds 5
        }
    }
    Pop-Location
    if (-not $ready) { Say "       （面板仍在初始化，稍等几秒会自动就绪，不影响使用）" "DarkGray" }
}

try {
    Write-Host ""
    Write-Host "============================================" -ForegroundColor Cyan
    Write-Host "   Codex 任务面板（一键启动 · 单窗口）" -ForegroundColor Cyan
    Write-Host "============================================" -ForegroundColor Cyan
    Write-Host ""
    if ($DryRun) { Say "  [演练模式] 只检查不改动" "Magenta" }
    Say "  Codex : $codexApp" "DarkGray"

    # 必须用 @() 包一层：函数返回单条记录时 PowerShell 会把数组拆成标量，
    # 而 PS 5.1 的 CimInstance 没有 .Count 属性，$roots.Count 会是空值，
    # 于是脚本永远误判成「Codex 没运行」，直接跳到重启分支。
    $roots = @(Get-CodexRoots)
    $hasCdp = @($roots | Where-Object { $_.CommandLine -match "remote-debugging-port=$cdpPort" }).Count -gt 0
    $cdpAlive = Test-Cdp $cdpPort
    $injectorCount = Get-InjectorCount

    Say "  状态 : Codex $(if ($roots.Count) { '运行中' } else { '未运行' }) / 调试端口 $(if ($cdpAlive) { '已开' } else { '未开' }) / 引擎 $(if ($injectorCount) { '运行中' } else { '未运行' })" "DarkGray"
    Write-Host ""

    # ---------- case 1 and 2: never restart Codex ----------
    if ($hasCdp -and $cdpAlive) {
        if ($injectorCount -eq 0) {
            Say "  [1/3] Codex 状态正常，正在把面板挂上去..."
            if ($DryRun) {
                Say "        （演练）本应在这里启动面板引擎" "Magenta"
            } else {
                # 先清掉上次异常退出留下的孤儿：旧注入器 + 旧面板服务。
                # 不清的话新服务会因 SQLite 被锁反复重启
                # （日志表现：Taskboard exited (4294967295)）。
                # 此时注入器数量为 0，所以现存的 server/index.mjs 全是无主孤儿，可放心杀。
                Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
                    Where-Object { $_.CommandLine -match 'codex-injector|server[/\\]index\.mjs' } |
                    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
                Start-Sleep -Seconds 1
                for ($round = 1; $round -le 3; $round++) {
                    $listener = Get-NetTCPConnection -LocalPort $servicePort -State Listen -ErrorAction SilentlyContinue
                    if (-not $listener) { break }
                    $listener | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
                    Start-Sleep -Seconds 1
                }
                $proc = Start-InjectorDetached
                $null = Wait-For 60 { (Get-Process -Id $proc.Id -ErrorAction SilentlyContinue) -and (Test-TcpPort $servicePort) }
                Start-Sleep -Seconds 6
            }
        } else {
            Say "  [1/3] 引擎已在运行，面板就在 Codex 里。"
        }

        if (-not $DryRun) { Start-ProxyManager }

        Say "  [2/3] 正在显示面板..."
        if ($DryRun) { Say "        （演练）本应在这里显示面板" "Magenta" }
        else { Show-Panel }

        Write-Host ""
        Say "  [OK] 面板已挂上，就在 Codex 主界面里。" "Green"
        Say "       点左侧栏的 Taskboard 图标可以收起 / 再打开。" "DarkGray"
        try {
            $runtime = Get-Content (Join-Path $projectRoot ".data\launcher-runtime.json") -Raw | ConvertFrom-Json
            Say "       浏览器直开: $($runtime.url)" "DarkGray"
        } catch { }
        if (-not $DryRun) { Finish }
        exit 0
    }

    # ---------- case 3: Codex has to be restarted with the debug port ----------
    if ($roots.Count -gt 0) {
        Write-Host ""
        Say "  [!] 当前这个 Codex 启动时没带调试端口，没法直接挂面板。" "Yellow"
        Say "      面板内嵌功能必须靠调试端口，只有重启一次才装得上。" "Yellow"
        Say "      重启会关掉现在所有 Codex 窗口（未保存的对话会丢）。" "Yellow"
        Write-Host ""
        if ($DryRun) {
            Say "      （演练）本应在这里询问 Y/N，然后关闭 Codex 并带调试端口重开" "Magenta"
            exit 0
        }
        # 必须显式点头才重启。倒计时自动重启过一次，直接把用户正在写的
        # 对话窗口关掉了 —— 改成 Y/N 询问，默认 N。
        Write-Host "      现在重启 Codex 吗？" -NoNewline
        Say "输入 Y 回车 = 重启并内嵌面板    直接回车 = 算了，用浏览器打开" "Cyan"
        $answer = Read-Host "      你的选择 (Y/N)"
        if ($answer -notmatch '^\s*[Yy]') {
            Write-Host ""
            Say "  好，不重启 Codex。改用浏览器打开面板。" "Yellow"
            Push-Location $projectRoot
            $previous = $ErrorActionPreference
            $ErrorActionPreference = "Continue"
            try { & $nodeExe (Join-Path $projectRoot "open-panel-browser.mjs") 2>&1 | Out-Null }
            finally { $ErrorActionPreference = $previous }
            Pop-Location
            Write-Host ""
            Say "  [OK] 面板已在默认浏览器打开。" "Green"
            if (-not $DryRun) { Finish }
            exit 0
        }
        Say "  好，5 秒后重启 Codex（这段时间可以再按 Ctrl+C 取消）..." "DarkGray"
        Start-Sleep -Seconds 5
    } else {
        Say "  [1/3] 正在启动 Codex..."
    }

    if ($DryRun) {
        Say "      （演练）本应在这里启动带调试端口的 Codex，并把面板挂上去" "Magenta"
        exit 0
    }

    # close every Codex process, otherwise the debug port never comes up
    Get-Process ChatGPT -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    for ($i = 0; $i -lt 15; $i++) {
        if ((Get-Process ChatGPT -ErrorAction SilentlyContinue).Count -eq 0) { break }
        Start-Sleep -Seconds 1
    }
    Get-Process ChatGPT -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

    # free the panel service port
    for ($round = 1; $round -le 5; $round++) {
        $listener = Get-NetTCPConnection -LocalPort $servicePort -State Listen -ErrorAction SilentlyContinue
        if (-not $listener) { break }
        $listener | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
        Start-Sleep -Seconds 2
    }

    Say "  [2/3] 正在完整启动任务面板链路（模型同步 + 代理 + Codex + 面板）..."
    # 改用久经验证的 launch-panel.mjs 全流程（同步 WorkBuddy 模型、启动协议代理、
    # 启动带调试端口的 Codex 并注入面板）。
    # 不再用 launch-codex-cdp.ps1（默认 profile + CDP）——
    # 新版 Chromium 在默认用户数据目录上会直接忽略 --remote-debugging-port（安全限制），
    # 实测进程能起来但调试端口永远不开，注入无从谈起。
    # launch-panel.mjs 的注入器会自动把默认 profile 的浏览器数据导入独立 profile，
    # 所以日常从本入口启动即是"单窗口"：唯一的 Codex 窗口自带面板。
    # 注意：这里绝对不能用「2>&1 | ForEach-Object」管道接输出 ——
    # launch-panel.mjs 以 stdio:"inherit" spawn 的注入器(--watch 常驻)
    # 会握着管道写端不放手，管道永远等不到 EOF，窗口就永远关不掉。
    # 让输出直通控制台即可。
    Push-Location $projectRoot
    $previous = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        & $nodeExe "launch-panel.mjs"
        $launchExit = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previous
    }
    Pop-Location
    if ($launchExit -ne 0) {
        throw "launch-panel.mjs 执行失败（退出码 $launchExit）。日志见 $projectRoot\.data"
    }

    # AUMID 激活链有时会延迟 20~30 秒拉起一个「无参数、默认 profile」的多余
    # Codex 窗口（这正是双窗口问题的根源）。注入版带 --user-data-dir，
    # 多余的裸实例没有任何参数 —— 扫描 45 秒（实测约 23 秒出现），发现即清。
    Say "  正在检查多余窗口（最多 45 秒，出现即清理）..."
    $strayCleaned = 0
    for ($round = 1; $round -le 15; $round++) {
        $stray = @(Get-CimInstance Win32_Process -Filter "Name = 'ChatGPT.exe'" -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandLine -notmatch '--type=' -and $_.CommandLine -notmatch 'remote-debugging-port' })
        foreach ($s in $stray) {
            Say "  清理多余的裸 Codex 窗口 (PID $($s.ProcessId))..." "DarkGray"
            Stop-Process -Id $s.ProcessId -Force -ErrorAction SilentlyContinue
            $strayCleaned++
        }
        if ($round -lt 15) { Start-Sleep -Seconds 3 }
    }
    if ($strayCleaned -eq 0) { Say "  无多余窗口。" "DarkGray" }

    Write-Host ""
    Say "  [OK] 面板已挂上，就在 Codex 主界面里。" "Green"
    Say "       点左侧栏的 Taskboard 图标可以收起 / 再打开。" "DarkGray"
    Finish
    exit 0
} catch {
    Show-Error $_.Exception.Message
    exit 1
}
