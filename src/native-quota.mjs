// Keep native account data. Local API models use their own quota and the native
// model catalog's Fast capability. The compatibility exists only in memory.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import http from 'node:http';
import net from 'node:net';
import { pathToFileURL } from 'node:url';
import WebSocket from 'ws';
import { atomicPrivate } from './settings.mjs';
import { errorDetails, describeError } from './diagnostics.mjs';

const quotaGuard = /(?<![\w$])([A-Za-z_$][\w$]*)="local"===([A-Za-z_$][\w$]*)&&([A-Za-z_$][\w$]*)\|\|\(0,([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\)\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\)/g;
const quotaAssetRevision = 4;
const escaped = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function scopeComposerSubmission(source, key) {
  if (!source.includes('activeCollaborationMode:') && !source.includes('n("eLmE")')) return { text: source, count: 0, legacyCount: 0 };
  const identifier = '[A-Za-z_$][\\w$]*';
  const variable = '(?<![\\w$])';
  const hardReads = new RegExp(variable + '(' + identifier + ')=\\(0,' + identifier + '\\.(' + identifier + ')\\)\\((' + identifier + ')\\.(' + identifier + '),(' + identifier + ')\\)', 'g');
  const props = /activeCollaborationMode:([A-Za-z_$][\w$]*),[^{};]{0,1200}?\b(submitDisabled(?:Reasons)?):([A-Za-z_$][\w$]*)/g;
  const components = [...source.matchAll(props)], changes = [];
  let count = 0, legacyCount = 0;
  for (const hard of source.matchAll(hardReads)) {
    const [, blocked, hook, module, flag, host] = hard;
    const legacy = hook === '_U' && flag === 'F9' && source.includes(module + '=n("eLmE")');
    if (legacy) legacyCount++;
    const component = components.find(match => match.index > hard.index);
    if (!component || component.index - hard.index > 40000) continue;
    const [, mode, property, disabled] = component;
    const between = source.slice(hard.index, component.index);
    const gateway = '"local"===' + host + '&&globalThis[' + JSON.stringify(key) + ']?.models?.has(' + mode + '?.settings?.model)';
    if (property === 'submitDisabledReasons') {
      // Follow the named reasons back to their native flags for the same host.
      // Webpack can rename all of the imports and local variables on rebuild.
      const reserve = between.match(new RegExp(variable + identifier + '=' + escaped(blocked) + '&&"reserve-limit"'));
      if (!reserve) continue;
      if (!legacy) legacyCount++;
      const usages = [...between.matchAll(new RegExp(variable + identifier + '=(' + identifier + ')&&"usage-limit"', 'g'))];
      if (usages.length !== 1) continue;
      const [usage] = usages;
      const usageRead = new RegExp(variable + escaped(usage[1]) + '=\\(0,' + identifier + '\\.' + identifier + '\\)\\("local"===' + escaped(host) + '&&' + identifier + '\\.' + identifier + '\\)');
      if (!usageRead.test(between.slice(0, usage.index))) continue;
      const afterReasons = between.slice(Math.max(reserve.index + reserve[0].length, usage.index + usage[0].length));
      if (!new RegExp(variable + escaped(disabled) + '=(?!=|>)').test(afterReasons)) continue;
      const before = source.slice(Math.max(0, component.index - 40000), hard.index + Math.min(reserve.index, usage.index));
      if (!new RegExp(variable + escaped(mode) + '=(?!=|>)').test(before)) continue;
      for (const [reason, value] of [[reserve, blocked], [usage, usage[1]]]) {
        changes.push({ offset: hard.index + reason.index, length: reason[0].length,
          text: reason[0].replace('=' + value, '=((' + gateway + ')?false:' + value + ')') });
      }
      count++; continue;
    }
    if (!legacy) continue;
    const ordinary = between.match(new RegExp(variable + '(' + identifier + ')=\\(0,' + identifier + '\\.Ul\\)\\("local"===' + escaped(host) + '&&(' + identifier + ')\\.U\\)'));
    if (!ordinary || !source.includes(ordinary[2] + '=n("a6kU")')) continue;
    const declaration = between.match(new RegExp(variable + escaped(disabled) + '=([^;]+);'));
    const tail = '||' + blocked + '||' + ordinary[1];
    if (!declaration || !declaration[1].endsWith(tail)) continue;
    // Scope only the two subscription-quota operands. Permission checks,
    // loading, safety decisions and every other native submit condition stay
    // in the original expression, including when switching models mid-chat.
    const adapted = declaration[0].slice(0, -tail.length - 1) + '||((' + gateway + ')?false:(' + blocked + '||' + ordinary[1] + '));';
    changes.push({ offset: hard.index + declaration.index, length: declaration[0].length, text: adapted });
    count++;
  }
  let text = source;
  for (const change of changes.sort((a, b) => b.offset - a.offset)) {
    text = text.slice(0, change.offset) + change.text + text.slice(change.offset + change.length);
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
function readAsset(fd, entry, buffer = Buffer.allocUnsafe(entry.size)) {
  const bytes = buffer.subarray(0, entry.size);
  if (fs.readSync(fd, bytes, 0, bytes.length, entry.offset) !== bytes.length) throw new Error('Incomplete native asset.');
  return bytes;
}

function readAssetSources(fd, entries) {
  return entries.map(entry => ({ ...entry, source: readAsset(fd, entry).toString() }));
}

export function nativeQuotaAssets(archive, cacheFile = '', includeSource = true) {
  const fd = fs.openSync(archive, 'r');
  try {
    const stat = fs.fstatSync(fd), identity = [path.resolve(archive), stat.size, stat.mtimeMs].join('|');
    const result = entries => includeSource ? readAssetSources(fd, entries) : entries;
    if (cacheFile) {
      try {
        const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
        if (cached.revision === quotaAssetRevision && cached.identity === identity && cached.entries?.length) {
          return result(cached.entries);
        }
      } catch {}
    }
    const prefix = Buffer.alloc(16); fs.readSync(fd, prefix, 0, 16, 0);
    const length = prefix.readUInt32LE(12);
    if (length > 32 * 1024 * 1024) throw new Error('Native asset index is too large.');
    const bytes = Buffer.alloc(length); fs.readSync(fd, bytes, 0, length, 16);
    const tree = JSON.parse(bytes), base = 8 + prefix.readUInt32LE(4), entries = [];
    let scratch = Buffer.alloc(0);
    function scan(directory, parent = '') {
      for (const [name, entry] of Object.entries(directory.files || {})) {
        const file = parent + name;
        if (entry.files) { if ('webview'.startsWith(file) || file.startsWith('webview/')) scan(entry, file + '/'); continue; }
        if (entry.unpacked || !file.startsWith('webview/assets/') || !file.endsWith('.js')) continue;
        const location = { url: 'app://-/' + file.slice('webview/'.length), offset: base + Number(entry.offset), size: Number(entry.size) };
        if (location.size > scratch.length) scratch = Buffer.allocUnsafe(location.size);
        const contents = readAsset(fd, location, scratch);
        const quota = contents.includes('sendBlocked:') && contents.includes('rateLimitWarningThreshold:');
        const fast = contents.includes('serviceTierAccess:') && contents.includes('authMethod==="amazonBedrock"');
        const composer = (contents.includes('submitDisabledReasons:') || contents.includes('submitDisabled:'))
          && (contents.includes('"reserve-limit"') || contents.includes('n("eLmE")'));
        if (!quota && !fast && !composer) continue;
        const source = contents.toString(), adapted = scopeNativeQuota(source, 'quota_probe');
        if (adapted.count || adapted.legacySubmitCount) {
          entries.push({ ...location, count: adapted.count, submitCount: adapted.submitCount,
            legacySubmitCount: adapted.legacySubmitCount, supportedFormat: source.includes('export const __webpack_modules__=') });
        }
      }
    }
    scan(tree);
    if (!entries.length) throw Object.assign(new Error('当前客户端的 API 界面兼容检查未通过，请更新官方客户端和适配层。'), { code: 'native_ui_unsupported' });
    if (cacheFile) atomicPrivate(cacheFile, { revision: quotaAssetRevision, identity, entries });
    return result(entries);
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
      'if(ids.some(id=>typeof native.__webpack_modules__?.[id]!=="function"))throw Error("Native quota module changed");' +
      'for(const id of ids)native.__webpack_modules__[id]=prepared[id];' +
      'state.installed+=ids.length;state.pending--;notify()' +
      '}).catch(error=>failed(error,asset))' +
      '}catch(error){failed(error,asset)}}';
  }).join('\n');
  return '(()=>{if(typeof location!=="undefined"&&(location.protocol!=="app:"||location.host!=="-"||self!==top))return;const key=' + JSON.stringify(key) + ';if(globalThis[key])return;' +
    'const state=globalThis[key]={models:new Set(' + JSON.stringify(models) + '),pending:' + assets.length + ',installed:0,error:null};' +
    'const notify=(initial=false)=>{const fn=globalThis[' + JSON.stringify(binding) + '];if(typeof fn==="function")fn(JSON.stringify({pending:state.pending,installed:state.installed,error:state.error,failedAsset:state.failedAsset,initial}))};' +
    'const failed=(error,asset)=>{if(!state.error){state.error=String(error);state.failedAsset=asset}state.pending--;notify()};notify(true);' +
    modules + '\n})()';
}
function nativePipe(child, socket, timeoutMs, disconnected) {
  const pending = new Map(), listeners = new Set(); let serial = 0, buffer = Buffer.alloc(0), closedError;
  function fail(error) {
    if (closedError) return;
    error.code ||= 'native_debugger_closed';
    closedError = error;
    for (const call of pending.values()) { clearTimeout(call.timer); call.reject(closedError); }
    pending.clear(); buffer = Buffer.alloc(0); disconnected.abort(error);
  }
  if (socket) { socket.on('error', fail); socket.once('close', () => fail(new Error('Native compatibility connection closed.'))); }
  else {
    child.stdio[3].on('error', fail); child.stdio[4].on('error', fail);
    child.stdio[4].once('end', () => fail(new Error('Native compatibility connection closed.')));
  }
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
    close() { listeners.clear(); socket?.terminate(); child.stdio?.[3]?.destroy(); child.stdio?.[4]?.destroy(); },
    pendingMethods() { return [...new Set([...pending.values()].map(call => call.method))]; },
    send(method, params = {}, sessionId) {
      if (closedError) return Promise.reject(closedError);
      return new Promise((resolve, reject) => {
        const id = ++serial, timer = setTimeout(() => { pending.delete(id); reject(Object.assign(new Error('客户端兼容命令未响应：' + method), { code: 'native_command_timeout', method })); }, timeoutMs);
        timer.unref(); pending.set(id, { resolve, reject, timer, method });
        const message = JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) });
        const sent = error => { if (error) fail(error); };
        if (socket) socket.send(message, sent); else child.stdio[3].write(message + '\0', sent);
      });
    },
  };
}
async function debuggerAddress(port, signal) {
  while (!signal.aborted) {
    const address = await new Promise(resolve => {
      const request = http.get({ host: '127.0.0.1', port, path: '/json/version', agent: false, signal }, response => {
        let text = '';
        response.on('data', chunk => { text += chunk; });
        response.once('error', () => resolve(null));
        response.once('end', () => { try { resolve(JSON.parse(text).webSocketDebuggerUrl); } catch { resolve(null); } });
      });
      request.once('error', () => resolve(null));
      request.setTimeout(500, () => request.destroy());
    });
    if (address) return address;
    await delay(50, undefined, { signal });
  }
  signal.throwIfAborted();
}

