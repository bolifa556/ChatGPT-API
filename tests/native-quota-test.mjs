import assert from 'node:assert/strict';
import { scopeNativeQuota, quotaBootstrap, gatewayQuotaModels } from '../src/native-quota.mjs';

const key = '__quota_test_' + Date.now();
const source = 'export const __rspack_esm_ids=[];export const __webpack_modules__={gate(e,t,n){const{host:w,blocked:E,model:g,limits:T}=n,tk={is:(limits)=>limits.blocked};let u;u="local"===w&&E||(0,tk.is)(T,g);e.result={rateLimitWarningThreshold:50,sendBlocked:u}}};';
const catalog = { official: [{ slug: 'official' }], gatewayIds: ['Gateway/model', 'official'] };
assert.deepEqual(gatewayQuotaModels(catalog), ['Gateway/model']);
assert.equal(scopeNativeQuota(source, key).count, 1);
assert.equal(scopeNativeQuota('const ordinary="local"===w&&E||(0,tk.is)(T,g);', key).count, 0);
const fastSource = 'const p=host,m=(0,i.tn)(p),h=m?.authMethod==="chatgpt"||m?.authMethod==="personalAccessToken"||m?.authMethod==="amazonBedrock";return{serviceTierAccess:h};';
assert.equal(scopeNativeQuota(fastSource, key).fastCount, 1);
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
console.log(JSON.stringify({ passed: true, checks: ['Exhausted subscription does not block local API models', 'Official models, remote hosts and unknown models keep native quota decisions', 'Catalog changes update the in-memory model scope'] }));
