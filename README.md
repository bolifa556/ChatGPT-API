# ChatGPT API Launcher

Windows x64 下的三入口启动器，适用于已安装的 `OpenAI.Codex` 桌面应用。它不是另一份 ChatGPT 客户端。

另提供 **Linux provider 独立版**（x64 / ARM64）：模型目录来自网关，使用 API Key，提供单一 `ChatGPT API` 入口，不处理官方登录。安装及功能边界见 [Linux 使用说明](docs/linux-readme.md)。

## 安装与更新

1. 使用独立发布包 `ChatGPT-API-Launcher-<版本>-win-x64.zip`，完整解压后双击包内 **安装.cmd**。
2. 选择程序安装目录，再填写 API 基础 URL 和 API Key，点击“安装 / 更新”。已有安装时自动优先识别桌面入口的目录，更新保留 `data/`。支持 HTTP 和 HTTPS；地址未带 `/v1` 时自动补齐。
3. 桌面生成 **ChatGPT**、**chatgpt-api** 和 **chatgpt-apionly** 三个快捷方式。重复安装更新同名入口，保留已有配置和额外设置。
4. 切换入口前，从托盘完全退出当前客户端。安装器不会更新客户端本体，也不会从 GitHub 自动下载启动器新版。

独立发布包携带 `runtime/node.exe` 和锁定版本的依赖，不包含源码仓库、开发测试、个人配置或运行数据。安装完成后可以删除解压的发布包，桌面入口指向选定的程序目录。首次安装默认目录为 `%LOCALAPPDATA%\Programs\ChatGPT-API-Launcher`。仅运行时必需的脚本会随程序安装。

从 Git 源码安装时仍可运行仓库根目录 `安装.cmd`，直接将该目录用作运行目录；缺少依赖时安装器会联网下载固定版本并校验哈希。日常安装、更新和分享建议使用独立 ZIP。

## 三个入口

| 入口 | 行为 |
| --- | --- |
| `ChatGPT.vbs` | 保留原生登录，模型目录与模型请求只使用官方；本地兼容层转换混合历史，不回退到网关模型。 |
| `chatgpt-api.vbs`，有已保存的 ChatGPT 登录 | 合并官方与网关的实际模型目录，按选中的模型分别使用官方账号或 API Key。 |
| `chatgpt-api.vbs`，没有已保存的 ChatGPT 登录 | 使用自定义 provider 和网关实际模型目录，无需先登录官方账号。 |
| `chatgpt-apionly.vbs` | 始终使用网关目录、API Key 和网关模型，生图也只走 API；已有官方登录文件保留。 |

桌面快捷方式指向上述根目录入口。入口用系统包注册信息启动应用，不写死 `WindowsApps` 下的版本目录。移动整个文件夹后，重新运行安装器更新快捷方式；移动前应完全退出客户端。

三个入口均保留兼容通道，官方模型不会转发到 API 网关。原生官方工具列表、增量上下文和加密状态保持原协议；仅遇到第三方历史时转换必要字段。退出后恢复临时配置，不改登录文件、语言设置或已保存的聊天正文。API 与 API-only 分别记住模型选择；切换入口不会注销官方账号。入口决定模型目录的来源，没有另设模型隐藏名单；网关提供的 GPT 模型仍是可用的网关模型。

官方模型列表随已安装的客户端版本刷新，不固定在安装启动器时的模型集合。启动器从与当前应用二进制一致的原生内核读取版本；官方入口的模型目录请求保留客户端原参数转发，API 入口同步合并官方与网关目录。原生客户端在启动时加载自定义目录，更新客户端或启动器后需从托盘完全退出并重开一次。

启动时根据模型选择提供方：官方模型使用 `openai` 和官方远程压缩；已登录的网关模型使用 `chatgpt_api_mixed`，保留原生账号认证并使用客户端内置文本压缩。启动器也会通过原生会话 API 双向更正旧对话的提供方，保留原 threadId 和消息。**在同一对话切换官方与网关模型后，目前需要从托盘完全退出并重开，才能保证压缩方式同步切换；模型菜单的即时联动尚未接入。** 完整边界见 [压缩修复记录](docs/compaction-incident-2026-09-28.md)。

## 目录

