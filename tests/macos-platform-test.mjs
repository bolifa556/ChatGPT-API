// Platform logic and installer validation; no macOS binaries or real homes run.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { parseProcessIdentity, sameProcess, parseClientProcesses, clientExecutable, launcherText } from '../macos/platform.mjs';
import { context, atomic, applyConfig, restoreConfig, settingsChecked } from '../macos/provider.mjs';
import { canonicalPath, verifyRelease } from '../macos/install.mjs';

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-macos-platform-test-'));
const savedHome = process.env.CODEX_HOME, savedClient = process.env.CHATGPT_API_CLIENT;
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
  const baseline = 'model = "official-example"\nmodel_reasoning_effort = "low"\n[app]\nlocaleOverride = "zh-CN"\n[model_providers.keep]\nname = "Keep"\n';
  atomic(ctx.config, baseline); atomic(path.join(ctx.home, 'auth.json'), '{"tokens":{"access_token":"inert-native-token"}}\n');
  const authHash = () => crypto.createHash('sha256').update(fs.readFileSync(path.join(ctx.home, 'auth.json'))).digest('hex');
  const authBefore = authHash();
  atomic(path.join(ctx.data, '.env'), 'BASE_URL=https://example.invalid/v1\nAPI_KEY=' + key + '\n');
  atomic(path.join(ctx.data, 'cache/models-gateway.json'), { models: [{ slug: 'Vendor/model' }, { slug: 'GPT/model' }] });
  applyConfig(ctx); const config = fs.readFileSync(ctx.config, 'utf8');
  assert(config.includes('requires_openai_auth = false')); assert(config.includes(JSON.stringify(path.join(ctx.root, 'macos/provider.mjs'))));
  assert(config.includes('model = "Vendor/model"')); assert(!config.includes('openai_base_url'));
  assert(config.includes('localeOverride = "zh-CN"')); assert(config.includes('[model_providers.keep]'));
  assert(!config.includes(key)); assert.equal(authHash(), authBefore);
  atomic(ctx.config, config.replace('zh-CN', 'en-US'));
  restoreConfig(ctx); assert.equal(fs.readFileSync(ctx.config, 'utf8').trimEnd(), baseline.replace('zh-CN', 'en-US').trimEnd());
  assert.equal(authHash(), authBefore);
  assert.equal(settingsChecked({ BASE_URL: 'http://example.invalid/', API_KEY: key }).BASE_URL, 'http://example.invalid/v1');

  const app = path.join(fixture, "custom ' space.app"), executable = path.join(app, 'Contents/MacOS/ActualMain');
  atomic(executable, '#!/bin/sh\n', 0o755); fs.chmodSync(executable, 0o755);
  process.env.CHATGPT_API_CLIENT = app;
  assert.equal(clientExecutable(file => { assert.equal(file, path.join(app, 'Contents/Info.plist')); return 'ActualMain'; }), executable);
  assert.throws(() => clientExecutable(() => '../outside'), /was not found/);
  const launch = launcherText({ ...ctx, root: "/tmp/a ' $var [x]", node: "/tmp/a ' $var [x]/runtime/node" });
  assert(launch.includes("'\\''")); assert(launch.includes('CODEX_HOME=' + ctx.home)); assert(!launch.includes(key));
  assert(launch.endsWith(' "$@"\n')); assert(!launch.includes('\r'));

  const release = path.join(fixture, 'release'), destination = path.join(fixture, 'target');
  const required = ['runtime/node','macos/provider.mjs','macos/platform.mjs','macos/chatgpt-apionly','macos/install.mjs','src/shim.mjs','assets/model-template.json','package-lock.json'];
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
  console.log(JSON.stringify({ passed: true, checks: ['macOS process parsing and PID/UID reuse protection', 'gateway-only config and preserved credentials/preferences', 'bundle executable discovery and quoted desktop entry', 'manifest integrity, architecture, duplicate paths and traversal rejection before writes'], scope: 'Cross-platform logic checks; not a native macOS execution test.' }, null, 2));
} finally {
  if (savedHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = savedHome;
  if (savedClient === undefined) delete process.env.CHATGPT_API_CLIENT; else process.env.CHATGPT_API_CLIENT = savedClient;
  assert(fixture.startsWith(path.join(os.tmpdir(), 'chatgpt-macos-platform-test-')));
  fs.rmSync(fixture, { recursive: true, force: true });
}
