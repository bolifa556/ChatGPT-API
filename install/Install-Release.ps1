$ErrorActionPreference = 'Stop'
$releaseRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'Release-Core.ps1')
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$form = New-Object System.Windows.Forms.Form
$form.Text = 'ChatGPT API Launcher 安装包'
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.ClientSize = New-Object System.Drawing.Size(660, 215)
$form.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)
$label = New-Object System.Windows.Forms.Label
$label.Text = '选择安装目录；更新现有安装时，请保持原目录。'
$label.Location = New-Object System.Drawing.Point(22, 22)
$label.AutoSize = $true
$form.Controls.Add($label)
$pathBox = New-Object System.Windows.Forms.TextBox
$pathBox.Location = New-Object System.Drawing.Point(25, 56)
$pathBox.Size = New-Object System.Drawing.Size(510, 25)
$pathBox.Text = Get-ExistingLauncherDirectory
$form.Controls.Add($pathBox)
$browse = New-Object System.Windows.Forms.Button
$browse.Text = '浏览…'
$browse.Location = New-Object System.Drawing.Point(548, 54)
$browse.Size = New-Object System.Drawing.Size(86, 28)
$browse.Add_Click({
    $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
    $dialog.Description = '选择独立的程序安装目录'
    if (Test-Path -LiteralPath $pathBox.Text -PathType Container) { $dialog.SelectedPath = $pathBox.Text }
    try { if ($dialog.ShowDialog() -eq 'OK') { $pathBox.Text = $dialog.SelectedPath } } finally { $dialog.Dispose() }
})
$form.Controls.Add($browse)
$hint = New-Object System.Windows.Forms.Label
$hint.Text = '运行依赖已随包提供。程序复制完成后，将打开 API 配置界面。'
$hint.Location = New-Object System.Drawing.Point(25, 101)
$hint.AutoSize = $true
$form.Controls.Add($hint)
$status = New-Object System.Windows.Forms.Label
$status.Location = New-Object System.Drawing.Point(25, 160)
$status.Size = New-Object System.Drawing.Size(450, 35)
$form.Controls.Add($status)
$install = New-Object System.Windows.Forms.Button
$install.Text = '安装并配置'
$install.Location = New-Object System.Drawing.Point(514, 156)
$install.Size = New-Object System.Drawing.Size(120, 32)
$form.Controls.Add($install)
$form.AcceptButton = $install
$install.Add_Click({
    $install.Enabled = $false
    try {
        if (-not (Get-AppxPackage -Name OpenAI.Codex | Select-Object -First 1)) {
            throw '请先安装官方 ChatGPT/Codex 桌面应用，再运行此安装包。'
        }
        $status.Text = '正在校验并安装程序文件…'
        $form.Refresh()
        $destination = Copy-ReleasePayload $releaseRoot $pathBox.Text.Trim()
        $form.Hide()
        & (Join-Path $destination 'install\Install-ChatGPT.ps1')
        $form.Close()
    } catch {
        $form.Show()
        $status.Text = '安装未完成'
        [void][System.Windows.Forms.MessageBox]::Show($_.Exception.Message, '安装未完成', 'OK', 'Error')
    } finally { $install.Enabled = $true }
})
[void]$form.ShowDialog()
