# ChatGPT API 3.2.6

本次更新修复纯 API 入口的联网搜索，完善模型目录、上下文和思考强度配置。

| 平台 | 安装包 |
| --- | --- |
| Windows x64 | [下载 ZIP](ChatGPT-API-Launcher-3.2.6-win-x64.zip) |
| Linux x64 | [下载安装包](ChatGPT-API-Provider-3.2.6-linux-x64.tar.gz) |
| Linux ARM64 | [下载安装包](ChatGPT-API-Provider-3.2.6-linux-arm64.tar.gz) |
| macOS Apple Silicon | [下载 DMG](ChatGPT-API-Provider-3.2.6-macos-arm64.dmg) |

- 补齐客户端独立搜索请求的适配。优先使用来源的原生搜索接口，接口明确拒绝该端点时再尝试 Responses 或 Chat 搜索，沿用当前模型、API 地址与 Key。
- 完善搜索结果、来源引用以及网页打开和查找的转换，保存成功使用的搜索协议供下次复用。
- 保存 API 来源后自动更新模型目录。GPT 模型沿用官方思考档位，其他新模型结合接口信息和参数校验识别可用档位，支持手动修改。
- 上下文按模型分别配置，已知容量、当前配置和思考档位均支持点击编辑。容量无法确认时，已知容量与当前配置均采用 262K，右侧显示客户端扣除预留空间后的数值。

Windows 已验证官方客户端 `26.1106.6628.0`。Windows/macOS 提供三个聊天入口，Linux 提供纯 API 入口。安装更新选择原目录即可保留 API 设置，更新前请完全退出客户端。

使用方法和功能边界见[项目说明](../../README.md)。
