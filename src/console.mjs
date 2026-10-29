import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { GatewaySources } from './gateway-sources.mjs';
import { readEnvFile, readSettings, publicSettings, saveSettings, settingsRevision, atomicPrivate, overrideKey, redact } from './settings.mjs';
import { rememberContexts, contextKey, applyContext } from './model-context.mjs';
import { imageOnlyModel } from './image-compat.mjs';

const moduleRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const readJson = (file, fallback = null) => { try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return fallback; } };
const json = (res, status, value) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
export function openBrowser(url) {
  const command = process.platform === 'win32' ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  const child = execFile(command[0], command[1], { windowsHide: true }, () => {}); child.unref();
}
async function requestBody(req) {
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > 256 * 1024) throw Object.assign(new Error('配置内容过大。'), { status: 413 }); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw Object.assign(new Error('配置必须是有效的 JSON。'), { status: 400 }); }
}
export async function startConsole({ root = process.env.CHATGPT_API_ROOT || moduleRoot, open = true, opener = openBrowser } = {}) {
  root = path.resolve(root);
  let env = readEnvFile(path.join(root, 'data/.env'));
  const version = readJson(path.join(root, 'package.json'), { version: '3.1.5' }).version;
  const identity = crypto.createHash('sha256').update(root).digest('hex');
  const stateFile = path.join(root, 'data/state/console.json');
  const previous = readJson(stateFile);
  if (previous?.port && previous?.token) {
    try {
      const response = await fetch('http://127.0.0.1:' + Number(previous.port) + '/api/ping', { headers: { authorization: 'Bearer ' + previous.token }, signal: AbortSignal.timeout(700) });
      const state = await response.json();
      if (state.service === 'chatgpt-api-console' && state.identity === identity && state.version === version) {
        const url = 'http://127.0.0.1:' + previous.port + '/#' + previous.token;
        if (open) opener(url);
        return { reused: true, url, close: async () => {} };
      }
    } catch {}
  }
  let settings = readSettings(root, env), refresh = null;
  const token = crypto.randomBytes(32).toString('hex');
  const assetRoot = path.join(root, 'assets/console');
  async function runtime() {
    try {
      const port = Number(env.SHIM_PORT || 8102);
      const health = await (await fetch('http://127.0.0.1:' + port + '/healthz', { signal: AbortSignal.timeout(600) })).json();
      if (health.service !== 'chatgpt-api-router') return { running: false };
      return { running: true, entryMode: health.entryMode, mode: health.mode, officialModels: health.officialModels, gatewayModels: health.gatewayModels,
        configurationId: health.configurationId, restartRequired: health.configurationId !== settingsRevision(settings) };
    } catch { return { running: false }; }
  }
  function models(pool) {
    const known = readJson(path.join(root, 'assets/model-contexts.json'), {});
    const template = readJson(path.join(root, 'assets/model-template.json'), {}).models?.[0] || { context_window: 128000 };
    const capacities = new Map();
    for (const profile of pool.profiles()) {
      if (!profile.baseUrl) continue;
      capacities.set(profile.id, rememberContexts({ file: path.join(root, 'data/cache/model-contexts.json'), base: profile.baseUrl,
        models: pool.models.filter(model => model._providerId === profile.id && !imageOnlyModel(model)).map(model => ({ ...model, id: model._upstreamId })), known }));
    }
    return pool.models.map(model => {
      const profile = pool.profile(model._providerId), record = capacities.get(profile.id)?.entries[contextKey(profile.baseUrl, model._upstreamId)];
      const key = overrideKey(profile.id, model._upstreamId), resolved = applyContext({ ...template }, record, { limit: settings.contextLimit, override: settings.contextOverrides[key] });
      return { id: model.id, name: model._upstreamId, providerId: profile.id, providerName: profile.name, overrideKey: key, kind: imageOnlyModel(model) ? 'image' : 'chat',
        capacity: record?.capacity || null, capacitySource: record?.source || 'unreported', fallbackCapacity: template.context_window, limit: resolved.context_window,
        effectivePercent: resolved.effective_context_window_percent ?? 95,
        effective: Math.floor(resolved.context_window * (resolved.effective_context_window_percent ?? 95) / 100) };
    });
  }
  async function state() {
    env = readEnvFile(path.join(root, 'data/.env'));
    settings = readSettings(root, env);
    const pool = new GatewaySources(root, env);
    try {
      pool.loadCached(readJson(path.join(root, 'data/cache/catalog-state.json'), {}));
      const statuses = pool.saved.statuses || [];
      return { version, configurationSaved: fs.existsSync(path.join(root, 'data/providers.json')), settings: publicSettings(settings), models: models(pool), runtime: await runtime(),
        sources: settings.providers.map(profile => {
          const cached = pool.sources.find(item => item.id === profile.id);
          const { fingerprint, ...status } = statuses.find(item => item.id === profile.id && item.fingerprint === pool.identity(profile)) || { ready: false, cached: Boolean(cached), models: cached?.models.length || 0 };
          return { id: profile.id, ...status };
        }),
        note: '启动 API 入口时会检索全部启用来源；运行期间不定时轮询。设置及模型菜单在完全退出并重开客户端后应用。' };
    } finally { pool.destroy(); }
  }
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const authority = '127.0.0.1:' + server.address().port;
    res.setHeader('x-content-type-options', 'nosniff'); res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    if (req.headers.host !== authority || req.headers.origin && req.headers.origin !== 'http://' + authority) return json(res, 403, { error: '仅允许控制台本机页面访问。' });
    try {
      if (url.pathname.startsWith('/api/')) {
        if (req.headers.authorization !== 'Bearer ' + token) return json(res, 401, { error: '控制台连接已失效，请重新打开控制台。' });
        if (req.method === 'GET' && url.pathname === '/api/ping') return json(res, 200, { service: 'chatgpt-api-console', version, identity });
        if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, await state());
        if (req.method === 'POST' && url.pathname === '/api/settings') {
          if (!String(req.headers['content-type']).startsWith('application/json')) return json(res, 415, { error: '需要 JSON 配置。' });
          const value = await requestBody(req);
          env = readEnvFile(path.join(root, 'data/.env'));
          settings = saveSettings(root, value, env); return json(res, 200, await state());
        }
        if (req.method === 'POST' && url.pathname === '/api/refresh') {
          if (!refresh) refresh = (async () => {
            env = readEnvFile(path.join(root, 'data/.env'));
            const pool = new GatewaySources(root, env, { transport: env.GATEWAY_TRANSPORT || 'direct', tunnelPort: Number(env.GATEWAY_TUNNEL_PORT || 18003) });
            try { pool.loadCached(readJson(path.join(root, 'data/cache/catalog-state.json'), {})); await pool.discover(); }
            finally { await pool.close(); }
          })().finally(() => { refresh = null; });
          await refresh; return json(res, 200, await state());
        }
        if (req.method === 'POST' && url.pathname === '/api/close') { json(res, 200, { closed: true }); setTimeout(() => server.close(), 50).unref(); return; }
        return json(res, 404, { error: '未找到操作。' });
      }
      if (req.method !== 'GET') return json(res, 405, { error: '不支持此请求。' });
      const assets = { '/': ['index.html', 'text/html; charset=utf-8'], '/console.css': ['console.css', 'text/css; charset=utf-8'], '/console.js': ['console.js', 'text/javascript; charset=utf-8'], '/icon.svg': ['icon.svg', 'image/svg+xml'] };
      const asset = assets[url.pathname]; if (!asset) return json(res, 404, { error: '未找到页面。' });
      res.writeHead(200, { 'content-type': asset[1], 'cache-control': 'no-store' }); res.end(fs.readFileSync(path.join(assetRoot, asset[0])));
    } catch (error) { json(res, error.status || 400, { error: redact(error.message, settings, [env.API_KEY]) }); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port, url = 'http://127.0.0.1:' + port + '/#' + token;
  atomicPrivate(stateFile, { pid: process.pid, port, token, version, identity });
  server.on('close', () => { if (readJson(stateFile)?.token === token) fs.rmSync(stateFile, { force: true }); });
  if (open) opener(url);
  return { server, url, close: () => new Promise(resolve => server.close(resolve)) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  startConsole({ open: !process.argv.includes('--no-open') }).catch(error => { console.error('无法打开控制台，请检查安装目录中的配置文件和运行时。'); process.exitCode = 1; });
}
