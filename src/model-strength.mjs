// Catalog and cached probe results share the same capability representation.
import { isGptModel } from './history-compat.mjs';
export const PROBE_REASONING_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
export const strengthMetadataFields = ['supported_reasoning_levels', 'supported_reasoning_efforts', 'reasoning_efforts',
  'reasoning_effort_levels', 'thinking', 'thinking_config',
  'supported_complexity_levels', 'complexity_levels', 'supported_quality_levels', 'quality_levels',
  'reasoning', 'complexity', 'quality', 'parameters', 'parameter_schema'];
const ranks = { auto: -1, none: 0, off: 0, minimal: 1, low: 2, standard: 2, medium: 3, high: 4, hd: 4, xhigh: 5, max: 6, ultra: 7 };
export const validStrength = value => typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,31}$/i.test(value);
export function canRequestFast(model) {
  const id = model?._upstreamId || model?.id || model?.slug || '';
  if (!isGptModel(id) || /^gpt-image/i.test(id.split('/').at(-1)) || model?.type === 'image') return false;
  if (Object.hasOwn(model, 'service_tiers')) return Array.isArray(model.service_tiers) && model.service_tiers.some(tier => ['priority', 'fast'].includes(tier?.id));
  if (Object.hasOwn(model, 'additional_speed_tiers')) return Array.isArray(model.additional_speed_tiers) && model.additional_speed_tiers.includes('fast');
  return true;
}
const unknown = () => ({ status: 'unknown', levels: [], highest: null, source: '' });
export function strengthLevels(value, source) {
  if (value === false) return { status: 'unsupported', levels: [], highest: null, source };
  const values = Array.isArray(value) ? value : value?.enum ?? value?.levels ?? value?.supported_levels ?? value?.supported_efforts;
  if (!Array.isArray(values) || values.length > 32) return null;
  const levels = [...new Set(values.map(item => typeof item === 'string' ? item : item?.effort ?? item?.value ?? item?.level))];
  if (levels.some(level => !validStrength(level))) return null;
  const ordered = levels.every(level => Object.hasOwn(ranks, level.toLowerCase()));
  if (ordered) levels.sort((a, b) => ranks[a.toLowerCase()] - ranks[b.toLowerCase()]);
  return { status: levels.length ? 'known' : 'unsupported', levels, highest: ordered ? levels.at(-1) || null : null, source };
}
function reported(model, kind) {
  const keys = kind === 'reasoning' ? ['supported_reasoning_levels', 'supported_reasoning_efforts', 'reasoning_efforts', 'reasoning_effort_levels']
    : ['supported_' + kind + '_levels', kind + '_levels'];
  const objects = [model, model?.model_info, model?.capabilities, model?.capabilities?.image_generation,
    model?.parameters, model?.parameters?.properties, model?.parameter_schema?.properties];
  for (const object of objects) {
    if (!object || typeof object !== 'object') continue;
    const efforts = kind === 'reasoning' && object.thinking_config?.enabled?.efforts;
    for (const value of [...keys.map(key => object[key]), kind === 'reasoning' ? object.reasoning?.effort : undefined,
      object[kind], ...(kind === 'reasoning' ? [object.reasoning_effort, object['reasoning.effort'], object.thinking,
        efforts && typeof efforts === 'object' && !Array.isArray(efforts) ? Object.keys(efforts) : efforts] : [])]) {
      const result = strengthLevels(value, 'catalog'); if (result) return result;
    }
  }
  return null;
}
function documentedImage(id, kind) {
  // Deployment-specific vLLM settings cannot be inferred from a shared name.
  if (/^vllm\//i.test(id)) return null;
  const leaf = id.split('/').at(-1).toLowerCase();
  const previous = ['gpt-image-1', 'gpt-image-1-mini', 'gpt-image-1.5', 'gpt-image-2'].includes(leaf);
  const v25 = /^gpt-image-2\.5-(?:sunburst|flare)$/.test(leaf);
  const v26 = /^gpt-image-2\.6-(?:sunburst|flare)$/.test(leaf);
  if (!previous && !v25 && !v26) return null;
  const values = kind === 'complexity' ? v26 ? ['low', 'medium', 'high'] : false
    : kind === 'quality' ? previous ? ['auto', 'low', 'medium', 'high'] : ['auto', 'low', 'medium', 'high', 'xhigh', 'max'] : undefined;
  const result = strengthLevels(values, 'documentation');
  return result && { ...result, sourceUrl: 'https://developers.openai.com/api/docs/guides/image-generation' };
}
export function modelStrengths(model, official = [], saved = model._probedStrengths || {}, overrides = model._strengthOverrides || {}) {
  const id = model._upstreamId || model.id || model.slug || '';
  const native = !/^vllm\//i.test(id) && /^gpt(?:-|\d)/i.test(id.split('/').at(-1))
    ? official.find(item => item.slug?.toLowerCase() === id.split('/').at(-1).toLowerCase()) : null;
  const declaredReasoning = reported(model, 'reasoning');
  const nativeReasoning = native && reported(native, 'reasoning');
  let reasoning = nativeReasoning ? { ...nativeReasoning, source: 'native-catalog' } : declaredReasoning;
  if (!reasoning && !/^vllm\//i.test(id)) {
    const leaf = id.split('/').at(-1).toLowerCase();
    if (['gpt-6.2-astra', 'gpt-6.2-sol'].includes(leaf)) reasoning = {
      ...strengthLevels(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], 'documentation'),
      sourceUrl: 'https://github.com/openai/codex/blob/main/codex-rs/models-manager/models.json',
    };
    const withNone = ['gpt-6-sol', 'gpt-6-luna', 'gpt-6.1-terra'].includes(leaf);
    if (withNone || ['gpt-6-astra', 'gpt-6.1-sol'].includes(leaf)) reasoning = {
      ...strengthLevels([...(withNone ? ['none'] : []), 'low', 'medium', 'high', 'xhigh', 'max'], 'documentation'),
      sourceUrl: 'https://developers.openai.com/api/docs/guides/reasoning',
    };
  }
  const result = {
    reasoning: reasoning || unknown(),
    complexity: reported(model, 'complexity') || documentedImage(id, 'complexity') || unknown(),
    quality: reported(model, 'quality') || documentedImage(id, 'quality') || unknown(),
  };
  for (const field of ['reasoning', 'complexity', 'quality']) {
    if (result[field].status === 'unknown' && saved[field]) result[field] = saved[field];
    if (field === 'reasoning' && ['probe', 'probe-confirmed'].includes(result[field].source)) {
      result[field] = unknown();
    }
    if (field === 'reasoning' && !isGptModel(id) && result[field].status === 'known') {
      result[field] = strengthLevels(result[field].levels.filter(level => PROBE_REASONING_LEVELS.includes(level)), result[field].source);
    }
    if (overrides[field]) result[field] = strengthLevels(overrides[field], 'manual');
  }
  return result;
}
export function selectedStrength(capability, configured) {
  return capability?.status === 'known' ? capability.levels.includes(configured) ? configured : capability.highest : null;
}
export function applyImageStrengths(payload, model, selection = {}, native = false) {
  const capabilities = modelStrengths(model);
  for (const field of ['complexity', 'quality']) {
    const capability = capabilities[field], selected = selectedStrength(capability, selection[field]);
    if (native && (field === 'complexity' || payload[field] == null || payload[field] === 'auto')) {
      // Built-in image_gen exposes no intensity argument. Its defaults belong
      // to its original model, not to the API model selected by this launcher.
      // Preserve an explicit quality when a native client supplies one.
      if (field === 'complexity' || capability.status !== 'unknown') delete payload[field];
      if (selected != null) payload[field] = selected;
    } else if (payload[field] == null) {
      if (selected != null) payload[field] = selected;
    } else if (capability.status !== 'unknown' && !capability.levels.includes(payload[field])) {
      throw Object.assign(new Error('Selected image model does not support ' + field + '=' + payload[field] + '.'),
        { status: 400, code: 'unsupported_image_strength' });
    }
  }
  return payload;
}
