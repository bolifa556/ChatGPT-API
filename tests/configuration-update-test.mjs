import assert from 'node:assert/strict';
import { normalizeGptHistory, normalizeOfficialHistory } from '../src/history-compat.mjs';
import { NonGptAdapter } from '../src/non-gpt-compat.mjs';
import { chatRequest, usesChat } from '../src/chat-compat.mjs';

const schema = { type: 'json_schema', name: 'existing_format', strict: true, schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false } };
const history = [
  { role: 'user', content: 'Original question 中文\n' },
  { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'Original answer', annotations: [] }] },
  { type: 'configuration_update', reasoning: { effort: 'high' } },
  { type: 'configuration_update', text: { format: schema } },
  { type: 'configuration_update', reasoning: { effort: 'medium' } },
  { role: 'user', content: 'Original follow-up' },
];
const original = { model: 'GPT/gpt-6-astra', reasoning: { effort: 'low', summary: 'auto' }, text: { verbosity: 'low', format: { type: 'text' } }, input: history };
const snapshot = JSON.stringify(original);
assert.equal(normalizeOfficialHistory(original).payload, original);
assert.equal(normalizeGptHistory(original).payload, original);
for (const model of ['阿里云订阅/glm-5.3', '词元计划/glm-5.3', 'vllm/local-model', 'Other/model']) {
  const result = new NonGptAdapter({ ...original, model }).request();
  assert.deepEqual(result.input, history.filter(item => item.type !== 'configuration_update'));
  assert.deepEqual(result.reasoning, { effort: 'medium', summary: 'auto' });
  assert.deepEqual(result.text, { verbosity: 'low', format: schema });
  if (model.startsWith('阿里云订阅/') || model.startsWith('词元计划/')) {
    assert(usesChat(result));
    const chat = chatRequest(result);
    assert.equal(chat.reasoning_effort, 'medium');
    assert.deepEqual(chat.response_format.json_schema.schema, schema.schema);
    assert.equal(chat.messages.at(-1).content, 'Original follow-up');
  }
  const reset = new NonGptAdapter({ ...original, model, input: [...history, { type: 'configuration_update', text: { format: { type: 'text' } } }] }).request();
  assert.deepEqual(reset.text.format, { type: 'text' });
  assert.equal(reset.reasoning.effort, 'medium');
  const future = { ...original, model, input: [{ type: 'configuration_update', future_field: true }] };
  assert.throws(() => new NonGptAdapter(future).request(), error => error.code === 'unsupported_configuration_update');
  const resetEffort = new NonGptAdapter({ ...original, model, input: [{ type: 'configuration_update', reasoning: { effort: null } }] }).request();
  assert.equal(resetEffort.reasoning.effort, null);
}
assert.equal(JSON.stringify(original), snapshot);
console.log(JSON.stringify({ passed: true, checks: ['Official/GPT configuration items retain positions, fields and request-level cache baseline', 'Non-GPT routes use the last native configuration values at request level without adding messages', 'Structured-output routing follows the effective format, including a later reset', 'Unknown configuration fields fail explicitly; canonical input stays unchanged'] }, null, 2));
