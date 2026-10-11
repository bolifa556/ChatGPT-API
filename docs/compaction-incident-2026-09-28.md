# 混合对话压缩故障与提供方切换

日期：2026-09-28。安装版本：OpenAI.Codex 26.924.2738.0 / app-server 0.158.0-alpha.2.1。故障版本：适配器提交 `9150b46`。

状态：协议保护、启动时双向提供方修复及回归测试已写入安装目录，尚待用户完全退出桌面后重新打开生效。没有强制关闭正在运行的客户端，也没有修改两个故障对话的消息。**模型菜单即时切换提供方尚未接入；不能将本次启动修复说成无需重开的全自动切换。**

## 生产证据与根因

| 对话 | 保存的 provider | 故障时模型 | 故障时间（北京时间） | response_item / compacted 数量 |
| --- | --- | --- | --- | --- |
| 大物数据处理 | openai | 阿里云订阅/qwen3.8-max | 18:30:51 | 144 / 0 |
| mc航空学 | openai | 阿里云订阅/qwen3.8-max | 18:34:59 | 319 / 0 |

两条对话均报 `remote compaction v2 expected exactly one compaction output item, got 0 from 3 output items`。对应网关请求返回 HTTP 200 和普通工具调用，不是网络中断。原始历史仍在，没有成功压缩后的替换历史。

旧混合入口把官方和网关模型放入同一个 `openai` 提供方目录。安装版本依据提供方选择压缩协议，而非依据当前模型名称。于是非 GPT 对话也发出官方远程 v2 控制项目 `compaction_trigger`；该项目通过普通 `/responses` 发送，不是 `/responses/compact`。

适配层原先只拒绝非 GPT 的 `/responses/compact` 和不透明 `compaction` 历史，漏掉了 `compaction_trigger`，将其交给普通模型生成。普通输出不满足客户端对专用 compaction 项目的要求。这是提供方绑定与控制项目转发的错误，不是“Qwen 或 GLM 不会压缩”。

## 已实施的改动

1. 非 GPT 的 `compaction_trigger` 在附件下载、上游调用前明确返回 `incompatible_compaction_provider`，提示退出重开修复绑定。不会把普通回答伪造成压缩项目。官方请求的控制项目保持原协议。
2. 为网关对话定义 `chatgpt_api_mixed`：保留原生 OpenAI 账号认证，由客户端选择自己的文本压缩流程；无需登录时继续使用 `chatgpt_api_launcher`。不增加摘要提示词或独立压缩任务。
3. 启动器按初始选中模型选择提供方。官方模型选择 `openai`，包括从 API 入口启动的官方模型；不再把所有 API 入口对话统一改成自定义提供方。
4. 桌面未运行时，修复助手通过原生 API 检查已知提供方的非归档对话：模型为网关模型、提供方为 `openai` 时更正为网关提供方；模型为官方模型、提供方为本启动器的旧自定义提供方时恢复 `openai`。未知模型、未知自定义提供方和已有正常文本压缩的旧网关提供方不作强制迁移。
5. 更正使用 `thread/resume`，保留模型名、threadId 和原有消息。原生客户端自行保存设置元数据；助手不直接编辑 rollout 或数据库，不发送聊天消息，不执行用户任务。重复执行不会再次更正已匹配的对话。
6. 助手只使用与安装包内原生可执行文件 SHA256 完全一致的客户端自有缓存副本，不复制、修改或替换客户端。新版本缓存尚未生成时记录待修复，待原生客户端初始化后下次启动再处理。

官方模型请求仍直接去 OpenAI，不经过 211 网关或非 GPT 转换；提供方恢复 `openai` 后，官方远程压缩也恢复。没有增加网络重试。登录文件、语言偏好、思考档位和用户任务文件未改。

## 切换提供方的实测边界

使用安装的原生 app-server、隔离 CODEX_HOME、无效测试账号和本机受控端点：

| 操作 | 实测结果 |
| --- | --- |
| openai + 非 GPT；关闭旧 remote_compaction_v2 feature | 仍发送 compaction_trigger，旧开关不生效 |
| use_responses_lite=false / supports_experimental_context=false | 不改变远程压缩选择 |
| 自定义提供方 name 恰为 OpenAI | 仍进入远程压缩 |
| 正常命名的自定义提供方 | 客户端自行发送内置文本压缩提示 |
| 仅切模型；给 turn/start 或 thread/settings/update 添加 modelProvider | 模型变化，活动提供方不变；后两者的安装版本 Schema 没有该字段 |
| 对已加载对话直接 thread/resume，指定另一提供方 | 仍使用活动提供方 |
| 同一原生连接上 thread/unsubscribe 后 thread/resume | 同一对话成功切换提供方；本机版本可立即恢复官方远程压缩 |
| 重启 app-server 后 thread/resume，指定 openai | 同一对话成功恢复官方远程压缩 |

“监听当前对话选择的模型 → 调用原生会话切换”有可验证的操作基础；监听可用模型目录或只改 config.toml 都不足够。桌面模型菜单没有执行这组提供方切换操作。HTTP 兼容层收到请求时，客户端已经决定使用哪种压缩。

