import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { imageCandidates, imageModelUnavailable } from '../src/image-compat.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = path.join(root, 'data/testing/image-generation-' + process.pid);
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jK4kAAAAASUVORK5CYII=';
const dataUrl = 'data:image/png;base64,' + png;
const nativeBody = { model: 'gpt-image-2', prompt: '保持这个中文提示词原样，不补充文字。', background: 'opaque', quality: 'auto', size: 'auto' };
const nativeResult = { created: 1780000000, data: [{ b64_json: png, generation_id: 'native-generation-id' }], background: 'opaque', quality: 'high', size: '1024x1024' };
const officialModel = { ...JSON.parse(fs.readFileSync(path.join(root, 'assets/model-template.json'))).models[0], slug: 'gpt-6-sol' };
const records = [], checks = [], servers = [], sockets = new Set(), children = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const listen = server => new Promise(resolve => {
  servers.push(server); server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});
let gatewayModels = [{ id: 'Other/chat-model' }, { id: '绘图/任意别名', capabilities: { image_generation: true, image_edit: true } }];
let officialStatus = 200, officialData = nativeResult, gatewayStatus = 200, gatewayData = { created: 1780000001, data: [{ b64_json: png }] };
let officialAction = '', gatewayAction = '', downloadPort, downloadType = 'image/png';
let unavailableFirst = false;
function peer(which) {
  return http.createServer(async (req, res) => {
    if (req.url.includes('/models')) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(which === 'official' ? { models: [officialModel] } : { data: gatewayModels })); return; }
    if (req.url.startsWith('/backend-api/files/download/')) { records.push({ which,path: req.url,headers: req.headers }); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ download_url: 'http://127.0.0.1:' + downloadPort + '/image.png' })); return; }
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks); let body;
    if (req.headers['content-type']?.startsWith('multipart/form-data')) {
      const form = await new Response(raw, { headers: { 'content-type': req.headers['content-type'] } }).formData();
      body = {};
      for (const [key,value] of form.entries()) body[key] = typeof value === 'string' ? value : { type: value.type, bytes: Buffer.from(await value.arrayBuffer()).toString('base64') };
    } else body = JSON.parse(raw.toString());
    records.push({ which,path: req.url,headers: req.headers,raw: raw.toString(),body });
    if (which === 'official' && officialAction === 'disconnect') { req.socket.destroy(); return; }
    let status = which === 'official' ? officialStatus : gatewayStatus;
    let data = which === 'official' ? officialData : gatewayData;
    if (which === 'gateway' && gatewayAction === 'multipart-only' && req.url.endsWith('/edits') && req.headers['content-type'] === 'application/json') {
      status = 400; data = { error: { message: 'at least one image or image_url is required' } };
    }
    if (which === 'gateway' && unavailableFirst && body.model === '绘图/任意别名') { status = 404; data = { error: { code: 'model_not_found', message: 'Image alias unavailable' } }; }
    res.writeHead(status, { 'content-type': 'application/json', 'x-native-image-peer': which });
    res.end(JSON.stringify(data));
  });
}
async function start(mode, options = {}) {
  const dir = path.join(fixture, 'router-' + children.length);
  for (const sub of ['assets','data/state','home']) fs.mkdirSync(path.join(dir, sub), { recursive: true });
  for (const name of ['model-template.json','reasoning-levels.json']) fs.copyFileSync(path.join(root, 'assets', name), path.join(dir, 'assets', name));
  if (options.login !== false) fs.writeFileSync(path.join(dir, 'home/auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'mock-native-oauth', account_id: 'mock-native-account' } }));
  const reserve = http.createServer(), port = await listen(reserve); await new Promise(resolve => reserve.close(resolve));
  fs.writeFileSync(path.join(dir, 'data/.env'), [
    'BASE_URL=http://127.0.0.1:' + gatewayPort + '/v1', 'API_KEY=mock-api-key', 'SHIM_PORT=' + port,
    'OFFICIAL_BASE=http://127.0.0.1:' + officialPort + '/backend-api/codex',
    ...Object.entries(options.settings || {}).map(([key,value]) => key + '=' + value),
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'data/state/route-state.json'), JSON.stringify({ mode, entryMode: options.entryMode || 'api', nativeAccount: options.nativeAccount === true, officialProxy: '', gatewayTransport: 'direct', clientVersion: '0.159.0' }));
  const child = spawn(process.execPath, [path.join(root, 'src/shim.mjs')], { env: { ...process.env, CHATGPT_API_ROOT: dir, CODEX_HOME: path.join(dir, 'home') }, windowsHide: true, stdio: ['ignore','ignore','pipe'] }); children.push(child);
  let stderr = ''; child.stderr.on('data', chunk => stderr += chunk);
  const base = 'http://127.0.0.1:' + port;
  for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/healthz')).ok) break; } catch {} await delay(25); }
  const ready = await fetch(base + '/readyz', { signal: AbortSignal.timeout(5000) }); assert.equal(ready.status, 200, stderr);
  return { base,dir };
}
async function send(router, operation = 'generations', extra = {}, routePrefix = '/v1', token = 'mock-api-key') {
  const payload = { ...nativeBody,...extra };
  const response = await fetch(router.base + routePrefix + '/images/' + operation, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token, 'chatgpt-account-id': 'must-not-leak', 'openai-organization': 'must-not-leak', 'x-codex-image-turn-id': 'original-turn-id', 'x-openai-actor-authorization': 'chatgpt-api-local' },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(10000),
  });
  return { status: response.status,headers: response.headers,raw: await response.text() };
}
const count = which => records.filter(r => r.which === which && r.body).length;
let gatewayPort, officialPort;
try {
  downloadPort = await listen(http.createServer((req, res) => {
    records.push({ which: 'download',headers: req.headers }); res.writeHead(200, { 'content-type': downloadType }); res.end(Buffer.from(png, 'base64'));
  }));
  gatewayPort = await listen(peer('gateway')); officialPort = await listen(peer('official'));
  const mixed = await start('mixed');
  const beforeGateway = count('gateway');
  let result = await send(mixed);
  assert.equal(result.status, 200); assert.equal(result.raw, JSON.stringify(nativeResult)); assert.equal(count('gateway'), beforeGateway);
  assert.equal(records.at(-1).raw, JSON.stringify(nativeBody)); assert.equal(records.at(-1).headers.authorization, 'Bearer mock-native-oauth');
  assert.equal(records.at(-1).path, '/backend-api/codex/images/generations'); assert.equal(result.headers.get('x-native-image-peer'), 'official');
  assert.equal(records.at(-1).headers['x-openai-actor-authorization'], undefined);
  checks.push('Official image model bypasses chat-menu allowlist; original body, output, headers and image metadata pass unchanged');
  result = await send(mixed, 'edits', { images: [{ image_url: dataUrl }] }, '');
  assert.equal(result.status, 200); assert.equal(records.at(-1).path, '/backend-api/codex/images/edits'); assert.deepEqual(records.at(-1).body.images, [{ image_url: dataUrl }]);
  checks.push('Native JSON image editing and both native endpoint prefixes are supported');

  const nativeAccount = await start('mixed', { login: false, nativeAccount: true });
  result = await send(nativeAccount, 'generations', {}, '/v1', 'native-keychain-oauth');
  assert.equal(result.status, 200); assert.equal(records.at(-1).which, 'official');
  assert.equal(records.at(-1).headers.authorization, 'Bearer native-keychain-oauth');
  assert(!fs.existsSync(path.join(nativeAccount.dir, 'home/auth.json')));
  const beforeNativeAccount = count('official');
  result = await send(nativeAccount);
  assert.equal(result.status, 200); assert.equal(records.at(-1).which, 'gateway'); assert.equal(count('official'), beforeNativeAccount);
  checks.push('Native-account image requests use client OAuth without auth.json; a bare API key never gains official identity');

  officialStatus = 404; officialData = { error: { code: 'model_not_found', message: 'Official image model unavailable' } };
  result = await send(mixed);
  assert.equal(result.status, 200); assert.equal(records.at(-1).which, 'gateway'); assert.equal(records.at(-1).body.model, '绘图/任意别名');
  assert.equal(records.at(-1).body.prompt, nativeBody.prompt); assert.equal(records.at(-1).headers.authorization, 'Bearer mock-api-key');
  for (const name of ['chatgpt-account-id','openai-organization','openai-project']) assert.equal(records.at(-1).headers[name], undefined);
  assert.equal(records.at(-1).headers['x-codex-image-turn-id'], 'original-turn-id');
  assert.equal(records.at(-1).headers['x-openai-actor-authorization'], undefined);
  assert.equal(records.at(-1).body.input, undefined); assert.equal(records.at(-1).body.messages, undefined);
  checks.push('Definitively unavailable official model falls back to any capability-advertised API image alias; OAuth and account headers never reach API');
  const menu = JSON.parse(fs.readFileSync(path.join(mixed.dir, 'data/cache/models-smr.json'))).models;
  assert(!menu.some(m => m.slug === '绘图/任意别名')); assert(menu.some(m => m.slug === 'Other/chat-model'));
  checks.push('Image-only models are not incorrectly advertised as conversational models');

  const gatewayOnly = await start('gateway'); let beforeOfficial = count('official');
  result = await send(gatewayOnly); assert.equal(result.status, 200); assert.equal(count('official'), beforeOfficial);
  assert.equal(records.at(-1).body.model, '绘图/任意别名');
  const noLogin = await start('mixed', { login: false }); result = await send(noLogin, 'edits', { images: [{ image_url: dataUrl }] });
  assert.equal(result.status, 200); assert.equal(count('official'), beforeOfficial); assert.deepEqual(records.at(-1).body.images, [{ image_url: dataUrl }]);
  checks.push('Provider-only ignores saved official credentials; missing sign-in also uses API directly, for generation and editing');

  gatewayModels.push({ id: 'qwen-image' });
  const defaultMixed = await start('mixed', { settings: { IMAGE_MODEL: '绘图/任意别名' } });
  const beforeDefaultOfficial = count('official');
  result = await send(defaultMixed);
  assert.equal(result.status, 200); assert.equal(records.at(-1).body.model, '绘图/任意别名');
  assert.equal(count('official'), beforeDefaultOfficial);
  result = await send(defaultMixed, 'generations', { model: 'qwen-image' });
  assert.equal(result.status, 200); assert.equal(records.at(-1).body.model, 'qwen-image');
  assert.equal(count('official'), beforeDefaultOfficial); assert.equal(records.at(-1).body.prompt, nativeBody.prompt);
  gatewayModels.pop();
  checks.push('A selected API image default is honored in signed-in mixed mode; an explicitly requested API image model overrides it without an official detour or prompt rewrite');

  const apiOnlyEntry = await start('mixed', { entryMode: 'apionly', nativeAccount: true });
  beforeOfficial = count('official');
  result = await send(apiOnlyEntry);
  assert.equal(result.status, 200); assert.equal(count('official'), beforeOfficial);
  assert.equal(records.at(-1).which, 'gateway');
  const officialEntry = await start('mixed', { entryMode: 'official' });
  const beforeOfficialFallback = count('gateway');
  result = await send(officialEntry);
  assert.equal(result.status, 404); assert.equal(count('gateway'), beforeOfficialFallback);
  checks.push('Official entry preserves the official error without API fallback; API-only entry ignores saved login even with stale mixed route metadata');

  gatewayData = { created: 1780000002, data: [{ url: 'http://127.0.0.1:' + downloadPort + '/image.png', revised_prompt: 'upstream revision' }] };
  result = await send(gatewayOnly); assert.equal(result.status, 200); assert.equal(JSON.parse(result.raw).data[0].b64_json, png);
  assert.equal(JSON.parse(result.raw).data[0].revised_prompt, 'upstream revision'); assert.equal(records.at(-1).headers.authorization, undefined);
  assert.equal(records.at(-1).headers['chatgpt-account-id'], undefined); assert.equal(result.headers.get('content-length'), null);
  checks.push('URL-only API image results convert to native base64; image download receives no credentials and preserves upstream content');
  downloadType = 'application/octet-stream';
  result = await send(gatewayOnly); assert.equal(result.status, 200); assert.equal(JSON.parse(result.raw).data[0].b64_json, png);
  downloadType = 'image/png';
  checks.push('Image URLs served as generic binary data retain their original raster bytes');
  gatewayData = { created: 1780000001, data: [{ b64_json: png }] };

  const multipart = await start('gateway', { settings: { IMAGE_EDIT_FORMAT: 'multipart' } });
  result = await send(multipart, 'edits', { images: [{ image_url: dataUrl }, { image_url: dataUrl }], mask: { image_url: dataUrl }, background: 'transparent', quality: 'high', size: '1024x1024' });
  assert.equal(result.status, 200); assert.equal(records.at(-1).body['image[]'].bytes, png); assert.equal(records.at(-1).body.background, 'transparent');
  assert.equal(records.at(-1).body.quality, 'high'); assert.equal(records.at(-1).body.prompt, nativeBody.prompt);
  assert.equal(records.at(-1).body.mask.bytes, png); assert.equal(records.at(-1).body.mask.type, 'image/png');
  checks.push('Legacy multipart edit APIs receive original image bytes and explicit size, quality, transparency and prompt');
  gatewayAction = 'multipart-only';
  const beforeEdit = records.length;
  result = await send(gatewayOnly, 'edits', { images: [{ image_url: dataUrl }, { image_url: dataUrl }], mask: { image_url: dataUrl }, background: 'transparent', quality: 'high', size: '1024x1024' });
  assert.equal(result.status, 200);
  const editRequests = records.slice(beforeEdit).filter(record => record.which === 'gateway');
  assert.equal(editRequests.length, 2); assert.equal(editRequests[0].headers['content-type'], 'application/json');
  assert.match(editRequests[1].headers['content-type'], /^multipart\/form-data/);
  assert.equal(editRequests[1].body['image[]'].bytes, png); assert.equal(editRequests[1].body.prompt, nativeBody.prompt);
  assert.equal(editRequests[1].body.model, editRequests[0].body.model);
  assert.equal(editRequests[1].body.background, 'transparent'); assert.equal(editRequests[1].body.quality, 'high');
  assert.equal(editRequests[1].body.mask.bytes, png);
  gatewayAction = '';
  for (const [status, data] of [
    [400, { error: { message: 'at least one image or image_url is required', code: 'content_policy_violation' } }],
    [400, { error: { message: 'Invalid image dimensions', param: 'image', code: 'invalid_value' } }],
    [400, { error: { message: 'at least one image or image_url is required' }, data: [{ b64_json: png }] }],
    [500, { error: { message: 'at least one image or image_url is required' } }],
  ]) {
    gatewayStatus = status; gatewayData = data; const before = count('gateway');
    result = await send(gatewayOnly, 'edits', { images: [{ image_url: dataUrl }] });
    assert.equal(result.status, status); assert.equal(result.raw, JSON.stringify(data)); assert.equal(count('gateway'), before + 1);
  }
  gatewayStatus = 200; gatewayData = { created: 1780000001, data: [{ b64_json: png }] };
  checks.push('A definitive JSON image-field rejection negotiates multipart once on the same API/model with identical inputs; accepted output, safety, invalid image data and server failures never trigger this conversion');
  result = await send(mixed, 'edits', { images: [{ file_id: 'file-native-original' }] });
  assert.equal(result.status, 200); assert.deepEqual(records.at(-1).body.images, [{ image_url: 'http://127.0.0.1:' + downloadPort + '/image.png' }]);
  assert(records.some(r => r.path === '/backend-api/files/download/file-native-original' && r.headers.authorization === 'Bearer mock-native-oauth'));
  result = await send(gatewayOnly, 'edits', { images: [{ file_id: 'file-native-original' }] });
  assert.equal(result.status, 400); assert.equal(JSON.parse(result.raw).error.code, 'image_reference_unavailable');
  checks.push('Native file IDs resolve using the owning account only; without sign-in an unusable foreign file ID reports a precise error');

  for (const [status,data] of [
    [400, { error: { code: 'content_policy_violation', message: 'safety rejection' } }],
    [400, { error: { code: 'invalid_parameter', param: 'size', message: 'Invalid size' } }],
    [429, { error: { code: 'rate_limit_exceeded', message: 'Slow down' } }],
    [503, { error: { code: 'server_error', message: 'Temporary network or service outage' } }],
  ]) {
    officialStatus = status; officialData = data; const before = count('gateway'); result = await send(mixed);
    assert.equal(result.status, status); assert.equal(result.raw, JSON.stringify(data)); assert.equal(count('gateway'), before);
  }
  officialAction = 'disconnect'; const beforeNetwork = count('gateway'); result = await send(mixed);
  assert.equal(result.status, 502); assert.equal(count('gateway'), beforeNetwork); officialAction = '';
  checks.push('No generation retry or fallback on network failure, server errors, transient rate limits, content rejection or invalid parameters');
  officialStatus = 429; officialData = { error: { code: 'insufficient_quota', message: 'No image quota' } }; result = await send(mixed);
  assert.equal(result.status, 200); assert.equal(records.at(-1).which, 'gateway');
  checks.push('Explicit exhausted official image quota can use API fallback without retrying official');

  gatewayModels = [{ id: 'Other/chat-model' }]; await fetch(mixed.base + '/readyz'); await fetch(gatewayOnly.base + '/readyz');
  beforeOfficial = count('official'); result = await send(gatewayOnly); assert.equal(result.status, 400); assert.equal(JSON.parse(result.raw).error.code, 'no_gateway_image_model');
  assert.equal(count('official'), beforeOfficial); result = await send(mixed); assert.equal(result.status, 400); assert.match(JSON.parse(result.raw).error.message, /Official.*unavailable.*no model/);
  checks.push('No API image model errors explicitly; both unavailable errors identify official failure and missing API capability');

  gatewayModels = [{ id: 'Other/chat-model' }, { id: '任意供应商/自定义生图别名' }];
  const alias = await start('gateway', { settings: { IMAGE_MODEL: '任意供应商/自定义生图别名' } }); result = await send(alias); assert.equal(result.status, 200); assert.equal(records.at(-1).body.model, '任意供应商/自定义生图别名');
  const badAlias = await start('gateway', { settings: { IMAGE_MODEL: 'absent-model' } }); result = await send(badAlias); assert.equal(result.status, 400); assert.equal(JSON.parse(result.raw).error.code, 'no_gateway_image_model');
  checks.push('Explicit alias selection needs no GPT Image naming; a configured model absent from this API errors without sending a generation');
  gatewayModels = [{ id: 'Other/chat-model' }, { id: '绘图/任意别名', capabilities: ['image_generation','image_edit'] }, { id: 'flux/flux-2' }];
  await fetch(mixed.base + '/readyz'); unavailableFirst = true; result = await send(mixed); assert.equal(result.status, 200); assert.equal(records.at(-1).body.model, 'flux/flux-2'); unavailableFirst = false;
  gatewayStatus = 404; gatewayData = { error: { code: 'model_not_found', message: 'API image model unavailable' } }; result = await send(mixed);
  assert.equal(result.status, 404); assert.equal(JSON.parse(result.raw).error.code, 'image_model_unavailable'); assert.match(JSON.parse(result.raw).error.message, /Official.*Custom image model/);
  checks.push('Known unavailable API candidates can try another image model; when official and all API image models are unavailable, return an error');

  gatewayStatus = 200; gatewayData = { created: 1780000001, data: [{ unexpected: 'invalid output' }] };
  const beforeMalformed = count('gateway'); result = await send(mixed); assert.equal(result.status, 502); assert.equal(JSON.parse(result.raw).error.code, 'invalid_upstream_image_response'); assert.equal(count('gateway'), beforeMalformed + 1);
  checks.push('Accepted but malformed API image output reports its protocol error without generating again on another model');
  assert.deepEqual(imageCandidates([{ id: 'qwen/qwen-image' },{ id: 'generic', supported_endpoints: ['/v1/images/edits'] }], {}, 'edits', 'gpt-image-2', { nativeDefault: true }).map(m => m.id), ['qwen/qwen-image','generic']);
  assert.equal(imageCandidates([{ id: 'vision-chat', output_modalities: ['text'], capabilities: ['vision'] }], {}, 'generations', 'gpt-image-2', { nativeDefault: true }).length, 0);
  assert.equal(imageModelUnavailable(200, { error: { code: 'model_not_found' } }), false);
  assert.equal(imageModelUnavailable(404, { data: [{ b64_json: png }] }), false);
  checks.push('Vision-only chat models are never mistaken for image generators; accepted output is never retried');
  const selection = [{ id: 'gpt-image-2' }, { id: 'qwen-image', capabilities: ['image_generation'] }, { id: 'only-edit', capabilities: ['image_edit'] }];
  const configured = { IMAGE_MODEL: 'qwen-image' };
  assert.equal(imageCandidates(selection, configured, 'generations', 'gpt-image-2', { nativeDefault: true })[0].id, 'qwen-image');
  assert.equal(imageCandidates(selection, configured, 'generations', 'gpt-image-2')[0].id, 'gpt-image-2');
  assert.equal(imageCandidates(selection, configured, 'edits', 'gpt-image-2', { nativeDefault: true })[0].id, 'gpt-image-2');
  assert.throws(() => imageCandidates(selection, configured, 'generations', 'missing-image'), error => error.code === 'no_gateway_image_model');
  assert.throws(() => imageCandidates(selection, configured, 'generations', 'only-edit'), error => error.code === 'unsupported_image_operation');
  checks.push('Native automatic image requests honor the default; explicit Images API model IDs win, and a generation-only default never disables available edit models');
  const report = { passed: true,checks };
  fs.mkdirSync(path.join(root, 'data/diagnostics'), { recursive: true }); fs.writeFileSync(path.join(root, 'data/diagnostics/image-generation-results.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  for (const child of children) if (child.exitCode === null) child.kill();
  for (const socket of sockets) socket.destroy();
  for (const server of servers) { server.close(); server.closeAllConnections?.(); }
}
