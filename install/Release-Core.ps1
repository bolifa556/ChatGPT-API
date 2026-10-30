function Get-ReleaseBlockingProcesses([string]$destination) {
    $prefix = [IO.Path]::GetFullPath($destination).TrimEnd('\') + '\'
    return @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {
        ($_.Name -eq 'ChatGPT.exe' -and $_.CommandLine -notmatch '--type=') -or
        ($_.ProcessId -ne $PID -and $_.Name -in @('node.exe','powershell.exe','pwsh.exe') -and
            $_.CommandLine -and $_.CommandLine.IndexOf($prefix, [StringComparison]::OrdinalIgnoreCase) -ge 0)
    })
}

function Assert-ReleasePathHasNoLinks([string]$path) {
    $current = [IO.Path]::GetFullPath($path)
    while ($current) {
        if (Test-Path -LiteralPath $current) {
            if ((Get-Item -LiteralPath $current -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw ('安装路径不能包含符号链接或目录联接：' + $current)
            }
        }
        $current = [IO.Path]::GetDirectoryName($current)
    }
}

function Get-ReleaseRelativeFile([string]$root, [string]$relative) {
    if (-not $relative -or $relative -match '[\\:]' -or $relative.StartsWith('/') -or
        @($relative.Split('/') | Where-Object { $_ -in @('', '.', '..') }).Count) {
        throw ('发布包包含无效的相对路径：' + $relative)
    }
    if ($relative -notmatch '^(?:ChatGPT\.vbs|chatgpt-api(?:only)?\.vbs|Launch-ChatGPT\.ps1|Read-ApiKey\.ps1|安装\.cmd|控制台\.vbs|package(?:-lock)?\.json|(?:src|install|assets|runtime|node_modules)/.+)$' -or
        $relative -match '(^|/)(?:\.env(?:\..*)?|\.npmrc|\.git|data|\.cache)(/|$)') {
        throw ('发布包包含非程序文件：' + $relative)
    }
    $prefix = [IO.Path]::GetFullPath($root).TrimEnd('\') + '\'
    $file = [IO.Path]::GetFullPath((Join-Path $root $relative))
    if (-not $file.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw '安装文件超出目标目录。' }
    Assert-ReleasePathHasNoLinks $file
    return $file
}

function Copy-ReleasePayload([string]$releaseRoot, [string]$destination) {
    $releaseRoot = [IO.Path]::GetFullPath($releaseRoot).TrimEnd('\')
    if (-not [IO.Path]::IsPathRooted($destination)) { throw '请选择完整的安装目录路径。' }
    $destination = [IO.Path]::GetFullPath($destination).TrimEnd('\')
    if ($destination -eq [IO.Path]::GetPathRoot($destination).TrimEnd('\') -or
        $destination -eq $releaseRoot -or
        $destination.StartsWith($releaseRoot + '\', [StringComparison]::OrdinalIgnoreCase) -or
        $releaseRoot.StartsWith($destination + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw '请选择独立的程序目录，不能安装到磁盘根目录或发布包所在目录。'
    }
    Assert-ReleasePathHasNoLinks $destination
    $manifest = [IO.File]::ReadAllText((Join-Path $releaseRoot 'release.json')) | ConvertFrom-Json
    if ($manifest.schemaVersion -ne 1 -or $manifest.product -ne 'chatgpt-api-launcher' -or -not $manifest.files.Count) {
        throw '发布包清单无效，请重新解压完整安装包。'
    }
    $payload = Join-Path $releaseRoot 'payload'
    $seen = @{}
    $copies = @()
    foreach ($entry in $manifest.files) {
        $relative = [string]$entry.path
        if ($seen.ContainsKey($relative)) { throw ('发布包中存在重复文件：' + $relative) }
        $seen[$relative] = $true
        $source = Get-ReleaseRelativeFile $payload $relative
        $target = Get-ReleaseRelativeFile $destination $relative
        if (-not (Test-Path -LiteralPath $source -PathType Leaf) -or
            (Get-Item -LiteralPath $source).Length -ne $entry.bytes -or
            (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash -ine $entry.sha256) {
            throw ('发布包文件校验失败：' + $relative + '。请重新解压安装包。')
        }
        $copies += [pscustomobject]@{source=$source;target=$target}
    }
    foreach ($required in @('Launch-ChatGPT.ps1','ChatGPT.vbs','chatgpt-api.vbs','chatgpt-apionly.vbs','Read-ApiKey.ps1','控制台.vbs','src/settings.mjs','src/gateway-sources.mjs','src/console.mjs','assets/console/index.html','install/Install-ChatGPT.ps1','src/shim.mjs','src/transport.mjs','src/response-state.mjs','src/model-context.mjs','src/gateway-recovery.mjs','src/Api-Settings.ps1','assets/model-contexts.json','runtime/node.exe','package-lock.json')) {
        if (-not $seen.ContainsKey($required)) { throw ('发布包缺少文件：' + $required) }
    }
    if (-not $seen.ContainsKey('install/Installer-UI.ps1')) { throw '发布包缺少安装界面组件。' }
    # Validate every source and destination before overwriting any installed file.
    if (@(Get-ReleaseBlockingProcesses $destination).Count) {
        throw '请先从托盘完全退出 ChatGPT，并等待该目录的启动器退出，再安装或更新。'
    }
    foreach ($copy in $copies) {
        [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($copy.target))
        Copy-Item -LiteralPath $copy.source -Destination $copy.target -Force
    }
    # Only listed program files are overlaid. Existing data and other files stay put.
    return $destination
}

function Get-ExistingLauncherDirectory {
    $desktop = [Environment]::GetFolderPath('DesktopDirectory')
    if ($desktop) {
        $shell = New-Object -ComObject WScript.Shell
        foreach ($name in @('chatgpt-api','chatgpt-apionly','ChatGPT')) {
            $path = Join-Path $desktop ($name + '.lnk')
            if (-not (Test-Path -LiteralPath $path)) { continue }
            $shortcut = $shell.CreateShortcut($path)
            $candidate = [string]$shortcut.WorkingDirectory
            if ($candidate -and (Test-Path -LiteralPath (Join-Path $candidate 'Launch-ChatGPT.ps1')) -and
                $shortcut.Arguments.Contains((Join-Path $candidate ($name + '.vbs')))) { return $candidate }
        }
    }
    return (Join-Path $env:LOCALAPPDATA 'Programs\ChatGPT-API-Launcher')
}
