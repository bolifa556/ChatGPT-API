# ChatGPT API 3.2.7

本版修复非 GPT 模型的回复显示，以及新版桌面客户端读取旧项目分组的问题。

| 平台 | 安装包 |
| --- | --- |
| Windows x64 | [下载 ZIP](ChatGPT-API-Launcher-3.2.7-win-x64.zip) |
| Linux x64 | [下载安装包](ChatGPT-API-Provider-3.2.7-linux-x64.tar.gz) |
| Linux ARM64 | [下载安装包](ChatGPT-API-Provider-3.2.7-linux-arm64.tar.gz) |
| macOS Apple Silicon | [下载 DMG](ChatGPT-API-Provider-3.2.7-macos-arm64.dmg) |

- 修复部分接口把整段正文放在最后一个数据包，或把正文分成多个文本块时，客户端没有显示最终答复的问题。
- 思考、过程说明和最终回复按服务商返回的顺序显示。工具调用因输出上限中断时保留原来的中断原因，不执行残缺的参数。
- 修复切换模型后上下文容量仍显示旧值的问题，补齐 GPT-6.2 Astra 和 Sol 的模型规格。
- 兼容新版客户端的账号偏好和项目记录。旧分组迁移不完整时，只恢复能与同一账号、本机项目和已有对话对应的记录；模型目录暂时缺项时，保留上次的模型选择。

更新前请完全退出客户端，安装时选择原目录即可保留 API 设置。使用方法见[项目说明](../../README.md)。
