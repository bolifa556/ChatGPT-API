#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Agent, ProxyAgent, request } from 'undici';
import WebSocket, { WebSocketServer } from 'ws';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { normalizeGptHistory, normalizeOfficialHistory, isGptModel, ResponseOutput } from './history-compat.mjs';
import { NonGptAdapter, NonGptEvents, validateNonGptCompaction } from './non-gpt-compat.mjs';
import { usesChat, chatRequest, chatResponse, ChatEvents } from './chat-compat.mjs';
import { decodedStream, ssePackets, encodeSse } from './sse.mjs';
import { forwardImages, imageOnlyModel, imageCapabilities } from './image-compat.mjs';

const dir = path.dirname(fileURLToPath(import.meta.url));
const root = process.env.CHATGPT_API_ROOT || path.dirname(dir);
const dataDir = path.join(root, 'data');
const cacheDir = path.join(dataDir, 'cache');
const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const readJson = (file, fallback = null) => { try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return fallback; } };
function atomic(file, value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n';
  try { if (fs.readFileSync(file, 'utf8') === text) return; } catch {}
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text); fs.renameSync(tmp, file);
}
function readEnv() {
  return Object.fromEntries(fs.readFileSync(process.env.CHATGPT_API_ENV_PATH || path.join(dataDir, '.env'), 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)
    .filter(s => s.trim() && !s.trim().startsWith('#') && s.indexOf('=') > 0)
    .map(s => { const n = s.indexOf('='); return [s.slice(0, n).trim(), s.slice(n + 1).trim()]; }));
}
const env = readEnv();
const runtime = readJson(path.join(dataDir, 'state', 'route-state.json'), {});
const entryMode = runtime.entryMode || 'api';
const mode = entryMode === 'apionly' ? 'gateway' : runtime.mode || 'mixed';
const gatewayEnabled = entryMode !== 'official';
const gatewayBase = (process.env.CHATGPT_GATEWAY_BASE || env.BASE_URL || '').replace(/\/+$/, '');
const officialBase = (env.OFFICIAL_BASE || 'https://chatgpt.com/backend-api/codex').replace(/\/+$/, '');
if (!/^https?:\/\//.test(gatewayBase) || !env.API_KEY) throw new Error('BASE_URL or API_KEY is missing.');
const officialProxy = runtime.officialProxy ?? '';
const transport = runtime.gatewayTransport || env.GATEWAY_TRANSPORT || 'direct';
const tunnelPort = Number(env.GATEWAY_TUNNEL_PORT || 18003);
const gatewayUrl = new URL(gatewayBase);
const gatewayDispatcher = new Agent(transport === 'ssh' ? { connect: { hostname: '127.0.0.1', port: tunnelPort, servername: gatewayUrl.hostname } } : {});
const officialDispatcher = officialProxy ? new ProxyAgent({ uri: officialProxy, connect: { timeout: 10000 } }) : new Agent({ connect: { timeout: 10000 } });
const sourceId = crypto.createHash('sha256').update(gatewayBase + '\n' + env.API_KEY).digest('hex');
const buildHash = crypto.createHash('sha256');
for (const name of ['shim.mjs','history-compat.mjs','non-gpt-compat.mjs','sse.mjs','chat-compat.mjs','image-compat.mjs']) buildHash.update(fs.readFileSync(path.join(dir, name)));
const buildId = buildHash.digest('hex');
const cachePath = path.join(cacheDir, 'catalog-state.json');
const logFile = path.join(dataDir, 'logs', 'shim.log');
const CACHE_MAX_AGE = 24 * 60 * 60 * 1000;
let catalog = { official: [], gatewayIds: [], gatewayModels: [], gatewayAt: null, officialAt: null, sourceId };
let status = { gateway: { ready: false }, official: { ready: false } };
let refreshInFlight;
let observedClientVersion, configuredVersionAtObservation;
const controllers = new Set();

function log(text) {
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > 5 * 1024 * 1024) {
      fs.rmSync(logFile + '.1', { force: true }); fs.renameSync(logFile, logFile + '.1');
    }
    fs.appendFileSync(logFile, '[' + new Date().toISOString() + '] ' + text.replaceAll(env.API_KEY, '[redacted]') + '\n');
  } catch {}
}
function auth() {
  const saved = readJson(path.join(codexHome, 'auth.json'), {});
  if (saved.auth_mode && saved.auth_mode !== 'chatgpt') return {};
  return { token: saved.tokens?.access_token || '', accountId: saved.tokens?.account_id || '' };
}
function accountIdentity() { return crypto.createHash('sha256').update(auth().accountId || '').digest('hex'); }
const validClientVersion = version => typeof version === 'string' && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version);
function currentClientVersion() {
  const configured = readJson(path.join(dataDir, 'state', 'route-state.json'), runtime).clientVersion;
  if (configured === configuredVersionAtObservation && validClientVersion(observedClientVersion)) return observedClientVersion;
  return validClientVersion(configured) ? configured : null;
}
function loadCatalog() {
  const saved = readJson(cachePath, {});
  if (saved.sourceId === sourceId && Date.now() - Date.parse(saved.gatewayAt) < CACHE_MAX_AGE) {
    catalog.gatewayIds = Array.isArray(saved.gatewayIds) ? saved.gatewayIds : [];
    catalog.gatewayModels = Array.isArray(saved.gatewayModels) ? saved.gatewayModels : catalog.gatewayIds.map(id => ({ id }));
    catalog.gatewayAt = saved.gatewayAt;
  }
  const native = readJson(path.join(codexHome, 'models_cache.json'), {});
  if (Array.isArray(native.models) && native.models.length) catalog.official = native.models;
  if (saved.accountIdentity === accountIdentity() && saved.official?.length &&
      Date.parse(saved.officialAt || '') > Date.parse(native.fetched_at || '')) {
    catalog.official = saved.official; catalog.officialAt = saved.officialAt;
  }
  if (!catalog.official.length && saved.accountIdentity === accountIdentity() && saved.official?.length) {
    catalog.official = saved.official; catalog.officialAt = saved.officialAt;
  }
}
function saveCatalog() {
  atomic(cachePath, { ...catalog, sourceId, accountIdentity: accountIdentity(), checkedAt: new Date().toISOString(), status });
}
function acceptOfficialCatalog(data, clientVersion) {
  if (!Array.isArray(data.models) || !data.models.length) throw new Error('Official model response has no catalog');
  catalog.official = data.models;
  catalog.officialAt = new Date().toISOString();
  catalog.officialClientVersion = clientVersion;
  status.official = { ready: true, checkedAt: catalog.officialAt, models: data.models.length, clientVersion };
}
async function fetchJson(url, headers, dispatcher, timeout = 12000, signal) {
  const boundedSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout);
  const r = await request(url, { headers, dispatcher, signal: boundedSignal, headersTimeout: timeout, bodyTimeout: timeout });
  const text = await r.body.text();
  if (r.statusCode < 200 || r.statusCode >= 300) throw new Error('HTTP ' + r.statusCode);
  return JSON.parse(text);
}
async function refreshCatalog() {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    await Promise.all([
      (async () => {
        if (!gatewayEnabled) { status.gateway = { ready: false, enabled: false }; return; }
        try {
          const data = await fetchJson(gatewayBase + '/models', { authorization: 'Bearer ' + env.API_KEY }, gatewayDispatcher);
          const ids = [...new Set((data.data || []).map(m => m.id).filter(id => typeof id === 'string' && id))];
          if (!ids.length) throw new Error('Gateway returned no models');
          catalog.gatewayIds = ids; catalog.gatewayAt = new Date().toISOString();
          catalog.gatewayModels = (data.data || []).filter(m => ids.includes(m.id)).map(m => Object.fromEntries(
            ['id','type','capabilities','supported_endpoints','output_modalities','architecture',
              'service_tiers','additional_speed_tiers','default_service_tier'].filter(key => m[key] !== undefined).map(key => [key,m[key]])));
          status.gateway = { ready: true, checkedAt: catalog.gatewayAt, models: ids.length };
        } catch (e) { status.gateway = { ready: false, error: e.message, checkedAt: new Date().toISOString(), cachedAt: catalog.gatewayAt }; }
      })(),
      (async () => {
        if (mode !== 'mixed') { status.official = { ready: false, enabled: false }; return; }
        const a = auth();
        if (!a.token) { status.official = { ready: false, error: 'No saved ChatGPT sign-in' }; return; }
        try {
          const version = currentClientVersion();
          if (!version) throw new Error('Native client version is unavailable; reopen the launcher after native client initialization.');
          const headers = { authorization: 'Bearer ' + a.token, ...(a.accountId ? { 'chatgpt-account-id': a.accountId } : {}) };
          const data = await fetchJson(officialBase + '/models?client_version=' + encodeURIComponent(version), headers, officialDispatcher);
          acceptOfficialCatalog(data, version);
        } catch (e) { status.official = { ready: false, error: e.message, cached: catalog.official.length > 0 }; }
      })(),
    ]);
    saveCatalog();
    writeDesktopCatalog();
    log('catalog refresh gateway=' + status.gateway.ready + ' official=' + status.official.ready);
  })().finally(() => { refreshInFlight = null; });
  return refreshInFlight;
}
function writeDesktopCatalog() {
  const levelsPath = path.join(cacheDir, 'reasoning-levels.json');
  let levels = readJson(levelsPath, readJson(path.join(root, 'assets', 'reasoning-levels.json')));
  const reasoningSource = catalog.official.find(m => m.slug === 'gpt-6-sol');
  if (reasoningSource?.supported_reasoning_levels?.length) {
    levels = { source_model: reasoningSource.slug, default_reasoning_level: reasoningSource.default_reasoning_level,
      supported_reasoning_levels: reasoningSource.supported_reasoning_levels };
    atomic(levelsPath, levels);
  }
  const fallback = readJson(path.join(root, 'assets', 'model-template.json'), {}).models || [];
  const template = catalog.official.find(m => m.slug === 'gpt-6-sol') || catalog.official[0] || fallback[0];
  if (!template || !levels?.supported_reasoning_levels?.length) throw new Error('Model template is missing');
  const officialIds = new Set(catalog.official.map(m => m.slug));
  const compareNames = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' }).compare;
  const gatewayPriority = mode === 'mixed' ? Math.max(0, ...catalog.official.map(m => Number(m.priority) || 0)) + 1 : 1;
  const imageOnlyIds = new Set(catalog.gatewayModels.filter(imageOnlyModel).map(m => m.id));
  const gateway = catalog.gatewayIds.filter(id => !imageOnlyIds.has(id) && (mode === 'gateway' || !officialIds.has(id))).sort(compareNames).map((id, index) => {
    const leaf = id.split('/').at(-1);
    const gpt = /^gpt\//i.test(id) || /^gpt(?:-|\d)/i.test(leaf);
    const native = gpt ? catalog.official.find(m => m.slug === leaf) : null;
    const model = structuredClone(native || template);
    Object.assign(model, { slug: id, display_name: id, description: 'Gateway model', priority: gatewayPriority + index,
      visibility: 'list', supported_in_api: true, supported_reasoning_levels: levels.supported_reasoning_levels,
      default_reasoning_level: levels.default_reasoning_level, comp_hash: null });
    // An official model's speed options do not describe the gateway's service.
    // Keep only speed metadata explicitly advertised by that upstream.
    const upstream = catalog.gatewayModels.find(m => m.id === id);
    model.default_service_tier = upstream?.default_service_tier ?? null;
    model.service_tiers = structuredClone(upstream?.service_tiers ?? []);
    model.additional_speed_tiers = structuredClone(upstream?.additional_speed_tiers ?? []);
    // Native GPT catalogs can carry instructions in model_messages instead of
    // base_instructions. Preserve that entire object, including its variables.
    if (!gpt) Object.assign(model, { model_messages: null, use_responses_lite: false, tool_mode: 'code_mode_only', shell_type: 'unified_exec', apply_patch_tool_type: 'freeform',
      base_instructions: 'You are a helpful coding assistant. Follow application and user instructions. Follow each tool schema exactly. Source-code and patch inputs must contain raw source text, not an extra JSON-encoded wrapper. Keep numeric arguments as numbers. In JavaScript REPL tools, use documented output helpers and do not use a top-level return. Treat tool errors as failures and correct the call before claiming success.' });
    return model;
  });
  atomic(path.join(cacheDir, 'models-gateway.json'), { models: gateway });
  atomic(path.join(cacheDir, 'models-smr.json'), { models: [...(mode === 'mixed' ? catalog.official : []), ...(gatewayEnabled ? gateway : [])] });
}
function route(model) {
  if (!model) throw Object.assign(new Error('The request does not identify a model.'), { status: 400 });
  if (mode === 'mixed' && catalog.official.some(m => m.slug === model)) return 'official';
  if (gatewayEnabled && catalog.gatewayIds.includes(model)) return 'gateway';
  throw Object.assign(new Error('Unknown model: ' + model + '. Refresh the model list; this request was not forwarded.'), { status: 400 });
}
function historyForTarget(payload, which) {
  if (which !== 'official' && !isGptModel(payload.model)) return { payload, changed: false };
  const result = which === 'official' ? normalizeOfficialHistory(payload) : normalizeGptHistory(payload);
  if (result.changed) log('history compatibility model=' + payload.model + ' ' + JSON.stringify(result.stats));
  return result;
}
function prepareRequest(payload, which, pathname = '/v1/responses') {
  if (which === 'gateway' && !isGptModel(payload.model)) {
    if (pathname.endsWith('/responses/compact')) throw Object.assign(new Error('GPT opaque compaction is unavailable for non-GPT models.'), { status: 400, code: 'incompatible_compacted_history' });
    const chat = usesChat(payload);
    const adapter = new NonGptAdapter(payload, { preserveReasoning: /^(阿里云订阅|词元计划|vllm)\//.test(payload.model) });
    const converted = adapter.request();
    return { payload: chat ? chatRequest(converted) : converted, changed: true, adapter, chat };
  }
  return historyForTarget(payload, which);
}
async function gatewayImageReferences(payload, incoming, signal) {
  if (!isGptModel(payload.model)) validateNonGptCompaction(payload);
  const items = Array.isArray(payload.input) ? payload.input : [];
  const needsUrl = part => part?.type === 'input_image' && part.file_id && !part.image_url;
  if (!items.some(item => [...(Array.isArray(item.content) ? item.content : []), ...(Array.isArray(item.output) ? item.output : [])].some(needsUrl))) return payload;
  // API-only file IDs belong to that API. Responses can carry them unchanged;
  // a Chat route without image data reports its existing format error instead.
  // Never use a saved ChatGPT login to resolve them in this mode.
  if (mode !== 'mixed') return payload;
  const converted = structuredClone(payload), links = new Map();
  // Match the installed client's read-only file-download-link endpoint. A file
  // ID owned by ChatGPT is not a file ID at another provider. Resolve only the
  // outgoing image reference; the canonical history keeps the original ID.
  const fileBase = officialBase.replace(/\/codex$/, '');
  for (const item of converted.input) for (const parts of [item.content, item.output]) {
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      if (!needsUrl(part)) continue;
      if (!links.has(part.file_id)) {
        const result = await fetchJson(fileBase + '/files/download/' + encodeURIComponent(part.file_id), headersFor(incoming, 'official'), officialDispatcher, 12000, signal);
        if (typeof result.download_url !== 'string' || !/^https?:\/\//.test(result.download_url)) throw Object.assign(new Error('The native file service did not provide a usable image download URL.'), { status: 502, code: 'image_reference_unavailable' });
        links.set(part.file_id, result.download_url);
      }
      part.image_url = links.get(part.file_id); delete part.file_id;
    }
  }
  return converted;
}
function headersFor(incoming, target) {
  const headers = {};
  for (const [k, v] of Object.entries(incoming)) {
    if (['host','connection','content-length','transfer-encoding','content-encoding','upgrade','proxy-authorization'].includes(k) || k.startsWith('sec-websocket-')) continue;
    headers[k] = v;
  }
  headers['accept-encoding'] = 'identity';
  if (target === 'gateway') {
    headers.authorization = 'Bearer ' + env.API_KEY;
    delete headers['chatgpt-account-id']; delete headers['openai-organization']; delete headers['openai-project'];
  } else {
    const a = auth();
    // Honor refreshed credentials sent by the native client; legacy custom-provider
    // threads carry our gateway key and must instead use the saved local account.
    const incomingToken = String(incoming.authorization || '').replace(/^Bearer\s+/i, '');
    const token = incomingToken && incomingToken !== env.API_KEY ? incomingToken : a.token;
    if (!token) throw Object.assign(new Error('Official models require a local ChatGPT sign-in.'), { status: 401 });
    headers.authorization = 'Bearer ' + token;
    if (!incomingToken || incomingToken === env.API_KEY) {
      delete headers['chatgpt-account-id']; if (a.accountId) headers['chatgpt-account-id'] = a.accountId;
    }
  }
  return headers;
}
function targetUrl(which, url) {
  const suffix = url.pathname.replace(/^\/v1(?=\/|$)/, '');
  return (which === 'official' ? officialBase : gatewayBase) + (suffix || '/') + url.search;
}
function decodeBody(body, encoding = '') {
  if (!body.length) return body;
  const decoders = { gzip: zlib.gunzipSync, deflate: zlib.inflateSync, br: zlib.brotliDecompressSync, zstd: zlib.zstdDecompressSync };
  if (!encoding || encoding === 'identity') return body;
  if (!decoders[encoding]) throw new Error('Unsupported content encoding');
  return decoders[encoding](body);
}
async function readBody(req) {
  const chunks = []; let n = 0;
  for await (const chunk of req) { n += chunk.length; if (n > 256 * 1024 * 1024) throw new Error('Request too large'); chunks.push(chunk); }
  return decodeBody(Buffer.concat(chunks), req.headers['content-encoding']);
}
function json(res, code, value) { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); }
function protocolError(e) { return { type: 'error', status: e.status || 502, error: { type: 'server_error', code: e.code || 'upstream_error', message: e.message } }; }
async function* convertedEvents(stream, adapted) {
  const events = adapted.adapter ? new NonGptEvents(adapted.adapter) : null;
  const chat = adapted.chat ? new ChatEvents(adapted.payload.model) : null;
  let terminal = false;
  for await (const packet of ssePackets(stream)) {
    if (packet.done && chat) break;
    if (!packet.data) continue;
    for (const event of chat ? chat.convert(packet.data) : [packet.data]) {
      if (['response.completed','response.incomplete','response.failed','error'].includes(event.type)) terminal = true;
      for (const converted of events ? events.convert(event) : [event]) yield converted;
    }
  }
  if (chat) for (const event of chat.finish()) {
    for (const converted of events.convert(event)) yield converted;
  }
  if (events) events.finish();
  else if (!terminal) throw Object.assign(new Error('Upstream stream ended before a terminal response event.'), { status: 502, code: 'incomplete_upstream_response' });
}
function health() { return { status: (gatewayEnabled ? status.gateway.ready : status.official.ready) ? 'ok' : 'degraded', service: 'chatgpt-api-router', version: 2, compatibilityVersion: 2, buildId, mode, entryMode, sourceId, gatewayBase, clientVersion: currentClientVersion(), ...status, officialModels: mode === 'mixed' ? catalog.official.length : 0, gatewayModels: gatewayEnabled ? catalog.gatewayIds.length : 0,
  gatewayImageModels: gatewayEnabled ? catalog.gatewayModels.filter(m => imageCapabilities(m).known || [env.IMAGE_MODEL,env.IMAGE_EDIT_MODEL].includes(m.id)).map(m => m.id) : [] }; }
async function forwardOfficialCatalog(req, res, url) {
  // A native model-list request carries its own version, account, and query.
  // Forward its response, including metadata/ETag/304, rather than substituting
  // the launcher's cached catalog. Gateway models remain in the API entry file.
  const controller = new AbortController(); controllers.add(controller);
  res.on('close', () => { if (!res.writableEnded) controller.abort(); });
  try {
    const upstream = await request(targetUrl('official', url), {
      method: 'GET', headers: headersFor(req.headers, 'official'), dispatcher: officialDispatcher,
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12000)]), headersTimeout: 12000, bodyTimeout: 12000,
    });
    const body = Buffer.from(await upstream.body.arrayBuffer());
    const clientVersion = url.searchParams.get('client_version');
    if (upstream.statusCode === 200) {
      try {
        // An in-flight periodic refresh must finish before this newer native
        // result becomes the canonical routing/menu catalog.
        if (refreshInFlight) await refreshInFlight.catch(e => log('catalog refresh ' + e.message));
        const data = JSON.parse(decodeBody(body, upstream.headers['content-encoding'] || '').toString('utf8'));
        acceptOfficialCatalog(data, clientVersion);
        observedClientVersion = clientVersion;
        configuredVersionAtObservation = readJson(path.join(dataDir, 'state', 'route-state.json'), runtime).clientVersion;
        saveCatalog(); writeDesktopCatalog();
      } catch (e) {
        // Updating the launcher's files must not replace the native response.
        log('native catalog cache update ' + e.message);
      }
    }
    const outgoing = { ...upstream.headers };
    for (const name of ['connection','transfer-encoding','keep-alive']) delete outgoing[name];
    res.writeHead(upstream.statusCode, outgoing); res.end(body);
  } finally { controllers.delete(controller); }
}
async function handleHttp(req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (['/healthz','/v1/healthz','/readyz'].includes(url.pathname)) {
    if (url.pathname === '/readyz') await refreshCatalog();
    return json(res, url.pathname === '/readyz' && !(gatewayEnabled ? status.gateway.ready : status.official.ready) ? 503 : 200, health());
  }
  if (req.method === 'GET' && ['/models','/v1/models'].includes(url.pathname) && mode === 'mixed' && url.searchParams.has('client_version')) {
    if (!validClientVersion(url.searchParams.get('client_version'))) throw Object.assign(new Error('Invalid native client version.'), { status: 400 });
    return forwardOfficialCatalog(req, res, url);
  }
  if (req.method === 'GET' && ['/models','/v1/models'].includes(url.pathname)) return json(res, 200, {
    // The native official provider requests its rich catalog at this same URL.
    // Preserve that schema without exposing API models in the official entry.
    ...(mode === 'mixed' ? { models: catalog.official } : {}),
    object: 'list', data: [...(mode === 'mixed' ? catalog.official.map(m => m.slug) : []), ...(gatewayEnabled ? catalog.gatewayIds : [])].filter((m,i,a) => a.indexOf(m) === i).map(id => ({ id, object: 'model' })) });
  let body = await readBody(req);
  const imageRoute = /^\/(?:v1\/)?images\/(generations|edits)$/.exec(url.pathname);
  if (imageRoute) {
    if (req.method !== 'POST') throw Object.assign(new Error('Images endpoints require POST.'), { status: 405, code: 'invalid_image_request' });
    const controller = new AbortController(); controllers.add(controller);
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    try {
      return await forwardImages({ req,res,url,body,operation: imageRoute[1],env,
        hasLogin: mode === 'mixed' && !!auth().token, allowGateway: gatewayEnabled,
        getModels: async () => catalog.gatewayModels,
        headersFor,targetUrl,officialDispatcher,gatewayDispatcher,imageDispatcher: officialDispatcher,decodeBody,signal: controller.signal,log,
        resolveFile: async id => {
          if (mode !== 'mixed' || !auth().token) throw Object.assign(new Error('A native file ID requires its owning ChatGPT sign-in; use a URL or local reference image.'), { status: 400, code: 'image_reference_unavailable' });
          const result = await fetchJson(officialBase.replace(/\/codex$/, '') + '/files/download/' + encodeURIComponent(id), headersFor(req.headers, 'official'), officialDispatcher, 12000, controller.signal);
          if (typeof result.download_url !== 'string' || !/^https?:\/\//.test(result.download_url)) throw Object.assign(new Error('The native file service did not provide an image URL.'), { status: 502, code: 'image_reference_unavailable' });
          return result.download_url;
        } });
    } finally { controllers.delete(controller); }
  }
  const parsed = JSON.parse(body.toString('utf8'));
  const which = route(parsed.model);
  const controller = new AbortController(); controllers.add(controller);
  res.on('close', () => { if (!res.writableEnded) controller.abort(); });
  const started = Date.now();
  try {
    const resolved = which === 'gateway' ? await gatewayImageReferences(parsed, req.headers, controller.signal) : parsed;
    const adapted = prepareRequest(resolved, which, url.pathname);
    if (adapted.changed || resolved !== parsed) body = Buffer.from(JSON.stringify(adapted.payload));
    const headers = headersFor(req.headers, which);
    if (adapted.adapter) delete headers['x-openai-internal-codex-responses-lite'];
    const upstream = await request(adapted.chat ? gatewayBase + '/chat/completions' + url.search : targetUrl(which, url), { method: req.method, body, headers, dispatcher: which === 'official' ? officialDispatcher : gatewayDispatcher,
      signal: controller.signal, headersTimeout: 120000, bodyTimeout: 300000 });
    const outgoing = { ...upstream.headers }; for (const name of ['connection','transfer-encoding','keep-alive']) delete outgoing[name];
    if (adapted.adapter && upstream.statusCode >= 200 && upstream.statusCode < 300) {
      const stream = decodedStream(upstream.body, upstream.headers['content-encoding']);
      delete outgoing['content-length']; delete outgoing['content-encoding'];
      outgoing['x-chatgpt-api-adapted'] = 'true';
      if (String(upstream.headers['content-type']).includes('text/event-stream')) {
        res.writeHead(upstream.statusCode, outgoing);
        try {
          for await (const event of convertedEvents(stream, adapted)) {
            if (res.destroyed) break;
            res.write(encodeSse(event));
          }
        } catch (e) {
          if (!res.destroyed) res.write(encodeSse(protocolError(e)));
          log('Stream conversion error ' + e.message);
        }
      } else {
        const chunks = []; let size = 0;
        for await (const chunk of stream) { size += chunk.length; if (size > 64 * 1024 * 1024) throw new Error('Upstream response exceeds limit'); chunks.push(chunk); }
        const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const response = adapted.adapter.response(adapted.chat ? chatResponse(data, parsed.model) : data);
        res.writeHead(upstream.statusCode, outgoing);
        res.write(JSON.stringify(response));
      }
      log('non-GPT compatibility model=' + parsed.model + ' ' + JSON.stringify(adapted.adapter.stats));
    } else {
      res.writeHead(upstream.statusCode, outgoing);
      for await (const chunk of upstream.body) { if (res.destroyed) break; res.write(chunk); }
    }
    res.end(); log(which + ' HTTP model=' + parsed.model + ' status=' + upstream.statusCode + ' ms=' + (Date.now() - started));
  } finally { controllers.delete(controller); }
}
loadCatalog();
if (process.argv.includes('--prepare')) {
  try {
    await refreshCatalog();
    const gatewayAvailable = catalog.gatewayIds.length && Date.now() - Date.parse(catalog.gatewayAt) < CACHE_MAX_AGE;
    if (gatewayEnabled && !gatewayAvailable) {
      catalog.gatewayIds = [];
      catalog.gatewayModels = [];
      if (mode !== 'mixed' || !catalog.official.length) throw new Error('Gateway unavailable and no current cache for this URL/key. ' + (status.gateway.error || ''));
      saveCatalog();
    }
    writeDesktopCatalog();
    process.stdout.write(JSON.stringify(health()) + '\n');
  } catch (e) { process.stderr.write(e.message.replaceAll(env.API_KEY, '[redacted]') + '\n'); process.exitCode = 1; }
  await gatewayDispatcher.close(); await officialDispatcher.close();
} else {
  const saved = readJson(cachePath, {});
  if (saved.sourceId === sourceId && saved.status) status = saved.status;
  const server = http.createServer((req, res) => handleHttp(req, res).catch(e => {
    log('HTTP error ' + e.message); if (!res.headersSent) json(res, e.status || 502, { error: protocolError(e).error }); else res.destroy();
  }));
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    if (!['/v1/responses','/responses'].includes(url.pathname)) { socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); return; }
    wss.handleUpgrade(req, socket, head, client => {
      let upstream; let closed = false; let officialOpening = false;
      const officialQueue = []; const laneRoutes = new Map(); const responseRoutes = new Map(); const active = new Map();
      // HTTP gateways are usually stateless. Preserve WS incremental context only
      // for this connection, with bounded memory; never write conversation copies.
      const gatewayHistory = new Map(); let historyBytes = 0;
      const officialPending = new Map(), officialBodies = new Map(), officialLanes = new Map();
      const send = value => { if (client.readyState === WebSocket.OPEN) client.send(typeof value === 'string' ? value : JSON.stringify(value)); };
      const failure = (e, lane) => send({ type: 'error', status: e.status || 502, code: e.code || 'upstream_error', message: e.message, ...(lane ? { stream_id: lane } : {}), error: { type: 'server_error', code: e.code || 'upstream_error', message: e.message } });
      function rememberGateway(id, body, output, which = 'gateway', { complete = true, connection = null } = {}) {
        if (!id) return;
        const input = [...body.input, ...(output || [])];
        const defaults = { ...body };
        for (const key of ['input','stream','type','stream_id','previous_response_id','generate']) delete defaults[key];
        const bytes = Buffer.byteLength(JSON.stringify({ defaults, input }));
        if (gatewayHistory.has(id)) { historyBytes -= gatewayHistory.get(id).bytes; gatewayHistory.delete(id); }
        if (bytes <= 64 * 1024 * 1024) { gatewayHistory.set(id, { input, defaults, bytes, complete, connection }); historyBytes += bytes; }
        while (gatewayHistory.size > 8 || historyBytes > 64 * 1024 * 1024) {
          const oldest = gatewayHistory.keys().next().value;
          historyBytes -= gatewayHistory.get(oldest).bytes; gatewayHistory.delete(oldest);
        }
        responseRoutes.set(id, which);
      }
      function officialSend(text) {
        let event = JSON.parse(text);
        let changed = false;
        if (event.type === 'response.create') {
          const prior = event.previous_response_id ? gatewayHistory.get(event.previous_response_id) : null;
          const incoming = typeof event.input === 'string' ? [{ role: 'user', content: event.input }] : event.input || [];
          const context = { ...prior?.defaults, ...event, input: [...(prior?.input || []), ...incoming] };
          const complete = !event.previous_response_id || Boolean(prior && prior.complete);
          // Previous response state can belong to a different provider or to an
          // official socket that has since closed. Never send its ID as an
          // incremental continuation on a replacement upstream connection.
          const foreign = event.previous_response_id && responseRoutes.get(event.previous_response_id) === 'gateway';
          const reconnected = prior && (prior.connection !== upstream || !upstream || upstream.readyState >= WebSocket.CLOSING);
          if (event.previous_response_id && (foreign || reconnected)) {
            if (!complete) throw Object.assign(new Error('Previous response is not cached. Retry with the full input history.'), { status: 400, code: 'previous_response_not_found' });
            event = { ...context }; delete event.previous_response_id; changed = true;
            log('official WS full-context recovery reason=' + (foreign ? 'provider-switch' : 'upstream-reconnect'));
          }
          const normalized = historyForTarget(event, 'official');
          if (changed || normalized.changed) text = JSON.stringify(normalized.payload);
          officialPending.set(event.stream_id || 'default', { body: context, complete, incremental: Boolean(event.previous_response_id) });
        }
        officialQueue.push(text);
        if (upstream?.readyState === WebSocket.OPEN) { while (officialQueue.length) upstream.send(officialQueue.shift()); return; }
        if (officialOpening) return;
        officialOpening = true;
        const options = { headers: headersFor(req.headers, 'official'), handshakeTimeout: 15000 };
        if (officialProxy) options.agent = new HttpsProxyAgent(officialProxy);
        const connection = new WebSocket(targetUrl('official', url).replace(/^http/, 'ws'), options);
        upstream = connection;
        const openedAt = Date.now();
        connection.on('open', () => {
          if (connection !== upstream || closed) return connection.close();
          officialOpening = false;
          log('official WS connected');
          while (officialQueue.length) connection.send(officialQueue.shift());
        });
        connection.on('message', data => {
          if (connection !== upstream || closed) return;
          const text = data.toString();
          try {
            const event = JSON.parse(text), id = event.response?.id, lane = event.stream_id || 'default';
            if (event.type === 'error') {
              const error = event.error || event, pending = officialPending.get(lane);
              const invalidPrevious = Number(event.status) === 400 &&
                (error.code === 'previous_response_not_found' || error.param === 'previous_response_id' || /Invalid\s+[`'"]?previous_response_id[`'"]?/i.test(error.message || ''));
              if (invalidPrevious && pending?.incremental && pending.complete) {
                // This validation error precedes response.created. Retry once
                // using the already assembled context, without the expired ID.
                // The retry is non-incremental, so it cannot enter this branch again.
                const replay = { ...pending.body }; delete replay.previous_response_id;
                log('official WS full-context recovery reason=invalid-previous-response');
                officialSend(JSON.stringify(replay));
                return;
              }
              officialPending.delete(lane);
              officialLanes.delete(lane);
              for (const [responseId, pendingBody] of officialBodies) {
                if ((pendingBody.body.stream_id || 'default') === lane) officialBodies.delete(responseId);
              }
              log('official WS error status=' + (event.status || '') + ' code=' + (error.code || '') + ' invalid_previous=' + invalidPrevious);
            }
            if (id) responseRoutes.set(id, 'official');
            if (event.type === 'response.created' && id && officialPending.has(lane)) {
              officialBodies.set(id, { ...officialPending.get(lane), output: new ResponseOutput() }); officialPending.delete(lane);
              officialLanes.set(lane, id);
            }
            const responseId = id || event.response_id || officialLanes.get(lane);
            officialBodies.get(responseId)?.output.observe(event);
            if (['response.completed','response.incomplete'].includes(event.type) && officialBodies.has(id)) {
              const pending = officialBodies.get(id);
              const result = pending.output.finish(event.response.output);
              rememberGateway(id, pending.body, result.output, 'official', { complete: pending.complete && result.complete, connection }); officialBodies.delete(id);
              if (officialLanes.get(lane) === id) officialLanes.delete(lane);
            }
            if (event.type === 'response.failed') {
              officialBodies.delete(id); if (officialLanes.get(lane) === id) officialLanes.delete(lane);
            }
          } catch (e) { log('Official context cache: ' + e.message); }
          send(text);
        });
        connection.on('error', e => {
          if (connection !== upstream || closed) return;
          officialOpening = false; officialQueue.length = 0; failure(e);
        });
        connection.on('close', code => {
          if (connection !== upstream) return;
          officialOpening = false; upstream = null;
          log('official WS closed code=' + code + ' lifetime_ms=' + (Date.now() - openedAt));
          // If generation was in flight, let the native client handle the broken
          // transport. Never silently replay possibly accepted work or tool calls.
          if (!closed && (officialPending.size || officialBodies.size)) client.close(1012, 'Official upstream disconnected during a response');
        });
      }
      async function gatewayCreate(event) {
        const lane = event.stream_id || 'default';
        if (active.has(lane)) throw Object.assign(new Error('A response is already running on this stream.'), { status: 409 });
        const previous = event.previous_response_id ? gatewayHistory.get(event.previous_response_id) : null;
        if (event.previous_response_id && (!previous || !previous.complete)) throw Object.assign(new Error('Previous response is not cached on this connection. Retry with the full input history.'), { status: 400, code: 'previous_response_not_found' });
        const incoming = typeof event.input === 'string' ? [{ role: 'user', content: event.input }] : event.input || [];
        let body = { ...previous?.defaults, ...event, input: [...(previous?.input || []), ...incoming], stream: true };
        delete body.type; delete body.stream_id; delete body.previous_response_id; delete body.generate;
        // Cache the original desktop format; convert only the outgoing copy.
        if (event.generate === false) {
          // Native clients prewarm WS connections without requesting generation.
          const response = { id: 'resp_router_' + crypto.randomUUID().replaceAll('-', ''), object: 'response', created_at: Math.floor(Date.now()/1000), model: body.model, output: [], status: 'completed', error: null };
          rememberGateway(response.id, body, []);
          const extra = event.stream_id ? { stream_id: event.stream_id } : {};
          send({ type: 'response.created', sequence_number: 0, response: { ...response, status: 'in_progress' }, ...extra });
          send({ type: 'response.completed', sequence_number: 1, response, ...extra });
          return;
        }
        const controller = new AbortController(); active.set(lane, controller); controllers.add(controller);
        try {
          const adapted = prepareRequest(await gatewayImageReferences(body, req.headers, controller.signal), 'gateway');
          const wireBody = adapted.payload;
          const headers = { ...headersFor(req.headers, 'gateway'), 'content-type': 'application/json' };
          if (adapted.adapter) delete headers['x-openai-internal-codex-responses-lite'];
          const up = await request(gatewayBase + (adapted.chat ? '/chat/completions' : '/responses'), { method: 'POST', headers, body: JSON.stringify(wireBody), dispatcher: gatewayDispatcher, signal: controller.signal, headersTimeout: 120000, bodyTimeout: 300000 });
          if (up.statusCode < 200 || up.statusCode >= 300) {
            const text = await up.body.text(); let message = text.slice(0,1800); let code;
            try { const obj = JSON.parse(text); message = obj.error?.message || obj.message || message; code = obj.error?.code; } catch {}
            throw Object.assign(new Error(message), { status: up.statusCode, code });
          }
          if (!String(up.headers['content-type']).includes('text/event-stream')) throw new Error('Gateway did not return an SSE response');
          const output = new ResponseOutput();
          for await (const response of convertedEvents(decodedStream(up.body, up.headers['content-encoding']), adapted)) {
              output.observe(response);
              if (response.response?.id) responseRoutes.set(response.response.id, 'gateway');
              if (['response.completed','response.incomplete'].includes(response.type)) {
                const result = output.finish(response.response?.output);
                rememberGateway(response.response?.id, body, result.output, 'gateway', { complete: result.complete });
                // Completion can arrive before the HTTP body closes. The client
                // may immediately start its next turn on this same WS stream.
                if (active.get(lane) === controller) active.delete(lane);
              }
              if (event.stream_id) response.stream_id = event.stream_id;
              send(response);
          }
          if (adapted.adapter) log('non-GPT compatibility model=' + event.model + ' ' + JSON.stringify(adapted.adapter.stats));
          log('gateway WS-to-HTTP model=' + event.model + ' status=' + up.statusCode);
        } finally { if (active.get(lane) === controller) active.delete(lane); controllers.delete(controller); }
      }
      // Attach immediately, before opening either upstream, so the first frame is retained.
      client.on('message', data => {
        try {
          const text = data.toString(); const event = JSON.parse(text); const lane = event.stream_id || 'default';
          const which = event.model ? route(event.model) : responseRoutes.get(event.previous_response_id) || laneRoutes.get(lane);
          if (!which) throw Object.assign(new Error('A model is required before continuing this stream.'), { status: 400 });
          laneRoutes.set(lane, which);
          if (which === 'official') officialSend(text);
          else if (event.type === 'response.create') gatewayCreate(event).catch(e => failure(e, event.stream_id));
          else if (event.type === 'response.cancel') active.get(lane)?.abort();
          else throw Object.assign(new Error('This gateway does not support WebSocket event ' + event.type), { status: 400, code: 'unsupported_event' });
        } catch (e) { failure(e); }
      });
      client.on('close', () => { closed = true; upstream?.terminate(); for (const ctrl of active.values()) ctrl.abort(); });
      client.on('error', e => log('WebSocket client ' + e.message));
    });
  });
  const host = env.SHIM_HOST || '127.0.0.1';
  if (!['127.0.0.1','::1'].includes(host)) throw new Error('The local router must bind to loopback.');
  server.listen(Number(process.env.CHATGPT_SHIM_PORT || env.SHIM_PORT || 8102), host, () => log('router v2 listening mode=' + mode + ' transport=' + transport));
  function shutdown() { for (const c of controllers) c.abort(); for (const ws of wss.clients) ws.terminate(); server.close(); gatewayDispatcher.destroy(); officialDispatcher.destroy(); setTimeout(() => process.exit(), 500).unref(); }
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
}
