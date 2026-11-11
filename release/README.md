# ChatGPT API 发布包

当前版本：[3.2.3](3.2.3/README.md)。每个版本独立保存，旧版本保留在各自目录。

| 平台 | 下载 |
| --- | --- |
| Windows x64 | [ZIP](https://github.com/bolifa556/ChatGPT-API/releases/download/v3.2.3/ChatGPT-API-Launcher-3.2.3-win-x64.zip) |
| Linux x64 | [tar.gz](https://github.com/bolifa556/ChatGPT-API/releases/download/v3.2.3/ChatGPT-API-Provider-3.2.3-linux-x64.tar.gz) |
| Linux ARM64 | [tar.gz](https://github.com/bolifa556/ChatGPT-API/releases/download/v3.2.3/ChatGPT-API-Provider-3.2.3-linux-arm64.tar.gz) |
| macOS Apple Silicon | [DMG](https://github.com/bolifa556/ChatGPT-API/releases/download/v3.2.3/ChatGPT-API-Provider-3.2.3-macos-arm64.dmg) |

3.2.3 改进启动失败时的提示，减少后台记录占用，补充推荐客户端版本。Windows 已验证客户端版本为 26.1103.7773.0，建议更新到这个版本或更新的官方稳定版。macOS DMG 含三个聊天入口和控制台 App。

需要先安装官方客户端。发布包附带运行时和依赖，不含个人配置、Key、登录、聊天、缓存或日志，不附带独立 `.sha256` 文件。模型和上游未提供的能力不由适配层补造，依赖官方身份的功能沿用原生要求，详见主 [README](../README.md)。
