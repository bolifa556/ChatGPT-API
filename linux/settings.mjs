import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import readline from 'node:readline';
import { Writable } from 'node:stream';

const run = promisify(execFile);
class Cancelled extends Error {}
async function command(program, args) {
  try { return (await run(program, args, { encoding: 'utf8', timeout: 600000, maxBuffer: 128 * 1024 })).stdout.trimEnd(); }
  catch (error) { if (error.code === 1 || error.code === 5) throw Object.assign(new Cancelled(), { code: error.code }); throw error; }
}
async function terminal(label, hidden = false) {
  const output = new Writable({ write(chunk, encoding, done) { if (!hidden) process.stderr.write(chunk); done(); } });
  output.isTTY = true; output.columns = process.stderr.columns || 80;
  const reader = readline.createInterface({ input: process.stdin, output, terminal: true });
  if (hidden) process.stderr.write(label);
  try { return await new Promise((resolve, reject) => { reader.once('SIGINT', () => reject(new Cancelled())); reader.question(hidden ? '' : label, resolve); }); }
  finally { reader.close(); if (hidden) process.stderr.write('\n'); }
}
export async function requestSettings(current, options = {}) {
  const execute = options.execute || command;
  const graphical = options.graphical ?? Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
  try {
    if (options.installation) {
      if (graphical) {
        try {
          const result = await execute('zenity', ['--forms', '--title=ChatGPT API 安装', '--width=480',
            '--text=API 设置\n可以现在填写，也可稍后通过控制台配置。', '--add-entry=API 地址（已有地址可留空）',
            '--add-password=API Key（已有密钥可留空）', '--separator=\n', '--ok-label=保存并安装', '--cancel-label=取消', '--extra-button=跳过，稍后配置']);
          if (result === '跳过，稍后配置') return { skip: true };
          const [base, ...secret] = result.split('\n');
          return { base: base.trim() || current.BASE_URL || '', key: secret.join('\n').trim() || current.API_KEY || '' };
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        try {
          try { await execute('kdialog', ['--title', 'ChatGPT API 安装', '--yesnocancel', '现在配置 API？也可以安装后通过控制台添加。', '--yes-label', '现在配置', '--no-label', '跳过，稍后配置', '--cancel-label', '取消']); }
          catch (error) { if (error.code === 1) return { skip: true }; if (error.code === 2) return null; throw error; }
          const base = await execute('kdialog', ['--title', 'API 地址', '--inputbox', 'API 地址', current.BASE_URL || '']);
          const key = await execute('kdialog', ['--title', 'API Key', '--password', '已有密钥留空保留。']);
          return { base, key: key || current.API_KEY || '' };
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      if (!(options.tty ?? process.stdin.isTTY)) return { skip: true };
      const ask = options.prompt || terminal;
      process.stderr.write('\n  ChatGPT API 安装\n  1  配置 API\n  2  跳过，稍后配置\n\n');
      const choice = (await ask('选择 [2]: ')).trim();
      if (choice !== '1') return { skip: true };
      const base = (await ask('API 地址: ')).trim() || current.BASE_URL || '';
      const key = (await ask('API Key（输入隐藏）: ', true)).trim() || current.API_KEY || '';
      return { base, key };
    }
    if (graphical) {
      try {
        const base = await execute('zenity', ['--entry', '--title=ChatGPT API', '--text=自定义 API 不可用。请输入 URL；取消保留原配置。', '--entry-text=' + (current.BASE_URL || '')]);
        const key = await execute('zenity', ['--password', '--title=ChatGPT API', '--text=请输入 API Key；留空保留原密钥。']);
        return { base, key: key || current.API_KEY || '' };
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      try {
        const base = await execute('kdialog', ['--title', 'ChatGPT API', '--inputbox', '自定义 API 不可用。请输入 URL；取消保留原配置。', current.BASE_URL || '']);
        const key = await execute('kdialog', ['--title', 'ChatGPT API', '--password', '请输入 API Key；留空保留原密钥。']);
        return { base, key: key || current.API_KEY || '' };
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (options.tty ?? process.stdin.isTTY) {
      const ask = options.prompt || terminal;
      const base = (await ask('API unavailable; Ctrl+C keeps settings. API URL [' + (current.BASE_URL || '') + ']: ')).trim() || current.BASE_URL;
      const key = (await ask('API Key [Enter keeps existing]: ', true)).trim() || current.API_KEY;
      return { base, key };
    }
    return null;
  } catch (error) { if (error instanceof Cancelled) return null; throw error; }
}
export async function showError(message) {
  if (!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY)) return;
  for (const [program, args] of [['zenity', ['--error', '--title=ChatGPT API', '--width=460', '--text=' + message]], ['kdialog', ['--title', 'ChatGPT API', '--error', message]]]) {
    try { await command(program, args); return; } catch (error) { if (error.code !== 'ENOENT') return; }
  }
}
