// Parse the generated menus with an unmodified native client; no chats or inference.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = process.env.CODEX_CLI_PATH;
assert(cli && fs.existsSync(cli), 'Set CODEX_CLI_PATH to the current native client.');
const fixture = fs.mkdtempSync(path.join(root, 'data/testing/native-catalog-'));
const checks = [];
let serial = 0;
async function parseMenu(catalog, expectedError) {
  const home = path.join(fixture, 'home-' + (++serial));
  fs.mkdirSync(home);
  const catalogPath = path.join(home, 'catalog.json');
  fs.writeFileSync(catalogPath, JSON.stringify(catalog));
  fs.writeFileSync(path.join(home, 'config.toml'), [
    'model_catalog_json = ' + JSON.stringify(catalogPath),
    'model_provider = "catalog_fixture"',
    '[history]', 'persistence = "none"',
    '[analytics]', 'enabled = false',
    '[model_providers.catalog_fixture]', 'name = "Isolated catalog validation"',
    'base_url = "http://127.0.0.1:9/v1"', 'wire_api = "responses"',
    'requires_openai_auth = false', '',
  ].join('\n'));
  const client = spawn(cli, ['app-server', '--stdio'], {
    cwd: home, env: { ...process.env, CODEX_HOME: home, OPENAI_API_KEY: 'inert-catalog-fixture' },
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '', stdout = '';
  client.stderr.on('data', data => stderr += data);
  client.stdout.on('data', data => stdout += data);
  client.stdin.on('error', () => {});
  const lines = readline.createInterface({ input: client.stdout });
  const result = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Native catalog validation timed out. ' + stderr)), 20000);
    const settle = (error, value) => { clearTimeout(timer); error ? reject(error) : resolve(value); };
    client.on('error', error => settle(error));
    client.on('exit', code => {
      if (expectedError) {
        try { assert.match(stderr + stdout, expectedError); settle(null, { rejected: true, exitCode: code }); }
        catch (error) { settle(error); }
      } else settle(Error('Native client exited before model/list: ' + stderr + stdout));
    });
    lines.on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.id === 1) {
        if (message.error) { settle(Error(message.error.message)); return; }
        client.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
        // model/list can fall back to defaults after a config-load failure.
        // The desktop's config/read call must succeed before listing models.
        client.stdin.write(JSON.stringify({ id: 2, method: 'config/read', params: { includeLayers: false } }) + '\n');
      } else if (message.id === 2) {
        if (expectedError) {
          try { assert.match(message.error?.message || '', expectedError); settle(null, { rejected: true }); }
          catch (error) { settle(error); }
          return;
        }
        if (message.error) { settle(Error(message.error.message)); return; }
        client.stdin.write(JSON.stringify({ id: 3, method: 'model/list', params: { includeHidden: true } }) + '\n');
      } else if (message.id === 3) {
        if (message.error) { settle(Error(message.error.message)); return; }
        try {
          const ids = message.result.data.map(model => model.model);
          for (const model of catalog.models) assert(ids.includes(model.slug), 'Native menu missing ' + model.slug);
          settle(null, { models: ids.length });
        } catch (error) { settle(error); }
      }
    });
  });
  client.stdin.write(JSON.stringify({ id: 1, method: 'initialize', params: {
    clientInfo: { name: 'native-catalog-validation', version: '1' }, capabilities: { experimentalApi: true },
  } }) + '\n');
  try { return await result; }
  finally {
    if (!client.stdin.destroyed) client.stdin.end();
    if (client.exitCode === null) await new Promise(resolve => {
      const timer = setTimeout(() => { client.kill(); resolve(); }, 3000);
      client.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    lines.close();
  }
}

const merged = JSON.parse(fs.readFileSync(path.join(root, 'data/cache/models-smr.json')));
const broken = structuredClone(merged);
const modernAlias = broken.models.find(model => model.slug.startsWith('GPT/') && model.model_messages?.instructions_template);
assert(modernAlias, 'The live catalog has no modern GPT alias to validate.');
delete modernAlias.base_instructions;
modernAlias.model_messages = null;
checks.push({ name: 'Previous missing-instructions failure reproduced by the native parser',
  ...await parseMenu(broken, /is missing both `base_instructions` and `model_messages.instructions_template`/) });
for (const [name, menu] of [['mixed', merged], ['gateway', JSON.parse(fs.readFileSync(path.join(root, 'data/cache/models-gateway.json')))]]) {
  checks.push({ name: 'Corrected ' + name + ' catalog accepted by the native parser and model/list', ...await parseMenu(menu) });
}
const multipleSources = structuredClone(merged);
for (const model of JSON.parse(fs.readFileSync(path.join(root, 'data/cache/models-gateway.json'))).models) {
  multipleSources.models.push({ ...structuredClone(model), slug: '@p_catalog01/' + model.slug, display_name: model.display_name + ' · Catalog fixture' });
}
checks.push({ name: 'Stable source-qualified model IDs coexist with the original models in the native menu', ...await parseMenu(multipleSources) });
const messagesOnly = structuredClone(merged);
for (const model of messagesOnly.models) if (model.model_messages?.instructions_template) delete model.base_instructions;
checks.push({ name: 'Native instructions-only schema works for official entries and GPT aliases without adding base instructions',
  ...await parseMenu(messagesOnly) });
const report = { passed: true, cli, checks };
fs.mkdirSync(path.join(root, 'data/diagnostics'), { recursive: true });
fs.writeFileSync(path.join(root, 'data/diagnostics/native-catalog-result.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
