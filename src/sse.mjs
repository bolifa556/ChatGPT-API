import zlib from 'node:zlib';
import { MAX_EVENT_BYTES } from './non-gpt-compat.mjs';

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
  let parts = [], bytes = 0, carriage = '', newline = '';
  function packet(raw) {
    const data = raw.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    return data && data !== '[DONE]' ? { raw, data: JSON.parse(data) } : { raw, done: data === '[DONE]' };
  }
  function append(text) {
    bytes += Buffer.byteLength(text);
    if (bytes > maxEventBytes) throw new Error('Upstream event exceeds limit');
    if (text) parts.push(text);
  }
  function* consume(text, final = false) {
    text = carriage + text; carriage = '';
    if (!final && text.endsWith('\r')) { carriage = '\r'; text = text.slice(0, -1); }
    text = newline + text.replace(/\r\n/g, '\n'); newline = '';
    let start = 0, at;
    while ((at = text.indexOf('\n\n', start)) >= 0) {
      append(text.slice(start, at));
      const raw = parts.join(''); parts = []; bytes = 0;
      yield packet(raw); start = at + 2;
    }
    let tail = text.slice(start);
    if (!final && tail.endsWith('\n')) { newline = '\n'; tail = tail.slice(0, -1); }
    append(tail);
  }
  for await (const chunk of stream) {
    // Keep large base64 events in chunks; repeatedly scanning/copying the whole
    // growing event makes a valid image take quadratic time to parse.
    yield* consume(decoder.decode(chunk, { stream: true }));
  }
  yield* consume(decoder.decode(), true);
  const raw = parts.join('');
  if (raw.trim()) yield packet(raw);
}
export const encodeSse = event => 'event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n';
