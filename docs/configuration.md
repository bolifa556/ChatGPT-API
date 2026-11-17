# 配置、认证与数据

## 配置文件

安装目录 `data/providers.json` 保存多 API 来源和上下文设置，控制台是推荐编辑方式。未保存多来源配置时，从 `data/.env` 读取默认来源，兼容已有安装。

```json
{
  "version": 1,
  "providers": [
    {
      "id": "default",
      "name": "默认 API",
      "baseUrl": "https://api.example.com/v1",
      "apiKey": "YOUR_API_KEY",
      "enabled": true,
      "imageModel": "",
      "imageEditModel": "",
      "imageEditFormat": "json"
    }
  ],
  "preferredProviderId": "default",
  "defaultImageModel": null,
  "imageRouting": "official",

  "imageStrengths": {},
  "contextOverrides": {}
}
```

新增来源 ID 由控制台生成，以 `p_` 开头；不要手工更改已使用的 ID。当前配置的键是 `[来源ID, 原始模型ID]` 的 JSON 字符串。`preferredProviderId` 用于自动图片候选优先顺序，不是将所有聊天自动路由到该来源。

`defaultImageModel` 独立保存手动指定的默认生图模型，格式为 `{ "providerId": "default", "modelId": "实际图片模型ID" }`；`null` 表示自动选择，控制台会直接勾选路由实际采用的“默认生图（自动）”，无需手动选择或保存，不改变 `preferredProviderId`。旧配置尚无此字段时，可从原优先来源的 `imageModel` 迁移；恢复自动后不会再次启用旧值。来源的 `imageModel` 仍可补充目录中未识别的图片别名。

`imageRouting` 在控制台“所有来源”右侧选择。`official` 使用登录的订阅账号，原样转发官方生图请求，不受下方 API 模型及强度设置影响；官方错误仍原样返回。`custom` 使用下方默认 API 生图模型。纯 API 模式始终使用 `custom`，忽略保存的官方选项；原生官方入口始终使用官方通道。旧配置已有手动 API 生图模型时沿用自定义通道，否则保留登录时使用官方的选择。

历史通道由启动器自动兼容，不提供手动选择。三个入口运行期间使用同一通道；旧对话的头部、持久化通道设置和 SQLite 索引仅在运行期间临时匹配，退出后恢复原值。消息、工具记录、ID、项目和原生设置不随之改写。恢复日志位于适配层 `data/state/thread-provider-compatibility.json`，恢复完成即删除；旧 `officialProvider` 配置被忽略。

“思考强度”优先读取模型目录的能力声明，支持 `supported_reasoning_levels`、`reasoning_effort_levels`、`thinking.levels`、`thinking_config.enabled.efforts` 等格式。GPT 模型沿用官方档位。其他新增聊天模型缺少声明时，进行一次参数校验，从模型明确返回的支持列表中保留 `low`、`medium`、`high`、`xhigh`、`max`，排除别名说明。通用 JSON 枚举错误或接受了无效值的接口标为“无法检测”。旧版生成探查的缓存会升级校验一次，之后复用最终结果。`strengthOverrides` 按 `[来源ID, 原始模型ID]` 保存用户编辑的 `reasoning`、`complexity`、`quality` 档位列表，客户端菜单使用同一份结果。校验只在控制台保存新来源或手动刷新时执行。

图片的 `complexity`（思考）与 `quality`（画质）独立保存。`imageStrengths` 的键同样为 `[来源ID, 原始模型ID]`，例如 `{ "[\"default\",\"gpt-image-2.6-sunburst\"]": { "complexity": "low", "quality": "high" } }`。未选择时自动使用当前可确认的最高档位；无法确定最高档位时使用模型默认。自定义原生生图请求会替换原模型自带的默认强度，未知或不支持的 `complexity` 不发送；原生请求的画质为 `auto` 或未指定时才使用控制台设置，显式画质优先。已确认不支持的请求档位在发送前报 400。上游实际回报的画质原样保留，不伪造为所选档位、不添加降档错误，也不再次生成。普通聊天的思考设置不变。

