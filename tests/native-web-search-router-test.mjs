// Only loopback fixture APIs are called. No vendor models or real credentials.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { encodeSse } from '../src/sse.mjs';
import { readRequestJson } from './http-fixture.mjs';
import { GatewaySources } from '../src/gateway-sources.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const models = [
  { id: 'relay/gpt-native' }, { id: 'relay/gpt-hosted' },
  { id: 'relay/gpt-chat', supported_endpoints: ['/chat/completions'], supported_parameters: ['web_search_options'] },
];

for (const [mode, login] of [['apionly', false], ['apionly', true], ['api', true]]) test('native search routing, persistent capability and credentials: ' + mode + ', login=' + login,
  { timeout: 20000 }, async t => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-search-router-'));
    const records = [], sockets = new Set();
    let child, stderr = '', slowClosed = false;
    const native = { encrypted_output: 'original-ciphertext', output: 'Native original page.', results: [{ type: 'text_result', ref_id: 'native-ref', url: 'https://example.com/native' }] };
    const officialModel = { ...JSON.parse(fs.readFileSync(path.join(root, 'assets/model-template.json'))).models[0], slug: 'gpt-official-fixture' };
    const upstream = http.createServer(async (req, res) => {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      if (pathname.endsWith('/models')) {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ data: models, models: [officialModel] }));
        return;
      }
      const body = await readRequestJson(req);
      records.push({ url: req.url, body, headers: req.headers });
      res.setHeader('content-type', 'application/json');
      if (pathname === '/official/alpha/search' || pathname.endsWith('/alpha/search') && body.model === models[0].id) {
        res.end(JSON.stringify(native)); return;
      }
      if (pathname.endsWith('/alpha/search')) {
        res.writeHead(405); res.end(JSON.stringify({ error: { code: 'method_not_allowed', message: 'Fixture native endpoint is unavailable.' } })); return;
      }
      const commands = JSON.stringify(body.input || body.messages);
      if (commands.includes('auth-fixture')) {
        res.writeHead(401); res.end(JSON.stringify({ error: { code: 'original_auth_error', message: 'Original fixture authentication error.' } })); return;
      }
      if (pathname.endsWith('/chat/completions')) {
        assert(body.web_search_options);
        assert.equal(body.tools, undefined);
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const chunk = { id: 'chat_search_fixture', model: body.model, citations: ['https://example.com/document'],
          choices: [{ index: 0, delta: { content: 'Original Chat search evidence [1].' }, finish_reason: 'stop' }] };
        res.end('data: ' + JSON.stringify(chunk) + '\n\ndata: [DONE]\n\n'); return;
      }
      const output = [];
      if (body.tools?.some(tool => tool.type === 'web_search')) output.push({ id: 'ws_fixture', type: 'web_search_call', status: 'completed',
        action: { type: 'search', sources: [{ url: 'https://example.com/document', title: 'Original source' }] } });
      output.push({ id: 'msg_fixture', type: 'message', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: 'Original Responses evidence.', annotations: [] }] });
      const value = { id: 'resp_fixture', status: 'completed', model: body.model, output };
      if (!body.stream) { res.end(JSON.stringify(value)); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(encodeSse({ type: 'response.created', response: { ...value, status: 'in_progress', output: [] } }));
      if (commands.includes('slow-fixture')) { res.on('close', () => { slowClosed = true; }); return; }
      res.end(encodeSse({ type: 'response.completed', response: value }));
    });
    upstream.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    async function stop() {
      if (child && child.exitCode === null) { child.kill(); await once(child, 'exit'); }
    }
    t.after(async () => {
      await stop();
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => upstream.close(resolve));
      assert(path.dirname(fixture) === path.resolve(os.tmpdir()) && path.basename(fixture).startsWith('chatgpt-search-router-'));
      fs.rmSync(fixture, { recursive: true, force: true });
    });
    upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
    const reserve = http.createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
    const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
    const base = 'http://127.0.0.1:' + port, apiBase = 'http://127.0.0.1:' + upstream.address().port + '/custom/v2';
    for (const directory of ['assets', 'data/state', 'home']) fs.mkdirSync(path.join(fixture, directory), { recursive: true });
    for (const name of ['model-template.json', 'model-contexts.json', 'reasoning-levels.json']) fs.copyFileSync(path.join(root, 'assets', name), path.join(fixture, 'assets', name));
    fs.writeFileSync(path.join(fixture, 'data/.env'), 'BASE_URL=' + apiBase + '\nAPI_KEY=fixture-key\nSHIM_PORT=' + port
      + '\nOFFICIAL_BASE=http://127.0.0.1:' + upstream.address().port + '/official');
    fs.writeFileSync(path.join(fixture, 'data/providers.json'), JSON.stringify({ version: 1, providers: [
      { id: 'default', name: 'Primary', enabled: true, baseUrl: apiBase, apiKey: 'fixture-key' },
      { id: 'p_search0001', name: 'Secondary', enabled: true, baseUrl: apiBase, apiKey: 'secondary-fixture-key' },
    ] }));
    fs.writeFileSync(path.join(fixture, 'data/state/route-state.json'), JSON.stringify({ entryMode: mode,
      mode: mode === 'apionly' ? 'gateway' : 'mixed', clientVersion: '0.169.0', nativeAccount: true }));
    if (login) fs.writeFileSync(path.join(fixture, 'home/auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'official-fixture-token' } }));
    fs.writeFileSync(path.join(fixture, 'home/models_cache.json'), JSON.stringify({ models: [officialModel] }));
    async function start() {
      child = spawn(process.execPath, [path.join(root, 'src/shim.mjs')], {
        env: { ...process.env, CHATGPT_API_ROOT: fixture, CODEX_HOME: path.join(fixture, 'home'), CHATGPT_SHIM_PORT: String(port) },
        windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
      });
      child.stderr.on('data', chunk => stderr += chunk);
      for (let attempt = 0; attempt < 100; attempt++) {
        if (child.exitCode !== null) throw new Error(stderr);
        try { if ((await fetch(base + '/readyz')).ok) return; } catch {}
        await delay(20);
      }
      throw new Error('Fixture router did not start: ' + stderr);
    }
    const request = { id: 'fixture-session', model: models[1].id,
      commands: { search_query: [{ q: 'fixture query' }] }, input: [{ role: 'user', content: 'Original context.' }] };
    const post = (body, suffix = '/v1/alpha/search', signal) => fetch(base + suffix, { method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer incoming-official-credential', 'chatgpt-account-id': 'private-account', 'x-codex-turn-state': 'private-state' },
      body: JSON.stringify(body), signal: signal || AbortSignal.timeout(4000) });
    await start();
    const initial = await post({ ...request, model: models[0].id, commands: { click: [{ ref_id: 'native-ref', id: 1 }] } });
    assert.deepEqual(await initial.json(), native);
    const before = records.length;
    const search = await post(request);
    assert.equal(search.status, 200); assert.equal((await search.json()).results[0].url, 'https://example.com/document');
    assert.deepEqual(records.slice(before).map(record => record.url), ['/custom/v2/alpha/search', '/custom/v2/responses']);
    assert.equal(records.at(-1).headers.authorization, 'Bearer fixture-key');
    assert.equal(records.at(-1).headers['chatgpt-account-id'], undefined);
    assert.equal(records.at(-1).headers['x-codex-turn-state'], undefined);
    assert.deepEqual(records.at(-1).body.input[0], request.input[0]);
    const chat = await post({ ...request, model: models[2].id });
    assert.equal(chat.status, 200); assert.match((await chat.json()).output, /Original Chat search evidence/);
    assert.equal(records.at(-1).url, '/custom/v2/chat/completions');
    const secondary = await post({ ...request, model: '@p_search0001/' + models[1].id });
    assert.equal(secondary.status, 200); await secondary.json();
    assert.equal(records.at(-1).headers.authorization, 'Bearer secondary-fixture-key');
    assert.equal(records.at(-1).body.model, models[1].id);
    const rejected = await post({ ...request, commands: { search_query: [{ q: 'auth-fixture' }] } });
    assert.equal(rejected.status, 401); assert.equal((await rejected.json()).error.code, 'original_auth_error');
    const ordinary = await post({ model: models[1].id, input: 'Ordinary chat.', stream: false }, '/v1/responses');
    assert.equal(ordinary.status, 200); await ordinary.json(); assert.equal(records.at(-1).body.tools, undefined);
    if (mode === 'api') {
      const official = await post({ ...request, model: officialModel.slug });
      assert.deepEqual(await official.json(), native);
      assert.equal(records.at(-1).url, '/official/alpha/search');
      assert.equal(records.at(-1).headers.authorization, 'Bearer incoming-official-credential');
    }
    await stop(); await start();
    const restartAt = records.length;
    const restored = await post(request);
    assert.equal(restored.status, 200); await restored.json();
    assert.deepEqual(records.slice(restartAt).map(record => record.url), ['/custom/v2/responses']);
    const cached = JSON.parse(fs.readFileSync(path.join(fixture, 'data/cache/gateway-sources.json')));
    assert.deepEqual(cached.sources[0].searchProtocols, {
      [models[0].id]: 'native', [models[1].id]: 'responses', [models[2].id]: 'chat',
    });
    assert(!JSON.stringify(cached).includes('fixture query'));
    const pool = new GatewaySources(fixture, { BASE_URL: apiBase, API_KEY: 'fixture-key' });
    pool.loadCached();
    const target = pool.target(models[1].id);
    assert.equal(pool.searchProtocol(target), 'responses');
    target.profile.apiKey = 'changed-fixture-key';
    assert.equal(pool.searchProtocol(target), null);
    await pool.close();
    const controller = new AbortController();
    const waiting = post({ ...request, commands: { search_query: [{ q: 'slow-fixture' }] } }, '/v1/alpha/search', controller.signal)
      .then(() => null, error => error);
    for (let attempt = 0; attempt < 100 && !records.some(record => JSON.stringify(record.body).includes('slow-fixture')); attempt++) await delay(10);
    controller.abort(); assert(await waiting);
    for (let attempt = 0; attempt < 100 && !slowClosed; attempt++) await delay(10);
    assert(slowClosed);
  });
