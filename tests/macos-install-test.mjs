// Exercise the shipped installer and provider under macOS, only in temporary homes.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

assert.equal(process.platform, 'darwin', 'Run this test on an Apple Silicon Mac.');
const run = promisify(execFile), delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const release = path.resolve(process.argv[2]), installer = path.join(release, 'setup/install.mjs');
const fixture = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'chatgpt-macos-install-test-'));
const installed = path.join(fixture, 'installed �ո� [x] $quote " percent%');
const home = path.join(fixture, 'home'), native = path.join(home, '.codex'), desktopData = path.join(home, '.local/share');
fs.mkdirSync(native, { recursive: true });
const key = 'inert-provider-key=$literal';
const authFile = path.join(native, 'auth.json'), configFile = path.join(native, 'config.toml');
const baseline = 'model = "old-official"\nmodel_reasoning_effort = "low"\n# user preference\n[app]\nlocaleOverride = "zh-CN"\n[model_providers.unrelated]\nname = "Keep"\nbase_url = "http://example.invalid/v1"\n';
fs.writeFileSync(configFile, baseline);
fs.writeFileSync(authFile, '{"inert_official_login_must_not_be_used":true}\n');
fs.writeFileSync(path.join(native, 'models_cache.json'), '{"models":[{"slug":"must-not-appear"}]}');
const originalAuth = fs.readFileSync(authFile, 'utf8');
const checks = [], requests = []; let models = ['Vendor/model','GPT/model'], badModels = false;
const server = http.createServer(async (req, res) => {
  try {
    assert.equal(req.headers.authorization, 'Bearer ' + key);
    assert.equal(req.headers['chatgpt-account-id'], undefined);
    if (req.url === '/v1/models') {
      res.writeHead(badModels ? 503 : 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: models.map(id => ({ id })) })); return;
    }
    assert.equal(req.url, '/v1/responses');
    let text = ''; for await (const chunk of req) text += chunk;
    const body = JSON.parse(text); requests.push(body);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ id: 'resp_provider_fixture', object: 'response', status: 'completed', model: body.model,
      output: body.tools?.length ? [{ type: 'function_call', id: 'fc_fixture', call_id: 'fixture', name: body.tools[0].name, arguments: JSON.stringify({ input: 'text("fixture");' }) }]
      : [{ type: 'message', id: 'msg_fixture', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'OK', annotations: [] }] }] }));
  } catch (error) { res.writeHead(500); res.end(JSON.stringify({ error: error.message })); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const reserve = http.createServer(); await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
const env = { ...process.env, HOME: home, CODEX_HOME: native, XDG_DATA_HOME: desktopData, CHATGPT_API_BASE_URL: 'http://127.0.0.1:' + server.address().port, CHATGPT_API_KEY: key, CHATGPT_API_PORT: String(port) };
delete env.CHATGPT_API_ROOT;
const invoke = (args, override = {}) => run(process.execPath, args, { env: { ...env, ...override }, timeout: 45000, maxBuffer: 2 * 1024 * 1024 });
const cli = (command, override = {}) => invoke([path.join(installed, 'macos/provider.mjs'), command], override);
const menu = () => JSON.parse(fs.readFileSync(path.join(installed, 'data/cache/models-gateway.json'))).models;
const record = () => JSON.parse(fs.readFileSync(path.join(installed, 'data/state/router.json')));
let simulatedClient;
try {
  const install = await run(path.join(release, 'install.sh'), [installed], { env, timeout: 45000, maxBuffer: 2 * 1024 * 1024 });
  assert(!install.stdout.includes(key)); assert(!install.stderr.includes(key));
  assert.deepEqual(new Set(menu().map(model => model.slug)), new Set(models));
  assert.equal(fs.readFileSync(authFile, 'utf8'), originalAuth);
  const config = fs.readFileSync(configFile, 'utf8');
  assert(config.includes('requires_openai_auth = false')); assert(config.includes('model_provider = "chatgpt_api_launcher"'));
  assert(config.includes('localeOverride = "zh-CN"')); assert(config.includes('[model_providers.unrelated]'));
  assert(!config.includes('powershell'));
  // Native image requests share the local bridge, even in API-only mode.
  assert(config.includes('openai_base_url = "http://127.0.0.1:' + port + '/v1"'));
  const route = await (await fetch('http://127.0.0.1:' + port + '/healthz')).json();
  assert.equal(route.entryMode, 'apionly'); assert.equal(route.mode, 'gateway'); assert.equal(route.officialModels, 0);
  assert.equal(fs.statSync(path.join(installed, 'data/.env')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(installed, 'data')).mode & 0o777, 0o700);
  assert(fs.statSync(path.join(installed, 'macos/chatgpt-apionly')).mode & 0o100);
  const desktopFile = path.join(home, 'Desktop/chatgpt-apionly.command');
  const desktop = fs.readFileSync(desktopFile, 'utf8');
  assert(desktop.includes(installed)); assert(desktop.includes('CODEX_HOME=' + native)); assert(!desktop.includes(release));
  assert.equal(fs.readdirSync(path.dirname(desktopFile)).length, 1);
  checks.push('Independent installation, macOS permissions and one command entry, provider config and preserved preferences/login');

  const running = record();
  const auths = await Promise.all([cli('auth'), cli('auth'), cli('auth')]);
  for (const auth of auths) { assert.equal(auth.stdout, key + '\n'); assert.equal(auth.stderr, ''); }
  assert.equal(record().pid, running.pid);
  await cli('stop'); await Promise.all([cli('auth'), cli('auth')]); assert.notEqual(record().pid, running.pid);
  checks.push('Concurrent native auth helpers reuse one router and lazily restart it without an official login');

  const response = await fetch('http://127.0.0.1:' + port + '/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key }, body: JSON.stringify({ model: 'Vendor/model', input: 'tool probe', tools: [{ type: 'custom', name: 'exec', format: { type: 'text' } }] }) });
  assert.equal(response.status, 200); const body = await response.json();
  assert.equal(body.output[0].type, 'custom_tool_call'); assert.equal(body.output[0].name, 'exec'); assert.equal(body.output[0].input, 'text("fixture");');
  assert(requests.length > 0);
  checks.push('Packaged provider performs HTTP requests and restores native custom tool calls through the shared adapter');

  models.push('Vendor/qwen-image', 'Vendor/qwen-image-edit');
  fs.appendFileSync(path.join(installed, 'data/.env'), 'IMAGE_MODEL=Vendor/qwen-image\nIMAGE_EDIT_MODEL=Vendor/qwen-image-edit\nIMAGE_EDIT_FORMAT=multipart\n');
  await cli('configure');
  const imageSettings = fs.readFileSync(path.join(installed, 'data/.env'), 'utf8');
  for (const value of ['IMAGE_MODEL=Vendor/qwen-image','IMAGE_EDIT_MODEL=Vendor/qwen-image-edit','IMAGE_EDIT_FORMAT=multipart']) assert(imageSettings.includes(value));
  assert(!menu().some(model => /qwen-image/.test(model.slug)));
  checks.push('Configure preserves image model aliases and edit format; image-only models stay out of the chat menu');

  const clientDir = path.join(fixture, 'mockbin'); fs.mkdirSync(clientDir);
  const client = path.join(clientDir, 'chatgpt');
  fs.writeFileSync(client, '#!/bin/sh\nprintf "%s\\n" "$CODEX_HOME" > "$CHATGPT_TEST_MARKER"\n', { mode: 0o755 });
  const marker = path.join(fixture, 'client-started.txt');
  fs.writeFileSync(configFile, fs.readFileSync(configFile, 'utf8').replace(/^model = .*$/m, 'model = "Vendor/model" # keep this choice'));
  models.push('Vendor/new-model');
  await cli('launch', { CHATGPT_API_CLIENT: client, CHATGPT_TEST_MARKER: marker });
  for (let i = 0; i < 30 && !fs.existsSync(marker); i++) await delay(50);
  assert.equal(fs.readFileSync(marker, 'utf8').trim(), native);
  assert(fs.readFileSync(configFile, 'utf8').includes('model = "Vendor/model"'));
  assert(menu().some(model => model.slug === 'Vendor/new-model'));
  const newModel = await fetch('http://127.0.0.1:' + port + '/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'Vendor/new-model', input: 'new' }) });
  assert.equal(newModel.status, 200); await newModel.text();
  checks.push('Launch refreshes the menu and live router together, then opens the configured client with the same CODEX_HOME');

  const payload = path.join(release, 'payload/src/shim.mjs'), originalPayload = fs.readFileSync(payload);
  const installedHash = crypto.createHash('sha256').update(fs.readFileSync(path.join(installed, 'src/shim.mjs'))).digest('hex');
  fs.appendFileSync(payload, '\n// damaged fixture');
  await assert.rejects(invoke([installer, release, installed]), /checksum failed/);
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(installed, 'src/shim.mjs'))).digest('hex'), installedHash);
  fs.writeFileSync(payload, originalPayload);
  const manifestFile = path.join(release, 'release.json'), originalManifest = fs.readFileSync(manifestFile);
  const manifest = JSON.parse(originalManifest); manifest.files[0].path = '../outside'; fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  await assert.rejects(invoke([installer, release, installed]), /Invalid program path/); fs.writeFileSync(manifestFile, originalManifest);
  checks.push('Damaged payloads and path traversal fail before replacing installed programs');

  const simulated = path.join(fixture, 'ChatGPT.app/Contents/MacOS/ChatGPT'); fs.mkdirSync(path.dirname(simulated), { recursive: true }); fs.linkSync(process.execPath, simulated);
  simulatedClient = spawn(simulated, ['-e', 'setInterval(()=>{},1000)'], { env, stdio: 'ignore' }); await once(simulatedClient, 'spawn');
  await assert.rejects(invoke([installer, release, installed]), /Fully quit ChatGPT/);
  await assert.rejects(cli('configure'), /Fully quit ChatGPT/);
  simulatedClient.kill(); await once(simulatedClient, 'exit'); simulatedClient = null;
  checks.push('Running desktop processes block installation and configuration changes');

  fs.writeFileSync(configFile, fs.readFileSync(configFile, 'utf8').replace('zh-CN', 'en-US'));
  fs.writeFileSync(path.join(installed, 'my-notes.txt'), 'preserve');
  await invoke([installer, release, installed], { CHATGPT_API_KEY: '', CHATGPT_API_BASE_URL: '', CHATGPT_API_PORT: '' });
  assert(fs.readFileSync(path.join(installed, 'data/.env'), 'utf8').includes('API_KEY=' + key));
  assert(fs.readFileSync(configFile, 'utf8').includes('localeOverride = "en-US"'));
  assert.equal(fs.readFileSync(path.join(installed, 'my-notes.txt'), 'utf8'), 'preserve');
  assert.equal(fs.readFileSync(authFile, 'utf8'), originalAuth);
  await cli('restore');
  const restored = fs.readFileSync(configFile, 'utf8');
  assert(!restored.includes('model_catalog_json')); assert(!restored.includes('[model_providers.chatgpt_api_launcher]'));
  assert(restored.includes('model = "old-official"')); assert(restored.includes('localeOverride = "en-US"')); assert(restored.includes('[model_providers.unrelated]'));
  checks.push('Updates preserve settings and user files; restore returns managed keys while retaining later preference edits');

  const report = { passed: true, platform: process.platform, architecture: process.arch, node: process.version, checks,
    scope: 'Shipped installer and router executed under macOS with isolated homes and mock upstreams; desktop GUI and real model inference are not exercised.' };
  fs.writeFileSync(path.join(root, 'data/diagnostics/macos-install-result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  simulatedClient?.kill();
  try { await cli('stop'); } catch {}
  server.close(); server.closeAllConnections?.();
  // This directory was allocated by this test; never remove a real user home.
  assert(fixture.startsWith(path.join(fs.realpathSync(os.tmpdir()), 'chatgpt-macos-install-test-')));
  fs.rmSync(fixture, { recursive: true, force: true });
}
