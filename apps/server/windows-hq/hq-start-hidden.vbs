' Starts Nuskha HQ with no window. Used by the "Nuskha HQ" scheduled task.
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir
sh.Run "cmd /c """ & dir & "\HQ-Server.cmd""", 0, False
