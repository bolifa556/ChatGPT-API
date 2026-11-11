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
import { errorDetails, describeError } from './diagnostics.mjs';

const quotaGuard = /(?<![\w$])([A-Za-z_$][\w$]*)="local"===([A-Za-z_$][\w$]*)&&([A-Za-z_$][\w$]*)\|\|\(0,([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\)\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\)/g;
const quotaAssetRevision = 2;
const escaped = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function scopeComposerSubmission(source, key) {
  const identifier = '[A-Za-z_$][\\w$]*';
  const hardReads = new RegExp('\\b(' + identifier + ')=\\(0,' + identifier + '\\._U\\)\\((' + identifier + ')\\.F9,(' + identifier + ')\\)', 'g');
  const props = /activeCollaborationMode:([A-Za-z_$][\w$]*),[^{};]{0,1200}?\b(submitDisabled(?:Reasons)?):([A-Za-z_$][\w$]*)/g;
  let text = source, count = 0, legacyCount = 0;
  for (const hard of source.matchAll(hardReads)) {
    const [, blocked, module, host] = hard;
    if (!source.includes(module + '=n("eLmE")')) continue;
    legacyCount++;
    const component = [...source.matchAll(props)].find(match => match.index > hard.index);
    if (!component || component.index - hard.index > 40000) continue;
    const [, mode, property, disabled] = component;
    const between = source.slice(hard.index, component.index);
    const ordinary = between.match(new RegExp('\\b(' + identifier + ')=\\(0,' + identifier + '\\.Ul\\)\\("local"===' + escaped(host) + '&&(' + identifier + ')\\.U\\)'));
    if (!ordinary || !source.includes(ordinary[2] + '=n("a6kU")')) continue;
    const gateway = '"local"===' + host + '&&globalThis[' + JSON.stringify(key) + ']?.models?.has(' + mode + '?.settings?.model)';
    if (property === 'submitDisabledReasons') {
      // New clients pass named reasons to the composer. Scope the two native
      // quota reasons before React memoizes them, preserving every other reason.
      const reasons = [[blocked, 'reserve-limit'], [ordinary[1], 'usage-limit']].map(([flag, reason]) =>
        between.match(new RegExp('\\b(' + identifier + ')=' + escaped(flag) + '&&"' + reason + '"')));
      if (reasons.some(reason => !reason)) continue;
      for (const [position, reason] of reasons.entries()) {
        const flag = position ? ordinary[1] : blocked;
        text = text.replace(reason[0], reason[0].replace('=' + flag, '=((' + gateway + ')?false:' + flag + ')'));
      }
      count++; continue;
    }
    const declaration = between.match(new RegExp('\\b' + escaped(disabled) + '=([^;]+);'));
    const tail = '||' + blocked + '||' + ordinary[1];
    if (!declaration || !declaration[1].endsWith(tail)) continue;
    // Scope only the two subscription-quota operands. Permission checks,
    // loading, safety decisions and every other native submit condition stay
    // in the original expression, including when switching models mid-chat.
    const adapted = declaration[0].slice(0, -tail.length - 1) + '||((' + gateway + ')?false:(' + blocked + '||' + ordinary[1] + '));';
    text = text.replace(declaration[0], adapted); count++;
  }
  return { text, count, legacyCount };
}
export function scopeNativeQuota(source, key) {
  if (!source.includes('sendBlocked:') && !source.includes('serviceTierAccess:') && !source.includes('submitDisabled:') && !source.includes('submitDisabledReasons:')) {
    return { text: source, count: 0, quotaCount: 0, fastCount: 0, submitCount: 0, legacySubmitCount: 0 };
  }
  let quotaCount = 0, fastCount = 0;
  let text = source.replace(quotaGuard, (match, output, host, _blocked, _module, _method, _limits, model, offset) => {
    const next = source.slice(offset + match.length, offset + match.length + 1000);
    if (!next.includes('sendBlocked:' + output) || !next.includes('rateLimitWarningThreshold:')) return match;
    quotaCount++;
    return output + '=("local"===' + host + '&&globalThis[' + JSON.stringify(key) + ']?.models?.has(' + model + ')?false:(' + match.slice(output.length + 1) + '))';
  });
  const fastGuard = /(?<![\w$])([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\?\.authMethod==="chatgpt"\|\|\2\?\.authMethod==="personalAccessToken"\|\|\2\?\.authMethod==="amazonBedrock"/g;
  text = text.replace(fastGuard, (match, output, auth, offset) => {
    if (!text.slice(offset, offset + 1000).includes('serviceTierAccess:')) return match;
    const before = text.slice(Math.max(0, offset - 200), offset);
    const host = before.match(new RegExp('\\b' + auth + '=\\(0,[A-Za-z_$][\\w$]*\\.[A-Za-z_$][\\w$]*\\)\\(([A-Za-z_$][\\w$]*)\\),$'))?.[1];
    if (!host) return match;
    fastCount++;
    return output + '=(' + match.slice(output.length + 1) + '||("local"===' + host + '&&globalThis[' + JSON.stringify(key) + ']?.models?.size>0))';
  });
  const submission = scopeComposerSubmission(text, key);
  return { text: submission.text, count: quotaCount + fastCount + submission.count, quotaCount, fastCount, submitCount: submission.count, legacySubmitCount: submission.legacyCount };
}
export function nativeQuotaAssets(archive, cacheFile = '') {
  const fd = fs.openSync(archive, 'r');
  try {
    const stat = fs.fstatSync(fd), identity = [path.resolve(archive), stat.size, stat.mtimeMs].join('|');
    const read = entry => {
      const buffer = Buffer.alloc(entry.size); fs.readSync(fd, buffer, 0, buffer.length, entry.offset);
      const source = buffer.toString(), adapted = scopeNativeQuota(source, 'quota_probe');
      if (!adapted.count && !adapted.legacySubmitCount) return null;
      if (!source.includes('export const __webpack_modules__=')) throw Object.assign(new Error('客户端界面模块格式不兼容，请更新官方客户端和适配层。'), { code: 'native_module_format' });
      return { url: entry.url, source, submitCount: adapted.submitCount, legacySubmitCount: adapted.legacySubmitCount };
    };
    if (cacheFile) {
      try {
        const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
        if (cached.revision === quotaAssetRevision && cached.identity === identity && cached.entries?.length) {
          const assets = cached.entries.map(read);
          if (assets.every(Boolean)) return assets;
        }
      } catch {}
    }
    const prefix = Buffer.alloc(16); fs.readSync(fd, prefix, 0, 16, 0);
    const length = prefix.readUInt32LE(12);
    if (length > 32 * 1024 * 1024) throw new Error('Native asset index is too large.');
    const bytes = Buffer.alloc(length); fs.readSync(fd, bytes, 0, length, 16);
    const tree = JSON.parse(bytes), base = 8 + prefix.readUInt32LE(4), assets = [], entries = [];
    function scan(directory, parent = '') {
      for (const [name, entry] of Object.entries(directory.files || {})) {
        const file = parent + name;
        if (entry.files) { if ('webview'.startsWith(file) || file.startsWith('webview/')) scan(entry, file + '/'); continue; }
        if (entry.unpacked || !file.startsWith('webview/assets/') || !file.endsWith('.js')) continue;
        const location = { url: 'app://-/' + file.slice('webview/'.length), offset: base + Number(entry.offset), size: Number(entry.size) };
        const asset = read(location);
        if (asset) { assets.push(asset); entries.push(location); }
      }
    }
    scan(tree);
    if (!assets.length) throw Object.assign(new Error('当前客户端的 API 界面兼容检查未通过，请更新官方客户端和适配层。'), { code: 'native_ui_unsupported' });
    if (cacheFile) atomicPrivate(cacheFile, { revision: quotaAssetRevision, identity, entries });
    return assets;
  } finally { fs.closeSync(fd); }
}
export function gatewayQuotaModels(catalog, mode = 'mixed') {
  const official = new Set(mode === 'gateway' ? [] : (catalog.official || []).map(model => model.slug));
  return (catalog.gatewayIds || []).filter(model => !official.has(model));
}
export function quotaBootstrap(assets, models, key, binding) {
  const modules = assets.map(asset => {
    const adapted = scopeNativeQuota(asset.source, key);
    const source = adapted.text.replace('export const __rspack_esm_ids=', 'const __rspack_esm_ids=')
      .replace('export const __webpack_modules__=', 'const __webpack_modules__=');
    return '{const asset=' + JSON.stringify(asset.url) + ';try{const prepared=(()=>{"use strict";\n' + source + '\nreturn __webpack_modules__})();' +
      'for(const id of Object.keys(prepared))if(!prepared[id].toString().includes(key))delete prepared[id];' +
      'import(' + JSON.stringify(asset.url) + ').then(native=>{' +
      'const ids=Object.keys(prepared);if(!ids.length)throw Error("Native quota module was not found");' +
      'for(const id of ids){if(typeof native.__webpack_modules__[id]!=="function")throw Error("Native quota module changed");native.__webpack_modules__[id]=function(...args){if(!state.executed.has(id)){state.executed.add(id);notify()}return Reflect.apply(prepared[id],this,args)}}' +
      'state.installed+=ids.length;state.pending--;notify()' +
      '}).catch(error=>{state.error=String(error);state.failedAsset=asset;notify()})' +
      '}catch(error){state.error=String(error);state.failedAsset=asset;notify()}}';
  }).join('\n');
  return '(()=>{if(typeof location!=="undefined"&&(location.protocol!=="app:"||location.host!=="-"))return;const key=' + JSON.stringify(key) + ';if(globalThis[key])return;' +
    'const state=globalThis[key]={models:new Set(' + JSON.stringify(models) + '),pending:' + assets.length + ',installed:0,executed:new Set(),error:null};' +
    'const notify=()=>{const fn=globalThis[' + JSON.stringify(binding) + '];if(typeof fn==="function")fn(JSON.stringify({pending:state.pending,installed:state.installed,executed:[...state.executed],error:state.error,failedAsset:state.failedAsset}))};' +
    modules + '\n})()';
}
function nativePipe(child, socket, timeoutMs) {
  const pending = new Map(), listeners = new Set(); let serial = 0, buffer = Buffer.alloc(0), closedError;
  function fail(error) {
    error.code ||= child.exitCode !== null || child.signalCode !== null ? 'native_client_exited' : 'native_debugger_closed';
    closedError ||= error;
    for (const call of pending.values()) { clearTimeout(call.timer); call.reject(closedError); }
    pending.clear(); buffer = Buffer.alloc(0);
  }
  if (socket) { socket.on('error', fail); socket.once('close', () => fail(new Error('Native compatibility connection closed.'))); }
  else {
    child.stdio[3].on('error', fail); child.stdio[4].on('error', fail);
    child.stdio[4].once('end', () => fail(new Error('Native compatibility connection closed.')));
  }
  child.once('exit', () => {
    fail(new Error('Native application exited.'));
    socket?.close(); child.stdio?.[3]?.destroy(); child.stdio?.[4]?.destroy();
  });
  (socket || child.stdio[4]).on(socket ? 'message' : 'data', chunk => {
    buffer = Buffer.concat([buffer, chunk, ...(socket ? [Buffer.from([0])] : [])]); let end;
    while ((end = buffer.indexOf(0)) >= 0) {
      const raw = buffer.subarray(0, end); buffer = buffer.subarray(end + 1);
      let event; try { event = JSON.parse(raw); } catch { continue; }
      const call = pending.get(event.id);
      if (call) { pending.delete(event.id); clearTimeout(call.timer); event.error ? call.reject(Object.assign(new Error(event.error.message), { code: 'native_command_failed' })) : call.resolve(event.result); }
      else for (const listener of listeners) listener(event);
    }
  });
  return {
    onEvent(listener) { listeners.add(listener); },
    pendingMethods() { return [...new Set([...pending.values()].map(call => call.method))]; },
    send(method, params = {}, sessionId) {
      if (closedError) return Promise.reject(closedError);
      return new Promise((resolve, reject) => {
        const id = ++serial, timer = setTimeout(() => { pending.delete(id); reject(Object.assign(new Error('客户端兼容命令未响应：' + method), { code: 'native_command_timeout', method })); }, timeoutMs);
        timer.unref(); pending.set(id, { resolve, reject: error => reject(Object.assign(error, { method })), timer, method });
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
export async function startQuotaCompatibleClient({ executable, archive, root, home, args = [], env = process.env, onStatus = () => {},
  onSpawn, launch, startupTimeoutMs = 90000 }) {
  const started = Date.now(), status = { phase: 'scanning', ready: false, installed: 0, errors: 0, targets: 0, pages: 0 };
  const clientVersion = archive.match(/OpenAI\.Codex_([\d.]+)_/)?.[1];
  if (clientVersion) status.clientVersion = clientVersion;
  let child, socket, deadline, resolveReady, rejectReady, pipe, lastReport;
  const report = () => {
    const signature = JSON.stringify(status);
    if (signature !== lastReport) { onStatus({ ...status }); lastReport = signature; }
    if (status.ready) resolveReady?.();
    else if (status.errors) rejectReady?.(Object.assign(new Error(status.lastError), { code: status.code || 'native_setup_failed' }));
  };
  try {
    report();
    const assets = nativeQuotaAssets(archive, path.join(root, 'data/cache/native-ui-index.json')),
      key = '__chatgpt_api_quota_' + crypto.randomBytes(8).toString('hex'), binding = key + '_notify';
    status.modules = assets.length;
    const cache = path.join(root, 'data/cache/catalog-state.json');
    let routeMode = 'mixed';
    try { routeMode = JSON.parse(fs.readFileSync(path.join(root, 'data/state/route-state.json'), 'utf8')).mode; } catch {}
    const models = () => gatewayQuotaModels(JSON.parse(fs.readFileSync(cache, 'utf8')), routeMode);
    // Validate every detected quota gate, including modules with no other
    // patches. Installing a Fast/banner module cannot certify the send button.
    if (models().length && assets.some(asset => asset.legacySubmitCount > asset.submitCount)) throw Object.assign(new Error('当前客户端的 API 发送兼容检查未通过，请更新官方客户端和适配层。'), { code: 'native_send_unsupported' });
    const bootstrapSource = quotaBootstrap(assets, [], key, binding);
    status.phase = 'launching'; report();
    if (launch) {
      // LaunchServices preserves macOS permission attribution. Its application
      // cannot inherit pipe descriptors, so use an ephemeral loopback endpoint.
      const reserve = net.createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
      const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
      child = await launch(['--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + port, ...args]);
      onSpawn?.(child); status.pid = child.pid; status.phase = 'connecting'; report();
      const until = Date.now() + startupTimeoutMs;
      let address, endpointError;
      while (!address && Date.now() < until && child.exitCode === null) {
        try { address = await debuggerAddress(port); } catch (error) { endpointError = error; }
        if (!address) await new Promise(resolve => setTimeout(resolve, 50));
      }
      if (!address) throw Object.assign(new Error('客户端兼容连接未建立，请先更新官方客户端。'), { code: 'native_endpoint_unavailable', cause: endpointError });
      const parsed = new URL(address);
      if (parsed.protocol !== 'ws:' || !['127.0.0.1', 'localhost'].includes(parsed.hostname) || Number(parsed.port) !== port) throw new Error('Invalid native compatibility endpoint.');
      socket = new WebSocket(address, { handshakeTimeout: startupTimeoutMs }); await once(socket, 'open');
    } else {
      child = spawn(executable, ['--remote-debugging-pipe', ...args], { env: { ...env, CODEX_HOME: home }, windowsHide: true,
        detached: true, stdio: ['ignore', 'ignore', onSpawn ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
      await once(child, 'spawn');
      onSpawn?.(child); status.pid = child.pid; status.phase = 'connecting'; report();
    }
    pipe = nativePipe(child, socket, startupTimeoutMs);
    const sessions = new Set();
    const evaluate = async (expression, id) => {
      const value = await pipe.send('Runtime.evaluate', { expression, returnByValue: true }, id);
      if (value.exceptionDetails) {
        const detail = value.exceptionDetails;
        throw Object.assign(new Error((detail.exception?.description || detail.text || 'Unknown script exception').slice(0, 1600)),
          { code: 'native_script_exception', method: 'Runtime.evaluate' });
      }
      return value;
    };
    const accept = value => {
      if (status.ready && !value.error) return;
      status.pending = value.pending;
      status.installed = Math.max(status.installed, value.installed || 0);
      if (!status.ready) status.executed = value.executed;
      status.ready ||= value.pending === 0 && value.installed > 0 && !value.error;
      status.phase = status.ready ? 'ready' : 'installing';
      if (value.error) {
        status.errors++; status.lastError = value.error; status.code = 'native_module_failed';
        status.failedAsset = value.failedAsset;
      }
      report();
    };
    const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    // Attach the handler before renderer events can arrive.
    ready.catch(() => {});
    pipe.onEvent(event => {
      (async () => {
        if (event.method === 'Target.detachedFromTarget') { sessions.delete(event.params.sessionId); return; }
        if (event.method === 'Runtime.bindingCalled' && event.params.name === binding) {
          const result = JSON.parse(event.params.payload);
          accept(result); return;
        }
        if (event.method !== 'Target.attachedToTarget') return;
        const id = event.params.sessionId, target = event.params.targetInfo;
        status.targets++;
        if (target.type !== 'page' || target.url && !target.url.startsWith('app://-') && target.url !== 'about:blank') {
          await pipe.send('Runtime.runIfWaitingForDebugger', {}, id); return;
        }
        sessions.add(id);
        status.pages++; if (!status.ready) status.phase = 'installing'; report();
        const source = bootstrapSource + ';if(globalThis[' + JSON.stringify(key) + '])globalThis[' + JSON.stringify(key) + '].models=new Set(' + JSON.stringify(models()) + ')';
        // Queue the document bootstrap before releasing native script execution.
        const setup = pipe.send('Page.addScriptToEvaluateOnNewDocument', { source }, id);
        const bound = pipe.send('Runtime.addBinding', { name: binding }, id);
        await Promise.all([setup, bound, pipe.send('Runtime.runIfWaitingForDebugger', {}, id)]);
        await evaluate(source, id);
        const result = await evaluate('JSON.stringify(globalThis[' + JSON.stringify(key) + ']&&{pending:globalThis[' + JSON.stringify(key) + '].pending,installed:globalThis[' + JSON.stringify(key) + '].installed,error:globalThis[' + JSON.stringify(key) + '].error,failedAsset:globalThis[' + JSON.stringify(key) + '].failedAsset})', id);
        if (result.result?.value) {
          const value = JSON.parse(result.result.value);
          accept(value);
        }
        report();
      })().catch(error => { if (child.exitCode === null) { status.errors++; status.code = error.code || 'native_setup_failed'; status.lastError = error.message; status.failure = errorDetails(error); report(); } });
    });
    deadline = setTimeout(() => {
      const commands = pipe.pendingMethods();
      const code = commands.length ? 'native_command_timeout' : !status.pages ? 'native_page_not_attached'
        : status.pending === undefined ? 'native_bootstrap_not_started' : 'native_module_load_timeout';
      const reason = commands.length ? '客户端兼容命令未响应：' + commands.join(', ') : !status.pages ? '未连接到客户端主页面'
        : status.pending === undefined ? '客户端主页面兼容脚本未开始执行' : '客户端界面模块加载未完成（剩余 ' + status.pending + ' 个）';
      rejectReady(Object.assign(new Error(reason + '。请先更新官方客户端；详细原因见 data/state/native-quota.json。'), { code }));
    }, startupTimeoutMs);
    const exited = () => rejectReady(Object.assign(new Error('客户端在兼容初始化期间退出（' + (child.signalCode || child.exitCode) + '）。'), { code: 'native_client_exited' }));
    child.once('exit', exited);
    if (child.exitCode !== null || child.signalCode !== null) exited();
    await pipe.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    await ready;
    clearTimeout(deadline);
    let refresh;
    const watcher = fs.watch(path.dirname(cache), (_type, name) => {
      if (String(name) !== path.basename(cache)) return;
      clearTimeout(refresh); refresh = setTimeout(() => {
        let ids; try { ids = models(); } catch { return; }
        const expression = 'if(globalThis[' + JSON.stringify(key) + '])globalThis[' + JSON.stringify(key) + '].models=new Set(' + JSON.stringify(ids) + ')';
        for (const session of sessions) evaluate(expression, session).catch(error => {
          if (!sessions.has(session) || child.exitCode !== null) return;
          status.errors++; status.lastError = describeError(error); status.failure = errorDetails(error); report();
        });
      }, 100);
    });
    child.once('exit', () => {
      watcher.close(); clearTimeout(refresh); socket?.close();
      status.ready = false; status.phase = 'stopped'; status.exitCode = child.exitCode; status.signal = child.signalCode;
      onStatus({ ...status });
    });
    return child;
  } catch (error) {
    status.failurePhase = status.phase; status.elapsedMs = Date.now() - started;
    status.pendingCommands = pipe?.pendingMethods();
    socket?.terminate();
    let failure = error;
    try {
      if (child && child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'exit'); }
    } catch (cleanupError) {
      failure = new AggregateError([error, cleanupError], error.message + '\n' + cleanupError.message, { cause: error });
    }
    child?.stdio?.[3]?.destroy(); child?.stdio?.[4]?.destroy();
    status.ready = false; status.phase = 'failed'; status.errors = Math.max(1, status.errors); status.lastError = describeError(failure);
    status.code ||= error.code || 'native_setup_failed'; status.failure ||= errorDetails(failure);
    try { report(); } catch {}
    throw failure;
  } finally { clearTimeout(deadline); }
}
async function main() {
  const [executable, archive, root, home] = process.argv.slice(2);
  const file = path.join(root, 'data/state/native-quota.json');
  const child = await startQuotaCompatibleClient({ executable, archive, root, home, onStatus: value => atomicPrivate(file, value) });
  if (child.exitCode === null && child.signalCode === null) await once(child, 'exit');
  process.exitCode = child.exitCode ?? (child.signalCode ? 1 : 0);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
