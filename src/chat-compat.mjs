import { createHash } from 'node:crypto';
import { MAX_EVENT_BYTES } from './non-gpt-compat.mjs';

const copy = value => structuredClone(value);
const id = value => createHash('sha256').update(value).digest('hex').slice(0, 32);
function unsupported(message) { return Object.assign(new Error(message), { status: 400, code: 'unsupported_chat_format' }); }

// Keep Responses as the default. These routes need fields their Responses
// endpoints do not carry, but their standard Chat endpoints do support.
export function usesChat(payload) {
  return payload.model?.startsWith('词元计划/') ||
    (payload.model?.startsWith('阿里云订阅/') && ['json_schema','json_object'].includes(payload.text?.format?.type));
}
function content(value) {
  if (typeof value === 'string' || value === null) return value;
  if (!Array.isArray(value)) throw unsupported('Unsupported message content for Chat.');
  return value.map(part => {
    if (['input_text','output_text','text'].includes(part.type)) return { type: 'text', text: part.text };
    if (part.type === 'input_image') {
      if (!part.image_url) throw unsupported('A provider-private image file_id cannot be sent to this Chat endpoint without its original image data.');
      return { type: 'image_url', image_url: { url: part.image_url, ...(part.detail ? { detail: part.detail } : {}) } };
    }
    if (part.type === 'input_audio' && part.audio_url) {
      const data = /^data:audio\/(wav|x-wav|mpeg|mp3);base64,([\s\S]+)$/.exec(part.audio_url);
      if (!data) throw unsupported('This Chat endpoint needs WAV/MP3 audio data; a native audio URL cannot be silently discarded.');
      return { type: 'input_audio', input_audio: { data: data[2], format: ['wav','x-wav'].includes(data[1]) ? 'wav' : 'mp3' } };
    }
    if (part.type === 'input_file') {
      if (part.file_url) throw unsupported('This Chat endpoint cannot represent a Responses file_url input.');
      const file = {}; for (const key of ['file_id','file_data','filename']) if (part[key] !== undefined) file[key] = part[key];
      return { type: 'file', file };
    }
    if (['image_url','input_audio','file','refusal'].includes(part.type)) return copy(part);
    throw unsupported('Unsupported Chat content type: ' + part.type);
  });
}
function parts(value) { return value == null ? [] : typeof value === 'string' ? [{ type: 'text', text: value }] : value; }

export function chatRequest(payload) {
  if (payload.previous_response_id) throw unsupported('Chat continuation requires the complete input history.');
  const messages = [], system = [];
  const aliyun = payload.model?.startsWith('阿里云订阅/');
  function append(role, value) {
    const converted = content(value);
    if (aliyun && (role === 'system' || role === 'developer')) {
      const blocks = parts(converted);
      if (blocks.some(part => part.type !== 'text')) throw unsupported('System content must be text.');
      system.push(...blocks.map(part => part.text)); return;
    }
    messages.push({ role, content: converted });
  }
  function assistant() {
    if (messages.at(-1)?.role !== 'assistant') messages.push({ role: 'assistant', content: null });
    return messages.at(-1);
  }
  if (typeof payload.instructions === 'string') append('system', payload.instructions);
  const input = typeof payload.input === 'string' ? [{ role: 'user', content: payload.input }] : payload.input || [];
  for (const item of input) {
    if (item.type === 'reasoning') {
      const blocks = item.content?.length ? item.content : item.summary || [];
      const text = blocks.map(part => part.text || '').join('');
      if (text) { const message = assistant(); message.reasoning_content = (message.reasoning_content || '') + text; }
    } else if (item.type === 'function_call') {
      const message = assistant();
      (message.tool_calls ||= []).push({ id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments } });
    } else if (item.type === 'function_call_output') {
      messages.push({ role: 'tool', tool_call_id: item.call_id, content: content(item.output) });
    } else if (item.type === 'message' || (!item.type && item.role)) {
      if (item.role === 'assistant') {
        const message = assistant(), next = content(item.content);
        message.content = message.content === null ? next : [...parts(message.content), ...parts(next)];
      } else append(item.role, item.content);
    } else throw unsupported('This Chat endpoint cannot represent history item: ' + item.type);
  }
  if (system.length) messages.unshift({ role: 'system', content: system.join('\n\n') });
  const result = { model: payload.model, messages };
  for (const key of ['stream','temperature','top_p','frequency_penalty','presence_penalty','logit_bias','user','seed','metadata','service_tier','parallel_tool_calls','store','prompt_cache_key']) {
    if (payload[key] !== undefined) result[key] = copy(payload[key]);
  }
  if (payload.max_output_tokens !== undefined) result.max_tokens = payload.max_output_tokens;
  if (payload.reasoning?.effort !== undefined) result.reasoning_effort = payload.reasoning.effort;
  if (payload.tools) result.tools = payload.tools.map(tool => {
    // These gateways accept native hosted-tool declarations as extensions.
    // Preserve them; capability errors belong to the upstream model.
    if (tool.type !== 'function') return copy(tool);
    const definition = {}; for (const key of ['name','description','parameters','strict']) if (tool[key] !== undefined) definition[key] = copy(tool[key]);
    return { type: 'function', function: definition };
  });
  if (payload.tool_choice !== undefined) {
    const choice = payload.tool_choice;
    if (typeof choice === 'string') result.tool_choice = choice;
    else if (choice.type === 'function') result.tool_choice = { type: 'function', function: { name: choice.name } };
    else if (choice.type === 'allowed_tools') {
      const allowed = new Set((choice.tools || []).map(tool => tool.type + ':' + (tool.name || '')));
      result.tools = (result.tools || []).filter(tool => allowed.has(tool.type + ':' + (tool.function?.name || tool.name || '')));
      result.tool_choice = choice.mode;
    } else result.tool_choice = copy(choice);
  }
  const format = payload.text?.format;
  if (format?.type === 'json_schema') {
    const schema = {}; for (const key of ['name','description','schema','strict']) if (format[key] !== undefined) schema[key] = copy(format[key]);
    result.response_format = { type: 'json_schema', json_schema: schema };
  } else if (format?.type === 'json_object' || format?.type === 'text') result.response_format = { type: format.type };
  if (result.stream) result.stream_options = { include_usage: true };
  return result;
}

