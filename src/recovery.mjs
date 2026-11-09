// Internal, temporary recovery. Login triggers are removed after restoration.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { atomicPrivate } from './settings.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const journalPath = ctx => path.join(ctx.root, 'data/state/recovery.json');
const watcherPath = ctx => path.join(ctx.root, 'data/state/recovery-watcher.json');
const children = new Map();
const read = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
const xml = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const desktopQuote = text => '"' + text.replaceAll('%', '%%').replace(/[\\"`$]/g, '\\$&') + '"';
function bootIdentity() {
  if (process.platform === 'linux') return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  return execFileSync('/usr/sbin/sysctl', ['-n', 'kern.boottime'], { encoding: 'utf8' }).trim();
}

export function recoveryTrigger(ctx, platform, loginDirectory) {
  const id = crypto.createHash('sha256').update(path.resolve(ctx.root)).digest('hex').slice(0, 16);
  const script = path.join(ctx.root, 'src/recovery.mjs');
  const args = [ctx.node, script, platform, ctx.root, ctx.home];
  if (process.platform === 'darwin') {
    const label = 'local.chatgpt-api.recovery.' + id;
    return { file: path.join(loginDirectory || path.join(os.homedir(), 'Library/LaunchAgents'), label + '.plist'),
      text: '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>' + label + '</string><key>ProgramArguments</key><array>' + args.map(arg => '<string>' + xml(arg) + '</string>').join('') + '</array><key>RunAtLoad</key><true/></dict></plist>\n' };
  }
  return { file: path.join(loginDirectory || path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'autostart'), 'chatgpt-api-recovery-' + id + '.desktop'),
    text: '[Desktop Entry]\nType=Application\nName=ChatGPT API internal recovery\nNoDisplay=true\nTerminal=false\nExec=' + args.map(desktopQuote).join(' ') + '\n' };
}
export async function registerRecovery(ctx, platform, options = {}) {
  const provider = await import(pathToFileURL(path.join(ctx.root, platform, 'provider.mjs')));
  const owner = provider.processIdentity(process.pid);
  if (!owner) throw new Error('Cannot identify the launcher for automatic recovery.');
  const file = journalPath(ctx);
  if (read(file)) throw new Error('An earlier automatic recovery is still pending.');
  const session = crypto.randomUUID(), trigger = recoveryTrigger(ctx, platform, options.loginDirectory);
  atomicPrivate(file, { version: 1, session, platform, root: ctx.root, home: ctx.home, owner, boot: bootIdentity(), trigger: trigger.file,
    watchNativeClients: false }, { durable: true });
  atomicPrivate(trigger.file, trigger.text, { durable: true });
  fs.mkdirSync(path.join(ctx.root, 'data/logs'), { recursive: true, mode: 0o700 });
  let child;
  try {
    for (let n = 0; n < 100; n++) {
      const watcher = read(watcherPath(ctx));
      if (watcher && provider.alive(watcher.owner)) {
        if (watcher.session === session) return session;
      } else if (!child) {
        const errors = fs.openSync(path.join(ctx.root, 'data/logs/recovery.log'), 'a', 0o600);
        try {
          child = spawn(ctx.node, [path.join(ctx.root, 'src/recovery.mjs'), platform, ctx.root, ctx.home], {
            detached: true, stdio: ['ignore', 'ignore', errors, 'ipc'], env: { ...process.env, CODEX_HOME: ctx.home, CHATGPT_API_ROOT: ctx.root },
          });
        } finally { fs.closeSync(errors); }
        await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
        children.set(session, child);
        child.unref(); child.channel?.unref();
      }
      if (child && (child.exitCode !== null || child.signalCode !== null)) throw new Error('Automatic recovery exited before initialization (' + (child.signalCode || child.exitCode) + '). See data/logs/recovery.log.');
      if (!read(file)) throw new Error('Automatic recovery stopped during startup.');
      await delay(100);
    }
    throw new Error('Automatic recovery did not start.');
  } catch (error) { unregisterRecovery(ctx, session); throw error; }
}
export async function recordRecoveryClient(ctx, session, pid) {
  const saved = read(journalPath(ctx));
  if (saved?.session !== session) throw new Error('Automatic recovery session changed.');
  const provider = await import(pathToFileURL(path.join(ctx.root, saved.platform, 'provider.mjs')));
  atomicPrivate(journalPath(ctx), { ...saved, client: provider.processIdentity(pid) }, { durable: true });
}
export function unregisterRecovery(ctx, session) {
  const saved = read(journalPath(ctx));
  if (!saved || saved.session !== session) return;
  if (fs.existsSync(saved.trigger)) fs.unlinkSync(saved.trigger);
  fs.unlinkSync(journalPath(ctx));
  const child = children.get(session); children.delete(session);
  if (child?.connected) child.disconnect();
}
export async function recoverPending(ctx, platform) {
  const saved = read(journalPath(ctx));
  if (!saved) return false;
  if (saved.root !== ctx.root || saved.home !== ctx.home || saved.platform !== platform) throw new Error('Automatic recovery belongs to another installation.');
  const provider = await import(pathToFileURL(path.join(ctx.root, platform, 'provider.mjs')));
  const currentBoot = !saved.boot || saved.boot === bootIdentity();
  if (currentBoot && (provider.alive(saved.owner) || provider.alive(saved.client))) return false;
  await provider.withLaunchLock(ctx, async () => {
    if (read(journalPath(ctx))?.session !== saved.session) return;
    provider.restoreConfig(ctx);
    await provider.restoreThreadProviders(ctx);
    await provider.stopRouter(ctx);
    unregisterRecovery(ctx, saved.session);
  });
  return true;
}
async function watch(ctx, platform) {
  const provider = await import(pathToFileURL(path.join(ctx.root, platform, 'provider.mjs')));
  const file = watcherPath(ctx), owner = provider.processIdentity(process.pid);
  const prior = read(file);
  if (prior && provider.alive(prior.owner)) return;
  // Two login/launcher invocations can overlap. An exclusive lock establishes
  // the watcher owner before any recovery work starts.
  try { fs.writeFileSync(file, JSON.stringify({ owner }), { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const latest = read(file);
    if (latest && provider.alive(latest.owner)) return;
    fs.unlinkSync(file);
    return watch(ctx, platform);
  }
  try {
    atomicPrivate(file, { owner, session: read(journalPath(ctx))?.session });
    if (process.connected) {
      // IPC signals owner exit without polling a process list. Normal cleanup
      // disconnects it after removing this session's recovery journal.
      await new Promise(resolve => process.once('disconnect', resolve));
    }
    while (read(journalPath(ctx))) {
      const saved = read(journalPath(ctx));
      if ((!saved.boot || saved.boot === bootIdentity()) && provider.alive(saved.owner)) return;
      try { await recoverPending(ctx, platform); }
      catch (error) {
        fs.appendFileSync(path.join(ctx.root, 'data/logs/recovery.log'), new Date().toISOString() + ' ' + error.message + '\n', { mode: 0o600 });
      }
      // Only an abnormal owner exit can reach this retry path with its native
      // client still alive. Normal operation has no monitoring timer.
      if (read(journalPath(ctx))) await delay(1500);
    }
  } finally { if (read(file)?.owner?.pid === process.pid) fs.unlinkSync(file); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  const [platform, root, home] = process.argv.slice(2);
  if (!['linux', 'macos'].includes(platform) || !path.isAbsolute(root || '') || !path.isAbsolute(home || '')) throw new Error('Invalid internal recovery context.');
  const ctx = { root, home, data: path.join(root, 'data'), config: path.join(home, 'config.toml'), node: process.execPath };
  watch(ctx, platform).catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
}
