$script:LauncherRootKeys = @('openai_base_url', 'model_provider', 'model_catalog_json', 'model', 'model_reasoning_effort', 'model_context_window', 'model_auto_compact_token_limit')
$script:LauncherTables = @('model_providers.chatgpt_api_launcher', 'model_providers.chatgpt_api_launcher.auth', 'model_providers.chatgpt_api_mixed', 'model_providers.chatgpt_api_mixed.auth', 'model_providers.smr', 'model_providers.smr.auth')
$script:LauncherRootKeys += @('cli_auth_credentials_store', 'forced_login_method')
function Write-LauncherFile([string]$path, [string]$content) {
    $directory = Split-Path -Parent $path
    [void][IO.Directory]::CreateDirectory($directory)
    $temporary = $path + '.chatgpt-api.tmp'
    $backup = $path + '.chatgpt-api.bak'
    try {
        $stream = [IO.File]::Open($temporary,'Create','Write','None')
        try { $bytes = (New-Object Text.UTF8Encoding($false)).GetBytes($content); $stream.Write($bytes,0,$bytes.Length); $stream.Flush($true) }
        finally { $stream.Dispose() }
        if (Test-Path -LiteralPath $path) { [IO.File]::Replace($temporary,$path,$backup) }
        else { [IO.File]::Move($temporary,$path) }
    } finally {
        foreach ($scratch in @($temporary,$backup)) { if (Test-Path -LiteralPath $scratch) { Remove-Item -LiteralPath $scratch } }
    }
}
function Get-CodexHome {
    if ($env:CODEX_HOME) { return $env:CODEX_HOME }
    return (Join-Path $env:USERPROFILE '.codex')
}
function Get-RootHead([string]$content) {
    $table = [regex]::Match($content, '(?m)^[ \t]*\[')
    if ($table.Success) { return $content.Substring(0, $table.Index) }
    return $content
}
function Get-RootLine([string]$content, [string]$key) {
    $pattern = '(?m)^[ \t]*' + [regex]::Escape($key) + '[ \t]*=[^\r\n]*(?:\r?\n|$)'
    $match = [regex]::Match((Get-RootHead $content), $pattern)
    if ($match.Success) { return $match.Value }
    return $null
}
function Get-RootString([string]$content, [string]$key) {
    $line = Get-RootLine $content $key
    if (-not $line) { return '' }
    $value = ($line -split '=', 2)[1].Trim()
    if ($value.StartsWith('"')) { try { return [string]($value | ConvertFrom-Json) } catch {} }
    return $value.Trim([char]39, [char]34)
}
function Set-RootLine([string]$content, [string]$key, $line) {
    $head = Get-RootHead $content
    $tail = $content.Substring($head.Length)
    $pattern = '(?m)^[ \t]*' + [regex]::Escape($key) + '[ \t]*=[^\r\n]*(?:\r?\n|$)'
    if ([regex]::IsMatch($head, $pattern)) {
        $head = [regex]::Replace($head, $pattern, [System.Text.RegularExpressions.MatchEvaluator]{ param($m) [string]$line })
    } elseif ($null -ne $line) { $head = [string]$line + $head }
    return $head + $tail
}
function Set-RootString([string]$content, [string]$key, [string]$value) {
    return Set-RootLine $content $key ($key + ' = ' + (Quote-TomlString $value) + [Environment]::NewLine)
}
function Get-TablePattern([string]$name) {
    return '(?ms)^[ \t]*\[' + [regex]::Escape($name) + '\][^\r\n]*(?:\r?\n|$).*?(?=^[ \t]*\[|\z)'
}
function Get-TableText([string]$content, [string]$name) {
    $match = [regex]::Match($content, (Get-TablePattern $name))
    if ($match.Success) { return $match.Value }
    return $null
}
function Set-TableText([string]$content, [string]$name, $text) {
    $pattern = Get-TablePattern $name
    if ([regex]::IsMatch($content, $pattern)) {
        return [regex]::Replace($content, $pattern, [System.Text.RegularExpressions.MatchEvaluator]{ param($m) [string]$text })
    }
    if ($null -ne $text) { return $content.TrimEnd() + [Environment]::NewLine + [Environment]::NewLine + [string]$text }
    return $content
}
function Get-SavedChatGPTLogin([string]$homePath) {
    $authPath = Join-Path $homePath 'auth.json'
    if (-not (Test-Path -LiteralPath $authPath)) { return $false }
    try {
        $auth = [System.IO.File]::ReadAllText($authPath) | ConvertFrom-Json
        return ((-not $auth.auth_mode -or $auth.auth_mode -eq 'chatgpt') -and [bool]$auth.tokens.access_token)
    } catch { return $false }
}
function Get-LauncherRouteMode([ValidateSet('official','api','apionly')][string]$entryMode, [string]$homePath) {
    if ($entryMode -eq 'apionly') { return 'gateway' }
    if ($entryMode -eq 'official' -or (Get-SavedChatGPTLogin $homePath)) { return 'mixed' }
    return 'gateway'
}
function Set-LauncherProvider([string]$content, [string]$id, [string]$baseUrl, [string]$packageDir, [bool]$websocket) {
    $nl = [Environment]::NewLine
    $table = 'model_providers.' + $id
    $body = @(('[' + $table + ']'), 'name = "Custom API"', ('base_url = ' + (Quote-TomlString $baseUrl)), 'wire_api = "responses"', 'requires_openai_auth = false', 'http_headers = { "x-openai-actor-authorization" = "chatgpt-api-local" }', ('supports_websockets = ' + $websocket.ToString().ToLowerInvariant()), '') -join $nl
    $command = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $argsText = ConvertTo-Json -InputObject @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',(Join-Path $packageDir 'Read-ApiKey.ps1')) -Compress
    $auth = @(('[' + $table + '.auth]'), ('command = ' + (Quote-TomlString $command)), ('args = ' + $argsText), 'timeout_ms = 30000', 'refresh_interval_ms = 0', '') -join $nl
    $existingBody = Get-TableText $content $table
    if (-not $existingBody -or $existingBody.TrimEnd() -cne $body.TrimEnd()) {
        $content = Set-TableText $content $table $body
    }
    $existingAuth = Get-TableText $content ($table + '.auth')
    if ($existingAuth -and $existingAuth.TrimEnd() -ceq $auth.TrimEnd()) { return $content }
    return Set-TableText $content ($table + '.auth') $auth
}
function Get-NativeRepairCli([string]$installLocation, [string]$cacheRoot = (Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin')) {
    # WindowsApps executables cannot necessarily be launched outside package
    # activation. Reuse the client's own relocated, byte-identical executable.
    $source = Join-Path $installLocation 'app\resources\codex.exe'
    if (-not (Test-Path -LiteralPath $source) -or -not (Test-Path -LiteralPath $cacheRoot)) { return $null }
    $sourceFile = Get-Item -LiteralPath $source
    $sourceHash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash
    foreach ($directory in @(Get-ChildItem -LiteralPath $cacheRoot -Directory | Sort-Object LastWriteTimeUtc -Descending)) {
        $candidate = Join-Path $directory.FullName 'codex.exe'
        if (-not (Test-Path -LiteralPath $candidate)) { continue }
        if ((Get-Item -LiteralPath $candidate).Length -eq $sourceFile.Length -and (Get-FileHash -LiteralPath $candidate -Algorithm SHA256).Hash -eq $sourceHash) { return $candidate }
    }
    return $null
}
function Get-NativeClientVersion([string]$installLocation = '') {
    if (-not $installLocation) {
        $package = Get-AppxPackage -Name OpenAI.Codex | Sort-Object Version -Descending | Select-Object -First 1
        if (-not $package) { return '' }
        $installLocation = $package.InstallLocation
    }
    $cli = Get-NativeRepairCli $installLocation
    # A saved model catalog describes the client that fetched it, not the
    # currently installed client. Ask the byte-identical native executable.
    $temporaryCli = $null
    try {
        if (-not $cli) {
            # Immediately after an app update the native relocated CLI cache
            # may not exist yet. Probe an exact temporary copy in the adapter;
            # WindowsApps executables cannot run directly outside activation.
            $source = Join-Path $installLocation 'app\resources\codex.exe'
            if (-not (Test-Path -LiteralPath $source)) { return '' }
            $scriptFile = $MyInvocation.MyCommand.ScriptBlock.File
            $cache = Join-Path (Split-Path -Parent (Split-Path -Parent $scriptFile)) 'data\cache'
            [void][IO.Directory]::CreateDirectory($cache)
            $temporaryCli = Join-Path $cache ('native-version-' + [Guid]::NewGuid().ToString('N') + '.exe')
            [IO.File]::Copy($source,$temporaryCli,$false)
            $cli = $temporaryCli
        }
        $version = (& $cli --version 2>$null | Out-String).Trim()
        if ($LASTEXITCODE -eq 0 -and $version -match '^codex-cli (\d+\.\d+\.\d+)(?:[-+\s]|$)') { return $Matches[1] }
    } catch { return '' }
    finally { if ($temporaryCli -and (Test-Path -LiteralPath $temporaryCli)) { Remove-Item -LiteralPath $temporaryCli -Force } }
    return ''
}
function Set-LauncherMixedProvider([string]$content, [string]$baseUrl, [string]$packageDir, [bool]$signedIn, [string]$id = 'chatgpt_api_mixed', [bool]$officialOnly = $false) {
    if (-not $signedIn) { return Set-LauncherProvider $content $id $baseUrl $packageDir $false }
    # Keep native account authentication while selecting native text compaction.
    # The router still sends official models directly to OpenAI and replaces
    # authentication only on requests sent to the external API.
    $table = 'model_providers.' + $id
    # Native OpenAI provider behavior (including remote compaction) is selected
    # by its name. Use it only for the entry whose router is official-only.
    $name = if ($officialOnly) { 'OpenAI' } else { 'ChatGPT API compatibility' }
    $body = @(('[' + $table + ']'), ('name = ' + (Quote-TomlString $name)), ('base_url = ' + (Quote-TomlString $baseUrl)), 'wire_api = "responses"', 'requires_openai_auth = true', 'supports_websockets = true', '') -join [Environment]::NewLine
    $content = Set-TableText $content ($table + '.auth') $null
    return Set-TableText $content $table $body
}
function Read-LauncherState([string]$packageDir) {
    $path = Get-LauncherDataPath $packageDir 'launcher-state.json'
    if (Test-Path -LiteralPath $path) { return ([System.IO.File]::ReadAllText($path) | ConvertFrom-Json) }
    return $null
}
function Restore-LauncherRootLine([string]$content, [string]$key, [string]$line, [string]$original) {
    if (-not $line -or (Get-RootLine $content $key)) { return Set-RootLine $content $key $line }
    $head = Get-RootHead $content
    $oldHead = Get-RootHead $original
    $pattern = '(?m)^[ \t]*' + [regex]::Escape($key) + '[ \t]*=[^\r\n]*(?:\r?\n|$)'
    $old = [regex]::Match($oldHead, $pattern)
    if (-not $old.Success) { return Set-RootLine $content $key $line }
    foreach ($next in [regex]::Matches($oldHead.Substring($old.Index + $old.Length), '(?m)^[ \t]*([A-Za-z_][A-Za-z0-9_]*)[ \t]*=')) {
        $position = [regex]::Match($head, '(?m)^[ \t]*' + [regex]::Escape($next.Groups[1].Value) + '[ \t]*=')
        if ($position.Success) { return $content.Insert($position.Index, $line) }
    }
    return $content.Insert($head.Length, $line)
}
function Restore-LauncherTable([string]$content, [string]$name, [string]$original) {
    $table = Get-TableText $original $name
    if (-not $table -or (Get-TableText $content $name)) { return Set-TableText $content $name $table }
    # Signing in temporarily removes the API-key auth table. Restore it in its
    # original position even when the user changed another setting meanwhile.
    $old = [regex]::Match($original, (Get-TablePattern $name))
    foreach ($next in [regex]::Matches($original.Substring($old.Index + $old.Length), '(?m)^[ \t]*(\[[^\r\n]+\])')) {
        $position = [regex]::Match($content, '(?m)^[ \t]*' + [regex]::Escape($next.Groups[1].Value))
        if ($position.Success) { return $content.Insert($position.Index, $table) }
    }
    return Set-TableText $content $name $table
}
function Restore-LauncherConfig([string]$packageDir, [string]$configPath) {
    $compatibility = Join-Path $packageDir 'data\state\thread-provider-compatibility.json'
    $state = Read-LauncherState $packageDir
    if ($state -and $state.active) {
        if ([IO.Path]::GetFullPath($state.configPath) -ne [IO.Path]::GetFullPath($configPath)) { throw '切换记录属于另一个配置目录，已停止自动恢复。' }
        $current = if (Test-Path -LiteralPath $configPath) { [System.IO.File]::ReadAllText($configPath) } else { '' }
        if ($state.entryMode -eq 'apionly') {
            $state | Add-Member -NotePropertyName lastApiOnlyModel -NotePropertyValue (Get-RootString $current 'model') -Force
            $state | Add-Member -NotePropertyName lastApiOnlyEffort -NotePropertyValue (Get-RootString $current 'model_reasoning_effort') -Force
        } elseif ($state.entryMode -ne 'official') {
            $state.lastApiModel = Get-RootString $current 'model'
            $state.lastApiEffort = Get-RootString $current 'model_reasoning_effort'
        }
        $body = [regex]::Replace($current, '(?m)^[ \t]*#[^\r\n]*', '').Trim()
        $damaged = $body -and $body -notmatch '(?m)^[^\r\n#]*=|^[ \t]*\['
        if ($current -ceq $state.applied -or $damaged) { $restored = [string]$state.original } else {
            $restored = $current
            foreach ($key in $script:LauncherRootKeys) { $restored = Restore-LauncherRootLine $restored $key (Get-RootLine $state.original $key) $state.original }
            foreach ($table in $script:LauncherTables) { $restored = Restore-LauncherTable $restored $table $state.original }
            $restored = $restored.TrimEnd() + [regex]::Match($state.original, '[\r\n\t ]*\z').Value
        }
        if ($state.PSObject.Properties['originalExisted'] -and -not $state.originalExisted -and $restored.Length -eq 0) { if (Test-Path -LiteralPath $configPath) { Remove-Item -LiteralPath $configPath } }
        else { Write-LauncherFile $configPath $restored }
        $state.active = $false
        $state.original = $null; $state.applied = $null
        Write-LauncherFile (Get-LauncherDataPath $packageDir 'launcher-state.json') ($state | ConvertTo-Json -Depth 8)
    }
    if (Get-Command Repair-LegacyLauncherConfig -ErrorAction SilentlyContinue) { Repair-LegacyLauncherConfig $packageDir $configPath }
    $desktopJournal = Join-Path $packageDir 'data\state\desktop-state-compatibility.json'
    if (Test-Path -LiteralPath $desktopJournal) {
        & (Join-Path $packageDir 'runtime\node.exe') (Join-Path $packageDir 'src\desktop-state.mjs') 'restore' (Split-Path -Parent $configPath) $packageDir
        if ($LASTEXITCODE -ne 0) { throw '桌面项目配置尚未恢复，请查看恢复日志。' }
    }
    # Native routing and preferences remain usable if history recovery needs retry.
    if (Test-Path -LiteralPath $compatibility) {
        $restoredThreads = & (Join-Path $packageDir 'runtime\node.exe') (Join-Path $packageDir 'src\repair-thread-providers.mjs') 'restore' (Split-Path -Parent $configPath) $packageDir 2> (Join-Path $packageDir 'data\logs\provider-restore-stderr.log')
        if ($LASTEXITCODE -ne 0) { throw '对话的临时通道设置尚未恢复，请查看 data\logs\provider-restore-stderr.log。' }
    }
    foreach ($scratch in @(($configPath + '.chatgpt-api.tmp'), ($configPath + '.chatgpt-api.bak'), (Join-Path (Split-Path -Parent $configPath) '.codex-global-state.json.chatgpt-api.tmp'))) {
        if (Test-Path -LiteralPath $scratch) { Remove-Item -LiteralPath $scratch }
    }
}
function Apply-LauncherConfig([string]$packageDir, [string]$configPath, [string]$mode, [string]$shimBase, [string]$gatewayBase, [ValidateSet('api','official','apionly')][string]$entryMode = 'api') {
    if ($entryMode -eq 'apionly') { $mode = 'gateway' }
    $signedIn = $mode -eq 'mixed'
    $originalExisted = Test-Path -LiteralPath $configPath
    $original = if ($originalExisted) { [IO.File]::ReadAllText($configPath) } else { '' }
    $previous = Read-LauncherState $packageDir
    $content = Set-RootString $original 'openai_base_url' $shimBase
    if (-not $signedIn) {
        # The provider's requires_openai_auth=false selects API authentication.
        # Keep the user's credential store so explicit sign-ins remain persistent.
        $content = Set-RootLine $content 'forced_login_method' $null
    }
    if ($entryMode -eq 'official') { $content = Set-RootLine $content 'model_catalog_json' $null }
    else { $content = Set-RootString $content 'model_catalog_json' (Get-LauncherDataPath $packageDir 'models-smr.json') }
    foreach ($id in @('chatgpt_api_launcher','chatgpt_api_mixed','smr')) {
        if ($id -eq 'chatgpt_api_launcher' -or (Get-TableText $content ('model_providers.' + $id))) { $content = Set-LauncherMixedProvider $content $shimBase $packageDir $signedIn $id }
    }
    # One runtime binding across entries. Old bindings are temporarily overlaid
    # by the launch helper and restored when the native client exits.
    $provider = 'chatgpt_api_launcher'
    $content = Set-LauncherMixedProvider $content $shimBase $packageDir $signedIn $provider ($entryMode -eq 'official')
    if ($entryMode -eq 'official') {
        $catalog = [IO.File]::ReadAllText((Get-LauncherDataPath $packageDir 'catalog-state.json')) | ConvertFrom-Json
        $ids = @($catalog.official | ForEach-Object { [string]$_.slug })
    } else {
        $catalog = [IO.File]::ReadAllText((Get-LauncherDataPath $packageDir 'models-smr.json')) | ConvertFrom-Json
        $ids = @($catalog.models | ForEach-Object { [string]$_.slug })
    }
    $selected = Get-RootString $original 'model'
    if ($ids.Count -and $ids -cnotcontains $selected) {
        if ($entryMode -eq 'apionly' -and $previous.lastApiOnlyModel -and $ids -ccontains $previous.lastApiOnlyModel) { $selected = $previous.lastApiOnlyModel }
        elseif ($entryMode -eq 'api' -and $previous.lastApiModel -and $ids -ccontains $previous.lastApiModel) { $selected = $previous.lastApiModel }
        elseif ($ids -ccontains 'GPT/gpt-6-sol') { $selected = 'GPT/gpt-6-sol' }
        else { $selected = $ids[0] }
        $content = Set-RootString $content 'model' $selected
    }
    # The helper restores original bindings after the application lifetime.
    $content = Set-RootString $content 'model_provider' $provider
    if ($entryMode -ne 'official') {
        # Model-specific catalog limits must not be overridden by a global GPT window.
        $content = Set-RootLine $content 'model_context_window' $null
        $content = Set-RootLine $content 'model_auto_compact_token_limit' $null
    }
    $state = [ordered]@{ version = 2; active = $true; mode = $mode; entryMode = $entryMode; configPath = $configPath; originalExisted = $originalExisted; original = $original; applied = $content; startedAt = [DateTime]::UtcNow.ToString('o'); lastApiModel = $(if ($entryMode -eq 'api') { $selected } else { $previous.lastApiModel }); lastApiEffort = $(if ($entryMode -eq 'api') { Get-RootString $original 'model_reasoning_effort' } else { $previous.lastApiEffort }); lastApiOnlyModel = $(if ($entryMode -eq 'apionly') { $selected } else { $previous.lastApiOnlyModel }); lastApiOnlyEffort = $(if ($entryMode -eq 'apionly') { Get-RootString $original 'model_reasoning_effort' } else { $previous.lastApiOnlyEffort }) }
    # Journal first, so a crash while switching can be recovered by either entry.
    Write-LauncherFile (Get-LauncherDataPath $packageDir 'launcher-state.json') ($state | ConvertTo-Json -Depth 8)
    Write-LauncherFile $configPath $content
}