function noteUiFailure(status, error, failedAsset) {
  if (status.errors) return;
  status.errors = 1;
  status.failurePhase = status.phase;
  status.code = error.code || 'native_setup_failed';
  status.lastError = describeError(error);
  status.failure = errorDetails(error);
  if (failedAsset) status.failedAsset = failedAsset;
}

function showQuotaWarning() {
  const title = 'ChatGPT API';
  const message = '部分自定义模型的发送额度或 Fast 兼容未加载。ChatGPT 可以继续使用。';
  let commands = [];
  if (process.platform === 'win32') {
    const script = '$shell=New-Object -ComObject WScript.Shell\n[void]$shell.Popup("' + message + '",15,"' + title + '",48)';
    commands = [[path.join(process.env.WINDIR, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]]];
  } else if (process.platform === 'darwin') {
    commands = [['/usr/bin/osascript', ['-e', 'display alert "' + title + '" message "' + message + '" as warning giving up after 15']]];
  } else if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) {
    commands = [['zenity', ['--warning', '--timeout=15', '--title=' + title, '--text=' + message]],
      ['kdialog', ['--title', title, '--passivepopup', message, '15']]];
  }
  const next = () => {
    const command = commands.shift();
    if (!command) { process.stderr.write(title + ' ' + message + '\n'); return; }
    const [program, args] = command;
    const dialog = spawn(program, args, { windowsHide: true, stdio: 'ignore' });
    dialog.once('error', next);
    dialog.unref();
  };
  next();
}

