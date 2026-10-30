import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { initializeDeferredSettings, requireApiConfiguration, readEnvFile, saveSettings, publicSettings, readSettings } from '../src/settings.mjs';
import { configure as configureLinux } from '../linux/provider.mjs';
import { configure as configureMac, launchEntry } from '../macos/provider.mjs';
import { requestSettings } from '../linux/settings.mjs';
import { requestInstallationSettings, configureProvider, Cancelled } from '../macos/dmg/gui.mjs';

const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'chatgpt-deferred-install-'));
const ctx = { root, data: path.join(root, 'data'), home: path.join(root, 'native'), config: path.join(root, 'native/config.toml') };
const checks = [];
try {
  fs.mkdirSync(ctx.home);
  fs.writeFileSync(ctx.config, '[app]\nlocaleOverride = "zh-CN"\n');
  const auth = path.join(ctx.home, 'auth.json');
  fs.writeFileSync(auth, '{"original":"native-credentials"}');
  const originalConfig = fs.readFileSync(ctx.config), originalAuth = fs.readFileSync(auth);
  for (const configure of [configureLinux, configureMac]) {
    assert.deepEqual(await configure(ctx, false, false, { skipApi: true }), { models: 0, deferred: true });
    const env = readEnvFile(path.join(ctx.data, '.env'));
    assert.equal(env.BASE_URL, ''); assert.equal(env.API_KEY, '');
    assert(!fs.existsSync(path.join(ctx.data, 'state/router.json')));
    assert(!fs.existsSync(path.join(ctx.data, 'cache')));
  }
  assert.deepEqual(fs.readFileSync(ctx.config), originalConfig);
  assert.deepEqual(fs.readFileSync(auth), originalAuth);
  assert.throws(() => requireApiConfiguration(root), error => error.code === 'api_not_configured' && error.message.includes('控制台'));
  if (process.platform !== 'win32') {
    for (const entry of ['api', 'apionly']) await assert.rejects(launchEntry(ctx, entry), error => error.code === 'api_not_configured');
  }
  checks.push('Deferred Linux/macOS installation creates no fake credential, model request, provider binding or native login/history change');

  const current = { BASE_URL: 'https://kept.invalid/v1', API_KEY: 'private-existing-key' };
  const calls = [];
  assert.deepEqual(await requestInstallationSettings(current, async input => { calls.push(input); return { skip: true }; }), { skip: true });
  assert(!JSON.stringify(calls).includes(current.API_KEY));
  const saved = await requestInstallationSettings(current, async () => ({ base: 'https://new.invalid/v1', key: '' }));
  assert.equal(saved.key, current.API_KEY);
  await assert.rejects(requestInstallationSettings(current, async () => { throw new Cancelled(); }), Cancelled);
  let skipArgs;
  await configureProvider(ctx, { configure: async (...args) => { skipArgs = args; } }, { skip: true });
  assert.deepEqual(skipArgs.slice(1), [false, false, { skipApi: true }]);
  checks.push('macOS combined dialog keeps saved keys out of argv, preserves blank keys and handles skip/cancel independently');

  const gtkArgs = [];
  assert.deepEqual(await requestSettings(current, { installation: true, graphical: true, execute: async (program, args) => { gtkArgs.push(args); return '跳过，稍后配置'; } }), { skip: true });
  const gtkSaved = await requestSettings(current, { installation: true, graphical: true, execute: async () => '\n' });
  assert.deepEqual(gtkSaved, { base: current.BASE_URL, key: current.API_KEY });
  assert(!JSON.stringify(gtkArgs).includes(current.API_KEY));
  assert.deepEqual(await requestSettings(current, { installation: true, graphical: false, tty: false }), { skip: true });
  assert.deepEqual(await requestSettings(current, { installation: true, graphical: false, tty: true, prompt: async () => '2' }), { skip: true });
  checks.push('Linux GTK and terminal installation offer deferred setup; GUI arguments never contain saved keys');

  const envFile = path.join(ctx.data, '.env');
  fs.writeFileSync(envFile, 'BASE_URL=https://kept.invalid/v1\nAPI_KEY=private-existing-key\nCUSTOM=keep\n');
  const before = fs.readFileSync(envFile);
  initializeDeferredSettings(root);
  await configureLinux(ctx, false, false, { skipApi: true });
  await configureMac(ctx, false, false, { skipApi: true });
  assert.deepEqual(fs.readFileSync(envFile), before);
  saveSettings(root, { ...publicSettings(readSettings(root)), contextLimit: 400000 });
  const providers = fs.readFileSync(path.join(ctx.data, 'providers.json'));
  initializeDeferredSettings(root);
  assert.deepEqual(fs.readFileSync(path.join(ctx.data, 'providers.json')), providers);
  assert.equal(requireApiConfiguration(root).providers[0].apiKey, current.API_KEY);
  checks.push('Skipping an update preserves exact existing URL/key/provider settings; later console configuration enables API use');
  console.log(JSON.stringify({ passed: true, checks }, null, 2));
} finally { fs.rmSync(root, { recursive: true, force: true }); }
