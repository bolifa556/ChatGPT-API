import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { runNativeSession } from '../src/native-session.mjs';

const checks = [];
for (const scenario of ['normal', 'native-crash', 'nonzero-exit', 'adapter-stop', 'startup-error', 'partial-startup-error', 'recovery-error', 'router-close-error']) {
  const server = http.createServer((_req, res) => res.end('session'));
  server.listen(0, '127.0.0.1');
  const ready = once(server, 'listening');
  const events = [];
  const statuses = [];
  let client;
  const task = runNativeSession({
    router: { routerReady: ready, closeRouter: async () => {
      events.push('router-closed');
      await new Promise(resolve => server.close(resolve));
      if (scenario === 'router-close-error') throw new Error('Fixture router close failed');
    } },
    start: async track => {
      if (scenario === 'startup-error' || scenario === 'recovery-error') throw new Error('Fixture startup failed');
      client = spawn(process.execPath, ['-e', 'process.on("message", message => { if(message === "close") process.exit(0); if(message === "crash"){ console.error("Fixture native stderr"); process.exit(17); }}); process.send("ready");'],
        { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
      await once(client, 'spawn');
      client.once('exit', () => events.push('native-exit'));
      track(client);
      await once(client, 'message');
      if (scenario === 'partial-startup-error') throw new Error('Fixture partial startup failed');
      return client;
    },
    onStatus: status => {
      statuses.push(status);
      if (!status.ready) return;
      events.push('ready');
      if (scenario === 'adapter-stop') process.emit('SIGTERM');
      else if (scenario === 'native-crash') client.kill('SIGKILL');
      else client.send(scenario === 'nonzero-exit' ? 'crash' : 'close');
    },
    recover: async () => {
      assert(!client || client.exitCode !== null || client.signalCode !== null, 'Restoration ran before the native client exited');
      assert(!server.listening, 'Restoration ran with a live router');
      events.push('restored');
      if (scenario === 'recovery-error') throw new Error('Fixture recovery failed');
    },
  });
  if (scenario === 'normal' || scenario === 'adapter-stop') await task;
  else await assert.rejects(task, error => {
    const expected = { 'native-crash': 'SIGKILL', 'nonzero-exit': '17', 'startup-error': 'Fixture startup failed',
      'partial-startup-error': 'Fixture partial startup failed', 'recovery-error': 'Fixture startup failed', 'router-close-error': 'Fixture router close failed' };
    assert(error.message.includes(expected[scenario]));
    if (scenario === 'recovery-error') {
      assert.equal(error.errors.length, 2);
      assert.equal(error.cause.message, 'Fixture startup failed');
      assert(error.message.includes('Fixture recovery failed'));
    }
    return true;
  });
  assert.equal(events.at(-1), 'restored');
  assert.equal(events.filter(value => value === 'restored').length, 1);
  if (client) assert(events.indexOf('native-exit') < events.indexOf('restored'));
  assert.equal(statuses.at(-1).stopped, true);
  if (scenario === 'nonzero-exit') {
    assert.equal(statuses.at(-1).exitCode, 17);
    assert(statuses.at(-1).error.includes('17'));
    assert(statuses.at(-1).clientStderr.includes('Fixture native stderr'));
  }
  if (scenario === 'partial-startup-error') assert(!statuses.some(status => status.ready));
  checks.push({ scenario, events, finalStatus: statuses.at(-1) });
}
let recoveredLiveClient = false;
const liveClient = { pid: 123, exitCode: null, signalCode: null, kill() { throw new Error('Fixture kill denied'); } };
await assert.rejects(runNativeSession({
  router: { routerReady: Promise.resolve(), closeRouter: async () => {} },
  start: async track => { track(liveClient); throw new Error('Fixture startup failed'); },
  recover: async () => { recoveredLiveClient = true; },
}), error => error.message.includes('Fixture startup failed') && error.message.includes('Fixture kill denied') && error.message.includes('still running'));
assert.equal(recoveredLiveClient, false, 'Configuration was restored while its recorded native client was still running');
checks.push({ scenario: 'kill-failure', recoveryDeferred: true });
console.log(JSON.stringify({ passed: true, checks }));
