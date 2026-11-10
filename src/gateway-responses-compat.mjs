import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { decodedStream, encodeSse, ssePackets } from './sse.mjs';
import { requestWithAbort, releaseResponseBody, NATIVE_PROTOCOL_HEADERS } from './transport.mjs';

const terminal = new Set(['response.completed', 'response.incomplete', 'response.failed', 'error']);
const imageItem = item => item?.type === 'image_generation_call';
const externalCall = item => !imageItem(item) && typeof item?.type === 'string' && item.type.endsWith('_call');
const nativeHeaders = new Set(NATIVE_PROTOCOL_HEADERS.flatMap(name => [name, 'x-bf-eh-' + name]));
const defaultImageModel = 'gpt-image-2.5-flare';
const shortText = (value, max = 300) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\s\0]/.test(value);

// This separate, non-secret file is opt-in and is not shipped as user state.
// Fail closed: a malformed rule must never accidentally select another source.
export function readGatewayResponseRules(root, log = () => {}) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(root, 'data/state/responses-compat.json'), 'utf8').replace(/^\uFEFF/, ''));
    if (value?.version !== 1 || !Array.isArray(value.rules) || value.rules.length > 32 || value.rules.some(rule =>
      !rule || !shortText(rule.profileId, 100) || !shortText(rule.modelPrefix) || !rule.modelPrefix.endsWith('/') ||
      typeof rule.bifrostProvider !== 'string' || !/^[A-Za-z0-9._-]{1,100}$/.test(rule.bifrostProvider) ||
      (rule.declareHostedImages !== undefined && typeof rule.declareHostedImages !== 'boolean') ||
      (rule.imageModel !== undefined && !shortText(rule.imageModel)))) throw new Error('Invalid compatibility rules');
    return value.rules;
  } catch (error) {
    if (error.code !== 'ENOENT') log('Responses compatibility configuration is invalid; rules disabled.');
    return [];
  }
}

export function imageComplexityError(event) {
  const error = event?.error || event?.response?.error;
  return ['error', 'response.failed'].includes(event?.type) &&
    error?.type === 'image_generation_user_error' && error?.param === 'complexity' &&
    /^Complexity '[^']+' is not supported for this image model\.?$/.test(error?.message || '');
}

// Do not replay a mixed tool turn. Keep image options/reference history, but
// expose only the hosted image tool and omit reasoning in this subrequest only.
export function imageSubrequest(payload, imageModel = defaultImageModel) {
  const tool = payload.tools?.find(tool => tool?.type === 'image_generation');
  const retry = { ...payload, stream: true, store: false, parallel_tool_calls: false,
    tools: [{ output_format: 'png', model: imageModel, ...tool, type: 'image_generation' }],
    tool_choice: { type: 'image_generation' } };
  delete retry.reasoning;
  return retry;
}

async function* packets(response) {
  for await (const packet of ssePackets(decodedStream(response.body, response.headers['content-encoding']), { maxEventBytes: 64 * 1024 * 1024 })) {
    if (packet.data) yield packet.data;
  }
}

