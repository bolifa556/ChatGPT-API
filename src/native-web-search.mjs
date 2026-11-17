import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { usesChat, chatRequest, chatResponse, ChatEvents, chatEndpointUnavailable } from './chat-compat.mjs';
import { decodedStream, ssePackets } from './sse.mjs';
import { releaseResponseBody } from './transport.mjs';
import { searchUrl, searchSources, searchParameters, chatSearchStyle } from './search-compat.mjs';
import { NonGptAdapter } from './non-gpt-compat.mjs';

const fail = (status, code, message) => Object.assign(new Error(message), { status, code });
const MAX_BODY = 16 * 1024 * 1024;
const nativeHeaders = /^(?:x-bf-eh-)?(?:x-openai-internal-codex-responses-lite|x-codex-.+|x-client-request-id|thread-id|session-id)$/i;

async function bytes(stream) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY) throw fail(502, 'search_response_too_large', 'The search response exceeds the compatibility limit.');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, size);
}

async function rejected(response) {
  const raw = await bytes(response.body);
  let data;
  try {
    const decoded = await bytes(decodedStream(Readable.from([raw]), response.headers['content-encoding']));
    data = JSON.parse(decoded.toString('utf8'));
  } catch {}
  return { response: { ...response, body: Readable.from([raw]) }, data, text: raw.toString('utf8') };
}

function unavailable(status, data, text, native) {
  const error = data?.error || {};
  if (error.param === 'model' || /model_not_found|unknown_model|auth|permission|quota|rate_limit/i.test(error.code || error.type || '')) return false;
  if (chatEndpointUnavailable(status, data, text)) return true;
  if (native) return status === 404 && /Cannot POST [^\s<>]*\/alpha\/search(?:[?\s<]|$)/i.test(error.message || text);
  return [400, 422].includes(status) && /^(?:tools|tool_choice|include|enable_search|web_search_options|search_options)(?:\b|\[)/.test(error.param || '')
    && /unsupported|not supported|unrecognized|unknown (?:field|parameter|tool)/i.test(error.message || '');
}

async function collect(response, chat, allowUncited) {
  const items = new Map();
  let ending, received = 0;
  const observe = event => {
    if (event.type === 'response.output_item.done') items.set(event.item.id || event.output_index, event.item);
    if (event.response?.output) for (const [index, item] of event.response.output.entries()) items.set(item.id || index, item);
    if (['response.completed', 'response.failed', 'response.incomplete', 'error'].includes(event.type)) ending = event;
  };
  try {
    if (String(response.headers['content-type']).includes('text/event-stream')) {
      const conversion = chat ? new ChatEvents('') : null;
      for await (const packet of ssePackets(decodedStream(response.body, response.headers['content-encoding']))) {
        received += Buffer.byteLength(packet.raw || '');
        if (received > MAX_BODY) throw fail(502, 'search_response_too_large', 'The search stream exceeds the compatibility limit.');
        if (packet.done) break;
        if (!packet.data) continue;
        const event = !packet.data.type && packet.event ? { ...packet.data, type: packet.event } : packet.data;
        if (conversion) conversion.convert(event).forEach(observe);
        else observe(event);
        if (ending) break;
      }
      if (conversion) conversion.finish().forEach(observe);
    } else {
      const raw = await bytes(decodedStream(response.body, response.headers['content-encoding']));
      const data = JSON.parse(raw.toString('utf8'));
      const value = chat ? chatResponse(data, '') : data;
      observe({ type: value.status === 'completed' ? 'response.completed' : 'response.incomplete', response: value });
    }
    if (ending?.type !== 'response.completed') {
      const error = ending?.error || ending?.response?.error;
      throw Object.assign(fail(502, 'search_upstream_incomplete', error?.message || 'The search response did not complete.'), error ? { upstreamError: error } : {});
    }
    const output = [...items.values()];
    const actions = output.filter(item => item.type === 'web_search_call' && item.status === 'completed').map(item => item.action || {});
    if (output.some(item => /_call$/.test(item.type || '') && item.type !== 'web_search_call')) {
      throw fail(502, 'unexpected_search_tool', 'The search API returned an external tool call instead of executing its built-in search.');
    }
    const sources = new Map(searchSources(ending.response).map(source => [source.url, source]));
    const parts = [];
    const add = source => {
      const url = searchUrl(source?.url);
      if (url) sources.set(url, { ...sources.get(url), ...source, url, title: source.title || sources.get(url)?.title || url });
    };
    for (const item of output) {
      if (item.type === 'web_search_call') {
        for (const source of item.action?.sources || []) add(source);
        if (item.action?.url) add({ url: item.action.url });
      }
      if (item.type === 'message') for (const part of item.content || []) {
        if (part.type === 'output_text') parts.push(part);
        for (const annotation of part.annotations || []) if (annotation.type === 'url_citation') add(annotation);
      }
    }
    const declaredChatResult = chat && allowUncited && parts.some(part => part.text);
    if (!actions.length && !declaredChatResult && (!chat || !sources.size)) throw fail(502, 'search_not_executed', 'The API returned no executed search or search-source evidence.');
    return { parts, actions, sources: [...sources.values()] };
  } finally { releaseResponseBody(response.body); }
}

function domains(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some(domain => typeof domain !== 'string' || !/^(?:[a-z0-9-]+\.)*[a-z0-9-]+$/i.test(domain))) {
    throw fail(400, 'invalid_search_filter', 'Search domains must be hostname lists.');
  }
  const result = [...new Set(value.map(domain => domain.toLowerCase()))];
  return result.length ? result : undefined;
}
const matches = (host, domain) => host === domain || host.endsWith('.' + domain);
function filtersFor(settings, requested) {
  const global = domains(settings.filters?.allowed_domains), local = domains(requested);
  let allowed = local ?? global;
  if (local && global) allowed = [...new Set(local.flatMap(domain => global.flatMap(other =>
    matches(domain, other) ? [domain] : matches(other, domain) ? [other] : [])))];
  if (allowed?.length === 0) throw fail(400, 'empty_search_filter', 'The requested search domains have no overlap.');
  const blocked = domains(settings.filters?.blocked_domains);
  return { ...(allowed ? { allowed_domains: allowed } : {}), ...(blocked ? { blocked_domains: blocked } : {}) };
}
function accepts(url, filters) {
  const host = new URL(url).hostname.toLowerCase();
  return (!filters.allowed_domains || filters.allowed_domains.some(domain => matches(host, domain)))
    && !filters.blocked_domains?.some(domain => matches(host, domain));
}

