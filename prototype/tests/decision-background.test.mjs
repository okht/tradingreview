import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEvidence, validateContext } from '../server/contracts.js';
import { createReviewTools } from '../server/review-tools.js';
import { cleanWorkspace } from '../server/storage.js';
import { createWorkspace, readWorkspace, validateWorkspace, WORKSPACE_KEY } from '../src/agent-workspace-state.js';
import { conversationContext, conversationScopeKey } from '../src/agent-conversation-state.js';

const trade = { id: 'REAL-NOTE-1', symbol: '600001', name: '背景测试标的', time: '2025-09-02T09:45', side: 'buy', quantity: 100, price: 40, fee: 5 };
const hidden = { reason: '隐藏的理由草稿', plan: '隐藏的计划草稿', unknown: true, noPlan: true, source: '现在回忆', reference: '历史笔记出处', recordedAt: '2026-10-21T10:55:00.123Z' };
const context = note => ({ trades: [trade], contexts: { [trade.id]: note }, marketMode: 'import', origin: '测试成交' });
function workspace(note = hidden) {
  const state = createWorkspace();
  Object.assign(state.conversations[0], context({ ...note }), { selectedIds: [trade.id] });
  return state;
}

test('background flags and hidden drafts survive local and server persistence and can be restored', () => {
  const state = cleanWorkspace(workspace());
  const restored = readWorkspace({ getItem: key => key === WORKSPACE_KEY ? JSON.stringify(state) : null });
  assert.deepEqual(validateWorkspace(restored), state);
  const note = restored.conversations[0].contexts[trade.id];
  for (const [key, value] of Object.entries(hidden)) assert.equal(note[key], value);
  note.unknown = false; note.noPlan = false;
  const active = conversationContext(restored.conversations[0]).contexts[trade.id];
  assert.equal(active.reason, hidden.reason);
  assert.equal(active.plan, hidden.plan);
  assert.equal(active.reference, hidden.reference);
  assert.equal(active.recordedAt, hidden.recordedAt);
});

test('older notes keep working and noPlan accepts only explicit booleans', () => {
  const old = { reason: '旧理由', plan: '', source: '当时记录' };
  assert.equal(validateContext(context(old)).contexts[trade.id].noPlan, undefined);
  assert.equal(validateContext(context({ ...old, noPlan: false })).contexts[trade.id].noPlan, false);
  for (const value of ['true', 1, null, {}]) assert.throws(() => validateContext(context({ ...old, noPlan: value })), /noPlan 必须为布尔值/);
});

test('analysis context strips inactive reason and plan drafts without mutating storage or provenance', () => {
  const state = workspace();
  const payload = conversationContext(state.conversations[0]);
  const note = payload.contexts[trade.id];
  assert.equal(note.reason, ''); assert.equal(note.plan, '');
  assert.equal(note.unknown, true); assert.equal(note.noPlan, true);
  assert.equal(note.source, hidden.source); assert.equal(note.reference, hidden.reference); assert.equal(note.recordedAt, hidden.recordedAt);
  assert.equal(state.conversations[0].contexts[trade.id].reason, hidden.reason);
  assert.equal(state.conversations[0].contexts[trade.id].plan, hidden.plan);
});

test('explicit no-plan evidence differs from missing input, including a note with no other content', async () => {
  const explicit = buildEvidence(context({ noPlan: true })).find(item => item.type === 'background');
  assert.match(explicit.text, /用户表示当时没有计划/);
  assert.doesNotMatch(explicit.text, /计划：未补充/);
  assert.equal(explicit.tradeId, trade.id);
  const missing = buildEvidence(context({ reason: '记得当时看过资料', plan: '' })).find(item => item.type === 'background');
  assert.match(missing.text, /计划：未补充/);
  const tools = createReviewTools(context(hidden));
  const result = await tools.find(tool => tool.name === 'read_evidence').execute('test-no-plan', {});
  const evidence = result.details.evidence.find(item => item.type === 'background');
  assert.match(evidence.text, /记不清当时的理由/);
  assert.match(evidence.text, /用户表示当时没有计划/);
  assert.equal(evidence.timeClass, 'recollection');
  assert.equal(evidence.recordedAt, hidden.recordedAt);
  assert.ok(!JSON.stringify(result).includes(hidden.reason));
  assert.ok(!JSON.stringify(result).includes(hidden.plan));
});

test('no-plan changes invalidate an analysis scope even when the plan text is already empty', () => {
  const state = workspace({ reason: '理由已补充', plan: '', source: '现在回忆' });
  const conversation = state.conversations[0];
  const before = conversationScopeKey(conversation, null);
  conversation.contexts[trade.id].noPlan = false;
  assert.equal(conversationScopeKey(conversation, null), before);
  conversation.contexts[trade.id].noPlan = true;
  assert.notEqual(conversationScopeKey(conversation, null), before);
});
