import test from 'node:test';
import assert from 'node:assert/strict';
import { createConversation, createWorkspace, validateWorkspace } from '../src/agent-workspace-state.js';
import { CONVERSATION_TITLE_LIMIT, conversationTitleError, deleteConversation, renameConversation } from '../src/conversation-actions.js';
import { validateMethod } from '../server/strategy-engine.js';

function workspace() {
  const state = createWorkspace();
  state.conversations.push(createConversation(), createConversation());
  state.conversations.forEach((item, index) => { item.title = `复盘 ${index + 1}`; item.draft = `保留草稿 ${index + 1}`; });
  return state;
}

test('renaming an inactive history entry targets its ID and preserves active conversation and material', () => {
  const state = workspace(), before = structuredClone(state), id = state.conversations[1].id;
  const renamed = renameConversation(state, id, '  月末复盘  ');
  assert.equal(renamed.activeId, state.activeId);
  assert.equal(renamed.conversations[1].title, '月末复盘');
  assert.equal(renamed.conversations[1].draft, state.conversations[1].draft);
  assert.deepEqual(renamed.conversations[0], state.conversations[0]);
  assert.deepEqual(state, before);
  assert.deepEqual(validateWorkspace(JSON.parse(JSON.stringify(renamed))), renamed);
});

test('history names reject empty, oversized, and missing-target edits', () => {
  const state = workspace();
  for (const name of ['', ' \n ', null, '长'.repeat(CONVERSATION_TITLE_LIMIT + 1)]) assert.throws(() => renameConversation(state, state.activeId, name));
  assert.throws(() => renameConversation(state, 'missing', '名称'), /已不存在/);
  assert.equal(conversationTitleError('长'.repeat(CONVERSATION_TITLE_LIMIT)), '');
});

test('deleting inactive history does not switch current conversation', () => {
  const state = workspace(), before = structuredClone(state), target = state.conversations[1];
  const removed = deleteConversation(state, target.id);
  assert.equal(removed.activeId, state.activeId);
  assert.deepEqual(removed.conversations.map(item => item.id), [state.conversations[0].id, state.conversations[2].id]);
  assert.deepEqual(state, before);
});

test('deleting current history opens the next neighbor, then previous when last in list', () => {
  for (const index of [0, 1, 2]) {
    const state = workspace(); state.activeId = state.conversations[index].id;
    const expected = state.conversations[index === 2 ? 1 : index + 1].id;
    const removed = deleteConversation(state, state.activeId);
    assert.equal(removed.activeId, expected);
    assert.ok(removed.conversations.some(item => item.id === removed.activeId));
  }
});

test('deleting the final conversation creates a valid empty conversation and retains independently saved material', () => {
  const state = createWorkspace(), sourceId = state.activeId;
  state.savedItems = [{ id: 'saved-check', conversationId: sourceId, title: '记录条件', trigger: '买入前', action: '记录退出条件', exception: '', savedAt: '2025-01-01T00:00:00.000Z' }];
  state.methods = [validateMethod({ id: 'saved-method', title: '均线法', rules: { kind: 'trend', lookback: 5 } })];
  const removed = deleteConversation(state, sourceId);
  assert.equal(removed.conversations.length, 1);
  assert.notEqual(removed.activeId, sourceId);
  assert.equal(removed.activeId, removed.conversations[0].id);
  assert.equal(removed.conversations[0].title, '新对话');
  assert.deepEqual(removed.conversations[0].messages, []);
  assert.deepEqual(removed.conversations[0].trades, []);
  assert.deepEqual(removed.savedItems, state.savedItems);
  assert.deepEqual(removed.methods, state.methods);
  assert.deepEqual(validateWorkspace(JSON.parse(JSON.stringify(removed))), removed);
  assert.throws(() => deleteConversation(removed, sourceId), /已不存在/);
});
