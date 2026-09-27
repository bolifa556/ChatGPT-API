function Set-LauncherSettings([string]$packageDir, [string]$baseUrl, [string]$apiKey) {
    $baseUrl = Normalize-BaseUrl $baseUrl
    $apiKey = $apiKey.Trim()
    if (-not $apiKey -or $apiKey -match '[\r\n]') { throw '请输入有效的 API Key。' }
    $path = Get-LauncherDataPath $packageDir '.env'
    $current = if (Test-Path -LiteralPath $path) { Get-EnvValues $path } else { @{} }
    $old = Get-LegacyLayoutState $packageDir
    $active = Read-LauncherState $packageDir
    if (($active -and $active.active) -or ($old -and $old.pending)) {
        if ($current['BASE_URL'] -ne $baseUrl -or $current['API_KEY'] -cne $apiKey) {
            throw '客户端仍在使用当前 API 配置，请先从托盘完全退出，再更换 URL 或密钥。'
        }
    }
    # Preserve optional settings, comments and unknown fields during reinstall.
    $text = if (Test-Path -LiteralPath $path) { [IO.File]::ReadAllText($path) } else { '' }
    $defaults = [ordered]@{ BASE_URL=$baseUrl; API_KEY=$apiKey; SHIM_HOST='127.0.0.1'; SHIM_PORT='8102'; GATEWAY_TRANSPORT='direct' }
    foreach ($name in $defaults.Keys) {
        if ($name -notin @('BASE_URL','API_KEY') -and $current.ContainsKey($name)) { continue }
        $line = $name + '=' + $defaults[$name]
        $pattern = '(?m)^' + [regex]::Escape($name) + '\s*=.*$'
        if ([regex]::IsMatch($text,$pattern)) {
            $text = [regex]::Replace($text,$pattern,[Text.RegularExpressions.MatchEvaluator]{param($m) $line})
        } else { $text = $text.TrimEnd() + "`r`n" + $line + "`r`n" }
    }
    Write-Utf8File $path ($text.Trim() + "`r`n")
}

function Set-DesktopEntries([string]$packageDir, [string]$desktopDir) {
    [void][IO.Directory]::CreateDirectory($desktopDir)
    $shell = New-Object -ComObject WScript.Shell
    foreach ($name in @('ChatGPT','chatgpt-api')) {
        $shortcut = $shell.CreateShortcut((Join-Path $desktopDir ($name + '.lnk')))
        $shortcut.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
        $shortcut.Arguments = '//B //Nologo "' + (Join-Path $packageDir ($name + '.vbs')) + '"'
        $shortcut.WorkingDirectory = $packageDir
        $shortcut.IconLocation = (Join-Path $packageDir 'assets\ChatGPT.ico') + ',0'
        $shortcut.WindowStyle = 7
        $shortcut.Description = if ($name -eq 'ChatGPT') { '启动系统当前注册的原版客户端' } else { '使用自定义 API 配置启动当前客户端' }
        $shortcut.Save()
    }
}
