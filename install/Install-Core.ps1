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
    if (($current['BASE_URL'] -ne $baseUrl -or $current['API_KEY'] -cne $apiKey) -and (Test-Path -LiteralPath (Join-Path $packageDir 'data\providers.json'))) {
        & (Join-Path $packageDir 'runtime\node.exe') (Join-Path $packageDir 'src\settings.mjs') sync-legacy $packageDir
        if ($LASTEXITCODE -ne 0) { throw 'API 基础设置已保存，但多来源配置未同步，请打开控制台检查。' }
    }
}

function Initialize-UnicodeShortcuts {
    if ('ChatGPTApi.NativeShortcuts' -as [type]) { return }
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Text;
namespace ChatGPTApi {
    public static class NativeShortcuts {
        [ComImport, Guid("00021401-0000-0000-C000-000000000046")]
        private class ShellLink { }
        [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("000214F9-0000-0000-C000-000000000046")]
        private interface IShellLinkW {
            void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder path, int count, IntPtr data, uint flags);
            void GetIDList(out IntPtr idList);
            void SetIDList(IntPtr idList);
            void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder description, int count);
            void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string description);
            void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder directory, int count);
            void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string directory);
            void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder arguments, int count);
            void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string arguments);
            void GetHotkey(out ushort hotkey);
            void SetHotkey(ushort hotkey);
            void GetShowCmd(out int showCommand);
            void SetShowCmd(int showCommand);
            void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder icon, int count, out int index);
            void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string icon, int index);
            void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string path, uint reserved);
            void Resolve(IntPtr window, uint flags);
            void SetPath([MarshalAs(UnmanagedType.LPWStr)] string path);
        }
        public static void Save(string file, string target, string arguments, string directory, string icon, string description) {
            object instance = new ShellLink();
            try {
                IShellLinkW link = (IShellLinkW)instance;
                link.SetPath(target);
                link.SetArguments(arguments);
                link.SetWorkingDirectory(directory);
                link.SetIconLocation(icon, 0);
                link.SetShowCmd(7);
                link.SetDescription(description);
                ((IPersistFile)instance).Save(file, true);
            } finally { Marshal.FinalReleaseComObject(instance); }
        }
    }
}
'@
}

function Set-DesktopEntries([string]$packageDir, [string]$desktopDir) {
    [void][IO.Directory]::CreateDirectory($desktopDir)
    Initialize-UnicodeShortcuts
    foreach ($name in @('ChatGPT','chatgpt-api','chatgpt-apionly')) {
        $arguments = '//B //Nologo "' + (Join-Path $packageDir ($name + '.vbs')) + '"'
        $description = if ($name -eq 'ChatGPT') { '官方模型与原生登录，保留混合历史兼容' } elseif ($name -eq 'chatgpt-apionly') { '仅使用自定义 API 网关模型，不切换官方登录' } else { '根据官方登录状态使用官方与网关模型' }
        [ChatGPTApi.NativeShortcuts]::Save((Join-Path $desktopDir ($name + '.lnk')), (Join-Path $env:WINDIR 'System32\wscript.exe'), $arguments, $packageDir, (Join-Path $packageDir 'assets\ChatGPT.ico'), $description)
    }
}
