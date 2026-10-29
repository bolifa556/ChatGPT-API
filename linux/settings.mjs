import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import readline from 'node:readline';
import { Writable } from 'node:stream';

const run = promisify(execFile);
class Cancelled extends Error {}
async function command(program, args) {
  try { return (await run(program, args, { encoding: 'utf8', timeout: 600000, maxBuffer: 128 * 1024 })).stdout.trimEnd(); }
  catch (error) { if (error.code === 1 || error.code === 5) throw new Cancelled(); throw error; }
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
