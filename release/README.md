# ChatGPT API 发布包

当前版本：[3.2.1](3.2.1/README.md)。每个版本独立保存，旧版本保留在各自目录。

| 平台 | 下载 |
| --- | --- |
| Windows x64 | [ZIP](3.2.1/ChatGPT-API-Launcher-3.2.1-win-x64.zip) |
| Linux x64 | [tar.gz](3.2.1/ChatGPT-API-Provider-3.2.1-linux-x64.tar.gz) |
| Linux ARM64 | [tar.gz](3.2.1/ChatGPT-API-Provider-3.2.1-linux-arm64.tar.gz) |
| macOS Apple Silicon | [DMG](3.2.1/ChatGPT-API-Provider-3.2.1-macos-arm64.dmg) |

3.2.1 自动兼容不同来源的旧对话，移除手动历史通道选项；修复纯 API 入口的账号身份、项目及工作区配置衔接，并保留 GPT 的原生 Fast 设置。兼容元数据和临时配置在退出后恢复，客户端目录不保留额外兼容文件。macOS DMG 含三个聊天入口和控制台 App。

需要先安装官方客户端。发布包附带运行时和依赖，不含个人配置、Key、登录、聊天、缓存或日志，不附带独立 `.sha256` 文件。混合模式官方额度用尽后的即时切 API 限制仍存在，详见主 [README](../README.md)。
