import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, spawn } from 'node:child_process';

// Keep dates predictable without replacing UTF-8 installation paths with '?'.
const psEnv = () => ({ ...process.env, LC_ALL: '', LC_TIME: 'C',
  LC_CTYPE: process.platform === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8' });
export function parseProcessIdentity(output, pid) {
  const match = output.trim().match(/^(.+?\d{4})\s+(\d+)\s+(\S+)\s+([\s\S]+)$/);
  if (!match || match[3].startsWith('Z')) return null;
  return { pid: Number(pid), start: match[1].replace(/\s+/g, ' '), uid: Number(match[2]), command: match[4] };
}
export function processIdentity(pid) {
  if (!Number.isSafeInteger(Number(pid)) || Number(pid) <= 0) return null;
  try {
    return parseProcessIdentity(execFileSync('/bin/ps', ['-ww', '-p', String(pid), '-o', 'lstart=', '-o', 'uid=', '-o', 'stat=', '-o', 'args='],
      { encoding: 'utf8', timeout: 5000, env: psEnv(), stdio: ['ignore', 'pipe', 'ignore'] }), pid);
  } catch { return null; }
}
export function sameProcess(record, current) {
  return !!record && !!current && current.pid === record.pid && current.start === record.start && current.uid === record.uid;
}
export const alive = record => !!record && sameProcess(record, processIdentity(record.pid));
export function parseClientProcesses(output, uid) {
  return output.split(/\r?\n/).flatMap(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (!match || Number(match[1]) !== uid) return [];
    // Main bundle executables only; helpers are under Contents/Frameworks.
    return /\/(?:ChatGPT|Codex)\.app\/Contents\/MacOS\/[^/]+$/i.test(match[3]) ? [Number(match[2])] : [];
  });
}
export function runningClients() {
  if (process.platform !== 'darwin') return [];
  // Failure must not be interpreted as "the client is closed".
  const output = execFileSync('/bin/ps', ['-ww', '-ax', '-o', 'uid=', '-o', 'pid=', '-o', 'comm='],
    { encoding: 'utf8', timeout: 5000, env: psEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  return parseClientProcesses(output, process.getuid());
}
export function requireClosedClient() {
  if (runningClients().length) throw new Error('Fully quit ChatGPT/Codex before installing, configuring, restoring, or stopping the provider.');
}
export const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";
export function launcherText(ctx) {
  return '#!/bin/sh\nset -eu\nexec /usr/bin/env ' + shellQuote('CODEX_HOME=' + ctx.home) + ' ' + shellQuote(ctx.node) + ' ' + shellQuote(path.join(ctx.root, 'macos/provider.mjs')) + ' "$@"\n';
}
export function clientExecutable(readPlist = file => execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleExecutable', file],
  { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim()) {
  const candidates = process.env.CHATGPT_API_CLIENT ? [process.env.CHATGPT_API_CLIENT]
    : ['/Applications/ChatGPT.app', path.join(os.homedir(), 'Applications/ChatGPT.app'),
       '/Applications/Codex.app', path.join(os.homedir(), 'Applications/Codex.app')];
  for (const candidate of candidates) {
    try {
      let file = path.resolve(candidate);
      if (file.endsWith('.app')) {
        const executable = readPlist(path.join(file, 'Contents/Info.plist'));
        if (!executable || /[\/\\\r\n\0]/.test(executable) || executable === '.' || executable === '..') continue;
        file = path.join(file, 'Contents/MacOS', executable);
      }
      fs.accessSync(file, fs.constants.X_OK);
      if (fs.statSync(file).isFile()) return file;
    } catch {}
  }
  throw new Error('ChatGPT/Codex.app was not found. Install the official desktop app, or set CHATGPT_API_CLIENT to its .app bundle or executable path.');
}

export function nativeCli(client) {
  const bundle = client?.match(/^(.*\.app)\/Contents\/MacOS\//)?.[1];
  const candidates = process.env.CHATGPT_API_CLI ? [process.env.CHATGPT_API_CLI]
    : bundle ? [
      path.join(bundle, 'Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'),
      path.join(bundle, 'Contents/Resources/codex'),
      path.join(bundle, 'Contents/Resources/codex-cli'),
    ] : [];
  for (const file of candidates) {
    try { fs.accessSync(file, fs.constants.X_OK); if (fs.statSync(file).isFile()) return file; } catch {}
  }
  return null;
}

export function clientLaunchCommand(client, args, home, { wait = true, platform = process.platform, opener = '/usr/bin/open' } = {}) {
  if (platform !== 'darwin') return { command: client, args };
  const bundle = client?.match(/^(.*\.app)\/Contents\/MacOS\/[^/]+$/i)?.[1];
  if (!bundle) throw new Error('The macOS client must be an executable inside its official .app bundle. Set CHATGPT_API_CLIENT to the installed .app.');
  // Launch the signed application through LaunchServices, rather than making
  // its main executable a descendant of the API launcher. -W keeps restoration
  // tied to the application lifetime; neither -n nor -F may reset its session.
  return { command: opener, args: [...(wait ? ['-W'] : []), '-a', bundle, '--env', 'CODEX_HOME=' + home,
    ...(args.length ? ['--args', ...args] : [])] };
}

export async function startNativeClient(client, args, home, options = {}) {
  const launch = clientLaunchCommand(client, args, home, options);
  const child = spawn(launch.command, launch.args, { detached: true, stdio: 'ignore',
    env: { ...process.env, CODEX_HOME: home } });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  return child;
}

export function officialProxy(settings = {}, env = process.env, readSystem = () => execFileSync('/usr/sbin/scutil', ['--proxy'],
  { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] })) {
  const configured = settings.OFFICIAL_PROXY || env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy;
  if (configured) {
    const url = new URL(configured);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('The official HTTP proxy must use http:// or https://.');
    return url.href;
  }
  if (process.platform !== 'darwin') return '';
  let text; try { text = readSystem(); } catch { return ''; }
  return parseSystemProxy(text);
}

export function parseSystemProxy(text) {
  const value = key => text.match(new RegExp('^\\s*' + key + '\\s*:\\s*(.+)$', 'm'))?.[1].trim();
  for (const prefix of ['HTTPS', 'HTTP']) {
    const host = value(prefix + 'Proxy'), port = value(prefix + 'Port');
    if (value(prefix + 'Enable') === '1' && host && /^\d+$/.test(port || '') && Number(port) > 0 && Number(port) <= 65535) {
      return 'http://' + (host.includes(':') ? '[' + host + ']' : host) + ':' + port;
    }
  }
  return '';
}