```text
ChatGPT.vbs                   官方模型入口
chatgpt-api.vbs               根据登录状态使用官方与网关模型
chatgpt-apionly.vbs           网关模型入口
Launch-ChatGPT.ps1            共用启动、退出恢复与进程管理
Read-ApiKey.ps1               旧 provider 的取钥匙及按需启动助手
安装.cmd                      安装入口
install/                     安装界面、设置保存、依赖准备
src/                         本地转发器、消息适配、配置与路径管理
assets/                      图标、无个人信息的模型模板、运行时下载清单
runtime/                     Node 运行程序
node_modules/                锁定版本的第三方依赖
data/                        当前机器的私有数据，不提交 Git
  .env                       URL 与 API_KEY
  cache/                     模型目录、推理档位缓存
  state/                     切换恢复记录、辅助进程身份、锁
  logs/                      固定文件名的日志
  backup/                    旧版一次性恢复备份
  diagnostics/               本机诊断和测试结果
  testing/                   测试用虚拟配置，不用于客户端
docs/                        使用与架构说明
tests/                       默认离线回归测试及显式运行的真实接口测试
.github/workflows/           Windows 自动检查定义
scripts/                     生成独立发布包的构建脚本
release/                     Windows/Linux 发布包、使用说明与 SHA-256
```

**客户端自己的登录、聊天记录、插件和界面缓存不在 `data/`。** 它们仍由客户端保存在 `CODEX_HOME`（默认 `%USERPROFILE%\.codex`）及 AppData 中。三个入口共用这些数据，不复制登录，不创建平行聊天库。

源码和维护文档由此目录中的本地 Git 管理，保留原有提交历史。`data/`、依赖、运行二进制与发布归档不提交 Git；发布说明和 `.sha256` 校验文件提交。当前及历史发布包均保存在 [release/](release/README.md)，文档索引见 [docs/](docs/README.md)。

从旧版平铺目录迁移时，若旧入口仍在运行，旧进程正在使用的根目录缓存和 `shim/` 会暂时保留；完全退出后的下一次启动自动迁移并清理。不会中断当前对话。

## 开发与验证

已安装 Node.js 时，在仓库根目录执行：

```powershell
npm ci --ignore-scripts
npm test
npm run test:windows
```

也可使用 `runtime/node.exe` 运行各 `*-test.mjs`，用 Windows PowerShell 5.1 执行 `tests/launcher-test.ps1`。默认测试使用本地模拟服务器和虚拟配置，不调用真实模型，不读真实聊天记录。

准备好运行依赖后，执行 `npm run build:release` 生成 `release/` 下的 ZIP 和 SHA-256 文件，再执行 `npm run test:release` 验证独立安装、离线依赖、更新保留配置与包完整性。也可用 `scripts/Build-Release.ps1 -OutputDirectory <独立发布目录>` 指定其他发布位置。构建采用程序文件白名单，不打包 `data/`，不会重启或更新当前运行中的安装。

Linux provider 使用 `python scripts/build-linux-release.py --arch all` 构建 `release/` 下的两个 `.tar.gz` 包，也可用 `--output <发布目录>` 指定其他位置（构建机需要 Python 3.11+，安装端不需要 Python）。Node 下载使用 `assets/runtime-linux.json` 中的官方 SHA-256；可将对应归档预置于 `data/cache/` 后离线构建。将包解压到 Linux 文件系统后，用包内 Node 执行 `tests/linux-provider-test.mjs <解压后的发布根目录>`，验证实际安装入口、权限、配置、并发取钥匙、路由、更新和恢复。测试仅使用隔离目录与模拟接口。

`python tests/linux-package-test.py <x64归档> <ARM64归档>` 可在构建机核对两个归档的完整清单、当前源文件、SHA-256、执行权限、换行格式及 ELF 架构，不执行异架构二进制。

`tests/live-models.mjs`、`tests/native-client-live.mjs`、`tests/official-client-live.mjs`、`tests/media-live.mjs` 是单独运行的真实接口验证，会使用本机配置和账号发起实际请求；原生真实模型测试使用 ephemeral 对话。`tests/native-switch-test.mjs` 则在独立测试目录中运行未修改的原生 app-server、真实本地工具和受控模型端点，验证同一对话的跨模型、跨入口恢复。运行方式、完整功能清单与排除项见 [最新验证记录](docs/model-verification-2026-09-28.md)。

详见 [配置与使用](docs/configuration.md)、[路由与兼容机制](docs/architecture.md)、[消息转换协议](docs/message-protocol.md)、[维护说明](docs/maintenance.md)。

项目是独立的本地工具，不是 OpenAI 官方产品。图标取自用户已安装的应用；第三方品牌与依赖的权利归原权利人。尚未为本项目指定对外发布许可证。
