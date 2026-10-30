$ErrorActionPreference = 'Stop'
$releaseRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'Release-Core.ps1')
. (Join-Path $PSScriptRoot 'Installer-UI.ps1')
$form = New-InstallerWindow 'ChatGPT API 安装' '1 / 2 · 安装位置' 316
[void](New-InstallerLabel $form '安装目录' 26 91 568 24)
$pathBox = New-InstallerInput $form '安装目录' 26 121 458
$pathBox.Text = Get-ExistingLauncherDirectory
$browse = New-InstallerButton $form '浏览…' 496 120 98
$browse.Add_Click({
    $dialog = New-Object Windows.Forms.FolderBrowserDialog
    $dialog.Description = '选择程序安装目录'
    if (Test-Path -LiteralPath $pathBox.Text -PathType Container) { $dialog.SelectedPath = $pathBox.Text }
    try { if ($dialog.ShowDialog() -eq 'OK') { $pathBox.Text = $dialog.SelectedPath } }
    finally { $dialog.Dispose() }
})
[void](New-InstallerLabel $form '更新请选择原目录，已有 API 设置会保留。' 26 169 568 24 -Muted)
$status = New-InstallerLabel $form '' 26 205 568 32 -Muted
$cancel = New-InstallerButton $form '取消' 348 264 108
$cancel.DialogResult = 'Cancel'; $form.CancelButton = $cancel
$install = New-InstallerButton $form '下一步' 470 264 124 -Primary
$form.AcceptButton = $install
$install.Add_Click({
    $install.Enabled = $false; $browse.Enabled = $false; $cancel.Enabled = $false
    try {
        if (-not (Get-AppxPackage -Name OpenAI.Codex | Select-Object -First 1)) { throw '请先安装官方 ChatGPT/Codex 桌面应用。' }
        Set-InstallerStatus $status '正在安装程序文件…'
        $destination = Copy-ReleasePayload $releaseRoot $pathBox.Text.Trim()
        $form.Hide()
        & (Join-Path $destination 'install\Install-ChatGPT.ps1')
        $form.Close()
    } catch {
        $form.Show()
        Set-InstallerStatus $status $_.Exception.Message -ErrorState
    } finally { $install.Enabled = $true; $browse.Enabled = $true; $cancel.Enabled = $true }
})
try { [void]$form.ShowDialog() } finally { $form.Dispose() }