// Stream text/reasoning immediately; withhold unsuccessful image placeholders.
// A successful retry fills the image slot with its REAL upstream item id, so the
// existing ResponseImages adapter can save, display and restore image history.
export async function* compatibleImageEvents(first, { payload, logicalModel, send, signal, imageModel, log = () => {} }) {
  let active = first, nextSequence = 0, responseId, initialResponse;
  let failedImageIndex, highestIndex = -1, hasExternalCall = false, hasImage = false;
  let retry = false, ended = false;
  const completed = new Map(), pending = new Set(), imageSlots = new Set();
  const emit = event => ({ ...event, sequence_number: nextSequence++ });
  const normalize = event => event.response ? { ...event,
    response: { ...event.response, id: responseId || event.response.id, model: logicalModel } } : event;
  const observe = item => {
    if (externalCall(item)) hasExternalCall = true;
    if (imageItem(item) && item.result) hasImage = true;
  };
  try {
    for await (const event of packets(first)) {
      if (event.response?.id) responseId ||= event.response.id;
      if (event.type === 'response.created') initialResponse = event.response;
      if (Number.isInteger(event.output_index)) highestIndex = Math.max(highestIndex, event.output_index);
      observe(event.item);
      if (Array.isArray(event.response?.output)) for (const [index, item] of event.response.output.entries()) {
        observe(item);
        highestIndex = Math.max(highestIndex, index);
        if (terminal.has(event.type)) {
          if (imageItem(item)) { imageSlots.add(index); failedImageIndex ??= index; }
          else if (item.status !== 'completed') pending.add(item.id ?? index);
          if (item.status === 'completed') completed.set(index, item);
        }
      }
      if (event.type === 'response.output_item.added' && !imageItem(event.item)) pending.add(event.item?.id ?? event.output_index);
      if (event.type === 'response.output_item.done') {
        pending.delete(event.item?.id ?? event.output_index);
        completed.set(event.output_index, event.item);
      }
      if (imageItem(event.item) && Number.isInteger(event.output_index)) {
        imageSlots.add(event.output_index);
        failedImageIndex ??= event.output_index;
      }
      if (event.type === 'response.output_item.added' && imageItem(event.item)) continue;
      if (event.type?.startsWith('response.image_generation_call.')) continue;
      if (imageComplexityError(event) && payload.reasoning && !hasExternalCall && !hasImage && pending.size === 0 && imageSlots.size <= 1) {
        retry = true;
        log('hosted image compatibility retry ' + JSON.stringify({ responseId, reason: 'unsupported_image_complexity', imageOnly: true, retainedChatReasoning: true }));
        break;
      }
      yield emit(normalize(event));
      if (terminal.has(event.type)) { ended = true; break; }
    }
    releaseResponseBody(first.body);
    if (!retry) {
      if (!ended) throw Object.assign(new Error('Upstream stream ended before a terminal response event.'), { status: 502, code: 'incomplete_upstream_response' });
      return;
    }
    signal?.throwIfAborted();
    active = await send(imageSubrequest(payload, imageModel), { imageOnly: true });
    if (active.statusCode < 200 || active.statusCode >= 300 || !String(active.headers['content-type']).includes('text/event-stream')) {
      throw Object.assign(new Error('The image-only compatibility request did not return a successful event stream.'), { status: 502, code: 'image_compatibility_retry_failed' });
    }
    const indices = new Map();
    const slot = (index, item) => {
      if (!Number.isInteger(index)) return index;
      if (!indices.has(index)) indices.set(index, imageItem(item) && Number.isInteger(failedImageIndex) ? failedImageIndex : ++highestIndex);
      return indices.get(index);
    };
    const retried = new Map();
    for await (const original of packets(active)) {
      if (externalCall(original.item) || original.response?.output?.some(externalCall)) {
        throw Object.assign(new Error('The image-only retry returned an unexpected tool call.'), { status: 502, code: 'image_compatibility_retry_failed' });
      }
      if (['response.created', 'response.in_progress', 'response.queued'].includes(original.type)) {
        if (!responseId && original.type === 'response.created') {
          responseId = original.response?.id; initialResponse = original.response;
          yield emit(normalize(original));
        }
        continue;
      }
      if (original.type?.startsWith('response.image_generation_call.')) continue;
      let event = { ...original };
      if (Number.isInteger(event.output_index)) event.output_index = slot(event.output_index, event.item);
      if (event.type === 'response.output_item.added' && imageItem(event.item)) continue;
      if (event.type === 'response.output_item.done') retried.set(event.output_index, event.item);
      if (event.response) {
        const output = event.response.output;
        if (Array.isArray(output)) for (const [index, item] of output.entries()) retried.set(slot(index, item), item);
        const merged = new Map([...completed, ...retried]);
        event.response = { ...event.response, id: responseId || event.response.id, model: logicalModel,
          tools: initialResponse?.tools ?? event.response.tools,
          tool_choice: initialResponse?.tool_choice ?? event.response.tool_choice,
          reasoning: initialResponse?.reasoning ?? event.response.reasoning,
          output: [...merged].sort(([left], [right]) => left - right).map(([, item]) => item) };
      }
      if (event.response_id && responseId) event.response_id = responseId;
      if (event.type === 'response.completed') {
        const images = event.response?.output?.filter(item => imageItem(item) && item.result).length || 0;
        if (!images) throw Object.assign(new Error('The image-only retry completed without an image.'), { status: 502, code: 'image_compatibility_retry_failed' });
        log('hosted image compatibility completed ' + JSON.stringify({ responseId, images }));
      }
      yield emit(event);
      if (terminal.has(event.type)) { ended = true; break; }
    }
    if (!ended) throw Object.assign(new Error('The image-only retry ended without a terminal event.'), { status: 502, code: 'incomplete_upstream_response' });
  } finally {
    releaseResponseBody(first.body);
    if (active !== first) releaseResponseBody(active.body);
  }
}

