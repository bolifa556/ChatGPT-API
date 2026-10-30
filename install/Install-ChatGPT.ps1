$ErrorActionPreference = 'Stop'
$packageDir = Split-Path -Parent $PSScriptRoot
. (Join-Path $packageDir 'src\Common.ps1')
. (Join-Path $packageDir 'src\Package-Paths.ps1')
. (Join-Path $packageDir 'src\Launcher-State.ps1')
. (Join-Path $PSScriptRoot 'Install-Core.ps1')
. (Join-Path $PSScriptRoot 'Bootstrap-Runtime.ps1')
. (Join-Path $PSScriptRoot 'Installer-UI.ps1')
$null = Initialize-PackageLayout $packageDir
$existing = @{}
try { $existing = Get-UserApiSettings $packageDir } catch { }
$form = New-InstallerWindow 'ChatGPT API 安装' '2 / 2 · API 设置' 398
$form.Tag = @{ complete = $false }
$intro = New-InstallerLabel $form '填写 API，或跳过并在安装后通过控制台配置。' 26 85 568 24
$urlLabel = New-InstallerLabel $form 'API 地址' 26 124 568 22
$urlBox = New-InstallerInput $form 'API 地址' 26 150 568
$urlBox.Text = [string]$existing['BASE_URL']
$keyText = if ($existing['API_KEY']) { 'API Key（留空保留已保存的密钥）' } else { 'API Key' }
$keyLabel = New-InstallerLabel $form $keyText 26 199 450 22
$keyBox = New-InstallerInput $form 'API Key' 26 225 568
$keyBox.UseSystemPasswordChar = $true
$showKey = New-Object Windows.Forms.CheckBox
$showKey.Text = '显示'; $showKey.AutoSize = $true
$showKey.Location = New-Object Drawing.Point(536, 198)
$showKey.Add_CheckedChanged({ $keyBox.UseSystemPasswordChar = -not $showKey.Checked })
$form.Controls.Add($showKey)
$status = New-InstallerLabel $form '地址省略 /v1 时自动补齐。Key 保存在本机安装目录。' 26 279 568 34 -Muted
$skip = New-InstallerButton $form '跳过，稍后配置' 26 346 160
$install = New-InstallerButton $form '安装并配置' 462 346 132 -Primary
$form.AcceptButton = $install
function Complete-Installation([bool]$skipApi) {
    $install.Enabled = $false; $skip.Enabled = $false
    $apiKey = $null
    try {
        if (-not (Get-AppxPackage -Name OpenAI.Codex | Select-Object -First 1)) { throw '请先安装官方 ChatGPT/Codex 桌面应用。' }
        $baseUrl = ''
        if (-not $skipApi) {
            if (-not $urlBox.Text.Trim()) { throw '请输入 API 地址，或选择“跳过，稍后配置”。' }
            $baseUrl = Normalize-BaseUrl $urlBox.Text
            $apiKey = $keyBox.Text.Trim()
            if (-not $apiKey) { $apiKey = [string]$existing['API_KEY'] }
            if (-not $apiKey -or $apiKey -match '[\r\n]') { throw '请输入 API Key，或选择“跳过，稍后配置”。' }
        }
        Set-InstallerStatus $status '正在准备运行环境…'
        Ensure-LauncherRuntime $packageDir
        if ($skipApi) { Initialize-DeferredLauncherSettings $packageDir }
        else { Set-LauncherSettings $packageDir $baseUrl $apiKey }
        $desktop = [Environment]::GetFolderPath('DesktopDirectory')
        if (-not $desktop) { throw '找不到当前用户的桌面目录。' }
        Set-DesktopEntries $packageDir $desktop
        $keyBox.Clear()
        foreach ($control in @($intro,$urlLabel,$urlBox,$keyLabel,$keyBox,$showKey,$skip)) { $control.Visible = $false }
        [void](New-InstallerLabel $form '安装完成' 26 95 568 28)
        [void](New-InstallerLabel $form '桌面入口：ChatGPT、chatgpt-api、chatgpt-apionly' 26 139 568 28)
        [void](New-InstallerLabel $form '调整 API 和模型：打开安装目录中的“控制台”。' 26 181 568 28 -Muted)
        $message = if ($skipApi) { '已跳过 API 配置，原有设置保持不变。' } else { '设置已保存。启动 API 入口时会获取模型目录。' }
        Set-InstallerStatus $status $message
        $form.Tag.complete = $true
        $install.Text = '完成'; $install.AccessibleName = '完成'; $install.Enabled = $true
    } catch {
        $message = $_.Exception.Message
        if ($apiKey) { $message = $message.Replace($apiKey, '[redacted]') }
        Set-InstallerStatus $status $message -ErrorState
        $install.Enabled = $true; $skip.Enabled = $true
    } finally { $apiKey = $null }
}
$skip.Add_Click({ Complete-Installation $true })
$install.Add_Click({ if ($form.Tag.complete) { $form.Close() } else { Complete-Installation $false } })
try { [void]$form.ShowDialog() }
finally { $keyBox.Clear(); $form.Dispose() }
