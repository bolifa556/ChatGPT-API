function Get-RecoveryPath([string]$packageDir) { return Join-Path $packageDir 'data\state\recovery-state.json' }
function Get-RecoveryBoot { return (Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture) }
function Get-RecoveryProcess([int]$processId) {
    $p = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $processId) -ErrorAction SilentlyContinue
    if ($p) { return @{pid=$p.ProcessId;exe=$p.ExecutablePath;createdAt=$p.CreationDate.ToUniversalTime().ToString('o')} }
    return $null
}
function Get-RecoveryName([string]$packageDir) {
    $hash = [Security.Cryptography.SHA256]::Create()
    try { $id = ([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes([IO.Path]::GetFullPath($packageDir))))).Replace('-','').Substring(0,12) }
    finally { $hash.Dispose() }
    return 'ChatGPT-API-Recovery-' + $id
}
function Get-RecoveryShortcut([string]$packageDir, [string]$startup = [Environment]::GetFolderPath('Startup')) {
    return Join-Path $startup ((Get-RecoveryName $packageDir) + '.lnk')
}
function Register-LauncherRecovery([string]$packageDir, [string]$configPath, [string]$startup = [Environment]::GetFolderPath('Startup'), [string]$runKey = 'Software\Microsoft\Windows\CurrentVersion\Run') {
    $session = [Guid]::NewGuid().ToString('N')
    $shortcut = if ($startup) { Get-RecoveryShortcut $packageDir $startup } else { '' }
    $runName = Get-RecoveryName $packageDir
    $wscript = Join-Path $env:WINDIR 'System32\wscript.exe'
    $arguments = '//B //Nologo "' + (Join-Path $packageDir 'src\Recover-ChatGPT.vbs') + '"'
    $runCommand = '"' + $wscript + '" ' + $arguments
    # Record both possible triggers before creating either one. A later launch
    # can clean up an interrupted registration even if it selects another path.
    Write-LauncherFile (Get-RecoveryPath $packageDir) (@{version=3;sessionId=$session;configPath=$configPath;shortcut=$shortcut;runKey=$runKey;runName=$runName;runCommand=$runCommand;owner=(Get-RecoveryProcess $PID)}|ConvertTo-Json -Depth 5)
    if (-not $PSBoundParameters.ContainsKey('startup')) {
        # A native registry write avoids compiling the shortcut COM bridge on
        # every launch. It is removed by the same successful recovery path.
        $key = $null
        try {
            $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($runKey)
            $key.SetValue($runName,$runCommand,[Microsoft.Win32.RegistryValueKind]::String)
            $key.Flush()
            return $session
        } catch {} finally { if ($key) { $key.Dispose() } }
    }
    try {
        if (-not $shortcut) { throw 'Windows 启动目录不可用。' }
        [void][IO.Directory]::CreateDirectory($startup)
        if (-not (Get-Command Initialize-UnicodeShortcuts -ErrorAction SilentlyContinue)) { . (Join-Path $packageDir 'install\Install-Core.ps1') }
        Initialize-UnicodeShortcuts
        if ([IO.File]::Exists($shortcut)) {
            $attributes = [IO.File]::GetAttributes($shortcut)
            if ($attributes -band [IO.FileAttributes]::ReadOnly) { [IO.File]::SetAttributes($shortcut,($attributes -band (-bnot [IO.FileAttributes]::ReadOnly))) }
        }
        [ChatGPTApi.NativeShortcuts]::Save($shortcut,$wscript,$arguments,$packageDir,(Join-Path $packageDir 'assets\ChatGPT.ico'),'恢复 ChatGPT 的临时 API 配置')
        [IO.File]::SetAttributes($shortcut,([IO.File]::GetAttributes($shortcut) -bor [IO.FileAttributes]::Hidden))
        $linkFile = [IO.File]::Open($shortcut,'Open','ReadWrite','Read')
        try { $linkFile.Flush($true) } finally { $linkFile.Dispose() }
    } catch {
        $startupError = $_.Exception.Message
        $key = $null
        try {
            # HKCU Run needs no administrator rights and remains registered
            # until recovery succeeds, including after another interruption.
            $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($runKey)
            $key.SetValue($runName,$runCommand,[Microsoft.Win32.RegistryValueKind]::String)
            $key.Flush()
        } catch {
            throw ('无法登记配置恢复。启动目录写入失败（' + $shortcut + '，' + $startupError + '）。当前用户登录恢复也未能写入（' + $_.Exception.Message + '）。')
        } finally { if ($key) { $key.Dispose() } }
    }
    # Return only after a next-logon trigger is durable. The caller can now
    # apply its temporary native configuration.
    return $session
}
function Repair-LegacyLauncherConfig([string]$packageDir, [string]$configPath) {
    if (-not (Test-Path -LiteralPath $configPath)) { return }
    $text = (Read-LauncherText $configPath)
    $catalog = Get-RootString $text 'model_catalog_json'
    $base = Get-RootString $text 'openai_base_url'
    $knownCatalog = $catalog -and ($catalog -eq (Join-Path $packageDir 'models-smr.json') -or $catalog -eq (Join-Path $packageDir 'data\cache\models-smr.json'))
    $reader = Quote-TomlString (Join-Path $packageDir 'Read-ApiKey.ps1')
    $ownedProviders = @(@('chatgpt_api_launcher','chatgpt_api_mixed','smr') | Where-Object {
        $authTable = Get-TableText $text ('model_providers.' + $_ + '.auth')
        $body = Get-TableText $text ('model_providers.' + $_)
        ($authTable -and $authTable.Contains($reader)) -or ($body -and $body.Contains('# chatgpt-api-root = ' + (Quote-TomlString $packageDir)))
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
    $saved = (Read-LauncherText $record) | ConvertFrom-Json
    foreach ($key in @('openai_base_url','model_provider','model_catalog_json')) { $text = Set-RootLine $text $key $null }
    foreach ($key in @('model','model_reasoning_effort')) {
        if ($saved.$key) { $value = [string]$saved.$key; if ($value.StartsWith('"')) { $value = $value | ConvertFrom-Json }; $text = Set-RootString $text $key $value }
    }
    $baselinePath = Get-LauncherDataPath $packageDir 'config-before-launchers.toml'
    $baseline = if (Test-Path -LiteralPath $baselinePath) { (Read-LauncherText $baselinePath) } else { '' }
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
    $state = (Read-LauncherText $file) | ConvertFrom-Json
    if (-not @($state.helpers).Count) { return }
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
    $state = (Read-LauncherText $file) | ConvertFrom-Json
    if ($state.sessionId -ne $session) { throw 'Recovery session changed during startup.' }
    $state | Add-Member -NotePropertyName controller -NotePropertyValue (Get-RecoveryProcess $processId) -Force
    Write-LauncherFile $file ($state | ConvertTo-Json -Depth 5)
}
function Set-LauncherRecoveryOwner([string]$packageDir, [string]$session, [int]$processId) {
    $file = Get-RecoveryPath $packageDir
    $state = (Read-LauncherText $file) | ConvertFrom-Json
    if ($state.sessionId -ne $session) { throw 'Recovery session changed during startup.' }
    $state.owner = Get-RecoveryProcess $processId
    Write-LauncherFile $file ($state | ConvertTo-Json -Depth 5)
}
function Wait-ClosingLauncherSession([string]$packageDir) {
    $file = Get-RecoveryPath $packageDir
    if (-not (Test-Path -LiteralPath $file)) { return }
    $state = (Read-LauncherText $file) | ConvertFrom-Json
    if (-not $state.client -or (Test-RecordedProcess $state.client)) { return }
    foreach ($record in @($state.controller,$state.owner)) {
        if (-not (Test-RecordedProcess $record)) { continue }
        $process = Get-Process -Id $record.pid -ErrorAction SilentlyContinue
        if (-not $process) { continue }
        try {
            if ($process.WaitForExit(5000)) { continue }
            if ($record.pid -eq $state.controller.pid) {
                $recovering = @(Get-CimInstance Win32_Process -Filter ('ParentProcessId=' + $record.pid) | Where-Object {
                    $_.CommandLine -and $_.CommandLine.Contains((Join-Path $packageDir 'src\Recover-ChatGPT.ps1'))
                })
                # A controller with no client and no recovery worker has no
                # remaining work. End only this installation's recorded helper.
                if (-not $recovering.Count) { Stop-LauncherRecordedHelpers $packageDir }
            }
            $null = $process.WaitForExit(30000)
        } finally { $process.Dispose() }
    }
}
function Stop-LauncherRecoveryClient($entry) {
    if (-not $entry -or -not $entry.pid) { return }
    $client = Get-Process -Id $entry.pid -ErrorAction SilentlyContinue
    if (-not $client) { return }
    try {
        # Open its process handle before checking the recorded identity again.
        if (-not $client.HasExited -and (Test-RecordedProcess $entry)) {
            try { $client.Kill() } catch { if (-not $client.HasExited) { throw } }
            if (-not $client.WaitForExit(10000)) { throw '本次客户端仍在退出，配置恢复尚未完成。' }
        }
    } finally { $client.Dispose() }
}
function Set-LauncherRecoveryClient([string]$packageDir, [string]$session, $process) {
    $file = Get-RecoveryPath $packageDir
    $state = (Read-LauncherText $file) | ConvertFrom-Json
    if ($state.sessionId -ne $session) { throw 'Recovery session changed during startup.' }
    $state | Add-Member -NotePropertyName client -NotePropertyValue (Get-RecoveryProcess $process.ProcessId) -Force
    Write-LauncherFile $file ($state | ConvertTo-Json -Depth 5)
}
function Wait-LauncherNativeClient([string]$packageDir, [string]$session, $controller, [int]$idleTimeoutMs = 120000, [int]$startupTimeoutMs = 180000) {
    $statusPath = Join-Path $packageDir 'data\state\native-session.json'
    $logPath = Join-Path $packageDir 'data\logs\native-session-stderr.log'
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $idleDeadline = $idleTimeoutMs
    $progress = ''; $phase = 'controller'; $clientPid = 0; $recordedController = 0
    while ($clock.ElapsedMilliseconds -lt $startupTimeoutMs) {
        $native = $null
        if (Test-Path -LiteralPath $statusPath) {
            try { $native = (Read-LauncherText $statusPath) | ConvertFrom-Json } catch {}
        }
        if ($native -and $native.session -eq $session) {
            $phase = [string]$native.phase
            $current = $phase + '|' + $native.pid
            if ($current -ne $progress) { $progress = $current; $idleDeadline = $clock.ElapsedMilliseconds + $idleTimeoutMs }
            if ($native.stopped) {
                if ($native.error) { throw [string]$native.error }
                throw ('客户端在启动确认前已退出（退出码 ' + $native.exitCode + '，信号 ' + $native.signal + '）。')
            }
        }
        $controller.Refresh()
        if ($controller.HasExited) {
            $detail = if (Test-Path -LiteralPath $logPath) { (Read-LauncherText $logPath).Trim() } else { '' }
            throw ('客户端启动进程已退出（退出码 ' + $controller.ExitCode + '）。' + [Environment]::NewLine + $detail)
        }
        if ($native -and $native.session -eq $session) {
            if ($native.controllerPid -and [int]$native.controllerPid -ne $recordedController) {
                $actual = Get-Process -Id ([int]$native.controllerPid) -ErrorAction SilentlyContinue
                if ($actual) {
                    Set-LauncherRecoveryController $packageDir $session $actual.Id
                    Add-RouterHelper $packageDir $actual (Join-Path $packageDir 'src\native-session.mjs')
                    $recordedController = $actual.Id
                }
            }
            if ($native.pid -and [int]$native.pid -ne $clientPid) {
                $client = Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$native.pid) -ErrorAction SilentlyContinue
                if ($client) {
                    Set-LauncherRecoveryClient $packageDir $session $client
                    $clientPid = [int]$native.pid
                }
            }
            if ($native.ready -and $clientPid) {
                $client = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $clientPid) -ErrorAction SilentlyContinue
                if ($client) { return $client }
            }
        }
        if ($clock.ElapsedMilliseconds -ge $idleDeadline) { break }
        Start-Sleep -Milliseconds 100
    }
    throw ('客户端启动等待超时（阶段 ' + $phase + '），请查看 data\logs\native-session-stderr.log。')
}
function Unregister-LauncherRecovery([string]$packageDir, [string]$session) {
    $file = Get-RecoveryPath $packageDir
    if (-not (Test-Path -LiteralPath $file)) { return }
    $state = (Read-LauncherText $file) | ConvertFrom-Json
    if ($state.sessionId -ne $session) { return }
    if ($state.shortcut -and (Test-Path -LiteralPath $state.shortcut)) { Remove-Item -LiteralPath $state.shortcut -Force }
    if ($state.runKey -and $state.runName -and $state.runCommand) {
        $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey([string]$state.runKey)
        try { $registered = $key -and $key.GetValue([string]$state.runName) -ceq $state.runCommand }
        finally { if ($key) { $key.Dispose() } }
        if ($registered) {
            $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey([string]$state.runKey,$true)
            try {
                if ($key -and $key.GetValue([string]$state.runName) -ceq $state.runCommand) {
                    $key.DeleteValue([string]$state.runName,$false)
                    $key.Flush()
                }
            } finally { if ($key) { $key.Dispose() } }
        }
    }
    Remove-Item -LiteralPath $file
}
