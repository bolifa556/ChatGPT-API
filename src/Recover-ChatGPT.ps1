param([switch]$Immediate)
$ErrorActionPreference = 'Stop'
$packageDir = Split-Path -Parent $PSScriptRoot
. (Join-Path $packageDir 'src\Common.ps1')
. (Join-Path $packageDir 'src\Package-Paths.ps1')
. (Join-Path $packageDir 'src\Launcher-State.ps1')
. (Join-Path $packageDir 'src\Recovery-Control.ps1')
$file = Get-RecoveryPath $packageDir
$watchLock = $null
$ready = Join-Path $packageDir 'data\state\recovery-watcher.json'
try {
    try { $watchLock = [IO.File]::Open((Join-Path $packageDir 'data\state\recovery.lock'),'OpenOrCreate','ReadWrite','None') }
    catch { exit 0 }
    while (Test-Path -LiteralPath $file) {
        $state = [IO.File]::ReadAllText($file) | ConvertFrom-Json
        $identity = Get-RecoveryProcess $PID
        $identity.sessionId = $state.sessionId
        Write-LauncherFile $ready ($identity | ConvertTo-Json -Depth 4)
        $sameBoot = -not $state.boot -or ([string]$state.boot -eq (Get-RecoveryBoot))
        if (-not $Immediate -and $sameBoot) {
            if (Test-RecordedProcess $state.owner) { Wait-Process -Id $state.owner.pid -ErrorAction SilentlyContinue }
            if (-not (Test-Path -LiteralPath $file)) { break }
            $latest = [IO.File]::ReadAllText($file) | ConvertFrom-Json
            if ($latest.sessionId -ne $state.sessionId) { continue }
            if (Test-RecordedProcess $latest.client) { Wait-Process -Id $latest.client.pid -ErrorAction SilentlyContinue }
            # Include native updater replacements and launches that happen before
            # the watcher can record a concrete application PID.
            if (-not $latest.PSObject.Properties['watchNativeClients'] -or $latest.watchNativeClients) {
                foreach ($app in @(Get-CimInstance Win32_Process -Filter "name='ChatGPT.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -and $_.CommandLine -notmatch '--type=' })) {
                    Wait-Process -Id $app.ProcessId -ErrorAction SilentlyContinue
                }
            }
        }
        elseif (Test-RecordedProcess $state.client) { throw '请完全退出 ChatGPT 后再恢复配置。' }
        $lock = $null
        try {
            $lock = [IO.File]::Open((Get-LauncherDataPath $packageDir 'launcher.lock'),'OpenOrCreate','ReadWrite','None')
            $latest = [IO.File]::ReadAllText($file) | ConvertFrom-Json
            if ($latest.sessionId -ne $state.sessionId) { continue }
            Restore-LauncherConfig $packageDir $state.configPath
            Stop-LauncherRecordedHelpers $packageDir
            Unregister-LauncherRecovery $packageDir $state.sessionId
        } catch {
            Add-Content -LiteralPath (Join-Path $packageDir 'data\logs\recovery.log') -Value ((Get-Date).ToUniversalTime().ToString('o') + ' ' + $_.Exception.Message)
        } finally { if ($lock) { $lock.Dispose() } }
        if (Test-Path -LiteralPath $file) { Start-Sleep -Seconds 3 }
    }
    # A failure before native activation can leave only the automatic trigger.
    $cleanupLock = $null
    try {
        $cleanupLock = [IO.File]::Open((Get-LauncherDataPath $packageDir 'launcher.lock'),'OpenOrCreate','ReadWrite','None')
        $shortcut = Get-RecoveryShortcut $packageDir
        if (-not (Test-Path -LiteralPath $file) -and (Test-Path -LiteralPath $shortcut)) { Remove-Item -LiteralPath $shortcut -Force }
    } catch {} finally { if ($cleanupLock) { $cleanupLock.Dispose() } }
} finally {
    if ($watchLock) {
        if (Test-Path -LiteralPath $ready) { Remove-Item -LiteralPath $ready }
        $watchLock.Dispose()
    }
}
