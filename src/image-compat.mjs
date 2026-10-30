import { requestWithAbort as request, releaseResponseBody, RESPONSE_TIMEOUTS, writeChunk } from './transport.mjs';

const fail = (message, code, status = 400) => Object.assign(new Error(message), { code, status });
const ok = status => status >= 200 && status < 300;
const leaf = id => id.split('/').at(-1);
const imageFamily = id => /^(?:gpt-image(?:-|$)|dall-e(?:-|$)|imagen(?:-|\d|$)|qwen-image(?:-|$)|flux(?:[-.\d]|$)|stable-(?:diffusion|image)(?:-|$)|sdxl(?:-|$)|seedream(?:-|$)|hunyuan-image(?:-|$)|grok-imagine(?:-image|-\d|$))|^gemini-.*-image(?:-|$)/i.test(leaf(id));
const imageEndpoint = value => /(?:^|[/:_.-])(?:images?[/:_.-](?:generations?|edits?)|image[_.-](?:generation|edit))(?:$|[/:_.-])/i.test(value);

// /models often lists only IDs. Keep capability metadata when present, and
// allow an explicitly configured model for aliases with no discoverable type.
export function imageCapabilities(model) {
  const endpoints = Array.isArray(model.supported_endpoints) ? model.supported_endpoints : null;
  const caps = model.capabilities;
  const names = Array.isArray(caps) ? caps : caps && typeof caps === 'object' ? Object.keys(caps).filter(key => caps[key] === true) : [];
  const outputs = model.output_modalities || model.architecture?.output_modalities || [];
  const generation = endpoints?.some(e => /images?[/:_.-]generations?|image[_.-]generation/i.test(e)) || names.includes('image_generation');
  const editing = endpoints?.some(e => /images?[/:_.-]edits?|image[_.-]edit/i.test(e)) || names.includes('image_edit');
  const known = generation || editing || outputs.includes('image') || ['image', 'image_generation'].includes(model.type) || imageFamily(model.id);
  const explicitImages = endpoints?.some(imageEndpoint) || names.includes('image_generation') || names.includes('image_edit');
  return { known, generation: explicitImages ? !!generation : known, editing: explicitImages ? !!editing : known };
}
export function imageOnlyModel(model) {
  const outputs = model.output_modalities || model.architecture?.output_modalities || [];
  if (outputs.includes('text') || model.supported_endpoints?.some(e => /chat|responses/i.test(e))) return false;
  return imageCapabilities(model).known;
}
function requestedImage(models, requested, nativeDefault) {
  if (!requested || requested === 'auto' || nativeDefault && requested === 'gpt-image-2') return null;
  const exact = models.find(model => model.id === requested);
  if (exact) return exact;
  const matches = models.filter(model => model._upstreamId === requested || leaf(model.id) === requested);
  if (matches.length > 1) throw fail('The image model exists at multiple API sources; specify its full source-qualified ID: ' + requested, 'ambiguous_image_model');
  return matches[0] || null;
}
export function imageCandidates(models, env, operation, requested, { nativeDefault = false } = {}) {
  const capability = operation === 'edits' ? 'editing' : 'generation';
  const explicit = requestedImage(models, requested, nativeDefault);
  if (explicit) {
    const caps = imageCapabilities(explicit);
    if (caps.known && !caps[capability]) throw fail('Selected image model does not advertise ' + operation + ': ' + explicit.id, 'unsupported_image_operation');
    return [explicit];
  }
  if (requested && requested !== 'auto' && !(nativeDefault && requested === 'gpt-image-2')) throw fail('Selected image model is not provided by this API: ' + requested, 'no_gateway_image_model');
  const configured = operation === 'edits' ? env.IMAGE_EDIT_MODEL || env.IMAGE_MODEL : env.IMAGE_MODEL;
  if (configured) {
    const model = models.find(m => m.id === configured);
    if (!model) throw fail('Configured image model is not provided by this API: ' + configured, 'no_gateway_image_model');
    const caps = imageCapabilities(model);
    if (!caps.known || caps[capability]) return [model];
    if (operation !== 'edits' || env.IMAGE_EDIT_MODEL) throw fail('Configured image model does not advertise ' + operation + ': ' + configured, 'no_gateway_image_model');
  }
  const candidates = models.filter(m => imageCapabilities(m)[capability]);
  const exact = candidates.find(model => model.id === requested);
  if (exact?._providerId && exact._providerId !== 'default') return [exact];
  return [...candidates.filter(m => m.id === requested || leaf(m.id) === leaf(requested || '')),
    ...candidates.filter(m => m.id !== requested && leaf(m.id) !== leaf(requested || ''))];
}
export function imageModelUnavailable(status, data) {
  if (ok(status) || data?.data?.length) return false;
  const e = data?.error || data || {};
  const code = String(e.code || e.type || '');
  const message = typeof e.message === 'string' ? e.message : typeof data?.detail === 'string' ? data.detail : '';
  if (/content_policy|safety|moderation|invalid_prompt/i.test(code + ' ' + message)) return false;
  if (status === 401 || status === 404 || status === 405) return true;
  if ([400,403,429].includes(status) && /^(?:model_not_found|unknown_model|model_unavailable|model_access_denied|unsupported_model|unsupported_endpoint|endpoint_not_found|permission_denied|insufficient_quota|quota_exceeded|usage_limit_reached)$/.test(code)) return true;
  return [400,403].includes(status) && (e.param == null || e.param === 'model') &&
    /(?:model|image generation|image editing|images endpoint).*(?:not found|not available|unavailable|not supported|unsupported|no access|access denied)|(?:unknown|unsupported) model/i.test(message);
}
function responseHeaders(headers, changed = false) {
  const result = { ...headers };
  for (const name of ['connection','transfer-encoding','keep-alive']) delete result[name];
  if (changed) { delete result['content-length']; delete result['content-encoding']; result['content-type'] = 'application/json; charset=utf-8'; }
  return result;
}
async function boundedBody(stream, max = 64 * 1024 * 1024) {
  const chunks = []; let bytes = 0;
  for await (const chunk of stream) {
    bytes += chunk.length;
    if (bytes > max) { stream.destroy(); throw fail('Image response exceeds the size limit.', 'invalid_upstream_image_response', 502); }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function imageBytes(reference, dispatcher, signal) {
  const match = typeof reference === 'string' && /^data:(image\/[\w.+-]+);base64,([A-Za-z0-9+/=\r\n]+)$/.exec(reference);
  if (match) return { bytes: Buffer.from(match[2], 'base64'), type: match[1] };
  let url; try { url = new URL(reference); } catch { throw fail('Image API returned an invalid image URL.', 'invalid_upstream_image_response', 502); }
  for (let redirects = 0; redirects <= 3; redirects++) {
    if (!['http:','https:'].includes(url.protocol) || url.username || url.password) throw fail('Only HTTP(S) image URLs are supported.', 'invalid_upstream_image_response', 502);
    // Signed image URLs must never receive either the API key or ChatGPT OAuth.
    const upstream = await request(url, { dispatcher, signal, headers: { accept: 'image/*' }, headersTimeout: 30000, bodyTimeout: 60000 });
    if ([301,302,303,307,308].includes(upstream.statusCode) && upstream.headers.location) {
      upstream.body.destroy(); url = new URL(upstream.headers.location, url); continue;
    }
    if (!ok(upstream.statusCode)) { upstream.body.destroy(); throw fail('Image download failed (HTTP ' + upstream.statusCode + ').', 'image_download_failed', 502); }
    const type = String(upstream.headers['content-type'] || '').split(';')[0];
    if (!type.startsWith('image/')) { upstream.body.destroy(); throw fail('Image URL did not return an image.', 'invalid_upstream_image_response', 502); }
    return { bytes: await boundedBody(upstream.body, 32 * 1024 * 1024), type };
  }
  throw fail('Image URL redirected too many times.', 'image_download_failed', 502);
}
async function gatewayBody(original, model, operation, env, dispatcher, signal, resolveFile) {
  const payload = structuredClone(original); payload.model = model.id;
  // Native "auto" controls are provider defaults. Preserve explicit choices.
  if (!/^gpt-image(?:-|$)/i.test(leaf(model.id))) {
    for (const key of ['size','quality','background']) if (payload[key] === 'auto') delete payload[key];
    if (payload.background === 'opaque') delete payload.background;
  }
  if (operation === 'edits' && Array.isArray(payload.images)) {
    for (let i = 0; i < payload.images.length; i++) {
      const image = payload.images[i];
      if (image.file_id && !image.image_url) payload.images[i] = { image_url: await resolveFile(image.file_id) };
    }
  }
  const format = env.IMAGE_EDIT_FORMAT || 'json';
  if (operation !== 'edits' || format === 'json') return { body: Buffer.from(JSON.stringify(payload)), contentType: 'application/json' };
  if (format !== 'multipart') throw fail('IMAGE_EDIT_FORMAT must be json or multipart.', 'invalid_image_configuration');
  if (!Array.isArray(payload.images) || !payload.images.length) throw fail('Image editing requires image references.', 'invalid_image_request');
  const form = new FormData();
  for (const [key,value] of Object.entries(payload)) {
    if (key === 'images') continue;
    if (value != null) form.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
  }
  for (const [i,image] of payload.images.entries()) {
    const { bytes,type } = await imageBytes(image.image_url, dispatcher, signal);
    const extension = type === 'image/jpeg' ? 'jpg' : type.split('/')[1];
    form.append(payload.images.length === 1 ? 'image' : 'image[]', new Blob([bytes], { type }), 'image-' + i + '.' + extension);
  }
  const encoded = new Response(form);
  return { body: Buffer.from(await encoded.arrayBuffer()), contentType: encoded.headers.get('content-type') };
}
async function nativeImageResponse(data, dispatcher, signal) {
  if (!Number.isInteger(data?.created) || !Array.isArray(data.data) || !data.data.length) throw fail('Image API did not return a valid Images response with created and data.', 'invalid_upstream_image_response', 502);
  let changed = false;
  for (const image of data.data) {
    if (typeof image.b64_json === 'string' && image.b64_json) continue;
    if (typeof image.url !== 'string' || !image.url) throw fail('Image API returned neither b64_json nor an image URL.', 'invalid_upstream_image_response', 502);
    image.b64_json = (await imageBytes(image.url, dispatcher, signal)).bytes.toString('base64'); changed = true;
  }
  return { data,changed };
}
// Image calls are independent of the conversational model menu and adapters.
// Fallback is allowed only after a definitive rejection, never after accepted
// output, an ambiguous network failure, or a content-policy rejection.
export async function forwardImages({ req,res,url,body,operation,env,hasLogin,allowGateway = true,getModels,headersFor,targetUrl,officialDispatcher,gatewayDispatcher,imageDispatcher,decodeBody,resolveFile,resolveGateway,signal,log }) {
  let original; try { original = JSON.parse(body.toString('utf8')); } catch { throw fail('Images requests must contain JSON.', 'invalid_image_request'); }
  if (!original || Array.isArray(original) || typeof original !== 'object') throw fail('Invalid Images request.', 'invalid_image_request');
  // The current native image tool has no model argument and always supplies
  // gpt-image-2. Its turn header distinguishes that default from an explicit
  // model selected by an ordinary Images API caller. Never inspect the prompt.
  const nativeDefault = Boolean(req.headers['x-codex-image-turn-id']) && original.model === 'gpt-image-2';
  const models = allowGateway ? await getModels() : [];
  const chosen = allowGateway && (requestedImage(models, original.model, nativeDefault)
    || (operation === 'edits' ? env.IMAGE_EDIT_MODEL || env.IMAGE_MODEL : env.IMAGE_MODEL));
  let officialFailure;
  const forward = async (which, model, outgoing = { body, contentType: req.headers['content-type'] || 'application/json' }, gateway) => {
    const headers = headersFor(req.headers, which, gateway?.profile); headers['content-type'] = outgoing.contentType;
    if (which === 'gateway') delete headers['x-openai-internal-codex-responses-lite'];
    const upstream = await request(targetUrl(which, url, gateway), { method: 'POST', body: outgoing.body, headers, dispatcher: which === 'official' ? officialDispatcher : gateway?.dispatcher || gatewayDispatcher, signal, ...RESPONSE_TIMEOUTS });
    try {
      log(which + ' images operation=' + operation + ' model=' + model + ' status=' + upstream.statusCode);
      if (which === 'official' && ok(upstream.statusCode)) {
        res.writeHead(upstream.statusCode, responseHeaders(upstream.headers));
        for await (const chunk of upstream.body) { if (res.destroyed) break; await writeChunk(res, chunk); }
        res.end(); return { completed: true };
      }
      const raw = await boundedBody(upstream.body);
      const decoded = decodeBody(raw, upstream.headers['content-encoding'] || '');
      let data; try { data = JSON.parse(decoded.toString('utf8')); } catch {}
      if (which === 'gateway' && ok(upstream.statusCode)) {
        const normalized = await nativeImageResponse(data, imageDispatcher, signal);
        res.writeHead(upstream.statusCode, responseHeaders(upstream.headers, normalized.changed));
        res.end(normalized.changed ? JSON.stringify(normalized.data) : raw); return { completed: true };
      }
      return { status: upstream.statusCode,headers: upstream.headers,raw,data };
    } finally { releaseResponseBody(upstream.body); }
  };
  if (hasLogin && !chosen) {
    const result = await forward('official', original.model);
    if (result.completed) return;
    if (!allowGateway || !imageModelUnavailable(result.status, result.data)) { res.writeHead(result.status, responseHeaders(result.headers)); res.end(result.raw); return; }
    officialFailure = result;
  }
  if (!allowGateway) throw fail('The official entry requires ChatGPT sign-in for image generation and editing.', 'official_sign_in_required', 401);
  let candidates;
  try { candidates = imageCandidates(models, env, operation, original.model, { nativeDefault }); }
  catch (e) { if (officialFailure) e.message = 'Official image model is unavailable (HTTP ' + officialFailure.status + '). ' + e.message; throw e; }
  if (!candidates.length) throw fail((officialFailure ? 'Official image model is unavailable (HTTP ' + officialFailure.status + '). ' : '') + 'This custom API provides no model for image ' + (operation === 'edits' ? 'editing' : 'generation') + '. Add an image model to the API; IMAGE_MODEL / IMAGE_EDIT_MODEL can select an alias.', 'no_gateway_image_model');
  let last;
  for (const model of candidates) {
    const gateway = resolveGateway?.(model);
    const outgoing = await gatewayBody(original, gateway ? { ...model, id: gateway.model } : model, operation, gateway?.env || env, imageDispatcher, signal, resolveFile);
    const result = await forward('gateway', model.id, outgoing, gateway);
    if (result.completed) return;
    last = { ...result,model: model.id };
    if (!imageModelUnavailable(result.status, result.data)) break;
  }
  if (!officialFailure) { res.writeHead(last.status, responseHeaders(last.headers)); res.end(last.raw); return; }
  const detail = typeof last.data?.error?.message === 'string' ? last.data.error.message : 'HTTP ' + last.status;
  throw fail('Official image model is unavailable (HTTP ' + officialFailure.status + '). Custom image model ' + last.model + ' failed: ' + detail, 'image_model_unavailable', last.status);
}
