# All mutable launcher files live under data. Native client data stays in CODEX_HOME.
function Get-LauncherDataPath([string]$packageDir, [string]$name) {
    $relative = switch ($name) {
        '.env' { 'data\.env' }
        'models-smr.json' { 'data\cache\models-smr.json' }
        'models-gateway.json' { 'data\cache\models-gateway.json' }
        'catalog-state.json' { 'data\cache\catalog-state.json' }
        'reasoning-levels.json' { 'data\cache\reasoning-levels.json' }
        'config-before-launchers.toml' { 'data\backup\config-before-launchers.toml' }
        default { 'data\state\' + $name }
    }
    # A pre-layout watcher still owns its journal until the old app exits.
    $old = Join-Path $packageDir $name
    if (Test-Path -LiteralPath $old -PathType Leaf) { return $old }
    return (Join-Path $packageDir $relative)
}

function Test-RecordedProcess($entry) {
    if (-not $entry -or -not $entry.pid) { return $false }
    $p = Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$entry.pid) -ErrorAction SilentlyContinue
    return [bool]($p -and $p.ExecutablePath -eq $entry.exe -and
        $p.CreationDate.ToUniversalTime().ToString('o') -eq $entry.createdAt)
}

function Get-LegacyLayoutState([string]$packageDir) {
    $file = Join-Path $packageDir 'data\state\layout-migration.json'
    if (Test-Path -LiteralPath $file) { return ([IO.File]::ReadAllText($file) | ConvertFrom-Json) }
    return $null
}

function Test-LegacyRouter([string]$packageDir, $health) {
    $state = Get-LegacyLayoutState $packageDir
    return [bool]($state -and $state.pending -and $health.buildId -eq $state.routerBuildId -and
        (Test-RecordedProcess $state.router))
}

