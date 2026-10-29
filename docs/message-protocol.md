# 原生客户端消息转换协议

适用对象：原生 ChatGPT / Codex 桌面客户端、官方模型与已配置 API 来源。模型目录动态发现，下表按原始模型 ID 展示协议路线示例，不作为固定模型清单或当前服务可用性声明。

## 多来源标识

默认来源保留旧模型 ID；新增来源在客户端使用 `@来源ID/原始模型ID`。选中模型时先固定对应来源的 URL、Key、连接与原始模型名，再按原始模型名选择下述转换路线。上游不会收到来源前缀；响应中的模型标识还原为客户端选择的公开 ID。工具内容、call_id 和消息顺序不因来源标识变化而改写。

同名模型属于不同来源时分别路由，不按名字合并、不自动回退。跨来源续聊仍遵循原生历史与 response ID 的归属规则，不把上一服务的状态标识发到另一服务。来源名称只用于显示；改名称不会改变公开模型 ID。上下文设置按来源 ID / 原始模型 ID 保存，容量缓存按真实 URL / 原始模型 ID 保存。

## 目标与边界

客户端决定对话、工具执行、历史、模型切换和压缩。适配层只转换请求副本和响应协议，不生成用户/助手正文，不添加新的任务提示词，不替模型纠正代码，不改写客户端保存的历史，不另建聊天库。测试使用临时目录和原生 ephemeral 对话。

现有模型目录中的基础指令与自定义工具说明保留；本次没有增加提示词，并移除原先转换思考时添加的说明前缀。测试夹具中的提示词仅供验证，未加入实际请求处理。另一个任务的重连修复保持有效。

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

官方 GPT 经保留的本地兼容通道发往 OpenAI，不经过 211 网关，也不经过非 GPT/Chat 转换。合法的原生请求保留协议；存在第三方历史时才规范必要字段。网关 GPT 同样不进入非 GPT/Chat 转换，但面向其无状态请求展开完整工具目录。

所有网关模型保留原生目录的完整指令模板和变量，包括工具、权限、默认／计划模式等分项；客户端自行组装 `developer` 消息及其他原生载体。适配层不另写基础提示词。没有登录或原生缓存时，使用包内经过原生 CLI 校验的官方内置模板快照。自定义工具原始描述与 grammar 保留，仅为函数协议增加必要的 `input: string` 参数外层，不追加工具纠错提示。

原生客户端会把对话创建时的基础指令保存在会话元数据中。更新模型目录不会重写旧对话的这段内容；客户端实际发来的指令仍完整转发。新对话直接使用更新后的模板。旧对话切换到另一模型并正常续聊一轮时，客户端会用原生 `model_switch` 消息带入新模板，之后可以切回原模型。适配层不自动创建这种消息，也不批量替换历史。

采用一套共用转换器，不为每个模型复制实现。词元现有 Responses 入口无法完整承载其思考历史，Chat 入口能传递 reasoning_content；阿里云常规 Responses 能承载原生 reasoning，但实测部分模型忽略 Responses 的结构化输出字段，因此仅结构化请求走标准 Chat response_format。

## 客户端请求到上游

