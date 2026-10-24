' Codex Taskboard - hidden launcher for open-taskboard.ps1
'
' Runs the PowerShell script with NO visible console window.
'
' Do NOT wrap this in "conhost.exe --headless". That wrapper makes Windows
' Terminal register the call, and every double-click then leaves another
' "Terminal" entry in the taskbar jump list even though no window is shown.
' A GUI parent (wscript.exe) launching powershell.exe with window style 0
' already gets a hidden console host, so the wrapper buys nothing.
'
' Failure is not silent: open-taskboard.ps1 shows a MessageBox on failure.
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
ps1 = fso.BuildPath(fso.GetParentFolderName(WScript.ScriptFullName), "open-taskboard.ps1")
sh.Run "powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & ps1 & """", 0, False
