# ChatGPT API 3.1.6

| 平台 | 下载 |
| --- | --- |
| Windows x64 | [ZIP 安装包](ChatGPT-API-Launcher-3.1.6-win-x64.zip) |
| Linux x64 | [tar.gz](ChatGPT-API-Provider-3.1.6-linux-x64.tar.gz) |
| Linux ARM64 | [tar.gz](ChatGPT-API-Provider-3.1.6-linux-arm64.tar.gz) |
| macOS Apple Silicon | [单文件 DMG](ChatGPT-API-Provider-3.1.6-macos-arm64.dmg) |

## 安装与设置

- Windows 安装弹窗采用统一的紧凑布局，增加“跳过，稍后配置”，安装完成直接在窗口内提示。
- macOS 将 API 地址和 Key 合并到一个原生设置窗口，保留 Command+V 和主动“粘贴 Key”，初次安装可跳过。
- Linux 使用已有 GTK/KDE 对话框或终端选择；命令行支持 `./install.sh --skip-api`。
- 跳过只安装程序与入口，不创建虚假 URL/Key、不请求模型目录、不覆盖已有 API 设置，也不为首次空配置安装写入原生 provider。
- 未配置 API 就启动 API 入口时，显示“尚未配置 API”并提示通过控制台填写；Windows/macOS 的官方入口不要求 API 配置。

## 当前边界

用自定义 API 聊过的旧对话，切回官方入口后可能无法续聊、恢复或压缩，不保证跨入口无缝互通。官方加密上下文、对话 provider 状态与工具的官方身份要求仍有边界。官方额度耗尽后，在混合模式原地切 API 模型仍可能被原生输入框拦截；本次没有将其计为已修复。详见项目 [README](../../README.md)。

包内包含运行时和锁定依赖，不含个人配置、Key、登录、聊天或日志，不提供独立下载校验文件。macOS 仍为 ad-hoc 签名，未经过 Apple 公证，系统权限和 GUI 体验需实际设备确认。
