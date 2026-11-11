param([Parameter(Mandatory=$true)][ValidateSet('official','api','apionly')][string]$Mode)
$ErrorActionPreference = 'Stop'
$env:CHATGPT_API_LAUNCH_STARTED_AT = [DateTime]::UtcNow.ToString('o')
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
    $recoveryFile = Get-RecoveryPath $packageDir
    if (Test-Path -LiteralPath $recoveryFile) {
        $recorded = (Read-LauncherText $recoveryFile) | ConvertFrom-Json
        if ($recorded.client) {
            if (Test-RecordedProcess $recorded.client) {
                return @(Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$recorded.client.pid))
            }
        }
    }
    return @(Get-CimInstance Win32_Process -Filter "name='ChatGPT.exe'" -ErrorAction SilentlyContinue | Where-Object {
        $_.CommandLine -and $_.CommandLine -notmatch '--type=' -and
        (-not $env:CODEX_ELECTRON_USER_DATA_PATH -or ($_.CommandLine.Contains('--user-data-dir=') -and $_.CommandLine.Contains($env:CODEX_ELECTRON_USER_DATA_PATH)))
    })
}
function Stop-Helpers {
    Stop-LauncherRecordedHelpers $packageDir
}

try {
    Wait-ClosingLauncherSession $packageDir
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
        if ($Mode -ne $activeEntry) {
            # A hidden window can still own native background work or an update.
            # Wait for the real process exit; never infer it from a window handle.
            throw '请先完全退出当前 ChatGPT，再点击另一个入口切换。'
        }
    }
    if ($running.Count -gt 0) {
        if ($env:CODEX_ELECTRON_USER_DATA_PATH) {
            Start-Process -FilePath (Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\chatgpt-desktop.exe') -ArgumentList ('--user-data-dir="' + $env:CODEX_ELECTRON_USER_DATA_PATH + '"') -WindowStyle Hidden
        } else { & (Join-Path $env:WINDIR 'explorer.exe') "shell:AppsFolder\$appId" }
        exit 0
    }
    Initialize-DeferredLauncherSettings $packageDir
    Restore-LauncherConfig $packageDir $configPath
    Stop-Helpers
    if ($Mode -ne 'official') { Assert-LauncherApiConfigured $packageDir }
    $nodePath = Join-Path $packageDir 'runtime\node.exe'
    if (-not (Test-Path -LiteralPath $nodePath)) { throw '缺少 runtime\node.exe，请使用完整安装包。' }
    $shimPath = Join-Path $packageDir 'src\shim.mjs'
    $authMode = Get-LauncherRouteMode $Mode (Get-CodexHome)
    if ($Mode -eq 'official') { $prepared = Ensure-LocalRouter $packageDir $authMode $Mode -PrepareOnly }
    else {
        $prepared = Invoke-GatewayPreparation { Ensure-LocalRouter $packageDir $authMode $Mode -PrepareOnly } { Show-ApiSettings $packageDir } {
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
    $nativeAlias = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\chatgpt-desktop.exe'
    if (-not (Test-Path -LiteralPath $nativeAlias)) { $nativeAlias = Join-Path $package.InstallLocation 'app\ChatGPT.exe' }
    $sessionState = Join-Path $packageDir 'data\state\native-session.json'
    $sessionLog = Join-Path $packageDir 'data\logs\native-session-stderr.log'
    $sessionScript = Join-Path $packageDir 'src\native-session.mjs'
    $starting = @{session=$recoverySession;entryMode=$Mode;ready=$false;stopped=$false;phase='controller';startedAt=[DateTime]::UtcNow.ToString('o')}
    Write-LauncherFile $sessionState ($starting | ConvertTo-Json)
    $starting.phase = if ($Mode -eq 'official') { 'disabled' } else { 'waiting' }
    Write-LauncherFile (Join-Path $packageDir 'data\state\native-quota.json') ($starting | ConvertTo-Json)
    $arguments = @((Join-Path $packageDir 'src\Recover-ChatGPT.vbs'),(Get-CodexHome),$nativeAlias,(Join-Path $package.InstallLocation 'app\resources\app.asar'),$Mode,$recoverySession) | ForEach-Object { '"' + $_ + '"' }
    $controller = Start-Process -FilePath (Join-Path $env:WINDIR 'System32\wscript.exe') -ArgumentList $arguments -WindowStyle Hidden -PassThru
    Set-LauncherRecoveryOwner $packageDir $recoverySession $controller.Id
    $null = Wait-LauncherNativeClient $packageDir $recoverySession $controller
    $apiLaunched=$true
    $lock.Dispose();$lock=$null
    # The script host waits on the controller's exit handle and owns crash
    # recovery. Release startup PowerShell and its loaded modules.
    exit 0
} catch {
    $message=$_.Exception.Message
    if($apiKey){$message=$message.Replace($apiKey,'[redacted]')}
    if ($apiLaunched) {
        Add-Content -LiteralPath (Join-Path $packageDir 'data\logs\recovery.log') -Value ([DateTime]::UtcNow.ToString('o') + ' ' + $message)
        exit 1
    }
    if (-not $apiLaunched -and $lock -and $recoverySession) {
        try {
            $recovery = (Read-LauncherText (Get-RecoveryPath $packageDir)) | ConvertFrom-Json
            if ($recovery.sessionId -eq $recoverySession) {
                # Recover an early PID even if the controller exited before
                # the readiness loop recorded its process identity.
                if (-not $recovery.client -and $sessionState -and (Test-Path -LiteralPath $sessionState)) {
                    $native = (Read-LauncherText $sessionState) | ConvertFrom-Json
                    if ($native.session -eq $recoverySession -and $native.pid) {
                        $candidate = Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$native.pid) -ErrorAction SilentlyContinue
                        if ($candidate -and $candidate.ParentProcessId -eq $native.controllerPid) {
                            Set-LauncherRecoveryClient $packageDir $recoverySession $candidate
                            $recovery = (Read-LauncherText (Get-RecoveryPath $packageDir)) | ConvertFrom-Json
                        }
                    }
                }
                Stop-Helpers
                Stop-LauncherRecoveryClient $recovery.client
                $lock.Dispose(); $lock = $null
                & (Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe') -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $packageDir 'src\Recover-ChatGPT.ps1') -Immediate -Session $recoverySession
                if ($LASTEXITCODE -ne 0) { throw '配置恢复尚未完成，请查看 data\logs\recovery.log。' }
            }
        } catch {
            $message += [Environment]::NewLine + $_.Exception.Message
            Add-Content -LiteralPath (Join-Path $packageDir 'data\logs\recovery.log') -Value ([DateTime]::UtcNow.ToString('o') + ' ' + $_.Exception.Message)
        }
    }
    Show-Message ('启动 ChatGPT 失败：'+$message)
    exit 1
} finally {
    if($lock){$lock.Dispose()}
    $apiKey=$null
}
