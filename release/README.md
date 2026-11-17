# ChatGPT API 发布包

当前版本：[3.2.6](3.2.6/README.md)。每个版本独立保存，旧版本保留在各自目录。

| 平台 | 下载 |
| --- | --- |
| Windows x64 | [ZIP](https://github.com/bolifa556/ChatGPT-API/releases/download/v3.2.6/ChatGPT-API-Launcher-3.2.6-win-x64.zip) |
| Linux x64 | [tar.gz](https://github.com/bolifa556/ChatGPT-API/releases/download/v3.2.6/ChatGPT-API-Provider-3.2.6-linux-x64.tar.gz) |
| Linux ARM64 | [tar.gz](https://github.com/bolifa556/ChatGPT-API/releases/download/v3.2.6/ChatGPT-API-Provider-3.2.6-linux-arm64.tar.gz) |
| macOS Apple Silicon | [DMG](https://github.com/bolifa556/ChatGPT-API/releases/download/v3.2.6/ChatGPT-API-Provider-3.2.6-macos-arm64.dmg) |

3.2.6 修复纯 API 入口的联网搜索，完善各类兼容接口的搜索转换、思考强度识别和模型配置。保存 API 来源后会自动获取模型目录。Windows 已验证客户端版本为 26.1106.6628.0，macOS DMG 含三个聊天入口和控制台 App。

需要先安装官方客户端。发布包附带运行时和依赖，不含个人配置、Key、登录、聊天、缓存或日志，不附带独立 `.sha256` 文件。模型和上游未提供的能力不由适配层补造，依赖官方身份的功能沿用原生要求，详见主 [README](../README.md)。
