# 原生客户端消息转换协议

适用对象：本机 OpenAI.Codex 桌面客户端与 14 个已配置的网关模型。2026-09-27 核对。

## 目标与边界

客户端决定对话、工具执行、历史、模型切换和压缩。适配层只转换请求副本和响应协议，不生成用户/助手正文，不添加新的任务提示词，不替模型纠正代码，不改写客户端保存的历史，不另建聊天库。测试使用临时目录和原生 ephemeral 对话。

现有模型目录中的基础指令、自定义工具说明和跨厂商思考标注是原有兼容行为，本次保留；“没有新增提示词”不代表原有兼容层完全没有说明文字。另一个任务的重连修复保持有效。

网络、限流、上游繁忙、思考强度、模型缺少的能力（例如识图、联网搜索），以及模型自己生成错误参数、代码、答案或摘要，不属于本次转换修复。不会靠虚构能力、降低用户要求或注入额外指令掩盖失败。

## 各模型的传输选择

| 模型 | 常规请求 | JSON Schema / JSON Object 请求 | 思考历史 |
| --- | --- | --- | --- |
| GPT/gpt-5.6-terra | 原生 Responses | 原生 Responses | 原生 GPT |
| GPT/gpt-6-astra | 原生 Responses | 原生 Responses | 原生 GPT |
| GPT/gpt-6-luna | 原生 Responses | 原生 Responses | 原生 GPT |
| GPT/gpt-6-sol | 原生 Responses | 原生 Responses | 原生 GPT |
| 阿里云订阅/deepseek-v4-pro | Responses | Chat Completions | 同模型保留 |
| 阿里云订阅/deepseek-v4.1-flash | Responses | Chat Completions | 同模型保留；能力错误照常返回 |
| 阿里云订阅/glm-5.2 | Responses | Chat Completions | 同模型保留 |
| 阿里云订阅/glm-5.3 | Responses | Chat Completions | 同模型保留 |
| 阿里云订阅/qwen3.8-flash | Responses | Chat Completions | 同模型保留 |
| 阿里云订阅/qwen3.8-max | Responses | Chat Completions | 同模型保留 |
| 词元计划/deepseek-flash | Chat Completions | Chat Completions | reasoning_content |
| 词元计划/deepseek-flash-2 | Chat Completions | Chat Completions | reasoning_content |
| 词元计划/glm-5.3-flash | Chat Completions | Chat Completions | reasoning_content |
| vllm/qwen3.8-flash-next | Responses | Responses | 原始 reasoning content |

官方直连 GPT 也保持原生 Responses。网关 GPT 不进入非 GPT/Chat 转换，仅在混合历史需要时做 GPT 历史格式规范化。

采用一套共用转换器，不为每个模型复制实现。词元现有 Responses 入口无法完整承载其思考历史，Chat 入口能传递 reasoning_content；阿里云常规 Responses 能承载原生 reasoning，但实测部分模型忽略 Responses 的结构化输出字段，因此仅结构化请求走标准 Chat response_format。

## 客户端请求到上游

| 客户端字段或项目 | 转换规则 |
| --- | --- |
| model | 保留完整网关模型名，不替换模型，不猜测同名部署 |
| instructions、system、developer、user、assistant | Responses 原样保留；Chat 把 instructions 放入 system。词元保留 developer；阿里云 Chat 要求一个开头的 system，按原顺序合并现有 system/developer 文本，仅以空行分隔 |
| 客户端 model_switch 更新 | 保留原文和相应角色；经过 Chat 时按上述角色规则转换 |
| input_text、output_text | Chat 转为 text，字符串内容不改；原生 Responses 保持原格式 |
| input_image | Chat 转为 image_url，保留 URL/数据和 detail；是否识图由模型决定 |
| input_file | Chat 映射 file_id/file_data/filename；无法表示的 file_url 明确报错，不伪造文件内容 |
| input_audio、已有 image_url/file/refusal | 在支持对应 Chat 格式时保留原字段；不补做识别或转写 |
| function 工具 | 名称、描述、参数 Schema、strict 保留；Chat 放入 tools[].function |
| namespace 工具 | 展开为函数，并用命名空间与原名生成确定性的别名；返回时恢复原名和 namespace，避免重名冲突 |
| custom 工具 | 用 function 的单个字符串参数 input 承载原始输入；返回时解包，工具由客户端执行 |
| additional_tools 历史项目 | 把定义移入 tools；保留命名空间，当前定义覆盖旧定义；不将定义当作对话文字发送 |
| function_call / custom_tool_call 历史 | 保留 call_id、实际参数和顺序；自定义工具仅包一层 JSON 字符串参数。合法空字符串保留，缺失输入明确报错 |
| function_call_output / custom_tool_call_output | 保留 call_id 和原始结果。Chat 转为 role=tool、tool_call_id；内容只改外层格式 |
| auto/none/required、指定工具、allowed_tools | 依目标协议转换工具选择，别名与定义一致；不替用户选择另一种工具 |
| web_search 等上游扩展工具声明 | 保留声明，不因客户端默认声明了它就阻断普通请求；不模拟上游没有的工具能力 |
| text.format | Chat 映射为 response_format；json_schema 的 name/description/schema/strict 原样保留；不添加“请输出 JSON”提示词 |
| reasoning.effort | 按原值传递；Chat 使用 reasoning_effort。不自动降档，不新增重试档位 |
| max_output_tokens | Chat 映射 max_tokens |
| temperature、top_p、parallel_tool_calls 等对应选项 | 按目标接口的同义字段传递；非 GPT 路线原有 reasoning.context 清理保留 |
| previous_response_id | 只交给拥有该状态的服务；跨服务续聊用已有完整输入替换外部 response ID，不插入“继续”消息 |

