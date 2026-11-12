Option Explicit
Dim shell, files, root
Set shell = CreateObject("WScript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")
root = files.GetParentFolderName(WScript.ScriptFullName)
On Error Resume Next
shell.Run """" & root & "\runtime\node.exe"" """ & root & "\src\console.mjs""", 0, False
If Err.Number <> 0 Then MsgBox "Unable to open the console. Check the installation and its configuration.", vbExclamation, "ChatGPT API Console"
