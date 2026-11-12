import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scopeNativeQuota, quotaBootstrap, gatewayQuotaModels, nativeQuotaAssets } from '../src/native-quota.mjs';

const key = '__quota_test_' + Date.now();
const source = 'export const __rspack_esm_ids=[];export const __webpack_modules__={gate(e,t,n){const{host:w,blocked:E,model:g,limits:T}=n,tk={is:(limits)=>limits.blocked};let u;u="local"===w&&E||(0,tk.is)(T,g);e.result={rateLimitWarningThreshold:50,sendBlocked:u}}};';
const namedSubmitSource = 'var C=n("eLmE"),P=n("a6kU");let nF=host,n6={settings:{model}},nK=(0,i._U)(C.F9,nF),of=(0,i.Ul)("local"===nF&&P.U);let other=otherBlock&&"permission-blocked",reserve=nK&&"reserve-limit",usage=of&&"usage-limit";let disabled=[other,reserve,usage].filter(Boolean).join(",");return{activeCollaborationMode:n6,submitDisabledReasons:disabled};';
const namedModule = 'export const __rspack_esm_ids=[];export const __webpack_modules__={composer(e,t,n){' + namedSubmitSource + '}};';
const catalog = { official: [{ slug: 'official' }], gatewayIds: ['Gateway/model', 'official'] };
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'native-ui-index-'));
const archive = path.join(fixture, 'app.asar'), index = path.join(fixture, 'index.json');
function writeArchive(text) {
  const entries = {}, chunks = []; let offset = 0;
  for (const [name, source] of Object.entries(typeof text === 'string' ? { 'quota.js': text } : text)) {
    const bytes = Buffer.from(source); entries[name] = { size: bytes.length, offset: String(offset) };
    chunks.push(bytes); offset += bytes.length;
  }
  const data = Buffer.concat(chunks), header = Buffer.from(JSON.stringify({ files: { webview: { files: { assets: { files: entries } } } } }));
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
  writeArchive({ 'quota.js': source, 'composer.js': namedModule });
  assert.equal(nativeQuotaAssets(archive, index).length, 2);
  const oldIndex = JSON.parse(fs.readFileSync(index));
  delete oldIndex.revision; oldIndex.entries = oldIndex.entries.slice(0, 1);
  fs.writeFileSync(index, JSON.stringify(oldIndex));
  const refreshed = nativeQuotaAssets(archive, index);
  assert.equal(refreshed.length, 2, 'An old matcher cache hid a newly supported send-button module');
  assert(refreshed.some(asset => asset.submitCount === 1));
  writeArchive(namedModule.replace('usage=of&&"usage-limit"', 'usage=of&&"changed-quota-reason"'));
  const unmatched = nativeQuotaAssets(archive, index);
  assert.equal(unmatched[0].legacySubmitCount, 1, 'An unmatched send gate disappeared from compatibility validation');
  assert.equal(unmatched[0].submitCount, 0);
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
const adaptedNamed = scopeNativeQuota(namedSubmitSource, key);
assert.equal(adaptedNamed.submitCount, 1);
assert.equal(adaptedNamed.legacySubmitCount, 1);
const renamedSource = namedSubmitSource.replaceAll('eLmE', 'newReserveModule').replaceAll('a6kU', 'newUsageModule')
  .replace('i._U', 'i.readReserve').replace('C.F9', 'C.reserve').replace('i.Ul', 'i.readUsage').replace('P.U', 'P.usage');
const renamed = scopeNativeQuota(renamedSource, key);
assert.equal(renamed.submitCount, 1, 'Minified import names changed despite equivalent native send rules');
assert.equal(scopeNativeQuota(renamedSource.replace('"local"===nF', '"local"===otherHost'), key).submitCount, 0,
  'A usage reason from a different host was scoped to the local model');
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
      const named = invoke(adaptedNamed.text), expectedReasons = [otherBlock && 'permission-blocked', !gateway && hard && 'reserve-limit', !gateway && host === 'local' && ordinary && 'usage-limit'].filter(Boolean).join(',');
      assert.equal(named.submitDisabledReasons, expectedReasons, JSON.stringify({host,model,hard,ordinary,otherBlock}));
      const afterUpgrade = new Function('host', 'model', 'otherBlock', 'n', 'i', renamed.text)(host, model, otherBlock,
        name => name === 'newReserveModule' ? { reserve: hard } : { usage: ordinary }, { readReserve: value => value, readUsage: value => value });
      assert.deepEqual(afterUpgrade, named);
      if (!gateway) assert.deepEqual(named, invoke(namedSubmitSource));
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
console.log(JSON.stringify({ passed: true, checks: ['Native Boolean and named-reason submit gates scope both exhausted-subscription flags to the selected model', 'Official models, remote hosts, unknown models and other native blockers retain their original decisions', 'Model switching updates submit eligibility and catalog changes update the in-memory scope', 'Matcher upgrades invalidate old asset indexes; unadapted quota gates remain visible to validation'] }));
