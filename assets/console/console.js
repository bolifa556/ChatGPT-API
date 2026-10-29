const $ = selector => document.querySelector(selector);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const tokens = value => value == null ? '未提供' : value >= 1000000 ? (value / 1000000).toLocaleString('en-US', { maximumFractionDigits: 2 }) + 'M' : value >= 1000 ? (value / 1000).toLocaleString('en-US', { maximumFractionDigits: 1 }) + 'K' : value.toLocaleString();
let token = location.hash.slice(1) || sessionStorage.getItem('console-token') || '';
if (token) sessionStorage.setItem('console-token', token);
history.replaceState(null, '', location.pathname);
let data, draft, dirty = false, busy = false, toastTimer;
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
  return '<label class="field' + (full ? ' full' : '') + '"><span>' + label + '</span>' + (secret ? '<div class="key-input">' : '') + '<input data-field="' + name + '" ' + (secret ? 'type="password" autocomplete="new-password"' : 'type="text" autocomplete="off"') + ' value="' + escape(provider[name] || '') + '" placeholder="' + escape(placeholder) + '" aria-label="' + escape(label + ' · ' + provider.name) + '">' + (secret ? '<button class="icon-button reveal" type="button" aria-label="显示新输入的密钥">◉</button></div>' : '') + '</label>';
}
function renderSources() {
  $('#sources').innerHTML = draft.providers.map(provider => {
    const state = data.sources.find(source => source.id === provider.id);
    const status = !provider.enabled ? '已停用' : state?.models ? state.models + ' 个模型' + (state.cached ? ' · 缓存' : '') : state?.error ? '连接失败' : '未加载';
    return `<article class="source-card" data-id="${provider.id}">
      <div class="source-head"><strong class="source-name">${escape(provider.name)}</strong><div class="source-tools"><span class="status-pill ${provider.enabled && state?.error ? 'failed' : ''}">${escape(status)}</span><label class="toggle"><input type="checkbox" data-field="enabled" aria-label="启用 ${escape(provider.name)}" ${provider.enabled ? 'checked' : ''}><span></span></label><button class="icon-button danger remove" aria-label="移除 ${escape(provider.name)}">×</button></div></div>
      <div class="field-grid">${field(provider, 'name', '名称', 'API 来源')}${field(provider, 'baseUrl', 'API 地址', 'https://api.example.com/v1')}${field(provider, 'apiKey', 'API Key', provider.keyConfigured ? '已保存；留空不变' : '输入 API Key', true)}</div>
      ${provider.enabled && state?.error ? '<p class="source-error">' + escape(state.error) + '</p>' : ''}
      <details><summary>图片模型</summary><div class="field-grid">${field(provider, 'imageModel', '生图模型', '自动识别')}${field(provider, 'imageEditModel', '图片编辑模型', '沿用生图模型')}<label class="field"><span>图片编辑格式</span><select data-field="imageEditFormat"><option value="json" ${provider.imageEditFormat !== 'multipart' ? 'selected' : ''}>JSON</option><option value="multipart" ${provider.imageEditFormat === 'multipart' ? 'selected' : ''}>Multipart</option></select></label></div><div class="source-footer"><button class="prefer ${draft.preferredProviderId === provider.id ? 'preferred' : ''}">${draft.preferredProviderId === provider.id ? '当前优先生图来源' : '设为优先生图来源'}</button></div></details></article>`;
  }).join('');
  for (const card of document.querySelectorAll('.source-card')) {
    const provider = draft.providers.find(item => item.id === card.dataset.id);
    card.addEventListener('input', event => {
      const input = event.target, name = input.dataset.field; if (!name) return;
      provider[name] = input.type === 'checkbox' ? input.checked : input.value;
      if (name === 'name') card.querySelector('.source-name').textContent = input.value;
      changed(); updateCounts();
    });
    card.querySelector('.remove').onclick = () => {
      if (!confirm('移除“' + provider.name + '”？已有聊天记录不会被删除。')) return;
      draft.providers = draft.providers.filter(item => item.id !== provider.id);
      for (const key of Object.keys(draft.contextOverrides)) if (JSON.parse(key)[0] === provider.id) delete draft.contextOverrides[key];
      if (draft.preferredProviderId === provider.id) draft.preferredProviderId = draft.providers.find(item => item.enabled)?.id || '';
      changed(); renderSources(); updateCounts();
    };
    card.querySelector('.prefer').onclick = () => { if (!provider.enabled) return toast('请先启用此来源。'); draft.preferredProviderId = provider.id; changed(); renderSources(); };
    card.querySelector('.reveal').onclick = () => { const input = card.querySelector('[data-field=apiKey]'); input.type = input.type === 'password' ? 'text' : 'password'; };
  }
}
function updateCounts() {
  $('#source-count').textContent = draft.providers.length;
  $('#model-count').textContent = data.models.length;
}
function renderModels() {
  if (!data) return;
  const search = $('#model-search').value.toLowerCase(), source = $('#model-source-filter').value;
  const models = data.models.filter(model => (!source || model.providerId === source) && (model.name + model.providerName).toLowerCase().includes(search));
  $('#filtered-count').textContent = models.length + ' 个模型'; $('#models-empty').hidden = models.length > 0;
  $('#model-rows').innerHTML = models.map(model => {
    const override = draft.contextOverrides[model.overrideKey] || '';
    const actual = Math.min(Number(override) || model.capacity || model.fallbackCapacity || model.limit, model.capacity || Infinity, Number(draft.contextLimit));
    return '<tr><td><strong>' + escape(model.name) + '</strong>' + (model.kind === 'image' ? ' · 图像' : '') + '</td><td>' + escape(model.providerName) + '</td><td>' + (model.kind === 'image' ? '—' : tokens(model.capacity)) + '</td><td><input class="model-override" ' + (model.kind === 'image' ? 'disabled ' : '') + 'type="number" min="4096" max="2000000" data-key="' + escape(model.overrideKey) + '" value="' + override + '" placeholder="自动" aria-label="' + escape(model.name) + ' 的上下文上限"></td><td data-effective="' + escape(model.overrideKey) + '">' + (model.kind === 'image' ? '—' : tokens(Math.floor(actual * (model.effectivePercent ?? 95) / 100))) + '</td></tr>';
  }).join('');
  for (const input of document.querySelectorAll('.model-override')) input.oninput = () => {
    const model = models.find(item => item.overrideKey === input.dataset.key); draft.contextOverrides[input.dataset.key] = input.value ? Number(input.value) : null;
    const actual = Math.min(Number(input.value) || model.capacity || model.fallbackCapacity || model.limit, model.capacity || Infinity, Number(draft.contextLimit));
    input.closest('tr').lastElementChild.textContent = tokens(Math.floor(actual * (model.effectivePercent ?? 95) / 100)); changed();
  };
}
function render(result) {
  data = result; draft = structuredClone(result.settings); dirty = false;
  $('#version').textContent = 'v' + result.version; $('#context-limit').value = draft.contextLimit;
  $('#notice').hidden = !result.configurationSaved || !result.runtime.restartRequired;
  $('#notice').textContent = '设置已保存。完全退出并重新打开 ChatGPT 后，加载新的 API 来源、模型菜单和上下文设置。';
  $('#model-source-filter').innerHTML = '<option value="">所有来源</option>' + draft.providers.map(provider => '<option value="' + provider.id + '">' + escape(provider.name) + '</option>').join('');
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
  changed(); renderSources(); updateCounts(); $('.source-card:last-child [data-field=name]').focus();
};
$('#context-limit').oninput = event => { draft.contextLimit = Number(event.target.value); changed(); updateCounts(); renderModels(); };
$('#model-search').oninput = renderModels; $('#model-source-filter').onchange = renderModels;
$('#discard').onclick = () => render(data);
$('#save-settings').onclick = async () => { busy = true; updateSavebar(); try { render(await api('settings', draft)); toast('已保存，重开客户端后应用。'); } catch (error) { toast(error.message); } finally { busy = false; updateSavebar(); } };
$('#refresh-models').onclick = async () => { busy = true; updateSavebar(); const button = $('#refresh-models'); button.textContent = '正在加载…'; try { render(await api('refresh', {})); toast('模型目录已更新。'); } catch (error) { toast(error.message); } finally { busy = false; button.textContent = '刷新模型目录'; updateSavebar(); } };
$('#close-console').onclick = async () => { if (dirty && !confirm('尚有未保存的修改，仍然退出？')) return; try { await api('close', {}); document.body.innerHTML = '<main class="closed"><div class="content"><h1>控制台已退出</h1><p>可以关闭此页面；需要时从安装目录重新打开控制台。</p></div></main>'; } catch (error) { toast(error.message); } };
window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
api('state').then(render).catch(error => { $('#load-error').textContent = error.message; $('#load-error').hidden = false; });
