import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { startQuotaCompatibleClient, quotaBootstrap } from '../src/native-quota.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-startup-'));
const source = 'export const __rspack_esm_ids=[];export const __webpack_modules__={gate(e,t,n){const{host:w,blocked:E,model:g,limits:T}=n,tk={is:(limits)=>limits.blocked};let u;u="local"===w&&E||(0,tk.is)(T,g);e.result={rateLimitWarningThreshold:50,sendBlocked:u}}};';
fs.mkdirSync(path.join(root, 'data/cache'), { recursive: true });
fs.writeFileSync(path.join(root, 'data/cache/catalog-state.json'), JSON.stringify({ official: [], gatewayIds: ['Gateway/model'] }));
const bytes = Buffer.from(source), header = Buffer.from(JSON.stringify({ files: { webview: { files: { assets: { files: { 'quota.js': { offset: '0', size: bytes.length } } } } } } }));
const prefix = Buffer.alloc(16); prefix.writeUInt32LE(header.length + 8, 4); prefix.writeUInt32LE(header.length, 12);
const archive = path.join(root, 'app.asar'); fs.writeFileSync(archive, Buffer.concat([prefix, header, bytes]));
const cases = { ready: null, notified: null, 'script-error': 'native_script_exception', 'module-error': 'native_module_failed',
  pending: 'native_module_load_timeout', unstarted: 'native_bootstrap_not_started', 'foreign-page': 'native_page_not_attached',
  unresponsive: 'native_command_timeout', exit: ['native_client_exited', 'native_debugger_closed'] };
try {
  for (const [scenario, expected] of Object.entries(cases)) {
    let child; const statuses = [];
    const task = startQuotaCompatibleClient({ executable: 'unused-fixture', archive, root, home: root, startupTimeoutMs: 1200,
      onStatus: value => statuses.push(structuredClone(value)),
      launch: async args => {
        const port = args.find(value => value.startsWith('--remote-debugging-port=')).split('=')[1];
        child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/native-debugger.mjs', import.meta.url)), port, scenario],
          { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
        await once(child, 'spawn'); return child;
      } });
    try {
      if (expected) {
        await assert.rejects(task, error => {
          assert([expected].flat().includes(error.code), scenario + ': ' + error.code + ': ' + error.message);
          return true;
        });
        assert([expected].flat().includes(statuses.at(-1).code), scenario);
        assert.equal(statuses.at(-1).phase, 'failed');
        assert(statuses.at(-1).failurePhase);
        assert(statuses.at(-1).elapsedMs >= 0);
        if (scenario === 'module-error') assert.equal(statuses.at(-1).failedAsset, 'app://-/assets/quota.js');
        if (scenario === 'script-error') assert(statuses.at(-1).failure.message.includes('SyntaxError'));
      } else {
        const client = await task;
        assert.equal(client, child);
        await new Promise(resolve => setTimeout(resolve, 90));
        assert(statuses.at(-1).ready, 'A late incomplete page revoked startup readiness');
      }
    } finally {
      if (child?.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'exit'); }
      child?.stderr?.destroy();
    }
  }
  const key = '__bootstrap_sync_failure';
  const broken = source.replace('export const __webpack_modules__=', 'throw Error("fixture prepare failure");export const __webpack_modules__=');
  new Function(quotaBootstrap([{ source: broken, url: 'data:text/javascript,fixture' }], [], key, key + '_notify'))();
  assert.equal(globalThis[key].error, 'Error: fixture prepare failure');
  assert.equal(globalThis[key].failedAsset, 'data:text/javascript,fixture');
  delete globalThis[key];
} finally { fs.rmSync(root, { recursive: true, force: true }); }
console.log(JSON.stringify({ passed: true, checks: Object.keys(cases).concat('synchronous preparation failure retains asset and cause') }));
