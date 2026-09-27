function Get-LockedPackages([string]$packageDir) {
    # PowerShell 5.1 cannot parse package-lock's empty root package name.
    $node = Join-Path $packageDir 'runtime\node.exe'
    if (-not (Test-Path -LiteralPath $node)) { $node = (Get-Command node.exe -ErrorAction Stop).Source }
    $json = & $node -p 'JSON.stringify(Object.entries(require(process.argv[1]).packages).filter(x=>x[0]).map(x=>({Name:x[0],Value:x[1]})))' (Join-Path $packageDir 'package-lock.json')
    if ($LASTEXITCODE -ne 0) { throw 'Cannot read dependency lock file.' }
    return ($json | ConvertFrom-Json)
}

function Get-LauncherDownload([string]$url, [string]$destination) {
    $options = @{Uri=$url;OutFile=$destination;TimeoutSec=60;UseBasicParsing=$true;ErrorAction='Stop'}
    if (Get-Command Get-ExistingOfficialProxy -ErrorAction SilentlyContinue) {
        $proxy = Get-ExistingOfficialProxy
        if ($proxy) { $options.Proxy = $proxy }
    }
    Invoke-WebRequest @options
}

function Test-LauncherDependencies([string]$packageDir) {
    foreach ($entry in @(Get-LockedPackages $packageDir)) {
        if (-not $entry.Name) { continue }
        $manifest = Join-Path $packageDir ($entry.Name + '/package.json')
        if (-not (Test-Path -LiteralPath $manifest)) { return $false }
        try { $installed = [IO.File]::ReadAllText($manifest) | ConvertFrom-Json } catch { return $false }
        if ($installed.version -ne $entry.Value.version) { return $false }
    }
    return $true
}

function Ensure-LauncherRuntime([string]$packageDir) {
    $rootPath = [IO.Path]::GetFullPath($packageDir).TrimEnd('\')
    $node = Join-Path $rootPath 'runtime\node.exe'
    if (-not (Test-Path -LiteralPath $node)) {
        $manifest = [IO.File]::ReadAllText((Join-Path $rootPath 'assets\runtime.json')) | ConvertFrom-Json
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        $part = $node + '.download'
        try {
            Get-LauncherDownload $manifest.url $part
            if ((Get-FileHash -LiteralPath $part -Algorithm SHA256).Hash -ine $manifest.sha256) { throw 'Node 下载校验失败，请重新下载完整安装包。' }
            Move-Item -LiteralPath $part -Destination $node -Force
        } finally { if (Test-Path -LiteralPath $part) { Remove-Item -LiteralPath $part -Force } }
    }
    $version = (& $node --version | Out-String).Trim().TrimStart('v')
    if ($LASTEXITCODE -ne 0 -or [version]$version -lt [version]'22.14.0') { throw '需要 Node.js 22.14 或更高版本。' }
    if (Test-LauncherDependencies $rootPath) { return }
    $packages = @(Get-LockedPackages $rootPath)
    $downloadDir = Join-Path $rootPath 'data\cache\install'
    [void][IO.Directory]::CreateDirectory($downloadDir)
    $tar = (Get-Command tar.exe -ErrorAction Stop).Source
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    foreach ($entry in $packages) {
        if (-not $entry.Name) { continue }
        if ($entry.Name -notmatch '^node_modules/(?:@[a-z0-9._-]+/)?[a-z0-9._-]+$') { throw 'Unsupported dependency path in lock file.' }
        $url = [Uri]$entry.Value.resolved
        if ($url.Scheme -ne 'https' -or $url.Host -ne 'registry.npmjs.org') { throw 'Dependency URL must use the npm registry over HTTPS.' }
        $destination = [IO.Path]::GetFullPath((Join-Path $rootPath $entry.Name))
        if (-not $destination.StartsWith($rootPath + '\node_modules\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Dependency target outside node_modules.' }
        $archive = Join-Path $downloadDir 'dependency.tgz'
        try {
            Get-LauncherDownload $url.AbsoluteUri $archive
            $integrity = [string]$entry.Value.integrity
            if (-not $integrity.StartsWith('sha512-')) { throw 'Missing SHA-512 dependency integrity.' }
            $sha = [Security.Cryptography.SHA512]::Create()
            try { $actual = 'sha512-' + [Convert]::ToBase64String($sha.ComputeHash([IO.File]::ReadAllBytes($archive))) } finally { $sha.Dispose() }
            if ($actual -cne $integrity) { throw ('Dependency checksum mismatch: ' + $entry.Name) }
            [void][IO.Directory]::CreateDirectory($destination)
            & $tar -xzf $archive -C $destination --strip-components=1
            if ($LASTEXITCODE -ne 0) { throw ('Dependency extraction failed: ' + $entry.Name) }
        } finally { if (Test-Path -LiteralPath $archive) { Remove-Item -LiteralPath $archive -Force } }
    }
    if (-not (Test-LauncherDependencies $rootPath)) { throw '运行依赖安装不完整，请重试安装。' }
}
