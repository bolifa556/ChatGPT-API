// The router and native UI compatibility share one process and one client
// lifetime. Recovery runs after that exact client exits, including crashes.
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { atomicPrivate } from './settings.mjs';
import { startQuotaCompatibleClient } from './native-quota.mjs';

export async function runNativeSession({ router, start, recover, onStatus = () => {} }) {
  let child, stopping = false;
  const stop = () => { stopping = true; if (child && child.exitCode === null && child.signalCode === null) child.kill(); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  try {
    await router.routerReady;
    child = await start();
    if (stopping) stop();
    onStatus({ ready: true, pid: child.pid });
    if (child.exitCode === null && child.signalCode === null) await once(child, 'exit');
  } finally {
    process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop);
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill(); await once(child, 'exit');
    }
    try { await router.closeRouter(); }
    finally { await recover(); }
    onStatus({ ready: false, stopped: true });
  }
}

async function main() {
  const [root, home, executable, archive, entryMode, session] = process.argv.slice(2);
  if (!path.isAbsolute(root || '') || !path.isAbsolute(home || '') || !path.isAbsolute(executable || '')
      || !['official', 'api', 'apionly'].includes(entryMode) || !/^[a-f0-9]{32}$/.test(session || '')) throw new Error('Invalid native session.');
  process.env.CODEX_HOME = home;
  process.env.CHATGPT_API_ROOT = root;
  const status = path.join(root, 'data/state/native-session.json');
  const args = process.env.CODEX_ELECTRON_USER_DATA_PATH ? ['--user-data-dir=' + path.resolve(process.env.CODEX_ELECTRON_USER_DATA_PATH)] : [];
  const router = await import('./shim.mjs');
  await runNativeSession({
    router,
    onStatus: value => atomicPrivate(status, { session, ...value }),
    start: async () => {
      if (entryMode !== 'official') return startQuotaCompatibleClient({ executable, archive, root, home, args,
        onStatus: value => atomicPrivate(path.join(root, 'data/state/native-quota.json'), { session, ...value }) });
      const child = spawn(executable, args, { env: process.env, windowsHide: true, stdio: 'ignore' });
      await once(child, 'spawn'); return child;
    },
    recover: async () => {
      const command = path.join(process.env.WINDIR, 'System32/WindowsPowerShell/v1.0/powershell.exe');
      const child = spawn(command, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
        path.join(root, 'src/Recover-ChatGPT.ps1'), '-Immediate', '-Session', session, '-ControllerPid', String(process.pid)], { windowsHide: true, stdio: 'ignore' });
      const [code] = await once(child, 'exit');
      if (code) throw new Error('Native configuration recovery is pending.');
    },
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
}
