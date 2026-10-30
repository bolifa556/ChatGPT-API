# ChatGPT API 发布包

当前版本：[3.1.7](3.1.7/README.md)。每个版本独立保存，旧版本保留在各自目录。

| 平台 | 下载 |
| --- | --- |
| Windows x64 | [ZIP](3.1.7/ChatGPT-API-Launcher-3.1.7-win-x64.zip) |
| Linux x64 | [tar.gz](3.1.7/ChatGPT-API-Provider-3.1.7-linux-x64.tar.gz) |
| Linux ARM64 | [tar.gz](3.1.7/ChatGPT-API-Provider-3.1.7-linux-arm64.tar.gz) |
| macOS Apple Silicon | [DMG](3.1.7/ChatGPT-API-Provider-3.1.7-macos-arm64.dmg) |

3.1.7 将图片模型集中到“模型与上下文”，支持独立默认生图模型，修复纯 API 入口的原生图片工具注册，并增加来源重命名与已保存 Key 的显示切换。macOS DMG 含三个聊天入口和控制台 App。

需要先安装官方客户端。发布包附带运行时和依赖，不含个人配置、Key、登录、聊天、缓存或日志，不附带独立 `.sha256` 文件。混合模式官方额度用尽后的即时切 API 限制仍存在，详见主 [README](../README.md)。
