' DS Whale Pet - silent launcher (no console window).
' ASCII only on purpose: WSH reads .vbs as ANSI, so non-ASCII text can break.

Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")

base = fso.GetParentFolderName(WScript.ScriptFullName)
appDir = base & "\app"
exe = appDir & "\node_modules\electron\dist\electron.exe"

If Not fso.FileExists(exe) Then
  MsgBox "Electron not found." & vbCrLf & vbCrLf & _
         "Run this first:" & vbCrLf & "  cd """ & appDir & """" & vbCrLf & "  npm install", _
         16, "DS Whale Pet"
  WScript.Quit 1
End If

sh.CurrentDirectory = appDir
sh.Run """" & exe & """ .", 0, False
