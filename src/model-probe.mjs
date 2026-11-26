import fs from 'node:fs';
import path from 'node:path';
import { isGptModel } from './history-compat.mjs';
import { imageCapabilities } from './image-compat.mjs';
import { usesChat, chatEndpointUnavailable } from './chat-compat.mjs';
import { modelStrengths, strengthLevels, PROBE_REASONING_LEVELS } from './model-strength.mjs';
import { contextKey, rememberContexts } from './model-context.mjs';
import { atomicPrivate, overrideKey } from './settings.mjs';
import { requestWithAbort, releaseResponseBody } from './transport.mjs';
import { decodedStream, ssePackets } from './sse.mjs';

const unknown = () => ({ status: 'unknown', levels: [], highest: null, source: 'model-validation' });
const read = (file, fallback = {}) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };
function message(data) {
  if (typeof data?.error === 'string') return data.error;
  if (data?.error?.message) return data.error.message;
  if (typeof data?.message === 'string') return data.message;
  if (typeof data?.detail === 'string') return data.detail;
  const detail = data?.detail?.find?.(item => item.loc?.some?.(part => /reasoning|effort|complexity|quality/.test(part)));
  return detail ? detail.loc.join('.') + ' ' + detail.msg : '';
}
export function probeLevels(data, field = 'reasoning') {
  const error = data?.error || data;
  if (error?.param && !new RegExp(field === 'reasoning' ? 'reasoning|effort' : field, 'i').test(error.param)) return [];
  const text = message(data);
  if (field === 'reasoning' && !error?.param && !/reasoning[_ .]?effort|level.+not supported.+valid levels/i.test(text)) return [];
  let values = error?.allowed_values || error?.supported_values;
  if (!Array.isArray(values)) {
    const patterns = [
      /valid (?:levels|values)\s*:\s*([^\n]+)/i,
      /reasoning[_ ]effort must be ([^\n]+)/i,
      /(?:only|must be one of)\s+([^\n]+?)\s+(?:is|are) allowed/i,
      /expected one of\s+([^\n]+)/i,
      /(?:supported|allowed) (?:values|levels)(?: are|:)\s*([^\n]+)/i,
      /input should be\s+([^\n]+)/i,
    ];
    const list = patterns.map(pattern => pattern.exec(text)?.[1]).find(Boolean);
    if (!list || !new RegExp(field === 'reasoning' ? 'reasoning|effort|level|variant' : field, 'i').test(text)) return [];
    const canonical = list.replace(/\([^)]*\balias(?:es)?\b[^)]*\)/gi, '');
    values = (canonical.match(/\b(?:none|off|minimal|low|standard|medium|high|hd|xhigh|max|ultra)\b/gi) || []).map(level => level.toLowerCase());
  }
  const levels = strengthLevels(values, 'probe')?.levels || [];
  return field === 'quality' ? levels : levels.filter(level => PROBE_REASONING_LEVELS.includes(level));
}

async function responseData(response) {
  if (!String(response.headers['content-type']).includes('text/event-stream')) {
    const text = await response.body.text();
    try { return JSON.parse(text); } catch { return { error: { message: text.slice(0, 1600) } }; }
  }
  let data = {};
  for await (const packet of ssePackets(decodedStream(response.body, response.headers['content-encoding']))) {
    if (packet.done) break;
    const event = packet.data;
    if (!event) continue;
    if (event.error || event.type === 'error') return { error: event.error || event };
    if (event.response) data = event.response;
    if (['response.completed', 'response.incomplete', 'response.failed'].includes(event.type)) break;
  }
  return data;
}