Fast 由客户端原生速度菜单控制，HTTP 和 WebSocket 均保留请求中的 `service_tier`，包括关闭 Fast 后的默认档。旧版 `fastModels` 字段在读取时忽略、保存时移除，不再覆盖客户端选择。API 入口运行期间，仅为支持 Fast 的 GPT 目录项开放相应原生选项；上游实际回报的服务档位保留原值，不伪造调度结果。

API 地址仅在裸域名后补齐 `/v1`；明确填写的 `/custom/v2` 等路径保留原值，也支持从 `/responses`、`/chat/completions` 等完整端点提取基础路径。不接受内嵌密码、查询参数或片段。保存的 Key 不在控制台状态接口中回传，空 Key 更新表示保留原值；控制台默认显示密码圆点，点击眼睛时通过经过认证且校验来源与修订号的独立接口查看明文，不改写配置。URL / Key 变更后不能使用旧凭据的目录缓存。

模型目录明确声明 `supported_endpoints` 时，按其选择 Responses 或 Chat；没有声明时保留已有兼容规则，不增加接口探测。具名工具结果保留名称和命名空间映射，优先关联已有的唯一调用 ID；没有对应 ID 时使用 Chat 的命名 function 结果形式，不补造调用。Chat 回复中的来源标注转换为原生 annotations。普通 API 保留原生协议头；只有已识别需要显式头转发的来源才附加相应扩展，没有新增独立规则文件。

## .env 兼容配置

`data/.env` 仍保存本地路由启动参数与原生取钥助手使用的本机桥接凭据。存在 `providers.json` 时，实际远程地址和 Key 以各来源为准；控制台不会在客户端运行中改写桥接凭据。首次保存且没有基础配置时才初始化 `.env`。

| 字段 | 默认值 / 含义 |
| --- | --- |
| `BASE_URL`、`API_KEY` | 旧版默认来源与本机桥接的启动凭据 |
| `SHIM_HOST` | `127.0.0.1`，本机监听 |
| `SHIM_PORT` | `8102` |
| `GATEWAY_TRANSPORT` | 默认按 API URL 连接，沿用系统路由；Windows 仅显式 `ssh` 启用旧默认来源的 SSH 隧道，其他值不阻止启动 |
| `OFFICIAL_BASE` | 默认官方 Codex 地址，通常无需设置 |
| `IMAGE_MODEL`、`IMAGE_EDIT_MODEL`、`IMAGE_EDIT_FORMAT` | 尚未保存多来源配置时的默认图片选项 |

校园 VPN、TUN、局域网和公网无需填写不同的连接类型。`direct` 表示不额外建立 SSH 隧道，不会绕过系统 VPN。`GATEWAY_TRANSPORT` 可省略；`auto`、`vpn` 等旧值按普通 URL 连接处理，显式 `ssh` 兼容大小写、外围引号和行尾 `#` 注释。此设置不会启用或关闭系统代理、VPN、TUN；仅在浏览器中设置的代理也不会因此自动用于 API 请求。

Windows / macOS 的旧 URL / Key 配置窗口仍可用；明确修改时同步控制台中的优先来源。多来源、单模型上下文和图片设置应在控制台管理。保存多来源配置后清空图片模型表示恢复自动选择，不会重新启用旧 `.env` 的图片别名。

## 模型目录

每次 API 入口启动时并行查询全部启用来源的 `/models`，随后生成原生客户端使用的菜单。控制台也可显式刷新；运行期间没有定时模型轮询。原生客户端自身的官方目录请求按原协议处理。

默认来源的模型标识保持原样，新增来源为 `@来源ID/原始模型ID`。显示名附带来源名称；上游仅收到自己的原始模型名和 Key，回到客户端时恢复公开模型标识。同名模型不自动合并、不跨来源静默回退。

每个来源目录独立缓存 24 小时，绑定来源 URL 和 Key 的指纹；缓存不保存 Key。可用来源与各自有效缓存共同组成目录；失效来源没有有效缓存时不展示其模型。官方目录按当前原生 CLI 版本读取，不使用写死的官方清单。

原生菜单在启动时加载。保存、刷新或更新客户端后，需要完全退出并重新打开入口才能加载新菜单；控制台不会中断正在运行的任务。

## 上下文

容量按真实 API URL 和原始模型 ID 缓存，优先采用模型元数据、已核对规格和原生最大容量。无法确认时，容量和初始配置统一设为 262K，可在控制台修改。详见 [上下文](model-context.md)。

