// Desktop wire compatibility. This module never executes model-generated input.
import { createHash } from 'node:crypto';
import { reasoningAsContext, mergeTools } from './history-compat.mjs';

export const MAX_EVENT_BYTES = 16 * 1024 * 1024;
const hash = value => createHash('sha256').update(value).digest('hex');
export function validateNonGptCompaction(payload) {
  // A remote compaction control item must not become a generation request.
  if (Array.isArray(payload?.input) && payload.input.some(item => item?.type === 'compaction_trigger')) {
    throw Object.assign(new Error('This conversation is still using the OpenAI remote-compaction provider with a non-GPT model. Fully exit ChatGPT and reopen chatgpt-api to apply the native text-compaction provider repair. No compaction request was sent to the model.'), { status: 400, code: 'incompatible_compaction_provider' });
  }
}
export function alias(name, namespace) {
  const value = (namespace || '') + '/' + name;
  return 'cx_' + value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 36) + '_' + hash(value).slice(0, 12);
}
const prefixes = { message: 'msg_', reasoning: 'rs_gateway_', function_call: 'fc_', custom_tool_call: 'ctc_', web_search_call: 'ws_' };
function safeId(id, type, prefix = prefixes[type]) {
  if (!prefix || typeof id !== 'string' || id.startsWith(prefix)) return id;
  const suffix = id.replace(/^[a-zA-Z0-9]+_/, '');
  return prefix + (/^[a-zA-Z0-9_-]{1,80}$/.test(suffix) ? suffix : hash(id).slice(0, 48));
}
export class NonGptAdapter {
  constructor(original, { preserveReasoning = false } = {}) {
    this.original = original;
    this.preserveReasoning = preserveReasoning;
    this.reasoningPrefix = original.model ? 'rs_gateway_' + hash(original.model).slice(0, 12) + '_' : 'rs_gateway_';
    this.mapping = new Map();
    this.ids = new Map();
    this.stats = { customTools: 0, namespaceTools: 0, carriersRemoved: 0, reasoningSkipped: 0, reasoningConverted: 0, reasoningPreserved: 0, callsRestored: 0, argumentErrors: 0, idsCorrected: 0 };
  }
  register(name, namespace, custom) {
    if (typeof name !== 'string' || !name) throw new Error('Tool name is missing');
    const key = alias(name, namespace), meta = { name, namespace, custom };
    if (this.mapping.has(key) && JSON.stringify(this.mapping.get(key)) !== JSON.stringify(meta)) throw new Error('Ambiguous tool definition');
    this.mapping.set(key, meta);
    return key;
  }
  historyName(name, namespace, custom) {
    const matches = [...this.mapping].filter(([, m]) => m.custom === custom &&
      ((m.name === name && (!namespace || namespace === m.namespace)) || (!namespace && name === [m.namespace, m.name].filter(Boolean).join('.'))));
    return matches.length === 1 ? matches[0][0] : this.register(name, namespace, custom);
  }
  tools(values, namespace) {
    return values.flatMap(original => {
      const t = structuredClone(original);
      if (t.type === 'namespace') return this.tools(t.tools || [], [namespace, t.name].filter(Boolean).join('.'));
      if (t.type === 'custom') {
        this.stats.customTools++;
        let description = 'Original tool: ' + [namespace, t.name].filter(Boolean).join('.') + '\n' + (t.description || '');
        description += '\nCompatibility interface: put the raw tool input (source code or patch text) into the input string. Do not JSON-wrap the source inside that string.';
        if (t.format?.type === 'grammar') description += '\nOriginal input grammar:\n' + (t.format.definition || '');
        return [{ type: 'function', name: this.register(t.name, namespace, true), description,
          parameters: { type: 'object', properties: { input: { type: 'string', description: 'Exact raw tool input; not a JSON object encoded as text.' } }, required: ['input'], additionalProperties: false } }];
      }
      if (t.type === 'function' && namespace) {
        this.stats.namespaceTools++;
        t.name = this.register(t.name, namespace, false);
      }
      return [t];
    });
  }
  choice(original) {
    if (!original || typeof original !== 'object') return original;
    const value = structuredClone(original);
    if (Array.isArray(value.tools)) value.tools = value.tools.map(t => this.choice(t));
    if (value.name) {
      let key = alias(value.name, value.namespace);
      const matches = [...this.mapping].filter(([, m]) => m.name === value.name);
      if (!this.mapping.has(key) && !value.namespace && matches.length === 1) key = matches[0][0];
      if (this.mapping.has(key)) { value.type = 'function'; value.name = key; delete value.namespace; }
    }
    return value;
  }
  request() {
    validateNonGptCompaction(this.original);
    const data = structuredClone(this.original), carriers = [], removedIds = new Set();
    if (Array.isArray(data.input)) {
      data.input = data.input.flatMap(item => {
        if (item?.type === 'additional_tools') {
          carriers.push(...(item.tools || [])); this.stats.carriersRemoved++;
        } else if (item?.type === 'reasoning') {
          if (this.preserveReasoning && this.original.model && item.id?.startsWith(this.reasoningPrefix)) {
            item.summary ??= [];
            this.stats.reasoningPreserved++;
            return [item];
          }
          // A role-less reasoning block becomes an extra system message in some
          // Responses->Chat converters. Preserve all readable text as assistant
          // context; encrypted bytes cannot be interpreted by a different vendor.
          if (item.id) removedIds.add(item.id);
          const context = reasoningAsContext(item);
          if (context) { this.stats.reasoningConverted++; return [context]; }
          this.stats.reasoningSkipped++;
        } else return [item];
        if (item.id) removedIds.add(item.id);
        return [];
      });
      data.input = data.input.filter(x => !(x?.type === 'item_reference' && removedIds.has(x.id)));
    }
    if (carriers.length || data.tools) data.tools = this.tools(mergeTools([...carriers, ...(data.tools || [])]));
    if (data.reasoning) delete data.reasoning.context;
    for (const item of Array.isArray(data.input) ? data.input : []) {
      if (!item || typeof item !== 'object') continue;
      delete item.internal_chat_message_metadata_passthrough;
      if (item.type === 'compaction') {
        throw Object.assign(new Error('This history contains an opaque GPT compaction block. Restore readable context before switching to a non-GPT model.'), { status: 400, code: 'incompatible_compacted_history' });
      }
      if (item.type === 'custom_tool_call') {
        item.type = 'function_call'; item.name = this.historyName(item.name, item.namespace, true);
        let input = item.input;
        if (input === undefined && typeof item.arguments === 'string') input = this.raw(item.arguments);
        if (typeof input !== 'string') throw Object.assign(new Error('Historical custom tool input must be a string.'), { status: 400, code: 'invalid_tool_input' });
        item.arguments = JSON.stringify({ input });
        delete item.input; delete item.namespace; delete item.id;
      } else if (item.type === 'custom_tool_call_output') {
        item.type = 'function_call_output'; delete item.id;
      } else if (item.type === 'function_call' && item.namespace) {
        item.name = this.historyName(item.name, item.namespace, false); delete item.namespace; delete item.id;
      } else if (item.type === 'message' && item.id) item.id = safeId(item.id, 'message');
    }
    if (data.tool_choice) data.tool_choice = this.choice(data.tool_choice);
    return data;
  }
  raw(argumentsText) {
    try {
      const value = JSON.parse(argumentsText).input;
      if (typeof value !== 'string') throw new Error('input must be a string');
      return value;
    } catch {
      this.stats.argumentErrors++;
      throw Object.assign(new Error('Upstream custom tool arguments must be a JSON object with a string input field.'), { status: 502, code: 'invalid_upstream_tool_arguments' });
    }
  }
  item(original, { partial = false } = {}) {
    if (!original || typeof original !== 'object') return original;
    let item = { ...original };
    if (item.type === 'reasoning') item.summary ??= [];
    // Some Responses gateways attach an empty reasoning-only placeholder to
    // message items. It is not a message field and contains no conversation data.
    else if (Array.isArray(item.summary) && !item.summary.length) delete item.summary;
    const meta = this.mapping.get(item.name);
    if (meta && item.type === 'function_call') {
      item.name = meta.name;
      if (meta.namespace) item.namespace = meta.namespace;
      if (meta.custom) { item.type = 'custom_tool_call'; item.input = partial && !item.arguments ? '' : this.raw(item.arguments); delete item.arguments; }
    }
    const id = safeId(item.id, item.type, item.type === 'reasoning' ? this.reasoningPrefix : prefixes[item.type]);
    if (id && id !== item.id) {
      if (!this.ids.has(item.id)) this.stats.idsCorrected++;
      this.ids.set(item.id, id); item.id = id;
    }
    return item;
  }
  response(original) {
    return Array.isArray(original?.output) ? { ...original, output: original.output.map(x => this.item(x)) } : original;
  }
}

