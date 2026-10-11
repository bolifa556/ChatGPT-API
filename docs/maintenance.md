# 维护说明

## 更新和迁移

通过独立 ZIP 发布包安装和更新：解压后运行包内 `安装.cmd`，选择原安装目录。安装器先验证逐文件 SHA-256，再覆盖清单中的程序文件，保留 `data/` 和其他已有文件；运行中的客户端或目标目录辅助进程会阻止覆盖。随后复用原配置界面，更新 `ChatGPT`、`chatgpt-api`、`chatgpt-apionly` 三个固定名称的桌面快捷方式。安装完成后可以删除发布包的解压目录。没有远程仓库自动更新。

`scripts/Build-Release.ps1` 与 `scripts/build-linux-release.py` 默认把发布包写入仓库内的 `release/`；历史版本也保存在这里。可通过 `-OutputDirectory` 或 `--output` 指定其他位置。包内只有安装入口、使用说明、安装程序、程序载荷及校验清单；Node.js 许可证和锁定依赖的许可证一起携带。版本号来自 `package.json`，构建不会覆盖同名的已有归档。`tests/release-test.ps1` 默认验证当前版本的 ZIP，也可传入 `-Archive <ZIP>`；测试在隔离目录验证新装、保留配置的更新和损坏包拒绝，不改真实桌面快捷方式、登录或配置。

旧版根目录数据会归入 `data`，旧版运行进程退出前保留它仍在使用的文件。判断进程同时核对 PID、程序路径和创建时间，避免 PID 被复用后误判。路径迁移不会重写客户端的聊天记录或登录文件。

移动安装目录或覆盖源文件前，建议先完全退出客户端。若临时路由尚未恢复，保持原目录位置，从原入口正常退出后再移动。

## 数据与 Git

- `data/`、运行二进制、依赖目录不提交 Git。
- `release/README.md` 和发布包的 `.sha256` 文件提交 Git；ZIP、tar.gz 归档保留在本地 `release/`，不写入 Git 对象库。
- 本仓库保留现有 Git 历史，不重新初始化或连接远端；在根目录使用 `git status`、`git log` 和 `git diff` 查看本地版本。
- `data/backup` 保存旧版留下的一次性备份，不是每次切换生成的。
- `data/logs/shim.log` 达到 5 MB 时滚动为一份 `.1`；启动日志使用固定文件名。
- 分享构建生成的原始 ZIP；构建白名单排除 `data/`、密钥、缓存、日志、Git 与测试。不要重新压缩已经安装并填写过密钥的程序目录。
- `data/testing` 是模拟测试夹具；`data/diagnostics` 是本机结果，不是客户端聊天历史。

## 常见问题

| 现象 | 检查位置 |
| --- | --- |
| 快捷方式打不开 | 文件夹是否移动；重跑安装更新路径。入口通过系统 Appx 注册启动，不跟随旧版本 exe 路径。 |
| 提示另一入口仍运行 | 从客户端托盘完全退出；不能并行切换不同入口的全局路由配置。 |
| 找不到 provider | 保留启动器的两个 provider 定义；根目录 `Read-ApiKey.ps1` 不能单独删除或移动。 |
| 模型列表刷新失败 | URL/Key 是否正确；查看 `data/logs`。新密钥不能借用旧密钥缓存。 |
| 客户端更新后缺少新官方模型 | 使用 3.0.2 或更新启动器，从托盘完全退出后重开。核对 `route-state.json.clientVersion` 与当前原生内核一致；旧 `models_cache.json` 中的版本不能用于请求新目录。API 菜单文件随刷新更新，但运行中的原生菜单不会因此自动重载。 |
| 更新后提示模型缺少 base_instructions / instructions_template | 使用 3.0.4 或更新启动器。GPT 别名保留官方完整 `model_messages`，兼容只有指令模板而无旧字段的目录。更新目录后在错误窗口重试，或重新打开入口。见 [修复与验证](model-catalog-fix-2026-10-09.md)。 |
| 新增 API 模型何时显示 | 3.0.5 起仅在启动时主动刷新目录，不再每分钟轮询。完全退出后重开入口会获取新目录；客户端自己的官方目录查询仍按原生方式转发。 |
| 英文、旧布局外观、无 Ultra 同时出现 | 本机已定位到原生在线功能配置 bootstrap / 备用初始化失败后的默认分支。中文配置存在也可能被该分支禁用；不以修改语言配置或客户端文件解决。 |
| 有旧令牌但被要求登录 | 先看原生账号发现/刷新日志；本机发现过账号请求超时导致登录回退。保存令牌不等于当时网络或令牌可用；启动器不删除 auth.json。 |
| 官方模型第二轮称没有工具 | 确认运行的是本次构建；官方 additional_tools 必须保留原生载体，不能提取成单次顶层 tools。更新后完全退出并从入口重开。 |
| 生图提示 Unknown model: gpt-image-2 | 使用 3.0.3 或更新版本，Images 专用接口不再受聊天目录限制。有登录优先官方，无登录直接 API；API 需配置生图模型。见 [修复与验证](image-generation-fix-2026-09-30.md)。 |
| HTTP 500、TLS、上游限流 | 本地格式转换无法修复上游网络、账号或网关配额问题。 |

