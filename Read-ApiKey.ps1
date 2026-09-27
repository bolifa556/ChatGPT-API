$ErrorActionPreference = 'Stop'
$packageDir = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $packageDir 'src\Common.ps1')
. (Join-Path $packageDir 'src\Package-Paths.ps1')
. (Join-Path $packageDir 'src\Launcher-State.ps1')
. (Join-Path $packageDir 'src\Router-Control.ps1')
$null = Initialize-PackageLayout $packageDir

$settings = Get-EnvValues (Get-LauncherDataPath $packageDir '.env')
$apiKey = [string]$settings['API_KEY']
if (-not $apiKey) { throw 'API_KEY is missing from .env.' }
# Legacy provider conversations use the same compatibility router, including
# when opened through the native entry. Only their API request starts this helper.
$null = Ensure-LocalRouter $packageDir
[Console]::Out.WriteLine($apiKey)
