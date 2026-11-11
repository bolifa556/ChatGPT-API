$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $root 'src\Common.ps1')
. (Join-Path $root 'src\Package-Paths.ps1')
. (Join-Path $root 'src\Launcher-State.ps1')
. (Join-Path $root 'src\Recovery-Control.ps1')
function Assert($condition, [string]$message) { if (-not $condition) { throw $message } }
function Quote([string]$text) { return "'" + $text.Replace("'", "''") + "'" }
$node = Join-Path $root 'runtime\node.exe'
$module = ([Uri](Join-Path $root 'src\native-session.mjs')).AbsoluteUri | ConvertTo-Json -Compress
$checks = @()
foreach ($scenario in @('normal', 'native-crash', 'adapter-crash', 'launcher-crash', 'power-loss', 'stalled-close')) {
    $fixture = Join-Path $root ('data\testing\session-' + $scenario + '-' + [Guid]::NewGuid().ToString('N'))
    foreach ($dir in @('src','install','runtime','startup','home','data\state','data\logs','data\cache')) { [void][IO.Directory]::CreateDirectory((Join-Path $fixture $dir)) }
    foreach ($name in @('Common','Package-Paths','Launcher-State','Recovery-Control','Router-Control','Recover-ChatGPT')) { Copy-Item -LiteralPath (Join-Path $root ('src\' + $name + '.ps1')) -Destination (Join-Path $fixture 'src') }
    Copy-Item -LiteralPath (Join-Path $root 'src\Recover-ChatGPT.vbs') -Destination (Join-Path $fixture 'src')
    Copy-Item -LiteralPath (Join-Path $root 'install\Install-Core.ps1') -Destination (Join-Path $fixture 'install')
    New-Item -ItemType HardLink -Path (Join-Path $fixture 'runtime\node.exe') -Target $node | Out-Null
    $config = Join-Path $fixture 'home\config.toml'
    $baseline = "model = `"original`"`r`ncli_auth_credentials_store = `"file`"`r`n[app]`r`nlocaleOverride = `"zh-CN`"`r`n"
    Write-Utf8File $config $baseline
    Write-Utf8File (Join-Path $fixture 'data\cache\models-smr.json') '{"models":[{"slug":"Fixture/model"}]}'
    $mockClient = @'
import fs from 'node:fs';
import path from 'node:path';
const root=process.argv[2];
const finish=()=>{if(fs.existsSync(path.join(root,'finish-client'))){watcher.close();process.exit(0)}};
const watcher=fs.watch(root,finish);finish();
'@
    Write-Utf8File (Join-Path $fixture 'client.mjs') $mockClient
    $controllerScript = @"
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {runNativeSession} from $module;
const [root,,,,,session]=process.argv.slice(2);
const server=http.createServer((req,res)=>res.end('fixture'));
server.listen(0,'127.0.0.1');
await runNativeSession({
 router:{routerReady:once(server,'listening'),closeRouter:()=>new Promise(resolve=>server.close(resolve))},
 start:async track=>{const child=spawn(process.execPath,[path.join(root,'client.mjs'),root],{windowsHide:true,stdio:'ignore'});await once(child,'spawn');track(child);return child},
 onStatus:value=>fs.writeFileSync(path.join(root,'data/state/native-session.json'),JSON.stringify({session,controllerPid:process.pid,...value})),
 recover:async()=>{const child=spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(root,'src/Recover-ChatGPT.ps1'),'-Immediate','-Session',session,'-ControllerPid',String(process.pid)],{windowsHide:true,stdio:'ignore'});const[code]=await once(child,'exit');if(code)throw Error('Fixture recovery failed')}
});
"@
    Write-Utf8File (Join-Path $fixture 'src\native-session.mjs') $controllerScript
    if ($scenario -eq 'stalled-close') {
        $controllerScript = $controllerScript.Replace('closeRouter:()=>new Promise(resolve=>server.close(resolve))','closeRouter:()=>new Promise(()=>{})')
        Write-Utf8File (Join-Path $fixture 'src\native-session.mjs') $controllerScript
    }
    $lines = @("`$ErrorActionPreference = 'Stop'")
    foreach ($name in @('Common','Package-Paths','Launcher-State','Recovery-Control','Router-Control')) { $lines += '. ' + (Quote (Join-Path $fixture ('src\' + $name + '.ps1'))) }
    $lines += '$session = Register-LauncherRecovery ' + ((@($fixture,$config,(Join-Path $fixture 'startup')) | ForEach-Object { Quote $_ }) -join ' ')
    $lines += 'Apply-LauncherConfig ' + ((@($fixture,$config,'gateway','http://127.0.0.1:8102/v1','','apionly') | ForEach-Object { Quote $_ }) -join ' ')
    $lines += '$guard = Start-Process -FilePath ' + (Quote (Join-Path $env:WINDIR 'System32\wscript.exe')) + ' -ArgumentList @(' + ((@((Join-Path $fixture 'src\Recover-ChatGPT.vbs'),(Join-Path $fixture 'home'),$node,'unused-archive','apionly') | ForEach-Object { Quote ('"'+$_+'"') }) -join ',') + ',$session) -WindowStyle Hidden -PassThru'
    $lines += 'Set-LauncherRecoveryOwner ' + (Quote $fixture) + ' $session $guard.Id'
    $lines += '$client = Wait-LauncherNativeClient ' + (Quote $fixture) + ' $session $guard'
    $lines += '$status = Read-LauncherText ' + (Quote (Join-Path $fixture 'data\state\native-session.json')) + ' | ConvertFrom-Json'
    $lines += 'Write-Utf8File ' + (Quote (Join-Path $fixture 'prepared.json')) + ' (@{controller=$status.controllerPid;guardian=$guard.Id;client=$client.ProcessId;session=$session}|ConvertTo-Json)'
    $lines += 'exit 0'
    $ownerScript = Join-Path $fixture 'owner.ps1'
    [IO.File]::WriteAllText($ownerScript,($lines -join "`r`n"),(New-Object Text.UTF8Encoding($true)))
    $owner = Start-Process powershell.exe -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',('"'+$ownerScript+'"')) -WindowStyle Hidden -PassThru -RedirectStandardError (Join-Path $fixture 'owner-stderr.log')
    $records = @((Get-RecoveryProcess $owner.Id))
    try {
        $prepared = Join-Path $fixture 'prepared.json'
        for($n=0;$n -lt 300 -and -not (Test-Path -LiteralPath $prepared);$n++) { $owner.Refresh(); if ($owner.HasExited -and -not (Test-Path -LiteralPath $prepared)) { throw ('Fixture owner failed. ' + [IO.File]::ReadAllText((Join-Path $fixture 'owner-stderr.log'))) }; Start-Sleep -Milliseconds 100 }
        Assert (Test-Path -LiteralPath $prepared) 'Fixture startup timed out.'
        $session = [IO.File]::ReadAllText($prepared) | ConvertFrom-Json
        $null = $owner.WaitForExit(5000)
        Assert ($owner.HasExited) 'Startup PowerShell remained resident.'
        $records = @((Get-RecoveryProcess $session.guardian),(Get-RecoveryProcess $session.controller),(Get-RecoveryProcess $session.client))
        Assert (-not (Test-Path -LiteralPath (Join-Path $fixture 'data\state\recovery-watcher.json'))) 'An extra recovery watcher was started.'
        if ($scenario -in @('launcher-crash','power-loss')) { Stop-Process -Id $session.guardian -Force }
        if ($scenario -in @('adapter-crash','power-loss')) { Stop-Process -Id $session.controller -Force }
        if ($scenario -in @('native-crash','power-loss')) { Stop-Process -Id $session.client -Force -ErrorAction SilentlyContinue }
        if ($scenario -in @('normal','launcher-crash','stalled-close')) { Write-Utf8File (Join-Path $fixture 'finish-client') 'exit' }
        if ($scenario -in @('normal','native-crash','stalled-close')) {
            Wait-Process -Id $session.client -Timeout 5 -ErrorAction SilentlyContinue
            Wait-ClosingLauncherSession $fixture
        }
        if ($scenario -eq 'power-loss') {
            $journal = [IO.File]::ReadAllText((Get-RecoveryPath $fixture)) | ConvertFrom-Json
            Start-Process -FilePath $journal.shortcut -WindowStyle Hidden
        }
        for($n=0;$n -lt 300 -and ((Test-Path -LiteralPath (Get-RecoveryPath $fixture)) -or @($records | Where-Object { Test-RecordedProcess $_ }).Count);$n++) { Start-Sleep -Milliseconds 100 }
        Assert (-not (Test-Path -LiteralPath (Get-RecoveryPath $fixture))) ('Recovery remained pending after ' + $scenario)
        Assert ([IO.File]::ReadAllText($config) -ceq $baseline) ('Native configuration changed after ' + $scenario)
        Assert (@($records | Where-Object { Test-RecordedProcess $_ }).Count -eq 0) ('A session process survived ' + $scenario)
        Assert (@(Get-ChildItem -LiteralPath (Join-Path $fixture 'startup') -Force).Count -eq 0) ('A recovery login trigger survived ' + $scenario)
        Assert (@(Get-ChildItem -LiteralPath (Join-Path $fixture 'home') -File).Count -eq 1) 'Native scratch files remained.'
        $checks += $scenario
    } finally {
        if (Test-Path -LiteralPath (Get-RecoveryPath $fixture)) {
            $pending = [IO.File]::ReadAllText((Get-RecoveryPath $fixture)) | ConvertFrom-Json
            $records += @($pending.controller,$pending.client)
        }
        foreach($record in $records) { if(Test-RecordedProcess $record){Stop-Process -Id $record.pid -Force} }
        if (Test-Path -LiteralPath (Get-RecoveryPath $fixture)) { & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $fixture 'src\Recover-ChatGPT.ps1') -Immediate }
    }
}
@{passed=$true;checks=$checks} | ConvertTo-Json -Depth 4
