// Actual POSIX processes, production Mac launcher/router and isolated upstreams.
// The desktop and native-account process below are fixtures, not a Mac GUI.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import WebSocket, { WebSocketServer } from 'ws';
import { readRequestJson } from './http-fixture.mjs';
import { context, atomic, launchEntry, stopRouter, health, setRoot } from '../macos/provider.mjs';
import { shellQuote, startNativeClient } from '../macos/platform.mjs';

assert(['linux', 'darwin'].includes(process.platform));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'chatgpt-macos-entries-'));
const savedCli = process.env.CHATGPT_API_CLI;
delete process.env.CHATGPT_API_CLI;
const records = [], servers = [], sockets = [], checks = [];
const key = 'inert-gateway-key=$literal', oauth = 'inert-native-refreshed-token';
const official = { ...JSON.parse(fs.readFileSync(path.join(root, 'assets/model-template.json'))).models[0], slug: 'gpt-6-sol' };
let serial = 0, ctx;
const reply = (body, which) => ({ id: 'resp_' + ++serial, object: 'response', model: body.model, status: 'completed', service_tier: body.service_tier,
  output: body.tools?.length ? [{ type: which === 'official' ? 'custom_tool_call' : 'function_call', name: body.tools[0].function?.name || body.tools[0].name, id: 'tool_' + serial,
    call_id: 'call_' + serial, ...(which === 'official' ? { input: 'text("fixture");' } : { arguments: JSON.stringify({ input: 'text("fixture");' }) }) }]
    : [{ type: 'message', id: 'msg_' + serial, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'fixture result', annotations: [] }] }] });
