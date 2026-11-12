$script:LauncherRootKeys = @('openai_base_url', 'model_provider', 'model_catalog_json', 'model', 'model_reasoning_effort', 'model_context_window', 'model_auto_compact_token_limit')
$script:LauncherTables = @('model_providers.chatgpt_api_launcher', 'model_providers.chatgpt_api_launcher.auth', 'model_providers.chatgpt_api_mixed', 'model_providers.chatgpt_api_mixed.auth', 'model_providers.smr', 'model_providers.smr.auth')
$script:LauncherRootKeys += @('cli_auth_credentials_store', 'forced_login_method')
$script:NativeVersionCachePath = Join-Path (Split-Path -Parent $PSScriptRoot) 'data\cache\native-client-version.json'
function Write-LauncherFile([string]$path, [string]$content) {
    $directory = Split-Path -Parent $path
    [void][IO.Directory]::CreateDirectory($directory)
    $temporary = $path + '.chatgpt-api.tmp'
    $backup = $path + '.chatgpt-api.bak'
    try {
        $stream = [IO.File]::Open($temporary,'Create','Write','None')
        try { $bytes = (New-Object Text.UTF8Encoding($false)).GetBytes($content); $stream.Write($bytes,0,$bytes.Length); $stream.Flush($true) }
        finally { $stream.Dispose() }
        if (Test-Path -LiteralPath $path) { [IO.File]::Replace($temporary,$path,[NullString]::Value) }
        else { [IO.File]::Move($temporary,$path) }
    } finally {
        foreach ($scratch in @($temporary,$backup)) { if (Test-Path -LiteralPath $scratch) { Remove-Item -LiteralPath $scratch } }
    }
}
function Get-CodexHome {
    if ($env:CODEX_HOME) { return $env:CODEX_HOME }
    return (Join-Path $env:USERPROFILE '.codex')
}
function Get-LauncherTomlMask([string]$content) {
    $mask = $content.ToCharArray()
    $quote = ''; $triple = $false; $isValue = $false; $depth = 0; $comment = $false
    for ($at = 0; $at -lt $content.Length; $at++) {
        $character = $content[$at]
        if ($comment) {
            if ($character -ne "`r" -and $character -ne "`n") { $mask[$at] = ' ' }
            if ($character -eq "`n") { $comment = $false; if (-not $depth) { $isValue = $false } }
            continue
        }
        if ($quote) {
            if ($isValue -and $character -ne "`r" -and $character -ne "`n") { $mask[$at] = ' ' }
            if ($quote -eq '"' -and $character -eq '\') {
                if ($at + 1 -lt $content.Length) { $at++; if ($isValue -and $content[$at] -ne "`r" -and $content[$at] -ne "`n") { $mask[$at] = ' ' } }
                continue
            }
            if ($character -eq $quote) {
                if (-not $triple) { $quote = '' }
                elseif ($at + 3 -le $content.Length -and $content.Substring($at,3) -eq (([string]$quote) * 3)) {
                    $end = $at + 3
                    while ($end -lt $at + 5 -and $end -lt $content.Length -and $content[$end] -eq $quote) { $end++ }
                    if ($isValue) { for ($i = $at + 1; $i -lt $end; $i++) { $mask[$i] = ' ' } }
                    $at = $end - 1; $quote = ''; $triple = $false
                }
            }
            continue
        }
        if ($character -eq "`n") { if (-not $depth) { $isValue = $false }; continue }
        if ($character -eq '#') { $comment = $true; $mask[$at] = ' '; continue }
        if ($character -eq '"' -or $character -eq [char]39) {
            $quote = $character
            $triple = $at + 3 -le $content.Length -and $content.Substring($at,3) -eq (([string]$character) * 3)
            $count = if ($triple) { 3 } else { 1 }
            if ($isValue) { for ($i = $at; $i -lt $at + $count; $i++) { $mask[$i] = ' ' } }
            $at += $count - 1; continue
        }
        if ($isValue) {
            if ($character -eq '[' -or $character -eq '{') { $depth++ }
            elseif ($character -eq ']' -or $character -eq '}') { $depth-- }
            $mask[$at] = ' '
        } elseif ($character -eq '=') { $isValue = $true }
    }
    return -join $mask
}
function Get-LauncherRootPattern([string]$key) {
    $escaped = [regex]::Escape($key)
    return '(?m)^[ \t]*(?:' + $escaped + '|"' + $escaped + '"|' + [char]39 + $escaped + [char]39 + ')[ \t]*=[^\r\n]*(?:\r?\n|$)'
}
function Get-RootHead([string]$content) {
    $table = [regex]::Match((Get-LauncherTomlMask $content), '(?m)^[ \t]*\[')
    if ($table.Success) { return $content.Substring(0, $table.Index) }
    return $content
}
function Get-RootLine([string]$content, [string]$key) {
    $pattern = Get-LauncherRootPattern $key
    $match = [regex]::Match((Get-LauncherTomlMask (Get-RootHead $content)), $pattern)
    if ($match.Success) { return $content.Substring($match.Index,$match.Length) }
    return $null
}
function Get-RootString([string]$content, [string]$key) {
    $line = Get-RootLine $content $key
    if (-not $line) { return '' }
    $value = ($line -split '=', 2)[1].Trim()
    $literal = [regex]::Match($value, '^("(?:[^"\\]|\\.)*"|''[^'']*'')')
    if ($literal.Success) {
        if ($literal.Value.StartsWith('"')) { try { return [string]($literal.Value | ConvertFrom-Json) } catch {} }
        else { return $literal.Value.Substring(1,$literal.Value.Length-2) }
    }
    return $value.Trim([char]39, [char]34)
}
function Set-RootLine([string]$content, [string]$key, $line) {
    $match = [regex]::Match((Get-LauncherTomlMask (Get-RootHead $content)), (Get-LauncherRootPattern $key))
    if ($match.Success) { return $content.Substring(0,$match.Index) + [string]$line + $content.Substring($match.Index+$match.Length) }
    return [string]$line + $content
}
function Set-RootString([string]$content, [string]$key, [string]$value) {
    return Set-RootLine $content $key ($key + ' = ' + (Quote-TomlString $value) + [Environment]::NewLine)
}
function Get-TablePattern([string]$name) {
    return '(?ms)^[ \t]*\[' + [regex]::Escape($name) + '\][^\r\n]*(?:\r?\n|$).*?(?=^[ \t]*\[|\z)'
}
function Get-TableText([string]$content, [string]$name) {
    $match = [regex]::Match((Get-LauncherTomlMask $content), (Get-TablePattern $name))
    if ($match.Success) { return $content.Substring($match.Index,$match.Length) }
    return $null
}
function Set-TableText([string]$content, [string]$name, $text) {
    $match = [regex]::Match((Get-LauncherTomlMask $content), (Get-TablePattern $name))
    if ($match.Success) { return $content.Substring(0,$match.Index) + [string]$text + $content.Substring($match.Index+$match.Length) }
    if ($null -ne $text) { return $content.TrimEnd() + [Environment]::NewLine + [Environment]::NewLine + [string]$text }
    return $content
}
function Get-SavedChatGPTLogin([string]$homePath) {
    $authPath = Join-Path $homePath 'auth.json'
    if (-not (Test-Path -LiteralPath $authPath)) { return $false }
    try {
        $auth = (Read-LauncherText $authPath) | ConvertFrom-Json
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
    $body = @(('[' + $table + ']'), ('# chatgpt-api-root = ' + (Quote-TomlString $packageDir)), 'name = "Custom API"', ('base_url = ' + (Quote-TomlString $baseUrl)), 'wire_api = "responses"', 'requires_openai_auth = false', 'experimental_bearer_token = "chatgpt-api-local"', 'http_headers = { "x-openai-actor-authorization" = "chatgpt-api-local" }', ('supports_websockets = ' + $websocket.ToString().ToLowerInvariant()), '') -join $nl
    $existingBody = Get-TableText $content $table
    if (-not $existingBody -or $existingBody.TrimEnd() -cne $body.TrimEnd()) {
        $content = Set-TableText $content $table $body
    }
    # The native client authenticates only to the loopback bridge. The router
    # owns upstream keys; no credential subprocess or router probe is needed.
    return Set-TableText $content ($table + '.auth') $null
}
function Get-NativeDesktopApp {
    $package = Get-AppxPackage -Name OpenAI.Codex | Sort-Object Version -Descending | Select-Object -First 1
    if (-not $package) { throw '未找到已安装的 ChatGPT/Codex 桌面应用。' }
    $manifest = Get-AppxPackageManifest -Package $package
    $applications = @($manifest.SelectNodes("/*[local-name()='Package']/*[local-name()='Applications']/*[local-name()='Application']") | Where-Object {
        $visual = $_.SelectSingleNode("*[local-name()='VisualElements']")
        $visual -and $visual.GetAttribute('AppListEntry') -ne 'none' -and $_.GetAttribute('Executable') -match '\.exe$'
    })
    $app = if ($applications.Count -eq 1) { $applications[0] } else { $applications | Where-Object { $_.GetAttribute('Id') -eq 'App' } | Select-Object -First 1 }
    if (-not $app) { throw 'Windows 安装注册中找不到 ChatGPT/Codex 桌面入口。' }
    $relative = $app.GetAttribute('Executable').Replace('/','\')
    $prefix = [IO.Path]::GetFullPath($package.InstallLocation).TrimEnd('\') + '\'
    $executable = [IO.Path]::GetFullPath((Join-Path $prefix $relative))
    if (-not $executable.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)) { throw 'Windows 安装注册中的 ChatGPT/Codex 路径无效。' }
    $resources = Join-Path (Split-Path -Parent $executable) 'resources'
    $windowsApps = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps'
    $packageAliases = Join-Path $windowsApps $package.PackageFamilyName
    $launch = $executable
    foreach ($extension in $app.SelectNodes("*[local-name()='Extensions']/*[local-name()='Extension' and @Category='windows.appExecutionAlias']")) {
        $target = $extension.GetAttribute('Executable').Replace('/','\')
        if ($target -and $target -ine $relative) { continue }
        foreach ($entry in $extension.SelectNodes("*[local-name()='AppExecutionAlias']/*[local-name()='ExecutionAlias']")) {
            $name = $entry.GetAttribute('Alias')
            if ($name -notmatch '^[^\\/:]+\.exe$') { continue }
            $aliasPath = @((Join-Path $packageAliases $name), (Join-Path $windowsApps $name)) |
                Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
            if ($aliasPath) { $launch = $aliasPath; break }
        }
        if ($launch -ne $executable) { break }
    }
    return [pscustomobject]@{
        appId = $package.PackageFamilyName + '!' + $app.GetAttribute('Id')
        processName = [IO.Path]::GetFileName($executable)
        launch = $launch
        archive = Join-Path $resources 'app.asar'
        cli = Join-Path $resources 'codex.exe'
    }
}
function Get-NativeClientVersion([string]$cliPath = '', [string]$cacheFile = $script:NativeVersionCachePath) {
    $temporaryCli = $null
    try {
        if (-not $cliPath) { $cliPath = (Get-NativeDesktopApp).cli }
        $source = Get-Item -LiteralPath $cliPath -ErrorAction Stop
        # Store packages are immutable and their path changes on update. Read
        # the real CLI version once per installed binary, without scanning or
        # hashing the native client's executable cache on every launch.
        if (Test-Path -LiteralPath $cacheFile) {
            try {
                $saved = (Read-LauncherText $cacheFile) | ConvertFrom-Json
                if ($saved.source -ceq $source.FullName -and $saved.length -eq $source.Length -and
                    $saved.modified -eq $source.LastWriteTimeUtc.Ticks.ToString() -and $saved.version -match '^\d+\.\d+\.\d+$') { return [string]$saved.version }
            } catch {}
        }
        $cache = Split-Path -Parent $cacheFile
        [void][IO.Directory]::CreateDirectory($cache)
        $temporaryCli = Join-Path $cache ('native-version-' + [Guid]::NewGuid().ToString('N') + '.exe')
        [IO.File]::Copy($source.FullName,$temporaryCli,$false)
        $output = (& $temporaryCli --version 2>$null | Out-String).Trim()
        if ($LASTEXITCODE -eq 0 -and $output -match '^codex-cli (\d+\.\d+\.\d+)(?:[-+\s]|$)') {
            $version = $Matches[1]
            Write-LauncherFile $cacheFile (@{source=$source.FullName;length=$source.Length;modified=$source.LastWriteTimeUtc.Ticks.ToString();version=$version}|ConvertTo-Json -Compress)
            return $version
        }
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
    $body = @(('[' + $table + ']'), ('# chatgpt-api-root = ' + (Quote-TomlString $packageDir)), ('name = ' + (Quote-TomlString $name)), ('base_url = ' + (Quote-TomlString $baseUrl)), 'wire_api = "responses"', 'requires_openai_auth = true', 'supports_websockets = true', '') -join [Environment]::NewLine
    $content = Set-TableText $content ($table + '.auth') $null
    return Set-TableText $content $table $body
}
function Read-LauncherState([string]$packageDir) {
    $path = Get-LauncherDataPath $packageDir 'launcher-state.json'
    if (Test-Path -LiteralPath $path) { return ((Read-LauncherText $path) | ConvertFrom-Json) }
    return $null
}
function Restore-LauncherRootLine([string]$content, [string]$key, [string]$line, [string]$original) {
    if (-not $line -or (Get-RootLine $content $key)) { return Set-RootLine $content $key $line }
    $head = Get-RootHead $content
    $oldHead = Get-RootHead $original
    $pattern = Get-LauncherRootPattern $key
    $old = [regex]::Match((Get-LauncherTomlMask $oldHead), $pattern)
    if (-not $old.Success) { return Set-RootLine $content $key $line }
    foreach ($next in [regex]::Matches((Get-LauncherTomlMask $oldHead).Substring($old.Index + $old.Length), '(?m)^[ \t]*["'']?([A-Za-z_][A-Za-z0-9_]*)["'']?[ \t]*=')) {
        $position = [regex]::Match((Get-LauncherTomlMask $head), (Get-LauncherRootPattern $next.Groups[1].Value))
        if ($position.Success) { return $content.Insert($position.Index, $line) }
    }
    return $content.Insert($head.Length, $line)
}
function Restore-LauncherTable([string]$content, [string]$name, [string]$original) {
    $table = Get-TableText $original $name
    if (-not $table -or (Get-TableText $content $name)) { return Set-TableText $content $name $table }
    # Signing in temporarily removes the API-key auth table. Restore it in its
    # original position even when the user changed another setting meanwhile.
    $old = [regex]::Match((Get-LauncherTomlMask $original), (Get-TablePattern $name))
    foreach ($next in [regex]::Matches((Get-LauncherTomlMask $original).Substring($old.Index + $old.Length), '(?m)^[ \t]*(\[[^\r\n]+\])')) {
        $position = [regex]::Match((Get-LauncherTomlMask $content), '(?m)^[ \t]*' + [regex]::Escape($next.Groups[1].Value))
        if ($position.Success) { return $content.Insert($position.Index, $table) }
    }
    return Set-TableText $content $name $table
}
function Restore-LauncherConfig([string]$packageDir, [string]$configPath) {
    $compatibility = Join-Path $packageDir 'data\state\thread-provider-compatibility.json'
    $state = Read-LauncherState $packageDir
    if ($state -and $state.active) {
        if ([IO.Path]::GetFullPath($state.configPath) -ne [IO.Path]::GetFullPath($configPath)) { throw '切换记录属于另一个配置目录，已停止自动恢复。' }
        $current = if (Test-Path -LiteralPath $configPath) { (Read-LauncherText $configPath) } else { '' }
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
    $original = if ($originalExisted) { (Read-LauncherText $configPath) } else { '' }
    $previous = Read-LauncherState $packageDir
    $content = Set-RootString $original 'openai_base_url' $shimBase
    if (-not $signedIn) {
        # The provider's requires_openai_auth=false selects API authentication.
        # Keep the user's credential store so explicit sign-ins remain persistent.
        $content = Set-RootLine $content 'forced_login_method' $null
    }
    if ($entryMode -eq 'official') { $content = Set-RootLine $content 'model_catalog_json' $null }
    else { $content = Set-RootString $content 'model_catalog_json' (Get-LauncherDataPath $packageDir 'models-smr.json') }
    foreach ($id in @('chatgpt_api_mixed','smr')) {
        if (Get-TableText $content ('model_providers.' + $id)) { $content = Set-LauncherMixedProvider $content $shimBase $packageDir $signedIn $id }
    }
    # One runtime binding across entries. Old bindings are temporarily overlaid
    # by the launch helper and restored when the native client exits.
    $provider = 'chatgpt_api_launcher'
    $content = Set-LauncherMixedProvider $content $shimBase $packageDir $signedIn $provider ($entryMode -eq 'official')
    if ($entryMode -eq 'official') {
        $catalog = (Read-LauncherText (Get-LauncherDataPath $packageDir 'catalog-state.json')) | ConvertFrom-Json
        $ids = @($catalog.official | ForEach-Object { [string]$_.slug })
    } else {
        $catalog = (Read-LauncherText (Get-LauncherDataPath $packageDir 'models-smr.json')) | ConvertFrom-Json
        $ids = @($catalog.models | ForEach-Object { [string]$_.slug })
    }
    $selected = Get-RootString $original 'model'
    $savedModel = if ($entryMode -eq 'apionly') { $previous.lastApiOnlyModel } elseif ($entryMode -eq 'api') { $previous.lastApiModel } else { '' }
    $savedEffort = if ($entryMode -eq 'apionly') { $previous.lastApiOnlyEffort } elseif ($entryMode -eq 'api') { $previous.lastApiEffort } else { '' }
    if ($savedModel -and $ids -ccontains $savedModel) {
        $selected = $savedModel
        $content = Set-RootString $content 'model' $selected
        if ($savedEffort) { $content = Set-RootString $content 'model_reasoning_effort' $savedEffort }
    }
    if ($ids.Count -and $ids -cnotcontains $selected) {
        if ($ids -ccontains 'GPT/gpt-6-sol') { $selected = 'GPT/gpt-6-sol' }
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
