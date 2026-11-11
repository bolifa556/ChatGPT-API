# ChatGPT API 3.2.2

本次更新修复流式等待、错误显示、生图下载和多种 API 的兼容问题。保留客户端原有指令、工具内容和历史，只做必要的协议转换。

| 平台 | 安装包 |
| --- | --- |
| Windows x64 | [下载 ZIP](ChatGPT-API-Launcher-3.2.2-win-x64.zip) |
| Linux x64 | [下载安装包](ChatGPT-API-Provider-3.2.2-linux-x64.tar.gz) |
| Linux ARM64 | [下载安装包](ChatGPT-API-Provider-3.2.2-linux-arm64.tar.gz) |
| macOS Apple Silicon | [下载 DMG](ChatGPT-API-Provider-3.2.2-macos-arm64.dmg) |

- 上游仍在发送心跳时及时传给客户端，响应头不再等到正文出现才下发；兼容不同的流式换行方式。
- 保留流式错误的事件名称、错误类型和参数，修复部分连接失败被显示成“已取消”的问题。
- 普通自定义 API 也能保留同模型的思考历史，工具历史中发生 ID 转换时同步处理引用。
- 自定义生图返回图片地址时按其来源下载，不再误用官方代理；保留原有生图模型选择和画质设置。
- 支持模型目录只返回名称的 Chat-only 接口。在明确的端点不支持响应后完成协议转换；网络断开或请求已被接受时不会自动重新生成。
- 修复 macOS/Linux 给自定义 API 路径多加 `/v1` 的问题，三个平台使用相同的地址规则。
- WebSocket 按客户端读取速度发送，旧响应路由随历史缓存释放；macOS/Linux 有有效目录缓存时也可先启动，再完成本次目录刷新，不增加定时轮询。
- 保留官方额度耗尽后切自定义模型发送、项目分类、原有登录与配置恢复功能。退出后可继续使用自己的官方客户端。

安装时可跳过 API 配置，之后在控制台填写 URL 和 Key。Windows/macOS 提供 `chatgpt-official`、`chatgpt-api`、`chatgpt-apionly` 三个入口；Linux 提供纯 API 入口。macOS 包未使用 Developer ID 公证，首次打开按系统提示正常允许。

适用范围为提供 OpenAI 兼容接口的 API。模型和上游未提供的能力不由适配层补造，依赖官方身份的客户端功能仍沿用原生要求。使用方法见[项目说明](../../README.md)。
