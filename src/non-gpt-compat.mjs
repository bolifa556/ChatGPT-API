// Desktop wire compatibility. This module never executes model-generated input.
import { createHash } from 'node:crypto';
import { reasoningAsContext } from './history-compat.mjs';

export const MAX_EVENT_BYTES = 16 * 1024 * 1024;
const hash = value => createHash('sha256').update(value).digest('hex');
export function alias(name, namespace) {
  const value = (namespace || '') + '/' + name;
  return 'cx_' + value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 36) + '_' + hash(value).slice(0, 12);
}
function mergeTools(values) {
  const merged = new Map();
  for (const t of values) {
    if (!t || typeof t !== 'object') throw new Error('Tool definition must be an object');
    const key = JSON.stringify([t.type, t.name, t.server_label]);
    const value = structuredClone(t);
    if (merged.has(key) && t.type === 'namespace') value.tools = mergeTools([...(merged.get(key).tools || []), ...(t.tools || [])]);
    merged.set(key, value);
  }
  return [...merged.values()];
}
const prefixes = { message: 'msg_', reasoning: 'rs_gateway_', function_call: 'fc_', custom_tool_call: 'ctc_', web_search_call: 'ws_' };
function safeId(id, type) {
  const prefix = prefixes[type];
  if (!prefix || typeof id !== 'string' || id.startsWith(prefix)) return id;
  const suffix = id.replace(/^[a-zA-Z0-9]+_/, '');
  return prefix + (/^[a-zA-Z0-9_-]{1,80}$/.test(suffix) ? suffix : hash(id).slice(0, 48));
}
export class NonGptAdapter {
  constructor(original) {
    this.original = original;
    this.mapping = new Map();
    this.ids = new Map();
    this.stats = { customTools: 0, namespaceTools: 0, carriersRemoved: 0, reasoningSkipped: 0, reasoningConverted: 0, callsRestored: 0, argumentErrors: 0, idsCorrected: 0 };
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
    const data = structuredClone(this.original), carriers = [], removedIds = new Set();
    if (Array.isArray(data.input)) {
      data.input = data.input.flatMap(item => {
        if (item?.type === 'additional_tools') {
          carriers.push(...(item.tools || [])); this.stats.carriersRemoved++;
        } else if (item?.type === 'reasoning') {
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
        item.arguments = JSON.stringify({ input: item.input || '' });
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
      return typeof argumentsText === 'string' ? argumentsText : JSON.stringify(argumentsText);
    }
  }
  item(original) {
    if (!original || typeof original !== 'object') return original;
    let item = { ...original };
    const meta = this.mapping.get(item.name);
    if (meta && item.type === 'function_call') {
      item.name = meta.name;
      if (meta.namespace) item.namespace = meta.namespace;
      if (meta.custom) { item.type = 'custom_tool_call'; item.input = item.arguments ? this.raw(item.arguments) : ''; delete item.arguments; }
    }
    const id = safeId(item.id, item.type);
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
    this.adapter = adapter; this.custom = new Map(); this.arguments = new Map(); this.emitted = new Set(); this.sequence = 0;
  }
  events(original) {
    let event = { ...original };
    const kind = event.type, idx = event.output_index;
    if (kind === 'response.output_item.added') {
      const item = event.item || {}, meta = this.adapter.mapping.get(item.name);
      if (item.type === 'function_call' && meta?.custom) {
        this.custom.set(idx, item); this.arguments.set(idx, item.arguments || '');
      }
      event.item = this.adapter.item(item);
    } else if (kind === 'response.function_call_arguments.delta' && this.custom.has(idx)) {
      const args = this.arguments.get(idx) + (event.delta || '');
      if (Buffer.byteLength(args) > MAX_EVENT_BYTES) throw new Error('Tool input exceeds limit');
      this.arguments.set(idx, args); return [];
    } else if (kind === 'response.function_call_arguments.done' && this.custom.has(idx)) {
      const args = event.arguments || this.arguments.get(idx);
      this.arguments.set(idx, args);
      if (this.emitted.has(idx)) return [];
      this.emitted.add(idx);
      const raw = this.adapter.raw(args);
      const base = { ...event }; delete base.arguments; delete base.name;
      return [{ ...base, type: 'response.custom_tool_call_input.delta', delta: raw }, { ...base, type: 'response.custom_tool_call_input.done', input: raw }];
    } else if (kind === 'response.output_item.done') {
      let item = event.item || {};
      if (this.custom.has(idx) && !item.arguments) item = { ...item, arguments: this.arguments.get(idx) };
      event.item = this.adapter.item(item);
      if (event.item.type === 'custom_tool_call') {
        this.adapter.stats.callsRestored++;
        if (!this.emitted.has(idx)) {
          this.emitted.add(idx);
          const base = { output_index: idx, item_id: event.item.id };
          return [{ ...base, type: 'response.custom_tool_call_input.delta', delta: event.item.input || '' },
            { ...base, type: 'response.custom_tool_call_input.done', input: event.item.input || '' }, event];
        }
      }
    } else if (kind === 'response.function_call_arguments.done' && this.adapter.mapping.has(event.name)) {
      const meta = this.adapter.mapping.get(event.name);
      event.name = meta.name; if (meta.namespace) event.namespace = meta.namespace;
    } else if (event.response) {
      const response = event.response;
      if (Array.isArray(response.output)) event.response = { ...response, output: response.output.map((item, i) => {
        if (item.type === 'function_call' && !item.arguments && this.arguments.has(i)) item = { ...item, arguments: this.arguments.get(i) };
        return this.adapter.item(item);
      }) };
    }
    return [event];
  }
  convert(event) {
    return this.events(event).map(out => ({ ...out,
      ...(this.adapter.ids.has(out.item_id) ? { item_id: this.adapter.ids.get(out.item_id) } : {}),
      sequence_number: this.sequence++ }));
  }
}
