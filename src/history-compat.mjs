import { createHash } from 'node:crypto';

const prefixes = {
  message: 'msg_', reasoning: 'rs_', function_call: 'fc_',
  custom_tool_call: 'ctc_', custom_tool_call_output: 'ctco_', web_search_call: 'ws_',
};

function correctedId(id, prefix) {
  const suffix = id.replace(/^[a-zA-Z0-9]+_/, '');
  return prefix + (/^[a-zA-Z0-9_-]{1,100}$/.test(suffix) ? suffix : createHash('sha256').update(id).digest('hex').slice(0,48));
}
export function readableReasoning(item) {
  const texts = [];
  for (const value of [...(Array.isArray(item.summary) ? item.summary : []), ...(Array.isArray(item.content) ? item.content : [])]) {
    if (typeof value?.text === 'string' && value.text.trim()) texts.push(value.text);
  }
  for (const key of ['text', 'reasoning']) if (typeof item[key] === 'string' && item[key].trim()) texts.push(item[key]);
  return [...new Set(texts)].join('\n\n');
}
export function reasoningAsContext(item) {
  const text = readableReasoning(item);
  return text ? { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '[Earlier assistant reasoning / summary, retained as conversation context]\n' + text, annotations: [] }] } : null;
}

// Apply only when sending to a GPT endpoint. Other providers keep their own
// history format. This never mutates the saved conversation or the input object.
export function normalizeGptHistory(payload) {
  const stats = { foreignReasoningSkipped: 0, foreignReasoningConverted: 0, itemIdsCorrected: 0, referencesCorrected: 0 };
  if (!Array.isArray(payload?.input)) return { payload, changed: false, stats };
  const renames = new Map(), removed = new Set();
  let changed = false;
  let input = payload.input.flatMap(item => {
    if (!item || typeof item !== 'object') return [item];
    const prefix = prefixes[item.type], id = item.id;
    const validId = typeof id === 'string' && id.startsWith(prefix || '\0');
    if (item.type === 'reasoning' && (id?.startsWith('rs_gateway_') || (!validId && !item.encrypted_content))) {
      // A third-party summary cannot be turned into an OpenAI reasoning item by
      // renaming its ID: the official service then returns "item not found".
      if (id) removed.add(id);
      changed = true;
      const context = reasoningAsContext(item);
      if (context) { stats.foreignReasoningConverted++; return [context]; }
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
  return { payload: changed ? { ...payload, input } : payload, changed, stats };
}

export function isGptModel(model) {
  return typeof model === 'string' && (/^gpt\//i.test(model) || /^gpt(?:-|\d)/i.test(model.split('/').at(-1)));
}
