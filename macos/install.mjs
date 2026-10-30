import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { context, atomic, configure, stopRouter, requireClosedClient } from './provider.mjs';
import { launcherText } from './platform.mjs';
import readline from 'node:readline/promises';
import { userApiSettings } from '../src/settings.mjs';

function noLinks(file) {
  for (let current = path.resolve(file); current !== path.dirname(current); current = path.dirname(current)) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('Program paths must not contain symbolic links: ' + current);
  }
}
export function canonicalPath(file) {
  const suffix = [];
  let parent = path.resolve(file);
  while (!fs.existsSync(parent)) {
    if (parent === path.dirname(parent)) throw new Error('Installation path has no existing parent.');
    suffix.unshift(path.basename(parent)); parent = path.dirname(parent);
  }
  // Resolve standard macOS aliases such as /var -> /private/var once, before
  // checking program files. Payload paths themselves must never contain links.
  return path.join(fs.realpathSync(parent), ...suffix);
}
function relativeFile(root, relative) {
  if (!relative || relative.includes('\\') || path.posix.isAbsolute(relative) || relative.split('/').some(part => !part || part === '.' || part === '..')
      || !/^(?:package(?:-lock)?\.json|(?:src|macos|runtime|assets|node_modules)\/.+)$/.test(relative)
      || /(^|\/)(?:data|\.env|\.git)(\/|$)/.test(relative)) throw new Error('Invalid program path in release manifest.');
  const file = path.resolve(root, relative); noLinks(file); return file;
}
export function verifyRelease(release, destination, architecture = process.arch) {
  const payload = path.join(release, 'payload');
  const manifest = JSON.parse(fs.readFileSync(path.join(release, 'release.json'), 'utf8'));
  if (manifest.schemaVersion !== 1 || manifest.product !== 'chatgpt-apionly-provider' || manifest.platform !== 'darwin-' + architecture || !manifest.files?.length) throw new Error('Invalid release or processor architecture.');
  const seen = new Set(), copies = [];
  for (const entry of manifest.files) {
    if (seen.has(entry.path)) throw new Error('Duplicate release path.'); seen.add(entry.path);
    const source = relativeFile(payload, entry.path), target = relativeFile(destination, entry.path);
    if (!fs.statSync(source).isFile()) throw new Error('Release entry is not a regular file.');
    const bytes = fs.readFileSync(source);
    if (bytes.length !== entry.bytes || crypto.createHash('sha256').update(bytes).digest('hex') !== entry.sha256) throw new Error('Release checksum failed: ' + entry.path);
    if (![0o644, 0o755].includes(entry.mode)) throw new Error('Invalid release permissions.');
    copies.push({ target, bytes, mode: entry.mode });
  }
  for (const required of ['runtime/node','macos/provider.mjs','macos/platform.mjs','macos/native.mjs','macos/chatgpt-apionly','macos/install.mjs','src/shim.mjs','src/transport.mjs','src/response-state.mjs','src/settings.mjs','src/gateway-sources.mjs','src/console.mjs','assets/console/index.html','assets/console/console.css','assets/console/console.js','assets/console/icon.svg','src/repair-thread-providers.mjs','src/model-context.mjs','src/gateway-recovery.mjs','assets/model-template.json','assets/model-contexts.json','package-lock.json']) {
    if (!seen.has(required)) throw new Error('Incomplete release: ' + required);
  }
  return { manifest, copies };
}
export async function install() {
  if (process.platform !== 'darwin' || process.getuid() === 0) throw new Error('Install as your macOS desktop user, without sudo.');
  const [releaseArg, destinationArg, ...flags] = process.argv.slice(2);
  if (flags.some(flag => flag !== '--skip-api')) throw new Error('Unknown installation option.');
  if (!releaseArg || !destinationArg || !path.isAbsolute(destinationArg) || /[\r\n\0]/.test(destinationArg)) throw new Error('Provide an absolute installation directory without line breaks.');
  const release = canonicalPath(releaseArg), destination = canonicalPath(destinationArg);
  if (destination === path.parse(destination).root || destination === canonicalPath(os.homedir()) || destination === release
      || destination.startsWith(release + path.sep) || release.startsWith(destination + path.sep)) throw new Error('Choose a separate program directory, outside the extracted release.');
  noLinks(destination); noLinks(release); requireClosedClient();
  const { manifest, copies } = verifyRelease(release, destination);
  const ctx = context(destination);
  const current = flags.includes('--skip-api') ? {} : userApiSettings(destination);
  let skipApi = flags.includes('--skip-api');
  if (!skipApi && !((process.env.CHATGPT_API_BASE_URL || current.BASE_URL) && (process.env.CHATGPT_API_KEY || current.API_KEY))) {
    if (!process.stdin.isTTY) skipApi = true;
    else {
      const reader = readline.createInterface({ input: process.stdin, output: process.stderr });
      try { skipApi = (await reader.question('\nChatGPT API 安装\n1  配置 API\n2  跳过，稍后配置\n选择 [2]: ')).trim() !== '1'; }
      finally { reader.close(); }
    }
  }
  // Complete verification before stopping or replacing installed programs.
  await stopRouter(ctx);
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  for (const { target, bytes, mode } of copies) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temporary = target + '.' + crypto.randomUUID() + '.tmp';
    try { fs.writeFileSync(temporary, bytes, { mode }); fs.renameSync(temporary, target); }
    finally { try { fs.unlinkSync(temporary); } catch {} }
  }
  fs.mkdirSync(ctx.data, { recursive: true, mode: 0o700 }); fs.chmodSync(ctx.data, 0o700);
  const result = await configure(ctx, false, !skipApi, { skipApi });
  const desktopEntry = path.join(os.homedir(), 'Desktop/chatgpt-apionly.command');
  atomic(desktopEntry, launcherText(ctx), 0o755); fs.chmodSync(desktopEntry, 0o755);
  console.log(JSON.stringify({ installed: destination, version: manifest.version, platform: manifest.platform, gatewayModels: result.models, configurationDeferred: Boolean(result.deferred), desktopEntry }, null, 2));
  if (result.deferred) console.log('安装完成，已跳过 API 配置。请通过 ChatGPT API 控制台添加 API 后启动。');
  console.log('Open chatgpt-apionly.command from your desktop. The release extraction directory can now be removed.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  install().catch(error => { const key = process.env.CHATGPT_API_KEY; console.error(key ? error.message.replaceAll(key, '[redacted]') : error.message); process.exitCode = 1; });
}
