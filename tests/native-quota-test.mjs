import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scopeNativeQuota, quotaBootstrap, gatewayQuotaModels, nativeQuotaAssets } from '../src/native-quota.mjs';

const key = '__quota_test_' + Date.now();
const source = 'export const __rspack_esm_ids=[];export const __webpack_modules__={gate(e,t,n){const{host:w,blocked:E,model:g,limits:T}=n,tk={is:(limits)=>limits.blocked};let u;u="local"===w&&E||(0,tk.is)(T,g);e.result={rateLimitWarningThreshold:50,sendBlocked:u}}};';
const catalog = { official: [{ slug: 'official' }], gatewayIds: ['Gateway/model', 'official'] };
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'native-ui-index-'));
const archive = path.join(fixture, 'app.asar'), index = path.join(fixture, 'index.json');
function writeArchive(text) {
  const data = Buffer.from(text), header = Buffer.from(JSON.stringify({ files: { webview: { files: { assets: { files: { 'quota.js': { size: data.length, offset: '0' } } } } } } }));
  const prefix = Buffer.alloc(16); prefix.writeUInt32LE(header.length + 8, 4); prefix.writeUInt32LE(header.length, 12);
  fs.writeFileSync(archive, Buffer.concat([prefix, header, data]));
}
try {
  writeArchive(source);
  const cold = nativeQuotaAssets(archive, index), saved = fs.statSync(index).mtimeMs;
  assert.deepEqual(nativeQuotaAssets(archive, index), cold);
  assert.equal(fs.statSync(index).mtimeMs, saved, 'An unchanged native client rescanned or rewrote its UI index');
  writeArchive(source + '\n// new native version');
  assert(nativeQuotaAssets(archive, index)[0].source.endsWith('new native version'));
  fs.writeFileSync(index, 'interrupted optional cache write');
  assert.equal(nativeQuotaAssets(archive, index).length, 1);
} finally { fs.unlinkSync(archive); fs.unlinkSync(index); fs.rmdirSync(fixture); }
assert.deepEqual(gatewayQuotaModels(catalog), ['Gateway/model']);
assert.deepEqual(gatewayQuotaModels(catalog, 'gateway'), ['Gateway/model', 'official'], 'Pure API models must retain quota/Fast compatibility when their names match an official model');
assert.equal(scopeNativeQuota(source, key).count, 1);
assert.equal(scopeNativeQuota('const ordinary="local"===w&&E||(0,tk.is)(T,g);', key).count, 0);
assert.equal(scopeNativeQuota('const data="' + 'a'.repeat(1000000) + '";' + source, key).quotaCount, 1);
const fastSource = 'const p=host,m=(0,i.tn)(p),h=m?.authMethod==="chatgpt"||m?.authMethod==="personalAccessToken"||m?.authMethod==="amazonBedrock";return{serviceTierAccess:h};';
assert.equal(scopeNativeQuota(fastSource, key).fastCount, 1);
const submitSource = 'var C=n("eLmE"),P=n("a6kU");let nF=host,n6={settings:{model}},nK=(0,i._U)(C.F9,nF),of=(0,i.Ul)("local"===nF&&P.U);let oU=otherBlock||nK||of;return{activeCollaborationMode:n6,submitDisabled:oU};';
const adaptedSubmit = scopeNativeQuota(submitSource, key);
assert.equal(adaptedSubmit.submitCount, 1);
assert.equal(adaptedSubmit.legacySubmitCount, 1);
const nativeSubmit = 'let blocked=otherBlock||workHomePolicy;return{activeCollaborationMode:mode,submitBlockState:state,submitDisabled:blocked};';
const currentSubmit = scopeNativeQuota(source + nativeSubmit, key);
assert.equal(currentSubmit.legacySubmitCount, 0);
assert.equal(currentSubmit.submitCount, 0);
assert(currentSubmit.text.endsWith(nativeSubmit), 'A native composer without duplicated quota checks was modified');
const url = 'data:text/javascript,' + encodeURIComponent(source);
const bootstrap = quotaBootstrap([{ url, source }], gatewayQuotaModels(catalog), key, key + '_notify');
try {
  new Function(bootstrap)();
  const native = await import(url);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(globalThis[key].installed, 1);
  const foreignKey = key + '_browser';
  new Function('location', quotaBootstrap([{ url, source }], ['Gateway/model'], foreignKey, foreignKey + '_notify'))({ protocol: 'https:', host: 'example.com' });
  assert.equal(globalThis[foreignKey], undefined);
  const fast = new Function('host', 'i', scopeNativeQuota(fastSource, key).text);
  assert.equal(fast('local', { tn: () => null }).serviceTierAccess, true);
  assert.equal(fast('remote', { tn: () => null }).serviceTierAccess, false);
  assert.equal(fast('remote', { tn: () => ({ authMethod: 'chatgpt' }) }).serviceTierAccess, true);
  for (const host of ['local', 'remote']) for (const model of ['Gateway/model', 'official', 'unknown', null]) {
    for (const hard of [false, true]) for (const ordinary of [false, true]) for (const otherBlock of [false, true]) {
      const invoke = source => new Function('host', 'model', 'otherBlock', 'n', 'i', source)(host, model, otherBlock,
        name => name === 'eLmE' ? { F9: hard } : { U: ordinary }, { _U: value => value, Ul: value => value });
      const result = invoke(adaptedSubmit.text);
      const gateway = host === 'local' && model === 'Gateway/model';
      assert.equal(result.submitDisabled, otherBlock || !gateway && (hard || host === 'local' && ordinary), JSON.stringify({host,model,hard,ordinary,otherBlock}));
      if (!gateway) assert.deepEqual(result, invoke(submitSource));
    }
  }
  for (const [host, model, blocked] of [['local', 'Gateway/model', false], ['local', 'official', true], ['remote', 'Gateway/model', true], ['local', 'unknown', true]]) {
    const output = {};
    native.__webpack_modules__.gate(output, {}, { host, model, blocked: true, limits: { blocked: true } });
    assert.equal(output.result.sendBlocked, blocked, host + '/' + model);
    assert.equal(output.result.rateLimitWarningThreshold, 50);
  }
  globalThis[key].models = new Set(['New/model']);
  const output = {};
  native.__webpack_modules__.gate(output, {}, { host: 'local', model: 'New/model', blocked: true, limits: { blocked: true } });
  assert.equal(output.result.sendBlocked, false);
} finally { delete globalThis[key]; }
console.log(JSON.stringify({ passed: true, checks: ['Native submit gate scopes both exhausted-subscription flags to the selected model', 'Official models, remote hosts, unknown models and other native blockers retain their original decisions', 'Model switching updates submit eligibility and catalog changes update the in-memory scope'] }));
