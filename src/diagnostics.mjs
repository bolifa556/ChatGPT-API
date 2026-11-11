// Failure-only diagnostics. No background timers, directory scans or payload logs.
import fs from 'node:fs';
import path from 'node:path';

export const LOG_LIMIT = 256 * 1024;
const ENTRY_LIMIT = 8192;
const managedLogs = ['shim.log', 'shim.log.1', 'shim-stdout.log', 'shim-stderr.log', 'provider-start.log',
  'native-session-stderr.log', 'prepare-stderr.log', 'provider-repair-stderr.log', 'ssh-stderr.log', 'recovery.log', 'console-stderr.log', 'launcher-error.log'];
const safeText = value => String(value ?? '').replace(/(Bearer\s+)[^\s"']+/gi, '$1[redacted]')
  .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@')
  .replace(/((?:"|')?(?:api[_-]?key|access_token|refresh_token|id_token)(?:"|')?\s*[:=]\s*["'])([^"']+)(["'])/gi, '$1[redacted]$3')
  .replace(/([?&](?:api[_-]?key|token|access_token|key)=)[^\s&#"']+/gi, '$1[redacted]');
let cleanedRoot;

export function errorDetails(error, sanitize = value => value, depth = 0, seen = new Set()) {
  if (depth > 3 || seen.has(error)) return undefined;
  seen.add(error);
  const result = { code: String(error?.code || error?.name || 'Error').slice(0, 120),
    message: safeText(sanitize(String(error?.message || error))).slice(0, 1600) };
  if (error?.method) result.method = String(error.method).slice(0, 100);
  if (Number.isInteger(error?.status)) result.status = error.status;
  if (error?.cause) result.cause = errorDetails(error.cause, sanitize, depth + 1, seen);
  if (Array.isArray(error?.errors)) result.errors = error.errors.slice(0, 4).map(value => errorDetails(value, sanitize, depth + 1, seen)).filter(Boolean);
  return result;
}
export function describeError(error) {
  const parts = [], seen = new Set();
  for (let current = error; current && !seen.has(current) && parts.length < 4; current = current.cause) {
    seen.add(current);
    const text = safeText(current.message || current).slice(0, 1600);
    const previous = parts.find(part => part.text === text);
    if (previous) previous.code ||= current.code;
    else parts.push({ text, code: current.code });
  }
  return parts.map(part => (part.code ? '[' + part.code + '] ' : '') + part.text).join(' → ');
}
export function cleanManagedLogs(root) {
  if (cleanedRoot === root) return;
  cleanedRoot = root;
  const directory = path.join(root, 'data/logs'), cutoff = Date.now() - 7 * 86400000;
  for (const name of managedLogs) {
    const file = path.join(directory, name);
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      if (name.endsWith('.1') || stat.mtimeMs < cutoff) { fs.unlinkSync(file); continue; }
      if (stat.size <= LOG_LIMIT) continue;
      const fd = fs.openSync(file, 'r+');
      try {
        const tail = Buffer.alloc(64 * 1024), bytes = fs.readSync(fd, tail, 0, tail.length, stat.size - tail.length);
        const firstLine = tail.indexOf(10), kept = tail.subarray(firstLine < 0 ? bytes : firstLine + 1, bytes);
        fs.writeSync(fd, kept, 0, kept.length, 0); fs.ftruncateSync(fd, kept.length);
      } finally { fs.closeSync(fd); }
    } catch {} // Log cleanup must never block launch or configuration recovery.
  }
}
export function createDiagnosticLog(file, { sanitize = value => value, limit = LOG_LIMIT } = {}) {
  let size, previous, writtenAt = 0;
  return text => {
    try {
      const message = Buffer.from(safeText(sanitize(String(text)))).subarray(0, Math.min(ENTRY_LIMIT, Math.max(0, limit - 64))).toString();
      const now = Date.now();
      if (message === previous && now - writtenAt < 30000) return;
      const line = Buffer.from('[' + new Date(now).toISOString() + '] ' + message + '\n');
      if (size === undefined) {
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        const stat = fs.existsSync(file) ? fs.lstatSync(file) : null;
        if (stat?.isSymbolicLink()) return;
        size = stat?.size || 0;
      }
      if (size + line.length > limit) { fs.writeFileSync(file, '', { mode: 0o600 }); size = 0; }
      fs.appendFileSync(file, line, { mode: 0o600 });
      size += line.length; previous = message; writtenAt = now;
    } catch {} // Diagnostics are best effort and never change request behavior.
  };
}
