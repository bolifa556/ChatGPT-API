import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { encodeSse, ssePackets } from '../src/sse.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-universal-api-'));
const records = [], sockets = new Set(), checks = [];
const models = [
  { id: 'selfhost/chat-only', supported_endpoints: ['/chat/completions'] },
  { id: 'GPT/gpt-chat-only', supported_endpoints: ['/chat/completions'] },
  { id: '词元计划/responses-only', supported_endpoints: ['/responses'] },
  { id: 'GPT/gpt-responses', supported_endpoints: ['/responses'] },
];
const citation = { type: 'url_citation', url_citation: { url: 'https://example.com/source', title: 'Original title', start_index: 0, end_index: 6 } };
let serial = 0, child, stderr = '';
const upstream = http.createServer(async (req, res) => {
  try {
    assert.equal(req.headers.authorization, 'Bearer fixture-key');
    if (req.url === '/custom/v2/models') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: models })); return; }
    assert(['/custom/v2/chat/completions', '/custom/v2/responses'].includes(req.url), 'The explicit API prefix was rewritten');
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks)); records.push({ url: req.url, headers: req.headers, body });
    const id = 'fixture_' + ++serial;
    if (req.url.endsWith('/chat/completions')) {
      const base = { id, model: 'actual-upstream-model', service_tier: body.service_tier };
      const message = { role: 'assistant', content: 'Answer', annotations: [citation] };
      if (!body.stream) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ...base, choices: [{ index: 0, message, finish_reason: 'stop' }] })); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: ' + JSON.stringify({ ...base, choices: [{ index: 0, delta: message, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n'); return;
    }
    const item = { type: 'message', id: 'msg_' + id, role: 'assistant', phase: 'final_answer', status: 'completed', content: [{ type: 'output_text', text: 'Answer', annotations: [] }] };
    const response = { id: 'resp_' + id, object: 'response', model: body.model, status: 'completed', output: [item], original_extension: { marker: 'original-response' } };
    if (!body.stream) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(response)); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end([{ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
      { type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response }].map(encodeSse).join(''));
  } catch (error) { res.writeHead(400); res.end(JSON.stringify({ error: { message: error.message } })); }
});
upstream.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
const reserve = http.createServer(); await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
try {
  for (const name of ['assets', 'home', 'data/state']) fs.mkdirSync(path.join(fixture, name), { recursive: true });
  for (const name of ['model-template.json', 'model-contexts.json', 'reasoning-levels.json']) fs.copyFileSync(path.join(root, 'assets', name), path.join(fixture, 'assets', name));
  fs.writeFileSync(path.join(fixture, 'data/.env'), 'BASE_URL=http://127.0.0.1:' + upstream.address().port + '/custom/v2\nAPI_KEY=fixture-key\nSHIM_PORT=' + port + '\n');
  fs.writeFileSync(path.join(fixture, 'data/state/route-state.json'), JSON.stringify({ mode: 'gateway', entryMode: 'apionly' }));
  child = spawn(process.execPath, [path.join(root, 'src/shim.mjs')], { env: { ...process.env, CHATGPT_API_ROOT: fixture, CODEX_HOME: path.join(fixture, 'home') }, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr.on('data', bytes => stderr += bytes);
  const base = 'http://127.0.0.1:' + port;
  let ready = false;
  for (let attempt = 0; attempt < 200 && !ready; attempt++) {
    if (child.exitCode !== null) throw new Error(stderr);
    try { ready = (await fetch(base + '/readyz')).ok; } catch {}
    if (!ready) await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert(ready, stderr);
  const input = [{ type: 'function_call_output', name: 'lookup', namespace: 'functions', output: 'Original result' }, { role: 'user', content: 'Original input' }];
  const payload = { instructions: 'Original instructions', input, service_tier: 'priority', tools: [{ type: 'namespace', name: 'functions', tools: [{ type: 'function', name: 'lookup', description: 'Original description', parameters: { type: 'object' } }] }], original_extension: { marker: 'original-request' } };
  const original = JSON.stringify(payload);
  for (const { id: model } of models) for (const stream of [false, true]) {
    const reply = await fetch(base + '/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json', 'x-openai-internal-codex-responses-lite': 'true', 'x-codex-turn-state': 'original-state' }, body: JSON.stringify({ ...payload, model, stream }) });
    assert.equal(reply.status, 200, await (reply.status === 200 ? Promise.resolve('') : reply.text()));
    let response;
    if (stream) { for await (const packet of ssePackets(reply.body)) if (packet.data?.type === 'response.completed') response = packet.data.response; }
    else response = await reply.json();
    const sent = records.at(-1), chat = model.includes('chat-only');
    assert.equal(sent.url, '/custom/v2/' + (chat ? 'chat/completions' : 'responses'));
    assert.equal(sent.body.service_tier, 'priority');
    assert(!Object.keys(sent.headers).some(name => name.startsWith('x-bf-eh-')));
    if (chat) {
      assert.equal(sent.body.messages[0].content, payload.instructions);
      assert.equal(sent.body.messages[1].role, 'function'); assert.equal(sent.body.messages[1].content, 'Original result');
      assert.equal(response.model, 'actual-upstream-model');
      assert.equal(response.output[0].content[0].annotations[0].url, citation.url_citation.url);
    } else {
      assert.equal(sent.body.instructions, payload.instructions);
      if (model.startsWith('GPT/')) {
        assert.equal(sent.body.input[0].name, 'lookup'); assert.equal(sent.body.input[0].namespace, 'functions');
      } else assert.equal(sent.body.input[0].name, sent.body.tools[0].name);
      assert.deepEqual(sent.body.original_extension, payload.original_extension);
      assert.equal(response.original_extension.marker, 'original-response');
      assert.equal(response.output[0].phase, 'final_answer');
    }
  }
  checks.push('Strict standard Responses/Chat APIs honor custom paths and declared endpoints over model-name prefixes across JSON and SSE');
  const ws = new WebSocket(base.replace('http:', 'ws:') + '/v1/responses'); await once(ws, 'open');
  try {
    for (const { id: model } of models) {
      const reply = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('WS fixture timed out')), 5000);
        const receive = bytes => { const event = JSON.parse(bytes); if (['response.completed', 'error'].includes(event.type)) { clearTimeout(timer); ws.off('message', receive); resolve(event); } };
        ws.on('message', receive);
      });
      ws.send(JSON.stringify({ type: 'response.create', ...payload, model }));
      assert.equal((await reply).type, 'response.completed');
      assert.equal(records.at(-1).body.service_tier, 'priority');
    }
  } finally { ws.terminate(); }
  assert.equal(JSON.stringify(payload), original);
  assert(records.every(record => !JSON.stringify(record.body).includes('server-hosted image_generation')));
  checks.push('WebSocket shares the same lossless preparation; no hosted-tool injection, invented instructions or extra generation');
  console.log(JSON.stringify({ passed: true, checks }));
} finally {
  if (child && child.exitCode === null) { child.kill(); await once(child, 'exit'); }
  for (const socket of sockets) socket.destroy();
  await new Promise(resolve => upstream.close(resolve));
  fs.rmSync(fixture, { recursive: true, force: true });
}