function requester(pool, model, signal) {
  const target = pool.target(model.id);
  let chat = usesChat({ model: target.model }, target.metadata);
  async function send({ effort } = {}) {
    signal?.throwIfAborted();
    const timeout = AbortSignal.timeout(30000);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const endpoint = chat ? '/chat/completions' : '/responses';
    const payload = chat ? { model: target.model, messages: [{ role: 'user', content: 'Reply only OK.' }], max_tokens: 16, stream: false,
        ...(effort ? { reasoning_effort: effort } : {}) }
      : { model: target.model, input: 'Reply only OK.', max_output_tokens: 16, stream: false, store: false,
        ...(effort ? { reasoning: { effort } } : {}) };
    let response;
    try {
      response = await requestWithAbort(target.base + endpoint, { method: 'POST',
        headers: { authorization: 'Bearer ' + target.profile.apiKey, 'content-type': 'application/json', accept: 'application/json', 'accept-encoding': 'identity' },
        body: JSON.stringify(payload), dispatcher: target.dispatcher, signal: requestSignal, headersTimeout: 30000, bodyTimeout: 30000 });
      if (response.statusCode >= 200 && response.statusCode < 300) return { status: response.statusCode, data: {} };
      const data = await responseData(response);
      if (!chat && chatEndpointUnavailable(response.statusCode, data, message(data))) {
        chat = true;
        releaseResponseBody(response.body);
        return send({ effort });
      }
      return { status: response.statusCode, data };
    } finally { releaseResponseBody(response?.body); }
  }
  return send;
}

async function reasoningProbe(send) {
  const initial = await send({ effort: 'invalid_probe' });
  const levels = [400, 422].includes(initial.status) ? probeLevels(initial.data) : [];
  return levels.length ? strengthLevels(levels, 'model-validation') : unknown();
}

export async function probeModels(pool, { signal } = {}) {
  const file = path.join(pool.root, 'data/cache/model-contexts.json');
  const official = read(path.join(pool.root, 'data/cache/catalog-state.json')).official || [];
  const known = read(path.join(pool.root, 'assets/model-contexts.json'));
  let cache = read(file, { version: 1, entries: {} });
  for (const profile of pool.profiles()) {
    cache = rememberContexts({ file, base: profile.baseUrl, official, known,
      models: pool.models.filter(model => model._providerId === profile.id && !imageCapabilities(model).known)
        .map(model => ({ ...model, id: model._upstreamId })) });
  }
  const models = pool.models.filter(model => !isGptModel(model._upstreamId) &&
    pool.saved.statuses?.some(source => source.id === model._providerId && source.ready));
  let next = 0;
  function save() {
    for (const record of Object.values(cache.entries)) delete record.checkedAt;
    atomicPrivate(file, cache);
  }
  async function worker() {
    while (next < models.length) {
      signal?.throwIfAborted();
      const model = models[next++], profile = pool.profile(model._providerId);
      const key = contextKey(profile.baseUrl, model._upstreamId), override = overrideKey(profile.id, model._upstreamId);
      const record = cache.entries[key] ||= { capacity: null, source: 'unreported' };
      const strengths = modelStrengths(model, official, record.strengths, {});
      const configured = pool.settings.strengthOverrides[override] || {};
      const image = imageCapabilities(model).known;
      const fields = image ? ['complexity', 'quality'] : ['reasoning'];
      let declared = false;
      for (const field of fields) if (strengths[field].status !== 'unknown' &&
          JSON.stringify(strengths[field]) !== JSON.stringify(record.strengths?.[field])) {
        record.strengths ||= {};
        record.strengths[field] = strengths[field];
        declared = true;
      }
      const missing = fields
        .filter(field => !configured[field] && strengths[field].status === 'unknown' &&
          (!record.strengths?.[field] || field === 'reasoning' && ['probe', 'probe-confirmed'].includes(record.strengths[field].source)));
      if (!missing.length) { if (declared) save(); continue; }
      // Record the attempt before sending so an interrupted refresh cannot
      // schedule the same validation again.
      record.strengths ||= {};
      for (const field of missing) record.strengths[field] = unknown();
      save();
      if (!image) {
        try {
          record.strengths.reasoning = await reasoningProbe(requester(pool, model, signal));
        } catch { signal?.throwIfAborted(); }
      }
      save();
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, models.length) }, worker));
  pool.collect(pool.saved.sources);
}
