import { createHash } from 'node:crypto';

const prefixes = {
  message: 'msg_', reasoning: 'rs_', function_call: 'fc_',
  custom_tool_call: 'ctc_', custom_tool_call_output: 'ctco_', web_search_call: 'ws_',
};

function correctedId(id, prefix) {
  const suffix = id.replace(/^[a-zA-Z0-9]+_/, '');
  return prefix + (/^[a-zA-Z0-9_-]{1,100}$/.test(suffix) ? suffix : createHash('sha256').update(id).digest('hex').slice(0,48));
}
export function mergeTools(values) {
  const merged = new Map();
  for (const tool of values) {
    if (!tool || typeof tool !== 'object') throw new Error('Tool definition must be an object');
    const key = JSON.stringify([tool.type, tool.name, tool.server_label]), value = structuredClone(tool);
    if (merged.has(key) && tool.type === 'namespace') value.tools = mergeTools([...(merged.get(key).tools || []), ...(tool.tools || [])]);
    merged.set(key, value);
  }
  return [...merged.values()];
}
export function readableReasoning(item) {
  const texts = [];
  for (const value of [...(Array.isArray(item.summary) ? item.summary : []), ...(Array.isArray(item.content) ? item.content : [])]) {
    if (typeof value?.text === 'string') texts.push(value.text);
  }
  for (const key of ['text', 'reasoning']) if (typeof item[key] === 'string') texts.push(item[key]);
  return texts.join('');
}
export function reasoningAsContext(item) {
  const text = readableReasoning(item);
  return text ? { type: 'message', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] } : null;
}

// Native tool carriers are part of incremental Responses history. Moving them
// to top-level tools would lose their inheritance on the next official turn.
export function normalizeOfficialHistory(payload) {
  return normalizeGptHistory(payload, { preserveToolCarriers: true });
}

// Only the outgoing copy changes. Official requests retain native tool carriers;
// stateless API gateways receive a complete top-level catalog on every request.
export function normalizeGptHistory(payload, { preserveToolCarriers = false } = {}) {
  const stats = { foreignReasoningSkipped: 0, foreignReasoningConverted: 0, itemIdsCorrected: 0, referencesCorrected: 0, toolCarriersExtracted: 0 };
  if (!Array.isArray(payload?.input)) return { payload, changed: false, stats };
  const renames = new Map(), removed = new Set(), carriers = [];
  let changed = false;
  let input = payload.input.flatMap(item => {
    if (!item || typeof item !== 'object') return [item];
    if (item.type === 'additional_tools' && preserveToolCarriers && item.role == null) {
      // Some older/dynamic carriers omit the required native control role.
      // This is a protocol field, not a new developer message or instruction.
      changed = true; return [{ ...item, role: 'developer' }];
    }
    if (item.type === 'additional_tools' && !preserveToolCarriers) {
      carriers.push(...(item.tools || [])); if (item.id) removed.add(item.id);
      stats.toolCarriersExtracted++; changed = true; return [];
    }
    const prefix = prefixes[item.type], id = item.id;
    const validId = typeof id === 'string' && id.startsWith(prefix || '\0');
    if (item.type === 'reasoning' && item.encrypted_content) return [item];
    const localReasoningId = typeof id === 'string' && /^rs_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
    if (item.type === 'reasoning' && !item.encrypted_content &&
        (id?.startsWith('rs_gateway_') || localReasoningId || (id && !validId) || (!id && item.content?.length))) {
      // Local/vendor IDs are not references to official server items. Keep the
      // exact existing text as a portable summary, without adding a chat message.
      if (id) removed.add(id);
      changed = true;
      const summary = [];
      for (const block of [...(item.summary || []), ...(item.content || [])]) {
        if (typeof block?.text !== 'string') throw Object.assign(new Error('Foreign reasoning contains a non-text block that cannot be converted losslessly.'), { status: 400, code: 'unsupported_reasoning_history' });
        summary.push({ type: 'summary_text', text: block.text });
      }
      for (const key of ['text', 'reasoning']) if (typeof item[key] === 'string') summary.push({ type: 'summary_text', text: item[key] });
      if (summary.length) { stats.foreignReasoningConverted++; return [{ type: 'reasoning', summary }]; }
      stats.foreignReasoningSkipped++; return [];
    }
    if (prefix && typeof id === 'string' && !validId) {
      const nextId = correctedId(id, prefix);
      renames.set(id, nextId); stats.itemIdsCorrected++; changed = true;
      return [{ ...item, id: nextId }];
    }
    return [item];
  });
  input = input.flatMap(item => {
    if (item?.type !== 'item_reference') return [item];
    if (removed.has(item.id)) { changed = true; stats.foreignReasoningSkipped++; return []; }
    if (renames.has(item.id)) { changed = true; stats.referencesCorrected++; return [{ ...item, id: renames.get(item.id) }]; }
    return [item];
  });
  // A reference without its original foreign item cannot be reconstructed.
  // Leave native references alone; never fabricate or silently drop context.
  if (input.some(item => item?.type === 'item_reference' &&
      (item.id?.startsWith('rs_gateway_') || /^rs_[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(item.id || '')))) {
    throw Object.assign(new Error('Foreign reasoning reference requires its complete original item.'), { status: 400, code: 'incomplete_foreign_history' });
  }
  return { payload: changed ? { ...payload, input, ...(carriers.length ? { tools: mergeTools([...carriers, ...(payload.tools || [])]) } : {}) } : payload, changed, stats };
}

export function isGptModel(model) {
  return typeof model === 'string' && (/^gpt\//i.test(model) || /^gpt(?:-|\d)/i.test(model.split('/').at(-1)));
}

// Responses Lite may leave response.output empty. Keep the original completed
// items from the stream; never reconstruct conversation items from text deltas.
export class ResponseOutput {
  constructor() { this.items = new Map(); this.pending = new Set(); }
  observe(event) {
    const index = event.output_index;
    if (!Number.isInteger(index)) return;
    if (event.type === 'response.output_item.added') this.pending.add(index);
    if (event.type === 'response.output_item.done' && event.item) {
      this.items.set(index, event.item); this.pending.delete(index);
    }
  }
  finish(output) {
    for (const [index, item] of (Array.isArray(output) ? output : []).entries()) {
      const match = item?.id && [...this.items].find(([, value]) => value.id === item.id);
      const key = match ? match[0] : index;
      // A terminal output item is complete. Merging unrelated or stale fields
      // from a stream item can create an object neither endpoint emitted.
      this.items.set(key, item); this.pending.delete(key);
    }
    return { output: [...this.items].sort(([a], [b]) => a - b).map(([, item]) => item), complete: this.pending.size === 0 };
  }
}
