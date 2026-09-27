// Opt-in integration helpers. Credentials remain in memory; test routers and
// native clients use isolated directories and never change the user's profile.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { request } from 'undici';
import WebSocket from 'ws';
import { ResponseOutput } from '../src/history-compat.mjs';

export const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export function classify(error) {
  const text = error?.message || String(error);
  if (/failed to parse Response|missing field|unsupported_chat_format|invalid_upstream_tool_arguments/i.test(text)) return 'adapter_or_upstream_format_needs_review';
  if (/timeout|timed out|socket|TLS|ECONN|fetch failed|connect|429|rate.limit|限流|overloaded|high demand|502|503|504/i.test(text)) return 'excluded_network_or_service';
  if (/reasoning.effort|reasoning_effort|thinking.*(?:unsupported|invalid)|effort.*(?:unsupported|invalid)/i.test(text)) return 'excluded_reasoning_effort';
  if (/not support|unsupported|not available|does not allow|not one of|不支持|unavailable|unknown parameter|stream.*must.*true/i.test(text)) return 'excluded_upstream_capability';
  return 'needs_review';
}
export async function startLive(label) {
  const fixture = path.join(root, 'data/testing', label + '-' + process.pid);
  for (const directory of ['assets','data/cache','data/state','home','workspace']) fs.mkdirSync(path.join(fixture, directory), { recursive: true });
  const env = Object.fromEntries(fs.readFileSync(path.join(root, 'data/.env'), 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)
    .filter(line => line.includes('=')).map(line => [line.slice(0, line.indexOf('=')).trim(), line.slice(line.indexOf('=') + 1).trim()]));
  const records = [], sockets = new Set();
  const proxy = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const record = { path: req.url, body: body.length ? JSON.parse(body) : null, output: '' }; records.push(record);
    try {
      const headers = { ...req.headers }; delete headers.host; delete headers.connection;
      const upstream = await request(env.BASE_URL.replace(/\/+$/, '') + req.url.replace(/^\/v1/, ''), { method: req.method, body: body.length ? body : undefined, headers, headersTimeout: 120000, bodyTimeout: 120000 });
      const outgoing = { ...upstream.headers }; delete outgoing.connection; delete outgoing['transfer-encoding'];
      record.status = upstream.statusCode; res.writeHead(upstream.statusCode, outgoing);
      for await (const chunk of upstream.body) { if (record.output.length < 4 * 1024 * 1024) record.output += chunk.toString(); if (!res.destroyed) res.write(chunk); }
      res.end();
    } catch (error) {
      record.error = error.message;
      if (!res.headersSent) { res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: error.message } })); }
      else res.destroy();
    }
  });
  proxy.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
  const gatewayBase = 'http://127.0.0.1:' + proxy.address().port + '/v1';
  const reserve = http.createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
  const base = 'http://127.0.0.1:' + reserve.address().port; await new Promise(resolve => reserve.close(resolve));
  for (const name of ['model-template.json','reasoning-levels.json']) fs.copyFileSync(path.join(root, 'assets', name), path.join(fixture, 'assets', name));
  for (const name of ['models-smr.json','models-gateway.json','reasoning-levels.json']) fs.copyFileSync(path.join(root, 'data/cache', name), path.join(fixture, 'data/cache', name));
  const catalog = JSON.parse(fs.readFileSync(path.join(root, 'data/cache/catalog-state.json'), 'utf8'));
  catalog.sourceId = crypto.createHash('sha256').update(gatewayBase + '\n' + env.API_KEY).digest('hex');
  fs.writeFileSync(path.join(fixture, 'data/cache/catalog-state.json'), JSON.stringify(catalog));
  fs.copyFileSync(path.join(root, 'data/state/route-state.json'), path.join(fixture, 'data/state/route-state.json'));
  const nativeHome = process.env.CODEX_HOME || path.join(process.env.USERPROFILE, '.codex');
  const watched = ['config.toml','auth.json'].map(name => path.join(nativeHome, name));
  const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const before = watched.map(digest);
  const child = spawn(process.execPath, [path.join(root, 'src/shim.mjs')], { env: { ...process.env, CODEX_HOME: nativeHome,
    CHATGPT_API_ROOT: fixture, CHATGPT_API_ENV_PATH: path.join(root, 'data/.env'), CHATGPT_GATEWAY_BASE: gatewayBase, CHATGPT_SHIM_PORT: new URL(base).port },
    windowsHide: true, stdio: ['ignore','ignore','pipe'] });
  let stderr = ''; child.stderr.on('data', value => stderr += value.toString());
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error('Test router exited: ' + stderr.slice(0, 300));
    try { if ((await (await fetch(base + '/healthz')).json()).compatibilityVersion === 2) break; } catch {}
    await delay(50);
  }
  return { base, fixture, records, models: catalog.gatewayIds, key: env.API_KEY,
    async close() {
      child.kill(); for (const socket of sockets) socket.destroy(); proxy.close();
      return watched.map(digest).every((value, index) => value === before[index]);
    } };
}
export async function connect(base) {
  const ws = new WebSocket(base.replace('http:', 'ws:') + '/v1/responses', { headers: { originator: 'codex_cli_rs', 'openai-beta': 'responses_websockets=2026-02-06' } });
  ws.on('error', () => {}); await once(ws, 'open'); return ws;
}
export function turn(ws, body, timeout = 120000) {
  return new Promise((resolve, reject) => {
    const output = new ResponseOutput(), events = []; let text = '', settled = false;
    const timer = setTimeout(() => finish(new Error('Live request timed out')), timeout);
    function finish(error, value) { if (settled) return; settled = true; clearTimeout(timer); ws.off('message', receive); ws.off('close', closed); error ? reject(error) : resolve(value); }
    function closed() { finish(new Error('Client connection closed')); }
    function receive(bytes) {
      const event = JSON.parse(bytes); events.push(event); output.observe(event);
      if (event.type === 'response.output_text.delta') text += event.delta || '';
      if (event.type === 'error' || event.type === 'response.failed') {
        const error = event.error || event.response?.error || {};
        finish(Object.assign(new Error(error.message || event.message || event.type), { code: error.code, status: event.status }));
      }
      if (['response.completed','response.incomplete'].includes(event.type)) {
        const items = output.finish(event.response.output).output;
        finish(null, { response: { ...event.response, output: items }, text: text || items.filter(item => item.type === 'message').flatMap(item => item.content || []).map(part => part.text || '').join(''), events });
      }
    }
    ws.on('message', receive); ws.on('close', closed);
    ws.send(JSON.stringify({ type: 'response.create', store: false, ...body }));
  });
}
export function saveReport(name, report) {
  const directory = path.join(root, 'data/diagnostics'); fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, name + '.json'), JSON.stringify(report, null, 2));
}
