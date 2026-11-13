# ChatGPT API 3.2.5

本次更新修复本地适配层的工具名称关联、工具参数截断和 Chat Completions 参数转换问题。

| 平台 | 安装包 |
| --- | --- |
| Windows x64 | [下载 ZIP](ChatGPT-API-Launcher-3.2.5-win-x64.zip) |
| Linux x64 | [下载安装包](ChatGPT-API-Provider-3.2.5-linux-x64.tar.gz) |
| Linux ARM64 | [下载安装包](ChatGPT-API-Provider-3.2.5-linux-arm64.tar.gz) |
| macOS Apple Silicon | [下载 DMG](ChatGPT-API-Provider-3.2.5-macos-arm64.dmg) |

- 统一工具定义、调用、结果和工具选择中的名称转换，修复部分带命名空间的工具记录在续聊时关联失败。
- 工具参数因输出上限等原因截断时，保留未完成状态和原始参数，后续可以在原对话继续发送消息。
- 补齐 Chat Completions 路径中的回复详细程度、缓存与调用方标识参数，按接口声明及模型类型选择输出上限字段。

Windows 已验证官方客户端 `26.1106.6628.0`。Windows/macOS 提供三个聊天入口，Linux 提供纯 API 入口。安装更新选择原目录即可保留 API 设置，更新前请完全退出客户端。

使用方法和功能边界见[项目说明](../../README.md)。