export class NativeWebSearch {
  constructor(sources, { now = Date.now } = {}) {
    this.sources = sources;
    this.now = now;
    this.sessions = new Map();
  }
  prepare(body, gateway) {
    if (typeof body.id !== 'string' || !body.id || body.id.length > 200) throw fail(400, 'invalid_search_request', 'A search session ID is required.');
    const settings = body.settings || {}, commands = body.commands;
    if (typeof settings !== 'object' || Array.isArray(settings)) throw fail(400, 'invalid_search_settings', 'Search settings must be an object.');
    if (!commands || typeof commands !== 'object' || Array.isArray(commands)) throw fail(400, 'missing_search_commands', 'Explicit search commands are required.');
    for (const [name, value] of Object.entries(commands)) {
      if (value != null && !['search_query', 'open', 'find', 'response_length'].includes(name)) {
        throw fail(400, 'unsupported_search_command', 'This API search protocol cannot represent the native command: ' + name);
      }
    }
    for (const name of ['search_query', 'open', 'find']) {
      if (commands[name] !== undefined && !Array.isArray(commands[name])) throw fail(400, 'invalid_search_commands', 'Search command groups must be arrays.');
    }
    const scope = crypto.createHash('sha256').update([gateway.base, gateway.profile.apiKey, body.id].join('\n')).digest('hex');
    for (const [key, value] of this.sessions) if (this.now() - value.at > 30 * 60 * 1000) this.sessions.delete(key);
    let session = this.sessions.get(scope);
    if (!session) {
      session = { refs: new Map(), next: this.now(), at: this.now() };
      this.sessions.set(scope, session);
    }
    session.at = this.now();
    while (this.sessions.size > 64) this.sessions.delete(this.sessions.keys().next().value);
    const resolve = ref => {
      const url = session.refs.get(ref)?.url || searchUrl(ref);
      if (!url) throw fail(400, 'invalid_search_reference', 'Use a result ID from this search session or an HTTP(S) URL.');
      return url;
    };
    const plans = new Map();
    const add = (name, operation, requested) => {
      const filters = filtersFor(settings, requested), key = JSON.stringify(filters);
      if (operation.ref_id && !accepts(operation.ref_id, filters)) throw fail(400, 'search_domain_blocked', 'The search reference is outside the requested domains.');
      if (!plans.has(key)) plans.set(key, { filters, commands: { response_length: commands.response_length } });
      (plans.get(key).commands[name] ||= []).push(operation);
    };
    for (const query of commands.search_query || []) {
      if (typeof query?.q !== 'string' || !query.q.trim()) throw fail(400, 'invalid_search_query', 'A nonempty search query is required.');
      if (query.recency !== undefined && (!Number.isSafeInteger(query.recency) || query.recency < 0)) throw fail(400, 'invalid_search_query', 'Search recency must be a nonnegative integer.');
      add('search_query', query, query.domains);
    }
    for (const operation of commands.open || []) {
      if (operation?.lineno !== undefined && (!Number.isSafeInteger(operation.lineno) || operation.lineno < 0)) throw fail(400, 'invalid_search_reference', 'A page line number must be a nonnegative integer.');
      add('open', { ...operation, ref_id: resolve(operation?.ref_id) });
    }
    for (const operation of commands.find || []) {
      if (typeof operation?.pattern !== 'string' || !operation.pattern) throw fail(400, 'invalid_search_pattern', 'A find pattern is required.');
      add('find', { ...operation, ref_id: resolve(operation.ref_id) });
    }
    if (!plans.size) throw fail(400, 'missing_search_commands', 'No search operation was supplied.');
    return { plans: [...plans.values()], session, settings };
  }
  payload(body, gateway, plan, settings, chat) {
    const tool = { type: 'web_search', ...(Object.keys(plan.filters).length ? { filters: plan.filters } : {}) };
    for (const name of ['user_location', 'search_context_size', 'external_web_access']) {
      if (settings[name] !== undefined) tool[name] = structuredClone(settings[name]);
    }
    if (['cached', 'indexed'].includes(tool.external_web_access)) tool.external_web_access = false;
    if (tool.external_web_access === 'live') tool.external_web_access = true;
    const input = typeof body.input === 'string' ? [{ role: 'user', content: body.input }] : body.input || [];
    if (!Array.isArray(input)) throw fail(400, 'invalid_search_input', 'Search input must be text or message items.');
    const payload = { model: gateway.model, input: [...input, { role: 'user',
      content: 'Execute these web search operations and return retrieved evidence with source URLs.\n' + JSON.stringify(plan.commands) }],
      tools: [tool], tool_choice: { type: 'web_search' }, stream: true, store: false, include: ['web_search_call.action.sources'] };
    for (const name of ['reasoning', 'max_output_tokens', ...searchParameters]) if (body[name] !== undefined) payload[name] = structuredClone(body[name]);
    if (!chat) return payload;
    const converted = new NonGptAdapter(payload).request({ releaseOriginal: true });
    return chatRequest(converted, gateway.metadata, gateway);
  }
  result(found, prepared) {
    const sources = new Map();
    for (const value of found) for (const source of value.sources) sources.set(source.url, { ...sources.get(source.url), ...source });
    const turn = prepared.session.next++;
    const references = [...sources.values()].map((source, index) => ({ ...source, type: 'text_result', ref_id: `turn${turn}search${index}` }));
    const byUrl = new Map(references.map(source => [source.url, source]));
    for (const source of references) prepared.session.refs.set(source.ref_id, source);
    while (prepared.session.refs.size > 256) prepared.session.refs.delete(prepared.session.refs.keys().next().value);
    const output = [];
    for (const value of found) for (const part of value.parts) {
      let text = part.text || '';
      const edits = new Map();
      for (const citation of part.annotations || []) {
        const source = byUrl.get(searchUrl(citation.url));
        if (!source || !Number.isInteger(citation.end_index) || citation.end_index < 0 || citation.end_index > text.length) continue;
        const start = citation.start_index, end = citation.end_index;
        const marker = `cite${source.ref_id}`;
        const original = text.slice(start, end);
        const from = Number.isInteger(start) && /^cite[^]*$/.test(original) ? start : end;
        const key = from + '/' + end;
        if (!edits.has(key)) edits.set(key, { start: from, end, markers: new Set() });
        edits.get(key).markers.add(marker);
      }
      for (const edit of [...edits.values()].sort((a, b) => b.start - a.start)) {
        text = text.slice(0, edit.start) + [...edit.markers].join('') + text.slice(edit.end);
      }
      output.push(text);
    }
    if (references.length) output.push(references.map(source => `[${source.ref_id}] ${source.title}\n${source.url}`).join('\n\n'));
    return { encrypted_output: null, output: output.join('\n\n'), results: references };
  }
  async run(body, { gateway, send, headers, signal }) {
    const cached = this.sources.searchProtocol(gateway);
    const declared = gateway.metadata?.supported_endpoints;
    const preferChat = usesChat({ model: gateway.model }, gateway.metadata)
      || !declared?.length && chatSearchStyle(gateway) !== 'tools';
    const compatible = preferChat ? ['chat', 'responses'] : ['responses', 'chat'];
    const protocols = [...new Set([cached || 'native', 'native', ...compatible])];
    let prepared, last;
    for (const protocol of protocols) {
      signal?.throwIfAborted();
      if (protocol === 'native') {
        const response = await send('/alpha/search', { ...body, model: gateway.model }, headers);
        if (response.statusCode >= 200 && response.statusCode < 300) {
          this.sources.rememberSearch(gateway, protocol);
          return response;
        }
        if (![400, 404, 405, 501].includes(response.statusCode)) return response;
        last = await rejected(response);
        if (!unavailable(response.statusCode, last.data, last.text, true)) return last.response;
        continue;
      }
      prepared ||= this.prepare(body, gateway);
      const outgoing = Object.fromEntries(Object.entries(headers).filter(([name]) => !nativeHeaders.test(name)));
      const values = [];
      let declined = false;
      for (const plan of prepared.plans) {
        signal?.throwIfAborted();
        const payload = this.payload(body, gateway, plan, prepared.settings, protocol === 'chat');
        const response = await send(protocol === 'chat' ? '/chat/completions' : '/responses',
          payload, outgoing);
        if (response.statusCode < 200 || response.statusCode >= 300) {
          last = await rejected(response);
          // A generated result is never replayed after another operation fails.
          if (values.length || !unavailable(response.statusCode, last.data, last.text, false)) return last.response;
          declined = true;
          break;
        }
        // Chat search APIs may document an enable switch without source metadata.
        // Keep their actual text; do not fabricate a search event or citations.
        const allowUncited = payload.enable_search === true || payload.web_search_options !== undefined
          || chatSearchStyle(gateway) === 'builtin'
          || payload.tools?.some(tool => tool.type === 'web_search' && tool.web_search?.enable === true);
        const value = await collect(response, protocol === 'chat', allowUncited);
        if (value.sources.some(source => !accepts(source.url, plan.filters))) throw fail(502, 'search_filter_not_honored', 'The API returned a source outside the requested search domains.');
        for (const [name, type] of [['open', 'open_page'], ['find', 'find_in_page']]) for (const operation of plan.commands[name] || []) {
          const verified = protocol === 'chat' ? value.sources.some(source => source.url === operation.ref_id)
            : value.actions.some(action => action.type === type && searchUrl(action.url) === operation.ref_id
              && (name !== 'find' || action.pattern === operation.pattern));
          if (!verified) throw fail(502, 'search_operation_not_executed', 'The API did not execute the requested ' + name + ' operation on its target URL.');
        }
        values.push(value);
      }
      if (declined) continue;
      this.sources.rememberSearch(gateway, protocol);
      const value = this.result(values, prepared);
      return { statusCode: 200, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
        body: Readable.from([JSON.stringify(value)]) };
    }
    return last.response;
  }
}
