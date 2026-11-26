#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { on } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { normalizeGptHistory, normalizeOfficialHistory, isGptModel, ResponseOutput, responseMessagePhases, ResponsePhases } from './history-compat.mjs';
import { NonGptAdapter, NonGptEvents, validateNonGptCompaction } from './non-gpt-compat.mjs';
import { usesChat, chatRequest, chatResponse, ChatEvents, chatEndpointUnavailable } from './chat-compat.mjs';
import { decodedStream, ssePackets, encodeSse, isSseControl } from './sse.mjs';
import { forwardImages, imageOnlyModel, imageCapabilities } from './image-compat.mjs';
import { ResponseImages, restoreHostedImageHistory } from './responses-images.mjs';
import { NativeWebSearch } from './native-web-search.mjs';
import { contextFields, rememberContexts, contextKey, applyContext } from './model-context.mjs';
import { officialDispatcherFor, readEncodedBody, outgoingBody, writeChunk, writeWebSocket, relayClose,
  requestWithAbort as request, protocolError, releaseResponseBody, drainResponseTail, RESPONSE_TIMEOUTS, MAX_REQUEST_BYTES,
  gatewayResponseHeaders, FORWARDED_NATIVE_HEADERS, normalizeGatewayTransport, gatewayDispatcherFor,
  NATIVE_RESPONSES_HEADER, WS_LITE_FIELD, TURN_STATE_HEADER } from './transport.mjs';
import { PendingResponses, HistoryCache, laneOf } from './response-state.mjs';
import { GatewaySources } from './gateway-sources.mjs';
import { overrideKey, redact } from './settings.mjs';
import { canRequestFast, modelStrengths } from './model-strength.mjs';
import { cleanManagedLogs, createDiagnosticLog, errorDetails, describeError } from './diagnostics.mjs';

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
if (gatewayEnabled && (!/^https?:\/\//.test(gatewayBase) || !env.API_KEY)) throw new Error('BASE_URL or API_KEY is missing.');
const officialProxy = runtime.officialProxy ?? '';
const transport = normalizeGatewayTransport(runtime.gatewayTransport || env.GATEWAY_TRANSPORT);
const tunnelPort = Number(env.GATEWAY_TUNNEL_PORT || 18003);
const sources = new GatewaySources(root, env, { transport, tunnelPort, baseOverride: process.env.CHATGPT_GATEWAY_BASE || '' });
const gatewayDispatcher = gatewayDispatcherFor(gatewayEnabled ? gatewayBase : 'http://127.0.0.1', transport, tunnelPort);
const mediaDispatcher = transport === 'direct' ? gatewayDispatcher : gatewayDispatcherFor('http://127.0.0.1', 'direct');
const officialDispatcher = officialDispatcherFor(officialProxy);
const officialWebSocketAgent = officialProxy ? new HttpsProxyAgent(officialProxy) : undefined;
const sourceId = crypto.createHash('sha256').update(gatewayBase + '\n' + (env.API_KEY || '')).digest('hex');
const buildHash = crypto.createHash('sha256');
for (const name of ['shim.mjs','history-compat.mjs','non-gpt-compat.mjs','sse.mjs','chat-compat.mjs','image-compat.mjs','responses-images.mjs','native-web-search.mjs','search-compat.mjs','model-context.mjs','model-strength.mjs','transport.mjs','response-state.mjs','diagnostics.mjs','settings.mjs','gateway-sources.mjs']) buildHash.update(fs.readFileSync(path.join(dir, name)));
for (const name of ['model-contexts.json', 'model-template.json']) {
  if (fs.existsSync(path.join(root, 'assets', name))) buildHash.update(fs.readFileSync(path.join(root, 'assets', name)));
}
const buildId = buildHash.digest('hex');
const cachePath = path.join(cacheDir, 'catalog-state.json');
cleanManagedLogs(root);
const debug = process.env.CHATGPT_API_DEBUG === '1';
const log = createDiagnosticLog(path.join(dataDir, 'logs', 'shim.log'), {
  sanitize: text => redact(text, sources.settings, [env.API_KEY, ...sources.secrets]),
});
const CACHE_MAX_AGE = 24 * 60 * 60 * 1000;
let catalog = { official: [], gatewayIds: [], gatewayModels: [], gatewayAt: null, officialAt: null, sourceId };
let status = { gateway: { ready: false }, official: { ready: false } };
let refreshInFlight;
let observedClientVersion, configuredVersionAtObservation;
const controllers = new Set();
const nativeSearch = new NativeWebSearch(sources);
export let routerReady;
export let closeRouter;

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
  if (gatewayEnabled) {
    catalog.gatewayModels = sources.loadCached(saved);
    catalog.gatewayIds = catalog.gatewayModels.map(model => model.id);
    catalog.gatewayAt = sources.sources.map(source => source.checkedAt).sort().at(-1) || null;
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
  return { sourceId: saved.sourceId, configurationId: saved.configurationId, status: saved.status };
}
function saveCatalog() {
  atomic(cachePath, { ...catalog, sourceId, configurationId: sources.revision, accountIdentity: accountIdentity(), checkedAt: new Date().toISOString(), status });
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
  if (r.statusCode < 200 || r.statusCode >= 300) throw Object.assign(new Error('HTTP ' + r.statusCode), { code: 'upstream_http_error', status: r.statusCode });
  return JSON.parse(text);
}
async function refreshCatalog() {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    await Promise.all([
      (async () => {
        if (!gatewayEnabled) { status.gateway = { ready: false, enabled: false }; return; }
        try {
          status.gateway = await sources.discover();
          catalog.gatewayModels = sources.models;
          catalog.gatewayIds = sources.models.map(model => model.id);
          catalog.gatewayAt = sources.sources.map(source => source.checkedAt).sort().at(-1) || null;
        } catch (e) { status.gateway = { ready: false, error: describeError(e), failure: errorDetails(e), checkedAt: new Date().toISOString(), cachedAt: catalog.gatewayAt }; }
      })(),
      (async () => {
        if (mode !== 'mixed') { status.official = { ready: false, enabled: false }; return; }
        const a = auth();
        if (!a.token) { status.official = { ready: false, error: 'No saved ChatGPT sign-in' }; return; }
        const startingCatalog = catalog.official;
        try {
          const version = currentClientVersion();
          if (!version) throw new Error('Native client version is unavailable; reopen the launcher after native client initialization.');
          const headers = { authorization: 'Bearer ' + a.token, ...(a.accountId ? { 'chatgpt-account-id': a.accountId } : {}) };
          const data = await fetchJson(officialBase + '/models?client_version=' + encodeURIComponent(version), headers, officialDispatcher);
          // A native model-list request can finish while this refresh is in flight.
          if (catalog.official === startingCatalog) acceptOfficialCatalog(data, version);
        } catch (e) {
          if (catalog.official === startingCatalog) status.official = { ready: false, error: describeError(e), failure: errorDetails(e), cached: catalog.official.length > 0 };
        }
      })(),
    ]);
    saveCatalog();
    writeDesktopCatalog();
    if (gatewayEnabled && !status.gateway.ready) log('catalog gateway ' + JSON.stringify(status.gateway));
    if (mode === 'mixed' && !status.official.ready) log('catalog official ' + JSON.stringify(status.official));
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
  const gatewayById = new Map(catalog.gatewayModels.map(model => [model.id, model]));
  const profiles = gatewayEnabled ? sources.profiles() : [];
  const compareNames = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' }).compare;
  const gatewayPriority = mode === 'mixed' ? Math.max(0, ...catalog.official.map(m => Number(m.priority) || 0)) + 1 : 1;
  const imageOnlyIds = new Set(catalog.gatewayModels.filter(imageOnlyModel).map(m => m.id));
  const contexts = new Map();
  for (const profile of profiles) contexts.set(profile.id, rememberContexts({ file: path.join(cacheDir, 'model-contexts.json'), base: profile.baseUrl,
    models: catalog.gatewayModels.filter(model => (model._providerId || 'default') === profile.id && !imageOnlyIds.has(model.id)).map(model => ({ ...model, id: model._upstreamId || model.id })),
    official: catalog.official, known: readJson(path.join(root, 'assets/model-contexts.json'), {}), write: atomic }));
  const gateway = (gatewayEnabled ? catalog.gatewayIds : []).filter(id => !imageOnlyIds.has(id) && (mode === 'gateway' || !officialIds.has(id))).sort(compareNames).map((id, index) => {
    const upstream = gatewayById.get(id);
    const originalId = upstream?._upstreamId || id, profile = sources.profile(upstream?._providerId || 'default');
    const leaf = originalId.split('/').at(-1);
    const gpt = isGptModel(originalId);
    const native = gpt ? catalog.official.find(m => m.slug?.toLowerCase() === leaf.toLowerCase()) : null;
    const model = structuredClone(native || template);
    const key = overrideKey(profile.id, originalId), record = contexts.get(profile.id)?.entries[contextKey(profile.baseUrl, originalId)];
    applyContext(model, record, { override: sources.settings.contextOverrides[key], capacity: sources.settings.modelCapacities[key] });
    const strengths = modelStrengths(upstream, catalog.official, record?.strengths, sources.settings.strengthOverrides[key]);
    // ModelInfo accepts a closed effort enum. Keep native additions from the
    // installed client's own catalog without forwarding arbitrary API labels.
    const nativeEfforts = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra',
      ...(native?.supported_reasoning_levels || []).map(item => item.effort)]);
    const reasoning = strengths.reasoning.status === 'known' ? strengths.reasoning.levels.filter(effort => nativeEfforts.has(effort)) : [];
    const descriptions = native?.supported_reasoning_levels || levels.supported_reasoning_levels;
    const preferred = native?.default_reasoning_level || upstream?.default_reasoning_level || levels.default_reasoning_level;
    Object.assign(model, { slug: id, display_name: profiles.length > 1 || profile.id !== 'default' ? originalId + ' · ' + profile.name : id,
      description: 'API · ' + profile.name, priority: gatewayPriority + index,
      visibility: 'list', supported_in_api: true,
      supported_reasoning_levels: reasoning.map(effort => structuredClone(descriptions.find(item => item.effort === effort) || { effort, description: '' })),
      default_reasoning_level: reasoning.includes(preferred) ? preferred : reasoning.includes(strengths.reasoning.highest) ? strengths.reasoning.highest : reasoning.at(-1) || null, comp_hash: null });
    // OpenAI-compatible model lists commonly contain IDs only. GPT still accepts
    // the native priority request; missing catalog fields must not hide it.
    // An explicit upstream declaration (including an empty list) takes precedence.
    const declaredSpeed = upstream && ['service_tiers', 'additional_speed_tiers'].some(key => Object.hasOwn(upstream, key));
    const requestFast = canRequestFast(upstream || { id }) && !declaredSpeed;
    const requestUltrafast = requestFast && leaf.toLowerCase() === 'gpt-6.2-sol';
    model.default_service_tier = gpt ? upstream?.default_service_tier ?? null : null;
    const speedTiers = requestFast ? [{ id: 'priority', name: 'Fast', description: requestUltrafast ? '2x speed, increased usage'
      : 'Request priority processing; availability and usage depend on the gateway.' }] : [];
    if (requestUltrafast) speedTiers.push({ id: 'ultrafast', name: 'Ultrafast', description: 'The fastest available responses for latency-sensitive work.' });
    model.service_tiers = gpt ? structuredClone(upstream?.service_tiers ?? speedTiers) : [];
    model.additional_speed_tiers = gpt ? structuredClone(upstream?.additional_speed_tiers ??
      (requestUltrafast ? ['fast', 'ultrafast'] : requestFast ? ['fast'] : [])) : [];
    // Let the native client assemble all instruction sections for every model.
    // Only the wire/tool capabilities required by the converter differ.
    if (!gpt) Object.assign(model, { use_responses_lite: false, tool_mode: 'code_mode_only', shell_type: 'unified_exec', apply_patch_tool_type: 'freeform' });
    return model;
  });
  atomic(path.join(cacheDir, 'models-gateway.json'), { models: gateway });
  atomic(path.join(cacheDir, 'models-smr.json'), { models: [...(mode === 'mixed' ? catalog.official : []), ...(gatewayEnabled ? gateway : [])] });
}
function route(model) {
  if (!model) throw Object.assign(new Error('The request does not identify a model.'), { status: 400, code: 'missing_model' });
  if (mode === 'mixed' && catalog.official.some(m => m.slug === model)) return 'official';
  if (gatewayEnabled && catalog.gatewayIds.includes(model)) return 'gateway';
  throw Object.assign(new Error('Unknown model: ' + model + '. Refresh the model list; this request was not forwarded.'), { status: 400, code: 'unknown_model' });
}
function historyForTarget(payload, which, { nativeTools = false, flattenConfiguration = false } = {}) {
  const images = restoreHostedImageHistory(payload, codexHome);
  if (which !== 'official' && !isGptModel(payload.model)) return images;
  const result = which === 'official' || nativeTools ? normalizeOfficialHistory(images.payload) : normalizeGptHistory(images.payload, { flattenConfiguration });
  if (debug && result.changed) log('history compatibility model=' + payload.model + ' ' + JSON.stringify(result.stats));
  return { ...result, changed: images.changed || result.changed };
}
function prepareRequest(payload, which, pathname = '/v1/responses', metadata, forceChat = false, gateway, historyOptions) {
  if (which === 'gateway' && (!isGptModel(payload.model) || usesChat(payload, metadata) || forceChat)) {
    if (pathname.endsWith('/responses/compact')) throw Object.assign(new Error('GPT opaque compaction is unavailable for non-GPT models.'), { status: 400, code: 'incompatible_compacted_history' });
    // The public model ID includes the source for aliased models. The wire
    // model name can be identical at two APIs with different reasoning state.
    const adapter = new NonGptAdapter(payload, { preserveReasoning: true, reasoningModel: metadata?.id });
    const converted = adapter.request({ releaseOriginal: true });
    const chat = forceChat || usesChat(converted, metadata);
    return { payload: chat ? chatRequest(converted, metadata, gateway) : restoreHostedImageHistory(converted, codexHome).payload, changed: true, adapter, chat };
  }
  return historyForTarget(payload, which, historyOptions);
}

