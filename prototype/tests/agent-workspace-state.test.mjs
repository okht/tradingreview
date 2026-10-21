import test from 'node:test';
import assert from 'node:assert/strict';
import { WORKSPACE_KEY, WORKSPACE_LIMITS, createConversation, createWorkspace, migrateJourney, readWorkspace, validateWorkspace } from '../src/agent-workspace-state.js';
import { createJourney, JOURNEY_KEY } from '../src/journey-state.js';
import { modelIdentity } from '../src/model-connection.js';
import { buildLiveContext, liveContextKey } from '../src/live-chat-state.js';
import { automaticWorkspaceRestore, inspectWorkspace, restoreWorkspaceSnapshot, sameWorkspace, workspaceCanSave, workspaceSnapshot } from '../src/useWorkspaceSync.js';
import { cleanWorkspace, MemoryStore } from '../server/storage.js';

const metadata = { mode: 'live', provider: 'openai', model: 'test-model', auth: 'api' };
const trade = { id: 'REAL-1', symbol: '600001', name: '用户标的', time: '2025-09-02T09:45', side: 'buy', quantity: 100, price: 40, fee: null };
const learning = { title: '保留依据', trigger: '下一次决定前', action: '记录来源与形成时间', exception: '资料不足时待确认' };
const stamp = '2025-09-05T03:04:05.000Z';
const proof = { id: 'trade:REAL-1', tradeId: 'REAL-1', type: 'trade', title: '成交记录', text: '用户记录买入 100 股。', source: '用户 CSV', publishedAt: trade.time, recordedAt: null, timeClass: 'before' };
function realWorkspace() {
  const workspace = createWorkspace(); workspace.model = { ...metadata };
  Object.assign(workspace.conversations[0], { trades: [{ ...trade }], selectedIds: [trade.id], origin: '用户 CSV', contexts: { [trade.id]: { reason: '我记得参考了公告', plan: '', source: '现在回忆', unknown: false } } });
  return workspace;
}
function realLegacy() {
  const state = { ...createJourney(), reviewId: 'legacy-review', model: { ...metadata }, marketMode: 'import', origin: '用户 CSV', trades: [{ ...trade }], selectedIds: [trade.id], question: '核对买入依据',
    liveReviewChat: { version: 1, messages: [{ id: 'live-opening', role: 'assistant', text: '旧界面引导', refs: [], suggestions: [] }, { id: 'answer-1', role: 'assistant', text: '保留来源与时间。', refs: [], suggestions: [], learning: { ...learning, analysisRunId: 'run-real', evidenceIds: [proof.id] }, evidenceIds: [proof.id] }], evidence: [proof], draft: '尚未发送的真实问题', lastRequest: null },
    savedItems: [{ ...learning, id: 'saved-real', reviewId: 'legacy-review', analysisRunId: 'run-real', evidenceIds: [proof.id], savedAt: stamp }, { ...learning, id: 'unknown-source', reviewId: 'legacy-review', savedAt: stamp }, { ...learning, id: 'older-review', reviewId: 'other-review', analysisRunId: 'run-real', savedAt: stamp }] };
  state.liveReviewChat.contextKey = liveContextKey(buildLiveContext(state, state.trades));
  return state;
}

test('new workspace contains one empty real conversation and no demo model or prewritten dialogue', () => {
  const state = createWorkspace();
  assert.equal(state.version, 2); assert.equal(state.model, null); assert.equal(state.conversations.length, 1);
  assert.equal(state.activeId, state.conversations[0].id);
  assert.equal(state.conversations[0].marketMode, 'import');
  assert.deepEqual(state.conversations[0].trades, []); assert.deepEqual(state.conversations[0].messages, []);
  assert.deepEqual(validateWorkspace(state), state);
  assert.notEqual(createConversation().id, state.activeId);
});

test('identical saved workspaces resume without a redundant conflict choice', () => {
  const state = realWorkspace();
  assert.equal(sameWorkspace(state, JSON.parse(JSON.stringify(state))), true);
  const changed = structuredClone(state); changed.conversations[0].draft = 'changed';
  assert.equal(sameWorkspace(state, changed), false);
  assert.equal(sameWorkspace(state, null), false);
});

