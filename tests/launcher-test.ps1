$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $root 'src\Common.ps1')
. (Join-Path $root 'src\Package-Paths.ps1')
. (Join-Path $root 'src\Launcher-State.ps1')
. (Join-Path $root 'install\Install-Core.ps1')
. (Join-Path $root 'install\Bootstrap-Runtime.ps1')
function Assert($condition, [string]$message) { if (-not $condition) { throw $message } }
$files = @(Get-ChildItem -LiteralPath $root -Filter *.ps1 -File)
foreach ($dir in @('src','install','tests')) { $files += Get-ChildItem -LiteralPath (Join-Path $root $dir) -Filter *.ps1 -File }
foreach ($file in $files) {
    $tokens=$null; $errors=$null
    $null=[Management.Automation.Language.Parser]::ParseFile($file.FullName,[ref]$tokens,[ref]$errors)
    Assert ($errors.Count -eq 0) ('Invalid PowerShell: ' + $file.Name + ': ' + ($errors.Message -join '; '))
}
$fixture=Join-Path $root 'data\testing\launcher'
$null=Initialize-PackageLayout $fixture
$config=Join-Path $fixture 'config.toml'
$baseline="model = `"gpt-6-sol`"`r`nmodel_reasoning_effort = `"ultra`"`r`n[app]`r`nlocaleOverride = `"zh-CN`"`r`nshowMax = true`r`n"
$baseline=Set-LauncherProvider $baseline 'chatgpt_api_launcher' 'http://127.0.0.1:8102/v1' $fixture $false
$models=@{models=@(@{slug='gpt-6-sol'},@{slug='Example/model'})}
$catalog=Get-LauncherDataPath $fixture 'models-smr.json'
Write-Utf8File $catalog ($models|ConvertTo-Json -Depth 5)
foreach($mode in @('mixed','gateway')) {
    $catalogModels=if($mode -eq 'mixed'){$models}else{@{models=@(@{slug='Example/model'})}}
    Write-Utf8File $catalog ($catalogModels|ConvertTo-Json -Depth 5)
    Write-Utf8File $config $baseline
    Apply-LauncherConfig $fixture $config $mode 'http://127.0.0.1:8102/v1' 'https://example.invalid/v1'
    $applied=[IO.File]::ReadAllText($config)
    Assert ((Get-RootString $applied 'model_catalog_json') -eq $catalog) 'Catalog path must be data/cache.'
    $provider=Get-RootString $applied 'model_provider'
    if($mode -eq 'gateway'){Assert ($provider -eq 'chatgpt_api_launcher') 'No-login provider was not selected.'}
    else{Assert (-not $provider -or $provider -eq 'openai') 'Mixed provider changed.'}
    Restore-LauncherConfig $fixture $config
    Assert ([IO.File]::ReadAllText($config) -ceq $baseline) 'Exact restore failed.'
    Apply-LauncherConfig $fixture $config $mode 'http://127.0.0.1:8102/v1' 'https://example.invalid/v1'
    Write-Utf8File $config ([IO.File]::ReadAllText($config).Replace('zh-CN','en-US'))
    Restore-LauncherConfig $fixture $config
    Assert ([IO.File]::ReadAllText($config) -ceq $baseline.Replace('zh-CN','en-US')) 'User preferences were overwritten.'
}
$before=@(Get-ChildItem -LiteralPath $fixture -Recurse -File).Count
for($i=0;$i -lt 8;$i++) {
    Write-Utf8File $config $baseline
    Apply-LauncherConfig $fixture $config 'mixed' 'http://127.0.0.1:8102/v1' 'https://example.invalid/v1'
    Restore-LauncherConfig $fixture $config
}
Assert (@(Get-ChildItem -LiteralPath $fixture -Recurse -File).Count -eq $before) 'Repeated switching created extra data.'

$auth=Join-Path $fixture 'auth.json'
Write-Utf8File $auth '{}'
Assert (-not (Get-SavedChatGPTLogin $fixture)) 'Empty auth should use gateway-only mode.'
Write-Utf8File $auth '{"auth_mode":"chatgpt","tokens":{"access_token":"expired-test-token"}}'
Assert (Get-SavedChatGPTLogin $fixture) 'Stored OAuth presence detection changed.'
Write-Utf8File $auth '{"auth_mode":"apikey","tokens":{"access_token":"test"}}'
Assert (-not (Get-SavedChatGPTLogin $fixture)) 'API key auth is not a ChatGPT login.'
Write-Utf8File $auth 'invalid-json'
Assert (-not (Get-SavedChatGPTLogin $fixture)) 'Malformed auth must not appear signed in.'

