# 自动切换提供方：方案与实测限制

日期：2026-09-28。范围：安装的 OpenAI.Codex 26.924.2738.0 / app-server 0.158.0-alpha.2.1。

本轮只调查和运行隔离测试，没有接入常驻控制桥，没有修改原生客户端或切换用户的活动对话。

## 结论

触发来源应当是**当前对话选择的模型**，不是可用模型目录发生变化。真正需要更换 provider 的操作位于桌面与原生 app-server 之间的 JSON-RPC 控制连接；HTTP 消息转换器收到推理请求时，原生客户端已经选择了压缩方式。

自动触发本身可以设计，但目前已验证能改变活动 provider 的 `thread/unsubscribe → thread/resume` 会重建该对话的运行环境，不能满足“不影响其他功能”。因此不建议现在把这套重载操作挂到模型菜单上，也不建议仅为此接入常驻控制桥。

当前建议保留启动时修复。将来的自动接入仅处理原生的新建、自然卸载后的恢复；正在加载的对话要实现无损即时切换，需要原生支持只更换 provider、保留运行环境的接口。安装版本尚未找到这样的接口。

## 实测发现的副作用

测试使用安装版本的原生可执行文件、隔离 CODEX_HOME、本机受控推理端点和固定无效账号信息。没有使用用户的真实聊天或上游密钥。

在一条对话内写入代码执行器状态、启动测试 MCP 服务与后台终端，然后在同一控制连接执行 unsubscribe 和指定 openai 的 resume：

| 检查项 | 实测结果 |
| --- | --- |
| threadId、已保存的 response_item / compacted 历史 | 保持不变 |
| provider | 成功切换为 openai |
| 代码执行器 `store/load` 状态 | 原值 `TARGET_MEMORY` 变为 null |
| 测试 MCP 进程 | PID 31252 变为 31824，计数从 2 重置为 1 |
| 原生后台终端列表 | 从 1 个变成 0 个，原 session 不再列出 |
| 审批方式、目录、工作区、沙盒、禁用插件、服务档位 | 保持不变 |
| 另一条同时加载的对话 | 内存值、MCP 进程及计数延续正常 |

“没有正在生成回答”不能证明“没有需要保留的运行状态”。仅检查 turn 是否结束、工具调用是否结束或终端列表是否为空，都不足以安全决定强制重载；MCP 与代码执行器仍可能有跨轮状态。测试证明的是当前版本、当前测试会话的行为，不能扩大成所有工具实现的统一结论。

本机证据：`data/diagnostics/native-provider-runtime-result.json`；测试脚本：`data/diagnostics/native-provider-runtime-probe.mjs`、`fixture-provider-runtime.mjs`。测试已退出，未遗留本次测试进程。

## 如果以后接入自动触发通道

可评估一个只处理会话控制参数的 RPC 转发层：

```text
原生模型菜单
    ↓ 原生 thread/start、thread/resume、thread/settings/update、turn/start
会话控制转发层：读取本次实际选择的 model，按 threadId 判断 provider
    ↓ 使用原生已支持的参数；其余调用、通知、返回结果原样转发
同版本原生 app-server
    ├─ 官方模型：openai → 官方推理与官方远程压缩
    └─ 网关模型：网关 provider → 现有适配层与原生文本压缩
```

其中，“GPT/...”一类网关目录里的模型仍属于网关。分类依据实际目录归属和明确的路由表，不能仅凭名称含 GPT 或前缀猜测。

自动处理范围必须限定如下：

| 时机 | 处理方式 | 安装版本状态 |
| --- | --- | --- |
| 新建对话 | 根据所选模型给 thread/start 指定 provider | 原生 API 支持；桌面自动桥未接入 |
| 对话已自然卸载，随后由桌面恢复 | 在这次原生 thread/resume 中指定对应 provider | 原生 API 支持；不得为了触发恢复而强制卸载 |
| 已加载对话，在同一 provider 内换模型 | 完整沿用原生模型切换，不重载 | 不需要提供方切换 |
| 已加载对话跨 provider 换模型 | 需要原生原位更换 provider 接口 | 当前不能保证运行状态保留；不自动执行重载 |
| 从托盘退出桌面，再通过入口启动 | 现有启动助手恢复匹配的 provider | 已有实现，磁盘版本待完整重启生效 |

即使实现上述有限的转发层，也必须按对话串行处理设置、下一轮发送和压缩，使用本次请求真正生效的模型（包括 collaborationMode 中的模型），避免依据过期的菜单事件切换。不能跨对话改全局默认值，不能重复提交用户消息，也不能伪造原生切换成功通知。

该方案不新增提示词、摘要或聊天，不复制、删改历史，不尝试导出并重建工具运行状态。官方远程压缩产生的不透明状态仍有跨厂商限制，provider 自动匹配不能解决该限制。

## 为什么当前不直接加一个监听脚本

- 安装版本的 `thread/settings/update` 与 `turn/start` Schema 没有 modelProvider；给它们添加未知字段没有实现活动 provider 更换。
- 对仍加载的对话调用带另一 provider 的 thread/resume，实测仍沿用活动 provider。
- 官方 Hooks 文档没有模型切换后原位修改 provider 的事件/API；UserPromptSubmit、PreCompact 也不提供此能力。通过钩子增加上下文不是本任务要求的消息转换。
- 轮询 config.toml、模型目录或数据库既不能可靠捕捉每个对话的最终选择，也不能改变已经加载的 provider。直接改保存文件还会与运行进程竞争。
- `CODEX_CLI_PATH` 和 `CODEX_APP_SERVER_WS_URL` 是已找到的控制连接替换入口，但前者会改变 Windows 原生包含核心的启动分支，后者是进程级配置，并非某条对话的开关。发现入口不等于验证全部原生功能兼容。
- 当前 Windows 桌面默认不是可直接附加的本地 daemon 控制连接；代码中的内置 daemon 接入分支排除了 Windows。另开一个 app-server 或外部连接，不能当成已控制桌面所属连接。

因此，本次不部署热切换监听器。启动修复是当前已验证的保守路径；若以后原生提供原位 provider 更新接口，再接模型选择事件，才能同时满足“即时自动切换”和“保留活动工具状态”。

参考：[官方 App Server 文档](https://learn.chatgpt.com/docs/app-server)、[官方 Hooks 文档](https://learn.chatgpt.com/docs/hooks)。订阅生命周期以安装版本实测为准；当前文档的无人订阅保留时长与本机观察并不相同，不能依赖 unsubscribe 后一定立即卸载。
