// Use the native session API to correct provider metadata. Never edit rollout
// files, send a chat message, invoke compaction, or construct replacement history.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function repairThreadProviders({ cli, home, gatewayIds, officialIds = [], provider, ids, dryRun = false }) {
  const models = new Set(gatewayIds.filter(id => !officialIds.includes(id)));
  const officialModels = new Set(officialIds);
  const managedProviders = new Set(['openai', 'chatgpt_api_launcher', 'chatgpt_api_mixed', 'smr']);
  const child = spawn(cli, ['app-server', '--stdio'], { env: { ...process.env, CODEX_HOME: home }, windowsHide: true, stdio: ['pipe','pipe','pipe'] });
  const pending = new Map(); let sequence = 0;
  child.stderr.resume();
  const send = value => child.stdin.write(JSON.stringify(value) + '\n');
  const lines = readline.createInterface({ input: child.stdout });
  function abort(error) { for (const call of pending.values()) { clearTimeout(call.timer); call.reject(error); } pending.clear(); }
  child.on('error', abort);
  child.on('exit', code => abort(new Error('Native provider repair process exited: ' + code)));
  lines.on('line', line => {
    let value; try { value = JSON.parse(line); } catch { return; }
    const call = pending.get(value.id);
    if (call && !value.method) {
      pending.delete(value.id); clearTimeout(call.timer);
      value.error ? call.reject(new Error(value.error.message)) : call.resolve(value.result);
    } else if (value.id !== undefined && value.method) {
      // A metadata repair must never approve or execute a model/tool operation.
      send({ id: value.id, error: { code: -32601, message: 'Provider repair only supports native session metadata operations.' } });
    }
  });
  function rpc(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error('Native provider repair timed out: ' + method)); }, 20000);
      pending.set(id, { resolve, reject, timer }); send({ id, method, params });
    });
  }
  const result = { dryRun, provider, candidates: [], repaired: [], failed: [] };
  try {
    await rpc('initialize', { clientInfo: { name: 'chatgpt-api-provider-repair', version: '1' }, capabilities: { experimentalApi: true } });
    send({ method: 'initialized', params: {} });
    let threads = [];
    if (ids) {
      for (const threadId of ids) threads.push((await rpc('thread/read', { threadId })).thread);
    } else {
      let cursor;
      do {
        const page = await rpc('thread/list', { limit: 100, modelProviders: [...managedProviders], archived: false, useStateDbOnly: true, ...(cursor ? { cursor } : {}) });
        threads.push(...page.data); cursor = page.nextCursor;
      } while (cursor);
    }
    for (const thread of threads) {
      if (!managedProviders.has(thread.modelProvider)) continue;
      const targetProvider = officialModels.has(thread.model) ? 'openai' : thread.modelProvider === 'openai' && models.has(thread.model) ? provider : null;
      if (!targetProvider || thread.modelProvider === targetProvider) continue;
      const item = { threadId: thread.id, model: thread.model, previousProvider: thread.modelProvider, targetProvider };
      result.candidates.push(item);
      if (dryRun) continue;
      try {
        const resumed = await rpc('thread/resume', { threadId: thread.id, model: thread.model, modelProvider: targetProvider, excludeTurns: true });
        if (resumed.thread.id !== thread.id || resumed.modelProvider !== targetProvider || resumed.model !== thread.model) throw new Error('Native session did not retain its ID/model and apply the requested provider.');
        await rpc('thread/unsubscribe', { threadId: thread.id });
        result.repaired.push(item);
      } catch (error) { result.failed.push({ ...item, error: error.message }); }
    }
    return result;
  } finally {
    abort(new Error('Provider repair stopped'));
    child.stdin.end();
    await new Promise(resolve => {
      if (child.exitCode !== null) { resolve(); return; }
      const timer = setTimeout(() => { child.kill(); resolve(); }, 3000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    lines.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [cli, home, root, provider] = process.argv.slice(2);
  try {
    if (!cli || !home || !root || !provider) throw new Error('Expected native CLI path, CODEX_HOME, installer root and provider.');
    const catalog = JSON.parse(fs.readFileSync(path.join(root, 'data/cache/catalog-state.json'), 'utf8'));
    const result = await repairThreadProviders({ cli, home, provider, gatewayIds: catalog.gatewayIds, officialIds: (catalog.official || []).map(model => model.slug) });
    const report = path.join(root, 'data/state/provider-repair-result.json');
    fs.mkdirSync(path.dirname(report), { recursive: true });
    fs.writeFileSync(report, JSON.stringify({ at: new Date().toISOString(), ...result }, null, 2));
    console.log(JSON.stringify({ repaired: result.repaired.length, failed: result.failed.length }));
    if (result.failed.length) process.exitCode = 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
