# macOS 隔离测试

构建和测试环境为 Windows 与 WSL/Linux，没有真实 Mac。模型端点、凭据、会话、终端文件和 MCP 服务均使用隔离测试数据。

| 范围 | 检查内容 |
| --- | --- |
| macOS 启动器与 POSIX 进程 | LaunchServices 命令经隔离 open 替身执行、原 CODEX_HOME 与参数传递、启动失败恢复、启动期间入口互斥、新版 CodexCLI.app 内置 CLI 自动定位及两种旧版路径、官方无 API Key、混合入口登录/未登录、原生账号读取回退、API-only、退出恢复、语言设置和凭据/聊天文件保留 |
| 消息与请求 | HTTP、SSE、WebSocket、工具输入/输出与历史、结构化输出、Fast 档位、官方压缩请求和模型目录范围 |
| 原生内核 | macOS 生成的配置交给未修改的 Windows app-server；实际执行终端、补丁、MCP、计划/提问、取消/续聊、会话管理、同一会话双向切换及原生压缩 |
| 协议适配 | GPT、阿里云订阅、词元计划、vLLM 路线；图像生成/编辑、身份隔离、官方不可用回退和多模态消息格式 |
| DMG | 三个聊天 App 与控制台 App 的麦克风／摄像头／系统音频／Apple Events／相关应用数据与文件夹用途声明、ARM64 Mach-O、当前源文件清单、执行权限、官方 Mac 图标资源、ad-hoc 代码页与资源哈希 |
| 图形配置逻辑 | 聊天与控制台入口参数、取消、粘贴菜单、用户主动读取剪贴板、隐藏密钥、密钥不进入命令行参数、安装和更新 |

上述检查验证客户端协议和启动器行为，不代表真实上游模型具备测试端点模拟的所有能力。

无法在当前环境实测：macOS LaunchServices 与窗口点击、真实 Keychain 访问/授权、Gatekeeper 首次放行、系统剪贴板键盘操作，以及依赖平台或官方在线身份的浏览器和插件界面。这些项目不标记为通过。

相关脚本：

- `tests/macos-platform-test.mjs`
- `tests/macos-dmg-gui-test.mjs`
- `tests/macos-provider-test.mjs`（POSIX）
- `tests/macos-entries-test.mjs`（POSIX）
- `tests/native-switch-test.mjs`（`NATIVE_MACOS_CONFIG=true`，本机使用 Windows 原生内核）
- `tests/macos-dmg-test.py`
- `package.json` 中的消息、路由、目录、图片与断线回归测试

macOS 发布目录只提供 DMG，不附带下载包校验文件。provider 归档仅作为构建过程中的临时中间文件。

容量缓存、可配置的默认 500k 上限、多来源 URL / Key、控制台认证及恢复设置均有隔离测试。真实 macOS LaunchServices 启动、TCC 权限归属、Dot 实际通话、浏览器权限、界面与钥匙串仍需在 Mac 上确认；用途声明与签名检查通过不代表系统已经授权。
