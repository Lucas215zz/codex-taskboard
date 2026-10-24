# Codex Taskboard - open panel in Codex built-in browser (in-app browser) - v2
# Changes vs v1:
#   - runs hidden (launched via open-panel-hidden.vbs, no black window)
#   - single-instance lock (rapid double-clicks won't stack up)
#   - Win32 SetForegroundWindow + Alt-key tap for reliable window activation
#     (v1's AppActivate failed on freshly launched Codex windows)
#   - skips the engine step entirely if the engine is already serving
# Pure ASCII on purpose (no BOM/encoding issues).

$ErrorActionPreference = 'Continue'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$dataDir = Join-Path $root '.data'
$panelUrl = 'http://127.0.0.1:47823/9b8a160a-3343-4df6-a16f-9265ed6773f8/'
$logFile = Join-Path $dataDir 'open-panel-codex.log'
$lockFile = Join-Path $dataDir 'open-panel.lock'

New-Item -ItemType Directory -Force -Path $dataDir | Out-Null

# ---------------------------------------------------------------- logging
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
function Log($m) {
  $line = "$(Get-Date -Format 'HH:mm:ss') $m"
  $line | Out-File -FilePath $logFile -Append -Encoding utf8
}
"=== run at $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ===" | Out-File -FilePath $logFile -Append -Encoding utf8

# ---------------------------------------------------------------- single-instance lock
if (Test-Path $lockFile) {
  $lockAge = ((Get-Date) - (Get-Item $lockFile).LastWriteTime).TotalSeconds
  if ($lockAge -lt 90) {
    Log 'SKIP: another run is already in progress (lock held)'
    exit 0
  }
}
Set-Content -Path $lockFile -Value "run" | Out-Null

$nodeExe = 'C:\Program Files\nodejs\node.exe'
if (-not (Test-Path $nodeExe)) {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $cmd) { Log 'ERROR: node not found'; exit 1 }
  $nodeExe = $cmd.Source
}

$ErrorActionPreference = 'Stop'
try {

  # -------------------------------------------------------------- 0) engine alive?
  Log 'checking panel engine...'
  $probe = & $nodeExe -e "fetch('http://127.0.0.1:47823/9b8a160a-3343-4df6-a16f-9265ed6773f8/',{redirect:'follow'}).then(r=>{console.log(r.status);process.exit(0)}).catch(()=>process.exit(1))" 2>$null
  if ($probe -eq '200') {
    Log '  engine already running, skip startup'
  } else {
    Log '  engine down, starting it (no Codex window)...'
    $engineOut = & $nodeExe (Join-Path $root 'open-panel-browser.mjs') --no-open 2>&1
    foreach ($line in $engineOut) { Log "  $line" }
    $probe2 = & $nodeExe -e "fetch('http://127.0.0.1:47823/9b8a160a-3343-4df6-a16f-9265ed6773f8/',{redirect:'follow'}).then(r=>{console.log(r.status);process.exit(0)}).catch(()=>process.exit(1))" 2>$null
    if ($probe2 -ne '200') { Log "ERROR: panel engine failed to start (probe=$probe2)"; exit 1 }
  }

  # -------------------------------------------------------------- 1) Codex window
  Log 'locating Codex window...'
  $codex = Get-Process ChatGPT -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle } | Select-Object -First 1
  $freshLaunch = $false
  if (-not $codex) {
    Log '  Codex not running, launching (your own profile, single window)...'
    Start-Process 'shell:AppsFolder\OpenAI.Codex_2p2nqsd0c76g0!App'
    $freshLaunch = $true
    for ($i = 0; $i -lt 45; $i++) {
      Start-Sleep -Seconds 1
      $codex = Get-Process ChatGPT -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle } | Select-Object -First 1
      if ($codex) { break }
    }
  }
  if (-not $codex) { Log 'ERROR: Codex window not found'; exit 1 }
  if ($freshLaunch) {
    Log '  Codex window appeared, waiting for it to settle...'
    Start-Sleep -Seconds 4
  }
  Log "  Codex window: PID $($codex.Id) handle $($codex.MainWindowHandle)"

  # -------------------------------------------------------------- 2) activate window
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName Microsoft.VisualBasic
  Add-Type -AssemblyName System.Drawing
  Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32Act {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, int dwFlags, int dwExtraInfo);
}
"@
  $activated = $false
  for ($attempt = 1; $attempt -le 8; $attempt++) {
    $codex.Refresh()
    $h = $codex.MainWindowHandle
    if ($h -ne [IntPtr]::Zero) {
      # tap Alt once to bypass Windows foreground-lock, then raise + focus
      [Win32Act]::keybd_event(0x12, 0, 0, 0)
      [Win32Act]::keybd_event(0x12, 0, 2, 0)
      [Win32Act]::ShowWindowAsync($h, 9) | Out-Null
      Start-Sleep -Milliseconds 200
      [void][Win32Act]::SetForegroundWindow($h)
      Start-Sleep -Milliseconds 350
      if ([Win32Act]::GetForegroundWindow() -eq $h) { $activated = $true; break }
      if ([Microsoft.VisualBasic.Interaction]::AppActivate($codex.Id)) { $activated = $true; break }
    }
    Start-Sleep -Milliseconds 500
  }
  if (-not $activated) { Log 'ERROR: could not bring Codex to front'; exit 1 }
  Log "Codex window activated (attempt $attempt)"
  Start-Sleep -Milliseconds 600

  # -------------------------------------------------------------- 3) in-app browser
  Log 'opening in-app browser (Ctrl+Shift+B) and typing panel URL...'
  [System.Windows.Forms.SendKeys]::SendWait('^+b')
  Start-Sleep -Milliseconds 2500
  [System.Windows.Forms.SendKeys]::SendWait('%d')
  Start-Sleep -Milliseconds 400
  [System.Windows.Forms.SendKeys]::SendWait($panelUrl)
  Start-Sleep -Milliseconds 300
  [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
  Start-Sleep -Seconds 4

  # -------------------------------------------------------------- 4) verification screenshot
  $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $bmp = New-Object System.Drawing.Bitmap($vs.Width, $vs.Height)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($vs.X, $vs.Y, [System.Drawing.Point]::Empty, $vs.Size)
  $shot = Join-Path $dataDir 'codex-open-result.png'
  $bmp.Save($shot, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  Log 'screenshot saved, DONE'

} catch {
  Log "ERROR: $($_.Exception.Message)"
  exit 1
} finally {
  Remove-Item $lockFile -ErrorAction SilentlyContinue
}
