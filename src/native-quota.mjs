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
import { Script, runInNewContext } from 'node:vm';
import WebSocket from 'ws';
import { atomicPrivate } from './settings.mjs';
import { errorDetails, describeError } from './diagnostics.mjs';

const quotaGuard = /(?<![\w$])([A-Za-z_$][\w$]*)="local"===([A-Za-z_$][\w$]*)&&([A-Za-z_$][\w$]*)\|\|\(0,([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\)\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\)/g;
const quotaAssetRevision = 7;
const escaped = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function scopeContextWindow(source, key) {
  if (!source.includes('"tokenUsageInfo"')) return { text: source, count: 0 };
  const identifier = '[A-Za-z_$][\\w$]*';
  const atoms = new RegExp('(' + identifier + ')=\\(0,' + identifier + '\\.tv\\)\\("tokenUsageInfo"\\)', 'g');
  const modelSelector = new RegExp('(' + identifier + ')=\\(0,(' + identifier + ')\\.i1\\)\\((' + identifier + ')\\.u,\\((' + identifier + '),\\{get:(' + identifier + ')\\}\\)=>\\5\\(' + identifier + ',\\4\\)\\?\\.model\\?\\?null\\)', 'g');
  let text = source, count = 0;
  for (const atom of [...source.matchAll(atoms)].reverse()) {
    const before = source.slice(Math.max(0, atom.index - 2400), atom.index);
    const model = [...before.matchAll(modelSelector)].at(-1);
    if (!model || before.slice(model.index + model[0].length).includes(';')) continue;
    const [, selected, hooks, scope, thread, get] = model;
    const read = get + '(' + atom[1] + ',{hostId:' + get + '(';
    const prefix = ',(' + identifier + ')=\\(0,' + escaped(hooks) + '\\.i1\\)\\(' + escaped(scope) + '\\.u,\\(' + escaped(thread) + ',\\{get:' + escaped(get) + '\\}\\)=>';
    const original = new RegExp('^' + prefix + 'null==' + escaped(thread) + '\\?null:' + escaped(read) + '(' + identifier + ')\\.qX,' + escaped(thread) + '\\),threadId:' + escaped(thread) + '\\}\\)\\)');
    const offset = atom.index + atom[0].length, match = source.slice(offset).match(original);
    if (!match) continue;
    const host = get + '(' + match[2] + '.qX,' + thread + ')';
    const readUsage = get + '(' + atom[1] + ',{hostId:' + host + ',threadId:' + thread + '})';
    const body = [
      '{if(null==' + thread + ')return null;',
      'const __chatgptApiUsage=' + readUsage + ';',
      'const __chatgptApiWindow="local"===' + host + '?globalThis[' + JSON.stringify(key) + ']?.contextWindows?.[' + get + '(' + selected + ',' + thread + ')]:null;',
      'return __chatgptApiUsage&&Number.isFinite(__chatgptApiWindow)&&__chatgptApiWindow>0&&__chatgptApiUsage.modelContextWindow!==__chatgptApiWindow',
      '?{...__chatgptApiUsage,modelContextWindow:__chatgptApiWindow}:__chatgptApiUsage})',
    ].join('');
    const head = match[0].slice(0, match[0].indexOf('=>') + 2);
    text = text.slice(0, offset) + head + body + text.slice(offset + match[0].length);
    count++;
  }
  return { text, count };
}
function scopeComposerSubmission(source, key) {
  if (!source.includes('activeCollaborationMode:') && !source.includes('n("eLmE")')) return { text: source, count: 0, legacyCount: 0 };
  const identifier = '[A-Za-z_$][\\w$]*';
  const variable = '(?<![\\w$])';
  const hardReads = new RegExp(variable + '(' + identifier + ')=\\(0,' + identifier + '\\.(' + identifier + ')\\)\\((' + identifier + ')\\.(' + identifier + '),(' + identifier + ')\\)', 'g');
  const props = /activeCollaborationMode:([A-Za-z_$][\w$]*),[^{};]{0,1200}?\b(submitDisabled(?:Reasons)?):([A-Za-z_$][\w$]*)/g;
  const components = [...source.matchAll(props)], changes = [];
  let count = 0, legacyCount = 0;
  // The shared composer receives account-level reasons from its caller. Scope
  // those reasons where the selected model and host are both available.
  for (const component of components) {
    const [, mode, property, disabled] = component;
    if (property !== 'submitDisabledReasons') continue;
    const start = component.index + component[0].length;
    const body = source.slice(start, start + 64 * 1024);
    const selection = body.match(new RegExp(variable + '(' + identifier + ')=' + escaped(mode) +
      '\\?\\.settings(?:\\?\\.|\\.)model\\?\\?null;[^;]{0,400}?\\{hostId:(' + identifier + '\\.hostId),selectedModel:\\1\\}'));
    if (!selection) continue;
    const list = body.match(new RegExp(variable + '(' + identifier + ')=\\[' + escaped(disabled) +
      '(?:,' + identifier + ')*\\]\\.filter\\(Boolean\\)'));
    if (!list || list.index <= selection.index) continue;
    const joined = body.match(new RegExp(variable + '(' + identifier + ')=(' + escaped(list[1]) +
      '\\.join\\(","\\)),(' + identifier + ')=\\1\\.length>0'));
    if (!joined || joined.index <= list.index) continue;
    const gateway = '"local"===' + selection[2] + '&&globalThis[' + JSON.stringify(key) + ']?.models?.has(' + selection[1] + ')';
    const original = joined[2];
    const scoped = '(' + list[1] + '.length&&' + gateway + '?' + original +
      '.split(",").filter(reason=>reason!=="reserve-limit"&&reason!=="usage-limit").join(","):' + original + ')';
    changes.push({ offset: start + joined.index + joined[1].length + 1, length: original.length, text: scoped });
    count++;
  }
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
  if (!source.includes('sendBlocked:') && !source.includes('serviceTierAccess:') && !source.includes('submitDisabled:') && !source.includes('submitDisabledReasons:') && !source.includes('"tokenUsageInfo"')) {
    return { text: source, count: 0, quotaCount: 0, fastCount: 0, submitCount: 0, legacySubmitCount: 0, contextCount: 0 };
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
  const context = scopeContextWindow(submission.text, key);
  return { text: context.text, count: quotaCount + fastCount + submission.count + context.count, quotaCount, fastCount, submitCount: submission.count, legacySubmitCount: submission.legacyCount, contextCount: context.count };
}
function readAsset(fd, entry, buffer = Buffer.allocUnsafe(entry.size)) {
  const bytes = buffer.subarray(0, entry.size);
  if (fs.readSync(fd, bytes, 0, bytes.length, entry.offset) !== bytes.length) throw new Error('Incomplete native asset.');
  return bytes;
}

function readAssetSources(fd, entries) {
  return entries.map(entry => {
    let source = readAsset(fd, entry).toString();
    if (entry.factory) {
      // Function.toString() drops the object key for function expressions.
      if (entry.factoryExpression) source = '[' + JSON.stringify(entry.moduleId) + ']:(' + source + ')';
      source = 'export const __webpack_modules__={' + source + '};';
    }
    return { ...entry, source };
  });
}

function assetFeatures({ quotaCount, submitCount, legacySubmitCount, fastCount, contextCount }) {
  return [quotaCount || submitCount || legacySubmitCount ? 'send' : '', fastCount ? 'fast' : '', contextCount ? 'context' : ''].filter(Boolean);
}

function isFactoryExpression(source) {
  try { new Script('(' + source + ')'); return true; }
  catch { return false; } // Method shorthand keeps its own key in the object literal.
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
          && (contents.includes('"reserve-limit"') || contents.includes('n("eLmE")') || contents.includes('selectedModel:'));
        const context = contents.includes('"tokenUsageInfo"');
        if (!quota && !fast && !composer && !context) continue;
        const source = contents.toString(), adapted = scopeNativeQuota(source, 'quota_probe');
        if (adapted.count || adapted.legacySubmitCount) {
          const supportedFormat = source.includes('export const __webpack_modules__=');
          if (adapted.contextCount && supportedFormat) {
            // The context selector lives in a large shared chunk. Register its
            // factories without running them, and retain only matching ranges.
            const definitions = source.replaceAll('export const ', 'const ');
            const modules = runInNewContext(definitions + '\n__webpack_modules__', Object.create(null), { timeout: 1000 });
            for (const [moduleId, factory] of Object.entries(modules)) {
              if (typeof factory !== 'function') continue;
              const text = Function.prototype.toString.call(factory), scoped = scopeNativeQuota(text, 'quota_probe');
              if (!scoped.count && !scoped.legacySubmitCount) continue;
              const bytes = Buffer.from(text), offset = contents.indexOf(bytes);
              if (offset < 0) throw new Error('Native module source range is unavailable.');
              entries.push({ ...location, offset: location.offset + offset, size: bytes.length, factory: true,
                moduleId, factoryExpression: isFactoryExpression(text), features: assetFeatures(scoped),
                count: scoped.count, submitCount: scoped.submitCount, legacySubmitCount: scoped.legacySubmitCount, supportedFormat });
            }
          } else entries.push({ ...location, features: assetFeatures(adapted), count: adapted.count, submitCount: adapted.submitCount,
            legacySubmitCount: adapted.legacySubmitCount, supportedFormat });
        }
      }
    }
    scan(tree);
    if (!entries.length) throw Object.assign(new Error('未找到可识别的客户端界面模块。'), { code: 'native_ui_unsupported' });
    if (cacheFile) atomicPrivate(cacheFile, { revision: quotaAssetRevision, identity, entries });
    return result(entries);
  } finally { fs.closeSync(fd); }
}
export function gatewayQuotaModels(catalog, mode = 'mixed') {
  const official = new Set(mode === 'gateway' ? [] : (catalog.official || []).map(model => model.slug));
  return (catalog.gatewayIds || []).filter(model => !official.has(model));
}
export function quotaBootstrap(assets, models, key, binding, contextWindows = {}) {
  const modules = assets.map((asset, index) => {
    const adapted = scopeNativeQuota(asset.source, key);
    const source = adapted.text.replace('export const __rspack_esm_ids=', 'const __rspack_esm_ids=')
      .replace('export const __webpack_modules__=', 'const __webpack_modules__=');
    return '{const asset=' + index + ';try{const prepared=(()=>{"use strict";\n' + source + '\nreturn __webpack_modules__})();' +
      'const ids=Object.keys(prepared).filter(id=>typeof prepared[id]==="function"&&prepared[id].toString().includes(key));' +
      'if(!ids.length){failed("native_module_not_found","No matching interface module",asset)}else{' +
      'import(' + JSON.stringify(asset.url) + ').then(native=>{' +
      'if(ids.some(id=>typeof native.__webpack_modules__?.[id]!=="function")){failed("native_module_changed","Native module IDs no longer match",asset);return}' +
      'for(const id of ids)native.__webpack_modules__[id]=prepared[id];' +
      'state.installed+=ids.length;state.pending--;notify()' +
      '},error=>failed("native_module_import_failed",error,asset)).catch(error=>failed("native_module_install_failed",error,asset))}' +
      '}catch(error){failed("native_module_prepare_failed",error,asset)}}';
  }).join('\n');
  return '(()=>{if(typeof location!=="undefined"&&(location.protocol!=="app:"||location.host!=="-"||self!==top))return;const key=' + JSON.stringify(key) + ';if(globalThis[key])return;' +
    'const state=globalThis[key]={models:new Set(' + JSON.stringify(models) + '),contextWindows:' + JSON.stringify(contextWindows) + ',pending:' + assets.length + ',installed:0};' +
    'const notify=(initial=false,failure)=>{const fn=globalThis[' + JSON.stringify(binding) + '];if(typeof fn==="function")fn(JSON.stringify({pending:state.pending,installed:state.installed,failure,initial}))};' +
    'const failed=(code,error,asset)=>{state.pending--;notify(false,{code,message:String(error),asset})};notify(true);' +
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

const featureEffects = {
  send: '官方订阅额度用完时，自定义模型的发送按钮可能变灰。',
  fast: '支持快速模式的自定义模型可能不显示小闪电。',
  context: '切换自定义模型后，对话里显示的上下文容量可能未更新。',
};
const failureReasons = {
  ENOENT: '启动器找不到当前客户端的界面资源文件。',
  EACCES: '系统拒绝读取客户端界面资源。',
  EPERM: '系统拒绝读取客户端界面资源。',
  native_ui_unsupported: '启动器在当前客户端版本中未找到可识别的界面模块。',
  native_send_unsupported: '当前客户端的发送按钮使用了启动器尚未支持的额度规则。',
  native_module_format: '当前客户端使用了启动器尚未支持的界面模块格式。',
  native_module_changed: '启动器定位的模块编号与客户端加载的模块不一致。',
  native_module_import_failed: '客户端未能加载这项功能的界面模块。',
  native_module_prepare_failed: '启动器未能解析这项功能的界面模块。',
  native_module_not_found: '启动器在界面资源中未找到这项功能对应的模块。',
  native_module_install_failed: '客户端加载了界面模块，但未能应用启动器的兼容处理。',
  native_module_failed: '这项功能的界面模块未能加载。',
  native_model_catalog_unavailable: '启动器未能读取本地自定义模型列表，无法确定要适配的模型。',
  native_endpoint_unavailable: '客户端未在等待时间内开放本机界面连接。',
  native_endpoint_invalid: '客户端返回了无效的本机界面连接地址。',
  native_page_not_attached: '启动器未在等待时间内找到 ChatGPT 主界面。',
  native_bootstrap_not_started: 'ChatGPT 主界面已打开，兼容脚本未在等待时间内开始执行。',
  native_module_load_timeout: '兼容脚本已启动，部分界面模块未在等待时间内完成加载。',
  native_command_timeout: '客户端未在等待时间内响应界面兼容请求。',
  native_command_failed: '客户端拒绝执行界面兼容请求。',
  native_debugger_closed: '客户端与启动器的本机界面连接提前断开。',
};

function noteUiFailure(status, error, asset, features = asset?.features || []) {
  const code = error.code || 'native_setup_failed';
  const stageReasons = {
    scanning: '启动器读取客户端界面资源时失败。',
    connecting: '启动器未能连接到客户端的本机界面。',
    installing: '启动器在加载客户端界面模块时失败。',
  };
  const reason = Object.hasOwn(failureReasons, code) ? failureReasons[code] : stageReasons[status.phase] || '客户端的界面兼容连接已停止。';
  const details = errorDetails(error);
  const failure = { code, reason, phase: status.phase, features, details, ...(asset ? { asset: asset.url } : {}) };
  status.failures = [...(status.failures || []), failure];
  status.errors = status.failures.length;
  if (status.errors !== 1) return;
  status.failurePhase = failure.phase;
  status.code = code;
  status.lastError = describeError(error);
  status.failure = details;
  if (asset) status.failedAsset = asset.url;
}

export function quotaWarningMessage(status) {
  const groups = new Map();
  for (const failure of status.failures || []) {
    if (!groups.has(failure.reason)) groups.set(failure.reason, new Set());
    const effects = groups.get(failure.reason);
    for (const feature of failure.features) if (Object.hasOwn(featureEffects, feature)) effects.add(featureEffects[feature]);
  }
  const messages = [...groups].map(([reason, effects]) => [...effects, reason].join('\n'));
  const version = status.clientVersion ? '\n当前客户端版本 ' + status.clientVersion + '。' : '';
  return ['ChatGPT 已启动，可以继续使用。' + version, ...messages].join('\n\n');
}

function showQuotaWarning(status) {
  const title = 'ChatGPT API 界面兼容提示';
  const message = quotaWarningMessage(status);
  let commands = [];
  if (process.platform === 'win32') {
    const literal = value => "'" + value.replaceAll("'", "''").replaceAll('\n', '\r\n') + "'";
    const script = '$shell=New-Object -ComObject WScript.Shell\n[void]$shell.Popup(' + literal(message) + ',30,' + literal(title) + ',48)';
    commands = [[path.join(process.env.WINDIR, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]]];
  } else if (process.platform === 'darwin') {
    commands = [['/usr/bin/osascript', ['-e', 'on run argv\ndisplay alert (item 1 of argv) message (item 2 of argv) as warning giving up after 30\nend run', title, message]]];
  } else if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) {
    commands = [['zenity', ['--warning', '--timeout=30', '--title=' + title, '--text=' + message]],
      ['kdialog', ['--title', title, '--passivepopup', message, '30']]];
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

async function installQuota({ child, port, models, contexts, cache, archive, assets, timeoutMs, status, report }) {
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
        throw Object.assign(new Error('Invalid native compatibility endpoint.'), { code: 'native_endpoint_invalid' });
      }
      socket = new WebSocket(address, { handshakeTimeout: timeoutMs });
      socket.on('error', () => {});
      await Promise.race([once(socket, 'open'), ended]);
    }
    pipe = nativePipe(child, socket, timeoutMs, disconnected);
    const sessions = new Set(), key = '__chatgpt_api_quota_' + crypto.randomBytes(8).toString('hex'), binding = key + '_notify';
    let latest = models();
    let latestContexts = contexts(latest);
    const writeModels = (id, ids) => pipe.send('Runtime.evaluate', {
      expression: '{const state=globalThis[' + JSON.stringify(key) + '];if(state){state.models=new Set(' + JSON.stringify(ids) + ');state.contextWindows=' + JSON.stringify(latestContexts) + '}}',
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
          if (value.failure) {
            const { code, message, asset } = value.failure;
            noteUiFailure(status, Object.assign(new Error(message), { code: code || 'native_module_failed' }), assets[asset]);
          }
          status.pending = value.pending;
          status.installed = Math.max(status.installed, value.installed || 0);
          if (value.pending === 0) {
            if (!status.installed && !status.errors) noteUiFailure(status,
              Object.assign(new Error('No native compatibility modules were installed.'), { code: 'native_module_not_found' }));
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
          try { source = quotaBootstrap(readAssetSources(fd, assets), ids, key, binding, latestContexts); }
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
        let ids, windows; try { ids = models(); windows = contexts(ids); } catch { return; }
        if (ids.length === latest.length && ids.every((id, index) => id === latest[index]) && JSON.stringify(windows) === JSON.stringify(latestContexts)) return;
        latest = ids;
        latestContexts = windows;
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
  const models = () => {
    try { return gatewayQuotaModels(JSON.parse(fs.readFileSync(cache, 'utf8')), routeMode); }
    catch (cause) { throw Object.assign(new Error('Could not read the local custom model catalog.', { cause }), { code: 'native_model_catalog_unavailable' }); }
  };
  const contexts = ids => {
    try {
      const allowed = new Set(ids);
      const catalog = JSON.parse(fs.readFileSync(path.join(root, 'data/cache/models-smr.json'), 'utf8')).models;
      return Object.fromEntries(catalog.filter(model => allowed.has(model.slug) && model.context_window > 0)
        .map(model => [model.slug, Math.floor(model.context_window * (model.effective_context_window_percent ?? 95) / 100)]));
    } catch { return {}; }
  };
  let assets, port, setupError;
  report();
  try {
    const candidates = nativeQuotaAssets(archive, path.join(root, 'data/cache/native-ui-index.json'), false);
    const hasGateway = models().length > 0;
    for (const asset of candidates) {
      if (!asset.supportedFormat) {
        noteUiFailure(status, Object.assign(new Error('客户端界面模块格式已变更。'), { code: 'native_module_format' }), asset);
      } else if (hasGateway && asset.legacySubmitCount > asset.submitCount) {
        noteUiFailure(status, Object.assign(new Error('当前客户端的 API 发送界面规则已变更。'), { code: 'native_send_unsupported' }), asset, ['send']);
      }
    }
    const supported = candidates.filter(asset => asset.supportedFormat && asset.count);
    status.modules = supported.length;
    if (!supported.length && !status.errors) throw Object.assign(new Error('No supported native compatibility modules were found.'), { code: 'native_ui_unsupported' });
    if (supported.length && launch) {
      // LaunchServices cannot pass the debugging pipe to the application.
      const reserve = net.createServer();
      reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
      port = reserve.address().port;
      await new Promise(resolve => reserve.close(resolve));
    }
    if (supported.length) assets = supported;
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
  if (!assets) {
    if (setupError) noteUiFailure(status, setupError);
    status.phase = 'degraded';
    report();
  } else {
    status.phase = 'connecting'; report();
    void installQuota({ child, port, models, contexts, cache, archive, assets, timeoutMs: startupTimeoutMs, status, report });
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
