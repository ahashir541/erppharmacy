' Starts Nuskha Local with no window. Used by the "Nuskha Local" scheduled task.
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir
sh.Run "cmd /c """ & dir & "\MedFlow-Server.cmd"" hidden", 0, False