test('unused v2 tabs restore a validated remote workspace regardless of generated conversation IDs', () => {
  const local = createWorkspace(); const remote = realWorkspace();
  local.conversations.push(createConversation());
  assert.equal(sameWorkspace(local, remote), false);
  const restored = automaticWorkspaceRestore(local, remote);
  assert.deepEqual(restored, validateWorkspace(remote));
  assert.equal(local.model, null); assert.equal(local.conversations[0].trades.length, 0);
  assert.notEqual(restored, remote);
  assert.deepEqual(automaticWorkspaceRestore(createWorkspace(), createWorkspace())?.version, 2);
  assert.equal(automaticWorkspaceRestore(local, { ...remote, activeId: 'missing' }), null);
  assert.equal(automaticWorkspaceRestore(local, realLegacy()), null);
});

test('any local material or prior use preserves explicit remote selection', () => {
  const mutations = [
    state => { state.model = metadata; },
    state => { state.savedItems = [{ ...learning, id: 'check-1' }]; },
    state => { state.conversations[0].title = '我的复盘'; },
    state => { state.conversations[0].draft = ' '; },
    state => { state.conversations[0].origin = '尚未完成的导入'; },
    state => { state.conversations[0].contextRevision = 1; },
    state => { state.conversations[0].trades = [{ ...trade }]; },
    state => { state.conversations[0].messages = [{ id: 'message-1', role: 'user', text: '请核对' }]; },
    state => { state.conversations[0].pendingTrades = { trades: [], questions: ['哪个标的？'], warnings: [], origin: '描述整理' }; },
    state => { state.conversations[0].lastRequest = { id: 'request-1', text: '未完成的问题' }; },
    state => { state.conversations[0].contexts = { orphan: { reason: '尚未关联交易的材料' } }; },
    state => { state.conversations[0].evidence = [{}]; },
    state => { state.conversations[0].marketData = {}; },
  ];
  for (const mutate of mutations) { const local = createWorkspace(); mutate(local); assert.equal(automaticWorkspaceRestore(local, realWorkspace()), null); }
});

