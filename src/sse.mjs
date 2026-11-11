import zlib from 'node:zlib';
import { MAX_EVENT_BYTES } from './non-gpt-compat.mjs';

const control = Symbol('SSE control');
export const isSseControl = value => Boolean(value?.[control]);

export function decodedStream(body, encoding = '') {
  const decoders = { gzip: zlib.createGunzip, deflate: zlib.createInflate, br: zlib.createBrotliDecompress, zstd: zlib.createZstdDecompress };
  if (!encoding || encoding === 'identity') return body;
  if (!decoders[encoding]) throw new Error('Unsupported upstream compression');
  const decoder = decoders[encoding]();
  body.on('error', error => decoder.destroy(error));
  // Leaving a completed SSE iterator must also release a compressed upstream.
  decoder.once('close', () => { if (!body.destroyed) body.destroy(); });
  return body.pipe(decoder);
}
export async function* ssePackets(stream, { maxEventBytes = MAX_EVENT_BYTES } = {}) {
  const decoder = new TextDecoder();
  let parts = [], bytes = 0, lines = [], eventBytes = 0, carriage = '';
  function packet() {
    const raw = lines.join('\n'), values = []; let event;
    for (const line of lines) {
      const at = line.indexOf(':'), field = at < 0 ? line : line.slice(0, at);
      const value = at < 0 ? '' : line.slice(at + 1).replace(/^ /, '');
      if (field === 'data') values.push(value);
      else if (field === 'event') event = value;
    }
    lines = []; eventBytes = 0;
    if (!values.length) return { raw: raw + '\n\n', [control]: true };
    const data = values.join('\n');
    return data && data !== '[DONE]' ? { raw, event, data: JSON.parse(data) } : { raw, done: data === '[DONE]' };
  }
  function append(text) {
    bytes += Buffer.byteLength(text);
    if (bytes + eventBytes > maxEventBytes) throw new Error('Upstream event exceeds limit');
    if (text) parts.push(text);
  }
  function* line() {
    const raw = parts.join(''); parts = []; const length = bytes; bytes = 0;
    // Comments need no blank line and do not dispatch an SSE event. Deliver
    // them while an upstream is otherwise idle, without inventing a message.
    if (raw.startsWith(':')) yield { raw: raw + '\n', [control]: true };
    else if (!raw) { if (lines.length) yield packet(); }
    else { lines.push(raw); eventBytes += length; }
  }
  function* consume(text, final = false) {
    text = carriage + text; carriage = '';
    if (!final && text.endsWith('\r')) { carriage = '\r'; text = text.slice(0, -1); }
    text = text.replace(/\r\n|\r/g, '\n');
    let start = 0, at;
    while ((at = text.indexOf('\n', start)) >= 0) {
      append(text.slice(start, at));
      yield* line(); start = at + 1;
    }
    append(text.slice(start));
  }
  for await (const chunk of stream) {
    // Keep large base64 events in chunks; repeatedly scanning/copying the whole
    // growing event makes a valid image take quadratic time to parse.
    yield* consume(decoder.decode(chunk, { stream: true }));
  }
  yield* consume(decoder.decode(), true);
  if (parts.length) yield* line();
  if (lines.length) yield packet();
}
export const encodeSse = event => isSseControl(event) ? event.raw : 'event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n';
