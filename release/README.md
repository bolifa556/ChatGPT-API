# ChatGPT API 发布包

当前版本：[3.2.2](3.2.2/README.md)。每个版本独立保存，旧版本保留在各自目录。

| 平台 | 下载 |
| --- | --- |
| Windows x64 | [ZIP](https://github.com/bolifa556/ChatGPT-API/releases/download/v3.2.2/ChatGPT-API-Launcher-3.2.2-win-x64.zip) |
| Linux x64 | [tar.gz](https://github.com/bolifa556/ChatGPT-API/releases/download/v3.2.2/ChatGPT-API-Provider-3.2.2-linux-x64.tar.gz) |
| Linux ARM64 | [tar.gz](https://github.com/bolifa556/ChatGPT-API/releases/download/v3.2.2/ChatGPT-API-Provider-3.2.2-linux-arm64.tar.gz) |
| macOS Apple Silicon | [DMG](https://github.com/bolifa556/ChatGPT-API/releases/download/v3.2.2/ChatGPT-API-Provider-3.2.2-macos-arm64.dmg) |

3.2.2 完善通用 API 的消息与工具转换，保留原始指令、来源标注、实际模型信息和 Fast 参数；优化启动、后台占用、退出及异常恢复。不同来源的旧对话继续自动兼容，语言、项目及界面偏好保持衔接。兼容元数据和临时配置在退出后恢复，客户端目录不保留额外兼容文件。macOS DMG 含三个聊天入口和控制台 App。

需要先安装官方客户端。发布包附带运行时和依赖，不含个人配置、Key、登录、聊天、缓存或日志，不附带独立 `.sha256` 文件。模型和上游未提供的能力不由适配层补造，依赖官方身份的功能沿用原生要求，详见主 [README](../README.md)。
