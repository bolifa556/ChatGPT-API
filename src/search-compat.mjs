// Search controls vary between OpenAI-compatible APIs. Preserve controls that
// the caller supplied, and select built-in search by the endpoint's contract.
export const searchParameters = ['enable_search', 'search_options', 'web_search_options', 'search_parameters',
  'search_domain_filter', 'search_recency_filter', 'search_after_date_filter', 'search_before_date_filter',
  'last_updated_after_filter', 'last_updated_before_filter', 'return_citations', 'return_related_questions',
  'return_images', 'search_mode', 'extra_body'];
export const searchResultFields = ['citations', 'search_results', 'search_result', 'search_info',
  'web_search', 'grounding_metadata', 'groundingMetadata'];
export const searchProtocols = new Set(['native', 'responses', 'chat']);
const list = value => Array.isArray(value) ? value : [];

export function searchUrl(value) {
  try {
    const url = new URL(value);
    if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) return url.href;
  } catch {}
  return null;
}

export function searchSources(value = {}) {
  if (!value.citations && !value.search_results && !value.search_result && !value.search_info
      && !value.web_search && !value.groundingMetadata && !value.grounding_metadata) return [];
  const grounding = value.groundingMetadata || value.grounding_metadata || {};
  const candidates = [
    ...list(value.citations), ...list(value.search_results), ...list(value.search_result),
    ...list(value.search_info?.search_results), ...list(value.web_search),
    ...list(grounding.groundingChunks || grounding.grounding_chunks).map(chunk => chunk.web),
  ];
  const sources = new Map();
  for (const [index, original] of candidates.entries()) {
    const source = typeof original === 'string' ? { url: original } : original;
    const url = searchUrl(source?.url || source?.link || source?.uri);
    if (!url) continue;
    const previous = sources.get(url);
    sources.set(url, { ...previous, ...source, url, title: source.title || previous?.title || url,
      index: Number.isSafeInteger(source.index) && source.index > 0 ? source.index : previous?.index ?? index + 1 });
  }
  return [...sources.values()];
}

export function searchCitationAnnotations(sources, text) {
  const annotations = [];
  for (const source of sources) {
    // Numbered citations are mapped only where the upstream actually put them.
    // A bare source list does not establish a character range in the answer.
    const marker = new RegExp('\\[(?:ref_)?' + source.index + '\\]', 'g');
    for (const match of text.matchAll(marker)) {
      annotations.push({ type: 'url_citation', url: source.url, title: source.title,
        start_index: match.index, end_index: match.index + match[0].length });
    }
  }
  return annotations;
}

export function chatSearchStyle({ base, metadata = {} }) {
  // https://www.alibabacloud.com/help/en/model-studio/web-search
  // https://docs.z.ai/guides/tools/web-search
  // https://docs.perplexity.ai/api-reference/chat-completions-post
  const parameters = [...list(metadata.supported_parameters),
    ...Object.keys(metadata.parameters?.properties || metadata.parameters || {}),
    ...Object.keys(metadata.parameter_schema?.properties || {})];
  const host = new URL(base).hostname.toLowerCase();
  if (parameters.includes('enable_search') || /(?:^|\.)(?:dashscope(?:-intl|-us)?\.aliyuncs\.com|maas\.aliyuncs\.com)$/.test(host)) return 'enable';
  if (host === 'open.bigmodel.cn' || host === 'api.z.ai') return 'zai';
  if (host === 'api.perplexity.ai') return 'builtin';
  if (parameters.includes('web_search_options') || host === 'api.openai.com') return 'options';
  return 'tools';
}

export function applyChatSearch(payload, gateway, settings = {}) {
  const webIndex = payload.tools?.findIndex(tool => ['web_search', 'web_search_preview'].includes(tool.type)) ?? -1;
  if (webIndex < 0) return payload;
  const style = chatSearchStyle(gateway);
  if (style === 'tools') return payload;
  const web = structuredClone(payload.tools[webIndex]);
  const result = { ...payload, tools: payload.tools.map((tool, index) => index === webIndex ? web : tool) };
  if ([false, 'cached', 'indexed'].includes(settings.external_web_access)) {
    throw Object.assign(new Error('This Chat search protocol cannot represent cache-only web access.'),
      { status: 400, code: 'unsupported_search_setting' });
  }
  if (style === 'zai') {
    web.web_search = { enable: true, search_result: true, ...web.web_search };
  } else {
    result.tools = result.tools.filter(tool => tool !== web);
    if (!result.tools.length) delete result.tools;
    if (style === 'enable') result.enable_search ??= true;
    if (style === 'options') {
      result.web_search_options = { ...result.web_search_options };
      for (const key of ['search_context_size', 'user_location']) {
        if (settings[key] !== undefined) result.web_search_options[key] ??= structuredClone(settings[key]);
      }
    }
    if (style === 'builtin' && settings.filters?.allowed_domains?.length) {
      result.search_domain_filter ??= [...settings.filters.allowed_domains];
    }
  }
  if (['web_search', 'web_search_preview'].includes(result.tool_choice?.type)) delete result.tool_choice;
  return result;
}