自定义工具示例（别名由代码根据原名计算）：

```json
{"type":"custom_tool_call","namespace":"functions","name":"exec","call_id":"c1","input":"text(\"中文\");"}
```

发送至函数接口时：

```json
{"type":"function_call","name":"<functions.exec 的确定性别名>","call_id":"c1","arguments":"{\"input\":\"text(\\\"中文\\\");\"}"}
```

返回时只执行一次 JSON 解包，恢复原始 `text("中文");`。不会剥除第二层包装、修正 JavaScript、自动改参数类型或重写补丁。上游 input 不是字符串时返回明确协议错误，客户端不会收到伪装成成功的工具调用。

## 思考与同一对话切换模型

非 GPT 思考 ID 带有来源模型的确定性标记。相同模型续聊时，保留它返回的思考文本、顺序、空白及字段；Chat 仅将原文放入 reasoning_content。不会去重、总结或重新生成思考。vLLM 返回 content 而缺少协议必需的 summary 时，只补空数组，不生成摘要。

换模型时沿用已有规则：可读思考作为既有助手上下文转换；官方加密思考留在客户端原始历史中，只向能接受它的 GPT 目标保留。不能解密的字节不会伪装成另一厂商的思考。原有跨厂商“先前思考/摘要”标注没有新增或扩展。

官方 → 网关时，从 response.output_item.done 收集真实完成项目，解决 Responses Lite 的 response.completed.output=[] 导致丢失上一轮文本或工具调用的问题。网关 → 官方时恢复原生命名空间/自定义工具历史，并将 additional_tools 定义移回 tools。两种方向都保留工具调用与结果的 call_id 配对，保留已有客户端更新和可用的 phase 信息。

连接内缓存只保存原生格式，转换后的 Chat messages 不回写客户端历史。缓存缺失或不完整时报错；不猜测缺失内容。重连机制继续使用另一个任务已经实现的有界恢复策略，不重复执行已被上游接受的工具工作。

## 上游响应到客户端

| 上游内容 | 客户端协议 |
| --- | --- |
| Responses 正文/思考/工具项目 | 保留实际内容，规范项目 ID、命名空间与自定义工具外层；不增加回答 |
| Chat content 增量 | response.output_text.delta，完成时发对应 done/item.done |
| Chat reasoning_content 增量 | reasoning summary 事件，正文逐字保留 |
| Chat tool_calls | 汇集每个索引的 name、id 和 arguments；形成原生 function_call 或解包后的 custom_tool_call |
| 并行工具、名称晚到、只有最终参数 | 按输出索引分别缓冲；每个调用只发一次完整 done，已收到的参数前缀不丢失 |
| 上游流内项目 ID 改变 | 对同一输出索引使用稳定的客户端 ID，增量、完成项目和最终 response 一致 |
| message 上的空 summary 占位 | 删除无内容且不属于 message 协议的占位字段，防止切回 GPT 被拒绝 |
| Chat stop / tool_calls | response.completed |
| length / content_filter | response.incomplete；不把未完成流当成功，不执行未完成的自定义工具参数 |
| 上游错误、没有结束事件 | 明确返回 error/failed；不补一条模型回答，不悄悄重试已生成的内容 |
| prompt/completion/total tokens | 映射为 input/output/total tokens；有实际缓存/思考计数时映射明细，缺失值不编造 0 |
| Chat refusal | 还原 refusal 内容和事件，不改成普通回答 |

HTTP JSON 与 HTTP SSE/WebSocket 使用相同的项目转换规则。SSE 保留 Unicode、跨字节分片和 CRLF 语义。最终 output 项目按完整对象处理，不把不同项目的字段拼成上游从未生成过的消息。

## 压缩

GLM、Qwen、DeepSeek、vLLM 可以使用客户端已有的文本压缩流程：客户端自己发压缩请求，模型返回摘要，客户端更新上下文。适配层按普通消息协议转换该请求，没有自建压缩任务、独立摘要提示词或第二份聊天记录。实际验证使用原生 thread/compact/start，并检查压缩事件与后续续聊。

官方 /responses/compact 返回的不可读加密 compaction 状态是另一种情况。当前不能无损转换为非 GPT 可读文本，遇到这种跨厂商历史明确报错；不能据此得出“GLM 不能压缩”，也不能悄悄删除压缩块声称已经兼容。

## 验证与参考

逐模型实测、排除项和复现命令见 [验证记录](model-verification-2026-09-27.md)。工具、插件、技能、文件操作等由客户端通过同一工具协议执行；验证共用协议链路，不等于逐个第三方工具业务逻辑或所有模态都具备能力。

官方参考与接口探测共同决定转换，不用文档中未列出的字段假定能力：

- [OpenAI conversation state](https://developers.openai.com/api/docs/guides/conversation-state)：保留实际输出作为下一轮状态。
- [OpenAI compaction](https://developers.openai.com/api/docs/guides/compaction)：区分加密压缩状态与普通文本历史。
- [阿里云 Responses 接口](https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-responses)：消息、工具与 reasoning 输入格式。
- [阿里云 GLM 接口](https://help.aliyun.com/zh/model-studio/glm-zhipu)：工具调用及 reasoning_content 历史。

代码位置：src/non-gpt-compat.mjs（工具及思考）、src/chat-compat.mjs（Chat 协议）、src/history-compat.mjs（跨模型历史）、src/shim.mjs（HTTP/WS 路由与真实输出缓存）。
