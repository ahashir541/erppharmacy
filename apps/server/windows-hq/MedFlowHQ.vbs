' Nuskha HQ console in its own window. Starts HQ first if it is not running.
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
url = "http://localhost:5299"

Function Ready()
  On Error Resume Next
  Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
  http.setTimeouts 1000, 1000, 2000, 2000
  http.Open "GET", url & "/hq/status", False
  http.Send
  ' 503 = running but still opening the database: do not start a second copy.
  Ready = (Err.Number = 0 And (http.Status = 200 Or http.Status = 503))
  On Error GoTo 0
End Function

If Not Ready() Then
  sh.CurrentDirectory = dir
  sh.Run "cmd /c """ & dir & "\HQ-Server.cmd""", 0, False
  For i = 1 To 90
    WScript.Sleep 1000
    If Ready() Then Exit For
  Next
  If Not Ready() Then
    MsgBox "Nuskha HQ could not start." & vbCrLf & "See " & dir & "\logs\medflow-hq.log", vbExclamation, "Nuskha HQ"
    WScript.Quit 1
  End If
End If

edge = ""
For Each p In Array(sh.ExpandEnvironmentStrings("%ProgramFiles(x86)%") & "\Microsoft\Edge\Application\msedge.exe", _
                    sh.ExpandEnvironmentStrings("%ProgramFiles%") & "\Microsoft\Edge\Application\msedge.exe")
  If fso.FileExists(p) Then edge = p
Next
If edge <> "" Then
  sh.Run """" & edge & """ --app=" & url & " --window-size=1366,820", 1, False
Else
  sh.Run url, 1, False
End If
