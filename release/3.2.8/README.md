# ChatGPT API 3.2.8

本版修复新版客户端在官方额度用尽后无法发送自定义模型消息的问题，并改进连续工具调用、图片编辑和控制台启动。

| 平台 | 安装包 |
| --- | --- |
| Windows x64 | [下载 ZIP](ChatGPT-API-Launcher-3.2.8-win-x64.zip) |
| Linux x64 | [下载安装包](ChatGPT-API-Provider-3.2.8-linux-x64.tar.gz) |
| Linux ARM64 | [下载安装包](ChatGPT-API-Provider-3.2.8-linux-arm64.tar.gz) |
| macOS Apple Silicon | [下载 DMG](ChatGPT-API-Provider-3.2.8-macos-arm64.dmg) |

- 在 `chatgpt-api` 里，官方额度用尽后可以切到自定义模型继续发送，使用该 API 来源自己的额度。
- 支持原生 WebSocket 的 GPT 接口可以在连续工具调用时复用连接，减少重复发送的对话内容。上一条响应明确无法续接时，可用已有的完整上下文继续。
- 补齐部分接口只在最后一个数据包里返回的完整工具调用，保留回复阶段、思考记录和接口返回的用量。
- 生图保留上游的流式预览事件。修图保留自定义 API 的文件引用，并复用同一请求中的图片下载。
- 刷新模型目录时保留手动设置的上下文。控制台避开浏览器限制的端口，启动兼容提示会指出具体受影响的功能。

更新前请完全退出客户端，安装时选择原目录即可保留 API 设置。使用方法见[项目说明](../../README.md)。
