// Mock official endpoints accept the same request encodings as the native service.
import zlib from 'node:zlib';
export async function readRequestJson(req) {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks);
  const decode = { gzip: zlib.gunzipSync, deflate: zlib.inflateSync, br: zlib.brotliDecompressSync, zstd: zlib.zstdDecompressSync }[req.headers['content-encoding']];
  return JSON.parse(decode ? decode(raw) : raw);
}
