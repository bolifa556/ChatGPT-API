$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $root 'src\Common.ps1')
. (Join-Path $root 'src\Package-Paths.ps1')
. (Join-Path $root 'src\Launcher-State.ps1')
. (Join-Path $root 'src\Recovery-Control.ps1')
function Assert($condition,[string]$message) { if (-not $condition) { throw $message } }
$fixture = Join-Path $root ('data\testing\recovery 中文-' + [Guid]::NewGuid().ToString('N'))
foreach ($dir in @('src','install','runtime','startup','home','data\state','data\logs','data\cache')) { [void][IO.Directory]::CreateDirectory((Join-Path $fixture $dir)) }
foreach ($name in @('Common.ps1','Package-Paths.ps1','Launcher-State.ps1','Recovery-Control.ps1')) { Copy-Item -LiteralPath (Join-Path $root ('src\'+$name)) -Destination (Join-Path $fixture ('src\'+$name)) }
Copy-Item -LiteralPath (Join-Path $root 'src\Recover-ChatGPT.ps1') -Destination (Join-Path $fixture 'src')
Copy-Item -LiteralPath (Join-Path $root 'src\Recover-ChatGPT.vbs') -Destination (Join-Path $fixture 'src')
Copy-Item -LiteralPath (Join-Path $root 'install\Install-Core.ps1') -Destination (Join-Path $fixture 'install')
$config = Join-Path $fixture 'home\config.toml'
$baseline = "model = `"gpt-6-sol`"`r`ncli_auth_credentials_store = `"file`"`r`n[app]`r`nlocaleOverride = `"zh-CN`"`r`n"
Write-Utf8File (Join-Path $fixture 'data\cache\models-smr.json') '{"models":[{"slug":"Vendor/model"}]}'
$checks = @()
$foreign = 'model_provider = "chatgpt_api_launcher"' + "`n" + 'openai_base_url = "http://127.0.0.1:8102/v1"' + "`n" + 'model_catalog_json = "another-install/models.json"' + "`n"
Write-Utf8File $config $foreign
Repair-LegacyLauncherConfig $fixture $config
Assert ([IO.File]::ReadAllText($config) -ceq $foreign) 'A matching port/provider was mistaken for configuration owned by this installation.'
# 3.2.0 wrote these definitions before recording the original configuration,
# so both its normal exit and its crash journal retain the unused helpers.
$legacyBaseline = Set-LauncherProvider $baseline 'chatgpt_api_launcher' 'http://127.0.0.1:8102/v1' $fixture $false
$legacyBaseline = Set-LauncherMixedProvider $legacyBaseline 'http://127.0.0.1:8102/v1' $fixture $false
foreach ($scenario in @('normal-exit','crash','crash-with-preference-change')) {
    Write-Utf8File $config $legacyBaseline
    Apply-LauncherConfig $fixture $config 'gateway' 'http://127.0.0.1:8102/v1' '' 'apionly'
    $legacyState = Read-LauncherState $fixture
    $legacyState.PSObject.Properties.Remove('originalExisted')
    $expected = $legacyBaseline
    if ($scenario -eq 'normal-exit') {
        $legacyState.active = $false; $legacyState.original = $null; $legacyState.applied = $null
        Write-Utf8File $config $legacyBaseline
    } elseif ($scenario -eq 'crash-with-preference-change') {
        Write-Utf8File $config ([IO.File]::ReadAllText($config).Replace('zh-CN','en-US'))
        $expected = $legacyBaseline.Replace('zh-CN','en-US')
    }
    Write-Utf8File (Get-LauncherDataPath $fixture 'launcher-state.json') ($legacyState | ConvertTo-Json -Depth 8)
    Restore-LauncherConfig $fixture $config
    Restore-LauncherConfig $fixture $config
    Assert ([IO.File]::ReadAllText($config) -ceq $expected) ('3.2.0 upgrade did not retain the restored settings after ' + $scenario)
    Assert (-not (Read-LauncherState $fixture).active) 'The old launch journal remained active after recovery.'
    $checks += '3.2.0 upgrade after ' + $scenario
}
$selectedOfficial = Set-RootString $legacyBaseline 'model_provider' 'openai'
Write-Utf8File $config $selectedOfficial
Repair-LegacyLauncherConfig $fixture $config
Assert ([IO.File]::ReadAllText($config) -ceq $selectedOfficial) 'Unused API definitions blocked an explicitly selected native provider.'
foreach ($activeOverride in @(
    (Set-RootString $legacyBaseline 'model_provider' 'chatgpt_api_launcher'),
    (Set-RootString $legacyBaseline 'model_catalog_json' (Join-Path $fixture 'data\cache\models-smr.json')),
    (Set-RootString $selectedOfficial 'openai_base_url' 'http://127.0.0.1:8102/v1')
)) {
    Write-Utf8File $config $activeOverride
    $blocked = $false
    try { Repair-LegacyLauncherConfig $fixture $config }
    catch { $blocked = $_.Exception.Message -eq '旧版 API 配置缺少原设置记录，已保留现场。' }
    Assert $blocked 'An active legacy override without its original record was silently discarded.'
    Assert ([IO.File]::ReadAllText($config) -ceq $activeOverride) 'Missing legacy records caused an unrecorded configuration change.'
}
$checks += 'Unused provider definitions are preserved; active owned roots still require their legacy recovery record'
foreach ($scenario in @('normal','crash','corrupt-config','new-boot')) {
    Write-Utf8File $config $baseline
    $session = Register-LauncherRecovery $fixture $config (Join-Path $fixture 'startup')
    Assert (@(Get-ChildItem -LiteralPath (Join-Path $fixture 'startup') -Filter '*.lnk' -Force).Count -eq 1) 'Next-logon recovery was not registered.'
    Apply-LauncherConfig $fixture $config 'gateway' 'http://127.0.0.1:8102/v1' '' 'apionly'
    if ($scenario -eq 'normal') {
        Restore-LauncherConfig $fixture $config; Unregister-LauncherRecovery $fixture $session
    } else {
        $state = [IO.File]::ReadAllText((Get-RecoveryPath $fixture)) | ConvertFrom-Json
        if ($scenario -eq 'new-boot') { $state.boot = 'previous-system-boot' }
        else { $state.owner = $null }
        Write-LauncherFile (Get-RecoveryPath $fixture) ($state | ConvertTo-Json -Depth 5)
        if ($scenario -eq 'corrupt-config') { Write-Utf8File $config 'partially written'; Write-Utf8File ($config + '.chatgpt-api.tmp') 'interrupted temporary file' }
        if ($scenario -in @('crash','new-boot')) {
            Start-Process -FilePath $state.shortcut -WindowStyle Hidden
            for ($n=0; $n -lt 150 -and (Test-Path -LiteralPath (Get-RecoveryPath $fixture)); $n++) { Start-Sleep -Milliseconds 100 }
        } else {
            & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $fixture 'src\Recover-ChatGPT.ps1') -Immediate
            Assert ($LASTEXITCODE -eq 0) ('Recovery failed for ' + $scenario)
        }
    }
    Assert ([IO.File]::ReadAllText($config) -ceq $baseline) ('Original native configuration changed after ' + $scenario)
    Assert (-not (Test-Path -LiteralPath (Get-RecoveryPath $fixture))) 'Completed recovery kept its journal.'
    Assert (@(Get-ChildItem -LiteralPath (Join-Path $fixture 'startup') -Filter '*.lnk' -Force).Count -eq 0) 'Completed recovery kept its startup shortcut.'
    Assert (@(Get-ChildItem -LiteralPath (Join-Path $fixture 'home') -File).Count -eq 1) 'Compatibility scratch files remained in the native home.'
    $checks += $scenario
}
$ownerScript = Join-Path $fixture 'owner.ps1'
$quote = { param($value) "'" + $value.Replace("'","''") + "'" }
$lines = @("`$ErrorActionPreference = 'Stop'")
foreach ($name in @('Common.ps1','Package-Paths.ps1','Launcher-State.ps1','Recovery-Control.ps1')) { $lines += '. ' + (& $quote (Join-Path $fixture ('src\'+$name))) }
$lines += '$session = Register-LauncherRecovery ' + ((@($fixture,$config,(Join-Path $fixture 'startup')) | ForEach-Object { & $quote $_ }) -join ' ')
$lines += 'Apply-LauncherConfig ' + ((@($fixture,$config,'gateway','http://127.0.0.1:8102/v1','','apionly') | ForEach-Object { & $quote $_ }) -join ' ')
$lines += 'Write-Utf8File ' + (& $quote (Join-Path $fixture 'prepared')) + " 'ready'"
$lines += 'Start-Sleep -Seconds 120'
Write-Utf8File $config $baseline
[IO.File]::WriteAllText($ownerScript,($lines -join "`r`n"),(New-Object Text.UTF8Encoding($true)))
$owner = Start-Process -FilePath powershell.exe -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',('"'+$ownerScript+'"')) -WindowStyle Hidden -PassThru -RedirectStandardError (Join-Path $fixture 'owner-stderr.log')
try {
    for ($n=0; $n -lt 300 -and -not (Test-Path -LiteralPath (Join-Path $fixture 'prepared')); $n++) { $owner.Refresh(); if ($owner.HasExited) { throw ('Fixture launcher exited before recovery was registered. ' + [IO.File]::ReadAllText((Join-Path $fixture 'owner-stderr.log'))) }; Start-Sleep -Milliseconds 100 }
    Assert (Test-Path -LiteralPath (Join-Path $fixture 'prepared')) 'Fixture launcher did not prepare.'
    Stop-Process -Id $owner.Id -Force
    $pending = [IO.File]::ReadAllText((Get-RecoveryPath $fixture)) | ConvertFrom-Json
    Start-Process -FilePath $pending.shortcut -WindowStyle Hidden
    for ($n=0; $n -lt 150 -and (Test-Path -LiteralPath (Get-RecoveryPath $fixture)); $n++) { Start-Sleep -Milliseconds 100 }
    Assert (-not (Test-Path -LiteralPath (Get-RecoveryPath $fixture))) 'Detached recovery did not finish after the launcher was killed.'
    Assert ([IO.File]::ReadAllText($config) -ceq $baseline) 'Detached recovery changed the original native configuration.'
    Assert (@(Get-ChildItem -LiteralPath (Join-Path $fixture 'startup') -Filter '*.lnk' -Force).Count -eq 0) 'Detached recovery kept its startup shortcut.'
    $checks += 'launcher force-killed before client activation; next-logon recovery completed'
} finally { $owner.Refresh(); if (-not $owner.HasExited) { Stop-Process -Id $owner.Id -Force } }
$checks | ConvertTo-Json