const wantsNativeLite = payload => payload.client_metadata?.[WS_LITE_FIELD] === 'true';
const validTurnState = value => typeof value === 'string' && value.length <= 8192 && /^[!-~]+$/.test(value);
const hasTurnState = event => event.type === 'response.metadata' && Object.entries(event.headers || {}).some(
  ([name, value]) => name.toLowerCase() === TURN_STATE_HEADER && validTurnState(Array.isArray(value) ? value[0] : value));
function withoutTurnState(payload) {
  if (!Object.hasOwn(payload.client_metadata || {}, TURN_STATE_HEADER)) return payload;
  const { [TURN_STATE_HEADER]: discarded, ...metadata } = payload.client_metadata;
  return { ...payload, client_metadata: metadata };
}
function turnStateEvent(responseId, state, streamId) {
  return { type: 'response.metadata', response_id: responseId, headers: { [TURN_STATE_HEADER]: state },
    ...(streamId == null ? {} : { stream_id: streamId }) };
}
const websocketEligible = (gateway, payload) => gateway.metadata.supports_websockets !== false &&
  isGptModel(gateway.model) && !usesChat(payload, gateway.metadata) &&
  (gateway.profile.id !== 'default' || transport !== 'ssh') &&
  (wantsNativeLite(payload) || gateway.metadata.supports_websockets === true);
const liteHttpEligible = (gateway, payload, incoming) => isGptModel(gateway.model) && !usesChat(payload, gateway.metadata) &&
  (incoming[NATIVE_RESPONSES_HEADER] === 'true' || wantsNativeLite(payload) &&
    (gateway.metadata.use_responses_lite === true || gateway.metadata.capabilities?.responses_lite === true || gateway.metadata._nativeProxy));

const responseFinished = type => type === 'response.completed' || type === 'response.incomplete';
const responseTerminal = type => responseFinished(type) || type === 'response.failed' || type === 'error';

const missingPreviousResponse = error => error?.code === 'previous_response_not_found' ||
  error?.param === 'previous_response_id' && /invalid|missing|not found|expired/i.test(error.message || '');
const mentionsConfiguration = error => /\bconfiguration_update\b/i.test(String(error?.param || '') + ' ' + String(error?.message || ''));

function nativeValidationFailure(status, error, websocket = false) {
  if (![400, 404, 405, 422, 501].includes(Number(status)) && status != null) return false;
  const code = String(error?.code || error?.type || '');
  const message = String(error?.message || '');
  if (error?.param === 'model' || /model_not_found|unknown_model|auth|permission|quota|rate_limit/i.test(code)) return false;
  if (websocket && /^(?:unsupported_endpoint|endpoint_not_found|unsupported_api|not_implemented|method_not_allowed|unsupported_event)$/.test(code)) return true;
  if (!/unsupported|invalid|unknown|unrecognized|not_implemented/i.test(code + ' ' + message)) return false;
  return mentionsConfiguration(error) || /additional_tools|responses.lite|parallel_tool_calls/i.test(String(error?.param || '') + ' ' + message) ||
    (websocket && /previous_response_id|response\.create|websocket/i.test(String(error?.param || '') + ' ' + message));
}

