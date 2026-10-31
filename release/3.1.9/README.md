# ChatGPT API 3.1.9

| 平台 | 下载 |
| --- | --- |
| Windows x64 | [ZIP 安装包](ChatGPT-API-Launcher-3.1.9-win-x64.zip) |
| Linux x64 | [tar.gz](ChatGPT-API-Provider-3.1.9-linux-x64.tar.gz) |
| Linux ARM64 | [tar.gz](ChatGPT-API-Provider-3.1.9-linux-arm64.tar.gz) |
| macOS Apple Silicon | [单文件 DMG](ChatGPT-API-Provider-3.1.9-macos-arm64.dmg) |

## 生图后的历史格式修复

修复图片返回后继续聊天出现 `Invalid value: 'input_image'. Supported values are: 'output_text' and 'refusal'.` 的问题。客户端能接收用于显示、编辑的 assistant 图片内容，但 Responses 上游不接受将它作为 assistant 输出文本直接回放。此前仅验证客户端和宽松模拟接口，漏掉了这条上游限制。

- 发送历史前，仅将适配层自己生成的图片展示消息还原为已有的 `image_generation_call` 结果，保留原图，不再次生图、不添加用户消息或虚构工具调用。
- 新结果的原始 ID、图片描述等元数据保存在图片旁的 `.response.json` 中，用于下一轮恢复原始结果；文件不含额外聊天或另一份图片数据。已有 3.1.8 记录没有元数据文件时，仍能用已保存的原图转换，不需要新建聊天或修改历史文件。
- 覆盖 HTTP、WebSocket、重新载入对话和经兼容入口切换官方模型的 Responses 请求。Chat 通道沿用已有图片映射；普通工具图片、用户上传图片和官方生图请求保持原有处理方式。
- 补齐图片引用对应的流式文字事件，重复完成事件只显示一次。

本次只修消息转换，不增加依赖、MCP、提示词或聊天记录，不修改官方客户端，也不增加网络重试。

## 验证

- 严格模拟接口先复现原始 400，再验证修复后的续聊、切换和重连。
- 真实 Bifrost / GPT 通道复现相同错误；修复后，客户端保存的旧格式图片历史经完整适配层请求，返回 HTTP 200、完成回答，Bifrost 对应日志为 `success`。
- 官方客户端内核已验证图片消息的流式文本、重新载入对话后引用原图编辑，以及原有 Images 生图/编辑链路。图片字节保持一致，验证没有发起付费生图。

其他用户的原始请求和桌面界面不在本机，仍需更新后在其原对话中确认。接口拒绝、网络失败与模型自身能力限制仍按上游实际情况处理；本补丁不承诺官方图库等专用界面完全一致。协议依据见 [Responses 消息定义](https://developers.openai.com/api/reference/resources/responses/methods/create)，其他边界见项目 [README](../../README.md)。

## 更新

完全退出客户端，再安装到原目录，保留 `data/` 与客户端数据目录，重新从相应入口打开后可继续已有对话。Windows / macOS 提供三个聊天入口和控制台；Linux 提供 API 入口与控制台。

安装包不含个人 Key、登录、聊天或日志，不提供独立下载校验文件。macOS 仍为 ad-hoc 签名，未经过 Apple 公证，保留系统正常的手动允许流程。
