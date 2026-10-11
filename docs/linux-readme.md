# ChatGPT API Provider — Linux

仅使用自定义 API provider 的 Linux 发布包。模型菜单只包含网关模型，认证使用你填写的 API Key；不读取或管理官方登录，不提供官方/API 双入口切换。消息、工具调用、流式响应和历史格式转换复用 Windows 版的适配核心。

## 安装

1. 安装官方 Linux ChatGPT 桌面应用。官方预览版支持 Ubuntu 24.04/26.04 等桌面发行版：<https://learn.chatgpt.com/docs/linux/linux-app>。
2. 下载对应架构的包：`x86_64` 选择 x64，`aarch64` 选择 ARM64。
3. 完全退出 ChatGPT，解压整个 `.tar.gz`，在解压目录运行 `./install.sh`。以桌面用户运行，不要使用 sudo。
4. 输入 API 基础 URL 和 API Key。密钥输入不显示在终端。默认安装到 `~/.local/share/chatgpt-api-provider`；也可运行 `./install.sh /你的/绝对/安装路径`。
5. 从应用菜单打开 **ChatGPT API**。安装完成后可删除发布包解压目录。

包内已包含对应架构的 Node.js、依赖及许可证，不需要安装 Node 或下载 npm 依赖。配置时需要访问你的网关 `/models` 接口。支持 HTTP/HTTPS，未带 `/v1` 的地址自动补齐。

更新时先完全退出客户端，再运行新包中的安装脚本，选择原目录。已有密钥和模型选择会保留，程序文件经过清单 SHA-256 校验后更新。分享原始发布包，不要分享安装后的 `data` 目录。

## 使用和配置

以下命令中的 `$INSTALL` 代表选定的程序安装目录：

```sh
"$INSTALL/linux/chatgpt-api"            # 刷新模型目录并打开官方客户端
"$INSTALL/linux/chatgpt-api" configure  # 修改 URL / Key
"$INSTALL/linux/chatgpt-api" status     # 查看本地适配器状态，不显示 Key
"$INSTALL/linux/chatgpt-api" stop       # 退出客户端后停止适配器
"$INSTALL/linux/chatgpt-api" restore    # 退出客户端后恢复被本安装器接管的原配置
```

安装器会在原生 `CODEX_HOME/config.toml`（默认 `~/.codex/config.toml`）设置 `chatgpt_api_launcher` provider、网关模型目录和默认模型。这些 provider 配置会持久保留；普通 `chatgpt` 命令也会使用这一配置。语言、权限和其他配置不变，不写 `auth.json` 或聊天记录。可用 `restore` 恢复安装前被接管的配置项，并保留其他设置的后续修改。

API Key 保存在安装目录的 `data/.env`，权限为仅当前用户可读写。后台适配器只监听 `127.0.0.1`；默认端口 8102。原生客户端通过取钥匙助手按需启动同一个适配器，适配器不会创建或修复聊天记录。

默认通过 PATH 中的 `chatgpt` 启动客户端。如安装位置特殊，可设置 `CHATGPT_API_CLIENT` 为客户端可执行文件的完整路径。若使用自定义 `CODEX_HOME`，安装和启动时应保持一致。

无人值守配置可通过环境变量 `CHATGPT_API_BASE_URL`、`CHATGPT_API_KEY`、`CHATGPT_API_PORT` 提供参数，再执行安装脚本或 `configure`；不要把真实密钥写进共享脚本或命令行参数。

生图和编辑也只使用自定义 API，支持非 GPT Image 模型；API 没有对应生图或编辑模型时直接报错。网关需提供 OpenAI 兼容 Images 接口。自动识别模型列表中的生图元数据或已知名称；任意别名可在 `data/.env` 设置 `IMAGE_MODEL=模型ID`，编辑另可设置 `IMAGE_EDIT_MODEL=模型ID`，ID 必须存在于当前 API 模型列表。默认 JSON 编辑，旧网关仅支持 multipart 时可设置 `IMAGE_EDIT_FORMAT=multipart`。这些选项在重新 `configure` 时保留。URL 图片结果转成原生需要的 base64，图片下载不附带 API Key；不会新增提示词或聊天内容。

## 功能边界

- 仅面向 Linux 原生客户端支持的本地 provider 功能。官方订阅、官方模型目录及官方凭据支持不包含在本包中。
- 工具、终端、文件操作和文本压缩由原生客户端提供；本工具转换消息，不添加会话内容。使用自定义 provider 的压缩方式由原生客户端决定。
- Linux 官方预览版暂不支持的功能、上游模型没有的能力，以及必须依赖官方登录的功能，本包不能补齐。需要 ChatGPT 账号才能下载的历史图片文件 ID 不能用网关 Key 读取；本地图片/文件仍按原生 provider 的支持范围处理。
- 网关线路按配置 URL 直连。本包不配置 VPN、系统代理或 SSH 隧道，不增加生成请求重试。
- 模型目录在启动时加载。安装更新、切换配置或需要刷新菜单时，应完全退出客户端后从 ChatGPT API 重开。
- Fast 请求档位原样发送，返回采用上游实际档位；菜单仅采用网关自己声明的速度选项，不复制官方倍速说明。是否真正提供优先服务由上游决定。
- 浏览器和 MCP 使用原生工具，其自身网络请求独立于模型请求；要求官方身份的原生服务不能用网关 Key 获得权限。本包不替换浏览器插件、不伪造身份、不启用 TUN。
- 发布包不包含官方客户端，不修改官方客户端二进制；这是独立第三方启动工具。
