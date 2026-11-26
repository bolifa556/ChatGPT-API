import { createHash } from 'node:crypto';
import { MAX_EVENT_BYTES } from './non-gpt-compat.mjs';
import { nativeUsage } from './history-compat.mjs';
import { applyChatSearch, searchParameters, searchResultFields, searchSources, searchCitationAnnotations } from './search-compat.mjs';

const copy = value => structuredClone(value);
const id = value => createHash('sha256').update(value).digest('hex').slice(0, 32);
function unsupported(message) { return Object.assign(new Error(message), { status: 400, code: 'unsupported_chat_format' }); }

// Keep Responses as the default. These routes need fields their Responses
// endpoints do not carry, but their standard Chat endpoints do support.
export function usesChat(payload, metadata) {
  const endpoints = metadata?.supported_endpoints;
  if (Array.isArray(endpoints)) {
    const chat = endpoints.some(value => typeof value === 'string' && /(?:chat[\/_-]completions)(?:$|[/?])/i.test(value));
    const responses = endpoints.some(value => typeof value === 'string' && /(?:^|\/)responses(?:$|[/?])/i.test(value));
    if (chat !== responses) return chat;
  }
  if (metadata?._protocol === 'chat') return true;
  return payload.model?.startsWith('词元计划/') ||
    (payload.model?.startsWith('阿里云订阅/') && ['json_schema','json_object'].includes(payload.text?.format?.type));
}
export function chatEndpointUnavailable(status, data, raw = '') {
  if (![400, 404, 405, 501].includes(status)) return false;
  const error = data?.error || data || {}, code = String(error.code || error.type || '');
  if (error.param === 'model' || /model_not_found|unknown_model|auth|permission|quota|rate_limit/i.test(code)) return false;
  if (/^(?:unsupported_endpoint|endpoint_not_found|unsupported_api|not_implemented|method_not_allowed)$/.test(code)) return true;
  if (status === 400) return false;
  if (code && !['not_found', 'invalid_request_error', 'http_error', String(status)].includes(code)) return false;
  const message = typeof error.message === 'string' ? error.message : typeof data?.detail === 'string' ? data.detail
    : typeof data?.error === 'string' ? data.error : raw;
  if (/\bmodel\b/i.test(message)) return false;
  if (status === 405 || status === 501) return true;
  return /^(?:404(?: page)?[ :.-]*)?not found[.!]?$/i.test(message.trim())
    || /Cannot POST [^\s<>]*\/responses(?:[?\s<]|$)/i.test(message);
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

export function chatRequest(payload, metadata, gateway) {
  if (payload.previous_response_id) throw unsupported('Chat continuation requires the complete input history.');
  const messages = [], system = [], calls = new Map();
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
      const text = blocks.map(part => part.text || '').join('\n\n');
      if (text) {
        const previous = messages.at(-1);
        if (previous?.role === 'assistant' && (previous.content !== null || previous.tool_calls)) messages.push({ role: 'assistant', content: null });
        const message = assistant();
        message.reasoning_content = [message.reasoning_content, text].filter(Boolean).join('\n\n');
      }
    } else if (item.type === 'function_call') {
      const message = assistant();
      (message.tool_calls ||= []).push({ id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments } });
      if (item.call_id) calls.set(item.call_id, item.name);
    } else if (item.type === 'function_call_output') {
      let callId = item.call_id;
      if (!callId && item.name) {
        const matching = [...calls].filter(([, name]) => name === item.name);
        if (matching.length === 1) callId = matching[0][0];
      }
      const output = content(item.output);
      if (callId) {
        messages.push({ role: 'tool', tool_call_id: callId, content: output }); calls.delete(callId);
      } else if (item.name) {
        // Chat's named function-result form needs no invented assistant call or
        // call ID. Use an existing unambiguous call ID whenever one is present.
        if (Array.isArray(output) && output.some(part => part.type !== 'text')) throw unsupported('A named Chat function result cannot represent non-text content without a call_id.');
        messages.push({ role: 'function', name: item.name, content: Array.isArray(output) ? output.map(part => part.text).join('') : output });
      } else throw unsupported('A Chat tool result requires its original call_id or function name.');
    } else if (item.type === 'message' || (!item.type && item.role)) {
      if (item.role === 'assistant') {
        const previous = messages.at(-1);
        if (previous?.role === 'assistant' && (previous.content !== null || previous.tool_calls)) messages.push({ role: 'assistant', content: null });
        assistant().content = content(item.content);
      } else append(item.role, item.content);
    } else throw unsupported('This Chat endpoint cannot represent history item: ' + item.type);
  }
  if (system.length) messages.unshift({ role: 'system', content: system.join('\n\n') });
  const result = { model: payload.model, messages };
  for (const key of ['stream','temperature','top_p','frequency_penalty','presence_penalty','logit_bias','user','seed','metadata','service_tier','parallel_tool_calls','store','prompt_cache_key','prompt_cache_retention','prompt_cache_options','safety_identifier', ...searchParameters]) {
    if (payload[key] !== undefined) result[key] = copy(payload[key]);
  }
  if (payload.max_output_tokens !== undefined) {
    const parameters = Array.isArray(metadata?.supported_parameters) ? metadata.supported_parameters : [];
    const completionLimit = parameters.includes('max_completion_tokens') || !parameters.includes('max_tokens') &&
      /^(?:o[134](?:-|$)|gpt-[5-9](?:[.-]|$))/i.test(payload.model?.split('/').at(-1) || '');
    result[completionLimit ? 'max_completion_tokens' : 'max_tokens'] = payload.max_output_tokens;
  }
  if (payload.text?.verbosity !== undefined) result.verbosity = copy(payload.text.verbosity);
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
      if ((choice.tools || []).some(tool => tool.type === 'mcp' && tool.name != null))
        throw unsupported('A named MCP tool restriction cannot be represented by filtering this Chat endpoint\'s server declarations.');
      const key = tool => JSON.stringify([tool.type, tool.function?.name || tool.name || '', tool.server_label || '']);
      const allowed = new Set((choice.tools || []).map(key));
      result.tools = (result.tools || []).filter(tool => allowed.has(key(tool)));
      result.tool_choice = choice.mode;
    } else result.tool_choice = copy(choice);
  }
  const format = payload.text?.format;
  if (format?.type === 'json_schema') {
    const schema = {}; for (const key of ['name','description','schema','strict']) if (format[key] !== undefined) schema[key] = copy(format[key]);
    result.response_format = { type: 'json_schema', json_schema: schema };
  } else if (format?.type === 'json_object' || format?.type === 'text') result.response_format = { type: format.type };
  if (result.stream) result.stream_options = { include_usage: true };
  return gateway ? applyChatSearch(result, gateway, payload.tools?.find(tool => ['web_search', 'web_search_preview'].includes(tool.type))) : result;
}