`contextOverrides` 保存用户填写的配置窗口，`modelCapacities` 保存用户编辑的已知容量。窗口按填写值生效，可以高于已知容量。缺少手动配置时使用已知或探查容量，未确认时使用 262,000。旧 `contextLimit` 字段在读取时忽略，保存时移除。客户端通常显示配置窗口的 95%。

## 认证与工具

官方请求使用原生账号凭据，不向自定义 API 传递 OAuth 或账号头。各 API 请求使用选中来源的 Key。API-only 的模型、目录和图片请求不回退官方服务；存在旧登录文件不改变此规则。

三个入口运行期间使用 `chatgpt_api_launcher`，自动兼容旧 provider 的本机对话，退出后恢复临时元数据。混合入口按登录状态加载模型。纯 API 入口通过 `requires_openai_auth = false` 和本地桥接占位凭据连接适配层，真实上游 Key 由路由持有；登录存储沿用用户原设置。项目、引导和工作区偏好通过临时展开原生账户作用域复用，退出时归回原作用域。官方入口提供和转发官方模型，并保留原生远程压缩。两个 API 入口使用原生文本压缩。

浏览器、MCP 和插件运行时可能另外请求官方身份服务，模型 Key 不能代替它们需要的账号权限。启动器不修改系统代理模式、TUN、DNS 或浏览器插件。工具定义、输入、历史调用及结果只按其协议转换。

Windows / macOS 的 API 入口通过 CDP 在运行时兼容当前客户端的发送额度判断和 Fast 显示。选中自定义模型时，解除官方订阅的额度拦截；官方模型和权限、加载状态等其他禁用条件保持原样。不改官方客户端安装文件，也不伪造账号额度；客户端升级改变界面结构时，可能需要更新兼容规则。

## 生图与编辑

Images 接口独立于聊天转换。官方入口只使用官方服务；混合入口有官方身份时按 `imageRouting` 选择官方或自定义服务，官方通道不自动回退自定义。API-only 及无登录模式直接使用 API 图片模型。

自定义生图通道使用选中的默认 API 模型，未手动指定时按目录自动选择。控制台在“模型与上下文”中选择默认，取消后恢复自动选择。模型按能力元数据与已知图片模型名称识别；已有的 `imageModel`、`imageEditModel` 和 `imageEditFormat` 配置继续读取，控制台保存其他设置时保留这些字段。图片生成不限定 GPT Image，来源必须提供兼容 Images 接口。

当前原生 `image_gen` 不接受 `model` 参数，聊天文字不能可靠指定图片模型。适配器仅对带原生图片回合标识的自动请求应用默认选择，不解析或改写提示词；普通 Images API 调用显式提供的模型 ID 优先。API 认证 provider 的本地工具注册标记会在上游转发前移除，不充当官方身份凭据。

没有对应模型时明确报错。网络故障、临时限流、参数错误、内容拒绝或已经生成但格式错误的结果不会触发再生图。URL 图片结果下载后转为原生需要的 base64，下载时不携带 API 或官方凭据，不新增提示词或聊天。

## 数据与权限

| 位置 | 内容 |
| --- | --- |
| 安装目录 `data/providers.json` | 多来源、明文 Key 和上下文设置 |
| 安装目录 `data/.env` | 兼容基础配置与路由启动参数，含明文 Key |
| `data/cache/` | 目录、容量及模板缓存 |
| `data/state/` | 活动入口、进程身份和控制台连接令牌 |
| `data/logs/` | 脱敏的启动与适配日志 |
| 原生 `CODEX_HOME` 及应用目录 | 原生登录、聊天、工具和界面数据 |

macOS 程序目录为 `~/Library/Application Support/chatgpt-apionly`；Linux 默认 `~/.local/share/chatgpt-api-provider`；Windows 以安装时选定目录为准。POSIX 配置文件限制为当前用户读写，未接入系统钥匙串。

三个平台在启动期间临时接管原生配置中的路由、目录项和旧对话通道标记，退出后恢复；同一 `CODEX_HOME` 的其他 CLI 可能读到临时设置。Linux 的 `configure` 可提前准备配置，也可执行 `restore` 恢复。不复制登录、不另建聊天库。分享时只分发 `release/<版本>/` 中的原始归档。
