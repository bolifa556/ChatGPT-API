const $ = selector => document.querySelector(selector);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const tokens = value => value == null ? '未提供' : value >= 1000000 ? (value / 1000000).toLocaleString('en-US', { maximumFractionDigits: 2 }) + 'M' : value >= 1000 ? (value / 1000).toLocaleString('en-US', { maximumFractionDigits: 1 }) + 'K' : value.toLocaleString();
let token = location.hash.slice(1) || sessionStorage.getItem('console-token') || '';
if (token) sessionStorage.setItem('console-token', token);
history.replaceState(null, '', location.pathname);
let data, draft, dirty = false, busy = false, toastTimer;
const savedKeyMask = '••••••••••••••••';
const icon = (paths, className = '') => '<svg class="' + className + '" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + paths + '</svg>';
const pencilIcon = icon('<path d="m15 5 4 4M5 19l4-1L20 7a2.8 2.8 0 0 0-4-4L5 14l-1 6Z"/>');
const eyeIcon = visible => icon('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>' + (visible ? '<path d="m3 3 18 18"/>' : ''));
async function api(route, body) {
  const response = await fetch('/api/' + route, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: 'Bearer ' + token, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json(); if (!response.ok) throw new Error(result.error || '操作未完成。'); return result;
}
function toast(message) { clearTimeout(toastTimer); $('#toast').textContent = message; $('#toast').hidden = false; toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 5500); }
function changed() { dirty = true; updateSavebar(); }
function updateSavebar() {
  $('.savebar').classList.toggle('dirty', dirty);
  $('#save-settings').disabled = !dirty || busy; $('#discard').disabled = !dirty || busy; $('#refresh-models').disabled = busy || dirty;
  $('#save-status').textContent = busy ? '正在处理…' : dirty ? '未保存' : '已保存';
  $('#add-source').disabled = busy;
}
function field(provider, name, label, placeholder = '', full = false) {
  const secret = name === 'apiKey';
  if (secret) {
    const masked = Boolean(provider.keyConfigured && !provider.apiKey), id = 'key-' + provider.id;
    return '<div class="field full"><label for="' + id + '">API Key</label><div class="key-input"><input id="' + id + '" data-field="apiKey" data-masked="' + masked + '" type="password" autocomplete="new-password" spellcheck="false" value="' + escape(masked ? savedKeyMask : provider.apiKey || '') + '" placeholder="输入 API Key" aria-label="' + escape('API Key · ' + provider.name) + '"><button class="icon-button reveal" type="button" aria-label="' + escape('显示 API Key · ' + provider.name) + '" title="显示 Key" aria-pressed="false">' + eyeIcon(false) + '</button></div></div>';
  }
  return '<label class="field' + (full ? ' full' : '') + '"><span>' + label + '</span><input data-field="' + name + '" type="text" autocomplete="off" value="' + escape(provider[name] || '') + '" placeholder="' + escape(placeholder) + '" aria-label="' + escape(label + ' · ' + provider.name) + '"></label>';
}
function sourceTitle(provider) {
  return '<strong class="source-name" title="' + escape(provider.name) + '">' + escape(provider.name) + '</strong><button class="quiet-action rename-source" type="button" aria-label="' + escape('重命名 ' + provider.name) + '">' + pencilIcon + '<span>重命名</span></button>';
}
function renderSourceFilters() {
  const filter = $('#model-source-filter'), selected = filter.value;
  filter.innerHTML = '<option value="">所有来源</option>' + draft.providers.map(provider => '<option value="' + provider.id + '">' + escape(provider.name) + '</option>').join('');
  filter.value = draft.providers.some(provider => provider.id === selected) ? selected : '';
}
function bindSourceTitle(card, provider) {
  const title = card.querySelector('.source-title');
  title.innerHTML = sourceTitle(provider);
  title.querySelector('.rename-source').onclick = () => {
    title.innerHTML = '<form class="rename-form"><input class="rename-input" type="text" value="' + escape(provider.name) + '" aria-label="来源名称" maxlength="100" required autocomplete="off"><button class="quiet-action rename-confirm" type="submit">确定</button><button class="quiet-action rename-cancel" type="button">取消</button></form>';
    const form = title.querySelector('form'), input = form.querySelector('input');
    const close = () => { bindSourceTitle(card, provider); title.querySelector('.rename-source').focus(); };
    form.onsubmit = event => {
      event.preventDefault(); const name = input.value.trim();
      input.setCustomValidity(name ? '' : '请输入来源名称。'); if (!input.reportValidity()) return;
      if (provider.name !== name) { provider.name = name; changed(); renderSourceFilters(); renderModels(); }
      card.querySelector('[data-field=baseUrl]').setAttribute('aria-label', 'API 地址 · ' + name);
      card.querySelector('[data-field=apiKey]').setAttribute('aria-label', 'API Key · ' + name);
      const reveal = card.querySelector('.reveal'), visible = card.querySelector('[data-field=apiKey]').type === 'text';
      reveal.setAttribute('aria-label', (visible ? '隐藏' : '显示') + ' API Key · ' + name);
      card.querySelector('[data-field=enabled]').setAttribute('aria-label', '启用 ' + name);
      card.querySelector('.remove').setAttribute('aria-label', '移除 ' + name);
      close();
    };
    input.oninput = () => input.setCustomValidity('');
    form.querySelector('.rename-cancel').onclick = close;
    form.onkeydown = event => { if (event.key === 'Escape') { event.preventDefault(); close(); } };
    input.focus(); input.select();
  };
}
function imageDefault() {
  if (draft.defaultImageModel) return draft.defaultImageModel;
  const model = (data.automaticImageModels || []).map(id => data.models.find(item => item.id === id))
    .find(model => model && draft.providers.some(provider => provider.id === model.providerId && provider.enabled));
  return model ? { providerId: model.providerId, modelId: model.name } : null;
}
function renderImageDefault() {
  const selected = imageDefault(), provider = draft.providers.find(item => item.id === selected?.providerId);
  $('#image-default-summary').innerHTML = selected
    ? '<span>默认生图：<strong>' + escape(selected.modelId) + '</strong>（' + escape(provider?.name || '来源已移除') + (draft.defaultImageModel ? '' : ' · 自动') + '）</span>'
      + (draft.defaultImageModel ? '<button id="clear-image-default" class="quiet-action" type="button">恢复自动</button>' : '')
    : '<span>当前目录未识别到生图模型。启动 API 入口或刷新模型目录后，会自动选好默认模型。</span>';
  if (draft.defaultImageModel) $('#clear-image-default').onclick = () => { draft.defaultImageModel = null; changed(); renderModels(); };
}
function bindKey(card, provider) {
  const input = card.querySelector('[data-field=apiKey]'), button = card.querySelector('.reveal');
  const update = () => {
    const visible = input.type === 'text'; button.innerHTML = eyeIcon(visible);
    button.setAttribute('aria-pressed', String(visible)); button.title = visible ? '隐藏 Key' : '显示 Key';
    button.setAttribute('aria-label', (visible ? '隐藏' : '显示') + ' API Key · ' + provider.name);
  };
  const hide = () => {
    input.type = 'password';
    if (!provider.apiKey && provider.keyConfigured) { input.value = savedKeyMask; input.dataset.masked = 'true'; }
    update();
  };
  input.addEventListener('beforeinput', () => {
    if (input.dataset.masked === 'true') { input.value = ''; input.dataset.masked = 'false'; }
  });
  input.addEventListener('focus', () => { if (input.dataset.masked === 'true') input.select(); });
  input.addEventListener('blur', () => { if (!input.value && provider.keyConfigured) hide(); });
  button.onclick = async () => {
    if (input.type === 'text') { hide(); return; }
    button.disabled = true; button.setAttribute('aria-busy', 'true');
    try {
      if (!provider.apiKey && provider.keyConfigured) {
        const revision = data.settings.revision, result = await api('keys/reveal', { providerId: provider.id, revision });
        if (!input.isConnected || data.settings.revision !== revision) return;
        if (!provider.apiKey) { input.value = result.apiKey; input.dataset.masked = 'false'; }
      }
      input.type = 'text'; update();
    } catch (error) { toast(error.message); }
    finally { button.disabled = false; button.removeAttribute('aria-busy'); }
  };
}
function renderSources() {
  $('#sources').innerHTML = draft.providers.map(provider => {
    const state = data.sources.find(source => source.id === provider.id);
    const status = !provider.enabled ? '已停用' : state?.models ? state.models + ' 个模型' + (state.cached ? ' · 缓存' : '') : state?.error ? '连接失败' : '未加载';
    return `<article class="source-card" data-id="${provider.id}">
      <div class="source-head"><div class="source-title">${sourceTitle(provider)}</div><div class="source-tools"><span class="status-pill ${provider.enabled && state?.error ? 'failed' : ''}">${escape(status)}</span><label class="toggle"><input type="checkbox" data-field="enabled" aria-label="启用 ${escape(provider.name)}" ${provider.enabled ? 'checked' : ''}><span></span></label><button class="icon-button danger remove" aria-label="移除 ${escape(provider.name)}">×</button></div></div>
      <div class="field-grid">${field(provider, 'baseUrl', 'API 地址', 'https://api.example.com/v1', true)}${field(provider, 'apiKey', 'API Key')}</div>
      ${provider.enabled && state?.error ? '<p class="source-error">' + escape(state.error) + '</p>' : ''}</article>`;
  }).join('');
  for (const card of document.querySelectorAll('.source-card')) {
    const provider = draft.providers.find(item => item.id === card.dataset.id);
    card.addEventListener('input', event => {
      const input = event.target, name = input.dataset.field; if (!name) return;
      if (name === 'apiKey') {
        if (input.dataset.masked === 'true' && input.value === savedKeyMask) return;
        input.dataset.masked = 'false';
      }
      provider[name] = input.type === 'checkbox' ? input.checked : input.value;
      if (name === 'enabled') {
        if (!provider.enabled && draft.defaultImageModel?.providerId === provider.id) draft.defaultImageModel = null;
        renderModels();
      }
      changed(); updateCounts();
    });
    card.querySelector('.remove').onclick = () => {
      if (!confirm('移除“' + provider.name + '”？已有聊天记录不会被删除。')) return;
      draft.providers = draft.providers.filter(item => item.id !== provider.id);
      for (const key of Object.keys(draft.contextOverrides)) if (JSON.parse(key)[0] === provider.id) delete draft.contextOverrides[key];
      if (draft.preferredProviderId === provider.id) draft.preferredProviderId = draft.providers.find(item => item.enabled)?.id || '';
      if (draft.defaultImageModel?.providerId === provider.id) draft.defaultImageModel = null;
      changed(); renderSources(); renderSourceFilters(); renderModels(); updateCounts();
    };
    bindSourceTitle(card, provider); bindKey(card, provider);
  }
}
function updateCounts() {
  $('#source-count').textContent = draft.providers.length;
  $('#model-count').textContent = data.models.filter(model => draft.providers.some(provider => provider.id === model.providerId && provider.enabled)).length;
}
function renderModels() {
  if (!data) return;
  const defaultImage = imageDefault();
  const search = $('#model-search').value.toLowerCase(), source = $('#model-source-filter').value;
  const models = data.models.filter(model => draft.providers.some(provider => provider.id === model.providerId && provider.enabled) && (!source || model.providerId === source) && (model.name + (draft.providers.find(provider => provider.id === model.providerId)?.name || model.providerName)).toLowerCase().includes(search));
  $('#filtered-count').textContent = models.length + ' 个模型'; $('#models-empty').hidden = models.length > 0;
  $('#model-rows').innerHTML = models.map(model => {
    const override = draft.contextOverrides[model.overrideKey] || '';
    const actual = Math.min(Number(override) || model.capacity || model.fallbackCapacity || model.limit, model.capacity || Infinity, Number(draft.contextLimit));
    const providerName = draft.providers.find(provider => provider.id === model.providerId)?.name || model.providerName;
    if (model.kind === 'image') {
      const selected = defaultImage?.providerId === model.providerId && defaultImage.modelId === model.name;
      const automatic = selected && !draft.defaultImageModel;
      const control = model.image?.generation
        ? '<label class="image-default-choice' + (selected ? ' selected' : '') + '"><input type="checkbox" class="image-default" data-id="' + escape(model.id) + '" ' + (selected ? 'checked ' : '') + (automatic ? 'disabled ' : '') + 'aria-label="' + escape(model.name + ' · ' + providerName + ' 默认生图') + '"><span>默认生图' + (automatic ? '（自动）' : '') + '</span></label>'
        : '<span class="model-note">仅图片编辑</span>';
      return '<tr class="image-model-row"><td><strong>' + escape(model.name) + '</strong><span class="model-kind">图片</span></td><td>' + escape(providerName) + '</td><td></td><td></td><td>' + control + '</td></tr>';
    }
    return '<tr><td><strong>' + escape(model.name) + '</strong></td><td>' + escape(providerName) + '</td><td>' + tokens(model.capacity) + '</td><td><input class="model-override" type="number" min="4096" max="2000000" data-key="' + escape(model.overrideKey) + '" value="' + override + '" placeholder="自动" aria-label="' + escape(model.name) + ' 的上下文上限"></td><td data-effective="' + escape(model.overrideKey) + '">' + tokens(Math.floor(actual * (model.effectivePercent ?? 95) / 100)) + '</td></tr>';
  }).join('');
  for (const input of document.querySelectorAll('.model-override')) input.oninput = () => {
    const model = models.find(item => item.overrideKey === input.dataset.key); draft.contextOverrides[input.dataset.key] = input.value ? Number(input.value) : null;
    const actual = Math.min(Number(input.value) || model.capacity || model.fallbackCapacity || model.limit, model.capacity || Infinity, Number(draft.contextLimit));
    input.closest('tr').lastElementChild.textContent = tokens(Math.floor(actual * (model.effectivePercent ?? 95) / 100)); changed();
  };
  for (const input of document.querySelectorAll('.image-default')) input.onchange = () => {
    const model = models.find(item => item.id === input.dataset.id);
    draft.defaultImageModel = input.checked ? { providerId: model.providerId, modelId: model.name } : null;
    changed(); renderModels();
    [...document.querySelectorAll('.image-default')].find(item => item.dataset.id === model.id)?.focus();
  };
  renderImageDefault();
}
function render(result) {
  data = result; draft = structuredClone(result.settings); dirty = false;
  $('#version').textContent = 'v' + result.version; $('#context-limit').value = draft.contextLimit;
  $('#notice').hidden = !result.configurationSaved || !result.runtime.restartRequired;
  $('#notice').textContent = '设置已保存。完全退出并重新打开 ChatGPT 后，加载新的 API 来源、模型菜单和上下文设置。';
  renderSourceFilters();
  renderSources(); renderModels(); updateCounts(); updateSavebar();
}
function view(name) {
  for (const button of document.querySelectorAll('[data-view]')) button.classList.toggle('active', button.dataset.view === name);
  for (const item of document.querySelectorAll('.view')) item.hidden = item.id !== 'view-' + name;
  $('#page-name').textContent = ({ sources: 'API 来源', models: '模型与上下文', about: '使用说明' })[name];
}
for (const button of document.querySelectorAll('[data-view]')) button.onclick = () => view(button.dataset.view);
for (const button of document.querySelectorAll('[data-theme]')) if (button.tagName === 'BUTTON') button.onclick = () => theme(button.dataset.theme);
function theme(value) { document.documentElement.dataset.theme = value; localStorage.setItem('console-theme', value); for (const button of document.querySelectorAll('button[data-theme]')) button.classList.toggle('selected', button.dataset.theme === value); }
theme(localStorage.getItem('console-theme') || 'auto');
$('#add-source').onclick = () => {
  if (!draft) return;
  const id = 'p_' + crypto.randomUUID().replaceAll('-', '').slice(0, 12);
  draft.providers.push({ id, name: 'API 来源 ' + (draft.providers.length + 1), baseUrl: '', apiKey: '', enabled: true, imageModel: '', imageEditModel: '', imageEditFormat: 'json' });
  changed(); renderSources(); renderSourceFilters(); updateCounts(); $('.source-card:last-child [data-field=baseUrl]').focus();
};
$('#context-limit').oninput = event => { draft.contextLimit = Number(event.target.value); changed(); updateCounts(); renderModels(); };
$('#model-search').oninput = renderModels; $('#model-source-filter').onchange = renderModels;
$('#discard').onclick = () => render(data);
$('#save-settings').onclick = async () => { busy = true; updateSavebar(); try { render(await api('settings', draft)); toast('已保存，重开客户端后应用。'); } catch (error) { toast(error.message); } finally { busy = false; updateSavebar(); } };
$('#refresh-models').onclick = async () => { busy = true; updateSavebar(); const button = $('#refresh-models'); button.textContent = '正在加载…'; try { render(await api('refresh', {})); toast('模型目录已更新。'); } catch (error) { toast(error.message); } finally { busy = false; button.textContent = '刷新模型目录'; updateSavebar(); } };
$('#close-console').onclick = async () => { if (dirty && !confirm('尚有未保存的修改，仍然退出？')) return; try { await api('close', {}); document.body.innerHTML = '<main class="closed"><div class="content"><h1>控制台已退出</h1><p>可以关闭此页面；需要时从安装目录重新打开控制台。</p></div></main>'; } catch (error) { toast(error.message); } };
window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
api('state').then(render).catch(error => { $('#load-error').textContent = error.message; $('#load-error').hidden = false; });
