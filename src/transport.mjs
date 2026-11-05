import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { isIP } from 'node:net';
import { checkServerIdentity } from 'node:tls';
import { Agent, ProxyAgent, buildConnector, request } from 'undici';

export const MAX_REQUEST_BYTES = 256 * 1024 * 1024;
export const CONNECT_TIMEOUT_MS = 10000;
// The native client owns generation deadlines. Explicit zeros disable Undici's
// default timers; cancellation and upstream completion still release requests.
export const RESPONSE_TIMEOUTS = { headersTimeout: 0, bodyTimeout: 0 };
export const NATIVE_RESPONSES_HEADER = 'x-openai-internal-codex-responses-lite';
export const FORWARDED_NATIVE_RESPONSES_HEADER = 'x-bf-eh-' + NATIVE_RESPONSES_HEADER;

export function normalizeGatewayTransport(value) {
  // Match the Windows launcher's explicit SSH opt-in. Other values use the
  // supplied URL through existing OS routes, including VPN/TUN interfaces.
  return /^\s*(?:"ssh"|'ssh'|ssh)\s*(?:#.*)?$/i.test(String(value ?? '')) ? 'ssh' : 'direct';
}

export function gatewayDispatcherFor(base, transport, tunnelPort = 18003) {
  if (normalizeGatewayTransport(transport) !== 'ssh') return new Agent();
  const hostname = new URL(base).hostname.replace(/^\[|\]$/g, '');
  const connect = buildConnector({ servername: isIP(hostname) ? undefined : hostname,
    checkServerIdentity: (_host, certificate) => checkServerIdentity(hostname, certificate) });
  // Connector factory options do not override the per-request destination.
  // Redirect the socket to the tunnel, keeping the original TLS identity/Host.
  return new Agent({ connect: (options, callback) => connect({ ...options, hostname: '127.0.0.1', port: tunnelPort }, callback) });
}

export function gatewayResponseHeaders(headers, native) {
  const result = { ...headers };
  delete result[FORWARDED_NATIVE_RESPONSES_HEADER];
  if (!native) delete result[NATIVE_RESPONSES_HEADER];
  // Bifrost forwards explicit x-bf-eh-* headers to its provider. Losing the
  // client's native protocol marker makes CLIProxyAPI inject a hosted image
  // tool instead of leaving generation to the client's existing image_gen.
  // Copy only a marker the client actually supplied; never invent one.
  else if (result[NATIVE_RESPONSES_HEADER] !== undefined)
    result[FORWARDED_NATIVE_RESPONSES_HEADER] = result[NATIVE_RESPONSES_HEADER];
  return result;
}
const codecs = {
  gzip: [zlib.gunzip, zlib.gzip], deflate: [zlib.inflate, zlib.deflate],
  br: [zlib.brotliDecompress, zlib.brotliCompress], zstd: [zlib.zstdDecompress, zlib.zstdCompress],
};
const encodingOf = value => String(value || '').trim().toLowerCase();
const tooLarge = () => Object.assign(new Error('Request exceeds the local transport size limit.'), { status: 413, code: 'request_too_large' });

export function officialDispatcherFor(proxy, timeout = CONNECT_TIMEOUT_MS) {
  // ProxyAgent has separate connectors for the proxy and the destination TLS.
  return proxy ? new ProxyAgent({ uri: proxy, proxyTls: { timeout }, requestTls: { timeout } }) : new Agent({ connect: { timeout } });
}

export async function readEncodedBody(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) throw tooLarge();
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks), encoding = encodingOf(req.headers['content-encoding']);
  if (!encoding || encoding === 'identity' || !raw.length) return { raw, decoded: raw, encoding };
  const codec = codecs[encoding]?.[0];
  if (!codec) throw Object.assign(new Error('Unsupported request content encoding.'), { status: 415, code: 'unsupported_content_encoding' });
  try {
    const decoded = await promisify(codec)(raw, { maxOutputLength: MAX_REQUEST_BYTES });
    return { raw, decoded, encoding };
  } catch (error) {
    if (error.code === 'ERR_BUFFER_TOO_LARGE') throw tooLarge();
    throw Object.assign(new Error('Invalid compressed request body.'), { status: 400, code: 'invalid_compressed_request' });
  }
}

