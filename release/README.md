# ChatGPT API 发布包

当前版本：[3.1.8](3.1.8/README.md)。每个版本独立保存，旧版本保留在各自目录。

| 平台 | 下载 |
| --- | --- |
| Windows x64 | [ZIP](3.1.8/ChatGPT-API-Launcher-3.1.8-win-x64.zip) |
| Linux x64 | [tar.gz](3.1.8/ChatGPT-API-Provider-3.1.8-linux-x64.tar.gz) |
| Linux ARM64 | [tar.gz](3.1.8/ChatGPT-API-Provider-3.1.8-linux-arm64.tar.gz) |
| macOS Apple Silicon | [DMG](3.1.8/ChatGPT-API-Provider-3.1.8-macos-arm64.dmg) |

3.1.8 修复 API 返回 Responses 图片结果时聊天空白的问题，保存原图并转换为可显示、可继续编辑的图片消息。不新增依赖或 MCP，保留现有原生生图链路。macOS DMG 含三个聊天入口和控制台 App。

需要先安装官方客户端。发布包附带运行时和依赖，不含个人配置、Key、登录、聊天、缓存或日志，不附带独立 `.sha256` 文件。混合模式官方额度用尽后的即时切 API 限制仍存在，详见主 [README](../README.md)。
