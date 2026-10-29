import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { CONTEXT_CAP, reportedCapacity, tokenCount, contextKey, rememberContexts, applyContext } from '../src/model-context.mjs';

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-context-'));
const file = path.join(fixture, 'context.json'), base = 'https://gateway.invalid/v1';
try {
  assert.equal(CONTEXT_CAP, 500000);
  assert.equal(tokenCount('1M'), 1000000); assert.equal(tokenCount('256k'), 256000);
  for (const bad of [0, -1, Infinity, 'unlimited', {}, '128K tokens', 1.5]) assert.equal(tokenCount(bad), null);
  assert.equal(reportedCapacity({ context_length: 1000000, max_model_len: 32768 }), 32768);
  assert.equal(reportedCapacity({ max_output_tokens: 8192, max_tokens: 16384 }), null);
  assert.equal(reportedCapacity({ architecture: { context_length: 131072 } }), 131072);
  assert.equal(contextKey(base + '/', 'model'), contextKey(base, 'model'));
  const known = { models: { large: { tokens: 1000000, source: 'official-fixture' } } };
  const models = [{ id: 'Vendor/small', context_length: 64000 }, { id: 'Vendor/large' },
    { id: 'GPT/gpt-fixture' }, { id: 'vllm/large', max_model_len: 32768 }];
  const official = [{ slug: 'gpt-fixture', context_window: 272000, max_context_window: 1000000 }];
  const originalOfficial = structuredClone(official);
  let cache = rememberContexts({ file, base, models, official, known });
  for (const [id, expected] of [['Vendor/small', 64000], ['Vendor/large', 500000], ['GPT/gpt-fixture', 500000], ['vllm/large', 32768]]) {
    const result = applyContext({ context_window: 272000, max_context_window: 872000, auto_compact_token_limit: 258400 }, cache.entries[contextKey(base, id)]);
    assert.equal(result.context_window, expected); assert.equal(result.max_context_window, expected);
    assert.equal(result.auto_compact_token_limit, null);
  }
  assert.deepEqual(official, originalOfficial);
  const stored = fs.readFileSync(file, 'utf8');
  cache = rememberContexts({ file, base, models: models.map(m => ({ ...m, context_length: 1234, max_model_len: 1234 })), official: [], known: {} });
  assert.equal(fs.readFileSync(file, 'utf8'), stored, 'Existing capacities must survive refresh, restart and credential rotation');
  assert.equal(cache.entries[contextKey(base, 'Vendor/small')].capacity, 64000);
  rememberContexts({ file, base, models: [...models, { id: 'new', context_length: 131072 }] });
  assert.equal(JSON.parse(fs.readFileSync(file)).entries[contextKey(base, 'new')].capacity, 131072);
  cache = rememberContexts({ file, base: 'https://other.invalid/v1', models: [{ id: 'Vendor/small', context_length: 16000 }] });
  assert.equal(cache.entries[contextKey('https://other.invalid/v1', 'Vendor/small')].capacity, 16000);
  assert.equal(cache.entries[contextKey(base, 'Vendor/small')].capacity, 64000);
  cache = rememberContexts({ file, base, models: [{ id: 'vllm/unknown' }], known });
  assert.equal(cache.entries[contextKey(base, 'vllm/unknown')].capacity, null);
  cache = rememberContexts({ file, base, models: [{ id: 'vllm/unknown', max_model_len: 8192 }] });
  assert.equal(cache.entries[contextKey(base, 'vllm/unknown')].capacity, 8192);
  const gptKnown = { models: { 'gpt-fixture': { tokens: 1000000, source: 'verified-specification' } } };
  const defaultCatalog = [{ slug: 'gpt-fixture', context_window: 272000 }];
  cache = rememberContexts({ file, base, models: [{ id: 'GPT/gpt-Fixture' }], official: defaultCatalog, known: gptKnown });
  assert.equal(cache.entries[contextKey(base, 'GPT/gpt-Fixture')].capacity, 1000000);
  assert.equal(applyContext({ context_window: 272000, effective_context_window_percent: 95 }, cache.entries[contextKey(base, 'GPT/gpt-Fixture')]).context_window * 0.95, 475000);
  const nativeKey = contextKey(base, 'GPT/gpt-fixture');
  cache.entries[nativeKey] = { capacity: 272000, source: 'native-model-catalog', checkedAt: 'old' };
  fs.writeFileSync(file, JSON.stringify(cache));
  cache = rememberContexts({ file, base, models: [{ id: 'GPT/gpt-fixture' }], official: defaultCatalog, known: gptKnown });
  assert.equal(cache.entries[nativeKey].capacity, 1000000, 'A native default window must not permanently constrain a known gateway model');
  const corrected = fs.readFileSync(file, 'utf8');
  rememberContexts({ file, base, models: [{ id: 'GPT/gpt-fixture' }], known: gptKnown });
  assert.equal(fs.readFileSync(file, 'utf8'), corrected, 'Cache correction runs only once');
  cache.entries[nativeKey] = { capacity: 128000, source: 'gateway-model-metadata' };
  fs.writeFileSync(file, JSON.stringify(cache));
  cache = rememberContexts({ file, base, models: [{ id: 'GPT/gpt-fixture' }], official: defaultCatalog, known: gptKnown });
  assert.equal(cache.entries[nativeKey].capacity, 128000, 'Do not inflate a real deployment limit');
  console.log(JSON.stringify({ passed: true, cap: CONTEXT_CAP, checks: ['actual deployment limits', 'one-time persistent capacities', 'new models only', 'separate URL namespaces', 'raw capacity retained', 'official metadata unchanged', 'native compaction defaults', 'unreported capacity is not fabricated'] }));
} finally { fs.rmSync(fixture, { recursive: true, force: true }); }