function mergeUsage(previous, value) {
  const result = { ...previous };
  for (const [source, target] of [['prompt_tokens','input_tokens'],['completion_tokens','output_tokens'],['total_tokens','total_tokens']]) {
    if (Number.isSafeInteger(value[source]) && value[source] >= 0) result[target] = value[source];
  }
  for (const [source, target] of [['prompt_tokens_details','input_tokens_details'],['completion_tokens_details','output_tokens_details']]) {
    if (value[source]) result[target] = { ...result[target], ...copy(value[source]) };
  }
  return result;
}

function nativeAnnotation(value) {
  if (value?.type === 'url_citation' && value.url_citation) {
    const { url_citation, ...rest } = value;
    return { ...copy(rest), ...copy(url_citation) };
  }
  return copy(value);
}

export class ChatEvents {
  constructor(model) { this.model = model; this.items = []; this.calls = new Map(); this.finished = false; }
  start(chunk) {
    if (this.response) {
      if (chunk.service_tier !== undefined) this.response.service_tier = copy(chunk.service_tier);
      if (chunk.model) this.response.model = chunk.model;
      return [];
    }
    if (!chunk.id) throw Object.assign(new Error('Chat response is missing its id.'), { status: 502, code: 'invalid_upstream_response' });
    this.response = { id: 'resp_gateway_' + id(chunk.id), object: 'response', model: chunk.model || this.model,
      created_at: chunk.created ?? Math.floor(Date.now() / 1000), status: 'in_progress', output: [], error: null,
      ...(chunk.service_tier !== undefined ? { service_tier: copy(chunk.service_tier) } : {}) };
    return [{ type: 'response.created', response: copy(this.response) }, { type: 'response.in_progress', response: copy(this.response) }];
  }
  text(kind, delta, newPart = false) {
    if (typeof delta !== 'string' || !delta) return [];
    const thought = kind === 'reasoning', bucket = thought ? 'reasoning' : 'message';
    const events = this.closeText(thought ? 'message' : 'reasoning', true, 'commentary');
    if (!this[bucket]) {
      const index = this.items.length, itemId = (thought ? 'rs_' : 'msg_') + id(this.response.id + '/' + index);
      const item = thought ? { type: 'reasoning', id: itemId, summary: [] } :
        { type: 'message', id: itemId, role: 'assistant', phase: this.phase ?? 'commentary', status: 'in_progress', content: [] };
      this[bucket] = { index, item, phase: this.phase }; this.items.push(item);
      events.push({ type: 'response.output_item.added', output_index: index, item: copy(item) });
    }
    const { index, item } = this[bucket], list = thought ? item.summary : item.content;
    const type = thought ? 'summary_text' : kind === 'refusal' ? 'refusal' : 'output_text';
    if (newPart || list.at(-1)?.type !== type) {
      if (list.length) events.push(...this.endPart(this[bucket]));
      const part = type === 'refusal' ? { type, refusal: '' } : { type, text: '', ...(thought ? {} : { annotations: this.annotations || [] }) };
      if (type === 'output_text') this.annotations = [];
      list.push(part);
      events.push({ type: thought ? 'response.reasoning_summary_part.added' : 'response.content_part.added', output_index: index, item_id: item.id,
        [thought ? 'summary_index' : 'content_index']: list.length - 1, part: copy(part) });
    }
    list.at(-1)[type === 'refusal' ? 'refusal' : 'text'] += delta;
    events.push({ type: 'response.' + (thought ? 'reasoning_summary_text' : type) + '.delta', output_index: index, item_id: item.id,
      [thought ? 'summary_index' : 'content_index']: list.length - 1, delta });
    return events;
  }
  endPart({ index, item }) {
    const thought = item.type === 'reasoning', list = thought ? item.summary : item.content, part = list.at(-1);
    if (!part) return [];
    const base = { output_index: index, item_id: item.id, [thought ? 'summary_index' : 'content_index']: list.length - 1 };
    const key = part.type === 'refusal' ? 'refusal' : 'text';
    return [{ ...base, type: 'response.' + (thought ? 'reasoning_summary_text' : part.type) + '.done', [key]: part[key] },
      { ...base, type: thought ? 'response.reasoning_summary_part.done' : 'response.content_part.done', part: copy(part) }];
  }
  closeText(kind, complete = true, phase) {
    const open = this[kind]; if (!open) return [];
    const { index, item } = open;
    if (kind === 'message') {
      item.status = complete ? 'completed' : 'incomplete';
      item.phase = open.phase ?? phase;
      this.annotations = []; this.annotationKeys?.clear();
    }
    this[kind] = null;
    return [...this.endPart(open), { type: 'response.output_item.done', output_index: index, item: copy(item) }];
  }
  annotate(values) {
    const events = [];
    for (const original of values) {
      const annotation = nativeAnnotation(original), key = JSON.stringify(annotation);
      this.annotationKeys ||= new Set();
      if (this.annotationKeys.has(key)) continue;
      this.annotationKeys.add(key);
      const at = this.message?.item.content.findLastIndex(part => part.type === 'output_text') ?? -1;
      if (at >= 0) {
        const { index, item } = this.message;
        const annotations = item.content[at].annotations;
        annotations.push(annotation);
        events.push({ type: 'response.output_text.annotation.added', output_index: index, item_id: item.id,
          content_index: at, annotation_index: annotations.length - 1, annotation: copy(annotation) });
      } else (this.annotations ||= []).push(annotation);
    }
    return events;
  }
  convert(chunk) {
    if (this.finished) return [];
    if (chunk.error) throw Object.assign(new Error(chunk.error.message || 'Chat upstream failed.'), {
      status: Number.isInteger(chunk.status) && chunk.status >= 400 && chunk.status <= 599 ? chunk.status : 502,
      upstreamError: copy(chunk.error), code: chunk.error.code || 'upstream_error' });
    const events = this.start(chunk);
    if (chunk.usage) this.usage = mergeUsage(this.usage, chunk.usage);
    if (typeof chunk.end_turn === 'boolean') this.endTurn = chunk.end_turn;
    for (const field of searchResultFields) if (chunk[field] !== undefined) this.response[field] = copy(chunk[field]);
    const sources = searchSources(chunk);
    for (const choice of chunk.choices || []) {
      if (choice.index && choice.index !== 0) throw unsupported('Multiple Chat choices cannot be represented as one Responses output.');
      const delta = choice.delta || {};
      if (delta.phase !== undefined) {
        if (this.message?.phase != null && this.message.phase !== delta.phase) events.push(...this.closeText('message', true, 'commentary'));
        this.phase = delta.phase;
        if (this.message) this.message.phase = delta.phase;
      }
      sources.push(...searchSources(delta));
      for (const field of searchResultFields) if (delta[field] !== undefined) this.response[field] = copy(delta[field]);
      events.push(...this.text('reasoning', delta.reasoning_content ?? delta.reasoning));
      if (Array.isArray(delta.content)) {
        for (const [position, part] of delta.content.entries()) {
          if (['text', 'output_text'].includes(part?.type) && typeof part.text === 'string') {
            events.push(...this.text('message', part.text, position > 0), ...this.annotate(part.annotations || []));
          } else if (part?.type === 'refusal' && typeof part.refusal === 'string') events.push(...this.text('refusal', part.refusal, position > 0));
          else throw Object.assign(new Error('Unsupported Chat response content block: ' + part?.type), { status: 502, code: 'unsupported_chat_response_content' });
        }
      } else events.push(...this.text('message', delta.content));
      events.push(...this.annotate(delta.annotations || []));
      events.push(...this.text('refusal', delta.refusal));
      if (delta.tool_calls?.length) events.push(...this.closeText('reasoning'));
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
    if (sources.length) {
      this.searchSources ||= new Map();
      for (const source of sources) this.searchSources.set(source.url, { ...this.searchSources.get(source.url), ...source });
    }
    // A tool-only response can hand off complete calls before the accounting
    // packet. Keep message-bearing responses open for any trailing citations.
    if (this.finishReason === 'tool_calls' && !this.message && !this.reasoning) events.push(...this.finishTools(true));
    return events;
  }
  finishTools(complete) {
    if (this.toolsFinished || !this.calls.size) return [];
    this.toolsFinished = true;
    const events = [];
    for (const [, call] of [...this.calls].sort(([a], [b]) => a - b)) {
      if (!call.id || !call.name) {
        if (!complete) continue;
        throw Object.assign(new Error('Chat tool call is missing its id or name.'), { status: 502, code: 'invalid_upstream_tool_call' });
      }
      const index = this.items.length;
      const item = { type: 'function_call', id: 'fc_' + id(this.response.id + '/' + index), call_id: call.id, name: call.name, arguments: call.arguments, status: complete ? 'completed' : 'incomplete' };
      this.items.push(item);
      if (complete) events.push({ type: 'response.output_item.added', output_index: index, item: { ...item, arguments: '', status: 'in_progress' } },
        { type: 'response.function_call_arguments.delta', output_index: index, item_id: item.id, delta: call.arguments },
        { type: 'response.function_call_arguments.done', output_index: index, item_id: item.id, name: call.name, arguments: call.arguments },
        { type: 'response.output_item.done', output_index: index, item: copy(item) });
    }
    return events;
  }
  finish() {
    if (this.finished) return [];
    if (!this.response || !this.finishReason) throw Object.assign(new Error('Chat stream ended without a finish_reason.'), { status: 502, code: 'incomplete_upstream_response' });
    this.finished = true;
    const events = [], complete = ['stop','tool_calls'].includes(this.finishReason);
    const lastText = this.message?.item.content.findLast(part => part.type === 'output_text');
    if (lastText && this.searchSources) events.push(...this.annotate(searchCitationAnnotations([...this.searchSources.values()], lastText.text)));
    events.push(...this.closeText('reasoning'), ...this.closeText('message', complete, this.calls.size ? 'commentary' : 'final_answer'), ...this.finishTools(complete));
    const limited = ['length','content_filter'].includes(this.finishReason);
    const usage = nativeUsage(this.usage);
    this.response = { ...this.response, output: copy(this.items), status: complete ? 'completed' : limited ? 'incomplete' : 'failed',
      ...(usage !== undefined ? { usage } : {}),
      ...(this.endTurn !== undefined ? { end_turn: this.endTurn } : {}),
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
