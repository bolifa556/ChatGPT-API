// The parent test trusts only our public test certificate in a child process.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import https from 'node:https';
import { once } from 'node:events';
import { gatewayDispatcherFor, requestWithAbort } from '../src/transport.mjs';

const records = [];
const peer = https.createServer({ key: fs.readFileSync(new URL('./fixtures/gateway-test-key.pem', import.meta.url)),
  cert: fs.readFileSync(new URL('./fixtures/gateway-test-cert.pem', import.meta.url)) }, (req, res) => {
  records.push({ host: req.headers.host, servername: req.socket.servername });
  res.end('fixture');
});
peer.listen(0, '127.0.0.1'); await once(peer, 'listening');
const port = peer.address().port;
try {
  for (const hostname of ['gateway-transport.test', '127.0.0.2']) {
    const base = `https://${hostname}:1/v1`, agent = gatewayDispatcherFor(base, 'SSH', port);
    try {
      const response = await requestWithAbort(base + '/models', { dispatcher: agent, signal: AbortSignal.timeout(3000) });
      assert.equal(await response.body.text(), 'fixture');
      assert.equal(records.at(-1).host, hostname + ':1');
      assert.equal(records.at(-1).servername, hostname === '127.0.0.2' ? false : hostname);
    } finally { await agent.close(); }
  }
  const directBase = `https://127.0.0.1:${port}/v1`, direct = gatewayDispatcherFor(directBase, 'vpn');
  try {
    const response = await requestWithAbort(directBase + '/models', { dispatcher: direct, signal: AbortSignal.timeout(3000) });
    assert.equal(await response.body.text(), 'fixture');
  } finally { await direct.close(); }
  const mismatch = 'https://wrong.gateway-transport.test:1/v1', agent = gatewayDispatcherFor(mismatch, 'ssh', port);
  const before = records.length;
  try {
    await assert.rejects(requestWithAbort(mismatch + '/models', { dispatcher: agent, signal: AbortSignal.timeout(3000) }), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
    assert.equal(records.length, before, 'Invalid TLS identity reached the API');
  } finally { await agent.close(); }
  console.log('HTTPS URL routes and SSH tunnel TLS identity verified for DNS/IP; invalid certificates remain rejected');
} finally { peer.closeAllConnections(); await new Promise(resolve => peer.close(resolve)); }
