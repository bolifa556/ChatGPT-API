import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, execFileSync } from 'node:child_process';

export function nativeVersion(cli) {
  if (!cli) return '';
  try {
    const text = execFileSync(cli, ['--version'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
    return text.match(/^codex-cli (\d+\.\d+\.\d+)(?:[-+\s]|$)/)?.[1] || '';
  } catch { return ''; }
}

export async function readNativeAccount(cli, home) {
  const child = spawn(cli, ['-c', 'model_provider="openai"', 'app-server', '--stdio'], {
    env: { ...process.env, CODEX_HOME: home }, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
  });
  const pending = new Map(); let sequence = 0, ended = false;
  const send = value => child.stdin.write(JSON.stringify(value) + '\n');
  const fail = error => { ended = true; for (const call of pending.values()) { clearTimeout(call.timer); call.reject(error); } pending.clear(); };
  child.once('error', fail);
  child.once('exit', () => fail(new Error('Native account reader exited.')));
  child.stdin.on('error', fail);
  const lines = readline.createInterface({ input: child.stdout });
  lines.on('line', line => {
    let value; try { value = JSON.parse(line); } catch { return; }
    const call = pending.get(value.id);
    if (call && !value.method) {
      pending.delete(value.id); clearTimeout(call.timer);
      value.error ? call.reject(new Error(value.error.message)) : call.resolve(value.result);
    } else if (value.id !== undefined && value.method) {
      send({ id: value.id, error: { code: -32601, message: 'Only account state is being read.' } });
    }
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    if (ended) { reject(new Error('Native account reader is closed.')); return; }
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Native account reader timed out.')); }, 10000);
    pending.set(id, { resolve, reject, timer }); send({ id, method, params });
  });
  try {
    await rpc('initialize', { clientInfo: { name: 'chatgpt-api-launcher', version: '3.1.3' }, capabilities: {} });
    send({ method: 'initialized', params: {} });
    const account = (await rpc('account/read', { refreshToken: false })).account;
    if (account?.type === 'chatgpt') {
      // Let the native credential/model loader refresh its own model cache.
      // This also works when credentials live in Keychain rather than auth.json.
      try { await rpc('model/list', { includeHidden: true }); } catch {}
    }
    return account;
  } finally {
    fail(new Error('Native account reader stopped.')); child.stdin.end();
    await new Promise(resolve => {
      if (child.exitCode !== null || !child.pid) { resolve(); return; }
      const timer = setTimeout(() => { child.kill(); resolve(); }, 1500);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    lines.close();
  }
}

export async function hasChatGPTLogin(home, cli) {
  try {
    const saved = JSON.parse(fs.readFileSync(path.join(home, 'auth.json'), 'utf8').replace(/^\uFEFF/, ''));
    if ((!saved.auth_mode || saved.auth_mode === 'chatgpt') && saved.tokens?.access_token) return true;
  } catch {}
  if (!cli) return false;
  // Ask the client's own credential loader, including its macOS Keychain store.
  // Do not extract tokens, log in/out, refresh credentials, or start a chat.
  try { return (await readNativeAccount(cli, home))?.type === 'chatgpt'; } catch { return false; }
}
