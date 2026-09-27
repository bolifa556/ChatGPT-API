$ErrorActionPreference = 'Stop'

function Get-EnvValues([string]$path) {
    if (-not (Test-Path -LiteralPath $path)) { throw "Missing settings file: $path" }
    $values = @{}
    foreach ($line in [System.IO.File]::ReadAllLines($path, [System.Text.Encoding]::UTF8)) {
        if (-not $line.Trim() -or $line.TrimStart().StartsWith('#')) { continue }
        $equals = $line.IndexOf('=')
        if ($equals -le 0) { continue }
        $name = $line.Substring(0, $equals).Trim()
        $value = $line.Substring($equals + 1).Trim()
        $values[$name] = $value
    }
    return $values
}

function Get-ExistingOfficialProxy {
    # Read the current environment/system settings; do not configure a VPN or port.
    foreach ($name in @('HTTPS_PROXY','https_proxy','ALL_PROXY','all_proxy')) {
        $value = [Environment]::GetEnvironmentVariable($name)
        if ($value -and $value -match '^https?://') { return $value }
    }
    $uri = [Uri]'https://chatgpt.com'
    try {
        $proxy = [Net.WebRequest]::DefaultWebProxy.GetProxy($uri)
        if ($proxy -and $proxy.AbsoluteUri -ne $uri.AbsoluteUri) { return $proxy.AbsoluteUri.TrimEnd('/') }
    } catch {}
    return ''
}

function Normalize-BaseUrl([string]$value) {
    $url = $value.Trim().TrimEnd('/')
    $url = [regex]::Replace($url, '(?i)/(?:models|responses)$', '')
    $uri = $null
    if (-not [System.Uri]::TryCreate($url, [System.UriKind]::Absolute, [ref]$uri) -or
        $uri.Scheme -notin @('http', 'https') -or $uri.UserInfo -or $uri.Query -or $uri.Fragment) {
        throw 'Enter an http:// or https:// API base URL without a query string.'
    }
    if ($url -notmatch '(?i)/v1$') { $url += '/v1' }
    return $url
}

function Write-Utf8File([string]$path, [string]$content) {
    if ((Test-Path -LiteralPath $path) -and [System.IO.File]::ReadAllText($path) -ceq $content) { return }
    $directory = Split-Path -Parent $path
    if (-not (Test-Path -LiteralPath $directory)) {
        [void](New-Item -ItemType Directory -Path $directory -Force)
    }
    $tempPath = Join-Path $directory ('write-' + [guid]::NewGuid().ToString('N') + '.tmp')
    $backupPath = Join-Path $directory ('backup-' + [guid]::NewGuid().ToString('N') + '.tmp')
    try {
        [System.IO.File]::WriteAllText($tempPath, $content, (New-Object System.Text.UTF8Encoding($false)))
        if (Test-Path -LiteralPath $path) {
            [System.IO.File]::Replace($tempPath, $path, $backupPath)
        } else {
            [System.IO.File]::Move($tempPath, $path)
        }
    } finally {
        if (Test-Path -LiteralPath $tempPath) { Remove-Item -LiteralPath $tempPath }
        if (Test-Path -LiteralPath $backupPath) { Remove-Item -LiteralPath $backupPath }
    }
}

function Get-GatewayModelIds([string]$baseUrl, [string]$apiKey) {
    $request = [System.Net.HttpWebRequest][System.Net.WebRequest]::Create($baseUrl.TrimEnd('/') + '/models')
    $request.Method = 'GET'
    $request.Timeout = 15000
    $request.Accept = 'application/json'
    $request.Headers['Authorization'] = 'Bearer ' + $apiKey
    $response = $null
    $reader = $null
    try {
        $response = $request.GetResponse()
        $reader = New-Object System.IO.StreamReader($response.GetResponseStream(), `
            (New-Object System.Text.UTF8Encoding($false, $true)), $true)
        $data = $reader.ReadToEnd() | ConvertFrom-Json
    } finally {
        if ($reader) { $reader.Dispose() }
        if ($response) { $response.Dispose() }
    }
    $ids = @($data.data | ForEach-Object { if ($null -ne $_) { [string]$_.id } } |
        Where-Object { $_ -and $_.Trim() } | Select-Object -Unique)
    if ($ids.Count -eq 0) { throw 'The gateway returned no model IDs.' }
    return $ids
}

function Quote-TomlString([string]$value) {
    return ($value | ConvertTo-Json -Compress)
}
