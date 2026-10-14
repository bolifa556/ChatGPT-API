# ChatGPT API-only Provider — macOS 3.0.9

适用于 Apple Silicon（ARM64）的独立 provider 包，只提供 **chatgpt-apionly** 入口。模型目录、对话和生图只使用自定义 API Key 与网关，不读取、刷新或写入官方登录文件；消息、工具、流式响应和历史转换复用 Windows/Linux 的同一份适配核心。

官方当前提供 Apple Silicon 的 [macOS 桌面应用](https://learn.chatgpt.com/docs/app)。原生 macOS 客户端读取 `~/.codex/config.toml` 并支持 [自定义 provider 和取钥匙助手](https://learn.chatgpt.com/docs/enterprise/connect-to-a-gateway)。本包不包含客户端、不修改客户端二进制。包内 Node.js 25.8.2 运行时要求 macOS 13.5 或以上，见 [Node 官方平台要求](https://github.com/nodejs/node/blob/v25.8.2/BUILDING.md#platform-list)；客户端自身的系统要求仍以官方版本为准。

## 安装

1. 安装官方 ChatGPT 桌面应用，默认放在 `/Applications/ChatGPT.app`。旧名称 `Codex.app` 也支持。
2. 完全退出客户端（Command-Q），解压 `ChatGPT-API-Provider-3.0.9-macos-arm64.tar.gz` 的全部内容。
3. 双击解压目录中的 `Install.command`，或在终端进入解压目录运行 `./install.sh`。以当前桌面用户安装，不使用 sudo。
4. 输入 API 基础 URL 和 API Key，密钥输入不回显。默认安装到 `~/Library/Application Support/chatgpt-apionly`；可运行 `./install.sh /你的/绝对/安装路径` 指定目录。
5. 从桌面双击 **chatgpt-apionly.command** 启动原生客户端。安装成功后可删除解压目录。

只生成一个桌面入口。命令入口通过终端显示错误，客户端独立运行；不会安装另一份官方/API 混合入口。若系统阻止打开命令文件，按 macOS 的“右键—打开”或系统设置中的正常允许流程处理，不需要关闭系统安全检查。

包内包含 ARM64 Node.js、锁定依赖及许可证，无需另装 Node、Python 或 npm。配置时会读取网关的 `/models`；基础地址未带 `/v1` 时自动补齐，支持 HTTP/HTTPS。

更新时完全退出客户端，运行新包中的安装入口并选择原目录。安装器先核对逐文件 SHA-256，再替换程序文件，保留密钥、模型选择、运行数据与其他已有文件。分享原始发布包，不分享安装后包含密钥的 `data/`。

## 使用

下面的 `$INSTALL` 代表程序安装目录：

```sh
"$INSTALL/macos/chatgpt-apionly"            # 启动时刷新网关模型目录并打开客户端
"$INSTALL/macos/chatgpt-apionly" configure  # 修改 URL / Key
"$INSTALL/macos/chatgpt-apionly" status     # 查看适配器状态
"$INSTALL/macos/chatgpt-apionly" stop       # 完全退出客户端后停止适配器
"$INSTALL/macos/chatgpt-apionly" restore    # 完全退出客户端后恢复安装前接管的配置
```

安装器在 `CODEX_HOME/config.toml`（默认 `~/.codex/config.toml`）设置 `chatgpt_api_launcher` provider、网关模型目录和默认模型，使用 `requires_openai_auth = false` 与取钥匙助手。配置持久保存，直接打开同一原生应用也会使用该 provider；不会创建平行聊天库。语言、权限及其他设置保留，不写 `auth.json` 或聊天正文。`restore` 恢复本安装器接管的原配置项，并保留其他设置的后续修改。

API Key 保存在安装目录的 `data/.env`，仅当前用户可读写。后台适配器只监听 `127.0.0.1`，默认端口 8102；取钥匙助手可按需启动同一适配器。官方登录即使已经存在，也不用于网关认证、模型列表或官方图片下载。

默认从 `/Applications` 或 `~/Applications` 的 `ChatGPT.app` / `Codex.app` 读取 `CFBundleExecutable` 启动实际程序，不固定客户端版本。其他安装位置可用环境变量 `CHATGPT_API_CLIENT` 指定应用包或可执行文件。自定义 `CODEX_HOME` 时安装与命令行启动应保持一致；生成的桌面入口会保留安装时选择的配置目录。

无人值守配置可使用 `CHATGPT_API_BASE_URL`、`CHATGPT_API_KEY`、`CHATGPT_API_PORT` 环境变量，不要把真实密钥写进共享脚本或命令行参数。

生图与图片编辑只走网关，支持非 GPT Image 模型。网关需提供 OpenAI 兼容 Images 接口；没有对应模型时直接报错。模型列表无法自动识别别名时，可在 `data/.env` 设置 `IMAGE_MODEL=模型ID`、`IMAGE_EDIT_MODEL=模型ID`；ID 必须存在于网关列表。默认 JSON 编辑，旧网关可设置 `IMAGE_EDIT_FORMAT=multipart`。重新配置时保留这些图片选项。

## 功能与验证边界

- 工具、终端、文件操作和文本压缩由原生客户端提供，本包只转换消息；不额外创建提示词、摘要任务或聊天记录。
- 不提供官方模型、官方登录或官方生图回退。要求官方账号的原生服务、模型本来不支持的能力、原生客户端本来不提供的功能均不会被补齐。
- 网关按 URL 直连，本包不配置系统代理、VPN、SSH 或 TUN，不增加生成请求重试。
- 模型目录在启动时刷新；更改配置或更新客户端后，完全退出并从 chatgpt-apionly 重开。
- Fast 档位沿用网关自己声明的能力，不复制官方速度选项；浏览器及 MCP 工具自身的网络与身份要求仍由原生客户端处理。
- 发布检查覆盖归档清单、SHA-256、Mach-O ARM64、执行权限、脚本换行、配置恢复及 macOS 进程/入口逻辑。当前构建机为 Windows；隔离 POSIX 路由测试不代表已经在真实 Mac 上验证官方客户端 GUI。macOS 安装回归脚本和 CI 已提供，实机结果应单独记录。
