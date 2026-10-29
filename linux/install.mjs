import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { context, atomic, configure, stopRouter, requireClosedClient } from '../payload/linux/provider.mjs';

function noLinks(file) {
  for (let current = path.resolve(file); current !== path.dirname(current); current = path.dirname(current)) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('Installation paths must not contain symbolic links: ' + current);
  }
}
function relativeFile(root, relative) {
  if (!relative || relative.includes('\\') || path.posix.isAbsolute(relative) || relative.split('/').some(part => !part || part === '.' || part === '..') || !/^(?:package(?:-lock)?\.json|(?:src|linux|runtime|assets|node_modules)\/.+)$/.test(relative) || /(^|\/)(?:data|\.env|\.git)(\/|$)/.test(relative)) throw new Error('Invalid program path in release manifest.');
  const file = path.resolve(root, relative); noLinks(file); return file;
}
const desktopQuote = value => '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('`', '\\`').replaceAll('$', '\\$').replaceAll('%', '%%') + '"';
async function install() {
  if (process.platform !== 'linux' || process.getuid() === 0) throw new Error('Install as your Linux desktop user, without sudo.');
  const [releaseArg, destinationArg] = process.argv.slice(2);
  if (!releaseArg || !destinationArg || !path.isAbsolute(destinationArg) || /[\r\n\0]/.test(destinationArg)) throw new Error('Provide an absolute installation directory without line breaks.');
  const release = path.resolve(releaseArg), destination = path.resolve(destinationArg), payload = path.join(release, 'payload');
  if (destination === '/' || destination === os.homedir() || destination === release || destination.startsWith(release + '/') || release.startsWith(destination + '/')) throw new Error('Choose a separate program directory, outside the extracted release.');
  noLinks(destination); noLinks(release); requireClosedClient();
  const manifest = JSON.parse(fs.readFileSync(path.join(release, 'release.json'), 'utf8'));
  if (manifest.schemaVersion !== 1 || manifest.product !== 'chatgpt-api-provider' || manifest.platform !== 'linux-' + process.arch || !manifest.files?.length) throw new Error('Invalid release or processor architecture.');
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
  for (const required of ['runtime/node','linux/provider.mjs','linux/console','linux/settings.mjs','linux/chatgpt-api','src/shim.mjs','src/transport.mjs','src/response-state.mjs','src/settings.mjs','src/gateway-sources.mjs','src/console.mjs','assets/console/index.html','assets/console/console.css','assets/console/console.js','assets/console/icon.svg','src/model-context.mjs','src/gateway-recovery.mjs','assets/model-template.json','assets/model-contexts.json','package-lock.json']) if (!seen.has(required)) throw new Error('Incomplete release: ' + required);
  const ctx = context(destination);
  // Verification finishes before stopping or replacing any installed program.
  await stopRouter(ctx);
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  for (const { target, bytes, mode } of copies) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temporary = target + '.' + crypto.randomUUID() + '.tmp';
    try { fs.writeFileSync(temporary, bytes, { mode }); fs.renameSync(temporary, target); }
    finally { try { fs.unlinkSync(temporary); } catch {} }
  }
  fs.mkdirSync(ctx.data, { recursive: true, mode: 0o700 }); fs.chmodSync(ctx.data, 0o700);
  const result = await configure(ctx);
  const applications = path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local/share'), 'applications');
  const entry = ['[Desktop Entry]','Type=Application','Name=ChatGPT API','Comment=ChatGPT with a custom API provider',
    'Exec=' + desktopQuote(path.join(destination, 'linux/chatgpt-api')), 'Icon=applications-development','Terminal=false','Categories=Development;', 'StartupNotify=true',''].join('\n');
  atomic(path.join(applications, 'chatgpt-api-provider.desktop'), entry, 0o644);
  const consoleEntry = ['[Desktop Entry]', 'Type=Application', 'Name=ChatGPT API 控制台', 'Comment=Manage API sources and model context',
    'Exec=' + desktopQuote(path.join(destination, 'linux/console')), 'Icon=' + path.join(destination, 'assets/console/icon.svg'), 'Terminal=false', 'Categories=Development;', ''].join('\n');
  atomic(path.join(destination, '控制台.desktop'), consoleEntry, 0o755);
  atomic(path.join(applications, 'chatgpt-api-console.desktop'), consoleEntry, 0o644);
  console.log(JSON.stringify({ installed: destination, version: manifest.version, platform: manifest.platform, gatewayModels: result.models, desktopEntry: path.join(applications, 'chatgpt-api-provider.desktop') }, null, 2));
  console.log('Open ChatGPT API from the applications menu. The release extraction directory can now be removed.');
}
install().catch(error => { const key = process.env.CHATGPT_API_KEY; console.error(key ? error.message.replaceAll(key, '[redacted]') : error.message); process.exitCode = 1; });
