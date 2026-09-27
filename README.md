# ChatGPT API Launcher

Windows x64 下的双入口启动器，适用于已安装的 `OpenAI.Codex` 桌面应用。它不是另一份 ChatGPT 客户端。

## 安装与更新

1. 把整个文件夹放在固定位置。已有安装时，用新版程序文件覆盖同一文件夹，保留 `data/`。
2. 双击 **安装.cmd**，填写 API 基础 URL 和 API Key，点击“安装 / 更新”。支持 HTTP 和 HTTPS；地址未带 `/v1` 时自动补齐。
3. 桌面生成 **ChatGPT** 和 **chatgpt-api** 两个快捷方式。重复安装更新同名入口，保留已有配置和额外设置。
4. 切换入口前，从托盘完全退出当前客户端。安装器不会更新客户端本体，也不会从 GitHub 自动下载启动器新版。

完整本地安装包携带 `runtime/node.exe` 和 `node_modules/`，可直接复用。从 Git 源码安装且缺少依赖时，安装器会联网下载固定版本并校验哈希。

## 两个入口

| 入口 | 行为 |
| --- | --- |
| `ChatGPT.vbs` | 恢复启动器临时配置，打开系统当前注册的原版应用。 |
| `chatgpt-api.vbs`，有已保存的 ChatGPT 登录 | 显示官方模型和网关模型，按选中的模型分别使用官方账号或 API Key。 |
| `chatgpt-api.vbs`，没有已保存的 ChatGPT 登录 | 使用自定义 provider，只显示网关模型，无需先登录官方账号。 |

桌面快捷方式指向上述根目录入口。入口用系统包注册信息启动应用，不写死 `WindowsApps` 下的版本目录。移动整个文件夹后，重新运行安装器更新快捷方式；移动前应完全退出客户端。

## 目录

```text
ChatGPT.vbs / chatgpt-api.vbs  两个可双击入口
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
tests/                       可复用、无真实账号的测试
.github/workflows/           Windows 自动检查定义
```

**客户端自己的登录、聊天记录、插件和界面缓存不在 `data/`。** 它们仍由客户端保存在 `CODEX_HOME`（默认 `%USERPROFILE%\.codex`）及 AppData 中。两个入口共用这些数据，不复制登录，不创建平行聊天库。

从旧版平铺目录迁移时，若旧入口仍在运行，旧进程正在使用的根目录缓存和 `shim/` 会暂时保留；完全退出后的下一次启动自动迁移并清理。不会中断当前对话。

## 开发与验证

已安装 Node.js 时，在仓库根目录执行：

```powershell
npm ci --ignore-scripts
npm test
npm run test:windows
```

也可直接使用 `runtime/node.exe` 运行 `tests/*.mjs`，用 Windows PowerShell 5.1 执行 `tests/launcher-test.ps1`。测试使用本地模拟服务器和虚拟配置，不调用收费模型，不读真实聊天记录。

详见 [配置与使用](docs/configuration.md)、[路由与兼容机制](docs/architecture.md)、[维护说明](docs/maintenance.md)。

项目是独立的本地工具，不是 OpenAI 官方产品。图标取自用户已安装的应用；第三方品牌与依赖的权利归原权利人。尚未为本项目指定对外发布许可证。
