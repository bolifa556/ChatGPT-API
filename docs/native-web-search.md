# 原生联网搜索兼容

## 原因与处理

客户端的原生 `web.run` 文本检索调用使用 `POST /v1/alpha/search`（也接受 `/alpha/search`），请求包含搜索会话 `id`、选中 `model` 和 `commands`。这不是普通 Responses 请求，也不是把 `web_search` 工具定义加入聊天就能替代的接口。

API-only 原先会将这个路径直接交给 API 来源。来源即使支持 Responses 托管搜索，也未必实现原生 `/alpha/search`；此时可能返回 404 / 405，表现为模型能聊天但原生搜索不可用。有登录身份的混合入口可能使用官方模型的原生通道，因此两个入口的表现不同。

适配层仅对路由到自定义 API 模型的原生搜索请求执行以下转换：

1. 解析并校验原生搜索指令，按当前模型确定 API 来源和真实模型名。
2. 向该来源的 `/responses` 发送强制使用托管 `web_search` 的检索请求，要求返回 `web_search_call.action.sources`。
3. 校验实际完成的 `web_search_call`，收集检索摘要、来源 URL 和引用标注，再返回原生需要的 `encrypted_output`、`output`、`results`。

官方模型仍使用原生官方路径。普通聊天、图片接口和模型选择不变；API-only 不借用本地已有的 ChatGPT 登录，不回退其他来源。原生 OAuth、账号标识和内部回合状态不会作为自定义搜索请求的认证信息发送。

## 上游要求

当前选中来源、模型及 API Key 必须真正支持 Responses 的托管 `web_search`，包括强制工具选择和来源返回。仅兼容 `/chat/completions`、仅在模型目录中声明搜索能力、或只返回一段没有执行搜索的文字，都不够。

接口形状依据 [OpenAI Responses 联网搜索文档](https://developers.openai.com/api/docs/guides/tools-web-search)。服务商若不支持这些参数，需要在服务商侧开放对应能力；本补丁不修改服务器权限，也不替代服务器提供搜索引擎。

搜索子请求使用选中模型的来源地址和 API Key，不自动切换模型。认证失败、限流、网络故障或不支持工具时返回错误，不再换来源重试。只有普通文字而没有真实搜索调用的“成功”回复会报 `search_not_executed`，不会当作已联网的结果。

## 支持范围与限制

支持 `search_query`、`open`（HTTP(S) URL 或本会话引用）、`find`，以及 `response_length`。每次原生请求最多四个操作，每个操作单独调用一次 Responses，可能产生多次模型与搜索计费。

`open` 和 `find` 由托管搜索模型执行，输出是带真实来源 URL 的模型检索摘要，不是与官方原生服务逐字节相同的网页正文或精确行号导出。`recency`、`lineno` 和摘要长度以指令形式尽力满足，不能作为严格的时间或行号保证。无结果时应明确说明，不能以记忆回答冒充检索。

暂不支持 `click`、`image_query`、PDF `screenshot`、`finance`、`weather`、`sports`、`time`、`literature_search_query` 等扩展指令；收到这些非空指令会返回 `unsupported_search_command`，不会伪造结果。

域名白名单取设置与单次查询限制的交集；预先阻止不允许的打开/查找 URL，并检查返回来源是否符合白名单和黑名单。这些检查不替代上游的网络访问隔离。`cached` 映射为 `external_web_access: false`，`live` 映射为 `true`；`indexed` 保留原值，交由上游支持或显式拒绝，不静默扩大为实时访问。

原生会话上下文只做形状校验，不转发给搜索子模型，避免把用户完整对话作为新的聊天任务执行。`max_output_tokens` 原样应用于每个子请求，不是所有操作及最后来源列表的总预算；`response_length` 也是摘要指令，不是最终返回长度的硬上限。

引用 ID 仅作为真实 URL 的内存别名，按来源 ID、地址、Key 和搜索会话隔离。闲置 30 分钟后在下次请求时淘汰，最多 64 个会话、每会话 256 个引用。来源变更、过期或重启后应重新检索，也可以直接打开原 HTTP(S) URL；不会将失效 ID 猜测为其他网页。

请求 UTF-8 序列化大小限制为 512 KiB；解压后的单个 JSON / SSE 事件限制为 8 MiB，SSE 数据累计限制为 16 MiB。支持普通 JSON、SSE、带事件名的 SSE 和现有压缩解码。客户端取消会中止在途的上游请求。

## 验证

无需真实 Key 的隔离测试：

```sh
node tests/native-web-search-test.mjs
node tests/native-web-search-router-test.mjs
```

前者覆盖转换、真实搜索调用校验、错误、压缩流、引用隔离、域名策略、预算和输入/输出限额；后者启动真实路由和本机模拟上游，在 API-only 与混合入口分别验证路径、来源 Key、官方请求保留、普通聊天不变及取消请求。两者均已加入 `npm test`。

实际验收还需在 API-only 入口选中支持托管搜索的 API 模型，调用文本搜索，再用返回 ID 执行 `open` / `find`。只看到模型口头宣称“已联网”不算成功；应检查实际工具结果和可访问的来源 URL。模拟测试不证明任意服务商或所有原生搜索扩展都可用。

新模块纳入 Windows / Linux / macOS 的发行包与路由构建指纹，避免仅更新此模块时旧路由未被识别，或发行包遗漏模块导致启动失败。Linux / macOS 原生运行仍需对应平台验证。
