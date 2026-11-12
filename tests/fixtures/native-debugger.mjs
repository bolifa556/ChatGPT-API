// A standalone CDP peer. Never starts or attaches to the user's native client.
import http from 'node:http';
import { WebSocketServer } from 'ws';

const [port, scenario] = process.argv.slice(2);
const server = http.createServer((_req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ webSocketDebuggerUrl: 'ws://127.0.0.1:' + port + '/devtools/browser/fixture' }));
});
const wss = new WebSocketServer({ server });
wss.on('connection', socket => {
  let binding;
  const send = value => socket.send(JSON.stringify(value));
  const notify = value => {
    if (socket.readyState === 1) send({ method: 'Runtime.bindingCalled', params: { name: binding, payload: JSON.stringify(value) }, sessionId: 'page-fixture' });
  };
  socket.on('message', raw => {
    const call = JSON.parse(raw);
    const reply = (value = {}) => send({ id: call.id, ...(call.sessionId ? { sessionId: call.sessionId } : {}), ...value });
    if (scenario === 'unresponsive') return;
    if (scenario === 'exit' && call.method === 'Target.setAutoAttach') { process.exit(17); }
    if (call.method === 'Target.setAutoAttach' && call.params.waitForDebuggerOnStart !== false) {
      return reply({ error: { message: 'The debugger paused the renderer' } });
    }
    if (call.method === 'Runtime.addBinding') binding = call.params.name;
    if (call.method === 'Page.addScriptToEvaluateOnNewDocument') {
      if (!binding || call.params.runImmediately !== true || scenario === 'script-error') {
        return reply({ error: { message: 'Fixture document bootstrap failed' } });
      }
      if (scenario !== 'unstarted') notify({ initial: true, pending: 1, installed: 0 });
      if (scenario === 'module-error' || scenario === 'partial-module-error') {
        notify({ pending: scenario === 'partial-module-error' ? 1 : 0, installed: 0,
          error: 'TypeError: Failed to fetch dynamically imported module', failedAsset: 'app://-/assets/quota.js' });
      }
      if (['ready', 'notified', 'partial-module-error', 'updated-module-format'].includes(scenario)) {
        setTimeout(() => notify({ pending: 0, installed: 1 }), 40);
      }
      if (scenario === 'notified') setTimeout(() => notify({ pending: 1, installed: 0 }), 80);
    }
    reply({ result: {} });
    if (call.method === 'Target.setAutoAttach') send({ method: 'Target.attachedToTarget', params: { sessionId: 'page-fixture',
      targetInfo: { type: 'page', url: scenario === 'foreign-page' ? 'https://example.invalid/' : 'app://-/index.html' } } });
  });
});
server.listen(Number(port), '127.0.0.1');