test('a draft typed while server inspection is pending prevents automatic restore', async () => {
  const previous = globalThis.fetch; const local = createWorkspace(); let release;
  try {
    globalThis.fetch = () => new Promise(resolve => { release = resolve; });
    const inspection = inspectWorkspace({ live: true });
    local.conversations[0].draft = '刚输入的问题';
    release(new Response(JSON.stringify({ state: realWorkspace(), revision: 4 }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const result = await inspection;
    assert.equal(automaticWorkspaceRestore(local, result.pendingRemote), null);
    assert.equal(local.conversations[0].draft, '刚输入的问题');
  } finally { globalThis.fetch = previous; }
});

test('v2 allowlists nested fields and preserves real messages, snapshots and identity without credentials', () => {
  const state = realWorkspace(); state.apiKey = 'must-strip'; state.model.apiKey = 'must-strip'; state.config = { token: 'must-strip' };
  const conversation = state.conversations[0]; conversation.apiKey = 'must-strip'; conversation.contexts[trade.id].token = 'must-strip';
  conversation.messages = [{ id: 'answer-1', role: 'assistant', text: '请继续核对来源。', refs: [{ panel: 'evidence', label: '成交', tradeId: trade.id, evidenceId: proof.id, token: 'must-strip' }], suggestions: [{ id: 'q1', text: '补充背景', apiKey: 'must-strip' }], learning: { ...learning, secret: 'must-strip' }, analysisRunId: 'run-real', evidenceIds: [proof.id], evidence: [{ ...proof, authorization: 'must-strip' }], createdAt: stamp, contextRevision: 0, modelLabel: 'test-model', modelSignature: modelIdentity(metadata), arbitraryHtml: '<script>not stored</script>' }];
  conversation.lastRequest = { id: 'request-1', text: '核对资料', task: 'review', createdAt: stamp, contextRevision: 0, modelLabel: 'test-model', modelSignature: modelIdentity(metadata), apiKey: 'must-strip' };
  const clean = validateWorkspace(state);
  assert.ok(!JSON.stringify(clean).includes('must-strip')); assert.ok(!JSON.stringify(clean).includes('script'));
  assert.equal(clean.conversations[0].messages[0].evidence[0].id, proof.id);
  assert.equal(clean.conversations[0].messages[0].modelSignature, modelIdentity(metadata));
  assert.equal(clean.conversations[0].lastRequest.modelLabel, 'test-model');
  assert.equal(clean.conversations[0].trades[0].fee, null);
  state.conversations[0].messages[0].evidence[0].text = 'mutated'; assert.notEqual(clean.conversations[0].messages[0].evidence[0].text, 'mutated');
});

test('incomplete parse candidates remain a separate draft and are never promoted into confirmed trades', () => {
  const state = createWorkspace();
  state.conversations[0].pendingTrades = { trades: [{ id: 'AI-1', name: '', symbol: '', time: '', side: '', quantity: null, price: null, fee: null, token: 'drop' }], questions: ['哪一个标的？'], warnings: [], origin: '描述整理' };
  const clean = validateWorkspace(state);
  assert.deepEqual(clean.conversations[0].trades, []); assert.equal(clean.conversations[0].pendingTrades.trades[0].price, null);
  assert.ok(!JSON.stringify(clean).includes('drop'));
});

test('browser background edits retain ISO receipt timestamps including milliseconds through persistence', () => {
  const state = realWorkspace();
  state.conversations[0].contexts[trade.id].recordedAt = '2026-10-21T10:55:00.123Z';
  const clean = cleanWorkspace(state);
  assert.equal(clean.conversations[0].contexts[trade.id].recordedAt, '2026-10-21T10:55:00.123Z');
  assert.deepEqual(validateWorkspace(JSON.parse(JSON.stringify(clean))), clean);
});

test('invalid ownership links, versions, dates and sample data fail instead of resetting state', () => {
  const mutations = [
    state => { state.version = 1; }, state => { state.activeId = 'unknown'; },
    state => { state.conversations.push({ ...state.conversations[0] }); },
    state => { state.conversations[0].selectedIds = ['missing']; },
    state => { state.conversations[0].marketMode = 'sample'; },
    state => { state.conversations[0].trades[0].symbol = 'DEMO001'; },
    state => { state.model = { mode: 'demo' }; },
    state => { state.conversations[0].createdAt = '2025-02-30T00:00:00Z'; },
    state => { state.conversations[0].contextRevision = -1; },
    state => { state.conversations[0].messages = [{ id: 'x', role: 'system', text: 'no', refs: [], suggestions: [] }]; },
    state => { state.conversations[0].messages = [{ id: 'x', role: 'assistant', text: 'no', contextRevision: 1 }]; },
    state => { state.conversations[0].messages = [{ id: 'x', role: 'assistant', text: 'no', modelSignature: JSON.stringify(['live', 'openai', 'test-model', 'api', 'https://api.openai.com?key=secret']) }]; },
  ];
  for (const mutate of mutations) { const state = realWorkspace(); mutate(state); assert.throws(() => validateWorkspace(state), { status: 400 }); }
});

test('v2 conversation/message limits and UTF-8 byte limit are enforced', () => {
  const many = createWorkspace(); many.conversations = Array.from({ length: WORKSPACE_LIMITS.conversations + 1 }, createConversation); many.activeId = many.conversations[0].id;
  assert.throws(() => validateWorkspace(many), { status: 400 });
  const messages = createWorkspace(); messages.conversations[0].messages = Array.from({ length: 201 }, (_, index) => ({ id: `m${index}`, role: 'user', text: 'x' }));
  assert.throws(() => validateWorkspace(messages), { status: 400 });
  const large = createWorkspace(); large.conversations[0].messages = Array.from({ length: 40 }, (_, index) => ({ id: `m${index}`, role: 'user', text: '汉'.repeat(9000) }));
  assert.throws(() => validateWorkspace(large), { status: 413 });
});

test('legacy import migration keeps proven live content and discards untraceable saved examples', () => {
  const legacy = realLegacy(); const state = migrateJourney(legacy);
  assert.equal(state.model.mode, 'live'); assert.equal(state.conversations[0].trades[0].symbol, trade.symbol);
  assert.deepEqual(state.conversations[0].messages.map(item => item.id), ['answer-1']);
  assert.equal(state.conversations[0].draft, '尚未发送的真实问题');
  assert.equal(state.conversations[0].messages[0].evidence[0].id, proof.id);
  assert.deepEqual(state.savedItems.map(item => item.id), ['saved-real']);
  assert.equal(state.savedItems[0].conversationId, state.activeId);
  assert.equal(legacy.liveReviewChat.messages.length, 2);
});

test('migration excludes live chat from an old selection while preserving current imported records', () => {
  const legacy = realLegacy(); legacy.contexts = { [trade.id]: { reason: '已重新补充背景', source: '现在回忆', unknown: false } };
  const migrated = migrateJourney(legacy);
  assert.equal(migrated.conversations[0].trades.length, 1);
  assert.deepEqual(migrated.conversations[0].messages, []);
  assert.deepEqual(migrated.savedItems, []);
});

test('legacy sample material never enters the product while a valid real model identity can survive', () => {
  for (const change of [{ marketMode: 'sample' }, { trades: [{ ...trade, symbol: 'DEMO001' }] }, { origin: '账户示例' }]) {
    const migrated = migrateJourney({ ...realLegacy(), ...change });
    assert.equal(migrated.model.mode, 'live'); assert.deepEqual(migrated.conversations[0].trades, []); assert.deepEqual(migrated.savedItems, []); assert.deepEqual(migrated.conversations[0].messages, []);
  }
  const realImportInDemo = migrateJourney({ ...realLegacy(), model: { mode: 'demo' }, reviewChat: { messages: [{ text: '预设示例回答' }] } });
  assert.equal(realImportInDemo.model, null); assert.equal(realImportInDemo.conversations[0].trades.length, 1); assert.deepEqual(realImportInDemo.conversations[0].messages, []); assert.deepEqual(realImportInDemo.savedItems, []);
});

test('readWorkspace migrates read-only and a corrupted v2 key never falls back over the original', () => {
  const data = new Map([[JOURNEY_KEY, JSON.stringify(realLegacy())]]); const original = data.get(JOURNEY_KEY); const reads = [];
  const storage = { getItem(key) { reads.push(key); return data.get(key) ?? null; }, setItem() { assert.fail('must not write'); }, removeItem() { assert.fail('must not delete'); } };
  assert.equal(readWorkspace(storage).conversations[0].trades.length, 1); assert.equal(data.get(JOURNEY_KEY), original);
  data.set(WORKSPACE_KEY, '{bad'); reads.length = 0;
  assert.throws(() => readWorkspace(storage), { status: 400 }); assert.deepEqual(reads, [WORKSPACE_KEY]); assert.equal(data.get(WORKSPACE_KEY), '{bad');
  const valid = createWorkspace(); data.set(WORKSPACE_KEY, JSON.stringify(valid));
  assert.deepEqual(readWorkspace(storage), valid);
});

test('saved checks survive removal of their original conversation without leaking extra fields', () => {
  const state = createWorkspace();
  state.savedItems = [{ ...learning, id: 'saved-1', conversationId: 'removed-conversation', messageId: 'old-message', analysisRunId: 'old-run', evidenceIds: [proof.id], savedAt: stamp, apiKey: 'drop' }];
  const clean = validateWorkspace(state);
  assert.equal(clean.savedItems[0].conversationId, 'removed-conversation'); assert.ok(!JSON.stringify(clean).includes('drop'));
});

test('server storage accepts v2 without losing its version and rejects failed writes atomically', async () => {
  const store = new MemoryStore(); const state = realWorkspace();
  assert.equal(cleanWorkspace(state).version, 2);
  assert.deepEqual(await store.put('owner-a', state, 0), { revision: 1 });
  assert.deepEqual(await store.get('owner-b'), { state: null, revision: 0 });
  const invalid = { ...state, activeId: 'unknown' };
  await assert.rejects(store.put('owner-a', invalid, 1), { status: 400 });
  assert.deepEqual(await store.get('owner-a'), { state: validateWorkspace(state), revision: 1 });
  await assert.rejects(store.put('owner-a', state, 0), { status: 409 });
});

test('snapshot and remote restore preserve v2 and migrate only validated v1 records', () => {
  const state = realWorkspace(); state.model.apiKey = 'drop';
  assert.equal(workspaceSnapshot(state).version, 2); assert.ok(!JSON.stringify(workspaceSnapshot(state)).includes('drop'));
  assert.equal(restoreWorkspaceSnapshot(state).version, 2);
  assert.equal(restoreWorkspaceSnapshot(realLegacy()).conversations[0].trades.length, 1);
  assert.throws(() => restoreWorkspaceSnapshot({ version: 1, trades: [], savedItems: [] }), /未通过校验/);
  assert.throws(() => restoreWorkspaceSnapshot({ version: 3 }), /版本无效/);
});

test('paused sync does not inspect or allow writes and v2 can save before model setup', async () => {
  const prior = globalThis.fetch; let calls = 0;
  try {
    globalThis.fetch = async () => { calls++; throw new Error('should not call'); };
    const state = createWorkspace();
    assert.equal(workspaceCanSave(state, true, 0), true);
    assert.equal(workspaceCanSave(state, true, 0, { paused: true }), false);
    assert.deepEqual(await inspectWorkspace({ live: true, paused: true }), { revision: null, pendingRemote: null, ready: false, status: 'local' });
    assert.equal(calls, 0);
  } finally { globalThis.fetch = prior; }
});
