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
  const head = value => value.slice(0, value.search(/^[ \t]*\[/m) < 0 ? value.length : value.search(/^[ \t]*\[/m));
  const pattern = name => new RegExp('^[ \\t]*' + name + '[ \\t]*=[^\\r\\n]*(?:\\r?\\n|$)', 'm');
  const currentHead = head(text);
  if (!line || pattern(key).test(currentHead)) return null;
  const originalHead = head(original || ''), match = pattern(key).exec(originalHead);
  if (!match) return null;
  const following = originalHead.slice(match.index + match[0].length);
  for (const next of following.matchAll(/^[ \t]*([A-Za-z_][A-Za-z0-9_]*)[ \t]*=/gm)) {
    const at = currentHead.search(pattern(next[1]));
    if (at >= 0) return currentHead.slice(0, at) + line + text.slice(at);
  }
  return currentHead + line + text.slice(currentHead.length);
}
