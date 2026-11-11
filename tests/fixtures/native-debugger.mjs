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
  let binding, armed = false;
  const commands = [];
  const send = value => socket.send(JSON.stringify(value));
  const notify = value => send({ method: 'Runtime.bindingCalled', params: { name: binding, payload: JSON.stringify(value) }, sessionId: 'page-fixture' });
  socket.on('message', raw => {
    const call = JSON.parse(raw); commands.push(call.method);
    if (call.method === 'Runtime.runIfWaitingForDebugger' && scenario !== 'foreign-page' && !binding) {
      send({ id: call.id, error: { message: 'Readiness binding was registered after renderer execution' } }); return;
    }
    if (scenario === 'unresponsive') return;
    if (scenario === 'exit' && call.method === 'Target.setAutoAttach') { process.exit(17); }
    let result = {};
    if (call.method === 'Runtime.addBinding') binding = call.params.name;
    if (call.method === 'Runtime.evaluate') {
      const snapshot = call.params.expression.startsWith('JSON.stringify(');
      if (scenario === 'script-error' && !snapshot) result = { exceptionDetails: { text: 'Uncaught', exception: { description: 'SyntaxError: fixture bootstrap failed' } } };
      else if (snapshot && scenario !== 'unstarted') {
        const value = { pending: scenario === 'ready' ? 0 : 1, installed: scenario === 'ready' ? 1 : 0, error: null };
        if (scenario === 'module-error') { value.error = 'TypeError: Failed to fetch dynamically imported module'; value.failedAsset = 'app://-/assets/quota.js'; }
        result = { result: { type: 'string', value: JSON.stringify(value) } };
        if (scenario === 'notified' && !armed) {
          armed = true;
          setTimeout(() => notify({ pending: 0, installed: 1, error: null }), 20);
          setTimeout(() => notify({ pending: 1, installed: 0, error: null }), 60);
        }
      } else result = { result: { type: 'undefined' } };
    }
    if (call.method === 'Runtime.runIfWaitingForDebugger' && binding && commands.indexOf('Runtime.addBinding') < commands.indexOf('Runtime.runIfWaitingForDebugger')) {
      // This verifies registration precedes the renderer's first execution.
      result = { bindingRegisteredBeforeResume: true };
    }
    send({ id: call.id, result, ...(call.sessionId ? { sessionId: call.sessionId } : {}) });
    if (call.method === 'Target.setAutoAttach') send({ method: 'Target.attachedToTarget', params: { sessionId: 'page-fixture',
      targetInfo: { type: 'page', url: scenario === 'foreign-page' ? 'https://example.invalid/' : 'app://-/index.html' } } });
  });
});
server.listen(Number(port), '127.0.0.1');
