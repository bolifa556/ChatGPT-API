import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { requestSettings, configureProvider, prepareInstallation, Cancelled, entryArguments, dialogScript } from '../macos/dmg/gui.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'chatgpt-dmg-gui-test-'));
const oldHome = process.env.CODEX_HOME;
try {
  for (const entryMode of ['official', 'api', 'apionly', 'console']) assert.deepEqual(entryArguments(['--entry', entryMode, '--configure']), { entryMode, args: ['--configure'] });
  assert.throws(() => entryArguments(['--entry', 'other']), /Unknown/);
  assert.throws(() => entryArguments(['--entry', 'api', '--entry', 'official']), /Unknown/);
  const menus = [], dialogs = []; let clipboardReads = 0;
  const pasteValue = 'inert-pasted-key=$literal';
  const cocoa = {
    NSApplication: { sharedApplication: { setActivationPolicy() {}, activateIgnoringOtherApps() {} } },
    NSApplicationActivationPolicyAccessory: 1, NSEventModifierFlagCommand: 1 << 20, NSPasteboardTypeString: 'text',
    NSMenu: { get alloc() { return { initWithTitle: title => ({ title, addItem() {} }) }; } },
    NSMenuItem: { get alloc() { return { get init() { return {}; }, initWithTitleActionKeyEquivalent(title, action, key) { const item = { title, action, key }; menus.push(item); return item; } }; } },
    NSPasteboard: { generalPasteboard: { stringForType() { clipboardReads++; return pasteValue; } } },
  };
  const scope = { $, ObjC: { import() {}, unwrap: value => value }, Application: { currentApplication: () => ({
    displayDialog(message, options) { dialogs.push(options); return dialogs.length === 1 ? { buttonReturned: '粘贴', textReturned: '' } : { buttonReturned: '确定', textReturned: options.defaultAnswer }; },
  }) } };
  function $(value) { return value; }
  Object.assign(scope.$, cocoa);
  vm.createContext(scope); vm.runInContext(dialogScript, scope);
  assert.equal(clipboardReads, 0);
  assert.equal(JSON.parse(scope.run([JSON.stringify({ kind: 'prompt', hidden: true })])).value, pasteValue);
  assert.equal(clipboardReads, 1); assert.equal(dialogs[0].hiddenAnswer, true); assert.equal(dialogs[1].defaultAnswer, pasteValue);
  assert(menus.some(item => item.action === 'paste:' && item.key === 'v' && item.keyEquivalentModifierMask === 1 << 20));
  const current = { BASE_URL: 'https://example.invalid/v1', API_KEY: 'inert-old-key=$literal' };
  const asked = [];
  const result = await requestSettings(current, async input => { asked.push(input); return asked.length === 1 ? 'http://gateway.invalid/v1' : ''; });
  assert.equal(result.key, current.API_KEY);
  assert(!JSON.stringify(asked).includes(current.API_KEY), 'Saved key entered UI process arguments');
  assert.equal(asked[1].hidden, true); assert.equal(asked[1].value, undefined);
  await assert.rejects(requestSettings(current, async () => { throw new Cancelled(); }), Cancelled);
  const envBefore = { base: process.env.CHATGPT_API_BASE_URL, key: process.env.CHATGPT_API_KEY };
  await configureProvider({}, { configure: async () => {
    assert.equal(process.env.CHATGPT_API_BASE_URL, result.base);
    assert.equal(process.env.CHATGPT_API_KEY, current.API_KEY);
  } }, result);
  assert.equal(process.env.CHATGPT_API_BASE_URL, envBefore.base); assert.equal(process.env.CHATGPT_API_KEY, envBefore.key);
  await assert.rejects(configureProvider({}, { configure: async () => { throw new Error('fixture failure'); } }, result), /fixture failure/);
  assert.equal(process.env.CHATGPT_API_KEY, envBefore.key);

  const release = path.join(fixture, 'release'), destination = path.join(fixture, 'installed');
  process.env.CODEX_HOME = path.join(fixture, 'native');
  fs.mkdirSync(process.env.CODEX_HOME);
  const auth = path.join(process.env.CODEX_HOME, 'auth.json');
  fs.writeFileSync(auth, '{"inert_native_login":"must-stay-unchanged"}');
  const originalAuth = fs.readFileSync(auth, 'utf8');
  const sources = ['macos/provider.mjs','macos/platform.mjs','macos/native.mjs','macos/install.mjs','macos/chatgpt-apionly','src/shim.mjs','src/transport.mjs','src/response-state.mjs','src/settings.mjs','src/gateway-sources.mjs','src/console.mjs','assets/console/index.html','assets/console/console.css','assets/console/console.js','assets/console/icon.svg','src/repair-thread-providers.mjs','src/model-context.mjs','src/gateway-recovery.mjs','assets/model-template.json','assets/model-contexts.json','package-lock.json'];
  const entries = [];
  for (const relative of [...sources, 'runtime/node']) {
    const bytes = relative === 'runtime/node' ? Buffer.from('fixture runtime\n') : fs.readFileSync(path.join(root, relative));
    const file = path.join(release, 'payload', relative);
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes);
    entries.push({ path: relative, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), mode: relative === 'runtime/node' ? 0o755 : 0o644 });
  }
  const manifestFile = path.join(release, 'release.json');
  const manifest = { schemaVersion: 1, product: 'chatgpt-apionly-provider', version: JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).version, platform: 'darwin-arm64', files: entries };
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  const settingsFile = path.join(destination, 'data/.env');
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true }); fs.writeFileSync(settingsFile, 'API_KEY=inert-existing-key\n');
  fs.writeFileSync(path.join(destination, 'my-notes.txt'), 'keep');
  const writes = [], originalWrite = fs.writeFileSync;
  let installed;
  fs.writeFileSync = (file, ...args) => { writes.push(String(file)); return originalWrite(file, ...args); };
  try { installed = await prepareInstallation(release, destination); }
  finally { fs.writeFileSync = originalWrite; }
  assert.equal(installed.updated, true);
  assert.equal(fs.readFileSync(settingsFile, 'utf8'), 'API_KEY=inert-existing-key\n');
  assert.equal(fs.readFileSync(path.join(destination, 'my-notes.txt'), 'utf8'), 'keep');
  assert.equal(fs.readFileSync(auth, 'utf8'), originalAuth);
  const consoleEntry = path.join(destination, '控制台.command');
  assert(fs.readFileSync(consoleEntry, 'utf8').includes(path.join('src', 'console.mjs')), 'Installation lacks a local console entry');
  assert(!writes.some(file => /\.command(?:\.|$)/i.test(file) && !file.startsWith(consoleEntry)), 'GUI installation created an unexpected command entry');
  const sourceFile = path.join(destination, 'src/shim.mjs');
  const oldMtime = fs.statSync(sourceFile).mtimeMs;
  assert.equal((await prepareInstallation(release, destination)).updated, false);
  assert.equal(fs.statSync(sourceFile).mtimeMs, oldMtime);
  const initialHash = crypto.createHash('sha256').update(fs.readFileSync(sourceFile)).digest('hex');
  manifest.files.find(entry => entry.path === 'src/shim.mjs').sha256 = '0'.repeat(64);
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  await assert.rejects(prepareInstallation(release, destination), /checksum failed/);
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(sourceFile)).digest('hex'), initialHash);
  assert.equal(fs.readFileSync(settingsFile, 'utf8'), 'API_KEY=inert-existing-key\n');
  await assert.rejects(prepareInstallation(release, path.join(release, 'inside')), /separate program directory/);
  console.log(JSON.stringify({ passed: true, checks: ['chat and console entry argument routing', 'paste menu and user-triggered clipboard flow with a Cocoa mock', 'password never included in dialog arguments', 'cancel and environment restoration', 'program install and console entry with preserved credentials/data', 'repeat launch avoids program rewrites', 'damaged update rejected before replacing files'], scope: 'Isolated controller and simulated Cocoa tests; no macOS dialogs, Gatekeeper or native GUI executed.' }, null, 2));
} finally {
  if (oldHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldHome;
  assert(fixture.startsWith(path.join(fs.realpathSync(os.tmpdir()), 'chatgpt-dmg-gui-test-')));
  fs.rmSync(fixture, { recursive: true, force: true });
}
