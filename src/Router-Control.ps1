function Get-RouterBuildId([string]$packageDir) {
    $bytes = New-Object 'System.Collections.Generic.List[byte]'
    foreach($name in @('shim.mjs','history-compat.mjs','non-gpt-compat.mjs','sse.mjs','chat-compat.mjs','image-compat.mjs','model-context.mjs','transport.mjs','response-state.mjs','settings.mjs','gateway-sources.mjs')) {
        $bytes.AddRange([IO.File]::ReadAllBytes((Join-Path $packageDir ('src\'+$name))))
    }
    foreach($asset in @('model-contexts.json','model-template.json')) {
        $assetFile = Join-Path $packageDir ('assets\' + $asset)
        if (Test-Path -LiteralPath $assetFile) { $bytes.AddRange([IO.File]::ReadAllBytes($assetFile)) }
    }
    $hash = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($hash.ComputeHash($bytes.ToArray()))).Replace('-','').ToLowerInvariant() }
    finally { $hash.Dispose() }
}
function Add-RouterHelper([string]$packageDir, $process, [string]$marker) {
    $p = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $process.Id)
    if(-not $p){throw 'Router helper exited during startup.'}
    $file=Get-LauncherDataPath $packageDir 'runtime-state.json'
    $state=if(Test-Path -LiteralPath $file){[IO.File]::ReadAllText($file)|ConvertFrom-Json}else{$null}
    $items=@()
    if($state -and $state.version -eq 2){
        foreach($entry in @($state.helpers)){
            $alive=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$entry.pid) -ErrorAction SilentlyContinue
            if($alive -and $alive.ExecutablePath -eq $entry.exe -and $alive.CreationDate.ToUniversalTime().ToString('o') -eq $entry.createdAt -and $alive.ProcessId -ne $p.ProcessId){$items+=$entry}
        }
    }
    $items+=@{pid=$p.ProcessId;exe=$p.ExecutablePath;createdAt=$p.CreationDate.ToUniversalTime().ToString('o');marker=$marker}
    Write-Utf8File $file (@{version=2;helpers=$items}|ConvertTo-Json -Depth 5)
}
function Get-LauncherRouterSelection([string]$packageDir, [string]$routeMode = '', [string]$entryMode = '') {
    $state = Read-LauncherState $packageDir
    if (-not $entryMode) { $entryMode = if ($state -and $state.active -and $state.entryMode) { [string]$state.entryMode } else { 'api' } }
    if ($entryMode -notin @('official','api','apionly')) { throw 'Unknown launcher entry mode.' }
    if ($entryMode -eq 'apionly') { $routeMode = 'gateway' }
    elseif ($entryMode -eq 'official') { $routeMode = 'mixed' }
    elseif (-not $routeMode) {
        $routeMode = if ($state -and $state.active -and $state.mode) { [string]$state.mode } else { Get-LauncherRouteMode $entryMode (Get-CodexHome) }
    }
    return [pscustomobject]@{ mode = $routeMode; entryMode = $entryMode }
}
function Ensure-LocalRouter([string]$packageDir, [string]$routeMode = '', [string]$entryMode = '') {
    $settings=Get-EnvValues (Get-LauncherDataPath $packageDir '.env')
    $baseUrl=Normalize-BaseUrl ([string]$settings['BASE_URL'])
    $key=[string]$settings['API_KEY'];if(-not $key){throw 'API_KEY is missing.'}
    $port=if($settings['SHIM_PORT']){[int]$settings['SHIM_PORT']}else{8102}
    $url='http://127.0.0.1:'+ $port +'/healthz'
    $selection = Get-LauncherRouterSelection $packageDir $routeMode $entryMode
    $mode = $selection.mode
    $entryMode = $selection.entryMode
    $sha=[Security.Cryptography.SHA256]::Create()
    try{$sourceId=([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($baseUrl+"`n"+$key)))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}
    $buildId=Get-RouterBuildId $packageDir
    $lock=$null
    try{
        for($n=0;$n -lt 100 -and -not $lock;$n++){
            try{$lock=[IO.File]::Open((Get-LauncherDataPath $packageDir 'router-start.lock'),'OpenOrCreate','ReadWrite','None')}catch{Start-Sleep -Milliseconds 100}
        }
        if(-not $lock){throw 'Another local router startup is still running.'}
        $health=$null
        try{$health=Invoke-RestMethod -Uri $url -TimeoutSec 1}catch{}
        if($health){
            $healthEntry = if ($health.entryMode) { $health.entryMode } else { 'api' }
            if($health.service -eq 'chatgpt-api-router' -and $health.sourceId -eq $sourceId -and ($health.buildId -eq $buildId -or (Test-LegacyRouter $packageDir $health)) -and $health.mode -eq $mode -and $healthEntry -eq $entryMode){return $health}
            throw 'The router on this port uses a different version or configuration. Fully exit ChatGPT and reopen chatgpt-api.'
        }
        $clientVersion = if ($mode -eq 'mixed') { Get-NativeClientVersion } else { '' }
        $logDir=Join-Path $packageDir 'data\logs';[void](New-Item -ItemType Directory -Path $logDir -Force)
        $transport=if($settings['GATEWAY_TRANSPORT']){[string]$settings['GATEWAY_TRANSPORT']}else{'direct'}
        if($transport -notin @('direct','ssh')){throw 'GATEWAY_TRANSPORT must be direct or ssh.'}
        if($transport -eq 'ssh' -and $entryMode -ne 'official'){
            $uri=[Uri]$baseUrl
            $hostName=if($settings['SSH_HOST']){[string]$settings['SSH_HOST']}else{$uri.Host}
            $remoteHost=if($settings['SSH_REMOTE_HOST']){[string]$settings['SSH_REMOTE_HOST']}elseif($hostName -eq $uri.Host){'127.0.0.1'}else{$uri.Host}
            $tunnelPort=if($settings['GATEWAY_TUNNEL_PORT']){[int]$settings['GATEWAY_TUNNEL_PORT']}else{18003}
            $target=if($settings['SSH_USER']){[string]$settings['SSH_USER']+'@'+$hostName}else{$hostName}
            $forward='127.0.0.1:'+ $tunnelPort +':'+$remoteHost+':'+$uri.Port
            $args=@('-N','-o','BatchMode=yes','-o','ConnectTimeout=10','-o','ExitOnForwardFailure=yes','-o','ServerAliveInterval=30','-o','ServerAliveCountMax=3','-o','StrictHostKeyChecking=accept-new','-L',$forward,$target)
            $ssh=(Get-Command ssh.exe -ErrorAction Stop).Source
            $p=Start-Process -FilePath $ssh -ArgumentList $args -WindowStyle Hidden -PassThru -RedirectStandardError (Join-Path $logDir 'ssh-stderr.log')
            Add-RouterHelper $packageDir $p $forward
            $connected=$false
            for($n=0;$n -lt 50;$n++){
                $p.Refresh();if($p.HasExited){throw 'SSH tunnel failed.'}
                $tcp=New-Object Net.Sockets.TcpClient
                try{$tcp.Connect('127.0.0.1',$tunnelPort);$connected=$true;break}catch{Start-Sleep -Milliseconds 200}finally{$tcp.Dispose()}
            }
            if(-not $connected){throw 'SSH tunnel was not ready.'}
        }
        Write-Utf8File (Get-LauncherDataPath $packageDir 'route-state.json') (@{version=2;mode=$mode;entryMode=$entryMode;gatewayTransport=$transport;officialProxy=(Get-ExistingOfficialProxy);clientVersion=$clientVersion}|ConvertTo-Json -Compress)
        $node=Join-Path $packageDir 'runtime\node.exe';$script=Join-Path $packageDir 'src\shim.mjs'
        $text=& $node $script --prepare 2> (Join-Path $logDir 'prepare-stderr.log')
        if($LASTEXITCODE -ne 0){throw ('Model refresh failed: '+[IO.File]::ReadAllText((Join-Path $logDir 'prepare-stderr.log')))}
        $prepared=($text -join '')|ConvertFrom-Json
        $p=Start-Process -FilePath $node -ArgumentList @('"'+$script+'"') -WorkingDirectory (Split-Path -Parent $script) -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logDir 'shim-stdout.log') -RedirectStandardError (Join-Path $logDir 'shim-stderr.log')
        Add-RouterHelper $packageDir $p $script
        for($n=0;$n -lt 60;$n++){
            $p.Refresh();if($p.HasExited){throw 'Local router exited. See shim-stderr.log.'}
            try{
                $health=Invoke-RestMethod -Uri $url -TimeoutSec 1
                if($health.service -eq 'chatgpt-api-router' -and $health.buildId -eq $buildId -and $health.sourceId -eq $sourceId){return $prepared}
            }catch{}
            Start-Sleep -Milliseconds 100
        }
        throw 'Local router did not become ready.'
    }finally{if($lock){$lock.Dispose()};$key=$null}
}
