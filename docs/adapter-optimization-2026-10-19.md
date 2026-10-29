# 适配层优化与验收

日期：2026-10-19。优化在 3.1.2 源码上完成验证，并纳入 3.1.3 发布范围；发布包见 `release/3.1.3`。

## 已完成

1. 官方 Codex HTTP 请求缺少压缩时补充无损 zstd，仅在体积减小时使用。已有压缩且无须转换的请求保持原始字节；网关不假定支持压缩。
2. 模型生成、上下文压缩及生图请求的 `headersTimeout`、`bodyTimeout` 显式为 0。目录、文件下载与连接建立的期限保留。取消、客户端断开、终止事件和异常提前退出均回收上游响应，包括 gzip 等解压流。
3. 非 GPT 模型继承完整原生指令对象及变量，移除自写基础提示词和工具纠错话术。纯 API 兜底使用原生 CLI 0.163.0-alpha.10.2 的内置指令快照；其余既有兼容能力字段逐项验证未变。原生目录可用时优先使用原生目录。
4. 本地无效请求、未知模型、上游内容类型错误与连接超时使用对应状态和错误代码。上游 HTTP 错误保持原状态和正文；WebSocket 转发保留完整上游错误对象。

没有改动官方客户端、登录文件、代理设置、聊天历史、提供方热切换或增加网络重试。Windows、Linux、macOS 启动器的代码标识同步包含模板，防止复用模板版本不同的路由。

## 验证结果

| 验证 | 结果 | 范围 |
| --- | --- | --- |
| 协议回归 | 14 组通过 | 工具、历史、结构化输出、上下文、图片引用／生图、重连和入口范围 |
| 原生客户端混合模式 | 当前 13 个网关模型通过 | 官方与网关切换、真实补丁及终端工具、原生文本／远程压缩协议、暂停续聊、MCP、计划、会话管理 |
| 原生客户端纯 API 模式 | 当前 13 个网关模型通过 | 无官方登录的工具执行、网关模型切换、暂停续聊与原生文本压缩 |
| 原生 Fast | 混合与纯 API 各 4 个 GPT 别名通过 | 原生菜单和实际 `service_tier=priority` 请求 |
| 超过旧响应期限 | HTTP、网关 WS、生图均等到第 128 秒并完成 | 隔离上游延迟响应，不依赖外网 |
| 连接生命周期 | 通过 | 完成但不关闭 HTTP、压缩流、Chat 最后 usage、暂停、错误内容类型 |
| Windows 入口 | 通过 | 三入口、配置恢复、登录文件保护及快捷方式 |
| Linux 运行 | WSL Ubuntu 22.04、Node 25.8.2 通过 | 共用适配器端到端测试 |
| macOS 入口逻辑 | 跨平台逻辑与 POSIX 进程夹具通过 | 三入口、LaunchServices 调用参数、模型与压缩请求、配置恢复 |

原生运行测试使用本机未修改的 Windows CLI 和隔离模型端点，真实工具只操作测试目录。上述结果证明适配链路及客户端协议行为，不代表真实上游的网络、模型生成质量或能力。没有在 macOS 真机测试 GUI、TCC、Keychain、Gatekeeper 或语音。

原生模板已验证：基础指令、权限、默认／计划模式及多代理指令与原生对照一致，9 个非 GPT 模型的 18 种消息转换保留文本、顺序和重复次数。

## 本机启用与旧对话

三个桌面快捷方式均引用本目录。当前活动客户端和路由保持运行；完全退出客户端（包括托盘）后，重新打开入口加载本次代码与模板。

原生客户端保存旧对话创建时的基础指令。重新启动不会替换这段旧内容；适配层继续完整转发它。新对话立即采用新模板。已有对话若需要应用新基础指令，可切换到另一模型并正常续聊一轮，再切回原模型；原生客户端生成 `model_switch` 更新。此行为已用隔离旧对话验证，没有自动插入消息或重写历史。

## 记录

- `data/diagnostics/optimization-protocol-suite.json`
- `data/diagnostics/optimization-native-mixed.json`
- `data/diagnostics/optimization-native-apionly.json`
- `data/diagnostics/optimization-native-fast-mixed.json`
- `data/diagnostics/optimization-native-fast-apionly.json`
- `data/diagnostics/adapter-optimization-results-long.json`
- `data/diagnostics/native-instruction-audit-2026-10-19.json`
- `data/diagnostics/native-template-resume-result.json`
- `data/diagnostics/optimization-posix-macos-entries.log`
- `data/diagnostics/optimization-linux-adapter.log`

本次修改前的文件快照保存在 `data/diagnostics/adapter-optimization-baseline-Q4nLL5`，已有未提交修改保留。
