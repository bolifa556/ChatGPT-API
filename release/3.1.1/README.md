# ChatGPT API 3.1.1

| 平台 | 安装包 |
| --- | --- |
| Windows x64 | [ChatGPT-API-Launcher-3.1.1-win-x64.zip](ChatGPT-API-Launcher-3.1.1-win-x64.zip) |
| Linux x64 | [ChatGPT-API-Provider-3.1.1-linux-x64.tar.gz](ChatGPT-API-Provider-3.1.1-linux-x64.tar.gz) |
| Linux ARM64 | [ChatGPT-API-Provider-3.1.1-linux-arm64.tar.gz](ChatGPT-API-Provider-3.1.1-linux-arm64.tar.gz) |
| macOS Apple Silicon | [ChatGPT-API-Provider-3.1.1-macos-arm64.dmg](ChatGPT-API-Provider-3.1.1-macos-arm64.dmg) |

每个 API URL 下的模型容量首次确认后缓存；模型列表继续在启动时刷新，已确认容量不重复检测。网关模型上下文为实际容量与 500,000 tokens 的较小值；官方模型沿用原生目录。自定义 API 不可用时可重新输入 URL / Key，取消保留旧值。

Windows 提供三个桌面入口；macOS DMG 提供 `chatgpt-official.app`、`chatgpt-api.app`、`chatgpt-apionly.app`；Linux 仅提供 API provider。使用前安装官方客户端，更新或切换入口前完全退出客户端。包内不含个人配置或容量缓存，不提供外部校验文件。

[完整使用说明](../../README.md) · [上下文与设置](../../docs/model-context.md)

500k 为网关模型目录上限；保留原生 5% 预留时，用量浮窗显示 475k。浮窗按新一轮 token 统计刷新，选择模型后不保证立即变化。官方模型仍使用原生配置。

macOS 三个入口通过系统 LaunchServices 启动官方客户端，包含通话、音视频、应用自动化及相关文件访问的用途声明；系统权限仍需在实际使用时正常授权。更新时替换三个入口 App。
