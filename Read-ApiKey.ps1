$ErrorActionPreference = 'Stop'
$packageDir = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $packageDir 'src\Common.ps1')
. (Join-Path $packageDir 'src\Package-Paths.ps1')
. (Join-Path $packageDir 'src\Launcher-State.ps1')

$settings = Get-EnvValues (Get-LauncherDataPath $packageDir '.env')
$apiKey = [string]$settings['API_KEY']
if (-not $apiKey) { throw 'API_KEY is missing from .env.' }
# Legacy configurations may still reference this reader. It returns a key only;
# the launcher owns router startup and lifetime.
[Console]::Out.WriteLine($apiKey)
