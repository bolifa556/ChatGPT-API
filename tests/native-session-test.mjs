import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { runNativeSession } from '../src/native-session.mjs';

const checks = [];
for (const scenario of ['normal', 'native-crash', 'adapter-stop', 'startup-error']) {
  const server = http.createServer((_req, res) => res.end('session'));
  server.listen(0, '127.0.0.1');
  const ready = once(server, 'listening');
  const events = [];
  let client;
  const task = runNativeSession({
    router: { routerReady: ready, closeRouter: async () => {
      events.push('router-closed');
      await new Promise(resolve => server.close(resolve));
    } },
    start: async () => {
      if (scenario === 'startup-error') throw new Error('Fixture startup failed');
      client = spawn(process.execPath, ['-e', 'setTimeout(()=>{},600000)'], { windowsHide: true, stdio: 'ignore' });
      await once(client, 'spawn');
      client.once('exit', () => events.push('native-exit'));
      return client;
    },
    onStatus: status => {
      if (!status.ready) return;
      events.push('ready');
      if (scenario === 'adapter-stop') process.emit('SIGTERM');
      else client.kill(scenario === 'native-crash' ? 'SIGKILL' : 'SIGTERM');
    },
    recover: async () => {
      assert(!client || client.exitCode !== null || client.signalCode !== null, 'Restoration ran before the native client exited');
      assert(!server.listening, 'Restoration ran with a live router');
      events.push('restored');
    },
  });
  if (scenario === 'startup-error') await assert.rejects(task, /Fixture startup failed/);
  else await task;
  assert.equal(events.at(-1), 'restored');
  assert.equal(events.filter(value => value === 'restored').length, 1);
  if (client) assert(events.indexOf('native-exit') < events.indexOf('restored'));
  checks.push({ scenario, events });
}
console.log(JSON.stringify({ passed: true, checks }));
