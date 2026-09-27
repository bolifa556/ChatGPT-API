import zlib from 'node:zlib';
import { MAX_EVENT_BYTES } from './non-gpt-compat.mjs';

export function decodedStream(body, encoding = '') {
  const decoders = { gzip: zlib.createGunzip, deflate: zlib.createInflate, br: zlib.createBrotliDecompress, zstd: zlib.createZstdDecompress };
  if (!encoding || encoding === 'identity') return body;
  if (!decoders[encoding]) throw new Error('Unsupported upstream compression');
  const decoder = decoders[encoding]();
  body.on('error', error => decoder.destroy(error));
  return body.pipe(decoder);
}
export async function* ssePackets(stream) {
  const decoder = new TextDecoder(); let buffer = '';
  function packet(raw) {
    const data = raw.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    return data && data !== '[DONE]' ? { raw, data: JSON.parse(data) } : { raw, done: data === '[DONE]' };
  }
  for await (const chunk of stream) {
    buffer = (buffer + decoder.decode(chunk, { stream: true })).replace(/\r\n/g, '\n');
    let at;
    while ((at = buffer.indexOf('\n\n')) >= 0) {
      const raw = buffer.slice(0, at); buffer = buffer.slice(at + 2);
      if (Buffer.byteLength(raw) > MAX_EVENT_BYTES) throw new Error('Upstream event exceeds limit');
      yield packet(raw);
    }
    if (Buffer.byteLength(buffer) > MAX_EVENT_BYTES) throw new Error('Upstream event exceeds limit');
  }
  buffer += decoder.decode();
  if (buffer.trim()) yield packet(buffer.replace(/\r\n/g, '\n'));
}
export const encodeSse = event => 'event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n';