| 客户端字段或项目 | 转换规则 |
| --- | --- |
| model | 按选定来源恢复完整原始模型名；回到客户端时还原公开模型 ID，不猜测同名部署 |
| instructions、system、developer、user、assistant | Responses 原样保留；Chat 把 instructions 放入 system。词元保留 developer；阿里云 Chat 要求一个开头的 system，按原顺序合并现有 system/developer 文本，仅以空行分隔 |
| 客户端 model_switch 更新 | 保留原文和相应角色；经过 Chat 时按上述角色规则转换 |
| input_text、output_text | Chat 转为 text，字符串内容不改；原生 Responses 保持原格式 |
| input_image | 保留 URL/数据和 detail；Chat 改为 image_url 外层。已登录混合模式的 ChatGPT file_id 从原生 `/backend-api/files/download/{file_id}` 获取原下载 URL，失败明确报错；官方路径保持 file_id。纯 API 模式不访问官方文件服务：Responses 原样转发该 API 的 file_id，是否有效由上游判断；Chat 无法表示只有 ID 的图片时明确报错。缓存和保存的历史不替换为临时 URL |
| input_file | Chat 映射 file_id/file_data/filename；无法表示的 file_url 明确报错，不伪造文件内容 |
| input_audio | 原生 data:audio/wav、x-wav、mpeg、mp3 内联数据转为 Chat input_audio.data/format；已是 Chat 格式则保留。不能表示的私有引用明确报错，不静默丢弃，不补做转写 |
| 已有 image_url/file/refusal | 对应字段保持原内容；文件内容不做额外解析或生成 |
| function 工具 | 名称、描述、参数 Schema、strict 保留；Chat 放入 tools[].function |
| namespace 工具 | 展开为函数，并用命名空间与原名生成确定性的别名；返回时恢复原名和 namespace，避免重名冲突 |
| custom 工具 | 用 function 的单个字符串参数 input 承载原始输入；返回时解包，工具由客户端执行 |
| additional_tools 历史项目 | 官方原生路径保留在 input 中，包括 ID、角色与引用；旧载体缺 role 时只补 developer。网关完整请求才把定义移入 tools，保留命名空间，当前定义覆盖旧定义；不将工具定义变成对话文字 |
| function_call / custom_tool_call 历史 | 保留 call_id、实际参数和顺序；自定义工具仅包一层 JSON 字符串参数。合法空字符串保留，缺失输入明确报错 |
| function_call_output / custom_tool_call_output | 保留 call_id 和原始结果。Chat 转为 role=tool、tool_call_id；内容只改外层格式 |
| auto/none/required、指定工具、allowed_tools | 依目标协议转换工具选择，别名与定义一致；不替用户选择另一种工具 |
| web_search 等上游扩展工具声明 | 保留声明，不因客户端默认声明了它就阻断普通请求；不模拟上游没有的工具能力 |
| text.format | Chat 映射为 response_format；json_schema 的 name/description/schema/strict 原样保留；不添加“请输出 JSON”提示词 |
| reasoning.effort | 按原值传递；Chat 使用 reasoning_effort。不自动降档，不新增重试档位 |
| max_output_tokens | Chat 映射 max_tokens |
| service_tier | 请求原值传递，包括 Chat 路径；不因菜单未声明速度档位而删除用户已有设置 |
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

切回官方或网关 GPT 时，第三方或客户端临时分配的思考 ID 不能当作官方服务端状态：将既有文本块逐块映射为 `reasoning.summary[].summary_text`，不携带第三方 ID，不增加助手消息，保留空白、重复块和顺序。官方加密思考对象保持原样。跨非 GPT 模型时沿用既有可读上下文转换，但不再添加“先前思考/摘要”说明前缀。不能解密的字节不伪装成另一厂商的思考。

官方 → 网关时，从 response.output_item.done 收集真实完成项目，解决 Responses Lite 的 response.completed.output=[] 导致丢失上一轮文本或工具调用的问题。网关 → 官方时使用缓存或客户端提交的原生命名空间/自定义工具历史，additional_tools 保持原生载体。两种方向都保留工具调用与结果的 call_id 配对，保留已有客户端更新和可用的 phase 信息。

连接内缓存只保存原生格式，转换后的 Chat messages 不回写客户端历史。缓存缺失或不完整时报错；不猜测缺失内容。重连机制继续使用另一个任务已经实现的有界恢复策略，不重复执行已被上游接受的工具工作。

## 上游响应到客户端

WebSocket 的 `response.interrupt` 按 `response_id` 定位当前响应，仅支持客户端原生的 `discard_partial_items` 模式。官方路径原样透传；网关 HTTP 路径关闭对应上游请求，返回 `response.interrupt.accepted`，再以 `response.completed` 和 `status=cancelled` 完成中断收尾。仅保留上游已完成的原始输出项目，不补全中断时的文本、思考或工具参数，不虚构用量。响应已结束时只确认中断，不重复发送完成事件；错误 ID、流或模式返回 `response.interrupt.failed`，不会取消另一条请求。旧版 `response.cancel` 仍保留。

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
| service_tier | 保留上游实际返回档位；最后一块才提供也会进入最终响应。缺失不编造，显式 null 保留，不用请求的 priority 覆盖上游 default |

HTTP JSON 与 HTTP SSE/WebSocket 使用相同的项目转换规则。SSE 保留 Unicode、跨字节分片和 CRLF 语义。最终 output 项目按完整对象处理，不把不同项目的字段拼成上游从未生成过的消息。