function usage(value) {
  if (!value) return undefined;
  const result = {};
  for (const [source, target] of [['prompt_tokens','input_tokens'],['completion_tokens','output_tokens'],['total_tokens','total_tokens']]) {
    if (value[source] !== undefined) result[target] = value[source];
  }
  // Native clients require the named count when a details object is present.
  // An upstream omitting that count means unknown, not an invented zero.
  if (value.prompt_tokens_details?.cached_tokens !== undefined) result.input_tokens_details = copy(value.prompt_tokens_details);
  if (value.completion_tokens_details?.reasoning_tokens !== undefined) result.output_tokens_details = copy(value.completion_tokens_details);
  return result;
}

export class ChatEvents {
  constructor(model) { this.model = model; this.items = []; this.calls = new Map(); this.finished = false; }
  start(chunk) {
    if (this.response) return [];
    if (!chunk.id) throw Object.assign(new Error('Chat response is missing its id.'), { status: 502, code: 'invalid_upstream_response' });
    this.response = { id: 'resp_gateway_' + id(chunk.id), object: 'response', model: this.model,
      created_at: chunk.created ?? Math.floor(Date.now() / 1000), status: 'in_progress', output: [], error: null };
    return [{ type: 'response.created', response: copy(this.response) }, { type: 'response.in_progress', response: copy(this.response) }];
  }
  text(kind, delta) {
    if (typeof delta !== 'string' || !delta) return [];
    const events = [];
    if (!this[kind]) {
      const index = this.items.length, itemId = (kind === 'reasoning' ? 'rs_' : 'msg_') + id(this.response.id + '/' + index);
      const item = kind === 'reasoning' ? { type: 'reasoning', id: itemId, summary: [{ type: 'summary_text', text: '' }] } :
        { type: 'message', id: itemId, role: 'assistant', status: 'in_progress', content: [{ type: 'output_text', text: '', annotations: [] }] };
      this[kind] = { index, item }; this.items.push(item);
      events.push({ type: 'response.output_item.added', output_index: index, item: copy(item) });
      events.push(kind === 'reasoning' ? { type: 'response.reasoning_summary_part.added', output_index: index, item_id: itemId, summary_index: 0, part: copy(item.summary[0]) } :
        { type: 'response.content_part.added', output_index: index, item_id: itemId, content_index: 0, part: copy(item.content[0]) });
    }
    const { index, item } = this[kind];
    (kind === 'reasoning' ? item.summary : item.content)[0].text += delta;
    events.push(kind === 'reasoning' ? { type: 'response.reasoning_summary_text.delta', output_index: index, item_id: item.id, summary_index: 0, delta } :
      { type: 'response.output_text.delta', output_index: index, item_id: item.id, content_index: 0, delta });
    return events;
  }
  convert(chunk) {
    if (this.finished) return [];
    if (chunk.error) throw Object.assign(new Error(chunk.error.message || 'Chat upstream failed.'), { status: 502, code: chunk.error.code || 'upstream_error' });
    const events = this.start(chunk);
    if (chunk.usage) this.usage = usage(chunk.usage);
    for (const choice of chunk.choices || []) {
      if (choice.index && choice.index !== 0) throw unsupported('Multiple Chat choices cannot be represented as one Responses output.');
      const delta = choice.delta || {};
      events.push(...this.text('reasoning', delta.reasoning_content ?? delta.reasoning));
      events.push(...this.text('message', delta.content));
      if (delta.refusal) {
        this.refusal = (this.refusal || '') + delta.refusal;
      }
      for (const part of delta.tool_calls || []) {
        const index = part.index ?? 0;
        if (!this.calls.has(index)) this.calls.set(index, { id: '', name: '', arguments: '' });
        const call = this.calls.get(index);
        if (part.id) {
          if (call.id && call.id !== part.id) throw Object.assign(new Error('Chat tool call id changed within one stream.'), { status: 502, code: 'invalid_upstream_tool_call' });
          call.id = part.id;
        }
        if (part.function?.name) call.name += part.function.name;
        if (part.function?.arguments) call.arguments += part.function.arguments;
        if (Buffer.byteLength(call.arguments) > MAX_EVENT_BYTES) throw new Error('Tool input exceeds limit');
      }
      if (choice.finish_reason) this.finishReason = choice.finish_reason;
    }
    return events;
  }
  finish() {
    if (this.finished) return [];
    if (!this.response || !this.finishReason) throw Object.assign(new Error('Chat stream ended without a finish_reason.'), { status: 502, code: 'incomplete_upstream_response' });
    this.finished = true;
    const events = [], complete = ['stop','tool_calls'].includes(this.finishReason);
    for (const kind of ['reasoning','message']) {
      if (!this[kind]) continue;
      const { index, item } = this[kind];
      if (kind === 'message') item.status = complete ? 'completed' : 'incomplete';
      const part = (kind === 'reasoning' ? item.summary : item.content)[0];
      if (kind === 'reasoning') events.push(
        { type: 'response.reasoning_summary_text.done', output_index: index, item_id: item.id, summary_index: 0, text: part.text },
        { type: 'response.reasoning_summary_part.done', output_index: index, item_id: item.id, summary_index: 0, part: copy(part) });
      else events.push(
        { type: 'response.output_text.done', output_index: index, item_id: item.id, content_index: 0, text: part.text },
        { type: 'response.content_part.done', output_index: index, item_id: item.id, content_index: 0, part: copy(part) });
      events.push({ type: 'response.output_item.done', output_index: index, item: copy(item) });
    }
    if (this.refusal) {
      const index = this.items.length;
      const item = { type: 'message', id: 'msg_' + id(this.response.id + '/' + index), role: 'assistant', status: 'completed', content: [{ type: 'refusal', refusal: this.refusal }] };
      this.items.push(item);
      events.push({ type: 'response.output_item.added', output_index: index, item: { ...copy(item), status: 'in_progress' } },
        { type: 'response.refusal.delta', output_index: index, item_id: item.id, content_index: 0, delta: this.refusal },
        { type: 'response.refusal.done', output_index: index, item_id: item.id, content_index: 0, refusal: this.refusal },
        { type: 'response.output_item.done', output_index: index, item: copy(item) });
    }
    for (const [, call] of [...this.calls].sort(([a], [b]) => a - b)) {
      if (!call.id || !call.name) throw Object.assign(new Error('Chat tool call is missing its id or name.'), { status: 502, code: 'invalid_upstream_tool_call' });
      const index = this.items.length;
      const item = { type: 'function_call', id: 'fc_' + id(this.response.id + '/' + index), call_id: call.id, name: call.name, arguments: call.arguments, status: complete ? 'completed' : 'incomplete' };
      this.items.push(item);
      if (complete) events.push({ type: 'response.output_item.added', output_index: index, item: { ...item, arguments: '', status: 'in_progress' } },
        { type: 'response.function_call_arguments.delta', output_index: index, item_id: item.id, delta: call.arguments },
        { type: 'response.function_call_arguments.done', output_index: index, item_id: item.id, name: call.name, arguments: call.arguments },
        { type: 'response.output_item.done', output_index: index, item: copy(item) });
    }
    const limited = ['length','content_filter'].includes(this.finishReason);
    this.response = { ...this.response, output: copy(this.items), status: complete ? 'completed' : limited ? 'incomplete' : 'failed',
      ...(this.usage ? { usage: this.usage } : {}),
      ...(limited ? { incomplete_details: { reason: this.finishReason === 'length' ? 'max_output_tokens' : 'content_filter' } } : {}),
      ...(!complete && !limited ? { error: { code: 'upstream_finish_reason', message: this.finishReason } } : {}) };
    events.push({ type: 'response.' + this.response.status, response: this.response });
    return events;
  }
}

export function chatResponse(value, model) {
  const stream = new ChatEvents(model);
  stream.convert({ ...value, choices: (value.choices || []).map(choice => ({ ...choice, delta: { ...choice.message,
    tool_calls: choice.message?.tool_calls?.map((call, index) => ({ ...call, index })) } })) });
  stream.finish();
  return stream.response;
}
