# Bifrost Responses 托管生图兼容（按来源启用）

客户端的本地 `image_gen` 工具、Images API 与 Responses 中的服务端 `image_generation` 工具是不同通道。此功能用于最后一种：GPT 聊天模型在 Responses 请求中调用真实托管图片工具。默认关闭，不修改官方客户端、官方路由、非 GPT 转换、远程压缩或现有 Images 接口。

## 适用问题与前提

某些 Bifrost → OpenAI 兼容上游组合存在以下问题：

- 标准 Responses 转换丢失工具结果的 `name`。客户端发送没有 `call_id`、但有 `name` 的 `function_call_output` 时，上游拒绝请求。
- 客户端没有注册本地 `image_gen`，模型因而误以为不存在另行提供的服务端图片工具。
- 上游将外层聊天 `reasoning` 传给图片模型，流中返回 `image_generation_user_error`、`param: complexity`，消息为 `Complexity '…' is not supported for this image model.`。

这些是特定网关组合的兼容问题，并非所有 Responses 服务都需要绕行或重试。

上游必须真正支持 Responses 的 `image_generation` 工具与选定图片模型。只开放 `/v1/images/generations` 和 `/v1/images/edits` 不等于具备托管工具能力。外层 `model` 仍为可调用工具的 GPT 聊天模型，图片型号放在图片工具的 `model` 内。参见 [OpenAI 托管生图文档](https://developers.openai.com/api/docs/guides/tools-image-generation)。

Bifrost 的对应提供方还需由管理员启用原生透传及流式透传，并在透传白名单中仅允许所需的 **POST `/v1/responses`**。本地适配使用 Bifrost 的 `/openai_passthrough/v1/responses` 路径和 `x-model-provider` 请求头，不修改 Bifrost/上游服务二进制，也不自动开放任何服务器接口。配置字段与界面以所用 Bifrost 版本为准；不要为此放开任意透传路径。

## 配置

在启动器程序目录下自行创建 `data/state/responses-compat.json`（不是客户端的 `.codex` 目录）：

```json
{
  "version": 1,
  "rules": [
    {
      "profileId": "default",
      "modelPrefix": "relay/",
      "bifrostProvider": "relay",
      "declareHostedImages": true,
      "imageModel": "gpt-image-2.5-flare"
    }
  ]
}
```

`relay` 仅为示例，请替换成自己的网关提供方名称。

| 字段 | 含义 |
| --- | --- |
| `profileId` | 启动器 API 来源 ID，默认来源为 `default`；其他来源使用本地 `data/providers.json` 中相应来源的 `id`。不要将含 Key 的完整配置公开。 |
| `modelPrefix` | 该来源上游模型 ID 的非空前缀，必须以 `/` 结尾。示例只匹配 `relay/gpt-…`，透传时移除 `relay/`。多来源展示名中的 `@p_…/` 不属于此字段。 |
| `bifrostProvider` | Bifrost 中的提供方 ID，写入 `x-model-provider`，不是启动器来源 ID。 |
| `declareHostedImages` | 可选布尔值，默认不注入。为 `true` 时添加真实 `image_generation` 工具及其能力说明；不强制普通聊天生图，不替换已有图片工具。 |
| `imageModel` | 可选图片型号，默认 `gpt-image-2.5-flare`。上游必须支持并授权该型号；已有图片工具显式指定的型号和参数优先。 |

没有文件、`rules: []` 或配置无效时，不启用适配。最多 32 条规则，按顺序采用第一条同时匹配来源和模型前缀的规则。配置无效只记录固定提示，不记录配置内容。

保存后完全退出客户端及启动器，再重新打开。配置启动时读取，不进行运行中热重载。删除文件或清空 `rules`，重启即可停用。此文件是本机状态，发布包不会附带或覆盖它。

这是对选定 API 聊天来源显式启用的托管工具，不使用控制台的 Images 默认模型、强度或“官方／自定义生图设置”。官方聊天模型仍走官方通道；若希望继续使用原生图片工具及其控制台设置，无需开启此功能。

## 请求与安全边界

匹配规则后，HTTP 和 WebSocket→HTTP 请求使用原生透传，保留工具 `name`、`namespace`、历史、认证及普通聊天推理设置。反向代理的 URL 前缀和查询参数保留。

只有流式响应中的上述精确图片复杂度错误，且原请求带外层 `reasoning` 时，才可能发起一次隔离的图片子请求：

- 子请求只开放并选择托管图片工具，保留原图片参数和参考图历史，移除子请求外层 `reasoning`；原聊天推理设置不改。
- 不复用原生回合状态、Lite 协商和请求身份头（包括其 `x-bf-eh-*` 副本）；保留 API 认证、提供方路由及取消信号。
- 已出现其他工具调用、未完成的非图片输出、成功图片或多个待恢复图片位置时，不重放。子请求中出现意外的其他工具调用会失败，不交给客户端执行。
- 不递归重试。认证、限流、网络、内容拒绝及其他错误不触发生图重试；JSON 非流式错误保持原有处理。
- 保留原始响应 ID、已完成文字和顺序，使用成功上游的真实图片 ID。失败占位不会作为成功图片写入历史。图片保存、聊天展示与后续编辑沿用现有 `ResponseImages` 机制，不伪造图片结果，不重写本地聊天记录。

隔离子请求可能产生一次额外的上游计费请求；此规则仅适合管理员已确认有上述兼容问题的来源，不应作为通用网络重试机制。

## 验证

```sh
npm ci --ignore-scripts
node tests/gateway-responses-compat-test.mjs
node tests/gateway-responses-router-test.mjs
npm test
```

测试使用本地模拟上游，不使用账号、生产服务或付费图片生成：覆盖原始工具字段、配置失效关闭、独立重试及禁止重放条件、真实路由 HTTP/WebSocket 转发、图片保存／展示／历史还原、官方与未选来源隔离，以及三平台构建指纹和发布清单。实际服务可用性仍需在配置好权限后另行验证。