官方 HTTP 未压缩请求可补充无损 zstd，解压后的请求字节不变；已有原生编码继续保留，必要转换后按原编码重压缩。网关不假定支持压缩。模型响应、原生上下文压缩及图片生成／编辑的响应等待均显式禁用适配层计时器，客户端和上游自身限制不变。用户取消、客户端断开及终止事件仍回收连接；Chat 最后一块 usage 在结束前完整读取。传输压缩不会改变上下文压缩协议。

无效本地 JSON、缺失／未知模型、无法表示的历史返回对应 400 类错误与稳定代码；本地连接超时使用 504。上游 HTTP 错误保持原状态和正文；转为 WebSocket 事件时保留原错误对象的 type、code、message、param 及扩展字段，不统一改成 server_error。

Fast 的目录声明与请求转发分别处理。官方目录保持原生元数据；网关 GPT 在 `/models` 只提供模型名称、未声明速度档位时仍提供 Fast（`priority`）选项，API-only 不依赖官方登录。上游明确的速度声明优先，空列表保留为禁用；非 GPT 模型按自身声明展示，不继承官方倍速说明。服务是否实际支持优先档位由上游决定。浏览器工具按同一工具协议转换，其运行时的官方身份等网络请求独立于模型通道，详见 [3.0.6 验证记录](browser-fast-network-fix-2026-10-10.md)。

## 压缩

GLM、Qwen、DeepSeek、vLLM 可以使用客户端已有的文本压缩流程：客户端自己发压缩请求，模型返回摘要，客户端更新上下文。适配层按普通消息协议转换该请求，没有自建压缩任务、独立摘要提示词或第二份聊天记录。实际验证使用原生 thread/compact/start，并检查压缩事件与后续续聊。

安装版本通过 provider 身份选择压缩流程。启动时官方模型使用 `openai`；网关模型使用保留原生认证的 `chatgpt_api_mixed`，无登录时使用 `chatgpt_api_launcher`，后两者均采用原生文本压缩。启动器在客户端退出后通过原生 `thread/resume` 双向更正对话提供方：网关模型离开错误的 `openai` 绑定，选回官方模型的对话恢复 `openai`。不复制对话、不改原始消息。已加载的对话不能靠更改默认配置立即修复。

远程压缩 v2 也会在普通 `/responses` 中发送 `compaction_trigger`，并非只使用 `/responses/compact`。非 GPT 适配层在附件下载和上游调用之前拒绝这种不支持的控制项目，返回 `incompatible_compaction_provider`，提示退出重开修复绑定。官方通道保持原样；不把普通回复伪装成 compaction 项目。

官方返回的不可读加密 compaction 状态不能无损转换为非 GPT 可读文本，遇到这种跨厂商历史明确报错，不删除压缩块。在同一对话切换官方与网关模型后，目前需要退出重开，才能保证提供方及压缩方式同步切换。原生 `thread/unsubscribe` 后 `thread/resume` 可在同一控制连接完成切换，但补测发现这会丢失代码执行器状态、重建测试 MCP 并使后台终端会话不再列出，因此不作为静默热切换方案；桌面模型菜单的自动联动尚未接入。HTTP 适配层不能代替客户端选择压缩协议。详见 [修复记录](compaction-incident-2026-09-28.md) 和 [自动切换方案](automatic-provider-switch-design.md)。

## 验证与参考

逐模型实测、完整功能清单、验证层级、排除项和复现命令见 [最新验证记录](model-verification-2026-09-28.md)。工具、插件、技能、文件操作等由客户端通过同一工具协议执行；验证共用协议链路，不等于逐个第三方工具业务逻辑或所有模态都具备能力。

官方参考与接口探测共同决定转换，不用文档中未列出的字段假定能力：

- [OpenAI conversation state](https://developers.openai.com/api/docs/guides/conversation-state)：保留实际输出作为下一轮状态。
- [OpenAI compaction](https://developers.openai.com/api/docs/guides/compaction)：区分加密压缩状态与普通文本历史。
- [阿里云 Responses 接口](https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-responses)：消息、工具与 reasoning 输入格式。
- [阿里云 GLM 接口](https://help.aliyun.com/zh/model-studio/glm-zhipu)：工具调用及 reasoning_content 历史。

代码位置：src/non-gpt-compat.mjs（工具及思考）、src/chat-compat.mjs（Chat 协议）、src/history-compat.mjs（跨模型历史）、src/shim.mjs（HTTP/WS 路由与真实输出缓存）。
