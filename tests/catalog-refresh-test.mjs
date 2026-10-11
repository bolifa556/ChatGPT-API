import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fixture = fs.mkdtempSync(path.join(root, 'data/testing/catalog-refresh-'));
const home = path.join(fixture, 'home'), children = [], sockets = new Set(), records = [], checks = [];
for (const sub of ['assets','data/state','data/cache','home']) fs.mkdirSync(path.join(fixture, sub), { recursive: true });
for (const name of ['model-template.json','reasoning-levels.json']) fs.copyFileSync(path.join(root, 'assets', name), path.join(fixture, 'assets', name));
const template = JSON.parse(fs.readFileSync(path.join(root, 'assets/model-template.json'), 'utf8')).models[0];
const old = { ...template, slug: 'gpt-6-sol' };
const nativeMessages = {
  instructions_template: template.base_instructions,
  persistent_instructions: 'native fixture instructions',
  instructions_variables: { fixture: { original: true } },
  approvals: { fixture: true },
  future_native_field: { preserve: ['all', 'metadata'] },
};
const latest = { ...template, slug: 'gpt-6.1-sol', display_name: 'GPT-6.1-Sol', priority: 0,
  model_messages: nativeMessages, fixture_metadata: { keep: true } };
delete latest.base_instructions;
let currentTemplate = old;
const gatewayIds = ['Vendor/model', 'GPT/gpt-6.1-sol', 'GPT/gpt-6-sol', 'GPT/gpt-catalog-unknown'];
let gatewayMetadata = {};
let extra = [], modelStatus = 200, delayOld = false, oldStarted;
const routeFile = path.join(fixture, 'data/state/route-state.json');
const menu = () => JSON.parse(fs.readFileSync(path.join(fixture, 'data/cache/models-smr.json'), 'utf8')).models;
const state = version => fs.writeFileSync(routeFile, JSON.stringify({ mode: 'mixed', officialProxy: '', clientVersion: version }));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'inert-catalog-account', account_id: 'fixture-account' } }));
fs.writeFileSync(path.join(home, 'models_cache.json'), JSON.stringify({ client_version: '0.158.0', fetched_at: '2026-09-28T00:00:00Z', models: [old] }));
const nativeCacheBefore = fs.readFileSync(path.join(home, 'models_cache.json'), 'utf8');
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/v1/models') {
    assert.equal(req.headers.authorization, 'Bearer inert-gateway-key');
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: gatewayIds.map(id => ({ id, ...gatewayMetadata[id] })) })); return;
  }
  assert.equal(url.pathname, '/backend-api/codex/models');
  const version = url.searchParams.get('client_version');
  records.push({ url: req.url, version, authorization: req.headers.authorization, account: req.headers['chatgpt-account-id'], marker: req.headers['x-native-fixture'] });
  if (delayOld && version === '0.159.0') { oldStarted?.(); await delay(180); }
  res.setHeader('content-type', 'application/json'); res.setHeader('etag', '"fixture-catalog"');
  if (req.headers['if-none-match'] === '"fixture-catalog"') { res.writeHead(304); res.end(); return; }
  if (modelStatus !== 200) { res.writeHead(modelStatus); res.end(JSON.stringify({ error: { code: 'fixture_unavailable' } })); return; }
  const models = version === '0.158.0' ? [old] : [latest, currentTemplate, ...extra];
  res.end(JSON.stringify({ models, fixture_response_metadata: { original: true, version } }));
});
server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const upstream = 'http://127.0.0.1:' + server.address().port;
const reserve = http.createServer(); await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
const base = 'http://127.0.0.1:' + port;
fs.writeFileSync(path.join(fixture, 'data/.env'), `BASE_URL=${upstream}/v1\nAPI_KEY=inert-gateway-key\nSHIM_PORT=${port}\nOFFICIAL_BASE=${upstream}/backend-api/codex\n`);
function child(args = []) {
  const processChild = spawn(process.execPath, [path.join(root, 'src/shim.mjs'), ...args], { env: { ...process.env, CODEX_HOME: home, CHATGPT_API_ROOT: fixture }, windowsHide: true, stdio: ['ignore','pipe','pipe'] });
  children.push(processChild); processChild.errorText = ''; processChild.stderr.on('data', data => processChild.errorText += data); processChild.stdout.resume(); return processChild;
}
try {
  state('0.159.0'); const prepare = child(['--prepare']);
  assert.equal((await once(prepare, 'exit'))[0], 0, prepare.errorText);
  assert.deepEqual(menu().slice(0, 2), [latest, old]);
  assert.equal(records.at(-1).version, '0.159.0');
  assert.equal(fs.readFileSync(path.join(home, 'models_cache.json'), 'utf8'), nativeCacheBefore);
  checks.push('Installed client version overrides stale native-cache version without editing native cache');
  const modernAlias = menu().find(model => model.slug === 'GPT/gpt-6.1-sol');
  assert.equal(modernAlias.base_instructions, undefined);
  assert.deepEqual(modernAlias.model_messages, latest.model_messages);
  assert.deepEqual(modernAlias.fixture_metadata, latest.fixture_metadata);
  const legacyAlias = menu().find(model => model.slug === 'GPT/gpt-6-sol');
  assert.equal(legacyAlias.base_instructions, old.base_instructions);
  assert.deepEqual(legacyAlias.model_messages, old.model_messages);
  const gatewayMenu = JSON.parse(fs.readFileSync(path.join(fixture, 'data/cache/models-gateway.json'))).models;
  assert.deepEqual(gatewayMenu, menu().slice(2));
  assert(menu().every(model => model.base_instructions || model.model_messages?.instructions_template));
  checks.push('Modern GPT aliases retain the complete native instructions object; legacy aliases retain base instructions in both menu files');
  for (const gatewayModel of gatewayMenu) {
    assert.deepEqual(gatewayModel.service_tiers, []);
    assert.deepEqual(gatewayModel.additional_speed_tiers, []);
    assert.equal(gatewayModel.default_service_tier, null);
  }
  assert.deepEqual(menu().slice(0, 2), [latest, old]);
  checks.push('Unadvertised gateway speed options are empty for GPT aliases and non-GPT models; official metadata remains byte-for-byte equivalent');
  const running = child();
  let ready = false;
  for (let n = 0; n < 80; n++) { try { if ((await fetch(base + '/healthz')).ok) { ready = true; break; } } catch {} await delay(40); }
  assert(ready, running.errorText);
  gatewayMetadata = { 'Vendor/model': { default_service_tier: 'priority',
    service_tiers: [{ id: 'priority', name: 'Upstream Fast', description: 'Original upstream description' }],
    additional_speed_tiers: ['fast'] } };
  await (await fetch(base + '/readyz')).json();
  const advertised = menu().find(model => model.slug === 'Vendor/model');
  for (const key of Object.keys(gatewayMetadata['Vendor/model'])) assert.deepEqual(advertised[key], gatewayMetadata['Vendor/model'][key]);
  const cachedMetadata = JSON.parse(fs.readFileSync(path.join(fixture, 'data/cache/catalog-state.json'))).gatewayModels.find(model => model.id === 'Vendor/model');
  for (const key of Object.keys(gatewayMetadata['Vendor/model'])) assert.deepEqual(cachedMetadata[key], advertised[key]);
  gatewayMetadata = {};
  await (await fetch(base + '/readyz')).json();
  assert.deepEqual(menu().find(model => model.slug === 'Vendor/model').service_tiers, []);
  checks.push('Explicit upstream Fast metadata is preserved through refresh and cache; withdrawing it removes stale speed claims');
  extra = [{ ...template, slug: 'gpt-catalog-refresh-fixture' }];
  await (await fetch(base + '/readyz')).json();
  assert.deepEqual(menu().slice(0, 3), [latest, old, ...extra]);
  assert.equal(menu().at(-1).slug, 'Vendor/model');
  checks.push('Runtime refresh updates official and merged gateway menu files, retaining full official metadata');
  state(undefined); const priorCount = records.length;
  const noVersion = await (await fetch(base + '/readyz')).json();
  assert.equal(noVersion.official.ready, false); assert.match(noVersion.official.error, /version is unavailable/);
  assert.equal(records.length, priorCount); assert(menu().some(model => model.slug === latest.slug));
  checks.push('Unknown current version retains cached models but never requests a hardcoded or stale version');
  state('0.159.0'); delayOld = true;
  const waiting = new Promise(resolve => oldStarted = resolve);
  const periodic = fetch(base + '/readyz').then(response => response.json());
  await waiting;
  const nativeHeaders = { authorization: 'Bearer inert-native-refreshed', 'chatgpt-account-id': 'native-account', 'x-native-fixture': 'preserve-header' };
  const nativeQuery = '/v1/models?client_version=0.160.0&native_capability=preserve-query';
  const nativeResponse = await fetch(base + nativeQuery, { headers: nativeHeaders });
  assert.equal(nativeResponse.status, 200); assert.equal(nativeResponse.headers.get('etag'), '"fixture-catalog"');
  const nativeData = await nativeResponse.json(); await periodic; delayOld = false;
  assert.deepEqual(nativeData, { models: [latest, old, ...extra], fixture_response_metadata: { original: true, version: '0.160.0' } });
  const forwarded = records.findLast(record => record.version === '0.160.0');
  assert.equal(forwarded.url, '/backend-api/codex/models?client_version=0.160.0&native_capability=preserve-query');
  assert.equal(forwarded.authorization, nativeHeaders.authorization); assert.equal(forwarded.account, 'native-account'); assert.equal(forwarded.marker, 'preserve-header');
  assert.equal(JSON.parse(fs.readFileSync(path.join(fixture, 'data/cache/catalog-state.json'))).officialClientVersion, '0.160.0');
  await (await fetch(base + '/readyz')).json(); assert.equal(records.at(-1).version, '0.160.0');
  checks.push('Native model-list query, refreshed auth, full body and ETag pass through; concurrent refresh cannot revert its version');
  const unchanged = await fetch(base + nativeQuery, { headers: { ...nativeHeaders, 'if-none-match': '"fixture-catalog"' } });
  assert.equal(unchanged.status, 304); assert.equal(await unchanged.text(), '');
  modelStatus = 503; const unavailable = await fetch(base + nativeQuery, { headers: nativeHeaders });
  assert.equal(unavailable.status, 503); assert.equal((await unavailable.json()).error.code, 'fixture_unavailable'); modelStatus = 200;
  checks.push('Native 304 and server errors are not replaced by a fake cached 200 response');
  const menuFile = path.join(fixture, 'data/cache/models-smr.json');
  const savedMenu = fs.readFileSync(menuFile);
  fs.unlinkSync(menuFile); fs.mkdirSync(menuFile);
  try {
    const cacheFailure = await fetch(base + nativeQuery, { headers: nativeHeaders });
    assert.equal(cacheFailure.status, 200); assert.deepEqual(await cacheFailure.json(), nativeData);
  } finally { fs.rmdirSync(menuFile); fs.writeFileSync(menuFile, savedMenu); }
  checks.push('A local menu write failure cannot turn a successful native model-list response into an error');
  state('0.161.0'); await (await fetch(base + '/readyz')).json(); assert.equal(records.at(-1).version, '0.161.0');
  checks.push('A subsequent installed-client version update supersedes a previously observed request version');
  currentTemplate = { ...old, model_messages: nativeMessages };
  delete currentTemplate.base_instructions;
  await (await fetch(base + '/readyz')).json();
  assert.deepEqual(menu().slice(0, 3), [latest, currentTemplate, ...extra]);
  for (const id of ['GPT/gpt-6-sol', 'GPT/gpt-catalog-unknown']) {
    const alias = menu().find(model => model.slug === id);
    assert.equal(alias.base_instructions, undefined);
    assert.deepEqual(alias.model_messages, nativeMessages);
  }
  const nonGpt = menu().find(model => model.slug === 'Vendor/model');
  assert(nonGpt.base_instructions);
  assert.equal(nonGpt.model_messages, null);
  assert.equal(nonGpt.tool_mode, 'code_mode_only');
  assert(menu().every(model => model.base_instructions || model.model_messages?.instructions_template));
  checks.push('An updated template and an unmatched GPT alias preserve native instructions without changing non-GPT compatibility');
  fs.unlinkSync(path.join(home, 'auth.json'));
  fs.unlinkSync(path.join(home, 'models_cache.json'));
  fs.writeFileSync(routeFile, JSON.stringify({ mode: 'gateway', officialProxy: '', clientVersion: '0.162.0' }));
  const officialCalls = records.length, apiOnly = child(['--prepare']);
  assert.equal((await once(apiOnly, 'exit'))[0], 0, apiOnly.errorText);
  assert.equal(records.length, officialCalls);
  assert.deepEqual(new Set(menu().map(model => model.slug)), new Set(gatewayIds));
  assert(menu().every(model => model.service_tiers.length === 0 && model.additional_speed_tiers.length === 0 && model.default_service_tier === null));
  assert.equal(fs.existsSync(path.join(home, 'auth.json')), false);
  checks.push('API-only mode prepares the complete gateway menu without official credentials, official requests or inherited Fast claims');
  const report = { passed: true, checks };
  fs.writeFileSync(path.join(root, 'data/diagnostics/catalog-refresh-result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  for (const p of children) if (p.exitCode === null) p.kill();
  for (const socket of sockets) socket.destroy(); server.close(); server.closeAllConnections?.();
}
