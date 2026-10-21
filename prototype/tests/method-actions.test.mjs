import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspace, validateWorkspace } from '../src/agent-workspace-state.js';
import { METHOD_TITLE_LIMIT, methodTitleError, renameSavedMethod, deleteSavedMethod } from '../src/method-actions.js';
import { validateMethod } from '../server/strategy-engine.js';
import { validateResearch, saveMethodVersion } from '../src/research-state.js';

function workspace() {
  const state = createWorkspace();
  state.methods = ['one', 'two'].map(id => validateMethod({ id, title: '同名方法', rules: { kind: 'trend', lookback: 5 } }));
  const research = validateResearch({ methods: state.methods, batch: { results: [{ methodId: 'one', metrics: { returnPct: 5 } }] } });
  state.conversations[0].research = structuredClone(research);
  state.conversations[0].messages = [{ id: 'answer', role: 'assistant', text: '历史分析原文', research }];
  return validateWorkspace(state);
}

test('method rename updates the selected ID in the library and every research card without changing historical prose or rules', () => {
  const state = workspace(), before = structuredClone(state);
  const renamed = renameSavedMethod(state, 'one', '  我的均线方法  ');
  assert.equal(renamed.methods[0].title, '我的均线方法');
  assert.equal(renamed.methods[1].title, '同名方法');
  assert.equal(renamed.conversations[0].research.methods[0].title, '我的均线方法');
  assert.equal(renamed.conversations[0].messages[0].research.methods[0].title, '我的均线方法');
  assert.equal(renamed.conversations[0].messages[0].text, '历史分析原文');
  assert.deepEqual(renamed.methods[0].rules, state.methods[0].rules);
  assert.deepEqual(renamed.conversations[0].research.batch, state.conversations[0].research.batch);
  assert.deepEqual(state, before);
  assert.deepEqual(validateWorkspace(JSON.parse(JSON.stringify(renamed))), renamed);
});

test('method names reject empty, oversized and stale targets', () => {
  const state = workspace();
  for (const title of ['', ' \n ', null, '长'.repeat(METHOD_TITLE_LIMIT + 1)]) assert.throws(() => renameSavedMethod(state, 'one', title));
  assert.throws(() => renameSavedMethod(state, 'missing', '名称'), /已不存在/);
  assert.equal(methodTitleError('长'.repeat(METHOD_TITLE_LIMIT)), '');
});

test('deleting a method only removes its library entry and allows explicit resaving from historical research', () => {
  const state = workspace(), before = structuredClone(state);
  const removed = deleteSavedMethod(state, 'one');
  assert.deepEqual(removed.methods.map(item => item.id), ['two']);
  assert.deepEqual(removed.conversations, state.conversations);
  assert.deepEqual(removed.savedItems, state.savedItems);
  assert.deepEqual(state, before);
  const resaved = saveMethodVersion(removed.methods, removed.conversations[0].research.methods[0]);
  assert.deepEqual(resaved.map(item => item.id), ['two', 'one']);
  assert.deepEqual(validateWorkspace(JSON.parse(JSON.stringify(removed))), removed);
  assert.throws(() => deleteSavedMethod(removed, 'one'), /已不存在/);
});