// Only explicitly selected GPT gateway requests reach this adapter. Official
// routes, other profiles, Chat adapters and /responses/compact stay unchanged.
export async function gatewayResponseRequest(url, options, { payload, gateway, rules = [], log = () => {}, request = requestWithAbort } = {}) {
  const parsed = new URL(url);
  const rule = rules.find(candidate => candidate.profileId === gateway?.profile?.id &&
    typeof candidate.modelPrefix === 'string' && candidate.modelPrefix.length &&
    typeof payload?.model === 'string' && payload.model.startsWith(candidate.modelPrefix) &&
    payload.model.length > candidate.modelPrefix.length && candidate.bifrostProvider && parsed.pathname.endsWith('/responses'));
  if (!rule) return request(url, options);
  const wirePayload = { ...payload, model: payload.model.slice(rule.modelPrefix.length) };
  if (rule.declareHostedImages) {
    if (!Array.isArray(wirePayload.tools) || !wirePayload.tools.some(tool => tool?.type === 'image_generation')) {
      wirePayload.tools = [...(Array.isArray(wirePayload.tools) ? wirePayload.tools : []),
        { type: 'image_generation', model: rule.imageModel || defaultImageModel, output_format: 'png' }];
    }
    // Native tool inventory and hosted tools are separate capabilities. Describe
    // the tool actually supplied on this wire request, without forcing its use.
    const notice = 'This Responses request includes the server-hosted image_generation tool. It is available for image creation and editing independently of the client-side native image_gen tool inventory. When the user asks for an image, use the provided hosted image_generation tool directly; do not claim it is unavailable merely because native image_gen is absent. The launcher saves and displays actual tool results. Do not use shell/API workarounds or claim generation without a real tool result.';
    wirePayload.instructions = [typeof payload.instructions === 'string' ? payload.instructions : '', notice].filter(Boolean).join('\n\n');
  }
  const headers = Object.fromEntries(Object.entries(options.headers || {}).filter(([name]) => !['content-length', 'content-encoding', 'x-model-provider'].includes(name.toLowerCase())));
  headers['content-type'] = 'application/json';
  headers['x-model-provider'] = rule.bifrostProvider;
  // Retain a reverse proxy's URL prefix, if present.
  parsed.pathname = parsed.pathname.replace(/\/(?:v1\/)?responses$/, '/openai_passthrough/v1/responses');
  const send = async (body, { imageOnly = false } = {}) => {
    // A new image operation must not inherit native turn-state, Lite negotiation
    // or request identity. Authentication/provider routing remain unchanged.
    const outgoing = imageOnly ? Object.fromEntries(Object.entries(headers).filter(([name]) => !nativeHeaders.has(name.toLowerCase()))) : headers;
    return request(parsed.toString(), { ...options, headers: outgoing, body: JSON.stringify(body) });
  };
  log('bifrost raw responses ' + JSON.stringify({ provider: rule.bifrostProvider, model: wirePayload.model }));
  const upstream = await send(wirePayload);
  if (upstream.statusCode < 200 || upstream.statusCode >= 300 || !String(upstream.headers['content-type']).includes('text/event-stream')) return upstream;
  const outgoingHeaders = { ...upstream.headers };
  delete outgoingHeaders['content-length']; delete outgoingHeaders['content-encoding'];
  const events = compatibleImageEvents(upstream, { payload: wirePayload, logicalModel: payload.model,
    send, signal: options.signal, imageModel: rule.imageModel || defaultImageModel, log });
  return { ...upstream, headers: outgoingHeaders, body: Readable.from((async function* () {
    for await (const event of events) yield Buffer.from(encodeSse(event));
  })(), { objectMode: false }) };
}
