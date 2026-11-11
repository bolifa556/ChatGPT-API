import assert from 'node:assert/strict';
import { getRoot, setRoot, getTable, setTable, tomlMask } from '../src/toml-edit.mjs';
import { restoreRootLine } from '../src/gateway-recovery.mjs';

const checks = [];
for (const newline of ['\n', '\r\n']) for (const delimiter of ['"""', "'''", '""""', "''''"]) {
  const open = delimiter.slice(0, 3), close = delimiter;
  const instruction = ['developer_instructions = ' + open,
    'Keep every character: 中文 $HOME \\ path', 'model_provider = "instruction-example"',
    '[model_providers.chatgpt_api_launcher]', 'model = "instruction-model"', close].join(newline) + newline;
  const original = instruction + '# model_provider = "comment-example"' + newline +
    'values = [' + newline + '  [1, 2],' + newline + '  [3, 4]' + newline + ']' + newline +
    '"model_provider" = "openai"' + newline + 'model = "original-model"' + newline +
    '[model_providers.chatgpt_api_launcher]' + newline + 'name = "original"' + newline +
    'description = """' + newline + '[fake-table]' + newline + 'literal = "unchanged"' + newline + '"""' + newline +
    '[desktop]' + newline + 'locale = "zh-CN"' + newline;
  const provider = getRoot(original, 'model_provider');
  assert.equal(provider, '"model_provider" = "openai"' + newline);
  assert.equal(getRoot(original, 'model'), 'model = "original-model"' + newline);
  const changed = setRoot(original, 'model_provider', 'model_provider = "launcher"' + newline);
  assert(changed.startsWith(instruction), 'An original instruction was edited');
  assert.equal(setRoot(changed, 'model_provider', provider), original);
  const table = getTable(original, 'model_providers.chatgpt_api_launcher');
  assert(table.includes('[fake-table]') && !table.includes('[desktop]'));
  const replaced = setTable(original, 'model_providers.chatgpt_api_launcher', '[model_providers.chatgpt_api_launcher]' + newline + 'name = "temporary"' + newline);
  assert(replaced.startsWith(instruction));
  assert.equal(setTable(replaced, 'model_providers.chatgpt_api_launcher', table), original);
  const missing = setRoot(original, 'model_provider', '');
  assert.equal(restoreRootLine(missing, 'model_provider', provider, original), original);
  assert.equal(tomlMask(original).length, original.length);
  checks.push(newline === '\n' ? delimiter : 'CRLF/' + delimiter);
}
console.log(JSON.stringify({ passed: true, checks }));
