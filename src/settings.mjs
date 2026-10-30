import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const DEFAULT_CONTEXT_LIMIT = 500000;
export const MAX_CONTEXT_LIMIT = 2000000;
export const settingsPath = root => path.join(root, 'data/providers.json');
export function readEnvFile(file) {
  let text; try { text = fs.readFileSync(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  return Object.fromEntries(text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(line => line.trim() && !line.trim().startsWith('#') && line.indexOf('=') > 0)
    .map(line => { const at = line.indexOf('='); return [line.slice(0, at).trim(), line.slice(at + 1).trim()]; }));
}
export function normalizeBaseUrl(value) {
  if (typeof value !== 'string' || /[\r\n\0]/.test(value)) throw new Error('请输入有效的 API 基础 URL。');
  let text = value.trim().replace(/\/+$/, '').replace(/\/(?:models|responses)$/i, '');
  let url; try { url = new URL(text); } catch { throw new Error('API 基础 URL 必须以 http:// 或 https:// 开头。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('API URL 不得包含账号密码、查询参数或片段。');
  if (!/\/v1$/i.test(text)) text += '/v1';
  return text;
}
export function atomicPrivate(file, value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n';
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = file + '.' + crypto.randomUUID() + '.tmp';
  try { fs.writeFileSync(temporary, text, { mode: 0o600 }); fs.renameSync(temporary, file); if (process.platform !== 'win32') fs.chmodSync(file, 0o600); }
  finally { try { fs.unlinkSync(temporary); } catch {} }
}
export const settingsRevision = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const overrideKey = (providerId, modelId) => JSON.stringify([providerId, modelId]);
const shortText = (value, fallback, max = 100) => typeof value === 'string' && value.trim() && !/[\r\n\0]/.test(value) && value.trim().length <= max ? value.trim() : fallback;
export function normalizeSettings(value, previous, { allowEmpty = false } = {}) {
  if (!value || value.version !== 1 || !Array.isArray(value.providers) || value.providers.length > 32) throw new Error('API 来源配置格式无效，最多可添加 32 个来源。');
  const ids = new Set();
  const providers = value.providers.map(item => {
    const id = item?.id;
    if (typeof id !== 'string' || !/^(?:default|p_[a-z0-9]{8,32})$/.test(id) || ids.has(id)) throw new Error('API 来源标识无效或重复。');
    ids.add(id);
    const old = previous?.providers?.find(provider => provider.id === id);
    const apiKey = typeof item.apiKey === 'string' && item.apiKey.trim() ? item.apiKey.trim() : old?.apiKey || '';
    if ((!apiKey && !allowEmpty) || apiKey.length > 8192 || /[\r\n\0]/.test(apiKey)) throw new Error('请为每个 API 来源填写有效的 Key；已有 Key 留空即可保留。');
    const baseUrl = allowEmpty && !item.baseUrl ? '' : normalizeBaseUrl(item.baseUrl);
    return { id, name: shortText(item.name, id === 'default' ? '默认 API' : '自定义 API'), baseUrl, apiKey, enabled: item.enabled !== false,
      imageModel: shortText(item.imageModel, '', 300), imageEditModel: shortText(item.imageEditModel, '', 300), imageEditFormat: item.imageEditFormat === 'multipart' ? 'multipart' : 'json' };
  });
  if (!allowEmpty && !providers.some(provider => provider.enabled)) throw new Error('请至少启用一个 API 来源。');
  const contextLimit = Number(value.contextLimit ?? DEFAULT_CONTEXT_LIMIT);
  if (!Number.isSafeInteger(contextLimit) || contextLimit < 4096 || contextLimit > MAX_CONTEXT_LIMIT) throw new Error('上下文上限应为 4,096 至 2,000,000 tokens。');
  const overrides = value.contextOverrides ?? {};
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides) || Object.keys(overrides).length > 2000) throw new Error('模型上下文配置无效。');
  const contextOverrides = {};
  for (const [key, raw] of Object.entries(overrides)) {
    let identity; try { identity = JSON.parse(key); } catch { throw new Error('模型上下文标识无效。'); }
    if (!Array.isArray(identity) || identity.length !== 2 || !ids.has(identity[0]) || typeof identity[1] !== 'string' || identity[1].length > 500) throw new Error('模型上下文来源无效。');
    if (raw === '' || raw === null || raw === 0) continue;
    const limit = Number(raw);
    if (!Number.isSafeInteger(limit) || limit < 4096 || limit > MAX_CONTEXT_LIMIT) throw new Error('单模型上下文应为 4,096 至 2,000,000 tokens，留空为自动。');
    contextOverrides[key] = limit;
  }
  const preferredProviderId = providers.some(provider => provider.id === value.preferredProviderId && provider.enabled)
    ? value.preferredProviderId : providers.find(provider => provider.enabled)?.id || providers[0]?.id || 'default';
  const legacy = providers.find(provider => provider.id === preferredProviderId);
  const selectedImage = Object.hasOwn(value, 'defaultImageModel') ? value.defaultImageModel
    : previous && Object.hasOwn(previous, 'defaultImageModel') ? previous.defaultImageModel
    : legacy?.imageModel ? { providerId: legacy.id, modelId: legacy.imageModel } : null;
  let defaultImageModel = null;
  if (selectedImage != null) {
    if (typeof selectedImage !== 'object' || Array.isArray(selectedImage) || !ids.has(selectedImage.providerId)
      || typeof selectedImage.modelId !== 'string' || !selectedImage.modelId.trim() || selectedImage.modelId.length > 500 || /[\r\n\0]/.test(selectedImage.modelId)) {
      throw new Error('默认生图模型无效，请从模型列表重新选择。');
    }
    defaultImageModel = { providerId: selectedImage.providerId, modelId: selectedImage.modelId.trim() };
  }
  return { version: 1, providers, preferredProviderId, defaultImageModel, contextLimit, contextOverrides };
}
export function readSettings(root, env = readEnvFile(path.join(root, 'data/.env'))) {
  const file = settingsPath(root);
  if (fs.existsSync(file)) return normalizeSettings(JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')), undefined, { allowEmpty: false });
  return normalizeSettings({ version: 1, providers: [{ id: 'default', name: '默认 API', baseUrl: env.BASE_URL || '', apiKey: env.API_KEY || '', enabled: true,
    imageModel: env.IMAGE_MODEL, imageEditModel: env.IMAGE_EDIT_MODEL, imageEditFormat: env.IMAGE_EDIT_FORMAT }], contextLimit: DEFAULT_CONTEXT_LIMIT, contextOverrides: {}, preferredProviderId: 'default' }, undefined, { allowEmpty: true });
}
export function publicSettings(value) {
  return { ...value, revision: settingsRevision(value), providers: value.providers.map(({ apiKey, ...provider }) => ({ ...provider, keyConfigured: Boolean(apiKey) })) };
}
export function userApiSettings(root, env = readEnvFile(path.join(root, 'data/.env'))) {
  const settings = readSettings(root, env);
  const profile = settings.providers.find(item => item.id === settings.preferredProviderId && item.enabled);
  return profile ? { ...env, BASE_URL: profile.baseUrl, API_KEY: profile.apiKey } : { ...env };
}
export function initializeDeferredSettings(root) {
  const file = path.join(root, 'data/.env');
  if (!fs.existsSync(file)) atomicPrivate(file, 'BASE_URL=\nAPI_KEY=\nSHIM_HOST=127.0.0.1\nSHIM_PORT=8102\nGATEWAY_TRANSPORT=direct\n');
}
export function requireApiConfiguration(root, env = readEnvFile(path.join(root, 'data/.env'))) {
  const settings = readSettings(root, env);
  if (!settings.providers.some(profile => profile.enabled && profile.baseUrl && profile.apiKey)) {
    throw Object.assign(new Error('尚未配置 API。请打开“ChatGPT API 控制台”填写 API 地址和 Key，保存后重新打开 API 入口。'), { code: 'api_not_configured' });
  }
  return settings;
}
export function saveSettings(root, value, env) {
  const previous = readSettings(root, env);
  if (value.revision && value.revision !== settingsRevision(previous)) throw Object.assign(new Error('配置已被另一个窗口修改，请重新载入后再保存。'), { status: 409 });
  const normalized = normalizeSettings(value, previous);
  atomicPrivate(settingsPath(root), normalized);
  // The legacy helper authenticates only to our local bridge. Keep its existing
  // bootstrap credential stable while running; initialize it on a fresh install.
  const envFile = path.join(root, 'data/.env'), bootstrap = readEnvFile(envFile);
  if (!bootstrap.BASE_URL || !bootstrap.API_KEY) {
    const profile = normalized.providers.find(item => item.id === normalized.preferredProviderId);
    const fields = { ...bootstrap, BASE_URL: profile.baseUrl, API_KEY: profile.apiKey, SHIM_HOST: '127.0.0.1', SHIM_PORT: bootstrap.SHIM_PORT || '8102', GATEWAY_TRANSPORT: bootstrap.GATEWAY_TRANSPORT || 'direct' };
    atomicPrivate(envFile, Object.entries(fields).map(([key, val]) => key + '=' + val).join('\n') + '\n');
  }
  return normalized;
}
export function syncLegacySettings(root, baseUrl, apiKey) {
  if (!fs.existsSync(settingsPath(root))) return;
  const previous = readSettings(root), id = previous.preferredProviderId;
  const normalized = normalizeSettings({ ...previous, providers: previous.providers.map(provider => provider.id === id ? { ...provider, baseUrl, apiKey } : provider) }, previous);
  atomicPrivate(settingsPath(root), normalized);
}
export function redact(text, value, extra = []) {
  for (const key of [...(value?.providers || []).map(provider => provider.apiKey), ...extra].filter(Boolean)) text = String(text).replaceAll(key, '[redacted]');
  return String(text);
}
export const publicModelId = (providerId, modelId) => providerId === 'default' ? modelId : '@' + providerId + '/' + modelId;

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv[2] !== 'sync-legacy') throw new Error('Unknown settings command.');
    const root = path.resolve(process.argv[3]);
    const env = readEnvFile(path.join(root, 'data/.env'));
    syncLegacySettings(root, env.BASE_URL, env.API_KEY);
  } catch (error) { console.error('无法同步 API 来源设置：' + error.message); process.exitCode = 1; }
}
