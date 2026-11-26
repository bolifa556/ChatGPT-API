import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { GatewaySources } from '../src/gateway-sources.mjs';
import { probeModels, probeLevels } from '../src/model-probe.mjs';
import { contextKey } from '../src/model-context.mjs';
import { startConsole } from '../src/console.mjs';
import { saveSettings, readSettings, publicSettings, overrideKey } from '../src/settings.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-model-probe-'));
for (const name of ['data/cache', 'assets']) fs.mkdirSync(path.join(root, name), { recursive: true });
fs.writeFileSync(path.join(root, 'assets/model-contexts.json'), '{}');
fs.writeFileSync(path.join(root, 'assets/model-template.json'), JSON.stringify({ models: [{ context_window: 272000, effective_context_window_percent: 95 }] }));
fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '3.2.5' }));
const ids = ['Vendor/new', 'Vendor/chat-only', 'Vendor/legacy', 'Vendor/known-effort', 'Vendor/with-known',
  'Vendor/ignored-effort', 'Vendor/schema-only', 'Vendor/alias-case', 'Vendor/structured-error', 'Vendor/stream-error',
  'Vendor/metadata-thinking', 'Vendor/metadata-efforts', 'Vendor/manual-only', 'GPT/gpt-6.1-sol', 'Vendor/flux-dev'];
