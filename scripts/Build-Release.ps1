param([string]$OutputDirectory = (Join-Path (Split-Path -Parent $PSScriptRoot) 'release'))
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $root 'install\Bootstrap-Runtime.ps1')
. (Join-Path $root 'install\Release-Core.ps1')
$package = [IO.File]::ReadAllText((Join-Path $root 'package.json')) | ConvertFrom-Json
$runtime = [IO.File]::ReadAllText((Join-Path $root 'assets\runtime.json')) | ConvertFrom-Json
if ($package.version -notmatch '^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$') { throw 'Invalid release version.' }
$node = Join-Path $root 'runtime\node.exe'
if ((Get-FileHash -LiteralPath $node -Algorithm SHA256).Hash -ine $runtime.sha256) { throw 'Bundled Node.js does not match assets/runtime.json.' }
if (-not (Test-LauncherDependencies $root)) { throw 'Prepare the locked runtime dependencies before building a release.' }

$name = 'ChatGPT-API-Launcher-' + $package.version + '-win-x64'
$output = [IO.Path]::GetFullPath($OutputDirectory)
if ($output.TrimEnd('\') -eq (Join-Path $root 'release')) { $output = Join-Path $output $package.version }
[void][IO.Directory]::CreateDirectory($output)
$zip = Join-Path $output ($name + '.zip')
if (Test-Path -LiteralPath $zip) { throw ('Release already exists; choose a new output directory or version: ' + $zip) }
$buildParent = Join-Path $root 'data\build'
$build = Join-Path $buildParent ([Guid]::NewGuid().ToString('N'))
$bundle = Join-Path $build $name
$payload = Join-Path $bundle 'payload'
[void][IO.Directory]::CreateDirectory($payload)

function Copy-ProgramFile([string]$relative) {
    $source = Get-ReleaseRelativeFile $root $relative
    $target = Get-ReleaseRelativeFile $payload $relative
    [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target))
    Copy-Item -LiteralPath $source -Destination $target
}

try {
    # Explicit application allowlist: never copy the repository or data wholesale.
    foreach ($file in @(
        '安装.cmd','控制台.vbs','ChatGPT.vbs','chatgpt-api.vbs','chatgpt-apionly.vbs','Launch-ChatGPT.ps1','Read-ApiKey.ps1',
        'package.json','package-lock.json','runtime/node.exe',
        'assets/ChatGPT.ico','assets/model-template.json','assets/reasoning-levels.json','assets/model-contexts.json','assets/console/index.html','assets/console/console.css','assets/console/console.js','assets/console/icon.svg','assets/runtime.json',
        'install/Install-ChatGPT.ps1','install/Install-Core.ps1','install/Installer-UI.ps1','install/Bootstrap-Runtime.ps1',
        'src/Common.ps1','src/Package-Paths.ps1','src/Launcher-State.ps1','src/Router-Control.ps1','src/Api-Settings.ps1',
        'src/shim.mjs','src/transport.mjs','src/response-state.mjs','src/settings.mjs','src/gateway-sources.mjs','src/console.mjs','src/chat-compat.mjs','src/history-compat.mjs','src/non-gpt-compat.mjs','src/sse.mjs','src/image-compat.mjs',
        'src/repair-thread-providers.mjs','src/model-context.mjs','src/gateway-recovery.mjs'
    )) { Copy-ProgramFile $file }
    foreach ($entry in @(Get-LockedPackages $root)) {
        $directory = Join-Path $root $entry.Name
        Assert-ReleasePathHasNoLinks $directory
        foreach ($item in Get-ChildItem -LiteralPath $directory -Recurse -Force) {
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw ('Linked dependency file: ' + $item.FullName) }
            if (-not $item.PSIsContainer) { Copy-ProgramFile ($item.FullName.Substring($root.Length + 1).Replace('\','/')) }
        }
    }
    $license = Join-Path $root ('data\cache\release-node-' + $runtime.version + '-LICENSE.txt')
    if (-not (Test-Path -LiteralPath $license)) {
        [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($license))
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Get-LauncherDownload ('https://raw.githubusercontent.com/nodejs/node/v' + $runtime.version + '/LICENSE') $license
    }
    $licenseText = [IO.File]::ReadAllText($license)
    if (-not $licenseText.Contains('Node.js') -or -not $licenseText.Contains('Permission is hereby granted')) { throw 'Invalid Node.js license text.' }
    Copy-Item -LiteralPath $license -Destination (Join-Path $payload 'runtime\LICENSE.txt')
    [void][IO.Directory]::CreateDirectory((Join-Path $bundle 'setup'))
    foreach ($file in @('Install-Release.ps1','Release-Core.ps1','Installer-UI.ps1')) {
        Copy-Item -LiteralPath (Join-Path $root ('install\' + $file)) -Destination (Join-Path $bundle ('setup\' + $file))
    }
    Copy-Item -LiteralPath (Join-Path $root 'install\Release-Install.cmd') -Destination (Join-Path $bundle '安装.cmd')
    Copy-Item -LiteralPath (Join-Path $root 'docs\release-readme.txt') -Destination (Join-Path $bundle '使用说明.txt')
    $files = @(Get-ChildItem -LiteralPath $payload -File -Recurse | Sort-Object FullName | ForEach-Object {
        [ordered]@{path=$_.FullName.Substring($payload.Length + 1).Replace('\','/');bytes=$_.Length;sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()}
    })
    $manifest = [ordered]@{schemaVersion=1;product=$package.name;version=$package.version;platform='win-x64';builtAt=[DateTime]::UtcNow.ToString('o');files=$files}
    [IO.File]::WriteAllText((Join-Path $bundle 'release.json'), ($manifest | ConvertTo-Json -Depth 6), (New-Object Text.UTF8Encoding($false)))
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::CreateFromDirectory($build, $zip, [IO.Compression.CompressionLevel]::Optimal, $false)
    [pscustomobject]@{archive=$zip;bytes=(Get-Item -LiteralPath $zip).Length;programFiles=$files.Count} | ConvertTo-Json
} finally {
    # This GUID staging directory is created by this build only.
    $resolvedBuild = [IO.Path]::GetFullPath($build)
    if ($resolvedBuild.StartsWith(([IO.Path]::GetFullPath($buildParent).TrimEnd('\') + '\'), [StringComparison]::OrdinalIgnoreCase) -and
        (Test-Path -LiteralPath $resolvedBuild)) {
        Assert-ReleasePathHasNoLinks $resolvedBuild
        Remove-Item -LiteralPath $resolvedBuild -Recurse -Force
    }
}
