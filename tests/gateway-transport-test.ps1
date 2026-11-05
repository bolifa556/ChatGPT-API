param([string]$RouterSource = '')
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $root 'src\Common.ps1')
. (Join-Path $root 'src\Package-Paths.ps1')
. (Join-Path $root 'src\Launcher-State.ps1')
if (-not $RouterSource) { $RouterSource = Join-Path $root 'src\Router-Control.ps1' }
. $RouterSource
function Assert($condition, [string]$message) { if (-not $condition) { throw $message } }
$fixture = Join-Path $root 'data\testing\gateway-transport-launcher'
[void][IO.Directory]::CreateDirectory((Join-Path $fixture 'data\state'))
$envFile = Get-LauncherDataPath $fixture '.env'
$cases = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'gateway-transport-cases.json')) | ConvertFrom-Json

# Run the real launcher up to routing selection without starting any process,
# contacting a server, or changing the actual client's configuration.
function Get-RouterBuildId { return 'fixture-build' }
function Get-NativeClientVersion { return '0.166.0' }
function Get-ExistingOfficialProxy { return 'http://127.0.0.1:9999' }
function Invoke-RestMethod { return $null }
function Write-Utf8File([string]$path, [string]$content) {
    Assert ($path -eq (Get-LauncherDataPath $fixture 'route-state.json')) 'Unexpected launcher write.'
    $script:route = $content | ConvertFrom-Json
    throw 'fixture_route_prepared'
}
function Start-Process {
    param($FilePath, $ArgumentList, $WindowStyle, [switch]$PassThru, $RedirectStandardError)
    Assert ($FilePath -like '*ssh.exe') 'Unexpected helper process.'
    Assert ($WindowStyle -eq 'Hidden') 'SSH helper should stay hidden.'
    $script:tunnel = $ArgumentList
    throw 'fixture_ssh_requested'
}
$checked = 0
foreach ($case in $cases) {
    $text = "BASE_URL=http://gateway.invalid:18000/v1`nAPI_KEY=fixture-key=#literal`nSHIM_PORT=18102`n"
    if ($null -ne $case[0]) { $text += 'GATEWAY_TRANSPORT=' + $case[0] + "`n" }
    [IO.File]::WriteAllText($envFile, $text)
    $script:route = $null; $script:tunnel = $null; $failure = ''
    try { Ensure-LocalRouter $fixture 'gateway' 'apionly' | Out-Null }
    catch { $failure = $_.Exception.Message }
    if ($case[1] -eq 'ssh') {
        Assert ($failure -eq 'fixture_ssh_requested') ('Explicit SSH failed: ' + $case[0] + ': ' + $failure)
        Assert ($script:tunnel -contains '127.0.0.1:18003:127.0.0.1:18000') 'SSH tunnel target changed.'
    } else {
        Assert ($failure -eq 'fixture_route_prepared') ('URL-based startup was blocked: ' + $case[0] + ': ' + $failure)
        Assert ($script:route.gatewayTransport -eq 'direct' -and -not $script:tunnel) 'Ordinary route started SSH.'
        Assert ($script:route.officialProxy -eq 'http://127.0.0.1:9999') 'Official proxy selection changed.'
    }
    Assert ([IO.File]::ReadAllText($envFile) -ceq $text) 'Network selection rewrote URL/key or settings.'
    $checked++
}
[IO.File]::WriteAllText($envFile, "GATEWAY_TRANSPORT=SSH`n")
$script:route = $null; $script:tunnel = $null
try { Ensure-LocalRouter $fixture 'mixed' 'official' | Out-Null } catch { $failure = $_.Exception.Message }
Assert ($failure -eq 'fixture_route_prepared' -and -not $script:tunnel) 'Official entry started a gateway tunnel.'
@{passed=$true;cases=$checked;checks=@('real launcher accepts ordinary network labels','explicit SSH preserved','official entry does not start SSH','settings and credentials unchanged')} | ConvertTo-Json -Compress
