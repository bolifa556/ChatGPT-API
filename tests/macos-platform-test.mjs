// Platform logic and installer validation; no macOS binaries or real homes run.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { parseProcessIdentity, sameProcess, parseClientProcesses, clientExecutable, nativeCli, launcherText, parseSystemProxy, officialProxy, clientLaunchCommand } from '../macos/platform.mjs';
import { context, atomic, applyConfig, restoreConfig, settingsChecked } from '../macos/provider.mjs';
import { canonicalPath, verifyRelease } from '../macos/install.mjs';

const fixture = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'chatgpt-macos-platform-test-'));
const savedHome = process.env.CODEX_HOME, savedClient = process.env.CHATGPT_API_CLIENT, savedCli = process.env.CHATGPT_API_CLI;
try {
  const identity = parseProcessIdentity('Wed Oct 14 12:34:56 2026  501 Ss /a b/runtime/node /a b/src/shim.mjs\n', 123);
  assert.equal(identity.start, 'Wed Oct 14 12:34:56 2026');
  assert.equal(identity.uid, 501); assert.equal(identity.pid, 123);
  assert(sameProcess(identity, { ...identity }));
  assert(!sameProcess(identity, { ...identity, start: 'Wed Oct 14 12:34:57 2026' }));
  assert(!sameProcess(identity, { ...identity, uid: 502 }));
  assert.equal(parseProcessIdentity('Wed Oct 14 12:34:56 2026 501 Z <defunct>', 123), null);
  assert.equal(parseProcessIdentity('bad output', 123), null);
  assert.deepEqual(parseClientProcesses([
    '501 10 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT',
    '501 11 /Users/a/Applications/Codex.app/Contents/MacOS/Codex',
    '501 12 /Applications/ChatGPT.app/Contents/Frameworks/ChatGPT Helper.app/Contents/MacOS/ChatGPT Helper',
    '502 13 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT',
    '501 14 /usr/local/bin/node',
  ].join('\n'), 501), [10, 11]);

  process.env.CODEX_HOME = path.join(fixture, 'native');
  const ctx = context(path.join(fixture, 'installed'));
  const key = 'inert-macos-key=$literal';
  const baseline = 'model = "official-example"\nmodel_reasoning_effort = "low"\nmodel_context_window = 500000\nmodel_auto_compact_token_limit = 400000\n[app]\nlocaleOverride = "zh-CN"\n[model_providers.keep]\nname = "Keep"\n';
  atomic(ctx.config, baseline); atomic(path.join(ctx.home, 'auth.json'), '{"tokens":{"access_token":"inert-native-token"}}\n');
  const authHash = () => crypto.createHash('sha256').update(fs.readFileSync(path.join(ctx.home, 'auth.json'))).digest('hex');
  const authBefore = authHash();
  atomic(path.join(ctx.data, '.env'), 'BASE_URL=https://example.invalid/v1\nAPI_KEY=' + key + '\n');
  atomic(path.join(ctx.data, 'cache/models-gateway.json'), { models: [{ slug: 'Vendor/model' }, { slug: 'GPT/model' }] });
  applyConfig(ctx); const config = fs.readFileSync(ctx.config, 'utf8');
  assert(config.includes('requires_openai_auth = false')); assert(config.includes(JSON.stringify(path.join(ctx.root, 'macos/provider.mjs'))));
  assert(config.includes('model = "Vendor/model"')); assert(config.includes('openai_base_url = "http://127.0.0.1:8102/v1"'));
  assert(config.includes('localeOverride = "zh-CN"')); assert(config.includes('[model_providers.keep]'));
  assert(!config.includes(key)); assert.equal(authHash(), authBefore);
  assert(!/^model_context_window\s*=/m.test(config)); assert(!/^model_auto_compact_token_limit\s*=/m.test(config));
  atomic(ctx.config, config.replace('zh-CN', 'en-US'));
  restoreConfig(ctx); assert.equal(fs.readFileSync(ctx.config, 'utf8').trimEnd(), baseline.replace('zh-CN', 'en-US').trimEnd());
  assert.equal(authHash(), authBefore);
  assert.equal(settingsChecked({ BASE_URL: 'http://example.invalid/', API_KEY: key }).BASE_URL, 'http://example.invalid/v1');
  assert.equal(parseSystemProxy('<dictionary> {\n HTTPSEnable : 1\n HTTPSProxy : 127.0.0.1\n HTTPSPort : 7890\n}'), 'http://127.0.0.1:7890');
  assert.equal(parseSystemProxy('HTTPEnable : 0\nHTTPProxy : localhost\nHTTPPort : 7890'), '');
  assert.equal(parseSystemProxy('HTTPEnable : 1\nHTTPProxy : localhost\nHTTPPort : 99999'), '');
  assert.equal(officialProxy({}, { HTTPS_PROXY: 'http://127.0.0.1:1234' }), 'http://127.0.0.1:1234/');

  const app = path.join(fixture, "custom ' space.app"), executable = path.join(app, 'Contents/MacOS/ActualMain');
  atomic(executable, '#!/bin/sh\n', 0o755); fs.chmodSync(executable, 0o755);
  process.env.CHATGPT_API_CLIENT = app;
  assert.equal(clientExecutable(file => { assert.equal(file, path.join(app, 'Contents/Info.plist')); return 'ActualMain'; }), executable);
  assert.throws(() => clientExecutable(() => '../outside'), /was not found/);

  const nativeApp = "/Applications/ChatGPT space ' 中文.app", nativeHome = "/Users/test/工作 ' $literal/.codex";
  const nativeArgs = ['--literal', 'a b', '$(untouched)'];
  const request = clientLaunchCommand(nativeApp + '/Contents/MacOS/ChatGPT', nativeArgs, nativeHome, { platform: 'darwin' });
  assert.deepEqual(request, { command: '/usr/bin/open', args: ['-W', '-a', nativeApp, '--env', 'CODEX_HOME=' + nativeHome, '--args', ...nativeArgs] });
  const reuse = clientLaunchCommand(nativeApp + '/Contents/MacOS/ChatGPT', [], nativeHome, { platform: 'darwin', wait: false });
  assert.deepEqual(reuse.args, ['-a', nativeApp, '--env', 'CODEX_HOME=' + nativeHome]);
  assert(!request.args.includes('-n')); assert(!request.args.includes('-F'));
  assert.throws(() => clientLaunchCommand('/tmp/standalone-client', [], nativeHome, { platform: 'darwin' }), /official .app/);
  assert.deepEqual(clientLaunchCommand('/tmp/fixture', nativeArgs, nativeHome, { platform: 'linux' }), { command: '/tmp/fixture', args: nativeArgs });

  delete process.env.CHATGPT_API_CLI;
  assert.equal(nativeCli(executable.replaceAll(path.sep, '/')), null);
  for (const [index, relative] of [
    'Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
    'Contents/Resources/codex',
    'Contents/Resources/codex-cli',
  ].entries()) {
    const bundle = path.join(fixture, "CLI layout ' space " + index + '.app');
    const client = path.join(bundle, 'Contents/MacOS/ChatGPT').replaceAll(path.sep, '/');
    const cli = path.join(bundle, relative);
    atomic(cli, '#!/bin/sh\n', 0o755); fs.chmodSync(cli, 0o755);
    if (index === 0) atomic(path.join(bundle, 'Contents/Resources/codex'), '#!/bin/sh\n', 0o755);
    assert.equal(nativeCli(client), cli);
    process.env.CHATGPT_API_CLI = executable;
    assert.equal(nativeCli(client), executable);
    process.env.CHATGPT_API_CLI = bundle;
    assert.equal(nativeCli(client), null);
    delete process.env.CHATGPT_API_CLI;
  }
  const launch = launcherText({ ...ctx, root: "/tmp/a ' $var [x]", node: "/tmp/a ' $var [x]/runtime/node" });
  assert(launch.includes("'\\''")); assert(launch.includes('CODEX_HOME=' + ctx.home)); assert(!launch.includes(key));
  assert(launch.endsWith(' "$@"\n')); assert(!launch.includes('\r'));

  const release = path.join(fixture, 'release'), destination = path.join(fixture, 'target');
  const required = ['runtime/node','macos/provider.mjs','macos/platform.mjs','macos/native.mjs','macos/chatgpt-apionly','macos/install.mjs','src/shim.mjs','src/transport.mjs','src/response-state.mjs','src/settings.mjs','src/gateway-sources.mjs','src/console.mjs','assets/console/index.html','assets/console/console.css','assets/console/console.js','assets/console/icon.svg','src/repair-thread-providers.mjs','src/model-context.mjs','src/gateway-recovery.mjs','assets/model-template.json','assets/model-contexts.json','package-lock.json'];
  const files = required.map(relative => {
    atomic(path.join(release, 'payload', relative), 'fixture\n');
    return { path: relative, bytes: 8, sha256: crypto.createHash('sha256').update('fixture\n').digest('hex'), mode: 0o644 };
  });
  const manifest = { schemaVersion: 1, product: 'chatgpt-apionly-provider', platform: 'darwin-arm64', files };
  const setManifest = value => atomic(path.join(release, 'release.json'), value);
  setManifest(manifest); assert.equal(verifyRelease(release, destination, 'arm64').copies.length, required.length);
  assert.throws(() => verifyRelease(release, destination, 'x64'), /architecture/);
  assert(!fs.existsSync(destination));
  setManifest({ ...manifest, files: [{ ...files[0], path: '../outside' }, ...files.slice(1)] });
  assert.throws(() => verifyRelease(release, destination, 'arm64'), /Invalid program path/);
  setManifest({ ...manifest, files: [{ ...files[0], sha256: '0'.repeat(64) }, ...files.slice(1)] });
  assert.throws(() => verifyRelease(release, destination, 'arm64'), /checksum failed/);
  setManifest({ ...manifest, files: [...files, files[0]] });
  assert.throws(() => verifyRelease(release, destination, 'arm64'), /Duplicate/);
  assert(!fs.existsSync(destination));
  assert.equal(canonicalPath(path.join(fixture, 'new/nested')), path.join(fs.realpathSync(fixture), 'new/nested'));
  console.log(JSON.stringify({ passed: true, checks: ['macOS process parsing and PID/UID reuse protection', 'gateway-only config and preserved credentials/preferences', 'bundle executable discovery and quoted desktop entry', 'LaunchServices command, explicit native home, unchanged arguments and application reuse', 'nested CodexCLI.app and both legacy CLI layouts, path priority and explicit overrides', 'manifest integrity, architecture, duplicate paths and traversal rejection before writes'], scope: 'Cross-platform logic checks; not a native macOS execution test.' }, null, 2));
} finally {
  if (savedHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = savedHome;
  if (savedClient === undefined) delete process.env.CHATGPT_API_CLIENT; else process.env.CHATGPT_API_CLIENT = savedClient;
  if (savedCli === undefined) delete process.env.CHATGPT_API_CLI; else process.env.CHATGPT_API_CLI = savedCli;
  assert(fixture.startsWith(path.join(fs.realpathSync(os.tmpdir()), 'chatgpt-macos-platform-test-')));
  fs.rmSync(fixture, { recursive: true, force: true });
}
