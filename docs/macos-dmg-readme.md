# chatgpt-apionly 3.0.9 — macOS DMG

适用于 Apple Silicon / ARM64。只需下载一个 DMG，里面是 **chatgpt-apionly.app** 和 Applications 快捷方式；安装和日常启动不再需要点击 .command 文件。

## 安装与首次打开

1. 先安装官方 ChatGPT macOS 客户端，完全退出当前客户端（Command-Q）。
2. 打开 ChatGPT-API-Provider-3.0.9-macos-arm64.dmg，把 chatgpt-apionly.app 拖到 Applications（应用程序）。
3. 从“应用程序”打开 chatgpt-apionly。如果系统提示“无法验证开发者”或“Apple 无法检查恶意软件”，关闭提示，进入“系统设置 → 隐私与安全性 → 仍要打开”，再确认“打开”。
4. 第一次启动会显示图形窗口，填写自定义 API 基础 URL 和 API Key。密钥输入隐藏，不会作为命令行参数传递。
5. 配置完成后自动启动原生客户端。以后双击 chatgpt-apionly.app 即可。

目前没有 Apple Developer ID 证书，本包只有用于文件完整性校验的 ad-hoc 签名，没有 Apple 开发者身份认证或公证。DMG 本身不能免除这次手动允许。正常允许流程见 Apple 官方说明：
https://support.apple.com/zh-cn/102445

如果系统提示“包含恶意软件”或“已损坏”，不要将其当作同一种开发者提醒；先核对下载包 SHA-256 并检查文件是否被修改。

## 数据与功能

运行程序和 API 设置保存在：
~/Library/Application Support/chatgpt-apionly

沿用旧版默认目录中的 data，不把密钥、缓存或登录数据写进 App 本体。更新时替换“应用程序”中的 App，再从新 App 启动；更新程序文件前需要完全退出原生客户端。

模型目录、对话与生图全部使用网关；保留既有 3.0.9 的消息转换、工具调用、历史和流式处理，不启用官方模型或生图回退。原生客户端的配置与聊天记录仍使用原来的 CODEX_HOME，不复制对话、不增加消息、不改原生客户端文件。

已有官方登录不会被拿来认证网关，也不会被删除。只有模型网关 Key 无法替代浏览器或插件服务自身要求的官方身份。

需要更换 URL / Key 时，完全退出原生客户端后，可用 macOS 自带的 open 命令打开同一 App 的图形配置：

    open -a chatgpt-apionly --args --configure

这个命令打开的是 App，不执行 .command 脚本。首次安装和日常启动都无需终端。

API Key 仍保存在程序目录的 data/.env，仅当前用户可读写。旧版自定义图片模型与编辑格式设置会保留。其他功能、模型能力和原生服务的边界与 3.0.9 provider 包一致。

## 验证范围

发布检查验证 UDIF/HFS+ 格式、磁盘映像解包、App 结构、Mach-O ARM64、ad-hoc 代码签名的页哈希及资源封装、278 个原 provider 文件保持不变，以及图形配置控制逻辑的安装、更新、取消与凭据保护。

当前构建机为 Windows，DMG 在 WSL 中交叉构建并做结构、文件系统与内容验证；这不等于已经完成真实 Mac 上的 Gatekeeper 首次放行和图形界面实测。包内没有个人凭据或聊天数据。
