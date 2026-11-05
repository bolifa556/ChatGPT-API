import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { GatewaySources } from '../src/gateway-sources.mjs';
import { normalizeGatewayTransport, requestWithAbort } from '../src/transport.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cases = JSON.parse(fs.readFileSync(new URL('./gateway-transport-cases.json', import.meta.url), 'utf8'));
fs.mkdirSync(path.join(root, 'data/testing'), { recursive: true });
const fixture = fs.mkdtempSync(path.join(root, 'data/testing/gateway-transport-'));
const records = [], model = 'GPT/transport-fixture', key = 'fixture-key=#literal';
const peer = http.createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  records.push({ url: req.url, host: req.headers.host, auth: req.headers.authorization, body: Buffer.concat(chunks).toString() });
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(req.url.endsWith('/models') ? { data: [{ id: model }] } : { status: 'completed' }));
});
peer.listen(0, '127.0.0.1'); await once(peer, 'listening');
const port = peer.address().port;
try {
  for (const [value, expected] of cases) {
    assert.equal(normalizeGatewayTransport(value), expected, JSON.stringify(value));
    // For SSH, the original loopback endpoint has no server. The connection
    // must use the already-established local tunnel while preserving Host.
    const base = expected === 'ssh' ? 'http://127.0.0.2:1/nested/v1' : `http://127.0.0.1:${port}/nested/v1`;
    const pool = new GatewaySources(fixture, { BASE_URL: base, API_KEY: key }, { transport: value, tunnelPort: port });
    const before = records.length;
    try {
      await pool.discover();
      assert(pool.models.some(item => item.id === model), 'Model discovery failed for ' + JSON.stringify(value));
      const target = pool.target(model);
      const body = JSON.stringify({ model, input: [{ role: 'user', content: 'Unchanged fixture input' }] });
      const response = await requestWithAbort(target.base + '/responses', { method: 'POST', dispatcher: target.dispatcher,
        headers: { authorization: 'Bearer ' + target.profile.apiKey, 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(3000) });
      assert.equal((await response.body.json()).status, 'completed');
      assert.equal(records.length - before, 2, 'Transport selection must not retry or probe another URL');
      for (const record of records.slice(before)) {
        assert.equal(record.host, new URL(base).host);
        assert.equal(record.auth, 'Bearer ' + key);
      }
      assert.equal(records.at(-1).url, '/nested/v1/responses');
      assert.equal(records.at(-1).body, body);
    } finally { await pool.close(); }
  }
  console.log(JSON.stringify({ passed: true, cases: cases.length, checks: ['URL-based model discovery and requests', 'explicit SSH endpoint redirection', 'Host, path, key and body unchanged', 'no extra attempts'] }));
} finally { peer.closeAllConnections(); await new Promise(resolve => peer.close(resolve)); }

const tls = spawnSync(process.execPath, [path.join(root, 'tests/gateway-tls-test.mjs')], { windowsHide: true,
  env: { ...process.env, NODE_EXTRA_CA_CERTS: path.join(root, 'tests/fixtures/gateway-test-cert.pem') }, encoding: 'utf8', timeout: 15000 });
assert.equal(tls.status, 0, tls.stderr || tls.error?.message);
console.log(tls.stdout.trim());
