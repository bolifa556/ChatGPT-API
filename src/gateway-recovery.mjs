import { rootHead, tomlMask, getRoot } from './toml-edit.mjs';

export function gatewayUnavailable(error) {
  return error?.code === 'gateway_unavailable' || /\[gateway_unavailable\]|Enter a valid http:\/\/ or https:\/\/ API base URL|API URL must not contain|API Key is missing or invalid/.test(error?.stderr || error?.message || '');
}
// Ask once during a cold launch. Only an explicit settings submission starts a new request.
export async function prepareWithRecovery(prepare, recover) {
  let ready, failure;
  try { ready = await prepare(); } catch (error) {
    if (!gatewayUnavailable(error)) throw error;
    failure = error;
  }
  if (!failure && ready?.gateway?.ready !== false) return ready;
  if (recover && await recover()) return prepare();
  if (failure) throw failure;
  return ready;
}
export function updateEnv(text, settings) {
  for (const [key, value] of Object.entries(settings)) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key) || /[\r\n\0]/.test(String(value))) throw new Error('Invalid API setting.');
    const line = key + '=' + value, pattern = new RegExp('^' + key + '\\s*=.*$', 'gm');
    text = pattern.test(text) ? text.replace(pattern, () => line) : text.trimEnd() + '\n' + line + '\n';
  }
  return text.replace(/^\n/, '').trimEnd() + '\n';
}
export function restoreRootLine(text, key, line, original) {
  const currentHead = rootHead(text);
  if (!line || getRoot(text, key)) return null;
  const originalHead = rootHead(original || ''), previous = getRoot(originalHead, key);
  if (!previous) return null;
  const matchAt = tomlMask(originalHead).indexOf(tomlMask(previous));
  const following = tomlMask(originalHead).slice(matchAt + previous.length);
  for (const next of following.matchAll(/^[ \t]*["']?([A-Za-z_][A-Za-z0-9_]*)["']?[ \t]*=/gm)) {
    const nextLine = getRoot(currentHead, next[1]);
    const at = nextLine ? tomlMask(currentHead).indexOf(tomlMask(nextLine)) : -1;
    if (at >= 0) return currentHead.slice(0, at) + line + text.slice(at);
  }
  return currentHead + line + text.slice(currentHead.length);
}
