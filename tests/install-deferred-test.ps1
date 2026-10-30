$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $root 'src\Common.ps1')
. (Join-Path $root 'src\Package-Paths.ps1')
. (Join-Path $root 'src\Launcher-State.ps1')
. (Join-Path $root 'install\Install-Core.ps1')
function Assert($condition, [string]$message) { if (-not $condition) { throw $message } }
$fixture = Join-Path $root ('data\testing\deferred-' + [Guid]::NewGuid().ToString('N'))
try {
    [void](Initialize-PackageLayout $fixture)
    Initialize-DeferredLauncherSettings $fixture
    $file = Join-Path $fixture 'data\.env'
    $settings = Get-EnvValues $file
    Assert (-not $settings['BASE_URL'] -and -not $settings['API_KEY']) 'Skip invented an API address or credential.'
    $blocked = $false
    try { Assert-LauncherApiConfigured $fixture } catch { $blocked = $_.Exception.Message.Contains('尚未配置 API') -and $_.Exception.Message.Contains('控制台') }
    Assert $blocked 'An unconfigured API entry has no actionable error.'
    $desktop = Join-Path $fixture 'desktop'
    Set-DesktopEntries $fixture $desktop
    Assert (@(Get-ChildItem -LiteralPath $desktop -Filter *.lnk).Count -eq 3) 'Skip failed to create all entries.'
    $preserved = @('BASE_URL=https://kept.invalid/v1','API_KEY=inert-kept-key','CUSTOM=keep','') -join [Environment]::NewLine
    Write-Utf8File $file $preserved
    Initialize-DeferredLauncherSettings $fixture
    Assert ([IO.File]::ReadAllText($file) -ceq $preserved) 'Skip changed an existing URL, key, or unknown option.'
    Assert-LauncherApiConfigured $fixture
    Assert (-not (Test-Path -LiteralPath (Join-Path $fixture 'data\cache\models-smr.json'))) 'Skip fetched or fabricated a model directory.'
    @{passed=$true;checks=@('empty API installation','explicit missing API error','all desktop entries created','existing configuration preserved exactly','no model directory fetched')} | ConvertTo-Json
} finally {
    $prefix = [IO.Path]::GetFullPath((Join-Path $root 'data\testing')).TrimEnd('\') + '\'
    $target = [IO.Path]::GetFullPath($fixture)
    if ($target.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { Remove-Item -LiteralPath $target -Recurse -Force }
}
