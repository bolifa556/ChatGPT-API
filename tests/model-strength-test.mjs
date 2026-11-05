import assert from 'node:assert/strict';
import { modelStrengths, applyImageStrengths } from '../src/model-strength.mjs';
import { normalizeSettings, overrideKey } from '../src/settings.mjs';

const current = { id: 'GPT/gpt-image-2.6-sunburst' }, previous = { id: 'GPT/gpt-image-2.5-flare' };
assert.deepEqual(modelStrengths(current).complexity.levels, ['low', 'medium', 'high']);
assert.equal(modelStrengths(current).complexity.highest, 'high');
assert.equal(modelStrengths(current).quality.highest, 'max');
assert.equal(modelStrengths(previous).complexity.status, 'unsupported');
assert.equal(modelStrengths({ id: 'gpt-image-2' }).quality.highest, 'high');
for (const id of ['image-alias', 'vllm/gpt-image-2.6-sunburst', 'custom-gpt-image-2.6-sunburst']) {
  assert.equal(modelStrengths({ id }).complexity.status, 'unknown');
}
const declared = { ...current, supported_complexity_levels: ['medium', 'low'], quality: { enum: ['auto', 'medium'] } };
assert.deepEqual(modelStrengths(declared).complexity.levels, ['low', 'medium']);
assert.equal(modelStrengths(declared).quality.highest, 'medium');
assert.equal(modelStrengths({ ...current, complexity: false }).complexity.status, 'unsupported');
assert.equal(modelStrengths({ id: 'custom', reasoning: true }).reasoning.status, 'unknown');
assert.deepEqual(modelStrengths({ id: 'custom', supported_reasoning_levels: [{ effort: 'high' }, { effort: 'low' }] }).reasoning.levels, ['low', 'high']);
assert.deepEqual(modelStrengths({ id: 'custom', parameters: { properties: { reasoning_effort: { enum: ['medium', 'high'] } } } }).reasoning.levels, ['medium', 'high']);
const native = [{ slug: 'gpt-6-sol', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }] }];
assert.equal(modelStrengths({ id: 'GPT/gpt-6-sol' }, native).reasoning.source, 'native-catalog');
assert.equal(modelStrengths({ id: 'GPT/gpt-6-sol' }).reasoning.source, 'documentation');
assert.equal(modelStrengths({ id: 'vllm/gpt-6-sol' }, native).reasoning.status, 'unknown');
assert.equal(modelStrengths({ id: 'GPT/gpt-6-sol', reasoning: false }, native).reasoning.status, 'unsupported');
assert.equal(modelStrengths({ id: 'custom', quality: { enum: ['balanced', 'detailed'] } }).quality.highest, null, 'Unknown ordering must not invent a maximum');

const original = { prompt: 'Unchanged prompt', images: [{ image_url: 'data:image/png;base64,aW5lcnQ=' }], complexity: 'max', quality: 'auto' };
const converted = applyImageStrengths(structuredClone(original), current, {}, true);
assert.deepEqual(converted, { ...original, complexity: 'high', quality: 'max' });
assert.equal(original.complexity, 'max');
assert.deepEqual(applyImageStrengths(structuredClone(original), current, { complexity: 'low', quality: 'medium' }, true), { ...original, complexity: 'low', quality: 'medium' });
assert.equal(applyImageStrengths({}, declared, { complexity: 'high' }, true).complexity, 'medium', 'Stale selection must use the current supported maximum');
const older = applyImageStrengths(structuredClone(original), previous, {}, true);
assert.equal(older.complexity, undefined); assert.equal(older.quality, 'max');
const unknown = applyImageStrengths(structuredClone(original), { id: 'custom-image' }, {}, true);
assert.equal(unknown.complexity, undefined); assert.equal(unknown.quality, 'auto');
assert.equal(applyImageStrengths({ complexity: 'low', quality: 'high' }, current, { complexity: 'high', quality: 'max' }, false).complexity, 'low');
assert.throws(() => applyImageStrengths({ complexity: 'max' }, current, {}, false), error => error.status === 400 && error.code === 'unsupported_image_strength');
assert.equal(applyImageStrengths({ complexity: 'max' }, { id: 'custom-image' }, {}, false).complexity, 'max');
const key = overrideKey('default', 'same-name'), second = overrideKey('p_12345678', 'same-name');
const baseline = { version: 1, providers: [{ id: 'default', baseUrl: 'https://example.invalid', apiKey: 'fixture' },
  { id: 'p_12345678', baseUrl: 'https://second.invalid', apiKey: 'fixture' }], imageStrengths: { [key]: { complexity: 'low' }, [second]: { quality: 'max' } } };
const normalized = normalizeSettings(baseline);
assert.deepEqual(normalized.imageStrengths, baseline.imageStrengths);
assert.equal(normalized.imageRouting, 'official');
assert.equal(normalizeSettings({ ...baseline, defaultImageModel: { providerId: 'default', modelId: 'same-name' } }).imageRouting, 'custom');
assert.equal(normalizeSettings({ ...baseline, imageRouting: 'official', defaultImageModel: { providerId: 'default', modelId: 'same-name' } }).imageRouting, 'official');
assert.throws(() => normalizeSettings({ ...baseline, imageRouting: 'unexpected' }));
assert.deepEqual(normalizeSettings({ ...baseline, imageStrengths: undefined }, normalized).imageStrengths, baseline.imageStrengths);
assert.deepEqual(normalizeSettings({ ...baseline, imageStrengths: {} }, normalized).imageStrengths, {});
assert.throws(() => normalizeSettings({ ...baseline, imageStrengths: { [key]: { temperature: 1 } } }));
assert.throws(() => normalizeSettings({ ...baseline, imageStrengths: { [key]: { complexity: 'high\nmodel=other' } } }));
console.log(JSON.stringify({ passed: true, checks: ['declared levels override exact documented specifications', 'unknown capabilities stay unknown', 'native image defaults use independent supported maxima', 'manual selections and separate API sources preserved', 'unsupported native complexity omitted', 'explicit API parameters preserved or rejected before forwarding'] }));