async function listen(which) {
  const server = http.createServer(async (req, res) => {
    const record = { which, path: req.url, headers: req.headers }; records.push(record);
    try {
      if (which === 'gateway') { assert.equal(req.headers.authorization, 'Bearer ' + key); assert.equal(req.headers['chatgpt-account-id'], undefined); }
      res.setHeader('content-type', 'application/json');
      if (req.url.includes('/models')) { res.end(JSON.stringify(which === 'official' ? { models: [official] } : { data: [{ id: 'Vendor/model' }, { id: 'GPT/gpt-6.1-sol' }] })); return; }
      const body = record.body = await readRequestJson(req);
      if (req.url.endsWith('/compact')) { res.end(JSON.stringify({ object: 'response.compaction', output: [{ type: 'compaction', id: 'cmp_fixture', encrypted_content: 'opaque-official-compaction' }] })); return; }
      const output = reply(body, which);
      if (body.stream) { res.setHeader('content-type', 'text/event-stream'); res.end('data: ' + JSON.stringify({ type: 'response.completed', response: output }) + '\n\n'); }
      else res.end(JSON.stringify(output));
    } catch (error) { res.statusCode = 500; res.end(JSON.stringify({ error: error.message })); }
  });
  const wss = new WebSocketServer({ noServer: true }); sockets.push(wss);
  server.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, ws => {
    ws.on('error', () => {});
    ws.on('message', raw => {
      const body = JSON.parse(raw); records.push({ which, path: req.url, headers: req.headers, body });
      ws.send(JSON.stringify({ type: 'response.completed', response: reply(body, which) }));
    });
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); servers.push(server);
  return 'http://127.0.0.1:' + server.address().port;
}
function wsRequest(base, model) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(base.replace('http:', 'ws:') + '/v1/responses', { headers: { authorization: 'Bearer ' + oauth, 'chatgpt-account-id': 'fixture-account' } });
    const timer = setTimeout(() => { ws.terminate(); reject(new Error('WebSocket timeout')); }, 5000);
    ws.on('error', reject); ws.on('open', () => ws.send(JSON.stringify({ type: 'response.create', model, input: [{ role: 'user', content: 'fixture context' }] })));
    ws.on('message', data => { const event = JSON.parse(data); if (['response.completed', 'error'].includes(event.type)) { clearTimeout(timer); ws.close(); resolve(event); } });
  });
}
try {
  const gateway = await listen('gateway'), upstream = await listen('official');
  const reserved = http.createServer(); await new Promise(resolve => reserved.listen(0, '127.0.0.1', resolve));
  const port = reserved.address().port; await new Promise(resolve => reserved.close(resolve));
  const installed = path.join(temporary, "installed ' $literal 空格");
  for (const directory of ['src', 'macos', 'assets', 'node_modules']) fs.cpSync(path.join(root, directory), path.join(installed, directory), { recursive: true });
  ctx = { ...context(installed), home: path.join(temporary, 'native-home'), config: path.join(temporary, 'native-home/config.toml'), node: process.execPath };
  const bundle = path.join(temporary, "ChatGPT fixture ' 空格.app");
  const cliScript = path.join(temporary, 'native-fixture.mjs');
  const cli = path.join(bundle, 'Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex');
  atomic(cliScript, `import fs from 'node:fs'; import path from 'node:path'; import readline from 'node:readline';
if(process.argv.includes('--version')){console.log('codex-cli 0.162.0');process.exit(0);}
const home=process.env.CODEX_HOME;
for await(const line of readline.createInterface({input:process.stdin})){
 const call=JSON.parse(line); fs.appendFileSync(path.join(home,'native-calls.jsonl'),JSON.stringify(call)+'\\n');
 if(call.id===undefined)continue;
 let result={};
 if(call.method==='account/read')result={account:fs.existsSync(path.join(home,'keychain-fixture'))?{type:'chatgpt'}:null,requiresOpenaiAuth:true};
 if(call.method==='thread/list')result={data:[],nextCursor:null};
 process.stdout.write(JSON.stringify({id:call.id,result})+'\\n');
}`);
  atomic(cli, '#!/bin/sh\nexec ' + shellQuote(process.execPath) + ' ' + shellQuote(cliScript) + ' "$@"\n', 0o755);
  const clientScript = path.join(temporary, 'client-fixture.mjs'), client = path.join(bundle, 'Contents/MacOS/ChatGPT');
  atomic(clientScript, "if(process.argv.includes('--once'))process.exit(0);setInterval(()=>{},1000);\n");
  atomic(client, '#!/bin/sh\nexec ' + shellQuote(process.execPath) + ' ' + shellQuote(clientScript) + ' "$@"\n', 0o755);
  const openerScript = path.join(temporary, 'open-fixture.mjs'), opener = path.join(temporary, 'open-fixture');
  atomic(openerScript, `import fs from 'node:fs'; import path from 'node:path'; import assert from 'node:assert/strict'; import {spawn} from 'node:child_process';
const args=process.argv.slice(2), home=process.env.CODEX_HOME;
assert(args.includes('-W')); assert(!args.includes('-n')); assert(!args.includes('-F'));
assert.equal(args[args.indexOf('--env')+1], 'CODEX_HOME='+home);
const bundle=args[args.indexOf('-a')+1];
const native=spawn(path.join(bundle,'Contents/MacOS/ChatGPT'), args.includes('--args')?args.slice(args.indexOf('--args')+1):[], {stdio:'ignore',env:process.env});
process.on('SIGTERM',()=>native.kill());
native.once('spawn',()=>fs.appendFileSync(path.join(home,'open-calls.jsonl'), JSON.stringify({args,home})+'\\n'));
native.once('error',()=>process.exit(1));
native.once('exit',(code)=>process.exit(code||0));
`);
  atomic(opener, '#!/bin/sh\nexec ' + shellQuote(process.execPath) + ' ' + shellQuote(openerScript) + ' "$@"\n', 0o755);
  const launchClient = (file, args, home, options) => startNativeClient(file, args, home, { ...options, platform: 'darwin', opener });
  const baseline = 'model = "gpt-6-sol"\nmodel_reasoning_effort = "low"\n[app]\nlocaleOverride = "zh-CN"\n[model_providers.keep]\nname = "keep"\n';
  atomic(ctx.config, baseline);
  atomic(path.join(ctx.home, 'models_cache.json'), { client_version: '0.162.0', models: [official] });
  const history = path.join(ctx.home, 'sessions/unchanged.jsonl'); atomic(history, '{"original":"history-must-remain-identical"}\n');
  const originalHistory = fs.readFileSync(history, 'utf8');
  const cases = [
    { entry: 'official', login: true, noKey: true, expectedMode: 'mixed' },
    { entry: 'api', login: false, expectedMode: 'gateway' },
    { entry: 'api', login: true, expectedMode: 'mixed' },
    { entry: 'apionly', login: true, expectedMode: 'gateway' },
    { entry: 'api', login: false, keychain: true, expectedMode: 'mixed' },
    { entry: 'official', login: false, noKey: true, expectedMode: 'mixed' },
  ];
  for (const scenario of cases) {
    const authFile = path.join(ctx.home, 'auth.json'), marker = path.join(ctx.home, 'keychain-fixture');
    if (scenario.login) atomic(authFile, { auth_mode: 'chatgpt', tokens: { access_token: 'inert-saved-native', account_id: 'fixture-account' } });
    else if (fs.existsSync(authFile)) fs.unlinkSync(authFile);
    if (scenario.keychain) atomic(marker, 'fixture'); else if (fs.existsSync(marker)) fs.unlinkSync(marker);
    const authBefore = fs.existsSync(authFile) ? fs.readFileSync(authFile, 'utf8') : null;
    atomic(path.join(ctx.data, '.env'), 'SHIM_PORT=' + port + '\nOFFICIAL_BASE=' + upstream + '/codex\n' + (scenario.noKey ? '' : 'BASE_URL=' + gateway + '/v1\nAPI_KEY=' + key + '\n'));
    const before = records.length, configBefore = fs.readFileSync(ctx.config, 'utf8');
    if (scenario.entry === 'api' && scenario.login) {
      await assert.rejects(launchEntry(ctx, scenario.entry, [], { client, officialProxy: '', runningClients: () => [],
        launchClient: async () => { throw new Error('fixture LaunchServices failure'); } }), /fixture LaunchServices failure/);
      assert.equal(await health(ctx), null);
      assert.equal(fs.readFileSync(ctx.config, 'utf8').trimEnd(), configBefore.trimEnd());
      assert(!fs.existsSync(path.join(ctx.data, 'state/config.json')));
    }
    await launchEntry(ctx, scenario.entry, [], { client, launchClient, officialProxy: '', runningClients: () => [], waitForClient: async child => {
      try {
        // spawn() confirms the opener process exists; wait for its fixture to
        // start the app before testing/terminating that application lifetime.
        const openCount = () => { try { return fs.readFileSync(path.join(ctx.home, 'open-calls.jsonl'), 'utf8').trim().split('\n').filter(Boolean).length; } catch { return 0; } };
        for (let attempt = 0; attempt < 100 && openCount() < checks.length + 1 && child.exitCode === null; attempt++) await new Promise(resolve => setTimeout(resolve, 20));
        assert.equal(openCount(), checks.length + 1, 'The opener did not start the isolated application');
        const state = await health(ctx), config = fs.readFileSync(ctx.config, 'utf8');
        assert.equal(state.entryMode, scenario.entry); assert.equal(state.mode, scenario.expectedMode); assert(!config.includes(key));
        assert.equal(state.clientVersion, scenario.expectedMode === 'mixed' ? '0.162.0' : null);
        assert.equal(state.officialModels, scenario.expectedMode === 'mixed' ? 1 : 0);
        assert(config.includes(scenario.entry === 'official' ? 'model_provider = "openai"' : scenario.expectedMode === 'mixed' ? 'model_provider = "chatgpt_api_mixed"' : 'model_provider = "chatgpt_api_launcher"'));
        assert.equal(config.includes('model_catalog_json = '), scenario.entry !== 'official');
        assert.equal(config.includes('requires_openai_auth = true'), scenario.expectedMode === 'mixed');
        await assert.rejects(launchEntry(ctx, scenario.entry === 'official' ? 'api' : 'official', [], { client, cli, runningClients: () => [child.pid] }), /Fully quit/);
        await assert.rejects(launchEntry(ctx, scenario.entry === 'official' ? 'api' : 'official', [], { client, runningClients: () => [] }), /Fully quit/);
        const base = 'http://127.0.0.1:' + port;
        const menu = await (await fetch(base + '/v1/models')).json();
        const ids = menu.data.map(model => model.id);
        assert.equal(ids.includes(official.slug), scenario.expectedMode === 'mixed');
        assert.equal(ids.includes('Vendor/model'), scenario.entry !== 'official');
        const target = scenario.entry === 'official' ? official.slug : 'Vendor/model';
        const input = [{ role: 'user', content: 'original fixture context' }, { type: 'custom_tool_call', call_id: 'history', name: 'exec', input: 'text("history");' }, { type: 'custom_tool_call_output', call_id: 'history', output: 'history result' }];
        const body = { model: target, input, service_tier: 'priority', tools: [{ type: 'custom', name: 'exec', format: { type: 'text' } }], text: { format: { type: 'json_schema', name: 'fixture', strict: true, schema: { type: 'object', properties: {} } } } };
        const headers = { 'content-type': 'application/json', authorization: 'Bearer ' + oauth, 'chatgpt-account-id': 'fixture-account' };
        const response = await fetch(base + '/v1/responses', { method: 'POST', headers, body: JSON.stringify(body) });
        assert.equal(response.status, 200); assert.equal((await response.json()).output[0].type, 'custom_tool_call');
        const forwarded = records.at(-1); assert.equal(forwarded.body.service_tier, 'priority'); assert.deepEqual(forwarded.body.text.format, body.text.format);
        assert.equal(forwarded.body.tools[0].type, scenario.entry === 'official' ? 'custom' : 'function');
        assert(JSON.stringify(forwarded.body).includes('history result'));
        const streamed = await fetch(base + '/v1/responses', { method: 'POST', headers, body: JSON.stringify({ ...body, stream: true }) });
        assert((await streamed.text()).includes('response.completed'));
        assert.equal((await wsRequest(base, target)).type, 'response.completed');
        if (scenario.expectedMode === 'mixed') {
          const compact = await fetch(base + '/v1/responses/compact', { method: 'POST', headers, body: JSON.stringify({ model: official.slug, input: [{ role: 'user', content: 'preserved' }] }) });
          assert.equal(compact.status, 200); assert.equal((await compact.json()).output[0].type, 'compaction');
          assert.equal(records.at(-1).headers.authorization, 'Bearer ' + oauth);
        }
        const unknown = await fetch(base + '/v1/responses', { method: 'POST', headers, body: JSON.stringify({ model: 'unknown/model', input: 'no forward' }) });
        assert.equal(unknown.status, 400);
        atomic(ctx.config, setRoot(fs.readFileSync(ctx.config, 'utf8').replace('zh-CN', 'en-US'), 'model', 'model = ' + JSON.stringify(target) + '\n'));
      } finally {
        const ended = once(child, 'exit'); child.kill(); await ended;
      }
    } });
    assert.equal(await health(ctx), null);
    assert.equal(fs.readFileSync(ctx.config, 'utf8').trimEnd(), configBefore.replace('zh-CN', 'en-US').trimEnd());
    assert.equal(fs.existsSync(authFile) ? fs.readFileSync(authFile, 'utf8') : null, authBefore);
    assert.equal(fs.readFileSync(history, 'utf8'), originalHistory);
    if (scenario.entry === 'official') assert(!records.slice(before).some(record => record.which === 'gateway'));
    if (scenario.expectedMode === 'gateway') assert(!records.slice(before).some(record => record.which === 'official'));
    checks.push({ ...scenario, passed: true });
  }
  const calls = fs.readFileSync(path.join(ctx.home, 'native-calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert(calls.some(call => call.method === 'account/read' && call.params.refreshToken === false));
  assert(!calls.some(call => /turn\/|login|logout|compact/.test(call.method)));
  const opened = fs.readFileSync(path.join(ctx.home, 'open-calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(opened.length, cases.length); assert(opened.every(call => call.home === ctx.home && call.args.includes(bundle)));
  const report = { passed: true, hostPlatform: process.platform, cases: checks,
    checks: ['LaunchServices command executed through a POSIX open fixture, preserving native home and application lifetime', 'LaunchServices failure restores config and stops the router', 'nested CodexCLI.app discovered without a CLI override and official models loaded', 'official entry without gateway credentials', 'signed-in, signed-out and native-account fallback selection', 'actual HTTP, SSE and WebSocket message/tool history conversion', 'structured schema and Fast tier forwarding', 'official compact forwarding and entry isolation', 'exit restoration, language edits and unchanged auth/history', 'switch blocked while another entry is running or its launcher is still active'],
    scope: 'Production Mac launcher/router with real POSIX children and isolated model endpoints; open and native account processes are fixtures. No real Mac LaunchServices, TCC, GUI, Keychain, Gatekeeper or account network exercised.' };
  fs.mkdirSync(path.join(root, 'data/diagnostics'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data/diagnostics/macos-entries-result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (savedCli === undefined) delete process.env.CHATGPT_API_CLI; else process.env.CHATGPT_API_CLI = savedCli;
  if (ctx) { try { await stopRouter(ctx); } catch {} }
  for (const wss of sockets) for (const ws of wss.clients) ws.terminate();
  for (const server of servers) { server.close(); server.closeAllConnections?.(); }
  assert(temporary.startsWith(path.join(fs.realpathSync(os.tmpdir()), 'chatgpt-macos-entries-')));
  fs.rmSync(temporary, { recursive: true, force: true });
}
