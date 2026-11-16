// Real router, mock loopback search upstreams, isolated credentials and home.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { encodeSse } from '../src/sse.mjs';
import { readRequestJson } from './http-fixture.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const model = 'relay/gpt-test';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const message = { id: 'msg_mock', type: 'message', role: 'assistant', status: 'completed',
  content: [{ type: 'output_text', text: 'Retrieved mock evidence.', annotations: [{ type: 'url_citation', url: 'https://example.com/doc', title: 'Mock document' }] }] };
const search = { id: 'ws_mock', type: 'web_search_call', status: 'completed', action: { type: 'search', sources: [{ url: 'https://example.com/doc' }] } };

for (const mode of ['apionly', 'api']) test('native search router scope and credentials: ' + mode, { timeout: 25000 }, async t => {
  fs.mkdirSync(path.join(root, 'data/testing'), { recursive: true });
  const fixture = fs.mkdtempSync(path.join(root, 'data/testing/native-search-'));
  const home = path.join(fixture, 'home'), records = [], sockets = new Set();
  const officialModel = { ...JSON.parse(fs.readFileSync(path.join(root, 'assets/model-template.json'))).models[0], slug: 'gpt-native' };
  let child, stderr = '', officialRequests = 0, slowClosed = false;
  const upstream = http.createServer(async (req, res) => {
    try {
      if (req.url.startsWith('/official')) officialRequests++;
      if (req.url.includes('/models')) {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ data: [{ id: model }], models: [officialModel] })); return;
      }
      const body = await readRequestJson(req);
      records.push({ url: req.url, headers: req.headers, body });
      if (req.url === '/official/alpha/search') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ encrypted_output: 'opaque-fixture', output: 'Native official search.', results: [] })); return;
      }
      if (req.url.includes('/alpha/search')) { res.writeHead(405); res.end('Method Not Allowed'); return; }
      const commandText = body.input?.at?.(-1)?.content || '';
      if (commandText.includes('auth-fixture')) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'authentication_error', code: 'fixture_unauthorized', message: 'Fixture unauthorized' } })); return;
      }
      const output = body.tools?.some(tool => tool.type === 'web_search') && !commandText.includes('no-call-fixture') ? [search, message] : [message];
      const response = { id: 'resp_mock', model: body.model, status: 'completed', output };
      if (!body.stream) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(response)); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(encodeSse({ type: 'response.created', response: { ...response, output: [], status: 'in_progress' } }));
      if (commandText.includes('slow-fixture')) { res.on('close', () => { slowClosed = true; }); return; }
      for (const [output_index, item] of output.entries()) res.write(encodeSse({ type: 'response.output_item.done', item, output_index }));
      res.end(encodeSse({ type: 'response.completed', response }));
    } catch (error) { res.writeHead(500); res.end(error.message); }
  });
  upstream.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  t.after(async () => {
    if (child && child.exitCode === null) { child.kill(); await once(child, 'exit'); }
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => upstream.close(resolve));
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const reserve = http.createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
  const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
  const base = 'http://127.0.0.1:' + port, apiBase = 'http://127.0.0.1:' + upstream.address().port + '/v1';
  for (const directory of ['assets', 'data/state', 'home']) fs.mkdirSync(path.join(fixture, directory), { recursive: true });
  for (const name of ['model-template.json', 'model-contexts.json', 'reasoning-levels.json']) fs.copyFileSync(path.join(root, 'assets', name), path.join(fixture, 'assets', name));
  fs.writeFileSync(path.join(fixture, 'data/.env'), ['BASE_URL=' + apiBase, 'API_KEY=fixture-api-key', 'SHIM_PORT=' + port,
    'OFFICIAL_BASE=http://127.0.0.1:' + upstream.address().port + '/official'].join('\n'));
  fs.writeFileSync(path.join(fixture, 'data/state/route-state.json'), JSON.stringify({
    entryMode: mode, mode: mode === 'apionly' ? 'gateway' : 'mixed', nativeAccount: mode === 'api', clientVersion: '0.167.0',
  }));
  fs.writeFileSync(path.join(fixture, 'data/providers.json'), JSON.stringify({ version: 1, providers: [
    { id: 'default', name: 'Fixture default', enabled: true, baseUrl: apiBase, apiKey: 'fixture-api-key' },
    { id: 'p_search0001', name: 'Fixture secondary', enabled: true, baseUrl: apiBase, apiKey: 'fixture-secondary-key' },
  ] }));
  // APIonly must ignore even an existing ChatGPT login.
  fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'fixture-official-token' } }));
  fs.writeFileSync(path.join(home, 'models_cache.json'), JSON.stringify({ models: [officialModel] }));
  child = spawn(process.execPath, [path.join(root, 'src/shim.mjs')], {
    env: { ...process.env, CHATGPT_API_ROOT: fixture, CODEX_HOME: home, CHATGPT_SHIM_PORT: String(port) },
    windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr.on('data', data => stderr += data);
  let ready = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    if (child.exitCode !== null) throw new Error('Fixture router exited: ' + stderr);
    try { if ((await fetch(base + '/readyz')).ok) { ready = true; break; } } catch {}
    await sleep(25);
  }
  assert(ready, 'Fixture router did not become ready: ' + stderr);
  const request = { id: 'fixture-session', model, input: [{ role: 'user', content: 'Private recent chat, not search instructions.' }],
    commands: { search_query: [{ q: 'fixture search', domains: ['example.com'] }], response_length: 'short' },
    settings: { external_web_access: true }, max_output_tokens: 2000 };
  async function post(payload, suffix = '/v1/alpha/search', signal) {
    return fetch(base + suffix, { method: 'POST', headers: { 'content-type': 'application/json',
      authorization: 'Bearer client-account-token-must-not-leak', 'chatgpt-account-id': 'private-account',
      'x-codex-turn-state': 'private-turn-state', 'x-openai-internal-codex-responses-lite': 'true' },
    body: JSON.stringify(payload), signal: signal || AbortSignal.timeout(5000) });
  }
  let before = records.length;
  const first = await post(request); assert.equal(first.status, 200);
  const result = await first.json();
  assert.equal(typeof result.output, 'string'); assert.equal(result.encrypted_output, null);
  assert.equal(result.results[0].url, 'https://example.com/doc');
  assert.equal(records.length, before + 1);
  const forwarded = records.at(-1);
  assert.equal(forwarded.url, '/v1/responses');
  assert.equal(forwarded.headers.authorization, 'Bearer fixture-api-key');
  assert.equal(forwarded.headers['chatgpt-account-id'], undefined);
  assert.equal(forwarded.headers['x-codex-turn-state'], undefined);
  assert.equal(forwarded.headers['x-openai-internal-codex-responses-lite'], undefined);
  assert.deepEqual(forwarded.body.tool_choice, { type: 'web_search' });
  assert.equal(forwarded.body.max_output_tokens, 2000);
  assert(!JSON.stringify(forwarded.body).includes('Private recent chat'));
  const ref = result.results[0].ref_id;
  for (const command of [{ open: [{ ref_id: ref, lineno: 3 }] }, { find: [{ ref_id: ref, pattern: 'fixture' }] }]) {
    const reply = await post({ ...request, commands: command }, '/alpha/search');
    assert.equal(reply.status, 200); await reply.json();
    assert(JSON.stringify(records.at(-1).body).includes('https://example.com/doc'));
  }
  before = records.length;
  for (const changes of [{ id: 'unrelated-session', commands: { open: [{ ref_id: ref }] } },
    { model: '@p_search0001/' + model, commands: { open: [{ ref_id: ref }] } },
    { commands: { screenshot: [{ ref_id: 'https://example.com/doc', pageno: 0 }] } }]) {
    const reply = await post({ ...request, ...changes }); assert.equal(reply.status, 400); await reply.json();
  }
  assert.equal(records.length, before);
  const secondary = await post({ ...request, model: '@p_search0001/' + model });
  assert.equal(secondary.status, 200); await secondary.json();
  assert.equal(records.at(-1).headers.authorization, 'Bearer fixture-secondary-key');
  assert.equal(records.at(-1).body.model, model);
  const unauthorized = await post({ ...request, commands: { search_query: [{ q: 'auth-fixture' }] } });
  assert.equal(unauthorized.status, 401); assert.equal((await unauthorized.json()).error.code, 'fixture_unauthorized');
  const falseSuccess = await post({ ...request, commands: { search_query: [{ q: 'no-call-fixture' }] } });
  assert.equal(falseSuccess.status, 502); assert.equal((await falseSuccess.json()).error.code, 'search_not_executed');
  const wrongMethod = await fetch(base + '/v1/alpha/search'); assert.equal(wrongMethod.status, 405);

  before = records.length;
  const chat = await post({ model, input: 'Ordinary chat.', stream: false }, '/v1/responses');
  assert.equal(chat.status, 200); await chat.json(); assert.equal(records.length, before + 1);
  assert.equal(records.at(-1).body.tools, undefined);
  if (mode === 'api') {
    const native = await post({ ...request, model: 'gpt-native' });
    assert.equal(native.status, 200);
    assert.deepEqual(await native.json(), { encrypted_output: 'opaque-fixture', output: 'Native official search.', results: [] });
    assert.equal(records.at(-1).url, '/official/alpha/search');
    // Refreshed incoming account identity wins on official requests only.
    assert.equal(records.at(-1).headers.authorization, 'Bearer client-account-token-must-not-leak');
  } else assert.equal(officialRequests, 0);

  const controller = new AbortController();
  const waiting = post({ ...request, commands: { search_query: [{ q: 'slow-fixture' }] } }, '/v1/alpha/search', controller.signal)
    .then(() => ({ error: null }), error => ({ error }));
  for (let attempt = 0; attempt < 100 && !records.some(record => JSON.stringify(record.body).includes('slow-fixture')); attempt++) await sleep(10);
  assert(records.some(record => JSON.stringify(record.body).includes('slow-fixture')));
  controller.abort(); assert((await waiting).error);
  for (let attempt = 0; attempt < 100 && !slowClosed; attempt++) await sleep(10);
  assert(slowClosed, 'Cancellation must close the accepted search upstream');
  assert.equal((await fetch(base + '/healthz')).status, 200);
});
