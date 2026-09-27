# 逐模型验证记录 · 2026-09-27

结论：已修复本次发现的本地消息转换问题。10 个非 GPT 模型均有成功的原生工具执行、文本压缩和压缩后续聊记录；个别重复测试存在上游空响应或错误答案。4 个网关 GPT 模型维持原生协议，测试受到上游 TLS/繁忙错误影响，未将受阻项目标成通过。

**生效状态：源码已更新；正在运行的 8102 转发进程仍是旧版本。自动审批拒绝了重启操作，只返回 blocked by policy。正常退出客户端后重新打开 chatgpt-api，启动器会加载已验证的新代码。** 没有通过修改客户端配置绕过这一限制。

## 验证方式

- 离线：历史不变性、工具参数与命名空间、Unicode/SSE 分片、Chat/Responses 等价、并行与延迟参数、响应 ID、Lite 历史、双向切换、重连、认证隔离及 Windows 启动器检查。
- 真实协议：14 个模型分别通过临时本地转发器调用现有网关；检查实际发给上游的消息，再将已有工具结果回传。官方/网关切换检查已有助手随机标记及工具历史，不依赖额外提示词修复。
- 原生客户端：使用本机安装的 Codex 0.158.0-alpha.2.1 app-server，临时 CODEX_HOME 与 ephemeral 对话。实际调用 audit.read_fixture，通过原生 exec/动态工具机制取得文件标记，触发 thread/compact/start，再检查续聊。
- 所有隔离实测报告的真实 config.toml/auth.json 哈希检查均保持一致；原生测试的持久化 session 文件数量为 0。

“通过”指相应协议链路确实执行成功；不代表模型永远遵循指令。“网络排除”“模型输出排除”“能力排除”保留为独立结论，不累计为通过。

## 14 个模型

| 模型 | 工具与历史协议 | 原生工具执行 | 原生文本压缩/续聊 | JSON Schema | 官方↔网关实测 |
| --- | --- | --- | --- | --- | --- |
| GPT/gpt-5.6-terra | 上游网络受阻 | 通过 | 压缩通过；续聊繁忙 | 网络排除 | 网络排除 |
| GPT/gpt-6-astra | 部分请求网络受阻 | 实际回调成功；后续繁忙 | 未完整验证，服务繁忙 | 通过 | 网络排除 |
| GPT/gpt-6-luna | 上游网络受阻 | 通过 | 压缩通过；续聊繁忙 | 网络排除 | 网络排除 |
| GPT/gpt-6-sol | 自定义/动态并行工具、历史通过；后续 TLS 错误 | 原生专项被服务繁忙阻断 | 未完整验证，服务繁忙 | 网络排除 | 网络排除 |
| vllm/qwen3.8-flash-next | 通过，含同模型思考回传 | 通过 | 通过 | 通过 | 官→网通过；网→官字段修复经回放验证，修复后真实请求被 TLS 阻断 |
| 词元计划/deepseek-flash | 通过，含同模型思考回传 | 通过 | 通过 | 通过 | 双向通过 |
| 词元计划/deepseek-flash-2 | 通过，含同模型思考回传 | 通过 | 通过 | 通过 | 最终复测网络排除 |
| 词元计划/glm-5.3-flash | 通过 | 有成功记录；重复测试有上游空响应 | 有完整成功记录；空响应轮次无法核对工具标记 | 通过 | 网→官通过；官→网网络排除 |
| 阿里云订阅/deepseek-v4-pro | 通过，含同模型思考回传 | 通过 | 通过 | 通过 | 网→官通过；官→网网络排除 |
| 阿里云订阅/deepseek-v4.1-flash | 通过 | 通过 | 通过 | 上游拒绝此 response_format，能力排除 | 网络排除 |
| 阿里云订阅/glm-5.2 | 通过，含同模型思考回传 | 通过 | 通过 | 通过 | 双向通过 |
| 阿里云订阅/glm-5.3 | 通过 | 通过 | 通过 | Schema 已正确发送，上游返回错误字段名，输出排除 | 网→官通过；官→网网络排除 |
| 阿里云订阅/qwen3.8-flash | 通过，含同模型思考回传 | 通过；模型曾未复述实际结果 | 通过 | 通过 | 双向通过 |
| 阿里云订阅/qwen3.8-max | 通过，含同模型思考回传 | 通过 | 通过 | 通过 | 网络排除 |

