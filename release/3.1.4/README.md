# ChatGPT API 3.1.4

| 平台 | 安装包 |
| --- | --- |
| Windows x64 | [ZIP](ChatGPT-API-Launcher-3.1.4-win-x64.zip) |
| Linux x64 | [tar.gz](ChatGPT-API-Provider-3.1.4-linux-x64.tar.gz) |
| Linux ARM64 | [tar.gz](ChatGPT-API-Provider-3.1.4-linux-arm64.tar.gz) |
| macOS Apple Silicon | [DMG](ChatGPT-API-Provider-3.1.4-macos-arm64.dmg) |

支持新版原生客户端的 `response.interrupt` 中断协议。网关路径按响应 ID 停止对应请求，返回中断确认和结束事件，仅保留已完成的原始输出，随后可在同一对话继续；官方模型保持原样透传。中断不会补全未完成的文本或工具参数，不新增提示词，不改写已有聊天历史，不影响同一连接上的其他响应。

Windows 和 macOS 提供官方、混合与 API-only 三个入口；Linux 仅提供自定义 API provider。使用前需安装对应平台的官方客户端。适配层保留完整原生指令模板、工具与历史转换、Fast 档位和模型上下文容量缓存；生成、上下文压缩及生图不设置本地响应等待上限，不增加网络重试。模型目录在启动时刷新，不定时轮询。

Windows 完整解压后运行 `安装.cmd`；Linux 解压后运行 `./install.sh`；macOS 只发布一个 DMG，内含三个入口 App，拖入“应用程序”安装。更新前完全退出客户端，Windows 也需退出托盘；更新保留原有 URL、Key、登录和聊天。更新后重新打开入口以加载新版适配层。

macOS 为 Apple Silicon / ARM64，采用 ad-hoc 签名，没有 Developer ID 和 Apple 公证；首次打开按“系统设置 → 隐私与安全性 → 仍要打开”允许。发布包包含运行时及依赖，不包含个人 Key、登录、聊天、运行缓存、日志或测试结果，不附带独立 `.sha256` 下载文件。

[完整使用说明](../../README.md) · [消息转换协议](../../docs/message-protocol.md)

验证范围：15 组适配层回归通过，本机新版 CLI 已隔离验证网关 GPT 的生成中追加消息，以及 GPT、阿里云 Responses、词元 Chat 的停止后续聊。Windows 独立安装／更新、Linux x64 安装／更新与中断协议、Linux ARM64 包结构、macOS DMG 三入口资源及签名结构检查通过。上游使用模拟服务；Mac 真机 GUI、TCC、Keychain、Gatekeeper 和 Linux ARM64 执行未进行验证。
