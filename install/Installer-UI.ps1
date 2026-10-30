Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[Windows.Forms.Application]::EnableVisualStyles()

function New-InstallerWindow([string]$title, [string]$step, [int]$height = 390) {
    $form = New-Object Windows.Forms.Form
    $form.Text = $title; $form.StartPosition = 'CenterScreen'
    $form.FormBorderStyle = 'FixedDialog'
    $form.MaximizeBox = $false; $form.MinimizeBox = $false
    $form.ClientSize = New-Object Drawing.Size(620, $height)
    $form.Font = New-Object Drawing.Font('Microsoft YaHei UI', 9.5)
    $form.BackColor = [Drawing.Color]::White
    $form.ForeColor = [Drawing.ColorTranslator]::FromHtml('#242424')
    $form.AutoScaleMode = 'Font'
    $icon = Join-Path (Split-Path -Parent $PSScriptRoot) 'assets\ChatGPT.ico'
    if (-not (Test-Path -LiteralPath $icon)) { $icon = Join-Path (Split-Path -Parent $PSScriptRoot) 'payload\assets\ChatGPT.ico' }
    if (Test-Path -LiteralPath $icon) { $form.Icon = New-Object Drawing.Icon($icon) }
    $heading = New-InstallerLabel $form 'ChatGPT API' 26 22 300 26
    $heading.Font = New-Object Drawing.Font('Microsoft YaHei UI', 11, [Drawing.FontStyle]::Bold)
    $progress = New-InstallerLabel $form $step 346 25 248 22 -Muted
    $progress.TextAlign = 'TopRight'
    foreach ($y in @(65, ($height - 72))) {
        $line = New-Object Windows.Forms.Panel
        $line.BackColor = [Drawing.ColorTranslator]::FromHtml('#E8E8E8')
        $line.Location = New-Object Drawing.Point(0, $y)
        $line.Size = New-Object Drawing.Size(620, 1)
        $form.Controls.Add($line)
    }
    return $form
}
function New-InstallerLabel($parent, [string]$text, [int]$x, [int]$y, [int]$width, [int]$height = 24, [switch]$Muted) {
    $control = New-Object Windows.Forms.Label
    $control.Text = $text; $control.Location = New-Object Drawing.Point($x, $y)
    $control.Size = New-Object Drawing.Size($width, $height)
    if ($Muted) { $control.ForeColor = [Drawing.ColorTranslator]::FromHtml('#707070') }
    $parent.Controls.Add($control)
    return $control
}
function New-InstallerInput($parent, [string]$name, [int]$x, [int]$y, [int]$width) {
    $control = New-Object Windows.Forms.TextBox
    $control.Name = $name; $control.AccessibleName = $name
    $control.Location = New-Object Drawing.Point($x, $y)
    $control.AutoSize = $false; $control.Size = New-Object Drawing.Size($width, 32)
    $control.BorderStyle = 'FixedSingle'; $control.BackColor = [Drawing.Color]::White
    $parent.Controls.Add($control)
    return $control
}
function New-InstallerButton($parent, [string]$text, [int]$x, [int]$y, [int]$width, [switch]$Primary) {
    $control = New-Object Windows.Forms.Button
    $control.Text = $text; $control.AccessibleName = $text; $control.UseMnemonic = $false
    $control.Location = New-Object Drawing.Point($x, $y)
    $control.Size = New-Object Drawing.Size($width, 34)
    $control.FlatStyle = 'Flat'; $control.UseVisualStyleBackColor = $false
    $control.FlatAppearance.BorderSize = 1
    $control.FlatAppearance.BorderColor = [Drawing.ColorTranslator]::FromHtml('#DCDCDC')
    $control.BackColor = [Drawing.Color]::White
    if ($Primary) {
        $control.BackColor = [Drawing.ColorTranslator]::FromHtml('#242424')
        $control.ForeColor = [Drawing.Color]::White
        $control.FlatAppearance.BorderColor = $control.BackColor
        $control.FlatAppearance.MouseOverBackColor = [Drawing.ColorTranslator]::FromHtml('#424242')
    }
    $parent.Controls.Add($control)
    return $control
}
function Set-InstallerStatus($control, [string]$message, [switch]$ErrorState) {
    $control.Text = $message
    $control.ForeColor = if ($ErrorState) { [Drawing.ColorTranslator]::FromHtml('#B42318') } else { [Drawing.ColorTranslator]::FromHtml('#707070') }
    $control.FindForm().Refresh()
}
