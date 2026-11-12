param([switch]$Immediate, [string]$Session = '', [int]$ControllerPid = 0, [switch]$WaitForClient)
$ErrorActionPreference = 'Stop'
$packageDir = Split-Path -Parent $PSScriptRoot
. (Join-Path $packageDir 'src\Common.ps1')
. (Join-Path $packageDir 'src\Package-Paths.ps1')
. (Join-Path $packageDir 'src\Launcher-State.ps1')
. (Join-Path $packageDir 'src\Recovery-Control.ps1')
$file = Get-RecoveryPath $packageDir
$lock = $null
try {
    if (-not (Test-Path -LiteralPath $file)) { exit 0 }
    $state = (Read-LauncherText $file) | ConvertFrom-Json
    if ($Session -and $state.sessionId -ne $Session) { exit 0 }
    $sameBoot = -not $state.boot -or ([string]$state.boot -eq (Get-RecoveryBoot))
    # Login recovery runs once and only recorded process identities can defer it.
    if ($sameBoot -and (Test-RecordedProcess $state.client)) {
        if ($WaitForClient) { Wait-LauncherRecoveryClient $state.client }
        else { if ($Immediate) { throw '本次启动的 ChatGPT 仍在运行，尚不能恢复配置。' }; exit 0 }
    }
    if (-not $Immediate -and $sameBoot -and ((Test-RecordedProcess $state.owner) -or (Test-RecordedProcess $state.controller))) { exit 0 }
    for ($n=0; $n -lt 100 -and -not $lock; $n++) {
        try { $lock = [IO.File]::Open((Get-LauncherDataPath $packageDir 'launcher.lock'),'OpenOrCreate','ReadWrite','None') }
        catch {
            # During startup the owner holds this lock while waiting for the
            # controller. Let that owner recover after observing its failure.
            if ($Immediate -and $Session -and $ControllerPid -and $sameBoot -and (Test-RecordedProcess $state.owner)) { exit 0 }
            Start-Sleep -Milliseconds 100
        }
    }
    if (-not $lock) { throw '配置恢复正等待启动准备完成，将在下次启动时继续。' }
    if (-not (Test-Path -LiteralPath $file)) { exit 0 }
    $latest = (Read-LauncherText $file) | ConvertFrom-Json
    if ($latest.sessionId -ne $state.sessionId) { exit 0 }
    # Native CLI children can finish their final SQLite/preference writes just
    # after the desktop main exits. Retry this bounded cleanup only on failure.
    for ($attempt=0; ; $attempt++) {
        try { Restore-LauncherConfig $packageDir $state.configPath; break }
        catch {
            if ($attempt -ge 9) { throw }
            Start-Sleep -Milliseconds ([Math]::Min(1000,100 * [Math]::Pow(2,$attempt)))
        }
    }
    $except = if ($Session -and $state.controller -and [int]$state.controller.pid -eq $ControllerPid -and (Test-RecordedProcess $state.controller)) { $ControllerPid } else { 0 }
    Stop-LauncherRecordedHelpers $packageDir $except
    Unregister-LauncherRecovery $packageDir $state.sessionId
} catch {
    Write-LauncherDiagnostic $packageDir 'recovery.log' $_.Exception.Message
    exit 1
} finally { if ($lock) { $lock.Dispose() } }
