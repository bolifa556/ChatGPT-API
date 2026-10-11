// Run the installed, unmodified Codex app-server with ephemeral test threads.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { startLive, delay, classify, saveReport } from './live-support.mjs';

const live = await startLive('native-client-live');
const cli = process.env.CODEX_CLI_PATH || path.join(process.env.LOCALAPPDATA, 'OpenAI/Codex/bin/faa963e871dd422c/codex.exe');
const provider = process.env.PROTOCOL_NATIVE_PROVIDER || 'protocol_probe';
const nativeAccount = process.env.PROTOCOL_NATIVE_OPENAI_AUTH === 'true';
const quote = value => "'" + value.replaceAll("'", "''") + "'";
const clientConfig = [
  'model_provider = ' + quote(provider), 'model_reasoning_effort = "low"', 'approval_policy = "never"', 'sandbox_mode = "read-only"',
  'model_catalog_json = ' + quote(path.join(live.fixture, 'data/cache/models-smr.json')),
  '[model_providers.' + provider + ']', 'name = "Isolated protocol verification"', 'base_url = ' + quote(live.base + '/v1'),
  'wire_api = "responses"', ...(nativeAccount ? ['requires_openai_auth = true', 'supports_websockets = true'] : ['env_key = "PROTOCOL_TEST_API_KEY"', 'requires_openai_auth = false', 'supports_websockets = false']),
  'request_max_retries = 0', 'stream_max_retries = 0', '[analytics]', 'enabled = false', '[history]', 'persistence = "none"', ''
].join('\n');
const report = { at: new Date().toISOString(), nativeVersion: '0.158.0-alpha.2.1', provider, nativeAccount, ephemeral: true, models: [] };
const selected = process.argv.slice(2);
const reportName = process.env.PROTOCOL_REPORT_NAME || (selected.length ? 'protocol-native-client-selected' : 'protocol-native-client');
const homes = [];
try {
  async function checkModel(model) {
    const tag = crypto.createHash('sha256').update(model).digest('hex').slice(0, 12);
    const home = path.join(live.fixture, 'home', tag), cwd = path.join(live.fixture, 'workspace', tag);
    for (const directory of [home, cwd]) fs.mkdirSync(directory, { recursive: true });
    homes.push(home); fs.writeFileSync(path.join(home, 'config.toml'), clientConfig);
    // Native account mode can make background OpenAI requests independently of
    // the router. Never put an external API key in its OAuth token slot.
    if (nativeAccount) fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'inert-isolated-native-account', account_id: 'isolated-protocol-account' } }));
    console.log(JSON.stringify({ model, phase: 'native_client_begin' }));
    const row = { model, toolCalls: [] }; report.models.push(row);
    const marker = 'NATIVE_' + crypto.randomBytes(6).toString('hex');
    const file = path.join(cwd, 'protocol-marker.txt'); fs.writeFileSync(file, marker);
    const child = spawn(cli, ['app-server','--stdio'], { cwd, env: { ...process.env, CODEX_HOME: home, PROTOCOL_TEST_API_KEY: live.key }, windowsHide: true, stdio: ['pipe','pipe','pipe'] });
    const pending = new Map(), notifications = []; let serial = 0, stderr = '';
    child.stderr.on('data', chunk => { if (stderr.length < 20000) stderr += chunk.toString(); });
    const lines = readline.createInterface({ input: child.stdout });
    function send(value) { if (!child.stdin.destroyed) child.stdin.write(JSON.stringify(value) + '\n'); }
    lines.on('line', line => {
      let value; try { value = JSON.parse(line); } catch { return; }
      if (value.id !== undefined && !value.method) {
        const request = pending.get(value.id); if (!request) return;
        pending.delete(value.id); clearTimeout(request.timer);
        value.error ? request.reject(new Error(value.error.message)) : request.resolve(value.result); return;
      }
      if (value.method && value.id !== undefined) {
        if (value.method === 'item/tool/call') {
          const p = value.params, valid = p.namespace === 'audit' && p.tool === 'read_fixture' && p.arguments?.n === 19 && p.arguments?.enabled === true;
          row.toolCalls.push({ namespace: p.namespace, tool: p.tool, arguments: p.arguments, valid });
          send({ id: value.id, result: { success: valid, contentItems: [{ type: 'inputText', text: valid ? fs.readFileSync(file, 'utf8') : 'Unexpected protocol test arguments.' }] } });
        } else send({ id: value.id, error: { code: -32601, message: 'This isolated test does not provide ' + value.method } });
        return;
      }
      notifications.push(value);
    });
    function rpc(method, params) {
      return new Promise((resolve, reject) => {
        const id = ++serial, timer = setTimeout(() => { pending.delete(id); reject(new Error('Native RPC timed out: ' + method)); }, 20000);
        pending.set(id, { resolve, reject, timer }); send({ id, method, params });
      });
    }
    async function waitAfter(offset, predicate, timeout = 150000) {
      const end = Date.now() + timeout;
      while (Date.now() < end) {
        const item = notifications.slice(offset).find(predicate); if (item) return item;
        if (child.exitCode !== null) throw new Error('Native app-server exited: ' + stderr.slice(-500));
        await delay(50);
      }
      const error = notifications.slice(offset).filter(value => value.method === 'error').at(-1);
      throw new Error(error?.params?.error?.message || error?.params?.message || 'Native turn timed out');
    }
    let threadId;
    async function nativeTurn(text) {
      const offset = notifications.length;
      const started = await rpc('turn/start', { threadId, effort: 'low', input: [{ type: 'text', text }] });
      const completed = await waitAfter(offset, value => value.method === 'turn/completed' && value.params?.turn?.id === started.turn.id);
      if (completed.params.turn.status !== 'completed') throw new Error(completed.params.turn.error?.message || 'Native turn status: ' + completed.params.turn.status);
      return notifications.slice(offset).filter(value => value.method === 'item/completed' && value.params?.item?.type === 'agentMessage').map(value => value.params.item.text).join('\n');
    }
    try {
      await rpc('initialize', { clientInfo: { name: 'protocol-verification', version: '1' }, capabilities: { experimentalApi: true } }); send({ method: 'initialized', params: {} });
      const started = await rpc('thread/start', { model, modelProvider: provider, cwd, ephemeral: true, approvalPolicy: 'never', sandbox: 'read-only',
        dynamicTools: [{ type: 'namespace', name: 'audit', description: 'Local read-only protocol verification.', tools: [{ type: 'function', name: 'read_fixture',
          description: 'Read the test fixture. Pass n=19 and enabled=true.', inputSchema: { type: 'object', properties: { n: { type: 'integer' }, enabled: { type: 'boolean' } }, required: ['n','enabled'], additionalProperties: false } }] }] });
      threadId = started.thread.id;
      const first = await nativeTurn('Call audit.read_fixture with n=19 and enabled=true, then reply only with the exact marker it returns. Do not run commands or change files.');
      row.native_tool = { status: row.toolCalls.some(call => call.valid) ? 'passed' : 'excluded_model_output', markerReturned: first.includes(marker) };
      row.tool_result_reply = { status: first.includes(marker) ? 'passed' : 'excluded_model_output' };
      if (row.tool_result_reply.status !== 'passed') {
        const upstream = live.records.filter(record => record.body?.model === model).at(-1);
        row.toolDiagnostics = { text: first.slice(0, 600), upstreamTools: upstream?.body?.tools?.map(tool => ({ type: tool.type, name: tool.function?.name || tool.name })), nativeItems: notifications.filter(value => value.method === 'item/completed').map(value => value.params?.item) };
        saveReport('protocol-native-tool-diagnostics', { model, upstream, notifications });
      }
      console.log(JSON.stringify({ model, phase: 'native_tool', ...row.native_tool, toolCalls: row.toolCalls.length }));
      if (!first.includes(marker)) {
        // Keep compression verification independent of a model refusing or
        // failing the earlier tool check. This input exists only in the fixture.
        await nativeTurn('For this isolated compaction check, remember this exact marker: ' + marker + '. Reply only with the marker and do not call tools.');
        row.compactionMarkerSeededByFixture = true;
      }
      const offset = notifications.length, before = live.records.length;
      await rpc('thread/compact/start', { threadId });
      const compacted = await waitAfter(offset, value => value.method === 'turn/completed' && value.params?.threadId === threadId);
      if (compacted.params.turn.status !== 'completed') throw new Error(compacted.params.turn.error?.message || 'Native compaction failed');
      const nativeItem = notifications.slice(offset).some(value => value.method === 'thread/compacted' || (value.method === 'item/completed' && value.params?.item?.type === 'contextCompaction'));
      const requests = live.records.slice(before).filter(record => record.body?.model === model);
      row.native_compaction = { status: nativeItem ? 'passed' : 'needs_review', nativeCompactionEvent: nativeItem, requestCount: requests.length,
        clientSuppliedCompactionPrompt: requests.some(record => JSON.stringify(record.body).includes('CONTEXT CHECKPOINT COMPACTION')) };
      const after = await nativeTurn('What exact marker did audit.read_fixture return before compaction? Reply only the marker. Do not call tools.');
      row.after_compaction = { status: after.includes(marker) ? 'passed' : 'needs_review', markerRetained: after.includes(marker) };
      row.itemTypes = [...new Set(notifications.filter(value => value.method === 'item/completed').map(value => value.params?.item?.type))];
    } catch (error) {
      row.failure = { status: classify(error), error: error.message.slice(0, 600) };
      row.diagnostics = notifications.filter(value => value.method === 'error').slice(-2).map(value => value.params?.error?.message || value.params?.message);
      row.nativeStderr = stderr.slice(-600);
    } finally {
      for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('Test client stopped')); }
      child.kill(); lines.close();
    }
    console.log(JSON.stringify(row)); saveReport(reportName, report);
  }
  const queue = live.models.filter(model => !selected.length || selected.some(value => model.includes(value)));
  await Promise.all(Array.from({ length: Math.min(3, queue.length) }, async () => { while (queue.length) await checkModel(queue.shift()); }));
} finally {
  report.nativeConfigAndAuthUnchanged = await live.close();
  report.persistedSessionFiles = homes.reduce((count, home) => count + (fs.existsSync(path.join(home, 'sessions')) ? fs.readdirSync(path.join(home, 'sessions')).length : 0), 0);
  saveReport(reportName, report);
}
