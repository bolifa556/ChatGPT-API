# ChatGPT API 3.2.2

本版完善通用 API 的消息转换，并包含启动、退出和配置恢复优化。保留原生指令、工具内容及历史，不增加生图提示词、隐藏生成重试或跨响应拼接。

| 平台 | 安装包 |
| --- | --- |
| Windows x64 | [下载 ZIP](ChatGPT-API-Launcher-3.2.2-win-x64.zip) |
| Linux x64 | [下载安装包](ChatGPT-API-Provider-3.2.2-linux-x64.tar.gz) |
| Linux ARM64 | [下载安装包](ChatGPT-API-Provider-3.2.2-linux-arm64.tar.gz) |
| macOS Apple Silicon | [下载 DMG](ChatGPT-API-Provider-3.2.2-macos-arm64.dmg) |

- 配置修改识别 TOML 字符串、注释与数组，保留多行自定义指令和配置示例；退出恢复原设置。
- 修复压缩历史恢复再次中断时的缓存一致性问题，减少日常切换的历史读写。
- 按模型目录声明选择 Responses 或 Chat；保留明确的 API 路径、具名工具结果、来源标注、真实模型信息和 Fast 参数。
- 普通 API 不再默认附加专用转发头；已识别的网关继续传递所需的原生协议元数据。
- 本地占位凭证不会作为官方身份发送。三平台纯 API 模式减少凭证辅助进程。
- 退出后及时释放入口；切换入口时不再仅凭窗口不可见强行终止客户端。关闭窗口后仍在后台运行的客户端，需要从客户端正常退出后切换入口。
- 控制台最后一个页面关闭后自动退出，不增加周期轮询。

安装时可跳过 API 配置，之后在控制台填写 URL 和 Key。Windows/macOS 提供 `chatgpt-official`、`chatgpt-api`、`chatgpt-apionly` 三个入口；Linux 提供纯 API 入口。macOS 包未使用 Developer ID 公证，首次打开按系统提示正常允许。

本版参考 [PR #1](https://github.com/bolifa556/ChatGPT-API/pull/1) 的字段保留、显式参数优先及统一协议验证思路；不引入其提示词注入、独立图片默认值及隐藏的第二次生成请求。

适用范围为提供 OpenAI 兼容接口的 API。模型和上游未提供的能力不由适配层补造，依赖官方身份的客户端功能仍沿用原生要求。使用方法见[项目说明](../../README.md)。
