// Execute the Mac provider's shared POSIX process/config/router logic in a
// temporary home, using the host Node. This is not a Mac GUI or Mach-O test.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { context, atomic, configure, ensureRouter, stopRouter, restoreConfig, health } from '../macos/provider.mjs';
import { processIdentity, alive, launcherText } from '../macos/platform.mjs';

assert(['linux', 'darwin'].includes(process.platform), 'Run on a POSIX host (macOS or WSL/Linux).');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-macos-provider-test-'));
const saved = Object.fromEntries(['CODEX_HOME','CHATGPT_API_BASE_URL','CHATGPT_API_KEY','CHATGPT_API_PORT'].map(name => [name, process.env[name]]));
const key = 'inert-macos-provider-key=$literal', requests = [];
let models = ['Vendor/model', 'GPT/model'], ctx;
const server = http.createServer(async (req, res) => {
  try {
    assert.equal(req.headers.authorization, 'Bearer ' + key);
    assert.equal(req.headers['chatgpt-account-id'], undefined);
    res.setHeader('content-type', 'application/json');
    if (req.url === '/v1/models') { res.end(JSON.stringify({ data: models.map(id => ({ id })) })); return; }
    assert.equal(req.url, '/v1/responses');
    let text = ''; for await (const chunk of req) text += chunk;
    const body = JSON.parse(text); requests.push(body);
    res.end(JSON.stringify({ id: 'resp_mac_fixture', object: 'response', status: 'completed', model: body.model, service_tier: body.service_tier,
      output: [{ type: 'function_call', id: 'fc_fixture', call_id: 'fixture', name: body.tools[0].name, arguments: JSON.stringify({ input: 'text("fixture");' }) }] }));
  } catch (error) { res.writeHead(500); res.end(JSON.stringify({ error: error.message })); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const reserve = http.createServer(); await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
try {
  const installed = path.join(fixture, "installed ' $quote [x] 空格");
  for (const directory of ['src', 'macos', 'assets', 'node_modules']) fs.cpSync(path.join(root, directory), path.join(installed, directory), { recursive: true });
  process.env.CODEX_HOME = path.join(fixture, 'native-home');
  process.env.CHATGPT_API_BASE_URL = 'http://127.0.0.1:' + server.address().port;
  process.env.CHATGPT_API_KEY = key; process.env.CHATGPT_API_PORT = String(port);
  ctx = { ...context(installed), node: process.execPath };
  const baseline = 'model = "old-official"\n[app]\nlocaleOverride = "zh-CN"\n';
  atomic(ctx.config, baseline); atomic(path.join(ctx.home, 'auth.json'), '{"tokens":{"access_token":"inert-official-must-not-be-used"}}\n');
  atomic(path.join(ctx.home, 'models_cache.json'), { models: [{ slug: 'must-not-appear' }] });
  const authBefore = fs.readFileSync(path.join(ctx.home, 'auth.json'), 'utf8');
  await configure(ctx);
  assert.equal(fs.readFileSync(path.join(ctx.home, 'auth.json'), 'utf8'), authBefore);
  assert.equal(fs.statSync(path.join(ctx.data, '.env')).mode & 0o777, 0o600);
  assert(fs.readFileSync(ctx.config, 'utf8').includes('requires_openai_auth = false'));
  const initial = JSON.parse(fs.readFileSync(path.join(ctx.data, 'state/router.json')));
  await Promise.all([ensureRouter(ctx), ensureRouter(ctx), ensureRouter(ctx)]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(ctx.data, 'state/router.json'))).pid, initial.pid);
  const ready = await health(ctx); assert.equal(ready.entryMode, 'apionly'); assert.equal(ready.officialModels, 0);
  const menu = await (await fetch('http://127.0.0.1:' + port + '/v1/models')).json();
  assert.deepEqual(new Set(menu.data.map(model => model.id)), new Set(models));
  const response = await fetch('http://127.0.0.1:' + port + '/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'Vendor/model', input: 'tool probe', service_tier: 'priority', tools: [{ type: 'custom', name: 'exec', format: { type: 'text' } }] }) });
  assert.equal(response.status, 200); const body = await response.json();
  assert.equal(body.output[0].type, 'custom_tool_call'); assert.equal(body.output[0].input, 'text("fixture");');
  assert.equal(requests[0].service_tier, 'priority');
  models.push('Vendor/new-model'); await ensureRouter(ctx, true);
  assert(JSON.parse(fs.readFileSync(path.join(ctx.data, 'cache/models-gateway.json'))).models.some(model => model.slug === 'Vendor/new-model'));

  const shellRoot = path.join(fixture, "shell ' $variable [x] 空格"), shellContext = { root: shellRoot, home: path.join(fixture, "home ' $variable"), node: process.execPath };
  atomic(path.join(shellRoot, 'macos/provider.mjs'), 'process.stdout.write(JSON.stringify({args:process.argv.slice(2),home:process.env.CODEX_HOME}));\n');
  const command = path.join(shellRoot, 'chatgpt-apionly.command'); atomic(command, launcherText(shellContext), 0o755);
  const result = await promisify(execFile)('/bin/sh', [command, 'status $literal', "'literal"], { encoding: 'utf8' });
  assert.deepEqual(JSON.parse(result.stdout), { args: ['status $literal', "'literal"], home: shellContext.home });

  atomic(path.join(ctx.data, 'state/router.json'), { ...processIdentity(process.pid), start: 'different-start-time' });
  await stopRouter(ctx); assert(alive(initial), 'Stale identity stopped an unrelated process or the live router');
  atomic(path.join(ctx.data, 'state/router.json'), initial);
  await stopRouter(ctx); assert.equal(await health(ctx), null);
  await ensureRouter(ctx); assert.notEqual(JSON.parse(fs.readFileSync(path.join(ctx.data, 'state/router.json'))).pid, initial.pid);
  await stopRouter(ctx);
  atomic(ctx.config, fs.readFileSync(ctx.config, 'utf8').replace('zh-CN', 'en-US'));
  restoreConfig(ctx); assert.equal(fs.readFileSync(ctx.config, 'utf8').trimEnd(), baseline.replace('zh-CN', 'en-US').trimEnd());
  assert.equal(fs.readFileSync(path.join(ctx.home, 'auth.json'), 'utf8'), authBefore);
  const report = { passed: true, hostPlatform: process.platform, checks: ['pure API route with residual official login', 'actual HTTP tool conversion and Fast tier forwarding', 'concurrent helper/router reuse and model refresh', 'desktop shell quoting and selected CODEX_HOME', 'PID identity guard, stop/restart and preference restoration'],
    scope: 'Real POSIX process and HTTP execution with host Node and isolated upstreams; packaged Darwin Node, macOS LaunchServices and official GUI are not exercised.' };
  fs.mkdirSync(path.join(root, 'data/diagnostics'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data/diagnostics/macos-provider-result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (ctx) { try { await stopRouter(ctx); } catch {} }
  for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  server.close(); server.closeAllConnections?.();
  assert(fixture.startsWith(path.join(os.tmpdir(), 'chatgpt-macos-provider-test-')));
  fs.rmSync(fixture, { recursive: true, force: true });
}