async function chatFallback(upstream, payload, gateway, url, incomingHeaders, signal, receivedBody) {
  if (!/\/(?:v1\/)?responses$/.test(url.pathname) || ![400, 404, 405, 501].includes(upstream.statusCode)
      || !usesChat(payload, { ...gateway.metadata, _protocol: 'chat' })) return null;
  const rejectedBody = receivedBody ?? Buffer.from(await upstream.body.arrayBuffer());
  let data, text = ''; try { text = decodeBody(rejectedBody, upstream.headers['content-encoding']).toString('utf8'); data = JSON.parse(text); } catch {}
  if (!chatEndpointUnavailable(upstream.statusCode, data, text)) return { rejectedBody };
  // Only a definitive, unaccepted endpoint rejection permits this conversion.
  // Reuse the original request, never a synthetic prompt or a partial result.
  const adapted = prepareRequest(payload, 'gateway', url.pathname, gateway.metadata, true, gateway);
  const body = Buffer.from(JSON.stringify(adapted.payload));
  const headers = gatewayResponseHeaders({ ...headersFor(incomingHeaders, 'gateway', gateway.profile), 'content-type': 'application/json' }, false);
  const next = await request(gateway.base + '/chat/completions' + url.search, {
    method: 'POST', body, headers, dispatcher: gateway.dispatcher, signal, ...RESPONSE_TIMEOUTS });
  if (next.statusCode >= 200 && next.statusCode < 300) sources.rememberChat(gateway);
  return { upstream: next, adapted, bytes: body.length };
}
async function gatewayHttpRequest(resolved, gateway, url, incomingHeaders, signal, method = 'POST', incoming) {
  const key = sources.transportKey(gateway);
  const start = async nativeLite => {
    const standardOnly = !nativeLite && sources.standardResponsesOnly.has(key);
    let payload = resolved;
    if (standardOnly && wantsNativeLite(resolved)) {
      const { [WS_LITE_FIELD]: discarded, ...clientMetadata } = resolved.client_metadata;
      payload = withoutTurnState({ ...resolved, client_metadata: clientMetadata });
    }
    const adapted = prepareRequest(payload, 'gateway', url.pathname, gateway.metadata, false, gateway,
      { nativeTools: nativeLite, flattenConfiguration: standardOnly });
    const body = incoming ? (await outgoingBody(incoming, adapted.payload, payload !== resolved || adapted.changed, false)).body : JSON.stringify(adapted.payload);
    const headers = headersFor(incomingHeaders, 'gateway', gateway.profile);
    if (!incoming) headers['content-type'] = 'application/json';
    if (standardOnly) delete headers[NATIVE_RESPONSES_HEADER];
    if (nativeLite) {
      headers[NATIVE_RESPONSES_HEADER] = 'true';
      const state = adapted.payload.client_metadata?.[TURN_STATE_HEADER];
      if (wantsNativeLite(resolved) && validTurnState(state)) headers[TURN_STATE_HEADER] = state;
    }
    const upstream = await request(adapted.chat ? gateway.base + '/chat/completions' + url.search : targetUrl('gateway', url, gateway), {
      method, body, headers: gatewayResponseHeaders(headers, !adapted.adapter, gateway.metadata?._nativeHeaderPrefix),
      dispatcher: gateway.dispatcher, signal, ...RESPONSE_TIMEOUTS,
    });
    return { upstream, adapted, bytes: Buffer.byteLength(body), nativeLite };
  };

  const mayNegotiate = method === 'POST' && /\/(?:v1\/)?responses$/.test(url.pathname) && !sources.standardResponsesOnly.has(key);
  const nativeLite = mayNegotiate && liteHttpEligible(gateway, resolved, incomingHeaders);
  let result = await start(nativeLite), rejectedBody;
  if (mayNegotiate && !result.adapted.chat && [400, 422].includes(result.upstream.statusCode) &&
      (nativeLite || isGptModel(gateway.model) && Array.isArray(resolved.input) && resolved.input.some(item => item?.type === 'configuration_update'))) {
    rejectedBody = Buffer.from(await result.upstream.body.arrayBuffer());
    let error;
    try { error = JSON.parse(decodeBody(rejectedBody, result.upstream.headers['content-encoding']).toString('utf8')).error; } catch {}
    if ((nativeLite || mentionsConfiguration(error)) && nativeValidationFailure(result.upstream.statusCode, error)) {
      sources.standardResponsesOnly.add(key);
      result = await start(false);
      rejectedBody = undefined;
    }
  }
  if (!result.adapted.chat && method === 'POST') {
    const fallback = await chatFallback(result.upstream, resolved, gateway, url, incomingHeaders, signal, rejectedBody);
    if (fallback?.upstream) return { ...fallback, nativeLite: false };
    rejectedBody = fallback?.rejectedBody ?? rejectedBody;
  }
  return { ...result, rejectedBody };
}

