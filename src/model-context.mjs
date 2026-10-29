import fs from 'node:fs';
import path from 'node:path';

export const CONTEXT_CAP = 500000;
export const contextFields = ['context_window', 'max_context_window', 'context_length', 'max_model_len',
  'max_input_tokens', 'max_input_length', 'max_sequence_length', 'limits', 'model_info'];
export function tokenCount(value) {
  if (typeof value === 'string') {
    const match = value.trim().replaceAll(',', '').match(/^(\d+(?:\.\d+)?)\s*([kKmM]?)$/);
    if (!match) return null;
    value = Number(match[1]) * ({ k: 1000, m: 1000000 }[match[2].toLowerCase()] || 1);
  }
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}
export function reportedCapacity(model) {
  const objects = [model, model?.limits, model?.model_info, model?.architecture];
  // A deployment's configured limit takes precedence over the architecture's capacity.
  const deployed = tokenCount(model?.max_model_len);
  if (deployed) return deployed;
  for (const object of objects) {
    const limits = ['context_window', 'context_length', 'max_context_window', 'max_sequence_length',
      'max_input_tokens', 'max_input_length'].map(key => tokenCount(object?.[key])).filter(Boolean);
    if (limits.length) return Math.min(...limits);
  }
  return null;
}
export function contextKey(base, id) {
  const url = new URL(base);
  url.pathname = url.pathname.replace(/\/+$/, '');
  return JSON.stringify([url.href.replace(/\/$/, ''), id]);
}
function documentedCapacity(id, known) {
  const leaf = id.split('/').at(-1), prefix = id.includes('/') ? id.slice(0, id.lastIndexOf('/')) : '';
  if (/^vllm$/i.test(prefix)) return null;
  // Match specifications without rewriting the case-sensitive upstream ID or cache key.
  const alias = Object.entries(known.aliases || {}).find(([name]) => name.toLowerCase() === id.toLowerCase())?.[1];
  const entry = Object.entries(known.models || {}).find(([name]) => name.toLowerCase() === (alias || leaf).toLowerCase())?.[1];
  return entry && { capacity: tokenCount(entry.tokens), source: entry.source, ...(alias ? { aliasOf: alias } : {}) };
}
export function rememberContexts({ file, base, models, official = [], known = {}, write }) {
  let saved; try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  const cache = saved?.version === 1 && saved.entries && !Array.isArray(saved.entries)
    ? saved : { version: 1, entries: {} };
  let changed = false;
  for (const model of models) {
    const key = contextKey(base, model.id), previous = cache.entries[key];
    const documented = documentedCapacity(model.id, known);
    // 3.1.0 could cache a native default window as a gateway's actual capacity.
    // Correct only that inferred record from local specifications; upstream limits remain authoritative.
    const inferredDefault = previous?.source === 'native-model-catalog' && documented?.capacity > previous.capacity;
    if (previous && tokenCount(previous.capacity) && !inferredDefault) continue;
    let found, capacity = reportedCapacity(model);
    if (capacity) found = { capacity, source: 'gateway-model-metadata' };
    if (!found && documented?.capacity) found = documented;
    const leaf = model.id.split('/').at(-1);
    if (!found && (/^gpt(?:-|\d)/i.test(leaf) || /^gpt\//i.test(model.id))) {
      const native = official.find(item => item.slug?.toLowerCase() === leaf.toLowerCase());
      capacity = tokenCount(native?.max_context_window);
      if (capacity) found = { capacity, source: 'native-model-catalog-max' };
    }
    // Unreported capacities remain explicitly unverified; never label a GPT template as an upstream fact.
    if (!found && previous?.capacity === null) continue;
    cache.entries[key] = { ...(found || { capacity: null, source: 'unreported' }), checkedAt: new Date().toISOString() };
    changed = true;
  }
  if (changed) {
    if (write) write(file, cache);
    else {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const temporary = file + '.' + process.pid + '.tmp';
      fs.writeFileSync(temporary, JSON.stringify(cache, null, 2) + '\n', { mode: 0o600 });
      fs.renameSync(temporary, file);
    }
  }
  return cache;
}
export function applyContext(model, record, { limit: configuredLimit = CONTEXT_CAP, override } = {}) {
  const capacity = tokenCount(record?.capacity);
  const fallback = tokenCount(model.context_window) || 128000;
  const desired = tokenCount(override) || capacity || fallback;
  const limit = Math.min(desired, capacity || desired, tokenCount(configuredLimit) || CONTEXT_CAP);
  model.context_window = limit;
  model.max_context_window = limit;
  // Let the native client derive its compaction threshold from this model's window.
  model.auto_compact_token_limit = null;
  return model;
}
