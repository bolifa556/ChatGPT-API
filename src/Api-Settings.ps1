function Show-ApiSettings([string]$packageDir) {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    $current = Get-UserApiSettings $packageDir
    $form = New-Object Windows.Forms.Form
    $form.Text = 'ChatGPT API 设置'
    $form.StartPosition = 'CenterScreen'
    $form.FormBorderStyle = 'FixedDialog'
    $form.MaximizeBox = $false; $form.MinimizeBox = $false
    $form.ClientSize = New-Object Drawing.Size(560, 245)
    $form.Font = New-Object Drawing.Font('Microsoft YaHei UI', 9)
    $notice = New-Object Windows.Forms.Label
    $notice.Text = '当前自定义 API 不可用。完成以更新配置；取消保留原 URL 和 Key。'
    $notice.Location = New-Object Drawing.Point(18, 15); $notice.AutoSize = $true
    $form.Controls.Add($notice)
    $urlLabel = New-Object Windows.Forms.Label
    $urlLabel.Text = 'API 基础 URL'; $urlLabel.Location = New-Object Drawing.Point(18, 50); $urlLabel.AutoSize = $true
    $form.Controls.Add($urlLabel)
    $urlBox = New-Object Windows.Forms.TextBox
    $urlBox.Location = New-Object Drawing.Point(18, 74); $urlBox.Size = New-Object Drawing.Size(522, 25)
    $urlBox.Text = [string]$current['BASE_URL']; $form.Controls.Add($urlBox)
    $keyLabel = New-Object Windows.Forms.Label
    $keyLabel.Text = 'API Key（留空保留原密钥）'; $keyLabel.Location = New-Object Drawing.Point(18, 111); $keyLabel.AutoSize = $true
    $form.Controls.Add($keyLabel)
    $keyBox = New-Object Windows.Forms.TextBox
    $keyBox.Location = New-Object Drawing.Point(18, 136); $keyBox.Size = New-Object Drawing.Size(522, 25)
    $keyBox.UseSystemPasswordChar = $true; $form.Controls.Add($keyBox)
    $cancel = New-Object Windows.Forms.Button
    $cancel.Text = '取消'; $cancel.Location = New-Object Drawing.Point(334, 194)
    $cancel.Size = New-Object Drawing.Size(96, 30); $cancel.DialogResult = 'Cancel'; $form.Controls.Add($cancel)
    $save = New-Object Windows.Forms.Button
    $save.Text = '完成'; $save.Location = New-Object Drawing.Point(444, 194)
    $save.Size = New-Object Drawing.Size(96, 30); $form.Controls.Add($save)
    $form.AcceptButton = $save; $form.CancelButton = $cancel
    $save.Add_Click({
        try {
            $base = Normalize-BaseUrl $urlBox.Text
            $key = $keyBox.Text.Trim(); if (-not $key) { $key = [string]$current['API_KEY'] }
            if (-not $key -or $key -match '[\r\n]') { throw '请输入有效的 API Key。' }
            $form.Tag = @{ base = $base; key = $key }
            $form.DialogResult = 'OK'; $form.Close()
        } catch { [void][Windows.Forms.MessageBox]::Show($_.Exception.Message, '配置错误') }
    })
    try { if ($form.ShowDialog() -eq 'OK') { return $form.Tag }; return $null }
    finally { $keyBox.Clear(); $form.Dispose() }
}
function Invoke-GatewayPreparation([scriptblock]$prepare, [scriptblock]$request, [scriptblock]$save) {
    $ready = $null; $failure = $null
    try { $ready = & $prepare } catch {
        if ($_.Exception.Message -notmatch '\[gateway_unavailable\]|API_KEY is missing|BASE_URL or API_KEY is missing|Enter an http:// or https://') { throw }
        $failure = $_
    }
    if (-not $failure -and ($null -eq $ready.gateway -or $ready.gateway.ready)) { return $ready }
    $values = & $request
    if ($values) { & $save $values; return (& $prepare) }
    if ($failure) { throw $failure }
    return $ready
}
