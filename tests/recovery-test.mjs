import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';

assert(['linux', 'darwin'].includes(process.platform));
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "chatgpt-recovery ' 空格-"));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  for (let n = 0; n < 200; n++) { if (check()) return; await delay(100); }
  throw new Error('Timed out waiting for internal recovery.');
}
const checks = [];
try {
  for (const platform of process.platform === 'darwin' ? ['macos'] : ['linux', 'macos']) {
    const root = path.join(temporary, platform), home = path.join(root, 'home');
    fs.mkdirSync(home, { recursive: true });
    for (const directory of ['src', platform, 'node_modules']) fs.cpSync(path.join(repo, directory), path.join(root, directory), { recursive: true });
    fs.mkdirSync(path.join(root, 'data/cache'), { recursive: true });
    for (const name of ['models-smr.json', 'models-gateway.json']) fs.writeFileSync(path.join(root, 'data/cache', name), '{"models":[{"slug":"Fixture/model"}]}');
    fs.writeFileSync(path.join(root, 'data/.env'), 'BASE_URL=http://fixture.invalid/v1\nAPI_KEY=inert\n');
    const ctx = { root, home, config: path.join(home, 'config.toml'), data: path.join(root, 'data'), node: process.execPath };
    const baseline = 'model="official"\ncli_auth_credentials_store="file"\n[app]\nlocaleOverride="zh-CN"\n';
    const auth = '{"auth_mode":"chatgpt","tokens":{"access_token":"inert-saved-account"}}';
    fs.writeFileSync(path.join(home, 'auth.json'), auth);
    const { registerRecovery, unregisterRecovery, recoverPending } = await import(pathToFileURL(path.join(root, 'src/recovery.mjs')));
    const provider = await import(pathToFileURL(path.join(root, platform, 'provider.mjs')));
    const state = path.join(root, 'data/state/recovery.json');
    const logins = path.join(root, 'automatic-login');
    for (const scenario of ['normal', 'crash', 'power-loss', 'new-boot']) {
      fs.writeFileSync(ctx.config, baseline);
      let owner, client;
      if (scenario === 'normal' || scenario === 'new-boot') {
        const session = await registerRecovery(ctx, platform, { loginDirectory: logins, watchNativeClients: false });
        provider.applyConfig(ctx);
        assert.equal(await recoverPending(ctx, platform), false);
        if (scenario === 'new-boot') {
          const previous = JSON.parse(fs.readFileSync(state));
          fs.writeFileSync(state, JSON.stringify({ ...previous, boot: 'previous-system-boot' }));
          await until(() => !fs.existsSync(state));
        } else { provider.restoreConfig(ctx); unregisterRecovery(ctx, session); }
      } else {
        const script = path.join(root, 'owner.mjs');
        fs.writeFileSync(script, `import fs from 'node:fs';import path from 'node:path';import{spawn}from'node:child_process';import{once}from'node:events';
import{registerRecovery,recordRecoveryClient}from'./src/recovery.mjs';import{applyConfig}from'./${platform}/provider.mjs';
const ctx=${JSON.stringify(ctx)};const session=await registerRecovery(ctx,'${platform}',{loginDirectory:${JSON.stringify(logins)},watchNativeClients:false});
applyConfig(ctx);const client=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});await once(client,'spawn');client.unref();await recordRecoveryClient(ctx,session,client.pid);
fs.writeFileSync(path.join(ctx.root,'prepared'),String(client.pid));setInterval(()=>{},1000);`);
        owner = spawn(process.execPath, [script], { stdio: ['ignore', 'ignore', 'pipe'] });
        let errors = ''; owner.stderr.on('data', chunk => { errors += chunk; });
        await until(() => { if (owner.exitCode !== null) throw new Error(errors); return fs.existsSync(path.join(root, 'prepared')); });
        client = Number(fs.readFileSync(path.join(root, 'prepared')));
        if (scenario === 'power-loss') {
          const watcher = JSON.parse(fs.readFileSync(path.join(root, 'data/state/recovery-watcher.json')));
          process.kill(watcher.owner.pid, 'SIGKILL');
        }
        owner.kill('SIGKILL'); await once(owner, 'exit');
        await delay(1700);
        assert(fs.existsSync(state), 'Recovery ran while the recorded native client was still open.');
        process.kill(client, 'SIGKILL');
        if (scenario === 'power-loss') {
          fs.writeFileSync(ctx.config, 'interrupted native write');
          fs.writeFileSync(ctx.config + '.chatgpt-api.tmp', 'interrupted temporary file');
          const login = spawn(process.execPath, [path.join(root, 'src/recovery.mjs'), platform, root, home], { stdio: 'ignore' });
          await once(login, 'exit'); assert.equal(login.exitCode, 0);
        }
        await until(() => !fs.existsSync(state));
        fs.unlinkSync(path.join(root, 'prepared'));
      }
      await until(() => !fs.existsSync(path.join(root, 'data/state/recovery-watcher.json')));
      assert.equal(fs.readFileSync(ctx.config, 'utf8'), baseline);
      assert.equal(fs.readFileSync(path.join(home, 'auth.json'), 'utf8'), auth);
      assert.deepEqual(fs.readdirSync(logins), []);
      assert.deepEqual(fs.readdirSync(home).sort(), ['auth.json', 'config.toml']);
      checks.push(platform + '/' + scenario);
    }
  }
  console.log(JSON.stringify({ passed: true, checks }));
} finally { fs.rmSync(temporary, { recursive: true, force: true }); }
