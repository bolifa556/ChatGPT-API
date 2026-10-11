# 配置与使用

## 配置位置

安装器将 URL 与密钥保存在 `data/.env`，格式见根目录 `.env.example`。密钥字段固定叫 `API_KEY`，支持值中带 `=`。重装只替换 URL、Key，保留已有可选字段和注释。

```dotenv
BASE_URL=https://gateway.example.com/v1
API_KEY=replace-with-your-gateway-key
SHIM_HOST=127.0.0.1
SHIM_PORT=8102
GATEWAY_TRANSPORT=direct
```

本地监听只允许回环地址。网关需支持 `/models`；模型的 Responses / Chat Completions 路由见 [消息转换协议](message-protocol.md)。

若使用 SSH，可额外配置 `GATEWAY_TRANSPORT=ssh`、`SSH_HOST`、`SSH_USER`、`SSH_REMOTE_HOST`、`GATEWAY_TUNNEL_PORT`。SSH 身份继续使用用户自己的 SSH 配置。默认直接请求填写的 URL。

## 如何识别“未登录”

API 入口每次冷启动读取 `CODEX_HOME/auth.json`；未设置 `CODEX_HOME` 时读取 `%USERPROFILE%\.codex\auth.json`。

- 文件可解析，`auth_mode` 为 `chatgpt` 或未填写，且存在 `tokens.access_token`：判为保存了 ChatGPT 登录，使用 `mixed`。
- 文件缺失、不可解析、没有令牌，或明确是其他认证方式：使用 `gateway`。
- 只判断已保存的凭据，不查询剩余额度，也不验证令牌是否过期。过期但尚未清除的令牌仍算“有登录”，由客户端处理刷新或重新登录。

`gateway` 模式选用 `model_provider = "chatgpt_api_launcher"`，配置 `requires_openai_auth = false`，由 `Read-ApiKey.ps1` 读取你的 API Key，并请求同一本地兼容层。启动器从不写 `auth.json`。

官方入口固定使用 `mixed` 和原生 `openai` provider，登录仍由原版客户端处理，不因为暂时没有保存令牌就切成 API 认证。

`chatgpt-apionly` 固定使用 `gateway`，不因已有官方登录切成混合模式。API Key 助手沿用当前入口记录，模型目录来自网关。它不会修改 `auth.json`；退出后仍可从官方入口使用原有登录。网关中的 GPT 模型按网关模型处理。

## 原配置改动范围

三个入口运行期间均临时设置 `openai_base_url`，并按需要设置默认 provider、模型。API 入口的 `model_catalog_json` 根据登录状态使用合并目录或网关目录；API-only 固定使用网关目录；官方入口不设置自定义目录，由本地 `/models` 返回原生官方模型元数据。退出后恢复；异常退出时，下一次从任一入口恢复。语言、Max/Ultra 显示开关等其他设置继续采用客户端原值。

入口范围由本地路由同时约束 HTTP、WebSocket 和生图请求。官方入口只请求官方模型，API-only 只请求网关模型；不会因为旧目录缓存或旧模型 ID 使用另一通道。两种 API 入口分别记住模型选择，不改写已保存的消息。

为让既有 API 对话能恢复，保留 `chatgpt_api_launcher` 和已经存在的 `smr` provider 定义，使它们指向本地兼容层。原生线程会保存 provider，因此不能只修改全局默认值或删除旧定义。选择官方模型时，本地通道使用官方账号发往 OpenAI；选择网关模型时才使用网关 API Key。

`data/state/launcher-state.json` 是一份反复复用的恢复记录；正常退出后清空临时配置快照。不会每次切换生成新的备份。

## 模型与档位

冷启动刷新网关与可用的官方模型目录，不再每分钟轮询。官方模型保持原顺序并置顶，网关模型按名称排序。网关的思考档位采用官方 GPT-6-Sol 的元数据；没有可用官方元数据时使用最近缓存或随包模板，包含 `ultra`。

Fast 的服务档位单独处理：官方模型保留官方声明；自定义模型仅使用其 `/models` 明确提供的 `service_tiers`、`additional_speed_tiers`、`default_service_tier`，没有声明时不复制官方倍速描述。请求里的 `service_tier` 仍原样送达上游；Chat → Responses 的 JSON 和流式转换保留上游实际返回的档位，包括退回 `default` 的情况。是否真正提供优先服务由上游决定。

