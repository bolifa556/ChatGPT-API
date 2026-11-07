param([Parameter(Mandatory=$true)][ValidateSet('official','api','apionly')][string]$Mode)
$ErrorActionPreference = 'Stop'
$packageDir = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $packageDir 'src\Common.ps1')
. (Join-Path $packageDir 'src\Package-Paths.ps1')
. (Join-Path $packageDir 'src\Launcher-State.ps1')
. (Join-Path $packageDir 'src\Recovery-Control.ps1')
. (Join-Path $packageDir 'src\Router-Control.ps1')
. (Join-Path $packageDir 'src\Api-Settings.ps1')
. (Join-Path $packageDir 'install\Install-Core.ps1')
$null = Initialize-PackageLayout $packageDir
$configPath = Join-Path (Get-CodexHome) 'config.toml'
$lockPath = Get-LauncherDataPath $packageDir 'launcher.lock'
$lock = $null
$apiLaunched = $false
$apiKey = ''
$recoverySession = ''
function Show-Message([string]$message) {
    Add-Type -AssemblyName System.Windows.Forms
    [void][System.Windows.Forms.MessageBox]::Show($message,'ChatGPT 启动器')
}
function Get-MainApp {
    return @(Get-CimInstance Win32_Process -Filter "name='ChatGPT.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -and $_.CommandLine -notmatch '--type=' })
}
function Stop-Helpers {
    Stop-LauncherRecordedHelpers $packageDir
}
function Recover-OldOverrides { Repair-LegacyLauncherConfig $packageDir $configPath }

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
    if ($Mode -ne 'official') { Assert-LauncherApiConfigured $packageDir }
    Initialize-DeferredLauncherSettings $packageDir
    Restore-LauncherConfig $packageDir $configPath
    Recover-OldOverrides
    Stop-Helpers
    $nodePath = Join-Path $packageDir 'runtime\node.exe'
    if (-not (Test-Path -LiteralPath $nodePath)) { throw '缺少 runtime\node.exe，请使用完整安装包。' }
    $shimPath = Join-Path $packageDir 'src\shim.mjs'
    $authMode = Get-LauncherRouteMode $Mode (Get-CodexHome)
    if ($Mode -eq 'official') { $prepared = Ensure-LocalRouter $packageDir $authMode $Mode }
    else {
        $prepared = Invoke-GatewayPreparation { Ensure-LocalRouter $packageDir $authMode $Mode } { Show-ApiSettings $packageDir } {
            param($values)
            Stop-Helpers
            Set-LauncherSettings $packageDir $values.base $values.key
        }
    }
    $settings = Get-EnvValues (Get-LauncherDataPath $packageDir '.env')
    $apiKey = [string]$settings['API_KEY']
    $baseUrl = if ($settings['BASE_URL']) { Normalize-BaseUrl ([string]$settings['BASE_URL']) } else { '' }
    $shimPort = if ($settings['SHIM_PORT']) { [int]$settings['SHIM_PORT'] } else { 8102 }
    $shimBase = 'http://127.0.0.1:' + $shimPort + '/v1'
    $recoverySession = Register-LauncherRecovery $packageDir $configPath
    if ($Mode -eq 'apionly' -or $authMode -eq 'gateway') {
        & $nodePath (Join-Path $packageDir 'src\desktop-state.mjs') 'begin' (Get-CodexHome) $packageDir
        if ($LASTEXITCODE -ne 0) { throw '桌面项目配置兼容准备失败。' }
    }
    Apply-LauncherConfig $packageDir $configPath $authMode $shimBase $baseUrl $Mode
    $repair = & $nodePath (Join-Path $packageDir 'src\repair-thread-providers.mjs') 'begin' (Get-CodexHome) $packageDir 2> (Join-Path $packageDir 'data\logs\provider-repair-stderr.log')
    if ($LASTEXITCODE -ne 0) { throw '对话兼容准备未完成，请查看 data\logs\provider-repair-stderr.log。' }
    $sessionStartedAt = (Read-LauncherState $packageDir).startedAt
    if($Mode -ne 'official' -and -not $prepared.gateway.ready){
        $notice = if ($authMode -eq 'mixed') { '网关目前不可用。有效缓存中的网关模型请求可能失败；已登录的官方模型仍使用官方通道。' } else { '网关目前不可用。此入口只使用网关模型，请检查网关连接。' }
        Show-Message $notice
    }
    if ($Mode -ne 'official') {
        $quotaState = Join-Path $packageDir 'data\state\native-quota.json'
        if (Test-Path -LiteralPath $quotaState) { Remove-Item -LiteralPath $quotaState }
        $nativeAlias = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\chatgpt-desktop.exe'
        if (-not (Test-Path -LiteralPath $nativeAlias)) { $nativeAlias = Join-Path $package.InstallLocation 'app\ChatGPT.exe' }
        $quotaScript = Join-Path $packageDir 'src\native-quota.mjs'
        $arguments = @($quotaScript,$nativeAlias,(Join-Path $package.InstallLocation 'app\resources\app.asar'),$packageDir,(Get-CodexHome)) | ForEach-Object { '"' + $_ + '"' }
        $quotaHelper = Start-Process -FilePath $nodePath -ArgumentList $arguments -WindowStyle Hidden -PassThru -RedirectStandardError (Join-Path $packageDir 'data\logs\quota-stderr.log')
        Add-RouterHelper $packageDir $quotaHelper $quotaScript
        $quotaReady = $false
        for ($n=0; $n -lt 400; $n++) {
            $quotaHelper.Refresh()
            if ($quotaHelper.HasExited) { throw ('额度兼容准备失败：' + [IO.File]::ReadAllText((Join-Path $packageDir 'data\logs\quota-stderr.log'))) }
            if (Test-Path -LiteralPath $quotaState) {
                $quota = [IO.File]::ReadAllText($quotaState) | ConvertFrom-Json
                if ($quota.ready) { $quotaReady = $true; break }
            }
            Start-Sleep -Milliseconds 100
        }
        if (-not $quotaReady) { throw '额度兼容准备未完成，请查看 data\logs\quota-stderr.log。' }
    } else {
        & (Join-Path $env:WINDIR 'explorer.exe') "shell:AppsFolder\$appId"
    }
    $main=$null
    for($n=0;$n -lt 100;$n++){ $apps=@(Get-MainApp);if($apps.Count){$main=$apps[0];break};Start-Sleep -Milliseconds 200 }
    if(-not $main){throw '客户端未能启动，已恢复原配置。'}
    Set-LauncherRecoveryClient $packageDir $recoverySession $main
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
            Unregister-LauncherRecovery $packageDir $recoverySession
        }
    }
} catch {
    $message=$_.Exception.Message
    if($apiKey){$message=$message.Replace($apiKey,'[redacted]')}
    if ($apiLaunched) {
        Add-Content -LiteralPath (Join-Path $packageDir 'data\logs\recovery.log') -Value ([DateTime]::UtcNow.ToString('o') + ' ' + $message)
        exit 1
    }
    if(-not $apiLaunched -and @(Get-MainApp).Count -eq 0){
        try{Restore-LauncherConfig $packageDir $configPath;Stop-Helpers;if($recoverySession){Unregister-LauncherRecovery $packageDir $recoverySession}}catch{}
    }
    Show-Message ('启动 ChatGPT 失败：'+$message)
    exit 1
} finally {
    if($lock){$lock.Dispose()}
    $apiKey=$null
}
