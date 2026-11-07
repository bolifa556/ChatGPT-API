// Keep native account data. Local API models use their own quota and the native
// model catalog's Fast capability. The compatibility exists only in memory.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import { pathToFileURL } from 'node:url';
import WebSocket from 'ws';
import { atomicPrivate } from './settings.mjs';

const quotaGuard = /([A-Za-z_$][\w$]*)="local"===([A-Za-z_$][\w$]*)&&([A-Za-z_$][\w$]*)\|\|\(0,([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\)\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\)/g;
export function scopeNativeQuota(source, key) {
  let quotaCount = 0, fastCount = 0;
  let text = source.replace(quotaGuard, (match, output, host, _blocked, _module, _method, _limits, model, offset) => {
    const next = source.slice(offset + match.length, offset + match.length + 1000);
    if (!next.includes('sendBlocked:' + output) || !next.includes('rateLimitWarningThreshold:')) return match;
    quotaCount++;
    return output + '=("local"===' + host + '&&globalThis[' + JSON.stringify(key) + ']?.models?.has(' + model + ')?false:(' + match.slice(output.length + 1) + '))';
  });
  const fastGuard = /([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\?\.authMethod==="chatgpt"\|\|\2\?\.authMethod==="personalAccessToken"\|\|\2\?\.authMethod==="amazonBedrock"/g;
  text = text.replace(fastGuard, (match, output, auth, offset) => {
    if (!text.slice(offset, offset + 1000).includes('serviceTierAccess:')) return match;
    const before = text.slice(Math.max(0, offset - 200), offset);
    const host = before.match(new RegExp('\\b' + auth + '=\\(0,[A-Za-z_$][\\w$]*\\.[A-Za-z_$][\\w$]*\\)\\(([A-Za-z_$][\\w$]*)\\),$'))?.[1];
    if (!host) return match;
    fastCount++;
    return output + '=(' + match.slice(output.length + 1) + '||("local"===' + host + '&&globalThis[' + JSON.stringify(key) + ']?.models?.size>0))';
  });
  return { text, count: quotaCount + fastCount, quotaCount, fastCount };
}
export function nativeQuotaAssets(archive) {
  const fd = fs.openSync(archive, 'r');
  try {
    const prefix = Buffer.alloc(16); fs.readSync(fd, prefix, 0, 16, 0);
    const length = prefix.readUInt32LE(12);
    if (length > 32 * 1024 * 1024) throw new Error('Native asset index is too large.');
    const bytes = Buffer.alloc(length); fs.readSync(fd, bytes, 0, length, 16);
    const tree = JSON.parse(bytes), base = 8 + prefix.readUInt32LE(4), assets = [];
    function scan(directory, parent = '') {
      for (const [name, entry] of Object.entries(directory.files || {})) {
        const file = parent + name;
        if (entry.files) { if ('webview'.startsWith(file) || file.startsWith('webview/')) scan(entry, file + '/'); continue; }
        if (entry.unpacked || !file.startsWith('webview/assets/') || !file.endsWith('.js')) continue;
        const buffer = Buffer.alloc(Number(entry.size)); fs.readSync(fd, buffer, 0, buffer.length, base + Number(entry.offset));
        const source = buffer.toString();
        if (!scopeNativeQuota(source, 'quota_probe').count) continue;
        if (!source.includes('export const __webpack_modules__=')) throw new Error('Unsupported native quota module format.');
        assets.push({ url: 'app://-/' + file.slice('webview/'.length), source });
      }
    }
    scan(tree);
    if (!assets.length) throw new Error('当前客户端的 API 界面兼容检查未通过，请更新适配层。');
    return assets;
  } finally { fs.closeSync(fd); }
}
export function gatewayQuotaModels(catalog) {
  const official = new Set((catalog.official || []).map(model => model.slug));
  return (catalog.gatewayIds || []).filter(model => !official.has(model));
}
export function quotaBootstrap(assets, models, key, binding) {
  const modules = assets.map(asset => {
    const adapted = scopeNativeQuota(asset.source, key);
    const source = adapted.text.replace('export const __rspack_esm_ids=', 'const __rspack_esm_ids=')
      .replace('export const __webpack_modules__=', 'const __webpack_modules__=');
    return '{const prepared=(()=>{"use strict";\n' + source + '\nreturn __webpack_modules__})();' +
      'for(const id of Object.keys(prepared))if(!prepared[id].toString().includes(key))delete prepared[id];' +
      'import(' + JSON.stringify(asset.url) + ').then(native=>{' +
      'const ids=Object.keys(prepared);if(!ids.length)throw Error("Native quota module was not found");' +
      'for(const id of ids){if(typeof native.__webpack_modules__[id]!=="function")throw Error("Native quota module changed");native.__webpack_modules__[id]=function(...args){if(!state.executed.has(id)){state.executed.add(id);notify()}return Reflect.apply(prepared[id],this,args)}}' +
      'state.installed+=ids.length;state.pending--;notify()' +
      '}).catch(error=>{state.error=String(error);notify()})}';
  }).join('\n');
  return '(()=>{if(typeof location!=="undefined"&&(location.protocol!=="app:"||location.host!=="-"))return;const key=' + JSON.stringify(key) + ';if(globalThis[key])return;' +
    'const state=globalThis[key]={models:new Set(' + JSON.stringify(models) + '),pending:' + assets.length + ',installed:0,executed:new Set(),error:null};' +
    'const notify=()=>{const fn=globalThis[' + JSON.stringify(binding) + '];if(typeof fn==="function")fn(JSON.stringify({pending:state.pending,installed:state.installed,executed:[...state.executed],error:state.error}))};' +
    modules + '\n})()';
}
function nativePipe(child, socket) {
  const pending = new Map(), listeners = new Set(); let serial = 0, buffer = Buffer.alloc(0);
  function fail(error) { for (const call of pending.values()) { clearTimeout(call.timer); call.reject(error); } pending.clear(); }
  if (socket) { socket.on('error', fail); socket.once('close', () => fail(new Error('Native compatibility connection closed.'))); }
  else { child.stdio[3].on('error', fail); child.stdio[4].on('error', fail); }
  child.once('exit', () => fail(new Error('Native application exited.')));
  (socket || child.stdio[4]).on(socket ? 'message' : 'data', chunk => {
    buffer = Buffer.concat([buffer, chunk, ...(socket ? [Buffer.from([0])] : [])]); let end;
    while ((end = buffer.indexOf(0)) >= 0) {
      const raw = buffer.subarray(0, end); buffer = buffer.subarray(end + 1);
      let event; try { event = JSON.parse(raw); } catch { continue; }
      const call = pending.get(event.id);
      if (call) { pending.delete(event.id); clearTimeout(call.timer); event.error ? call.reject(new Error(event.error.message)) : call.resolve(event.result); }
      else for (const listener of listeners) listener(event);
    }
  });
  return {
    onEvent(listener) { listeners.add(listener); },
    send(method, params = {}, sessionId) {
      return new Promise((resolve, reject) => {
        const id = ++serial, timer = setTimeout(() => { pending.delete(id); reject(new Error('Native compatibility setup timed out: ' + method)); }, 10000);
        timer.unref(); pending.set(id, { resolve, reject, timer });
        const message = JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) });
        if (socket) socket.send(message); else child.stdio[3].write(message + '\0');
      });
    },
  };
}
async function debuggerAddress(port) {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port, path: '/json/version', agent: false }, response => {
      let text = ''; response.on('data', chunk => { text += chunk; });
      response.once('end', () => { try { resolve(JSON.parse(text).webSocketDebuggerUrl); } catch (error) { reject(error); } });
    });
    request.once('error', reject); request.setTimeout(500, () => request.destroy(new Error('Native debugger is not ready.')));
  });
}
export async function startQuotaCompatibleClient({ executable, archive, root, home, args = [], env = process.env, onStatus = () => {}, launch }) {
  const assets = nativeQuotaAssets(archive), key = '__chatgpt_api_quota_' + crypto.randomBytes(8).toString('hex'), binding = key + '_notify';
  const cache = path.join(root, 'data/cache/catalog-state.json');
  const models = () => gatewayQuotaModels(JSON.parse(fs.readFileSync(cache, 'utf8')));
  let child, socket;
  if (launch) {
    // LaunchServices preserves macOS permission attribution. Its application
    // cannot inherit pipe descriptors, so use an ephemeral loopback endpoint.
    const reserve = net.createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
    const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
    child = await launch(['--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + port, ...args]);
    const until = Date.now() + 20000;
    try {
      let address;
      while (!address && Date.now() < until && child.exitCode === null) {
        try { address = await debuggerAddress(port); } catch {}
        if (!address) await new Promise(resolve => setTimeout(resolve, 50));
      }
      const parsed = new URL(address);
      if (parsed.protocol !== 'ws:' || !['127.0.0.1', 'localhost'].includes(parsed.hostname) || Number(parsed.port) !== port) throw new Error('Invalid native compatibility endpoint.');
      socket = new WebSocket(address); await once(socket, 'open');
    } catch (error) { child.kill(); throw error; }
  } else {
    child = spawn(executable, ['--remote-debugging-pipe', ...args], { env: { ...env, CODEX_HOME: home }, windowsHide: true,
      detached: true, stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
    await once(child, 'spawn');
  }
  const pipe = nativePipe(child, socket), sessions = new Set();
  const status = { pid: child.pid, ready: false, installed: 0, errors: 0 };
  let resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  // Attach the handler before renderer events can arrive.
  ready.catch(() => {});
  const report = () => { onStatus({ ...status }); if (status.ready) resolveReady(); else if (status.errors) rejectReady(new Error(status.lastError)); };
  pipe.onEvent(event => {
    (async () => {
      if (event.method === 'Target.detachedFromTarget') { sessions.delete(event.params.sessionId); return; }
      if (event.method === 'Runtime.bindingCalled' && event.params.name === binding) {
        const result = JSON.parse(event.params.payload);
        status.installed = Math.max(status.installed, result.installed || 0);
        status.executed = result.executed;
        status.ready = result.pending === 0 && result.installed > 0 && !result.error;
        if (result.error) { status.errors++; status.lastError = result.error; }
        report(); return;
      }
      if (event.method !== 'Target.attachedToTarget') return;
      const id = event.params.sessionId, target = event.params.targetInfo;
      if (target.type !== 'page' || target.url && !target.url.startsWith('app://-') && target.url !== 'about:blank') {
        await pipe.send('Runtime.runIfWaitingForDebugger', {}, id); return;
      }
      sessions.add(id);
      const source = quotaBootstrap(assets, models(), key, binding);
      // Queue the document bootstrap before releasing native script execution.
      const setup = pipe.send('Page.addScriptToEvaluateOnNewDocument', { source }, id);
      await pipe.send('Runtime.runIfWaitingForDebugger', {}, id);
      await setup;
      await pipe.send('Runtime.addBinding', { name: binding }, id);
      await pipe.send('Runtime.evaluate', { expression: source }, id);
      const result = await pipe.send('Runtime.evaluate', { expression: 'JSON.stringify(globalThis[' + JSON.stringify(key) + ']&&{pending:globalThis[' + JSON.stringify(key) + '].pending,installed:globalThis[' + JSON.stringify(key) + '].installed,error:globalThis[' + JSON.stringify(key) + '].error})', returnByValue: true }, id);
      if (result.result?.value) {
        const value = JSON.parse(result.result.value);
        status.installed = Math.max(status.installed, value.installed || 0); status.ready = value.pending === 0 && value.installed > 0 && !value.error;
        if (value.error) { status.errors++; status.lastError = value.error; }
      }
      report();
    })().catch(error => { if (child.exitCode === null) { status.errors++; status.lastError = error.message; report(); } });
  });
  const deadline = setTimeout(() => rejectReady(new Error('Native quota compatibility did not become ready.')), 25000);
  child.once('exit', () => rejectReady(new Error('Native client exited during compatibility startup.')));
  try {
    await pipe.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    await ready;
  } catch (error) { socket?.close(); child.kill(); throw error; }
  finally { clearTimeout(deadline); }
  let refresh;
  const watcher = fs.watch(path.dirname(cache), (_type, name) => {
    if (String(name) !== path.basename(cache)) return;
    clearTimeout(refresh); refresh = setTimeout(() => {
      let ids; try { ids = models(); } catch { return; }
      const expression = 'if(globalThis[' + JSON.stringify(key) + '])globalThis[' + JSON.stringify(key) + '].models=new Set(' + JSON.stringify(ids) + ')';
      for (const session of sessions) pipe.send('Runtime.evaluate', { expression }, session).catch(() => {});
    }, 100);
  });
  child.once('exit', () => { watcher.close(); clearTimeout(refresh); socket?.close(); });
  return child;
}
async function main() {
  const [executable, archive, root, home] = process.argv.slice(2);
  const file = path.join(root, 'data/state/native-quota.json');
  const child = await startQuotaCompatibleClient({ executable, archive, root, home, onStatus: value => atomicPrivate(file, value) });
  const [code] = await once(child, 'exit'); process.exitCode = code || 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