官方目录按当前已安装内核的实际版本请求，不读取旧模型缓存里的版本号，也不写死官方模型集合。官方入口的原生目录请求保留客户端参数及官方响应；API 入口的合并目录随刷新同步到 `data/cache/models-smr.json`。客户端原生配置 `model_catalog_json` 在启动时加载，因此更新后需要从托盘完全退出并重开一次才能看到新菜单。若刚更新的原生客户端尚未生成匹配的可执行文件缓存，先启动原生客户端完成初始化，再退出重开；启动器会保留可用模型缓存，但不会猜测内核版本。

显示的档位仍受客户端设置控制；可选档位不代表每个上游都能执行同样的推理行为。网关不可达时，仅可复用同一 URL/Key 的 24 小时内模型目录，并提示降级；换 URL/Key 不复用旧目录。

有可用官方目录时，即使网关目录过期且刷新失败，也可启动官方通道；过期网关模型不会继续显示为可用。未增加生成请求的网络重试。启动器更新后，已经运行的客户端保持原来的配置，完全退出并从桌面入口重开后加载新配置。

## 生图与编辑

原生 `image_gen` 的 `/images/generations`、`/images/edits` 单独路由，不受聊天菜单中的模型集合限制，也不经过 Responses / Chat 消息转换器。

- 有官方登录：先原样发往官方 Images 接口。官方明确拒绝模型、无权访问、无登录权限、接口不存在或明确额度用尽时，再使用自定义 API 生图模型。
- 无官方登录或 Linux provider-only：直接使用自定义 API 生图模型，不读取官方凭据。
- 自定义 API 没有对应的生图或编辑模型时，返回 `no_gateway_image_model`；两个通道都不可用时返回错误。网络失败、服务端故障、临时限流、内容拒绝、错误请求参数和已接受但格式错误的结果不会触发重新生图。

自动选择优先读取 `/models` 中的 `capabilities.image_generation` / `image_edit`、`supported_endpoints`、图片输出模态等元数据，也可识别 GPT Image、Qwen Image、Flux、Imagen 等生图模型名称。不是根据“识图”能力推断生图能力。若网关只返回 ID，且使用无法识别的任意别名，在 `data/.env` 中填写列表里的准确模型 ID：

```dotenv
IMAGE_MODEL=供应商/生图模型别名
IMAGE_EDIT_MODEL=供应商/编辑模型别名
```

`IMAGE_EDIT_MODEL` 可省略，默认使用 `IMAGE_MODEL`。指定别名必须由当前 API 的 `/models` 提供，不会猜测模型或把生图请求发给普通聊天模型。自动选择的某个候选明确不可用时，可以尝试下一生图候选；指定模型不会自动换成其他别名。只提供图片接口的模型不会混入聊天菜单。新增模型随目录刷新发现。

网关负责将各厂商接口统一为 OpenAI 兼容 Images 协议。默认保留原生 JSON 编辑格式；旧网关仅接受 multipart 时设置 `IMAGE_EDIT_FORMAT=multipart`，适配器将原图字节转成上传格式。转到非 GPT Image 时，原生 `auto` 和默认不透明控制交给上游默认值；明确的尺寸、质量、透明背景、原始提示词及图片内容保留。返回 `b64_json` 的结果直接转交；仅返回图片 URL 时，读取真实图片转成原生客户端需要的 base64，下载时不携带任何账号或 API 凭据。不制造图片、补写提示词或创建聊天记录。

原生请求与响应结构依据 [Codex Images 客户端源码](https://github.com/openai/codex/blob/main/codex-rs/codex-api/src/endpoint/images.rs) 和 [Images 类型](https://github.com/openai/codex/blob/main/codex-rs/codex-api/src/images.rs)。接口 JSON 编辑支持见 [OpenAI API 更新说明](https://developers.openai.com/api/docs/changelog)。

## 浏览器和工具的网络

浏览器工具定义、代码参数、历史调用和结果按普通原生工具转换。模型请求与浏览器工具自身的网络请求是两条链路；本地 `/v1/responses` 不接收原生浏览器运行时的身份和功能配置请求。设置官方模型的代理，不代表所有 MCP 进程自动使用同一个代理。

有官方登录时，自定义模型继续使用客户端提供的原生浏览器和插件；没有官方登录时，模型、终端、文件编辑、本地 MCP、模型切换和原生文本压缩使用自定义 API 通道。当前安装的浏览器扩展运行时还依赖官方身份接口，纯 API 模式不能凭消息转换获得该接口的账号权限。内置浏览器的本机页面控制已单独实测；不要据此推断所有浏览器后端都不需要登录。

启动器不修改系统代理模式、TUN、DNS、浏览器登录信息或原生插件文件，也不创建替代浏览器和伪造官方身份。网络故障应按实际工具进程的出网链路排查；详见 [浏览器、Fast 与网络验证](browser-fast-network-fix-2026-10-10.md)。