async function installQuota({ child, port, models, cache, archive, assets, timeoutMs, status, report }) {
  const disconnected = new AbortController(), { signal } = disconnected;
  const clientExited = () => disconnected.abort(new Error('Native application exited.'));
  child.once('exit', clientExited);
  let socket, pipe, watcher, refresh;
  const deadline = setTimeout(() => {
    const commands = pipe?.pendingMethods() || [];
    const code = port && !pipe ? 'native_endpoint_unavailable' : commands.length ? 'native_command_timeout'
      : !status.pages ? 'native_page_not_attached' : status.pending === undefined ? 'native_bootstrap_not_started' : 'native_module_load_timeout';
    const detail = commands.length ? commands.join(', ') : code;
    disconnected.abort(Object.assign(new Error('客户端界面兼容未就绪（' + detail + '）。'), { code }));
  }, timeoutMs);
  deadline.unref();
  const ended = once(signal, 'abort').then(() => { throw signal.reason; });
  ended.catch(() => {});
  try {
    if (child.exitCode !== null || child.signalCode !== null) clientExited();
    signal.throwIfAborted();
    if (port) {
      const address = await debuggerAddress(port, signal), parsed = new URL(address);
      if (parsed.protocol !== 'ws:' || !['127.0.0.1', 'localhost'].includes(parsed.hostname) || Number(parsed.port) !== port) {
        throw new Error('Invalid native compatibility endpoint.');
      }
      socket = new WebSocket(address, { handshakeTimeout: timeoutMs });
      socket.on('error', () => {});
      await Promise.race([once(socket, 'open'), ended]);
    }
    pipe = nativePipe(child, socket, timeoutMs, disconnected);
    const sessions = new Set(), key = '__chatgpt_api_quota_' + crypto.randomBytes(8).toString('hex'), binding = key + '_notify';
    let latest = models();
    const writeModels = (id, ids) => pipe.send('Runtime.evaluate', {
      expression: 'if(globalThis[' + JSON.stringify(key) + '])globalThis[' + JSON.stringify(key) + '].models=new Set(' + JSON.stringify(ids) + ')',
    }, id);
    const seeds = new Map();
    let resolveReady;
    const ready = new Promise(resolve => { resolveReady = resolve; });
    const failed = (error, id) => {
      if (!sessions.has(id) || signal.aborted) return;
      disconnected.abort(error);
    };
    pipe.onEvent(event => {
      if (signal.aborted) return;
      if (event.method === 'Target.detachedFromTarget') {
        sessions.delete(event.params.sessionId); seeds.delete(event.params.sessionId); return;
      }
      if (event.method === 'Runtime.bindingCalled' && event.params.name === binding && sessions.has(event.sessionId)) {
        const id = event.sessionId;
        try {
          const value = JSON.parse(event.params.payload);
          if (value.initial && seeds.get(id) !== latest) writeModels(id, latest).catch(error => failed(error, id));
          if (status.ready) return;
          if (value.error) noteUiFailure(status, Object.assign(new Error(value.error), { code: 'native_module_failed' }), value.failedAsset);
          status.pending = value.pending;
          status.installed = Math.max(status.installed, value.installed || 0);
          if (value.pending === 0) {
            if (!status.installed) noteUiFailure(status, new Error('No native compatibility modules were installed.'));
            status.ready = status.installed > 0;
            status.phase = status.errors ? 'degraded' : 'ready';
            report(); resolveReady();
          }
        } catch (error) { failed(error, id); }
        return;
      }
      if (event.method !== 'Target.attachedToTarget') return;
      const { sessionId: id, targetInfo: target } = event.params;
      status.targets++;
      if (target.type !== 'page' || target.url && target.url !== 'about:blank' && !target.url.startsWith('app://-/')) return;
      sessions.add(id); status.pages++;
      if (status.phase === 'connecting') { status.phase = 'installing'; report(); }
      const ids = latest; seeds.set(id, ids);
      // Register in the renderer's document context. A debugger evaluation
      // made during startup can leave the app:// module imports pending.
      pipe.send('Runtime.addBinding', { name: binding }, id)
        .then(() => {
          // The running adapter keeps only asset offsets. Read the sources for
          // this document, then let the CDP write release its temporary script.
          const fd = fs.openSync(archive, 'r');
          let source;
          try { source = quotaBootstrap(readAssetSources(fd, assets), ids, key, binding); }
          finally { fs.closeSync(fd); }
          return pipe.send('Page.addScriptToEvaluateOnNewDocument', { source, runImmediately: true }, id);
        })
        .catch(error => failed(error, id));
    });
    const attached = pipe.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    await Promise.race([Promise.all([attached, ready]), ended]);
    clearTimeout(deadline);
    if (typeof globalThis.gc === 'function') setImmediate(() => globalThis.gc());
    if (!status.ready) return;
    watcher = fs.watch(path.dirname(cache), (_type, name) => {
      if (name && String(name) !== path.basename(cache)) return;
      clearTimeout(refresh);
      refresh = setTimeout(() => {
        let ids; try { ids = models(); } catch { return; }
        if (ids.length === latest.length && ids.every((id, index) => id === latest[index])) return;
        latest = ids;
        for (const session of sessions) writeModels(session, ids).catch(error => failed(error, session));
      }, 100);
    });
    watcher.once('error', error => disconnected.abort(error));
    await ended;
  } catch (error) {
    const failure = signal.aborted ? signal.reason : error;
    // The debugging pipe can close just before Electron reports its exit.
    if (!status.ready && failure.code === 'native_debugger_closed' && child.exitCode === null && child.signalCode === null) await delay(100);
    const exited = child.exitCode !== null || child.signalCode !== null;
    status.pendingCommands = pipe?.pendingMethods();
    if (!exited) {
      noteUiFailure(status, failure);
    }
    status.phase = exited ? 'stopped' : 'degraded'; status.ready = false;
    report();
  } finally {
    clearTimeout(deadline); clearTimeout(refresh); watcher?.close();
    child.off('exit', clientExited);
    if (pipe) pipe.close(); else socket?.terminate();
  }
}