async function gatewayImageReferences(payload, incoming, signal) {
  if (!isGptModel(payload.model)) validateNonGptCompaction(payload);
  // API-only file IDs belong to that API. Responses can carry them unchanged;
  // a Chat route without image data reports its existing format error instead.
  // Never use a saved ChatGPT login to resolve them in this mode.
  if (mode !== 'mixed' || !Array.isArray(payload.input)) return payload;
  const needsUrl = part => part?.type === 'input_image' && part.file_id && !part.image_url;
  let files;
  for (const item of payload.input) for (const parts of [item?.content, item?.output]) {
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      if (!needsUrl(part)) continue;
      files ??= new Map();
      files.set(part.file_id, null);
    }
  }
  if (!files) return payload;
  // Match the installed client's read-only file-download-link endpoint. A file
  // ID owned by ChatGPT is not a file ID at another provider. Resolve only the
  // outgoing image reference; the canonical history keeps the original ID.
  const fileBase = officialBase.replace(/\/codex$/, '');
  const headers = headersFor(incoming, 'official');
  const controller = new AbortController();
  const lookupSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const ids = [...files.keys()];
  try {
    // The links are independent. Bound concurrent reads for image-heavy histories.
    for (let offset = 0; offset < ids.length; offset += 4) {
      await Promise.all(ids.slice(offset, offset + 4).map(async id => {
        const result = await fetchJson(fileBase + '/files/download/' + encodeURIComponent(id), headers, officialDispatcher, 12000, lookupSignal);
        if (typeof result.download_url !== 'string' || !/^https?:\/\//.test(result.download_url)) throw Object.assign(new Error('The native file service did not provide a usable image download URL.'), { status: 502, code: 'image_reference_unavailable' });
        files.set(id, result.download_url);
      }));
    }
  } catch (error) {
    controller.abort();
    throw error;
  }
  const input = payload.input.map(item => {
    let converted = item;
    for (const key of ['content', 'output']) {
      const parts = item?.[key];
      if (!Array.isArray(parts) || !parts.some(needsUrl)) continue;
      if (converted === item) converted = { ...item };
      converted[key] = parts.map(part => {
        if (!needsUrl(part)) return part;
        const { file_id, ...image } = part;
        return { ...image, image_url: files.get(file_id) };
      });
    }
    return converted;
  });
  return { ...payload, input };
}
function hasOfficialAuth(incoming) {
  const token = String(incoming.authorization || '').replace(/^Bearer\s+/i, '');
  return (mode === 'mixed' || runtime.nativeAccount === true) && (!!auth().token ||
    ((entryMode === 'official' || runtime.nativeAccount === true) && !!token && !isGatewayKey(token)));
}
function isGatewayKey(token) { return token === 'chatgpt-api-local' || token === env.API_KEY || sources.secrets.has(token); }
function headersFor(incoming, target, profile) {
  const headers = {};
  for (const [k, v] of Object.entries(incoming)) {
    if (['host','connection','content-length','transfer-encoding','content-encoding','upgrade','proxy-authorization'].includes(k) || FORWARDED_NATIVE_HEADERS.has(k) || k.startsWith('sec-websocket-')) continue;
    headers[k] = v;
  }
  if (target !== 'official') headers['accept-encoding'] = 'identity';
  if (headers['x-openai-actor-authorization'] === 'chatgpt-api-local') delete headers['x-openai-actor-authorization'];
  if (target === 'gateway') {
    headers.authorization = 'Bearer ' + (profile?.apiKey || env.API_KEY);
    delete headers['x-openai-actor-authorization'];
    delete headers['chatgpt-account-id']; delete headers['openai-organization']; delete headers['openai-project'];
  } else {
    // Honor refreshed credentials sent by the native client; legacy custom-provider
    // threads carry our gateway key and must instead use the saved local account.
    const incomingToken = String(incoming.authorization || '').replace(/^Bearer\s+/i, '');
    if (incomingToken && !isGatewayKey(incomingToken)) headers.authorization = 'Bearer ' + incomingToken;
    else {
      const a = auth();
      if (!a.token) throw Object.assign(new Error('Official models require a local ChatGPT sign-in.'), { status: 401 });
      headers.authorization = 'Bearer ' + a.token;
      delete headers['chatgpt-account-id']; if (a.accountId) headers['chatgpt-account-id'] = a.accountId;
    }
  }
  return headers;
}
function targetUrl(which, url, gateway) {
  const suffix = url.pathname.replace(/^\/v1(?=\/|$)/, '');
  return (which === 'official' ? officialBase : gateway?.base || gatewayBase) + (suffix || '/') + url.search;
}
function gatewayRequest(payload, gateway) {
  // Preserve the native speed choice, including an explicit default/off value.
  return payload.model === gateway.model ? payload : { ...payload, model: gateway.model };
}
function clientEvent(event, model, gateway) {
  return gateway && gateway.model !== model && event.response?.model === gateway.model ? { ...event, response: { ...event.response, model } } : event;
}
function imageSettings() {
  const selected = sources.settings.defaultImageModel;
  const profile = sources.profile(selected?.providerId || sources.settings.preferredProviderId);
  const id = name => profile?.id === 'default' ? name : '@' + profile?.id + '/' + name;
  // An image default never changes the primary chat source or its credentials.
  return { ...env, IMAGE_MODEL: selected ? (selected.providerId === 'default' ? selected.modelId : '@' + selected.providerId + '/' + selected.modelId) : '',
    IMAGE_EDIT_MODEL: profile?.imageEditModel ? id(profile.imageEditModel) : '' };
}
function decodeBody(body, encoding = '') {
  if (!body.length) return body;
  const decoders = { gzip: zlib.gunzipSync, deflate: zlib.inflateSync, br: zlib.brotliDecompressSync, zstd: zlib.zstdDecompressSync };
  if (!encoding || encoding === 'identity') return body;
  if (!decoders[encoding]) throw new Error('Unsupported content encoding');
  return decoders[encoding](body);
}
function json(res, code, value) { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); }
function parseRequest(text) {
  let value;
  try { value = JSON.parse(text); }
  catch { throw Object.assign(new Error('The request body must contain valid JSON.'), { status: 400, code: 'invalid_json_request' }); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Object.assign(new Error('The request body must be a JSON object.'), { status: 400, code: 'invalid_json_request' });
  return value;
}
async function* convertedEvents(stream, conversion, images) {
  const events = conversion.adapter ? new NonGptEvents(conversion.adapter) : null;
  const chat = conversion.chat ? new ChatEvents(conversion.model) : null;
  const phases = new ResponsePhases();
  let terminal = false;
  // Responses events can contain base64 images. Match the buffered Responses
  // body limit; Chat events and accumulated tool arguments keep their own limit.
  for await (const packet of ssePackets(stream, { maxEventBytes: chat ? undefined : 64 * 1024 * 1024 })) {
    if (isSseControl(packet)) { yield { event: packet }; continue; }
    if (packet.done && chat) break;
    if (!packet.data) continue;
    const data = !chat && !packet.data.type && packet.event ? { ...packet.data, type: packet.event } : packet.data;
    for (const event of chat ? chat.convert(data) : [data]) {
      if (responseTerminal(event.type)) terminal = true;
      for (const converted of events ? events.convert(event) : [event]) {
        for (const phased of phases.convert(converted)) {
          for (const item of images ? images.convert(phased) : [phased]) yield { event: item, original: item === packet.data ? packet : null };
        }
      }
    }
    // A Responses terminal event is complete even if the peer keeps HTTP open.
    // Chat completion is emitted by finish() after its usage/[DONE] packets.
    if (terminal) break;
  }
  if (chat) for (const event of chat.finish()) {
    for (const converted of events.convert(event)) {
      for (const phased of phases.convert(converted)) {
        for (const item of images ? images.convert(phased) : [phased]) yield { event: item };
      }
    }
  }
  if (events) events.finish();
  else if (!terminal) throw Object.assign(new Error('Upstream stream ended before a terminal response event.'), { status: 502, code: 'incomplete_upstream_response' });
}
function health() {
  const { IMAGE_MODEL, IMAGE_EDIT_MODEL } = gatewayEnabled ? imageSettings() : {};
  return { status: (gatewayEnabled ? status.gateway.ready : status.official.ready) ? 'ok' : 'degraded', service: 'chatgpt-api-router', version: 2, compatibilityVersion: 2, buildId, mode, entryMode, sourceId, gatewayBase, configurationId: sources.revision, clientVersion: currentClientVersion(), ...status, officialModels: mode === 'mixed' ? catalog.official.length : 0, gatewayModels: gatewayEnabled ? catalog.gatewayIds.length : 0,
    gatewayImageModels: gatewayEnabled ? catalog.gatewayModels.filter(m => imageCapabilities(m).known || m.id === IMAGE_MODEL || m.id === IMAGE_EDIT_MODEL).map(m => m.id) : [] };
}
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
  const receivedAt = Date.now();
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
    object: 'list', data: [...new Set([...(mode === 'mixed' ? catalog.official.map(m => m.slug) : []), ...(gatewayEnabled ? catalog.gatewayIds : [])])].map(id => ({ id, object: 'model' })) });
  let incoming = await readEncodedBody(req);
  if (/^\/(?:v1\/)?alpha\/search$/.test(url.pathname)) {
    if (req.method !== 'POST') throw Object.assign(new Error('Native search requires POST.'), { status: 405, code: 'invalid_search_method' });
    const body = parseRequest(incoming.decoded.toString('utf8'));
    incoming = null;
    const which = route(body.model), gateway = which === 'gateway' ? sources.target(body.model, catalog.gatewayModels) : null;
    const controller = new AbortController(); controllers.add(controller);
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    let upstream;
    try {
      const headers = headersFor(req.headers, which, gateway?.profile);
      headers['content-type'] = 'application/json';
      const send = (endpoint, payload, outgoing) => request((gateway?.base || officialBase) + endpoint + url.search, {
        method: 'POST', headers: outgoing, body: JSON.stringify(payload),
        dispatcher: gateway?.dispatcher || officialDispatcher, signal: controller.signal, ...RESPONSE_TIMEOUTS });
      upstream = gateway ? await nativeSearch.run(body, { gateway, headers, send, signal: controller.signal })
        : await send('/alpha/search', body, headers);
      const outgoing = { ...upstream.headers };
      for (const name of ['connection', 'transfer-encoding', 'keep-alive']) delete outgoing[name];
      res.writeHead(upstream.statusCode, outgoing);
      for await (const chunk of upstream.body) await writeChunk(res, chunk);
      res.end();
    } finally { releaseResponseBody(upstream?.body); controllers.delete(controller); }
    return;
  }
  const imageRoute = /^\/(?:v1\/)?images\/(generations|edits)$/.exec(url.pathname);
  if (imageRoute) {
    const body = incoming.decoded;
    incoming = null;
    if (req.method !== 'POST') throw Object.assign(new Error('Images endpoints require POST.'), { status: 405, code: 'invalid_image_request' });
    const controller = new AbortController(); controllers.add(controller);
    const nativeImageUrls = new Set();
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    try {
      const imageLogin = hasOfficialAuth(req.headers);
      return await forwardImages({ req,res,url,body,operation: imageRoute[1],env: imageSettings(),
        hasLogin: imageLogin, allowGateway: gatewayEnabled,
        routing: !gatewayEnabled ? 'official' : mode === 'gateway' || !imageLogin ? 'custom' : sources.settings.imageRouting,
        getModels: async () => catalog.gatewayModels.map(model => {
          const profile = sources.profile(model._providerId || 'default'), original = model._upstreamId || model.id;
          const selected = sources.settings.defaultImageModel;
          return profile && ([profile.imageModel, profile.imageEditModel].includes(original)
            || selected?.providerId === profile.id && selected.modelId === original) ? { ...model, type: 'image' } : model;
        }),
        resolveGateway: model => {
          const selected = sources.target(model.id, catalog.gatewayModels);
          return { ...selected, strengths: sources.settings.imageStrengths[overrideKey(selected.profile.id, selected.model)],
            env: { ...env, IMAGE_EDIT_FORMAT: selected.profile.imageEditFormat } };
        },
        headersFor,targetUrl,officialDispatcher,gatewayDispatcher,imageDispatcher: mediaDispatcher,
        imageDispatcherFor: (reference, gateway, original = reference) => nativeImageUrls.has(original) ? officialDispatcher
          : gateway && new URL(reference).origin === new URL(gateway.base).origin ? gateway.dispatcher : mediaDispatcher,
        decodeBody,signal: controller.signal,log,
        resolveFile: mode === 'mixed' && imageLogin ? async id => {
          const result = await fetchJson(officialBase.replace(/\/codex$/, '') + '/files/download/' + encodeURIComponent(id), headersFor(req.headers, 'official'), officialDispatcher, 12000, controller.signal);
          if (typeof result.download_url !== 'string' || !/^https?:\/\//.test(result.download_url)) throw Object.assign(new Error('The native file service did not provide an image URL.'), { status: 502, code: 'image_reference_unavailable' });
          nativeImageUrls.add(result.download_url); return result.download_url;
        } : undefined });
    } finally { controllers.delete(controller); }
  }
  let parsed = parseRequest(incoming.decoded.toString('utf8'));
  const model = parsed.model, which = route(model);
  const gateway = which === 'gateway' ? sources.target(model, catalog.gatewayModels) : null;
  const controller = new AbortController(); controllers.add(controller);
  res.on('close', () => { if (!res.writableEnded) controller.abort(); });
  const started = Date.now();
  const requestId = crypto.randomUUID();
  let phase = 'conversion', firstByteMs = null, upstreamBytes = null, upstreamStatus = null, upstreamBody;
  if (debug) log('request start ' + JSON.stringify({ requestId, route: which, model,
    wireBytes: incoming.raw.length, decodedBytes: incoming.decoded.length, encoding: incoming.encoding || 'identity',
    readDecodeMs: started - receivedAt }));
  try {
    let upstream, adapted, rejectedBody, encoding;
    if (gateway) {
      const input = parsed, raw = incoming;
      const renamed = gatewayRequest(input, gateway);
      const resolved = await gatewayImageReferences(renamed, req.headers, controller.signal);
      incoming = parsed = null;
      phase = 'upstream_headers';
      ({ upstream, adapted, rejectedBody, bytes: upstreamBytes } = await gatewayHttpRequest(resolved, gateway, url, req.headers, controller.signal, req.method,
        resolved === input ? raw : undefined));
    } else {
      adapted = prepareRequest(parsed, which, url.pathname);
      const payload = await outgoingBody(incoming, adapted.payload, adapted.changed, true);
      encoding = payload.encoding; upstreamBytes = payload.body.length;
      incoming = parsed = null;
      const headers = headersFor(req.headers, which);
      if (encoding) headers['content-encoding'] = encoding;
      phase = 'upstream_headers';
      upstream = await request(targetUrl(which, url), { method: req.method, body: payload.body, headers, dispatcher: officialDispatcher,
        signal: controller.signal, ...RESPONSE_TIMEOUTS });
    }
    upstreamBody = upstream.body;
    const conversion = { adapter: adapted.adapter, chat: adapted.chat, model: adapted.payload.model };
    adapted = null;
    upstreamStatus = upstream.statusCode; phase = 'stream';
    if (debug) log('request headers ' + JSON.stringify({ requestId, status: upstreamStatus, upstreamBytes,
      encoding: encoding || 'identity', ms: Date.now() - started }));
    const outgoing = { ...upstream.headers }; for (const name of ['connection','transfer-encoding','keep-alive']) delete outgoing[name];
    const images = gateway && /^\/(?:v1\/)?responses$/.test(url.pathname) ? new ResponseImages(codexHome) : null;
    if ((images || conversion.adapter || gateway && model !== gateway.model) && upstream.statusCode >= 200 && upstream.statusCode < 300) {
      const stream = decodedStream(upstream.body, upstream.headers['content-encoding']);
      delete outgoing['content-length']; delete outgoing['content-encoding'];
      outgoing['x-chatgpt-api-adapted'] = 'true';
      if (String(upstream.headers['content-type']).includes('text/event-stream')) {
        res.writeHead(upstream.statusCode, outgoing);
        res.flushHeaders();
        try {
          const keepConnection = stream === upstream.body;
          const packets = keepConnection ? stream.iterator({ destroyOnReturn: false }) : stream;
          for await (const { event, original } of convertedEvents(packets, conversion, images)) {
            if (res.destroyed) break;
            firstByteMs ??= Date.now() - started;
            const response = clientEvent(event, model, gateway);
            await writeChunk(res, original && response === event && original.event === event.type ? original.raw + '\n\n' : encodeSse(response));
          }
          if (keepConnection && !controller.signal.aborted) {
            drainResponseTail(upstreamBody); upstreamBody = null;
          }
        } catch (e) {
          if (!res.destroyed) await writeChunk(res, encodeSse(protocolError(e)));
          log('stream conversion ' + JSON.stringify({ requestId, route: which, failure: errorDetails(e) }));
        }
      } else {
        const chunks = []; let size = 0;
        for await (const chunk of stream) { size += chunk.length; if (size > 64 * 1024 * 1024) throw new Error('Upstream response exceeds limit'); chunks.push(chunk); }
        const data = JSON.parse((chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, size)).toString('utf8'));
        chunks.length = 0;
        const converted = conversion.chat ? chatResponse(data, gateway.model) : data;
        const native = conversion.adapter ? conversion.adapter.response(converted) : converted;
        const phased = gateway ? responseMessagePhases(native) : native;
        const response = images ? images.response(phased) : phased;
        if (gateway && gateway.model !== model && response.model === gateway.model) response.model = model;
        res.writeHead(upstream.statusCode, outgoing);
        firstByteMs ??= Date.now() - started;
        await writeChunk(res, JSON.stringify(response));
      }
      if (debug && conversion.adapter) log('non-GPT compatibility model=' + model + ' ' + JSON.stringify(conversion.adapter.stats));
    } else {
      res.writeHead(upstream.statusCode, outgoing);
      res.flushHeaders();
      for await (const chunk of rejectedBody !== undefined ? [rejectedBody] : upstream.body) {
        if (res.destroyed) break;
        firstByteMs ??= Date.now() - started;
        await writeChunk(res, chunk);
      }
    }
    res.end(); if (debug || upstreamStatus >= 400) log(which + ' HTTP model=' + model + ' status=' + upstream.statusCode + ' ms=' + (Date.now() - started));
    if (debug) log('request end ' + JSON.stringify({ requestId, status: upstreamStatus, firstByteMs, ms: Date.now() - started }));
  } catch (error) {
    if (!controller.signal.aborted) log('request error ' + JSON.stringify({ requestId, route: which, model, phase,
      upstreamBytes, status: upstreamStatus, firstByteMs, cancelled: controller.signal.aborted,
      failure: errorDetails(error), ms: Date.now() - started }));
    throw error;
  } finally { releaseResponseBody(upstreamBody); controllers.delete(controller); }
}
const savedCatalog = loadCatalog();
if (process.argv.includes('--prepare')) {
  try {
    const gatewayCacheComplete = savedCatalog.configurationId === sources.revision &&
      catalog.gatewayIds.length > 0 && sources.sources.length === sources.profiles().length;
    const deferred = process.argv.includes('--cached') && (!gatewayEnabled || gatewayCacheComplete) &&
      (mode !== 'mixed' || catalog.official.length);
    if (deferred) {
      status = { gateway: { ...savedCatalog.status?.gateway, ready: gatewayEnabled && catalog.gatewayIds.length > 0, cached: true },
        official: { ...savedCatalog.status?.official, ready: mode === 'mixed' && catalog.official.length > 0, cached: true } };
    } else await refreshCatalog();
    const gatewayAvailable = catalog.gatewayIds.length && Date.now() - Date.parse(catalog.gatewayAt) < CACHE_MAX_AGE;
    if (gatewayEnabled && !gatewayAvailable) {
      catalog.gatewayIds = [];
      catalog.gatewayModels = [];
      if (mode !== 'mixed' || !catalog.official.length) throw Object.assign(new Error('Gateway unavailable and no current cache for this URL/key. ' + (status.gateway.error || '')), { code: 'gateway_unavailable' });
      saveCatalog();
    }
    if (deferred || gatewayEnabled && !gatewayAvailable) writeDesktopCatalog();
    process.stdout.write(JSON.stringify({ ...health(), refreshOnStart: Boolean(deferred) }) + '\n');
  } catch (e) { process.stderr.write((e.code === 'gateway_unavailable' ? '[gateway_unavailable] ' : '') + redact(e.message, sources.settings, [env.API_KEY, ...sources.secrets]) + '\n'); process.exitCode = 1; }
  await sources.close(); await gatewayDispatcher.close(); await officialDispatcher.close();
  if (mediaDispatcher !== gatewayDispatcher) await mediaDispatcher.close();
} else {
  if (savedCatalog.sourceId === sourceId && savedCatalog.status) status = savedCatalog.status;
  const server = http.createServer((req, res) => handleHttp(req, res).catch(e => {
    const failure = protocolError(e);
    if (failure.status !== 499) log('HTTP error ' + JSON.stringify(errorDetails(e)));
    if (!res.headersSent) json(res, failure.status, { error: failure.error }); else res.destroy();
  }));
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_REQUEST_BYTES });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    if (!['/v1/responses','/responses'].includes(url.pathname)) { socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); return; }
    wss.handleUpgrade(req, socket, head, client => {
      const connectionId = crypto.randomUUID();
      let upstream; let closed = false; let officialOpening = false;
      const officialQueue = []; const laneRoutes = new Map(); const responseRoutes = new Map(); const active = new Map();
      const gatewaySockets = new Map();
      let handshakeTarget, foreignHeaders;
      function selectTarget(lane, target) {
        const previous = laneRoutes.get(lane);
        laneRoutes.set(lane, target);
        handshakeTarget ??= target;
        return previous !== undefined && previous !== target;
      }
      function requestHeaders(target) {
        if (target === handshakeTarget || !req.headers[TURN_STATE_HEADER]) return req.headers;
        if (!foreignHeaders) {
          foreignHeaders = { ...req.headers };
          delete foreignHeaders[TURN_STATE_HEADER];
        }
        return foreignHeaders;
      }
      // HTTP gateways are usually stateless. Preserve WS incremental context only
      // for this connection, with bounded memory; never write conversation copies.
      const gatewayHistory = new HistoryCache({ onDelete: id => responseRoutes.delete(id) });
      const officialPending = new PendingResponses(), officialBodies = new Map(), officialLanes = new Map();
      const textFrame = { binary: false };
      const send = (value, wait = false) => {
        const bytes = Buffer.isBuffer(value);
        const text = bytes || typeof value === 'string' ? value : JSON.stringify(value);
        // Small frames go straight to the writable loopback socket. Wait only
        // when a frame can fill the send queue or the client stops reading.
        if (wait && (client.readyState !== WebSocket.OPEN || client.bufferedAmount + text.length * (bytes ? 1 : 3) > 65536))
          return writeWebSocket(client, text);
        if (client.readyState === WebSocket.OPEN) client.send(text, textFrame);
      };
      const failure = (e, lane) => {
        const value = protocolError(e);
        if (value.status !== 499) log('WebSocket error ' + JSON.stringify({ connectionId, failure: errorDetails(e) }));
        send({ ...value, code: value.error.code, message: value.error.message, ...(lane ? { stream_id: lane } : {}) });
      };
      function rememberGateway(id, body, output, which = 'gateway', { complete = true, connection = null, lane = laneOf(body), gatewayKey, http = false } = {}) {
        if (!id) return;
        const input = [...body.input, ...(output || [])];
        const defaults = { ...body };
        for (const key of ['input','stream','type','stream_id','previous_response_id','generate']) delete defaults[key];
        if (!gatewayHistory.set(id, { input, defaults, complete, connection, lane, gatewayKey, http })) {
          responseRoutes.delete(id);
          log('history cache miss reason=capacity route=' + which);
        } else responseRoutes.set(id, which);
      }
      function officialSend(wire, event = JSON.parse(wire)) {
        let changed = false, queued;
        if (event.type === 'response.create') {
          const prior = event.previous_response_id ? gatewayHistory.get(event.previous_response_id, { materialize: false }) : null;
          if (selectTarget(laneOf(event), 'official')) {
            const scoped = withoutTurnState(event);
            changed = scoped !== event; event = scoped;
          }
          const incoming = typeof event.input === 'string' ? [{ role: 'user', content: event.input }] : event.input || [];
          let context = { ...prior?.defaults, ...event, input: [...(prior?.input || []), ...incoming] };
          const complete = !event.previous_response_id || Boolean(prior && prior.complete);
          // Previous response state can belong to a different provider or to an
          // official socket that has since closed. Never send its ID as an
          // incremental continuation on a replacement upstream connection.
          const foreign = event.previous_response_id && responseRoutes.get(event.previous_response_id) === 'gateway';
          const reconnected = prior && (prior.connection !== upstream || !upstream || upstream.readyState >= WebSocket.CLOSING);
          if (event.previous_response_id && (foreign || reconnected)) {
            if (!complete) throw Object.assign(new Error('Previous response is not cached. Retry with the full input history.'), { status: 400, code: 'previous_response_not_found' });
            if (foreign) context = withoutTurnState(context);
            event = { ...context, input: gatewayHistory.materialize(context.input) };
            delete event.previous_response_id; changed = true;
            if (debug) log('official WS full-context recovery reason=' + (foreign ? 'provider-switch' : 'upstream-reconnect'));
          }
          const normalized = historyForTarget(event, 'official');
          if (changed || normalized.changed) wire = JSON.stringify(normalized.payload);
          const trace = { requestId: crypto.randomUUID(), started: Date.now() };
          queued = { body: context, complete, incremental: Boolean(event.previous_response_id), trace };
          officialPending.push(laneOf(event), queued);
          if (debug) log('WS request ' + JSON.stringify({ connectionId, requestId: trace.requestId, route: 'official',
            model: event.model, bytes: Buffer.byteLength(wire), incremental: Boolean(event.previous_response_id) }));
        }
        officialQueue.push(wire);
        if (upstream?.readyState === WebSocket.OPEN) { while (officialQueue.length) upstream.send(officialQueue.shift(), textFrame); return; }
        if (officialOpening) return;
        officialOpening = true;
        const options = { headers: headersFor(requestHeaders('official'), 'official'), handshakeTimeout: 15000, agent: officialWebSocketAgent };
        const connection = new WebSocket(targetUrl('official', url).replace(/^http/, 'ws'), options);
        upstream = connection;
        const openedAt = Date.now();
        if (queued && event.generate !== false && !validTurnState(event.client_metadata?.[TURN_STATE_HEADER])) {
          connection.once('upgrade', response => {
            const state = response.headers[TURN_STATE_HEADER];
            if (validTurnState(state)) queued.handshakeState = state;
          });
        }
        connection.on('open', () => {
          if (connection !== upstream || closed) return connection.close();
          officialOpening = false;
          if (debug) log('official WS connected');
          while (officialQueue.length) connection.send(officialQueue.shift(), textFrame);
        });
        let writes = 0;
        connection.on('message', data => {
          if (connection !== upstream || closed) return;
          let nativeMetadata;
          try {
            const event = JSON.parse(data), id = event.response?.id, lane = laneOf(event);
            if (event.type === 'error') {
              const error = event.error || event;
              // A request error before response.created consumes one FIFO entry.
              // Once work is accepted, never replay it or guess which later
              // queued request an uncorrelated error belongs to.
              const accepted = officialLanes.has(lane);
              const pending = accepted ? null : officialPending.shift(lane);
              const invalidPrevious = Number(event.status) === 400 &&
                (error.code === 'previous_response_not_found' || error.param === 'previous_response_id' || /Invalid\s+[`'"]?previous_response_id[`'"]?/i.test(error.message || ''));
              if (invalidPrevious && pending?.incremental && pending.complete && !officialPending.peek(lane)) {
                // This validation error precedes response.created. Retry once
                // using the already assembled context, without the expired ID.
                // The retry is non-incremental, so it cannot enter this branch again.
                const replay = { ...pending.body, input: gatewayHistory.materialize(pending.body.input) };
                delete replay.previous_response_id;
                if (debug) log('official WS full-context recovery reason=invalid-previous-response');
                officialSend(JSON.stringify(replay));
                return;
              }
              if (accepted) officialPending.delete(lane);
              officialLanes.delete(lane);
              for (const [responseId, pendingBody] of officialBodies) {
                if (laneOf(pendingBody.body) === lane) { officialBodies.delete(responseId); responseRoutes.delete(responseId); }
              }
              log('official WS error status=' + (event.status || '') + ' code=' + (error.code || '') + ' invalid_previous=' + invalidPrevious);
            }
            if (id) responseRoutes.set(id, 'official');
            if (event.type === 'response.created' && id) {
              const pending = officialPending.shift(lane);
              if (pending) officialBodies.set(id, { ...pending, output: new ResponseOutput() });
              if (debug && pending?.trace) log('WS accepted ' + JSON.stringify({ connectionId, requestId: pending.trace.requestId, ms: Date.now() - pending.trace.started }));
              officialLanes.set(lane, id);
            }
            const responseId = id || event.response_id || officialLanes.get(lane);
            if (hasTurnState(event)) {
              const pending = officialBodies.get(responseId) || officialPending.peek(lane);
              if (pending) pending.handshakeState = null;
            }
            if (event.type === 'response.interrupt.accepted' && officialBodies.has(responseId))
              officialBodies.get(responseId).interrupted = true;
            officialBodies.get(responseId)?.output.observe(event);
            if (responseFinished(event.type) && officialBodies.has(id)) {
              const pending = officialBodies.get(id);
              if (pending.handshakeState) nativeMetadata = turnStateEvent(id, pending.handshakeState, event.stream_id);
              const result = pending.output.finish(event.response.output);
              rememberGateway(id, pending.body, result.output, 'official', { complete: pending.complete && (result.complete || pending.interrupted === true), connection }); officialBodies.delete(id);
              if (debug && pending.trace) log('WS end ' + JSON.stringify({ connectionId, requestId: pending.trace.requestId, status: event.response.status, ms: Date.now() - pending.trace.started }));
              if (officialLanes.get(lane) === id) officialLanes.delete(lane);
            }
            if (event.type === 'response.failed') {
              officialBodies.delete(id); responseRoutes.delete(id); if (officialLanes.get(lane) === id) officialLanes.delete(lane);
            }
          } catch (e) { log('Official context cache: ' + e.message); }
          const metadataWrite = nativeMetadata && send(nativeMetadata, true);
          const frameWrite = send(data, true);
          const forward = metadataWrite && frameWrite ? Promise.all([metadataWrite, frameWrite]) : metadataWrite || frameWrite;
          if (!forward) return;
          writes++; connection.pause();
          forward.catch(() => connection.terminate()).finally(() => { if (--writes === 0 && !closed) connection.resume(); });
        });
        connection.on('error', e => {
          if (connection !== upstream || closed) return;
          officialOpening = false; officialQueue.length = 0; failure(e);
        });
        connection.on('close', (code, reason) => {
          if (connection !== upstream) return;
          officialOpening = false; upstream = null;
          if (debug || !closed && (officialPending.size || officialBodies.size || ![1000, 1001, 1005].includes(code))) log('official WS closed code=' + code + ' lifetime_ms=' + (Date.now() - openedAt) + ' connection=' + connectionId);
          // If generation was in flight, let the native client handle the broken
          // transport. Never silently replay possibly accepted work or tool calls.
          if (!closed && (officialPending.size || officialBodies.size || ![1000, 1001, 1005].includes(code))) relayClose(client, code, reason);
        });
      }
      function closeGatewaySocket(lane) {
        const entry = gatewaySockets.get(lane);
        if (!entry) return;
        gatewaySockets.delete(lane);
        entry.socket.terminate();
      }

      function gatewaySocket(gateway, event, key) {
        const lane = laneOf(event), existing = gatewaySockets.get(lane);
        if (existing && existing.key !== key) closeGatewaySocket(lane);
        const sourceKey = sources.sourceKey(gateway.profile);
        if (sources.httpOnly.has(key) || sources.wsUpgradeUnavailable.has(sourceKey) || !websocketEligible(gateway, event)) return null;
        if (existing?.key === key && existing.socket.readyState < WebSocket.CLOSING) return existing;
        const headers = headersFor(requestHeaders(key), 'gateway', gateway.profile);
        const socket = new WebSocket(gateway.base.replace(/^http/, 'ws') + '/responses' + url.search, { headers, handshakeTimeout: 1500, maxPayload: MAX_REQUEST_BYTES });
        const entry = { socket, key };
        gatewaySockets.set(lane, entry);
        if (event.generate !== false && !validTurnState(event.client_metadata?.[TURN_STATE_HEADER])) {
          socket.once('upgrade', response => {
            const state = response.headers[TURN_STATE_HEADER];
            if (validTurnState(state)) entry.handshakeState = state;
          });
        }
        entry.ready = new Promise(resolve => {
          const unavailable = () => resolve(false);
          socket.once('open', () => {
            socket.off('error', unavailable);
            resolve(true);
          });
          socket.once('unexpected-response', (request, response) => {
            response.resume();
            if (gatewaySockets.get(lane) === entry && [404, 405, 501].includes(response.statusCode))
              sources.wsUpgradeUnavailable.add(sourceKey);
            unavailable();
            socket.terminate();
          });
          socket.once('error', unavailable);
          socket.once('close', () => {
            if (gatewaySockets.get(lane) === entry) gatewaySockets.delete(lane);
            resolve(false);
          });
          socket.on('error', () => {}); // An idle upstream socket can close independently of a turn.
        });
        return entry;
      }

      function rememberResponse(response, pending, body, connection, key) {
        const id = response.response?.id;
        if (id) responseRoutes.set(id, 'gateway');
        if (responseFinished(response.type)) {
          const result = pending.output.finish(response.response?.output);
          rememberGateway(id, body, result.output, 'gateway', { complete: pending.complete && (result.complete || pending.interrupted),
            lane: pending.lane, connection, gatewayKey: key, http: !connection });
        }
      }

      async function gatewayNativeResponse(binding, event, previous, context, gateway, pending, raw) {
        const { socket, key } = binding;
        if (!await binding.ready || socket.readyState !== WebSocket.OPEN || pending.controller.signal.aborted) return false;
        const continuation = previous?.connection === socket && previous.lane === pending.lane &&
          binding.latestResponseId === event.previous_response_id;
        if (!continuation && !pending.complete) return false;
        const replay = event.previous_response_id && !continuation;
        let wire = replay ? { ...context, input: gatewayHistory.materialize(context.input) } : event.model ? event : { ...event, model: context.model };
        if (replay) delete wire.previous_response_id;
        wire = await gatewayImageReferences(gatewayRequest(wire, gateway), requestHeaders(key), pending.controller.signal);
        wire = historyForTarget(wire, 'gateway', { nativeTools: true }).payload;
        pending.controller.signal.throwIfAborted();
        const received = on(socket, 'message', { signal: pending.controller.signal, close: ['close'], highWaterMark: 8, lowWaterMark: 2 });
        pending.native = socket;
        const images = new ResponseImages(codexHome), phases = new ResponsePhases();
        let accepted = false, terminal, nativeMetadata, retryFull = false;
        try {
          const requestText = wire === event ? raw : JSON.stringify(wire);
          if (debug) log('gateway native WS request ' + JSON.stringify({ model: context.model, bytes: Buffer.byteLength(requestText), incremental: continuation }));
          await writeWebSocket(socket, requestText);
          for await (const [data] of received) {
            const incoming = JSON.parse(data);
            if (!accepted && incoming.type === 'error') {
              const error = incoming.error || incoming;
              if (continuation && pending.complete && missingPreviousResponse(error)) {
                binding.latestResponseId = null;
                retryFull = true;
                break;
              }
              if (pending.complete && nativeValidationFailure(incoming.status, error, true)) {
                sources.httpOnly.add(key);
                socket.terminate();
                return false;
              }
            }
            accepted ||= typeof incoming.type === 'string' && incoming.type.startsWith('response.') && incoming.type !== 'response.metadata';
            if (incoming.type === 'response.interrupt.accepted') pending.interrupted = true;
            if (hasTurnState(incoming)) binding.handshakeState = null;
            for (const event of phases.convert(incoming)) for (const item of images.convert(event)) {
              let response = clientEvent(item, context.model, gateway);
              if (context.stream_id != null && response.stream_id !== context.stream_id) response = { ...response, stream_id: context.stream_id };
              pending.output.observe(response);
              if (response.response) pending.response = response.response;
              if (responseTerminal(response.type)) {
                if (responseFinished(response.type)) {
                  binding.latestResponseId = response.response?.id;
                  rememberResponse(response, pending, context, socket, key);
                  if (binding.handshakeState) nativeMetadata = turnStateEvent(response.response?.id, binding.handshakeState, context.stream_id);
                } else {
                  binding.latestResponseId = null;
                  socket.terminate();
                }
                terminal = response === incoming ? data : response;
              } else {
                const write = send(response === incoming ? data : response, true);
                if (write) await write;
              }
            }
            if (terminal) break;
          }
        } finally {
          pending.native = null;
          binding.handshakeState = null;
          await received.return();
          if (socket.isPaused && socket.readyState === WebSocket.OPEN) socket.resume();
        }
        if (retryFull) return gatewayNativeResponse(binding, event, null, context, gateway, pending, raw);
        if (!terminal) throw Object.assign(new Error('Gateway WebSocket ended before a terminal response.'), { code: 'incomplete_upstream_response' });
        if (active.get(pending.lane) === pending) active.delete(pending.lane);
        if (nativeMetadata) await send(nativeMetadata, true);
        await send(terminal, true);
        return true;
      }

      async function gatewayCreate(event, raw) {
        const lane = laneOf(event);
        if (active.has(lane)) throw Object.assign(new Error('A response is already running on this stream.'), { status: 409 });
        const previous = event.previous_response_id ? gatewayHistory.get(event.previous_response_id, { materialize: false }) : null;
        const complete = !event.previous_response_id || Boolean(previous?.complete);
        const historyMissing = () => Object.assign(new Error('Previous response is not cached on this connection. Retry with the full input history.'), { status: 400, code: 'previous_response_not_found' });
        if (event.previous_response_id && !previous) throw historyMissing();
        const incoming = typeof event.input === 'string' ? [{ role: 'user', content: event.input }] : event.input || [];
        const gateway = sources.target(event.model ?? previous?.defaults.model, catalog.gatewayModels), key = sources.transportKey(gateway);
        const switched = selectTarget(lane, key);
        if (switched || previous && previous.gatewayKey !== key) {
          const scoped = withoutTurnState(event);
          if (scoped !== event) raw = JSON.stringify(scoped);
          event = scoped;
        }
        let context = { ...previous?.defaults, ...event, input: [...(previous?.input || []), ...incoming] };
        if (previous && !event.client_metadata) context = withoutTurnState(context);
        // Once a chain uses HTTP, the remaining tool rounds can reuse that pool.
        // A later independent turn can try WebSocket again after a transient error.
        const binding = previous?.http && previous.gatewayKey === key ? null : gatewaySocket(gateway, event, key);
        // Cache the original desktop format; convert only the outgoing copy.
        if (event.generate === false) {
          // Native clients prewarm WS connections without requesting generation.
          const response = { id: 'resp_router_' + crypto.randomUUID().replaceAll('-', ''), object: 'response', created_at: Math.floor(Date.now()/1000), model: context.model, output: [], status: 'completed', error: null };
          rememberGateway(response.id, context, [], 'gateway', { complete, lane, gatewayKey: key });
          const extra = event.stream_id ? { stream_id: event.stream_id } : {};
          send({ type: 'response.created', sequence_number: 0, response: { ...response, status: 'in_progress' }, ...extra });
          send({ type: 'response.completed', sequence_number: 1, response, ...extra });
          return;
        }
        const controller = new AbortController();
        const pending = { controller, lane, streamId: event.stream_id, body: context, output: new ResponseOutput(), response: null, nextSequence: 0, interrupted: false, complete, key, binding };
        active.set(lane, pending); controllers.add(controller);
        let upstreamBody;
        const requestId = crypto.randomUUID(), started = Date.now();
        try {
          if (binding && await gatewayNativeResponse(binding, event, previous, context, gateway, pending, raw)) return;
          if (controller.signal.aborted) return;
          if (!complete) throw historyMissing();
          const body = { ...context, input: gatewayHistory.materialize(context.input), stream: true };
          delete body.type; delete body.stream_id; delete body.previous_response_id; delete body.generate;
          const headers = requestHeaders(key);
          const resolved = await gatewayImageReferences(gatewayRequest(body, gateway), headers, controller.signal);
          const { upstream: up, adapted, rejectedBody, bytes, nativeLite } = await gatewayHttpRequest(resolved, gateway, url, headers, controller.signal);
          upstreamBody = up.body;
          if (debug) log('WS headers ' + JSON.stringify({ connectionId, requestId, model: event.model, bytes, status: up.statusCode, ms: Date.now() - started }));
          if (up.statusCode < 200 || up.statusCode >= 300) {
            const raw = rejectedBody !== undefined ? rejectedBody : Buffer.from(await up.body.arrayBuffer());
            const text = decodeBody(raw, up.headers['content-encoding']).toString('utf8'); let message = text.slice(0,1800), upstreamError;
            try { const obj = JSON.parse(text); message = obj.error?.message || obj.message || message; if (obj.error && typeof obj.error === 'object') upstreamError = obj.error; } catch {}
            throw Object.assign(new Error(message), { status: up.statusCode, upstreamError });
          }
          if (!String(up.headers['content-type']).includes('text/event-stream')) throw Object.assign(new Error('Gateway did not return an SSE response'), { status: 502, code: 'invalid_upstream_content_type' });
          const conversion = { adapter: adapted.adapter, chat: adapted.chat, model: adapted.payload.model };
          const stream = decodedStream(up.body, up.headers['content-encoding']);
          const keepConnection = stream === up.body;
          const packets = keepConnection ? stream.iterator({ destroyOnReturn: false }) : stream;
          let turnState = nativeLite && up.headers[TURN_STATE_HEADER];
          for await (const { event: item, original } of convertedEvents(packets, conversion, new ResponseImages(codexHome))) {
            if (isSseControl(item)) continue;
            if (pending.interrupted) break;
            let response = clientEvent(item, body.model, gateway);
            pending.output.observe(response);
            if (response.response) pending.response = { ...pending.response, ...response.response };
            pending.nextSequence = Math.max(pending.nextSequence + 1, Number.isInteger(response.sequence_number) ? response.sequence_number + 1 : 0);
            rememberResponse(response, pending, context, null, key);
            if (hasTurnState(response)) turnState = null;
            if (responseFinished(response.type) && validTurnState(turnState)) {
              await send(turnStateEvent(response.response?.id, turnState, event.stream_id), true);
            }
            if (responseTerminal(response.type) && active.get(lane) === pending) active.delete(lane);
            if (event.stream_id != null && response.stream_id !== event.stream_id) response = { ...response, stream_id: event.stream_id };
            await send(response === item && original ? original.text : response, true);
          }
          if (keepConnection && !controller.signal.aborted) {
            drainResponseTail(upstreamBody); upstreamBody = null;
          }
          if (debug && conversion.adapter) log('non-GPT compatibility model=' + event.model + ' ' + JSON.stringify(conversion.adapter.stats));
          if (debug) log('gateway WS-to-HTTP model=' + event.model + ' status=' + up.statusCode);
        } catch (error) {
          // A successful native interrupt owns the terminal acknowledgement;
          // the deliberate HTTP abort must not fail it or a following turn.
          if (pending.interrupted && controller.signal.aborted) return;
          if (!controller.signal.aborted) log('WS error ' + JSON.stringify({ connectionId, requestId, failure: errorDetails(error), status: error.status,
            cancelled: controller.signal.aborted, ms: Date.now() - started }));
          throw error;
        } finally {
          releaseResponseBody(upstreamBody);
          if (pending.response?.id && !gatewayHistory.entries.has(pending.response.id)) responseRoutes.delete(pending.response.id);
          if (active.get(lane) === pending) active.delete(lane); controllers.delete(controller);
        }
      }
      function gatewayInterrupt(event) {
        const id = event.response_id;
        if (typeof id !== 'string' || !id) throw Object.assign(new Error('response.interrupt requires a response_id.'), { status: 400, code: 'invalid_response_id' });
        const pending = [...active.values()].find(value => value.response?.id === id);
        const cached = pending ? null : gatewayHistory.get(id, { materialize: false });
        const lane = pending?.lane ?? cached?.lane;
        const streamId = event.stream_id ?? pending?.streamId ?? (typeof cached?.lane === 'string' ? cached.lane : undefined);
        const extra = streamId !== undefined ? { stream_id: streamId } : {};
        const modeSupported = event.mode === 'discard_partial_items';
        if (!modeSupported || (!pending && (!cached || responseRoutes.get(id) !== 'gateway')) || (event.stream_id != null && laneOf(event) !== lane)) {
          send({ type: 'response.interrupt.failed', response_id: id, ...extra,
            error: { code: modeSupported ? 'response_not_found' : 'unsupported_interrupt_mode',
              message: modeSupported ? 'No matching gateway response exists on this stream.' : 'Only discard_partial_items interruption is supported.' } });
          return;
        }
        if (!pending) {
          // Completion may already be on the wire when its interrupt arrives.
          // Acknowledge it without emitting a second terminal response.
          send({ type: 'response.interrupt.accepted', response_id: id, ...extra });
          return;
        }
        pending.interrupted = true;
        if (active.get(lane) === pending) active.delete(lane);
        pending.controller.abort();
        // Retain only original, completed items. Never complete partial tool
        // arguments or manufacture assistant text from uncommitted deltas.
        const output = pending.output.finish().output.filter(item => !item.status || item.status === 'completed');
        const response = { ...pending.response, status: 'cancelled', output };
        rememberGateway(id, pending.body, output, 'gateway', { complete: pending.complete, lane, gatewayKey: pending.key, http: true });
        send({ type: 'response.interrupt.accepted', response_id: id, sequence_number: pending.nextSequence++, ...extra });
        send({ type: 'response.completed', response, sequence_number: pending.nextSequence++, ...extra });
        if (debug) log('gateway WS interrupted response=' + id);
      }
      // Attach immediately, before opening either upstream, so the first frame is retained.
      client.on('message', data => {
        try {
          const event = parseRequest(data); const lane = laneOf(event);
          const target = laneRoutes.get(lane);
          const which = event.model ? route(event.model) : responseRoutes.get(event.response_id) || responseRoutes.get(event.previous_response_id) || (target && (target === 'official' ? 'official' : 'gateway'));
          if (event.type === 'response.interrupt' && which !== 'official') {
            const pending = [...active.values()].find(value => value.response?.id === event.response_id && (event.stream_id == null || value.lane === lane));
            if (pending?.native?.readyState === WebSocket.OPEN) pending.native.send(data, textFrame);
            else gatewayInterrupt(event);
            return;
          }
          if (!which) throw Object.assign(new Error('A model is required before continuing this stream.'), { status: 400 });
          if (which === 'official') {
            if (!active.has(lane)) closeGatewaySocket(lane);
            officialSend(data, event);
          }
          else if (event.type === 'response.create') gatewayCreate(event, data).catch(e => failure(e, event.stream_id));
          else if (event.type === 'response.cancel') {
            const pending = active.get(lane);
            if (pending?.native?.readyState === WebSocket.OPEN) {
              const socket = pending.native;
              pending.interrupted = true;
              socket.send(data, textFrame, () => socket.terminate());
            } else if (pending?.binding?.socket.readyState === WebSocket.CONNECTING) closeGatewaySocket(lane);
            pending?.controller.abort();
          }
          else throw Object.assign(new Error('This gateway does not support WebSocket event ' + event.type), { status: 400, code: 'unsupported_event' });
        } catch (e) { failure(e); }
      });
      client.on('close', () => {
        closed = true; upstream?.terminate();
        for (const lane of gatewaySockets.keys()) closeGatewaySocket(lane);
        for (const value of active.values()) value.controller.abort();
      });
      client.on('error', e => log('WebSocket client ' + e.message));
    });
  });
  const host = env.SHIM_HOST || '127.0.0.1';
  if (!['127.0.0.1','::1'].includes(host)) throw new Error('The local router must bind to loopback.');
  routerReady = new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(Number(process.env.CHATGPT_SHIM_PORT || env.SHIM_PORT || 8102), host, () => {
      if (debug) log('router v2 listening mode=' + mode + ' transport=' + transport); resolve();
    });
  });
  if (runtime.refreshOnStart) routerReady.then(() => refreshCatalog()).catch(error => log('catalog refresh ' + error.message));
  let closing;
  closeRouter = () => closing ||= (async () => {
    for (const c of controllers) c.abort();
    for (const ws of wss.clients) ws.terminate();
    const closed = new Promise(resolve => server.close(resolve));
    server.closeAllConnections();
    officialWebSocketAgent?.destroy();
    sources.destroy();
    await Promise.allSettled([gatewayDispatcher.destroy(), officialDispatcher.destroy(),
      ...(mediaDispatcher !== gatewayDispatcher ? [mediaDispatcher.destroy()] : []), closed]);
  })();
  if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    await routerReady;
    const shutdown = () => closeRouter().then(() => process.exit());
    process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
  }
}