$envFile=Get-LauncherDataPath $fixture '.env'
Write-Utf8File $envFile "# custom settings`r`nBASE_URL=https://old.invalid/v1`r`nAPI_KEY=fixture-key`r`nSHIM_PORT=8999`r`nSSH_HOST=fixture`r`n"
Set-LauncherSettings $fixture 'http://gateway.invalid' 'test-key=$literal'
$saved=[IO.File]::ReadAllText($envFile)
Assert ($saved.Contains('SSH_HOST=fixture') -and $saved.Contains('SHIM_PORT=8999') -and $saved.Contains('# custom settings')) 'Reinstall lost optional settings.'
Assert ($saved.Contains('BASE_URL=http://gateway.invalid/v1') -and $saved.Contains('API_KEY=test-key=$literal')) 'URL/key was altered.'
Set-LauncherSettings $fixture 'http://gateway.invalid' 'test-key=$literal'
Assert ([IO.File]::ReadAllText($envFile) -ceq $saved) 'Reinstall is not idempotent.'
$fakeDesktop=Join-Path $fixture 'desktop'
Set-DesktopEntries $root $fakeDesktop
Set-DesktopEntries $root $fakeDesktop
Assert (@(Get-ChildItem -LiteralPath $fakeDesktop -Filter *.lnk).Count -eq 2) 'Shortcut updates created duplicates.'
$shell=New-Object -ComObject WScript.Shell
foreach($name in @('ChatGPT','chatgpt-api')) {
    $link=$shell.CreateShortcut((Join-Path $fakeDesktop ($name+'.lnk')))
    Assert ($link.Arguments.Contains((Join-Path $root ($name+'.vbs')))) 'Shortcut is not targeting the root entry.'
    Assert (-not $link.TargetPath.Contains('WindowsApps')) 'Shortcut is tied to a client version.'
}

$legacy=Join-Path $root 'data\testing\migration'
$null=Initialize-PackageLayout $legacy
Write-Utf8File (Join-Path $legacy '.env') 'API_KEY=migration-fixture'
Write-Utf8File (Join-Path $legacy 'catalog-state.json') '{"fixture":true}'
Write-Utf8File (Join-Path $legacy 'launcher-state.json') '{"active":false}'
$null=Initialize-PackageLayout $legacy
Assert (-not (Test-Path -LiteralPath (Join-Path $legacy '.env'))) 'Legacy env not migrated.'
Assert ([IO.File]::ReadAllText((Join-Path $legacy 'data\.env')) -ceq 'API_KEY=migration-fixture') 'Migration changed the key.'
Assert (Test-Path -LiteralPath (Join-Path $legacy 'data\cache\catalog-state.json')) 'Legacy cache not migrated.'
$count=@(Get-ChildItem -LiteralPath $legacy -Recurse -File).Count
$null=Initialize-PackageLayout $legacy
Assert (@(Get-ChildItem -LiteralPath $legacy -Recurse -File).Count -eq $count) 'Migration accumulated files.'
$me=Get-CimInstance Win32_Process -Filter ('ProcessId='+$PID)
$record=@{pid=$me.ProcessId;exe=$me.ExecutablePath;createdAt=$me.CreationDate.ToUniversalTime().ToString('o')}
Write-Utf8File (Join-Path $legacy 'data\state\layout-migration.json') (@{pending=$true;watcher=$record;router=$null}|ConvertTo-Json -Depth 5)
Write-Utf8File (Join-Path $legacy 'launcher-state.json') '{"active":true}'
Assert (-not (Initialize-PackageLayout $legacy)) 'Active legacy watcher must defer migration.'
Assert (Test-Path -LiteralPath (Join-Path $legacy 'launcher-state.json')) 'Active journal moved while in use.'
Write-Utf8File (Join-Path $legacy 'data\state\layout-migration.json') '{"pending":false}'
Assert (Test-LauncherDependencies $root) 'Installed dependency versions do not match lock file.'
$report=@{passed=$true;checks=@('PowerShell 5.1 syntax','exact restore and preference preservation','8 switches without growing backups','no-login detection','idempotent install preserving settings','two version-independent shortcuts','safe and repeatable data migration','active legacy process protection','locked dependencies')}
Write-Utf8File (Join-Path $root 'data\diagnostics\launcher-results.json') ($report|ConvertTo-Json -Depth 5)
$report|ConvertTo-Json -Depth 5
