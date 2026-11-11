import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'quiet-router-'));
const root = fileURLToPath(new URL('../', import.meta.url));
let broken = false, child;
const upstream = http.createServer(async (req, res) => {
  for await (const _chunk of req) {}
  if (req.url.endsWith('/models')) { res.end(JSON.stringify({ data: [{ id: 'gpt-6-sol' }] })); return; }
  if (broken) { req.socket.destroy(); return; }
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ id: 'resp_quiet', object: 'response', status: 'completed', model: 'gpt-6-sol', output: [] }));
});
try {
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const reserve = http.createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
  const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
  fs.mkdirSync(path.join(fixture, 'data/state'), { recursive: true });
  fs.mkdirSync(path.join(fixture, 'home'));
  fs.mkdirSync(path.join(fixture, 'assets'));
  for (const name of ['model-template.json','model-contexts.json','reasoning-levels.json']) fs.copyFileSync(path.join(root, 'assets', name), path.join(fixture, 'assets', name));
  fs.writeFileSync(path.join(fixture, 'data/.env'), 'BASE_URL=http://127.0.0.1:' + upstream.address().port + '/v1\nAPI_KEY=inert-quiet-private-key\nSHIM_PORT=' + port + '\n');
  fs.writeFileSync(path.join(fixture, 'data/state/route-state.json'), JSON.stringify({ mode: 'gateway', entryMode: 'apionly' }));
  const env = { ...process.env, CHATGPT_API_ROOT: fixture, CODEX_HOME: path.join(fixture, 'home') };
  delete env.CHATGPT_API_DEBUG;
  child = spawn(process.execPath, [path.join(root, 'src/shim.mjs')], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', value => output += value); child.stderr.on('data', value => output += value);
  const base = 'http://127.0.0.1:' + port;
  let ready = false;
  for (let n = 0; n < 100 && !ready; n++) {
    try { ready = (await fetch(base + '/readyz')).ok; } catch {}
    if (!ready) await new Promise(resolve => setTimeout(resolve, 30));
  }
  if (!ready) assert.fail(output || 'The isolated router did not become ready');
  const request = () => fetch(base + '/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-6-sol', input: 'PRIVATE_TEST_PROMPT_MUST_NOT_BE_LOGGED', stream: false }) });
  assert.equal((await request()).status, 200);
  const log = path.join(fixture, 'data/logs/shim.log');
  assert(!fs.existsSync(log), 'Successful startup and generation wrote a routine log');
  assert.equal(output, '', 'Successful router emitted console noise');
  broken = true;
  const failed = await request(); assert.equal(failed.status, 502); await failed.text();
  const text = fs.readFileSync(log, 'utf8');
  assert(text.includes('upstream_headers') && text.includes('UND_ERR_SOCKET'), text);
  assert(!text.includes('PRIVATE_TEST_PROMPT_MUST_NOT_BE_LOGGED') && !text.includes('inert-quiet-private-key'));
} finally {
  if (child?.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'exit'); }
  upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
  fs.rmSync(fixture, { recursive: true, force: true });
}
console.log(JSON.stringify({ passed: true, checks: ['successful requests stay silent', 'connection failures retain phase and underlying code', 'no prompt or credential logging'] }));
