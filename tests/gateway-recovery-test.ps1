$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $root 'src\Api-Settings.ps1')
function Assert($condition, $message) { if (-not $condition) { throw $message } }
$script:calls = 0; $script:writes = 0
$failed = $false
try {
    Invoke-GatewayPreparation { $script:calls++; throw '[gateway_unavailable] HTTP 401' } { return $null } { $script:writes++ } | Out-Null
} catch { $failed = $true }
Assert ($failed -and $script:calls -eq 1 -and $script:writes -eq 0) 'Cancel retried the gateway or saved settings.'
$script:calls = 0
$result = Invoke-GatewayPreparation {
    $script:calls++
    if ($script:calls -eq 1) { throw '[gateway_unavailable] HTTP 401' }
    return [pscustomobject]@{ gateway = @{ ready = $true } }
} { return @{ base='https://new.invalid/v1'; key='inert-test' } } { param($values) $script:writes++ }
Assert ($result.gateway.ready -and $script:calls -eq 2 -and $script:writes -eq 1) 'Submitting settings did not connect with the new values.'
$script:calls = 0
$result = Invoke-GatewayPreparation { $script:calls++; return [pscustomobject]@{ gateway = @{ ready = $false }; cached = $true } } { return $null } { throw 'Cancel wrote settings.' }
Assert ($result.cached -and $script:calls -eq 1) 'Cancel did not retain the cached launch path.'
$failed = $false
try { Invoke-GatewayPreparation { throw 'Unrelated local port conflict' } { throw 'Must not ask' } {} | Out-Null } catch { $failed = $_.Exception.Message -eq 'Unrelated local port conflict' }
Assert $failed 'A local failure incorrectly opened API settings.'
@{passed=$true;checks=@('cancel preserves settings','only submit connects again','cached failure remains usable','unrelated errors do not prompt')} | ConvertTo-Json -Compress