## 验证范围

自动测试覆盖消息副本不变性、可读思考保留、SSE 分片、工具转换、HTTP/WS 路由、认证头隔离、模型排序、缓存过期、无登录目录、设置恢复、安装幂等与迁移保护。测试成功说明这些本地逻辑通过，不代表所有远程模型或官方服务当前可用。

`tests/catalog-refresh-test.mjs` 覆盖旧缓存版本与当前内核版本不同、运行时合并目录刷新、官方目录完整透传、并发刷新顺序、304/错误与本地写入失败隔离，以及 GPT 别名继承旧 `base_instructions` 和新 `model_messages` 两种结构。`tests/launcher-test.ps1` 验证版本来自匹配当前安装包的内核，解析失败时不编造版本。设置 `CODEX_CLI_PATH` 后运行 `npm run test:native-catalog`，在隔离目录通过原生 `config/read` 和 `model/list` 检查生成的菜单；`model/list` 可能在配置错误时退回默认目录，因此不能单独作为配置验证。

当前还有 225 组跨模型协议组合、14 个模型的实际原生 app-server 切换/恢复测试，以及真实模型接口验证。具体功能、网络与能力排除项见 [2026-09-28 验证记录](model-verification-2026-09-28.md)。受控端点通过、真实模型通过、能力排除和未执行必须分别记录。

3.0.6 另补测 14 个模型的无官方登录模式：设置 `CODEX_CLI_PATH`、`EXTENDED_NATIVE=true`、`NATIVE_API_ONLY=true` 后运行 `tests/native-switch-test.mjs`，模型取自当前 `data/cache/catalog-state.json` 的 `gatewayIds`，`NATIVE_SWITCH_REPORT_NAME` 指定结果文件名（无需 `.json` 后缀）。这里实际执行原生本地工具，但模型输出使用隔离上游；不要将其写成逐个真实模型能力验证。Fast、浏览器及网络的修复和剩余限制见 [验证记录](browser-fast-network-fix-2026-10-10.md)。

3.0.8 补充纯 API 图片文件 ID 的 Responses 原样转发与 Chat 明确错误回归，确保有/无残留官方登录均不访问官方文件服务。新包验证和浏览器最终边界见 [功能修复记录](function-repair-2026-10-11.md)。

3.0.9 增加独立 `chatgpt-apionly` 入口，官方入口停用网关目录、请求与生图回退；网关使用 SSH 时，官方入口也不建立该网关隧道。登录状态、HTTP/WS 路由、图片通道、独立模型偏好与快捷方式测试见 [入口拆分记录](entry-split-2026-10-11.md)。Linux 仍仅提供原来的单一 provider 入口。

Windows PowerShell 脚本使用 UTF-8 BOM，以避免 5.1 把中文当作系统代码页解释。