export class NonGptEvents {
  constructor(adapter) {
    this.adapter = adapter; this.calls = new Map(); this.itemIds = new Map(); this.sequence = 0; this.terminal = false;
  }
  item(original, index, options) {
    const item = this.adapter.item(original, options);
    if (item?.id && Number.isInteger(index)) {
      if (!this.itemIds.has(index)) this.itemIds.set(index, item.id);
      const stable = this.itemIds.get(index);
      if (original.id !== stable) this.adapter.ids.set(original.id, stable);
      item.id = stable;
    }
    return item;
  }
  call(index, item = {}) {
    if (!Number.isInteger(index) || index < 0) throw Object.assign(new Error('Upstream tool event is missing its output_index.'), { status: 502, code: 'invalid_upstream_tool_call' });
    if (!this.calls.has(index)) this.calls.set(index, { item: { type: 'function_call' }, arguments: '', added: false, argumentsDone: false, itemDone: false, streamed: false });
    const call = this.calls.get(index);
    for (const [key, value] of Object.entries(item)) {
      if (['id','name','call_id'].includes(key) && !value) continue;
      if (key !== 'arguments') call.item[key] = value;
    }
    if (typeof item.arguments === 'string' && (item.arguments || !call.arguments)) call.arguments = item.arguments;
    return call;
  }
  start(index, call) {
    if (call.added || !call.item.name || !call.item.call_id) return [];
    call.added = true;
    return [{ type: 'response.output_item.added', output_index: index,
      item: this.item({ ...call.item, arguments: '', status: 'in_progress' }, index, { partial: true }) }];
  }
  argumentsDone(index, call) {
    if (call.argumentsDone || !call.added) return [];
    call.argumentsDone = true;
    const base = { output_index: index, item_id: call.item.id };
    const meta = this.adapter.mapping.get(call.item.name);
    if (meta?.custom) {
      const input = this.adapter.raw(call.arguments);
      return [{ ...base, type: 'response.custom_tool_call_input.delta', delta: input },
        { ...base, type: 'response.custom_tool_call_input.done', input }];
    }
    return [...(!call.streamed && call.arguments ? [{ ...base, type: 'response.function_call_arguments.delta', delta: call.arguments }] : []),
      { ...base, type: 'response.function_call_arguments.done', arguments: call.arguments,
        name: meta?.name || call.item.name, ...(meta?.namespace ? { namespace: meta.namespace } : {}) }];
  }
  finishItem(index, original) {
    const call = this.call(index, original);
    if (!call.item.name || !call.item.call_id) throw Object.assign(new Error('Upstream tool call is missing its name or call_id.'), { status: 502, code: 'invalid_upstream_tool_call' });
    const item = this.item({ ...call.item, arguments: call.arguments }, index);
    if (call.itemDone) return { item, events: [] };
    const events = [...this.start(index, call), ...this.argumentsDone(index, call), { type: 'response.output_item.done', output_index: index, item }];
    call.itemDone = true;
    if (item.type === 'custom_tool_call') this.adapter.stats.callsRestored++;
    return { item, events };
  }
  events(original) {
    let event = { ...original };
    const kind = event.type, idx = event.output_index;
    if (['response.completed','response.incomplete','response.failed','error'].includes(kind)) this.terminal = true;
    if (kind === 'response.failed' || kind === 'error') return [event];
    if (kind === 'response.output_item.added') {
      if (event.item?.type === 'function_call') return this.start(idx, this.call(idx, event.item));
      event.item = this.item(event.item, idx, { partial: true });
    } else if (kind === 'response.function_call_arguments.delta') {
      const call = this.call(idx, { id: event.item_id });
      call.arguments += event.delta || '';
      if (Buffer.byteLength(call.arguments) > MAX_EVENT_BYTES) throw new Error('Tool input exceeds limit');
      if (!call.item.name || this.adapter.mapping.get(call.item.name)?.custom) return [];
      const added = this.start(idx, call);
      if (!call.added) return [];
      const delta = call.streamed ? event.delta : call.arguments;
      call.streamed = true;
      return [...added, { ...event, delta }];
    } else if (kind === 'response.function_call_arguments.done') {
      const call = this.call(idx, { id: event.item_id, name: event.name, arguments: event.arguments });
      return [...this.start(idx, call), ...this.argumentsDone(idx, call)];
    } else if (kind === 'response.output_item.done') {
      if (event.item?.type === 'function_call' || this.calls.has(idx)) return this.finishItem(idx, event.item).events;
      event.item = this.item(event.item, idx);
    } else if (event.response) {
      const response = event.response, extra = [];
      if (Array.isArray(response.output)) event.response = { ...response, output: response.output.map((item, index) => {
        if (kind === 'response.completed' && item.type === 'function_call') {
          const result = this.finishItem(index, item); extra.push(...result.events); return result.item;
        }
        return this.item(item, index, { partial: !this.terminal });
      }) };
      return [...extra, event];
    }
    return [event];
  }
  convert(event) {
    return this.events(event).map(out => ({ ...out,
      ...(out.item_id && this.itemIds.has(out.output_index) ? { item_id: this.itemIds.get(out.output_index) } :
        this.adapter.ids.has(out.item_id) ? { item_id: this.adapter.ids.get(out.item_id) } : {}),
      sequence_number: this.sequence++ }));
  }
  finish() {
    if (!this.terminal) throw Object.assign(new Error('Upstream stream ended before a terminal response event.'), { status: 502, code: 'incomplete_upstream_response' });
  }
}