export async function outgoingBody(incoming, payload, changed, official) {
  const compressed = incoming.encoding && incoming.encoding !== 'identity';
  if (official && !changed && compressed) return { body: incoming.raw, encoding: incoming.encoding };
  const body = changed ? Buffer.from(JSON.stringify(payload)) : incoming.decoded;
  if (body.length > MAX_REQUEST_BYTES) throw tooLarge();
  // Gateway compression support is not implied by a native client's encoding.
  if (!official) return { body, encoding: '' };
  const encoding = compressed ? incoming.encoding : 'zstd';
  const encoder = codecs[encoding]?.[1];
  if (!encoder) return { body, encoding: '' }; // Older external Node runtimes.
  const encoded = await promisify(encoder)(body);
  if (encoded.length > MAX_REQUEST_BYTES) throw tooLarge();
  if (!compressed && encoded.length >= body.length) return { body, encoding: '' };
  return { body: encoded, encoding };
}

export function protocolError(error) {
  // Upstream error objects belong to that service; preserve their type, code,
  // message and parameter instead of presenting them as a local server error.
  if (error.upstreamError) return { type: 'error', status: error.status || 502, error: error.upstreamError };
  const timeoutCodes = { UND_ERR_CONNECT_TIMEOUT: 'upstream_connect_timeout', UND_ERR_HEADERS_TIMEOUT: 'upstream_headers_timeout', UND_ERR_BODY_TIMEOUT: 'upstream_body_timeout' };
  const cancelled = error.name === 'AbortError' || error.code === 'ABORT_ERR';
  const code = timeoutCodes[error.code] || (cancelled ? 'request_cancelled' : typeof error.code === 'string' ? error.code : 'upstream_error');
  const status = error.status || (timeoutCodes[error.code] ? 504 : cancelled ? 499 : 502);
  const type = status === 401 ? 'authentication_error' : status === 403 ? 'permission_error' : status === 429 ? 'rate_limit_error' : status < 500 ? 'invalid_request_error' : 'server_error';
  return { type: 'error', status, error: { type, code, message: error.message } };
}

export function requestWithAbort(url, options) {
  const signal = options.signal;
  if (!signal) return request(url, options);
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    let cancelled = false;
    const abort = () => { cancelled = true; reject(signal.reason || new Error('Request aborted')); };
    signal.addEventListener('abort', abort, { once: true });
    request(url, options).then(response => {
      signal.removeEventListener('abort', abort);
      // A connector can finish after cancellation. Never forward its late reply.
      if (cancelled) releaseResponseBody(response.body);
      else resolve(response);
    }, error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}

export function releaseResponseBody(body) {
  if (!body || body.destroyed || body.readableEnded) return;
  // An unread Undici body emits an abort error when deliberately destroyed.
  body.on('error', () => {});
  body.destroy();
}

export async function writeChunk(res, chunk) {
  if (res.destroyed) throw Object.assign(new Error('Client disconnected'), { code: 'ABORT_ERR' });
  if (res.write(chunk)) return;
  await new Promise((resolve, reject) => {
    const cleanup = () => { res.off('drain', drain); res.off('close', close); res.off('error', error); };
    const drain = () => { cleanup(); resolve(); };
    const error = value => { cleanup(); reject(value); };
    const close = () => error(Object.assign(new Error('Client disconnected'), { code: 'ABORT_ERR' }));
    res.once('drain', drain); res.once('close', close); res.once('error', error);
    if (res.destroyed) close();
  });
}

export function relayClose(client, code, reason) {
  if (client.readyState > 1) return;
  if ((code >= 1000 && code <= 1014 && ![1004, 1005, 1006].includes(code)) || (code >= 3000 && code <= 4999)) client.close(code, reason);
  else client.terminate(); // Reserved/no-frame close codes cannot be put on the wire.
}
