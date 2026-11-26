import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { startQuotaCompatibleClient, quotaBootstrap, quotaWarningMessage } from '../src/native-quota.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-startup-'));
const clientVersion = '26.1106.6628.0';
const archiveDirectory = path.join(root, `OpenAI.Codex_${clientVersion}_x64__2p2nqsd0c76g0`, 'app', 'resources');
fs.mkdirSync(archiveDirectory, { recursive: true });
const source = 'export const __rspack_esm_ids=[];export const __webpack_modules__={gate(e,t,n){const{host:w,blocked:E,model:g,limits:T}=n,tk={is:(limits)=>limits.blocked};let u;u="local"===w&&E||(0,tk.is)(T,g);e.result={rateLimitWarningThreshold:50,sendBlocked:u}}};';
fs.mkdirSync(path.join(root, 'data/cache'), { recursive: true });
fs.writeFileSync(path.join(root, 'data/cache/catalog-state.json'), JSON.stringify({ official: [], gatewayIds: ['Gateway/model'] }));
function writeArchive(name, entries) {
  const files = {}, chunks = []; let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const bytes = Buffer.from(text);
    files[name] = { offset: String(offset), size: bytes.length }; chunks.push(bytes); offset += bytes.length;
  }
  const header = Buffer.from(JSON.stringify({ files: { webview: { files: { assets: { files } } } } }));
  const prefix = Buffer.alloc(16); prefix.writeUInt32LE(header.length + 8, 4); prefix.writeUInt32LE(header.length, 12);
  const file = path.join(archiveDirectory, name); fs.writeFileSync(file, Buffer.concat([prefix, header, ...chunks])); return file;
}
const archive = writeArchive('app.asar', { 'quota.js': source });
const updatedArchive = writeArchive('updated.asar', { 'unrecognized.js': 'const other = true;' });
const partialArchive = writeArchive('partial.asar', { 'quota.js': source, 'changed.js': source.replace('__webpack_modules__', '__new_modules__') });
const context = 'export const __webpack_modules__={ctx:function(e,t,n){let selected=(0,hooks.i1)(scope.u,(thread,{get:read})=>read(settings,thread)?.model??null),usage=(0,store.tv)("tokenUsageInfo"),selector=(0,hooks.i1)(scope.u,(thread,{get:read})=>null==thread?null:read(usage,{hostId:read(hosts.qX,thread),threadId:thread}));return selector}};';
const fast = 'export const __webpack_modules__={fast(e,t,n){const p=host,m=(0,i.tn)(p),h=m?.authMethod==="chatgpt"||m?.authMethod==="personalAccessToken"||m?.authMethod==="amazonBedrock";return{serviceTierAccess:h}}};';
const runtimePartialArchive = writeArchive('runtime-partial.asar', { 'quota.js': source, 'context.js': context, 'fast.js': fast });
const cases = { ready: 'ready', notified: 'ready', 'script-error': 'native_command_failed', 'module-error': 'native_module_import_failed',
  'partial-module-error': 'native_module_changed', 'updated-module-format': 'native_module_format',
  pending: 'native_module_load_timeout', unstarted: 'native_bootstrap_not_started', 'foreign-page': 'native_page_not_attached',
  unresponsive: 'native_command_timeout', exit: 'exit', 'missing-archive': 'ENOENT', 'updated-renderer': 'native_ui_unsupported' };
