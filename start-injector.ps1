# Codex Taskboard - restart the Codex injector (sidebar / Codex-mode)
#
# Why this script exists:
#   The panel engine is started by open-panel-browser.mjs with a PERSISTED
#   instance secret (.data/browser-mode-secret). The injector generates a
#   random secret on every start, so the health proof never matches and the
#   injector dies with "Timed out waiting for authenticated /health".
#   This script hands the SAME token + secret to the injector, so the
#   injector reuses the running engine instead of fighting it for port 47823.
#
# Pure ASCII on purpose (no BOM/encoding issues).

$ErrorActionPreference = 'Continue'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$dataDir = Join-Path $root '.data'
$logFile = Join-Path $dataDir 'injector.log'
$errFile = Join-Path $dataDir 'injector.err.log'
$scriptLogFile = Join-Path $dataDir 'start-injector.log'
$secretFile = Join-Path $dataDir 'browser-mode-secret'
$configFile = Join-Path $root 'panel-config.mjs'

New-Item -ItemType Directory -Force -Path $dataDir | Out-Null

function Log($message) {
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $message"
    Add-Content -LiteralPath $scriptLogFile -Value $line -Encoding UTF8
}

# ---------------------------------------------------------------- node
$nodeExe = $null
$onPath = Get-Command node.exe -ErrorAction SilentlyContinue
if ($onPath) { $nodeExe = $onPath.Source }
if (-not $nodeExe -and (Test-Path 'C:\Program Files\nodejs\node.exe')) {
    $nodeExe = 'C:\Program Files\nodejs\node.exe'
}
if (-not $nodeExe) {
    Log 'ERROR: node.exe not found'
    exit 1
}

# ---------------------------------------------------------------- token
# The panel URL must stay stable (bookmarks / in-app browser links).
$token = ''
if (Test-Path $configFile) {
    $match = Select-String -Path $configFile -Pattern 'PANEL_TOKEN\s*=\s*"([^"]+)"' |
        Select-Object -First 1
    if ($match) { $token = $match.Matches[0].Groups[1].Value }
}
if (-not $token) { $token = [guid]::NewGuid().ToString() }

# ---------------------------------------------------------------- secret
if (-not (Test-Path $secretFile)) {
    $bytes = New-Object byte[] 32
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    $rng.GetBytes($bytes)
    $rng.Dispose()
    $hex = -join ($bytes | ForEach-Object { $_.ToString('x2') })
    Set-Content -LiteralPath $secretFile -Value $hex -Encoding ascii
    Log 'created a new instance secret'
}
$secret = (Get-Content -LiteralPath $secretFile -Raw).Trim()
if ($secret -notmatch '^[a-f0-9]{64}$') {
    Log 'ERROR: instance secret file is corrupted'
    exit 1
}

# ---------------------------------------------------------------- stop old injector
$old = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
    Where-Object { $_.CommandLine -match 'codex-injector' } |
    ForEach-Object { $_.ProcessId }
foreach ($oldPid in $old) {
    Stop-Process -Id $oldPid -Force -ErrorAction SilentlyContinue
    Log "stopped previous injector (PID $oldPid)"
}
if ($old) { Start-Sleep -Seconds 1 }

# ---------------------------------------------------------------- start injector
$env:CODEX_TASKBOARD_HOST = '127.0.0.1'
$env:CODEX_TASKBOARD_PORT = '47823'
$env:CODEX_TASKBOARD_INSTANCE_TOKEN = $token
$env:CODEX_TASKBOARD_INSTANCE_SECRET = $secret

Remove-Item -LiteralPath $logFile, $errFile -ErrorAction SilentlyContinue
$child = Start-Process -FilePath $nodeExe `
    -ArgumentList 'scripts/codex-injector.mjs', '--launch', '--watch', '--open', '--port', '9231' `
    -WorkingDirectory $root `
    -RedirectStandardOutput $logFile `
    -RedirectStandardError $errFile `
    -WindowStyle Hidden `
    -PassThru

Start-Sleep -Seconds 6
if (-not (Get-Process -Id $child.Id -ErrorAction SilentlyContinue)) {
    Log "ERROR: injector exited immediately, see $errFile"
    Get-Content -LiteralPath $errFile -ErrorAction SilentlyContinue | ForEach-Object { Log "  $_" }
    exit 1
}

Log "injector running (PID $($child.Id))"
Log "panel: http://127.0.0.1:47823/$token/?host=codex"
Get-Content -LiteralPath $logFile -ErrorAction SilentlyContinue | ForEach-Object { Log "  $_" }
exit 0
