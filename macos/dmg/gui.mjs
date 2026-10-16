import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const run = promisify(execFile);
const dialogScript = String.raw`
function run(argv) {
  var app = Application.currentApplication();
  app.includeStandardAdditions = true;
  var input = JSON.parse(argv[0]);
  try {
    if (input.kind === "prompt") {
      var result = app.displayDialog(input.message, {
        withTitle: "chatgpt-apionly",
        defaultAnswer: input.value || "",
        hiddenAnswer: Boolean(input.hidden),
        buttons: ["取消", "确定"],
        defaultButton: "确定",
        cancelButton: "取消"
      });
      return JSON.stringify({ value: result.textReturned });
    }
    app.displayAlert("chatgpt-apionly", { message: input.message, as: "critical", buttons: ["好"] });
    return JSON.stringify({ ok: true });
  } catch (error) {
    if (error.errorNumber === -128 || String(error).indexOf("(-128)") >= 0) return JSON.stringify({ cancelled: true });
    throw error;
  }
}
`;
export class Cancelled extends Error {}
export async function dialog(input) {
  // Passwords are returned through a private pipe, never passed in argv.
  const { stdout } = await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', dialogScript, JSON.stringify(input)], {
    encoding: 'utf8', timeout: 600000, maxBuffer: 128 * 1024,
  });
  const result = JSON.parse(stdout.trim());
  if (result.cancelled) throw new Cancelled();
  return result.value;
}
export function defaultInstallDirectory(home = os.homedir()) {
  return path.join(home, 'Library/Application Support/chatgpt-apionly');
}
async function modules(release) {
  const load = relative => import(pathToFileURL(path.join(release, 'payload/macos', relative)).href);
  const [provider, installer] = await Promise.all([load('provider.mjs'), load('install.mjs')]);
  return { provider, installer };
}
export async function prepareInstallation(releaseArg, destinationArg) {
  const { provider, installer } = await modules(releaseArg);
  const release = installer.canonicalPath(releaseArg), destination = installer.canonicalPath(destinationArg);
  const ctx = provider.context(destination);
  if (destination === path.parse(destination).root || destination === installer.canonicalPath(os.homedir()) ||
      destination === release || destination.startsWith(release + path.sep) || release.startsWith(destination + path.sep)) {
    throw new Error('Choose a separate program directory, outside the application bundle.');
  }
  const manifestBytes = fs.readFileSync(path.join(release, 'release.json'));
  const manifestHash = crypto.createHash('sha256').update(manifestBytes).digest('hex');
  const marker = path.join(ctx.data, 'state/dmg-package.json');
  const previous = provider.readJson(marker);
  if (previous?.manifestHash === manifestHash && fs.existsSync(ctx.node) && fs.existsSync(path.join(destination, 'macos/provider.mjs'))) {
    return { ctx, provider, updated: false };
  }
  provider.requireClosedClient();
  const { manifest, copies } = installer.verifyRelease(release, destination, 'arm64');
  await provider.stopRouter(ctx);
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  for (const { target, bytes, mode } of copies) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temporary = target + '.' + crypto.randomUUID() + '.tmp';
    try { fs.writeFileSync(temporary, bytes, { mode }); fs.renameSync(temporary, target); }
    finally { try { fs.unlinkSync(temporary); } catch {} }
  }
  fs.mkdirSync(ctx.data, { recursive: true, mode: 0o700 });
  fs.chmodSync(ctx.data, 0o700);
  provider.atomic(marker, { version: manifest.version, manifestHash });
  return { ctx, provider, updated: true };
}
export async function requestSettings(current, ask = dialog) {
  const base = await ask({ kind: 'prompt', message: '请输入自定义 API 基础 URL', value: current.BASE_URL || '' });
  const answer = await ask({ kind: 'prompt', message: current.API_KEY ? '请输入 API Key；留空保留原密钥' : '请输入 API Key', hidden: true });
  return { base, key: answer || current.API_KEY || '' };
}
export async function configureProvider(ctx, provider, values) {
  const names = ['CHATGPT_API_BASE_URL','CHATGPT_API_KEY'];
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  try {
    process.env.CHATGPT_API_BASE_URL = values.base;
    process.env.CHATGPT_API_KEY = values.key;
    return await provider.configure(ctx);
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
}
export async function main(args = process.argv.slice(2)) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('This app requires an Apple Silicon Mac.');
  const resources = path.dirname(fileURLToPath(import.meta.url));
  const { ctx, provider } = await prepareInstallation(path.join(resources, 'release'), defaultInstallDirectory());
  process.env.CHATGPT_API_ROOT = ctx.root;
  const current = provider.readSettings(ctx);
  if (!current.BASE_URL || !current.API_KEY || args.includes('--configure')) {
    provider.requireClosedClient();
    const values = await requestSettings(current);
    await configureProvider(ctx, provider, values);
  }
  await provider.main(['launch']);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(async error => {
    if (error instanceof Cancelled) return;
    let message = error.message || String(error);
    try {
      const { provider } = await modules(path.join(path.dirname(fileURLToPath(import.meta.url)), 'release'));
      const key = provider.readSettings(provider.context(defaultInstallDirectory())).API_KEY;
      if (key) message = message.replaceAll(key, '[redacted]');
    } catch {}
    try { await dialog({ kind: 'error', message }); } catch { process.stderr.write(message + '\n'); }
    process.exitCode = 1;
  });
}
