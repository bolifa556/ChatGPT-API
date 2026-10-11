param([Parameter(Mandatory=$true)][ValidateSet('official','api','apionly')][string]$Mode)
$ErrorActionPreference = 'Stop'
$packageDir = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $packageDir 'src\Common.ps1')
. (Join-Path $packageDir 'src\Package-Paths.ps1')
. (Join-Path $packageDir 'src\Launcher-State.ps1')
. (Join-Path $packageDir 'src\Router-Control.ps1')
$null = Initialize-PackageLayout $packageDir
$configPath = Join-Path (Get-CodexHome) 'config.toml'
$runtimePath = Get-LauncherDataPath $packageDir 'runtime-state.json'
$lockPath = Get-LauncherDataPath $packageDir 'launcher.lock'
$lock = $null
$apiLaunched = $false
$apiKey = ''
function Show-Message([string]$message) {
    Add-Type -AssemblyName System.Windows.Forms
    [void][System.Windows.Forms.MessageBox]::Show($message,'ChatGPT 启动器')
}
function Get-MainApp {
    return @(Get-CimInstance Win32_Process -Filter "name='ChatGPT.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -and $_.CommandLine -notmatch '--type=' })
}
function Stop-Helpers {
    if (-not (Test-Path -LiteralPath $runtimePath)) { return }
    $state = [IO.File]::ReadAllText($runtimePath) | ConvertFrom-Json
    foreach ($entry in @($state.helpers)) {
        if (-not $entry.pid) { continue }
        $p = Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$entry.pid) -ErrorAction SilentlyContinue
        if ($p -and $p.ExecutablePath -eq $entry.exe -and $p.CreationDate.ToUniversalTime().ToString('o') -eq $entry.createdAt -and $p.CommandLine.Contains([string]$entry.marker)) {
            Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
        }
    }
    Write-Utf8File $runtimePath '{"version":2,"helpers":[]}'
}
function Recover-OldOverrides {
    if (-not (Test-Path -LiteralPath $configPath)) { return }
    $content = [IO.File]::ReadAllText($configPath)
    $catalog = Get-RootString $content 'model_catalog_json'
    $base = Get-RootString $content 'openai_base_url'
    if ($catalog -ne (Get-LauncherDataPath $packageDir 'models-smr.json') -and $catalog -ne (Join-Path $packageDir 'models-smr.json') -and $base -ne 'http://127.0.0.1:8102/v1') { return }
    $savedPath = Get-LauncherDataPath $packageDir 'official-settings.json'
    if (-not (Test-Path -LiteralPath $savedPath)) { throw '发现旧版 API 覆盖但缺少原设置记录；为避免覆盖个人设置，已停止启动。' }
    $saved = [IO.File]::ReadAllText($savedPath) | ConvertFrom-Json
    foreach ($key in @('openai_base_url','model_provider','model_catalog_json')) { $content = Set-RootLine $content $key $null }
    foreach ($key in @('model','model_reasoning_effort')) {
        if ($saved.$key) { $value=[string]$saved.$key; if($value.StartsWith('"')) { $value=$value | ConvertFrom-Json }; $content=Set-RootString $content $key $value }
    }
    Write-Utf8File $configPath $content
}
try {
    $legacyLayout = Get-LegacyLayoutState $packageDir
    if ($legacyLayout -and $legacyLayout.pending -and @(Get-MainApp).Count -eq 0) {
        # Let the old watcher restore its journal before selecting the new paths.
        for ($n=0; $n -lt 60 -and (Test-RecordedProcess $legacyLayout.watcher); $n++) {
            if (@(Get-MainApp).Count -gt 0) { break }
            Start-Sleep -Milliseconds 200
        }
        if (@(Get-MainApp).Count -eq 0) {
            if (Test-RecordedProcess $legacyLayout.watcher) { throw '旧入口仍在恢复配置，请稍后再打开。' }
            # A crashed watcher can leave a router behind. Only recorded helpers
            # are stopped, with their PID, executable, creation time and marker checked.
            Stop-Helpers
            if (-not (Initialize-PackageLayout $packageDir)) { throw '旧版转发器仍在退出，目录迁移尚未完成，请稍后再打开。' }
            $runtimePath = Get-LauncherDataPath $packageDir 'runtime-state.json'
            $lockPath = Get-LauncherDataPath $packageDir 'launcher.lock'
        }
    }
    try { $lock = [IO.File]::Open($lockPath,'OpenOrCreate','ReadWrite','None') }
    catch { throw '另一个入口正在准备配置，请稍后再点击。' }
    $package = Get-AppxPackage -Name OpenAI.Codex | Sort-Object Version -Descending | Select-Object -First 1
    if (-not $package) { throw '未找到已安装的 ChatGPT/Codex 桌面应用。' }
    $appId = $package.PackageFamilyName + '!App'
    $running = @(Get-MainApp)
    $state = Read-LauncherState $packageDir
    $activeEntry = if ($state -and $state.active) { if ($state.entryMode) { $state.entryMode } else { 'api' } } else { 'official' }
    if ($running.Count -gt 0) {
        if ($Mode -ne $activeEntry) { throw '请先从托盘完全退出 ChatGPT，再点击另一个入口切换。' }
        & (Join-Path $env:WINDIR 'explorer.exe') "shell:AppsFolder\$appId"
        exit 0
    }
    Restore-LauncherConfig $packageDir $configPath
    Recover-OldOverrides
    Stop-Helpers
    $settings = Get-EnvValues (Get-LauncherDataPath $packageDir '.env')
    $apiKey = [string]$settings['API_KEY']
    if (-not $apiKey) { throw '.env 中缺少 API_KEY。请运行安装脚本填写。' }
    $baseUrl = Normalize-BaseUrl ([string]$settings['BASE_URL'])
    $nodePath = Join-Path $packageDir 'runtime\node.exe'
    if (-not (Test-Path -LiteralPath $nodePath)) { throw '缺少 runtime\node.exe，请使用完整安装包。' }
    $shimPath = Join-Path $packageDir 'src\shim.mjs'
    $shimPort = if ($settings['SHIM_PORT']) { [int]$settings['SHIM_PORT'] } else { 8102 }
    $shimBase = 'http://127.0.0.1:' + $shimPort + '/v1'
    $authMode = Get-LauncherRouteMode $Mode (Get-CodexHome)
    $prepared = Ensure-LocalRouter $packageDir $authMode $Mode
    Apply-LauncherConfig $packageDir $configPath $authMode $shimBase $baseUrl $Mode
    # No desktop process is running here. Match each managed conversation's
    # provider to its saved model through the native API, retaining its history/ID.
    $nativeCli = Get-NativeRepairCli $package.InstallLocation
    $repairProvider = if ($authMode -eq 'mixed') { 'chatgpt_api_mixed' } else { 'chatgpt_api_launcher' }
    if ($nativeCli) {
        $repair = & $nodePath (Join-Path $packageDir 'src\repair-thread-providers.mjs') $nativeCli (Get-CodexHome) $packageDir $repairProvider 2> (Join-Path $packageDir 'data\logs\provider-repair-stderr.log')
        if ($LASTEXITCODE -ne 0) { throw '对话的原生提供方切换未完成。聊天内容没有被重写，请查看 data\logs\provider-repair-stderr.log。' }
    } else {
        # A just-updated client populates its own executable cache on first open.
        # Never run an older binary against new sessions or copy/patch the client.
        Write-Utf8File (Join-Path $packageDir 'data\logs\provider-repair-stderr.log') 'Matching native CLI cache is not ready. Reopen the launcher after the updated client has initialized once to repair existing gateway conversations.'
    }
    $sessionStartedAt = (Read-LauncherState $packageDir).startedAt
    if($Mode -ne 'official' -and -not $prepared.gateway.ready){
        $notice = if ($authMode -eq 'mixed') { '网关目前不可用。有效缓存中的网关模型请求可能失败；已登录的官方模型仍使用官方通道。' } else { '网关目前不可用。此入口只使用网关模型，请检查网关连接。' }
        Show-Message $notice
    }
    & (Join-Path $env:WINDIR 'explorer.exe') "shell:AppsFolder\$appId"
    $main=$null
    for($n=0;$n -lt 100;$n++){ $apps=@(Get-MainApp);if($apps.Count){$main=$apps[0];break};Start-Sleep -Milliseconds 200 }
    if(-not $main){throw '客户端未能启动，已恢复原配置。'}
    $apiLaunched=$true
    $lock.Dispose();$lock=$null
    do {
        Wait-Process -Id $main.ProcessId -ErrorAction SilentlyContinue
        # The app may replace its main process while applying an update.
        Start-Sleep -Milliseconds 1200
        $main = @(Get-MainApp) | Select-Object -First 1
    } while ($main)
    for($n=0;$n -lt 50 -and -not $lock;$n++){
        try{$lock=[IO.File]::Open($lockPath,'OpenOrCreate','ReadWrite','None')}catch{Start-Sleep -Milliseconds 100}
    }
    if($lock){
        $currentState = Read-LauncherState $packageDir
        if($currentState.active -and $currentState.startedAt -eq $sessionStartedAt -and @(Get-MainApp).Count -eq 0){
            Restore-LauncherConfig $packageDir $configPath
            Stop-Helpers
        }
    }
} catch {
    $message=$_.Exception.Message
    if($apiKey){$message=$message.Replace($apiKey,'[redacted]')}
    if(-not $apiLaunched -and @(Get-MainApp).Count -eq 0){
        try{Restore-LauncherConfig $packageDir $configPath;Stop-Helpers}catch{}
    }
    Show-Message ('启动 ChatGPT 失败：'+$message)
    exit 1
} finally {
    if($lock){$lock.Dispose()}
    $apiKey=$null
}
