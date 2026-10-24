' Codex Taskboard - hidden launcher wrapper (v2)
' Runs open-panel-in-codex.ps1 with NO visible window at all.
'
' Why conhost.exe --headless?
'   On Windows 11 the default terminal is Windows Terminal, which IGNORES
'   the hidden-window request (Run(...,0) + -WindowStyle Hidden) and pops
'   a visible Terminal window for every powershell.exe. Wrapping the call
'   in conhost.exe --headless creates a headless console host that WT
'   cannot take over, so the window truly never appears.
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
ps1 = fso.BuildPath(fso.GetParentFolderName(WScript.ScriptFullName), "open-panel-in-codex.ps1")
sh.Run "conhost.exe --headless powershell -NoProfile -ExecutionPolicy Bypass -File """ & ps1 & """", 0, False