const counts = new Map();
let catalogs = 0, active = 0, peak = 0, interrupted;
const server = http.createServer(async (req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.url.endsWith('/models')) {
    catalogs++;
    res.end(JSON.stringify({ data: ids.map(id => ({ id,
      ...(id === 'Vendor/with-known' ? { context_window: 900000, supported_reasoning_efforts: ['low'] } : {}),
      ...(id === 'Vendor/known-effort' ? { supported_reasoning_efforts: ['low', 'high'] } : {}),
      ...(id === 'Vendor/metadata-thinking' ? { thinking: { levels: ['none', 'low', 'high', 'max'] } } : {}),
      ...(id === 'Vendor/metadata-efforts' ? { reasoning_effort_levels: ['low', 'high', 'xhigh'] } : {}),
    })) }));
    return;
  }
  const parts = [];
  for await (const part of req) parts.push(part);
  const body = JSON.parse(Buffer.concat(parts)), id = body.model;
  assert(!req.url.includes('/images/'), 'Capability discovery generated an image');
  assert.equal(body.input || body.messages?.[0]?.content, 'Reply only OK.');
  assert.equal(body.max_output_tokens ?? body.max_tokens, 16);
  assert.equal(body.reasoning?.effort || body.reasoning_effort, 'invalid_probe', 'Discovery sent a generation request for a valid effort');
  counts.set(id, (counts.get(id) || 0) + 1);
  active++; peak = Math.max(peak, active);
  res.once('close', () => { active--; });
  await new Promise(resolve => setTimeout(resolve, 15));
  if (id === 'Vendor/interrupted') { interrupted?.(); return; }
  const reject = (status, error) => { res.writeHead(status); res.end(JSON.stringify({ error })); };
  if (id === 'Vendor/chat-only' && req.url.endsWith('/responses')) return reject(404, { message: 'Cannot POST /v1/responses' });
  if (id === 'Vendor/ignored-effort') {
    res.end(JSON.stringify({ status: 'completed', reasoning: { effort: 'invalid_probe' }, usage: { output_tokens_details: { reasoning_tokens: 20 } } }));
    return;
  }
  if (id === 'Vendor/schema-only') return reject(400, { message: 'unknown variant, expected one of none, low, medium, high, xhigh, max' });
  if (id === 'Vendor/structured-error') return reject(422, { param: 'reasoning.effort', allowed_values: ['low', 'high', 'max'] });
  if (id === 'Vendor/alias-case') return reject(400, { message: 'level invalid_probe not supported, valid levels: none, low, high, xhigh (medium and max aliases are accepted)' });
  const error = { message: 'level invalid_probe not supported, valid levels: none, low, high, max' };
  if (id === 'Vendor/stream-error') {
    res.writeHead(400, { 'content-type': 'text/event-stream' });
    res.end('data: ' + JSON.stringify({ type: 'error', error }) + '\n\n');
    return;
  }
  reject(400, error);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port + '/v1';
const env = { BASE_URL: base, API_KEY: 'fixture-key' };
fs.writeFileSync(path.join(root, 'data/.env'), 'BASE_URL=' + base + '\nAPI_KEY=fixture-key\n');
const pool = new GatewaySources(root, env), file = path.join(root, 'data/cache/model-contexts.json');
const legacy = { status: 'known', levels: ['low', 'high'], highest: 'high', source: 'probe-confirmed' };
fs.writeFileSync(file, JSON.stringify({ version: 1, entries: {
  [contextKey(base, 'Vendor/legacy')]: { capacity: 262000, source: 'probe-fallback', strengths: { reasoning: legacy } },
  [contextKey(base, 'Vendor/known-effort')]: { capacity: 262000, source: 'default-context-window', strengths: { reasoning: legacy } },
} }));
saveSettings(root, { ...publicSettings(readSettings(root)), contextOverrides: { [overrideKey('default', 'Vendor/legacy')]: 500000 },
  strengthOverrides: { [overrideKey('default', 'Vendor/manual-only')]: { reasoning: ['medium'] } } });
let consoleServer;
try {
  assert.deepEqual(probeLevels({ error: { message: 'unknown variant, expected one of none, low, high' } }), []);
  assert.deepEqual(probeLevels({ error: { param: 'reasoning.effort', allowed_values: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] } }), ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(probeLevels({ error: { message: 'level invalid_probe not supported, valid levels: low, high, max (minimal and medium aliases are accepted)' } }), ['low', 'high', 'max']);
  assert.deepEqual(probeLevels({ error: { message: 'complexity invalid; valid values: none, low, high, ultra' } }, 'complexity'), ['low', 'high']);
  assert.deepEqual(probeLevels({ error: { message: 'quality invalid; valid values: standard, hd' } }, 'quality'), ['standard', 'hd']);
  await pool.discover();
  await probeModels(pool);
  let records = JSON.parse(fs.readFileSync(file)).entries;
  const record = id => records[contextKey(base, id)];
  for (const id of ['Vendor/new', 'Vendor/chat-only', 'Vendor/legacy', 'Vendor/structured-error', 'Vendor/stream-error']) {
    assert.deepEqual(record(id).strengths.reasoning.levels, ['low', 'high', 'max']);
    assert.equal(record(id).strengths.reasoning.source, 'model-validation');
    assert.equal(counts.get(id), id === 'Vendor/chat-only' ? 2 : 1);
  }
  for (const id of ['Vendor/ignored-effort', 'Vendor/schema-only']) {
    assert.equal(record(id).strengths.reasoning.status, 'unknown');
    assert.equal(counts.get(id), 1);
  }
  assert.deepEqual(record('Vendor/alias-case').strengths.reasoning.levels, ['low', 'high', 'xhigh']);
  assert.deepEqual(record('Vendor/metadata-thinking').strengths.reasoning.levels, ['low', 'high', 'max']);
  assert.deepEqual(record('Vendor/metadata-efforts').strengths.reasoning.levels, ['low', 'high', 'xhigh']);
  for (const id of ['Vendor/known-effort', 'Vendor/with-known', 'Vendor/metadata-thinking', 'Vendor/metadata-efforts', 'Vendor/manual-only', 'GPT/gpt-6.1-sol', 'Vendor/flux-dev']) assert(!counts.has(id));
  assert.equal(record('Vendor/manual-only').strengths?.reasoning, undefined, 'A manual setting became a shared model capability');
  assert.equal(record('Vendor/with-known').capacity, 900000);
  assert.equal(record('Vendor/new').capacity, 262000);
  assert.equal(record('Vendor/legacy').capacity, 262000);
  assert.equal(readSettings(root).contextOverrides[overrideKey('default', 'Vendor/legacy')], 500000, 'A missing capacity cannot reset a manual window');
  assert(peak > 1 && peak <= 4);
  const before = [...counts];
  await pool.discover(); await probeModels(pool);
  assert.deepEqual([...counts], before, 'A completed validation ran again');
  ids.push('Vendor/added');
  await pool.discover(); await probeModels(pool);
  for (const [id, count] of before) assert.equal(counts.get(id), count);
  assert.equal(counts.get('Vendor/added'), 1);
  ids.push('Vendor/interrupted');
  await pool.discover();
  const controller = new AbortController(), started = new Promise(resolve => { interrupted = resolve; });
  const pending = probeModels(pool, { signal: controller.signal });
  await started; controller.abort();
  await assert.rejects(pending);
  await probeModels(pool);
  assert.equal(counts.get('Vendor/interrupted'), 1);
  records = JSON.parse(fs.readFileSync(file)).entries;
  for (const entry of Object.values(records)) {
    assert(!('checkedAt' in entry)); assert(!('history' in entry)); assert(!('requests' in entry));
  }
  const current = readSettings(root), key = overrideKey('default', 'Vendor/new');
  saveSettings(root, { ...publicSettings(current), contextOverrides: { [key]: 2000000 },
    modelCapacities: { [key]: 64000 }, strengthOverrides: { ...current.strengthOverrides, [key]: { reasoning: ['low', 'high'] } } });
  consoleServer = await startConsole({ root, open: false });
  const token = new URL(consoleServer.url).hash.slice(1);
  const api = (name, body) => fetch(new URL('/api/' + name, consoleServer.url), {
    method: body ? 'POST' : 'GET', headers: { authorization: 'Bearer ' + token, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  let state = await (await api('state')).json();
  const configured = state.models.find(model => model.name === 'Vendor/new');
  assert.equal(configured.capacity, 64000); assert.equal(configured.limit, 2000000); assert.equal(configured.effective, 1900000);
  assert.deepEqual(configured.strengths.reasoning.levels, ['low', 'high']);
  const previousCatalogs = catalogs;
  state = await (await api('settings', { ...state.settings, providers: [...state.settings.providers,
    { id: 'p_12345678', name: 'Added', baseUrl: base, apiKey: 'another-fixture-key', enabled: true }] })).json();
  assert.equal(state.models.length, ids.length * 2); assert(catalogs > previousCatalogs);
  assert.deepEqual(state.models.find(model => model.name === 'Vendor/manual-only' && model.providerId === 'default').strengths.reasoning.levels, ['medium']);
  assert.deepEqual(state.models.find(model => model.name === 'Vendor/manual-only' && model.providerId === 'p_12345678').strengths.reasoning.levels, ['low', 'high', 'max']);
  console.log(JSON.stringify({ passed: true, checks: ['native levels from metadata and per-model validation', 'aliases excluded', 'global schema enums stay unknown', 'legacy result upgrades once', 'single validation per new model', 'no valid-effort generation calls', 'bounded parallel requests', 'GPT exclusion', 'Chat fallback', 'manual capability and context edits', 'automatic source discovery'] }));
} finally {
  await consoleServer?.close(); await pool.close(); await new Promise(resolve => server.close(resolve));
  assert(root.startsWith(path.join(os.tmpdir(), 'chatgpt-model-probe-')));
  fs.rmSync(root, { recursive: true, force: true });
}
