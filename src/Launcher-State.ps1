$script:LauncherRootKeys = @('openai_base_url', 'model_provider', 'model_catalog_json', 'model', 'model_reasoning_effort')
$script:LauncherTables = @('model_providers.chatgpt_api_launcher', 'model_providers.chatgpt_api_launcher.auth', 'model_providers.chatgpt_api_mixed', 'model_providers.chatgpt_api_mixed.auth', 'model_providers.smr', 'model_providers.smr.auth')
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
    $body = @(('[' + $table + ']'), 'name = "Custom API"', ('base_url = ' + (Quote-TomlString $baseUrl)), 'wire_api = "responses"', 'requires_openai_auth = false', ('supports_websockets = ' + $websocket.ToString().ToLowerInvariant()), '') -join $nl
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
    if (-not $cli) { return '' }
    # A saved model catalog describes the client that fetched it, not the
    # currently installed client. Ask the byte-identical native executable.
    $version = (& $cli --version | Out-String).Trim()
    if ($LASTEXITCODE -eq 0 -and $version -match '^codex-cli (\d+\.\d+\.\d+)(?:[-+\s]|$)') { return $Matches[1] }
    return ''
}
function Set-LauncherMixedProvider([string]$content, [string]$baseUrl, [string]$packageDir, [bool]$signedIn) {
    if (-not $signedIn) { return Set-LauncherProvider $content 'chatgpt_api_mixed' $baseUrl $packageDir $false }
    # Keep native account authentication while selecting native text compaction.
    # The router still sends official models directly to OpenAI and replaces
    # authentication only on requests sent to the external API.
    $table = 'model_providers.chatgpt_api_mixed'
    $body = @(('[' + $table + ']'), 'name = "ChatGPT API compatibility"', ('base_url = ' + (Quote-TomlString $baseUrl)), 'wire_api = "responses"', 'requires_openai_auth = true', 'supports_websockets = true', '') -join [Environment]::NewLine
    $content = Set-TableText $content ($table + '.auth') $null
    return Set-TableText $content $table $body
}
function Read-LauncherState([string]$packageDir) {
    $path = Get-LauncherDataPath $packageDir 'launcher-state.json'
    if (Test-Path -LiteralPath $path) { return ([System.IO.File]::ReadAllText($path) | ConvertFrom-Json) }
    return $null
}
function Restore-LauncherConfig([string]$packageDir, [string]$configPath) {
    $state = Read-LauncherState $packageDir
    if (-not $state -or -not $state.active) { return }
    if ([IO.Path]::GetFullPath($state.configPath) -ne [IO.Path]::GetFullPath($configPath)) { throw '切换记录属于另一个配置目录，已停止自动恢复。' }
    $current = [System.IO.File]::ReadAllText($configPath)
    if ($state.entryMode -eq 'apionly') {
        $state | Add-Member -NotePropertyName lastApiOnlyModel -NotePropertyValue (Get-RootString $current 'model') -Force
        $state | Add-Member -NotePropertyName lastApiOnlyEffort -NotePropertyValue (Get-RootString $current 'model_reasoning_effort') -Force
    } elseif ($state.entryMode -ne 'official') {
        $state.lastApiModel = Get-RootString $current 'model'
        $state.lastApiEffort = Get-RootString $current 'model_reasoning_effort'
    }
    if ($current -ceq $state.applied) { $restored = [string]$state.original } else {
        $restored = $current
        foreach ($key in $script:LauncherRootKeys) { $restored = Set-RootLine $restored $key (Get-RootLine $state.original $key) }
        foreach ($table in $script:LauncherTables) { $restored = Set-TableText $restored $table (Get-TableText $state.original $table) }
        $restored = $restored.TrimEnd() + [regex]::Match($state.original, '[\r\n\t ]*\z').Value
    }
    Write-Utf8File $configPath $restored
    $state.active = $false
    $state.original = $null; $state.applied = $null
    Write-Utf8File (Get-LauncherDataPath $packageDir 'launcher-state.json') ($state | ConvertTo-Json -Depth 8)
}
function Apply-LauncherConfig([string]$packageDir, [string]$configPath, [string]$mode, [string]$shimBase, [string]$gatewayBase, [ValidateSet('api','official','apionly')][string]$entryMode = 'api') {
    if ($entryMode -eq 'apionly') { $mode = 'gateway' }
    $original = if (Test-Path -LiteralPath $configPath) { [IO.File]::ReadAllText($configPath) } else { '' }
    # Retain stable provider IDs for old conversations. Their auth helper lazily
    # starts the local adapter; they must never bypass it by dialing Bifrost.
    $original = Set-LauncherProvider $original 'chatgpt_api_launcher' $shimBase $packageDir $false
    $original = Set-LauncherMixedProvider $original $shimBase $packageDir ($mode -eq 'mixed')
    if(Get-TableText $original 'model_providers.smr'){$original=Set-LauncherProvider $original 'smr' $shimBase $packageDir $false}
    Write-Utf8File $configPath $original
    $previous = Read-LauncherState $packageDir
    $content = Set-RootString $original 'openai_base_url' $shimBase
    if ($entryMode -eq 'official') { $content = Set-RootLine $content 'model_catalog_json' $null }
    else { $content = Set-RootString $content 'model_catalog_json' (Get-LauncherDataPath $packageDir 'models-smr.json') }
    foreach ($id in @('chatgpt_api_launcher','smr')) {
        if (Get-TableText $content ('model_providers.' + $id)) { $content = Set-LauncherProvider $content $id $shimBase $packageDir ($mode -eq 'mixed') }
    }
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
    $routingCatalog = [IO.File]::ReadAllText((Get-LauncherDataPath $packageDir 'catalog-state.json')) | ConvertFrom-Json
    $officialIds = @($routingCatalog.official | ForEach-Object { [string]$_.slug })
    # Select the provider for the initial model, never downgrade all official
    # conversations to a custom provider merely because the API entry is used.
    $provider = if ($entryMode -eq 'official' -or ($mode -eq 'mixed' -and $officialIds -ccontains $selected)) { 'openai' } elseif ($mode -eq 'mixed') { 'chatgpt_api_mixed' } else { 'chatgpt_api_launcher' }
    $content = Set-RootString $content 'model_provider' $provider
    $state = [ordered]@{ version = 2; active = $true; mode = $mode; entryMode = $entryMode; configPath = $configPath; original = $original; applied = $content; startedAt = [DateTime]::UtcNow.ToString('o'); lastApiModel = $(if ($entryMode -eq 'api') { $selected } else { $previous.lastApiModel }); lastApiEffort = $(if ($entryMode -eq 'api') { Get-RootString $original 'model_reasoning_effort' } else { $previous.lastApiEffort }); lastApiOnlyModel = $(if ($entryMode -eq 'apionly') { $selected } else { $previous.lastApiOnlyModel }); lastApiOnlyEffort = $(if ($entryMode -eq 'apionly') { Get-RootString $original 'model_reasoning_effort' } else { $previous.lastApiOnlyEffort }) }
    # Journal first, so a crash while switching can be recovered by either entry.
    Write-Utf8File (Get-LauncherDataPath $packageDir 'launcher-state.json') ($state | ConvertTo-Json -Depth 8)
    Write-Utf8File $configPath $content
}
