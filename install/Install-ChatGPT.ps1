$ErrorActionPreference = 'Stop'
$packageDir = Split-Path -Parent $PSScriptRoot
. (Join-Path $packageDir 'src\Common.ps1')
. (Join-Path $packageDir 'src\Package-Paths.ps1')
. (Join-Path $packageDir 'src\Launcher-State.ps1')
. (Join-Path $PSScriptRoot 'Install-Core.ps1')
. (Join-Path $PSScriptRoot 'Bootstrap-Runtime.ps1')
$null = Initialize-PackageLayout $packageDir

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$form = New-Object System.Windows.Forms.Form
$form.Text = 'ChatGPT 三入口安装'
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.ClientSize = New-Object System.Drawing.Size(590, 270)
$form.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)

$titleLabel = New-Object System.Windows.Forms.Label
$titleLabel.Text = '配置自定义 API'
$titleLabel.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 13, [System.Drawing.FontStyle]::Bold)
$titleLabel.Location = New-Object System.Drawing.Point(22, 16)
$titleLabel.AutoSize = $true
$form.Controls.Add($titleLabel)

$urlLabel = New-Object System.Windows.Forms.Label
$urlLabel.Text = 'API 基础 URL（OpenAI Responses 兼容接口）'
$urlLabel.Location = New-Object System.Drawing.Point(24, 57)
$urlLabel.AutoSize = $true
$form.Controls.Add($urlLabel)

$urlBox = New-Object System.Windows.Forms.TextBox
$urlBox.Location = New-Object System.Drawing.Point(25, 79)
$urlBox.Size = New-Object System.Drawing.Size(540, 25)
$form.Controls.Add($urlBox)

$urlHint = New-Object System.Windows.Forms.Label
$urlHint.Text = '支持 http:// 或 https://；未写 /v1 时自动补上。'
$urlHint.ForeColor = [System.Drawing.Color]::DimGray
$urlHint.Location = New-Object System.Drawing.Point(26, 108)
$urlHint.AutoSize = $true
$form.Controls.Add($urlHint)

$keyLabel = New-Object System.Windows.Forms.Label
$keyLabel.Text = 'API Key'
$keyLabel.Location = New-Object System.Drawing.Point(24, 136)
$keyLabel.AutoSize = $true
$form.Controls.Add($keyLabel)

$keyBox = New-Object System.Windows.Forms.TextBox
$keyBox.Location = New-Object System.Drawing.Point(25, 158)
$keyBox.Size = New-Object System.Drawing.Size(540, 25)
$keyBox.UseSystemPasswordChar = $true
$form.Controls.Add($keyBox)

$noticeLabel = New-Object System.Windows.Forms.Label
$noticeLabel.Text = '密钥会以明文保存在本文件夹的 data\.env 中。请勿公开分享安装后的文件夹。'
$noticeLabel.ForeColor = [System.Drawing.Color]::DimGray
$noticeLabel.Location = New-Object System.Drawing.Point(26, 189)
$noticeLabel.AutoSize = $true
$form.Controls.Add($noticeLabel)

$statusLabel = New-Object System.Windows.Forms.Label
$statusLabel.Text = ''
$statusLabel.Location = New-Object System.Drawing.Point(24, 229)
$statusLabel.Size = New-Object System.Drawing.Size(355, 20)
$form.Controls.Add($statusLabel)

$installButton = New-Object System.Windows.Forms.Button
$installButton.Text = '安装 / 更新'
$installButton.Location = New-Object System.Drawing.Point(464, 222)
$installButton.Size = New-Object System.Drawing.Size(100, 30)
$form.Controls.Add($installButton)
$form.AcceptButton = $installButton

$envPath = Get-LauncherDataPath $packageDir '.env'
if (Test-Path -LiteralPath $envPath) {
    try {
        $existing = Get-EnvValues $envPath
        $urlBox.Text = [string]$existing['BASE_URL']
        $keyBox.Text = [string]$existing['API_KEY']
    } catch {
        # The form still opens so the user can replace an invalid .env.
    }
}

$installButton.Add_Click({
    $installButton.Enabled = $false
    $statusLabel.Text = '正在安装…'
    $form.Refresh()
    $apiKey = $null
    try {
        $baseUrl = Normalize-BaseUrl $urlBox.Text
        $apiKey = $keyBox.Text.Trim()
        if (-not $apiKey -or $apiKey.Contains("`r") -or $apiKey.Contains("`n")) {
            throw '请输入有效的 API Key。'
        }
        $package = Get-AppxPackage -Name OpenAI.Codex | Select-Object -First 1
        if (-not $package) { throw '未找到已安装的 ChatGPT/Codex 桌面应用。' }
        $statusLabel.Text = '正在准备运行环境…'
        $form.Refresh()
        Ensure-LauncherRuntime $packageDir
        Set-LauncherSettings $packageDir $baseUrl $apiKey

        $catalogNotice = ''
        try {
            $statusLabel.Text = '正在获取模型列表…'
            $form.Refresh()
            # The launcher performs an authenticated refresh at every cold start.
            # Reuse the existing cache here; do not create a different catalog policy.
            [void](Get-GatewayModelIds $baseUrl $apiKey)
        } catch {
            $catalogNotice = "`r`n`r`n当前未能获取模型列表；首次打开 chatgpt-api 时会重试。"
        }

        $desktopDir = [Environment]::GetFolderPath('DesktopDirectory')
        if (-not $desktopDir) { throw '找不到当前用户的桌面目录。' }
        Set-DesktopEntries $packageDir $desktopDir

        $statusLabel.Text = '安装完成'
        [void][System.Windows.Forms.MessageBox]::Show(
            '已在桌面生成 ChatGPT、chatgpt-api 和 chatgpt-apionly 三个快捷方式。' +
            "`r`n切换入口前，请先完全退出 ChatGPT。" + $catalogNotice,
            '安装完成', 'OK', 'Information')
        $form.Close()
    } catch {
        $errorMessage = $_.Exception.Message
        if ($apiKey) { $errorMessage = $errorMessage.Replace($apiKey, '[redacted]') }
        $statusLabel.Text = '安装失败'
        [void][System.Windows.Forms.MessageBox]::Show($errorMessage, '安装失败', 'OK', 'Error')
    } finally {
        $apiKey = $null
        $installButton.Enabled = $true
    }
})

[void]$form.ShowDialog()
