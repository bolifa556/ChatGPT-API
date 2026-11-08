function Get-RecoveryPath([string]$packageDir) { return Join-Path $packageDir 'data\state\recovery-state.json' }
function Get-RecoveryBoot { return (Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture) }
function Get-RecoveryProcess([int]$processId) {
    $p = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $processId) -ErrorAction SilentlyContinue
    if ($p) { return @{pid=$p.ProcessId;exe=$p.ExecutablePath;createdAt=$p.CreationDate.ToUniversalTime().ToString('o')} }
    return $null
}
function Get-RecoveryShortcut([string]$packageDir, [string]$startup = [Environment]::GetFolderPath('Startup')) {
    $hash = [Security.Cryptography.SHA256]::Create()
    try { $id = ([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes([IO.Path]::GetFullPath($packageDir))))).Replace('-','').Substring(0,12) }
    finally { $hash.Dispose() }
    return Join-Path $startup ('ChatGPT-API-Recovery-' + $id + '.lnk')
}
function Register-LauncherRecovery([string]$packageDir, [string]$configPath, [string]$startup = [Environment]::GetFolderPath('Startup')) {
    $session = [Guid]::NewGuid().ToString('N')
    $shortcut = Get-RecoveryShortcut $packageDir $startup
    if (-not (Get-Command Initialize-UnicodeShortcuts -ErrorAction SilentlyContinue)) { . (Join-Path $packageDir 'install\Install-Core.ps1') }
    Initialize-UnicodeShortcuts
    # The next-logon recovery must exist before the native files are touched.
    Write-LauncherFile (Get-RecoveryPath $packageDir) (@{version=2;sessionId=$session;configPath=$configPath;shortcut=$shortcut;owner=(Get-RecoveryProcess $PID);boot=(Get-RecoveryBoot)}|ConvertTo-Json -Depth 5)
    $arguments = '//B //Nologo "' + (Join-Path $packageDir 'src\Recover-ChatGPT.vbs') + '"'
    [ChatGPTApi.NativeShortcuts]::Save($shortcut,(Join-Path $env:WINDIR 'System32\wscript.exe'),$arguments,$packageDir,(Join-Path $packageDir 'assets\ChatGPT.ico'),'恢复 ChatGPT 的临时 API 配置')
    [IO.File]::SetAttributes($shortcut,([IO.File]::GetAttributes($shortcut) -bor [IO.FileAttributes]::Hidden))
    $linkFile = [IO.File]::Open($shortcut,'Open','ReadWrite','Read')
    try { $linkFile.Flush($true) } finally { $linkFile.Dispose() }
    return $session
}
function Repair-LegacyLauncherConfig([string]$packageDir, [string]$configPath) {
    if (-not (Test-Path -LiteralPath $configPath)) { return }
    $text = [IO.File]::ReadAllText($configPath)
    $catalog = Get-RootString $text 'model_catalog_json'
    $base = Get-RootString $text 'openai_base_url'
    $knownCatalog = $catalog -and ($catalog -eq (Join-Path $packageDir 'models-smr.json') -or $catalog -eq (Join-Path $packageDir 'data\cache\models-smr.json'))
    $reader = Quote-TomlString (Join-Path $packageDir 'Read-ApiKey.ps1')
    $ownedProviders = @(@('chatgpt_api_launcher','chatgpt_api_mixed','smr') | Where-Object {
        $authTable = Get-TableText $text ('model_providers.' + $_ + '.auth')
        $authTable -and $authTable.Contains($reader)
    })
    $selectedProvider = Get-RootString $text 'model_provider'
    $ownedBase = $base -and @($ownedProviders | Where-Object {
        $body = Get-TableText $text ('model_providers.' + $_)
        $body -and $body.Contains('base_url = ' + (Quote-TomlString $base))
    }).Count -gt 0
    # 3.2.0 retained provider definitions after a normal restore. Only active
    # root settings establish a legacy override that needs its old backup.
    if (-not $knownCatalog -and $selectedProvider -notin $ownedProviders -and -not $ownedBase) { return }
    $record = Get-LauncherDataPath $packageDir 'official-settings.json'
    if (-not (Test-Path -LiteralPath $record)) { throw '旧版 API 配置缺少原设置记录，已保留现场。' }
    $saved = [IO.File]::ReadAllText($record) | ConvertFrom-Json
    foreach ($key in @('openai_base_url','model_provider','model_catalog_json')) { $text = Set-RootLine $text $key $null }
    foreach ($key in @('model','model_reasoning_effort')) {
        if ($saved.$key) { $value = [string]$saved.$key; if ($value.StartsWith('"')) { $value = $value | ConvertFrom-Json }; $text = Set-RootString $text $key $value }
    }
    $baselinePath = Get-LauncherDataPath $packageDir 'config-before-launchers.toml'
    $baseline = if (Test-Path -LiteralPath $baselinePath) { [IO.File]::ReadAllText($baselinePath) } else { '' }
    foreach ($id in @('chatgpt_api_launcher','chatgpt_api_mixed','smr')) {
        $table = 'model_providers.' + $id
        $body = Get-TableText $text $table
        if ($body -and $base -and $body.Contains($base)) {
            foreach ($name in @($table,($table + '.auth'))) { $text = Set-TableText $text $name (Get-TableText $baseline $name) }
        }
    }
    Write-LauncherFile $configPath $text
}
function Stop-LauncherRecordedHelpers([string]$packageDir, [int]$exceptProcessId = 0) {
    $file = Get-LauncherDataPath $packageDir 'runtime-state.json'
    if (-not (Test-Path -LiteralPath $file)) { return }
    $state = [IO.File]::ReadAllText($file) | ConvertFrom-Json
    foreach ($entry in @($state.helpers)) {
        if ([int]$entry.pid -eq $exceptProcessId) { continue }
        if (-not $entry.marker -or -not (Test-RecordedProcess $entry)) { continue }
        $p = Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$entry.pid) -ErrorAction SilentlyContinue
        if ($p.CommandLine -and $p.CommandLine.Contains([string]$entry.marker)) { Stop-Process -Id $entry.pid -Force -ErrorAction SilentlyContinue }
    }
    Write-LauncherFile $file '{"version":2,"helpers":[]}'
}
function Set-LauncherRecoveryController([string]$packageDir, [string]$session, [int]$processId) {
    $file = Get-RecoveryPath $packageDir
    $state = [IO.File]::ReadAllText($file) | ConvertFrom-Json
    if ($state.sessionId -ne $session) { throw 'Recovery session changed during startup.' }
    $state | Add-Member -NotePropertyName controller -NotePropertyValue (Get-RecoveryProcess $processId) -Force
    Write-LauncherFile $file ($state | ConvertTo-Json -Depth 5)
}
function Wait-LauncherSession([string]$packageDir, [string]$session, [int]$controllerId) {
    Wait-Process -Id $controllerId -ErrorAction SilentlyContinue
    $file = Get-RecoveryPath $packageDir
    if (-not (Test-Path -LiteralPath $file)) { return }
    $recovery = [IO.File]::ReadAllText($file) | ConvertFrom-Json
    if ($recovery.sessionId -ne $session) { return }
    if (Test-RecordedProcess $recovery.client) {
        # The controller exited first. End only its recorded native client
        # before removing the temporary provider from the shared configuration.
        Stop-Process -Id $recovery.client.pid -Force -ErrorAction SilentlyContinue
        Wait-Process -Id $recovery.client.pid -ErrorAction SilentlyContinue
    }
    & (Join-Path $packageDir 'src\Recover-ChatGPT.ps1') -Immediate -Session $session
}
function Set-LauncherRecoveryClient([string]$packageDir, [string]$session, $process) {
    $file = Get-RecoveryPath $packageDir
    $state = [IO.File]::ReadAllText($file) | ConvertFrom-Json
    if ($state.sessionId -ne $session) { throw 'Recovery session changed during startup.' }
    $state | Add-Member -NotePropertyName client -NotePropertyValue (Get-RecoveryProcess $process.ProcessId) -Force
    Write-LauncherFile $file ($state | ConvertTo-Json -Depth 5)
}
function Unregister-LauncherRecovery([string]$packageDir, [string]$session) {
    $file = Get-RecoveryPath $packageDir
    if (-not (Test-Path -LiteralPath $file)) { return }
    $state = [IO.File]::ReadAllText($file) | ConvertFrom-Json
    if ($state.sessionId -ne $session) { return }
    if (Test-Path -LiteralPath $state.shortcut) { Remove-Item -LiteralPath $state.shortcut -Force }
    Remove-Item -LiteralPath $file
}