补测已发现重载的明确副作用：同一控制连接上的 unsubscribe/resume 虽保留聊天历史，却清空了测试代码执行器的 store/load 状态，重建测试 MCP 进程，并使后台终端列表由 1 变为 0。另一条同时加载的对话状态延续正常。不能把“同一 threadId、历史不变”扩大为“活动工具状态不受影响”，也不能仅等到一轮结束就静默重载。

要实现不丢运行状态的即时自动联动，需要原生支持原位更换 provider；安装版本尚未找到这样的接口。目前未接入常驻控制通道。只读检查发现 `CODEX_APP_SERVER_WS_URL`、`CODEX_CLI_PATH` 等替换入口，但它们会改变原生连接或启动分支，不能仅凭这些入口就保证官方功能完全保留。没有为此修改原生前端、替换原生后端或重启全部活动任务。有限自动化只能考虑原生新建或已经自然卸载后的恢复，不能主动强制卸载；详见 [自动切换方案](automatic-provider-switch-design.md)。

当前可用路径是：选择目标模型后，完全退出桌面并重开，由启动器按保存的模型恢复对应提供方。尚未重新加载时，官方模型请求虽然仍去 OpenAI，但不能承诺已恢复全部官方提供方行为。

官方远程压缩产生的不透明加密状态，仍不能被无损翻译给其他厂商模型；恢复 `openai` 不会消除再次切回网关时的限制。部分官方前端功能按提供方 ID 开放，自定义提供方状态下不能声称完全等价。

## 验证结果

- 默认七组协议回归、Windows 启动配置与恢复测试通过。
- 15 个目录模型通过受控原生测试：官方 → 网关、重新加载提供方、网关文本压缩与工具执行，再切官方并重新加载后执行远程 v2 压缩；包含 MCP、补丁、终端、计划提问、媒体结果、中断、继续与对话管理。真实推理结果另列。
- 旧错误绑定的修复保持 threadId 和原始 response_item / compacted 项目不变；纯官方对话不迁移，重复修复无变化。
- 真实上游的原生工具、文本压缩、压缩后标记回忆完整通过 11 个模型：阿里云 6 个、词元 3 个、vLLM、GPT/gpt-6-sol。词元 GLM 首次返回空结果，单独复测三项均通过。
- GPT/gpt-5.6-terra、GPT/gpt-6-astra、GPT/gpt-6-luna 被连接或高负载错误阻断；新增 GPT/gemini-3.8-flash-high 被 Google 账号验证要求阻断。未计为通过。
- 真实模型测试使用 ephemeral 对话，真实 config.toml / auth.json 哈希不变，真实聊天目录新增会话文件为 0。

两个用户对话的只读预检均准确列为候选；活动桌面中的绑定尚未强行改动。生效需要完全退出后重新打开入口。

## 先前验证遗漏与独立问题

先前真实压缩测试使用自定义 `protocol_probe`，原生混合切换测试却没有调用压缩，漏掉了生产 `openai` + 非 GPT 组合。不能把那两组通过记录拼成生产混合压缩已通过。旧报告已标明更正。

“大物数据处理”的后台描述另有 `Invalid 'input[138].name'`，历史中有 `function_call.name = tools.view_image`，“mc航空学”没有。这不是共同压缩根因，本次未改原历史来掩盖该独立错误。

测试期间曾将网关密钥误放进隔离账号的 OAuth 字段，可能随原生后台认证请求发给 OpenAI；观测到认证请求返回 401。该轮已停止，相关测试 auth 文件已替换为无效值，测试代码改用固定无效 OAuth token，随后重新验证。生产 auth.json 未改，网关密钥尚未轮换。建议因这次潜在泄露轮换该密钥；测试修正不等于撤销已发出的凭据。

## 本机证据

以下文件均在 Git 忽略的 data/diagnostics，不发布私人运行资料：

- compaction-incident-threads.json：两条对话的错误、提供方、历史计数。
- compaction-production-repair-preview.json：两个用户对话的只读候选检查。
- compaction-native-rebind-proof.json：更正提供方后原始项目不变。
- native-provider-transition-result.json：七种切换操作及压缩请求形态。
- native-provider-runtime-result.json：重载前后代码执行器、测试 MCP、后台终端、历史与另一对话状态的对照。
- native-compaction-provider-roundtrip-final.json：15 个模型双向恢复和原生功能回归。
- compaction-fixed-native-live.json、compaction-fixed-native-ciyuan-recheck.json：真实上游结果。

[官方 App Server 文档](https://learn.chatgpt.com/docs/app-server) 说明恢复配置和连接订阅；即时卸载行为以上述安装版本实测为准。[官方配置参考](https://learn.chatgpt.com/docs/config-file/config-reference) 区分模型和提供方配置。[Compaction](https://developers.openai.com/api/docs/guides/compaction) 说明不透明压缩项目，不能用普通摘要冒充。
