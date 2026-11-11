// The router and native UI compatibility share one process and one client
// lifetime. Recovery runs after that exact client exits, including crashes.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { atomicPrivate } from './settings.mjs';
import { startQuotaCompatibleClient } from './native-quota.mjs';
import { cleanManagedLogs, errorDetails, describeError, createDiagnosticLog } from './diagnostics.mjs';

export async function runNativeSession({ router, start, recover, onStatus = () => {} }) {
  let child, stopping = false, clientStderr = '';
  const errors = [], state = { ready: false, stopped: false, phase: 'router' };
  const report = value => { Object.assign(state, value); onStatus({ ...state }); };
  const stop = () => { stopping = true; if (child && child.exitCode === null && child.signalCode === null) child.kill(); };
  const track = nativeClient => {
    child = nativeClient;
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', chunk => { clientStderr = (clientStderr + chunk.toString()).slice(-8192); });
    report({ phase: 'client', pid: child.pid, nativeSpawnedAt: new Date().toISOString() });
    if (stopping) stop();
  };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  try {
    report({ phase: 'router' });
    await router.routerReady;
    report({ phase: 'launching' });
    child = await start(track, report);
    if (stopping) stop();
    else {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error('Native client exited before startup confirmation (' + (child.signalCode || child.exitCode) + ').');
      report({ ready: true, phase: 'running', pid: child.pid });
      if (typeof globalThis.gc === 'function') setImmediate(() => globalThis.gc());
    }
    if (child.exitCode === null && child.signalCode === null) await once(child, 'exit');
    if (!stopping && (child.exitCode !== 0 || child.signalCode)) {
      throw new Error('Native client exited with ' + (child.signalCode ? 'signal ' + child.signalCode : 'code ' + child.exitCode));
    }
  } catch (error) { state.failurePhase = state.phase; errors.push(error); }
  finally {
    process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop);
    try {
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill(); await once(child, 'exit');
      }
    } catch (error) { errors.push(error); }
    try { report({ ready: false, phase: 'recovering' }); } catch (error) { errors.push(error); }
    try { await router.closeRouter(); } catch (error) { errors.push(error); }
    if (child && child.exitCode === null && child.signalCode === null) errors.push(new Error('Native client is still running. Configuration recovery is pending.'));
    else {
      try { await recover(); } catch (error) { errors.push(error); }
      child?.stderr?.destroy();
    }
    const error = errors.map(error => error.message || String(error)).join('\n');
    try {
      report({ ready: false, stopped: true, phase: error ? 'failed' : 'stopped',
        exitCode: child?.exitCode ?? null, signal: child?.signalCode ?? null,
        error: error || null, ...(errors.length ? { failures: errors.map(value => errorDetails(value)),
          ...(clientStderr ? { clientStderr: clientStderr.trim() } : {}) } : {}) });
    } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, errors.map(error => error.message || String(error)).join('\n'), { cause: errors[0] });
}

async function main() {
  const [root, home, executable, archive, entryMode, session] = process.argv.slice(2);
  if (!path.isAbsolute(root || '') || !path.isAbsolute(home || '') || !path.isAbsolute(executable || '')
      || !['official', 'api', 'apionly'].includes(entryMode) || !/^[a-f0-9]{32}$/.test(session || '')) throw new Error('Invalid native session.');
  process.env.CODEX_HOME = home;
  process.env.CHATGPT_API_ROOT = root;
  cleanManagedLogs(root);
  // The file describes the latest attempt, never a previous launch failure.
  try { fs.unlinkSync(path.join(root, 'data/logs/native-session-stderr.log')); } catch {}
  const status = path.join(root, 'data/state/native-session.json');
  const startedAt = new Date().toISOString();
  const state = { session, entryMode, controllerPid: process.pid, startedAt,
    launcherStartedAt: process.env.CHATGPT_API_LAUNCH_STARTED_AT, ready: false, stopped: false, phase: 'initializing' };
  const report = value => {
    Object.assign(state, value, { updatedAt: new Date().toISOString() });
    atomicPrivate(status, state);
  };
  report({});
  atomicPrivate(path.join(root, 'data/state/native-quota.json'), { session, entryMode, ready: false, phase: entryMode === 'official' ? 'disabled' : 'waiting', startedAt });
  const args = process.env.CODEX_ELECTRON_USER_DATA_PATH ? ['--user-data-dir=' + path.resolve(process.env.CODEX_ELECTRON_USER_DATA_PATH)] : [];
  try {
    const router = await import('./shim.mjs');
    await runNativeSession({
      router,
      onStatus: report,
      start: async (track, progress) => {
        if (entryMode !== 'official') return startQuotaCompatibleClient({ executable, archive, root, home, args,
          onSpawn: track,
          onStatus: value => {
            atomicPrivate(path.join(root, 'data/state/native-quota.json'), { session, entryMode, updatedAt: new Date().toISOString(), ...value });
            if (!state.ready && !state.stopped) progress({ phase: value.phase, ...(value.pid ? { pid: value.pid } : {}) });
          } });
        const child = spawn(executable, args, { env: process.env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
        await once(child, 'spawn'); track(child); return child;
      },
      recover: async () => {
        const command = path.join(process.env.WINDIR, 'System32/WindowsPowerShell/v1.0/powershell.exe');
        const child = spawn(command, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
          path.join(root, 'src/Recover-ChatGPT.ps1'), '-Immediate', '-Session', session, '-ControllerPid', String(process.pid)], { windowsHide: true, stdio: 'ignore' });
        const [code] = await once(child, 'exit');
        if (code) throw new Error('Native configuration recovery is pending. See data/logs/recovery.log.');
      },
    });
  } catch (error) {
    try { report({ ready: false, stopped: true, phase: 'failed', error: error.message }); }
    catch (statusError) { throw new AggregateError([error, statusError], error.message + '\n' + statusError.message, { cause: error }); }
    throw error;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    const detail = describeError(error) + '\n' + JSON.stringify(errorDetails(error));
    createDiagnosticLog(path.join(process.argv[2], 'data/logs/native-session-stderr.log'))(detail);
    process.stderr.write(describeError(error) + '\n'); process.exitCode = 1;
  });
}
