Option Explicit
Dim shell, files, root, code
Set shell = CreateObject("WScript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")
root = files.GetParentFolderName(WScript.ScriptFullName)
code = shell.Run("""" & root & "\runtime\node.exe"" """ & root & "\src\console.mjs""", 0, True)
If code <> 0 Then MsgBox "Unable to open the console. Check the installation and its configuration.", vbExclamation, "ChatGPT API Console"
