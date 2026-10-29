param([string]$Archive)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$package = [IO.File]::ReadAllText((Join-Path $root 'package.json')) | ConvertFrom-Json
$releaseName = 'ChatGPT-API-Launcher-' + $package.version + '-win-x64'
if (-not $Archive) { $Archive = Join-Path $root ('release\' + $package.version + '\' + $releaseName + '.zip') }
if (-not (Test-Path -LiteralPath $Archive)) { throw 'Build a release first, or pass -Archive with an existing ZIP.' }
function Assert($condition, [string]$message) { if (-not $condition) { throw $message } }
function Assert-Fails([scriptblock]$action, [string]$message) {
    $failed = $false
    try { & $action | Out-Null } catch { $failed = $true }
    Assert $failed $message
}
# Read the actual Shell Link StringData. WScript's COM getter can convert a
# correctly stored Unicode argument through the runner's ANSI code page.
function Get-ShortcutStoredArguments([string]$file) {
    $stream = [IO.File]::OpenRead($file)
    $reader = New-Object IO.BinaryReader($stream)
    try {
        if ($stream.Length -lt 76 -or $reader.ReadUInt32() -ne 76) { throw 'Invalid Shell Link header.' }
        $stream.Position = 20
        $flags = $reader.ReadUInt32()
        $stream.Position = 76
        if ($flags -band 1) { $size = $reader.ReadUInt16(); $stream.Position += $size }
        if ($flags -band 2) { $start = $stream.Position; $size = $reader.ReadUInt32(); $stream.Position = $start + $size }
        $encoding = if ($flags -band 128) { [Text.Encoding]::Unicode } else { [Text.Encoding]::Default }
        foreach ($field in @(4,8,16,32)) {
            if (-not ($flags -band $field)) { continue }
            $count = [int]$reader.ReadUInt16()
            $length = if ($flags -band 128) { $count * 2 } else { $count }
            if ($stream.Position + $length -gt $stream.Length) { throw 'Truncated Shell Link StringData.' }
            $value = $encoding.GetString($reader.ReadBytes($length))
            if ($field -eq 32) { return $value }
        }
        return ''
    } finally { $reader.Dispose(); $stream.Dispose() }
}
function Get-NativeConfigHashes {
    $homePath = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
    $values = @{}
    foreach ($name in @('config.toml','auth.json')) {
        $file = Join-Path $homePath $name
        $values[$name] = if (Test-Path -LiteralPath $file) { (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash } else { $null }
    }
    return ($values | ConvertTo-Json -Compress)
}
$before = Get-NativeConfigHashes
$fixtureParent = Join-Path $root 'data\testing'
$fixture = Join-Path $fixtureParent ('release-' + [Guid]::NewGuid().ToString('N'))
$extracted = Join-Path $fixture '解压 [测试]'
$destination = Join-Path $fixture '独立 安装 [目标]'
$passed = $false
try {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::ExtractToDirectory([IO.Path]::GetFullPath($Archive), $extracted)
    $release = Join-Path $extracted $releaseName
    Assert (Test-Path -LiteralPath (Join-Path $release '安装.cmd')) 'Missing release entry point.'
    foreach ($file in Get-ChildItem -LiteralPath $release -Recurse -File -Filter *.ps1) {
        $tokens = $null; $errors = $null
        $null = [Management.Automation.Language.Parser]::ParseFile($file.FullName, [ref]$tokens, [ref]$errors)
        Assert ($errors.Count -eq 0) ('Invalid Windows PowerShell script: ' + $file.FullName)
    }
    $contents = @(Get-ChildItem -LiteralPath $release -Recurse -Force -File)
    foreach ($file in $contents) {
        $relative = $file.FullName.Substring($release.Length + 1).Replace('\','/')
        Assert ($relative -notmatch '(^|/)(?:data|tests|diagnostics|\.git|\.github|\.env|\.npmrc)(/|$)') ('Private/development file in release: ' + $relative)
    }
    . (Join-Path $release 'setup\Release-Core.ps1')
    # This test installs only into its isolated fixture while the desktop stays open.
    $script:testBusy = $false
    function Get-ReleaseBlockingProcesses([string]$destination) {
        if ($script:testBusy) { return @([pscustomobject]@{Name='fixture-running-process'}) }
        return @()
    }
    $installed = Copy-ReleasePayload $release $destination
    Assert ($installed -eq $destination) 'Installer used the extraction directory as its destination.'
    . (Join-Path $installed 'src\Common.ps1')
    . (Join-Path $installed 'src\Package-Paths.ps1')
    . (Join-Path $installed 'src\Launcher-State.ps1')
    . (Join-Path $installed 'install\Install-Core.ps1')
    . (Join-Path $installed 'install\Bootstrap-Runtime.ps1')
    function Get-LauncherDownload([string]$url, [string]$destination) { throw 'The offline release tried to download a dependency.' }
    $null = Initialize-PackageLayout $installed
    Ensure-LauncherRuntime $installed
    Set-LauncherSettings $installed 'https://example.invalid' 'release-test-inert-key'
    $envFile = Join-Path $installed 'data\.env'
    $originalSettings = [IO.File]::ReadAllText($envFile) + "CUSTOM_KEEP=preserved`r`n"
    [IO.File]::WriteAllText($envFile, $originalSettings)
    [IO.File]::WriteAllText((Join-Path $installed 'my-notes.txt'), 'keep this user file')
    $fakeDesktop = Join-Path $fixture 'desktop'
    Set-DesktopEntries $installed $fakeDesktop
    $shell = New-Object -ComObject WScript.Shell
    foreach ($entry in @('ChatGPT','chatgpt-api','chatgpt-apionly')) {
        $shortcutFile = Join-Path $fakeDesktop ($entry + '.lnk')
        $storedArguments = Get-ShortcutStoredArguments $shortcutFile
        $expectedEntry = Join-Path $installed ($entry + '.vbs')
        Assert ($storedArguments.IndexOf($expectedEntry, [StringComparison]::OrdinalIgnoreCase) -ge 0) ('Shortcut does not target the installed entry. Expected: ' + $expectedEntry + '; stored arguments: ' + $storedArguments)
    }
    $null = Copy-ReleasePayload $release $destination
    Assert ([IO.File]::ReadAllText($envFile) -ceq $originalSettings) 'Update changed existing settings.'
    Assert (Test-Path -LiteralPath (Join-Path $installed 'my-notes.txt')) 'Update deleted a user file.'
    $script:testBusy = $true
    Assert-Fails { Copy-ReleasePayload $release $destination } 'Update did not reject an active installation.'
    $script:testBusy = $false
    Assert-Fails { Copy-ReleasePayload $release $release } 'Installer accepted the extracted release as its destination.'
    Assert-Fails { Get-ReleaseRelativeFile $destination '../outside.txt' } 'Path traversal was accepted.'
    Assert-Fails { Get-ReleaseRelativeFile $destination 'data/.env' } 'Payload may overwrite private settings.'
    $source = Join-Path $release 'payload\Read-ApiKey.ps1'
    $sourceBytes = [IO.File]::ReadAllBytes($source)
    $installedHash = (Get-FileHash -LiteralPath (Join-Path $installed 'Read-ApiKey.ps1')).Hash
    [IO.File]::AppendAllText($source, '# broken payload')
    Assert-Fails { Copy-ReleasePayload $release $destination } 'Corrupted payload was accepted.'
    Assert ((Get-FileHash -LiteralPath (Join-Path $installed 'Read-ApiKey.ps1')).Hash -eq $installedHash) 'Failed verification changed installed files.'
    [IO.File]::WriteAllBytes($source, $sourceBytes)
    $node = Join-Path $installed 'runtime\node.exe'
    foreach ($script in Get-ChildItem -LiteralPath (Join-Path $installed 'src') -Filter *.mjs -File) {
        & $node --check $script.FullName
        Assert ($LASTEXITCODE -eq 0) ('Packaged module failed syntax check: ' + $script.Name)
    }
    $smoke = Join-Path $installed 'release-smoke.mjs'
    [IO.File]::WriteAllText($smoke, "import 'ws'; import 'undici'; import 'https-proxy-agent'; console.log('Bundled dependencies load successfully.');")
    & $node $smoke
    Assert ($LASTEXITCODE -eq 0) 'Bundled dependencies did not load from the independent installation.'
    Assert ((Get-NativeConfigHashes) -ceq $before) 'Release test changed native account/configuration files.'
    $report = [ordered]@{passed=$true;archive=[IO.Path]::GetFullPath($Archive);version=$package.version;checks=@(
        'clean archive allowlist','PowerShell 5.1 package syntax','independent install with Chinese/spaces/brackets in path',
        'offline runtime and dependency setup','shortcuts target installed directory','update preserves settings and user files',
        'active-process update guard','path traversal and private-file protection','corrupt payload rejected before writes',
        'packaged JavaScript and dependency imports','native config and auth unchanged'
    )}
    [void][IO.Directory]::CreateDirectory((Join-Path $root 'data\diagnostics'))
    [IO.File]::WriteAllText((Join-Path $root 'data\diagnostics\release-package-result.json'), ($report | ConvertTo-Json -Depth 5))
    $report | ConvertTo-Json -Depth 5
    $passed = $true
} finally {
    $resolved = [IO.Path]::GetFullPath($fixture)
    if ($passed -and $resolved.StartsWith(([IO.Path]::GetFullPath($fixtureParent).TrimEnd('\') + '\'), [StringComparison]::OrdinalIgnoreCase)) {
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}
