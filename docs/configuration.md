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

本地监听只允许回环地址。网关需支持 `/models` 和 OpenAI Responses 接口；普通 Chat Completions 接口需要上游网关先做转换。

若使用 SSH，可额外配置 `GATEWAY_TRANSPORT=ssh`、`SSH_HOST`、`SSH_USER`、`SSH_REMOTE_HOST`、`GATEWAY_TUNNEL_PORT`。SSH 身份继续使用用户自己的 SSH 配置。默认直接请求填写的 URL。

## 如何识别“未登录”

每次冷启动读取 `CODEX_HOME/auth.json`；未设置 `CODEX_HOME` 时读取 `%USERPROFILE%\.codex\auth.json`。

- 文件可解析，`auth_mode` 为 `chatgpt` 或未填写，且存在 `tokens.access_token`：判为保存了 ChatGPT 登录，使用 `mixed`。
- 文件缺失、不可解析、没有令牌，或明确是其他认证方式：使用 `gateway`。
- 只判断已保存的凭据，不查询剩余额度，也不验证令牌是否过期。过期但尚未清除的令牌仍算“有登录”，由客户端处理刷新或重新登录。

`gateway` 模式选用 `model_provider = "chatgpt_api_launcher"`，配置 `requires_openai_auth = false`，由 `Read-ApiKey.ps1` 读取你的 API Key，并请求同一本地兼容层。启动器从不写 `auth.json`。

## 原配置改动范围

API 运行期间临时设置 `openai_base_url`、`model_catalog_json`，并按需要设置默认 provider、模型。退出后恢复；异常退出时，下一次从任一入口恢复。语言、Max/Ultra 显示开关等其他设置继续采用客户端原值。

为让既有 API 对话能恢复，保留 `chatgpt_api_launcher` 和已经存在的 `smr` provider 定义，使它们指向本地兼容层。这些定义不会把普通官方对话切到网关。原生入口中继续旧 API 对话时，取钥匙助手按需启动本地兼容层。

`data/state/launcher-state.json` 是一份反复复用的恢复记录；正常退出后清空临时配置快照。不会每次切换生成新的备份。

## 模型与档位

冷启动刷新网关与可用的官方模型目录，运行中也会定期刷新。官方模型保持原顺序并置顶，网关模型按名称排序。网关统一采用官方 GPT-6-Sol 的档位元数据；没有可用官方元数据时使用最近缓存或随包模板，包含 `ultra`。

显示的档位仍受客户端设置控制；可选档位不代表每个上游都能执行同样的推理行为。网关不可达时，仅可复用同一 URL/Key 的 24 小时内模型目录，并提示降级；换 URL/Key 不复用旧目录。