部分请求没有返回可读思考，不虚构思考内容来“通过”该项。所有非 GPT 模型的自定义工具、动态命名空间工具与类型参数均有成功协议测试。

## 发现并修复的问题

1. 官方 Lite 的终帧 output 为空时，旧缓存漏掉已经发出的助手/工具项目。改为收集实际 output_item.done，完整对象缓存与客户端格式一致。
2. 动态工具载体留在历史正文中，切回官方会被拒绝。定义移回 tools，调用及结果的 call_id 保留。
3. 同模型思考被当作跨模型内容处理。现在按来源模型区分；词元用 Chat reasoning_content 承载，阿里云/vLLM 保留原生 reasoning。
4. 阿里云部分 Responses 请求忽略结构化输出字段。仅该类请求使用 Chat response_format，保留完整 Schema。
5. 错误的自定义工具包装可能被误当原始输入。只接受字符串 input，显式拒绝错误外层；不修复模型代码。
6. 名称晚到、参数先到、并行及最终项可能导致参数丢失/重复完成。按索引汇集，保证完整输入和单次完成事件。
7. vLLM/Bifrost 的 reasoning 缺少必需 summary，message 又可能带空 summary；上游流内 ID 还可能变化。补空协议容器、移除无内容的错位字段、稳定项目 ID；不修改正文。
8. Chat 的空 token 明细导致原生客户端缺字段解析失败。缺少计数时不发送不完整明细，不猜测数值。
9. 原生客户端默认声明 web_search。该声明原样交给已验证接受扩展声明的上游，不在本地把整个请求拦下。

上述修复没有增加新的基础指令、任务提示词或摘要提示词；原有工具兼容说明保持不变。

## 明确排除和限制

- Qwen Flash 曾在实际工具结果已经完整回传后输出 `audit` 或 `NATIVE-CALL`，随后压缩续聊却能返回正确标记。原始上游请求和客户端回调均核对过，属于输出行为，不修改答案。
- 词元 GLM 某些请求的上游 SSE 只有 role 和 stop、没有正文/工具调用。本地未吞掉它的内容；成功记录与这些空响应都保留，不将空答伪装成成功。
- GPT 网关模型的 TLS、超时、high demand 作为网络/服务排除，未修改代理、重试、并发或服务端配置。
- 识图等模型不具备的能力、思考档位以及官方也不能使用的功能未加入适配验收。
- 普通文本压缩已实测可用。官方加密 compaction 块跨厂商仍不能无损转换，遇到时明确报错。不会自行补写摘要、删除该块或改历史。
- 验证覆盖原生客户端共用的消息、工具和压缩链路；没有声称逐个插件、第三方工具业务或所有输入模态都经过实测。

## 复现与本机证据

默认离线回归：

```powershell
npm test
npm run test:windows
```

单独运行真实验证，会使用本机配置和账号发送请求：

```powershell
./runtime/node.exe tests/live-models.mjs
./runtime/node.exe tests/native-client-live.mjs
# 可传模型名片段，只测一个模型
./runtime/node.exe tests/native-client-live.mjs '阿里云订阅/glm-5.3'
```

本机原始结果位于 data/diagnostics（不提交 Git，不含认证请求头）：

| 文件 | 内容 |
| --- | --- |
| protocol-live-models.json | 14 模型首轮协议测试，包含修复前发现的问题 |
| protocol-live-models-selected.json | vLLM 修复后协议验证 |
| protocol-live-models-deepseek2-final.json | 词元 DeepSeek Flash 2 最终协议验证 |
| protocol-native-client.json | 14 模型首轮原生客户端验证 |
| protocol-native-client-final.json | 最终版本 10 个非 GPT 模型原生客户端复测 |
| protocol-native-client-glm-passed.json | 词元 GLM 原生工具、压缩、续聊完整成功记录 |
| protocol-native-client-retry-first.json | GPT 复测及上游繁忙记录 |
| protocol-vllm-events.json | vLLM 字段问题原始流，已用于修复后回放验证 |
| protocol-vllm-switch-final.json | 修复后真实切回官方的 TLS 阻断记录 |
| protocol-deployment.json | 代码版本及等待正常重启的状态 |

历史失败记录保留用于追溯；不要将首轮失败误读为修复后的最终结论。协议本身见 [完整转换协议](message-protocol.md)。