function Initialize-PackageLayout([string]$packageDir) {
    $resolvedRoot = [IO.Path]::GetFullPath($packageDir).TrimEnd('\')
    foreach ($dir in @('data','data\cache','data\state','data\logs','data\backup','data\diagnostics','runtime','assets')) {
        [void][IO.Directory]::CreateDirectory((Join-Path $resolvedRoot $dir))
    }
    $state = Get-LegacyLayoutState $resolvedRoot
    if (-not $state -and (Test-Path -LiteralPath (Join-Path $resolvedRoot 'shim\shim.mjs'))) {
        # A downloaded source update may be overlaid on an older installation.
        # Capture its live process identities before moving any of its journals.
        $watcher = Get-CimInstance Win32_Process -Filter "name='powershell.exe'" | Where-Object {
            $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.Contains((Join-Path $resolvedRoot 'Launch-ChatGPT.ps1'))
        } | Select-Object -First 1
        $router = Get-CimInstance Win32_Process -Filter "name='node.exe'" | Where-Object {
            $_.CommandLine -and $_.CommandLine.Contains((Join-Path $resolvedRoot 'shim\shim.mjs'))
        } | Select-Object -First 1
        $identity = { param($p) if ($p) { @{pid=$p.ProcessId;exe=$p.ExecutablePath;createdAt=$p.CreationDate.ToUniversalTime().ToString('o')} } else { $null } }
        $bytes = New-Object 'System.Collections.Generic.List[byte]'
        foreach ($name in @('shim.mjs','history-compat.mjs','non-gpt-compat.mjs','sse.mjs')) {
            $file = Join-Path $resolvedRoot ('shim\' + $name)
            if (Test-Path -LiteralPath $file) { $bytes.AddRange([IO.File]::ReadAllBytes($file)) }
        }
        $sha = [Security.Cryptography.SHA256]::Create()
        try { $oldBuild = ([BitConverter]::ToString($sha.ComputeHash($bytes.ToArray()))).Replace('-','').ToLowerInvariant() } finally { $sha.Dispose() }
        $state = [pscustomobject]@{version=1;pending=$true;watcher=(& $identity $watcher);router=(& $identity $router);routerBuildId=$oldBuild}
        Write-Utf8File (Join-Path $resolvedRoot 'data\state\layout-migration.json') ($state | ConvertTo-Json -Depth 5)
    }
    if ($state -and $state.pending) {
        foreach ($entry in @($state.watcher, $state.router)) {
            if (Test-RecordedProcess $entry) { return $false }
        }
    }
    $lock = $null
    try {
        $lock = [IO.File]::Open((Join-Path $resolvedRoot 'data\state\migration.lock'),'OpenOrCreate','ReadWrite','None')
        $mapping = @{
            '.env'='data\.env'; 'launcher-state.json'='data\state\launcher-state.json'
            'runtime-state.json'='data\state\runtime-state.json'; 'route-state.json'='data\state\route-state.json'
            'official-settings.json'='data\state\official-settings.json'; 'restart-state.json'='data\state\restart-state.json'
            'models-smr.json'='data\cache\models-smr.json'; 'models-gateway.json'='data\cache\models-gateway.json'
            'catalog-state.json'='data\cache\catalog-state.json'; 'reasoning-levels.json'='data\cache\reasoning-levels.json'
            'config-before-launchers.toml'='data\backup\config-before-launchers.toml'
            'model-template.json'='assets\model-template.json'
        }
        foreach ($name in $mapping.Keys) {
            $source = Join-Path $resolvedRoot $name
            $target = [IO.Path]::GetFullPath((Join-Path $resolvedRoot $mapping[$name]))
            if (-not $target.StartsWith($resolvedRoot + '\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid migration target.' }
            if (Test-Path -LiteralPath $source -PathType Leaf) { Move-Item -LiteralPath $source -Destination $target -Force }
        }
        foreach ($name in @('launcher.lock','router-start.lock')) {
            $old = Join-Path $resolvedRoot $name
            if (Test-Path -LiteralPath $old -PathType Leaf) { Remove-Item -LiteralPath $old -Force }
        }
        foreach ($name in @('ChatGPT-Common.ps1','Launcher-State.ps1','Router-Control.ps1','Install-ChatGPT.ps1','Restart-ChatGPT-Api.ps1','ChatGPT.ico','README.txt','本地兼容层迁移.md','跨模型历史修复.md','修复与验证.md')) {
            $old = Join-Path $resolvedRoot $name
            if (Test-Path -LiteralPath $old -PathType Leaf) { Remove-Item -LiteralPath $old -Force }
        }
        # Remove only the recorded, superseded source tree after its process exits.
        if ($state -and $state.pending) {
            $legacy = [IO.Path]::GetFullPath((Join-Path $resolvedRoot 'shim'))
            if ($legacy -ne ($resolvedRoot + '\shim')) { throw 'Invalid legacy path.' }
            if (Test-Path -LiteralPath $legacy) {
                $links = @(Get-ChildItem -LiteralPath $legacy -Force -Recurse | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint })
                if ($links.Count -or ((Get-Item -LiteralPath $legacy).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Legacy shim contains a link; automatic cleanup stopped.' }
                $logs = Join-Path $legacy 'logs'
                if (Test-Path -LiteralPath $logs) {
                    Get-ChildItem -LiteralPath $logs -File | ForEach-Object { Move-Item -LiteralPath $_.FullName -Destination (Join-Path $resolvedRoot 'data\logs') -Force }
                }
                Remove-Item -LiteralPath $legacy -Recurse -Force
            }
            $state.pending = $false
            $state | Add-Member -NotePropertyName completedAt -NotePropertyValue ([DateTime]::UtcNow.ToString('o')) -Force
            Write-Utf8File (Join-Path $resolvedRoot 'data\state\layout-migration.json') ($state | ConvertTo-Json -Depth 5)
        }
        return $true
    } finally { if ($lock) { $lock.Dispose() } }
}