try {
  for (const [scenario, expected] of Object.entries(cases)) {
    let child, debugArgs, finish;
    const status = new Promise(resolve => { finish = resolve; });
    const statuses = [], warnings = [];
    try {
      const client = await startQuotaCompatibleClient({ executable: 'unused-fixture',
        archive: { 'missing-archive': archive + '.missing', 'updated-renderer': updatedArchive,
          'updated-module-format': partialArchive, 'partial-module-error': runtimePartialArchive }[scenario] || archive,
        root, home: root, startupTimeoutMs: 1500,
        onStatus: value => {
          statuses.push(structuredClone(value));
          if (['ready', 'degraded', 'stopped'].includes(value.phase)) finish(value);
        },
        onWarning: value => warnings.push(value),
        launch: async args => {
          debugArgs = args;
          const port = args.find(value => value.startsWith('--remote-debugging-port='))?.split('=')[1];
          child = port
            ? spawn(process.execPath, [fileURLToPath(new URL('./fixtures/native-debugger.mjs', import.meta.url)), port, scenario], { windowsHide: true, stdio: 'ignore' })
            : spawn(process.execPath, ['-e', 'setInterval(() => {}, 500)'], { windowsHide: true, stdio: 'ignore' });
          await once(child, 'spawn'); return child;
        } });
      assert.equal(client, child);
      assert(statuses.every(value => value.clientVersion === clientVersion), 'Startup status lost the Windows package version');
      assert(!statuses.some(value => value.ready), 'Native startup waited on UI compatibility');
      if (scenario === 'exit') {
        assert.equal((await once(child, 'exit'))[0], 17);
        await status;
        assert.equal(warnings.length, 0, 'A native process exit emitted a compatibility warning');
        continue;
      }
      const final = await status;
      if (expected === 'ready') {
        assert(final.ready, scenario);
        await new Promise(resolve => setTimeout(resolve, 110));
        assert(statuses.at(-1).ready, 'A late incomplete page revoked UI readiness');
        assert.equal(warnings.length, 0);
      } else {
        assert.equal(final.phase, 'degraded', scenario);
        assert.equal(final.code, expected, scenario);
        assert(final.failurePhase);
        assert.equal(child.exitCode, null, 'UI compatibility failure stopped the native client');
        assert.equal(child.signalCode, null, 'UI compatibility failure terminated the native client');
        assert.equal(warnings.length, 1, 'A degraded compatibility attempt must warn exactly once');
        const warning = quotaWarningMessage(warnings[0]);
        assert(warning.includes(clientVersion));
        assert(warning.includes(final.failures[0].reason));
        if (['updated-module-format', 'partial-module-error'].includes(scenario)) {
          assert(final.ready && final.installed === 1, 'A failed asset prevented independent compatible assets from loading');
        }
        if (['missing-archive', 'updated-renderer'].includes(scenario)) assert.deepEqual(debugArgs, []);
        if (scenario === 'module-error') assert.equal(final.failedAsset, 'app://-/assets/quota.js');
        if (scenario === 'partial-module-error') {
          assert.equal(final.errors, 2);
          assert.deepEqual(final.failures.map(failure => [failure.code, failure.asset, failure.features]), [
            ['native_module_changed', 'app://-/assets/context.js', ['context']],
            ['native_module_import_failed', 'app://-/assets/fast.js', ['fast']],
          ]);
          assert.match(warning, /上下文容量/);
          assert.match(warning, /小闪电/);
          assert.doesNotMatch(warning, /额度用完|发送按钮/);
        }
      }
    } finally {
      if (child?.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'exit'); }
    }
  }
  const key = '__bootstrap_sync_failure';
  const broken = source.replace('export const __webpack_modules__=', 'throw Error("fixture prepare failure");export const __webpack_modules__=');
  const notices = [];
  globalThis[key + '_notify'] = value => notices.push(JSON.parse(value));
  try {
    new Function(quotaBootstrap([{ source: broken, url: 'data:text/javascript,fixture' }], [], key, key + '_notify'))();
    assert.deepEqual(notices.at(-1).failure, { code: 'native_module_prepare_failed', message: 'Error: fixture prepare failure', asset: 0 });
  } finally { delete globalThis[key]; delete globalThis[key + '_notify']; }
} finally { fs.rmSync(root, { recursive: true, force: true }); }
console.log(JSON.stringify({ passed: true, checks: Object.keys(cases).concat('synchronous preparation failure retains asset and cause') }));