export async function startQuotaCompatibleClient({ executable, archive, root, home, args = [], env = process.env,
  onStatus = value => atomicPrivate(path.join(root, 'data/state/native-quota.json'), { updatedAt: new Date().toISOString(), ...value }),
  onWarning = showQuotaWarning, onSpawn, launch, startupTimeoutMs = 15000 }) {
  const status = { phase: 'scanning', ready: false, installed: 0, errors: 0, targets: 0, pages: 0 };
  const clientVersion = archive.match(/OpenAI\.Codex_([\d.]+)_/)?.[1];
  if (clientVersion) status.clientVersion = clientVersion;
  let warned = false;
  const report = () => {
    try { onStatus({ ...status }); } catch {}
    if (!warned && status.phase === 'degraded' && status.failurePhase !== 'ready') {
      warned = true;
      try { onWarning({ ...status }); } catch {}
    }
  };
  const cache = path.join(root, 'data/cache/catalog-state.json');
  let routeMode = 'mixed';
  try { routeMode = JSON.parse(fs.readFileSync(path.join(root, 'data/state/route-state.json'), 'utf8')).mode; } catch {}
  const models = () => gatewayQuotaModels(JSON.parse(fs.readFileSync(cache, 'utf8')), routeMode);
  let assets, port, setupError;
  report();
  try {
    const candidates = nativeQuotaAssets(archive, path.join(root, 'data/cache/native-ui-index.json'), false);
    const hasGateway = models().length > 0;
    for (const asset of candidates) {
      if (!asset.supportedFormat) {
        noteUiFailure(status, Object.assign(new Error('客户端界面模块格式已变更。'), { code: 'native_module_format' }), asset.url);
      } else if (hasGateway && asset.legacySubmitCount > asset.submitCount) {
        noteUiFailure(status, Object.assign(new Error('当前客户端的 API 发送界面规则已变更。'), { code: 'native_send_unsupported' }), asset.url);
      }
    }
    const supported = candidates.filter(asset => asset.supportedFormat && asset.count);
    status.modules = supported.length;
    if (!supported.length) throw new Error('No supported native compatibility modules were found.');
    if (launch) {
      // LaunchServices cannot pass the debugging pipe to the application.
      const reserve = net.createServer();
      reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
      port = reserve.address().port;
      await new Promise(resolve => reserve.close(resolve));
    }
    assets = supported;
  } catch (error) { setupError = error; }
  const debugArgs = !assets ? [] : port ? ['--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + port] : ['--remote-debugging-pipe'];
  let child;
  if (launch) child = await launch([...debugArgs, ...args]);
  else {
    const stdio = ['ignore', 'ignore', onSpawn ? 'pipe' : 'ignore'];
    if (assets) stdio.push('pipe', 'pipe');
    child = spawn(executable, [...debugArgs, ...args], { env: { ...env, CODEX_HOME: home }, windowsHide: true, detached: true, stdio });
    await once(child, 'spawn');
  }
  onSpawn?.(child);
  status.pid = child.pid;
  if (setupError) {
    noteUiFailure(status, setupError);
    status.phase = 'degraded';
    report();
  } else {
    status.phase = 'connecting'; report();
    void installQuota({ child, port, models, cache, archive, assets, timeoutMs: startupTimeoutMs, status, report });
  }
  return child;
}

async function main() {
  const [executable, archive, root, home] = process.argv.slice(2);
  const child = await startQuotaCompatibleClient({ executable, archive, root, home });
  if (child.exitCode === null && child.signalCode === null) await once(child, 'exit');
  process.exitCode = child.exitCode ?? (child.signalCode ? 1 : 0);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(error => { process.stderr.write(error.message + '\\n'); process.exitCode = 1; });
