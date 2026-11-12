Option Explicit
Dim shell, fso, root, command, index, code
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
shell.CurrentDirectory = root
If WScript.Arguments.Count = 5 Then
    command = Chr(34) & fso.BuildPath(root, "runtime\node.exe") & Chr(34) & " --expose-gc " & Chr(34) & fso.BuildPath(root, "src\native-session.mjs") & Chr(34) & " " & Chr(34) & root & Chr(34)
    For index = 0 To 4
        command = command & " " & Chr(34) & WScript.Arguments(index) & Chr(34)
    Next
    ' Run waits on the process handle; this does not poll the process list.
    code = shell.Run(command, 0, True)
    If fso.FileExists(fso.BuildPath(root, "data\state\recovery-state.json")) Then
        command = Chr(34) & shell.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\WindowsPowerShell\v1.0\powershell.exe" & Chr(34) & " -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File " & Chr(34) & fso.BuildPath(root, "src\Recover-ChatGPT.ps1") & Chr(34) & " -Immediate -WaitForClient -Session " & WScript.Arguments(4)
        code = shell.Run(command, 0, True)
    End If
    WScript.Quit code
ElseIf WScript.Arguments.Count = 0 Then
    command = Chr(34) & shell.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\WindowsPowerShell\v1.0\powershell.exe" & Chr(34) & " -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File " & Chr(34) & fso.BuildPath(root, "src\Recover-ChatGPT.ps1") & Chr(34)
    shell.Run command, 0, False
Else
    WScript.Quit 1
End If
