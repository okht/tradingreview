import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEvidence } from '../server/contracts.js';
import { createWorkspace, validateWorkspace } from '../src/agent-workspace-state.js';
import { acceptedSuggestionPatch, createPreparationController, preparationContext, preparationScopeKey, preparedResult, shouldAcceptSuggestion, suggestionText } from '../src/background-preparation-state.js';
import { runAgent, setFinancialConfig } from '../src/services/api.js';

const model = { mode: 'live', provider: 'openai', auth: 'oauth', model: 'model-test' };
const trade = { id: 'T1', name: '浦发银行', symbol: '600000', time: '2025-09-02T09:45', side: 'buy', quantity: 100, price: 12, fee: 5 };
const note = { tradeId: 'T1', reason: '先建立仓位，观察后续走势。', plan: '分批投入，并在后续调整前核对持仓与预算。', basis: '根据可见成交行为推测，不代表已确认的历史理由或计划。', evidenceIds: ['trade:T1'], unknown: true };
const event = { id: 'E1', tradeId: 'T1', type: 'event', title: '材料', text: '原始公告摘要', source: '用户提供原文', publishedAt: '2025-09-02T10:00', recordedAt: '2025-09-05T10:00', url: 'https://example.com/notice' };
const value = () => ({ ...createWorkspace().conversations[0], trades: [trade], selectedIds: [trade.id], origin: '用户文件', contextRevision: 1 });
const result = () => ({ suggestions: [structuredClone(note)], missing: ['理由需用户核对'], fetchedEvidence: [], retrievalStatus: '尚未配置外部取证，保留缺口。' });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));

function setup(options = {}) {
  let current = { conversation: value(), model, busy: false };
  const pending = [], calls = [], commits = [];
  const controller = createPreparationController({
    readCurrent: () => current,
    connected: candidate => candidate?.mode === 'live',
    commit(id, scope, patch) {
      if (options.failSave) throw new Error('存储空间不足');
      if (current.conversation.id !== id || preparationScopeKey(current.conversation, current.model) !== scope) return null;
      current = { ...current, conversation: { ...current.conversation, ...patch } }; commits.push(patch); return current.conversation;
    },
    run(input) { calls.push(input); const request = deferred(); pending.push(request); return request.promise; },
    timeoutMs: options.timeoutMs || 120000,
    minBatchIntervalMs: 0,
  });
  return { controller, pending, calls, commits, get current() { return current; }, update(patch) { current = { ...current, ...patch }; } };
}

test('preparation uses this conversation only, excluding messages and unconfirmed drafts', () => {
  const conversation = value(); conversation.contexts = { T1: { source: '现在回忆', reason: '暂存文字', unknown: true }, OTHER: { reason: '其他会话秘密' } };
  conversation.messages = [{ role: 'assistant', text: '旧回复', evidence: [event] }];
  conversation.suggestions = [note];
  const context = preparationContext(conversation);
  assert.deepEqual(context.trades, [trade]); assert.equal(context.contexts.T1.reason, '');
  assert.equal(context.contexts.OTHER, undefined); assert.deepEqual(context.evidence, []);
  assert.equal(context.messages, undefined); assert.equal(context.suggestions, undefined);
});

test('suggestions never replace input, uncertainty flags or an original record provenance', () => {
  assert.equal(suggestionText({ reason: '用户文字' }, note, 'reason'), '');
  assert.equal(suggestionText({ reason: ' ' }, note, 'reason'), '');
  assert.equal(suggestionText({ unknown: true }, note, 'reason'), '');
  assert.equal(suggestionText({ noPlan: true }, note, 'plan'), '');
  assert.equal(suggestionText({ source: '当时记录', reason: '原件理由' }, note, 'plan'), '');
  assert.equal(suggestionText({}, note, 'reason'), note.reason);
});

test('Tab only accepts visible empty-field candidates and preserves navigation and IME keys', () => {
  assert.equal(shouldAcceptSuggestion({ key: 'Tab' }, '', note.reason), true);
  for (const extra of [{ shiftKey: true }, { ctrlKey: true }, { altKey: true }, { metaKey: true }, { isComposing: true }, { nativeEvent: { isComposing: true } }]) assert.equal(shouldAcceptSuggestion({ key: 'Tab', ...extra }, '', note.reason), false);
  assert.equal(shouldAcceptSuggestion({ key: 'Tab' }, '手动输入', note.reason), false);
  assert.equal(shouldAcceptSuggestion({ key: 'Tab' }, '', ''), false);
  assert.equal(shouldAcceptSuggestion({ key: 'Enter' }, '', note.reason), false);
});

test('explicit acceptance persists as recalled AI draft with timestamp, not pre-decision proof', () => {
  const workspace = createWorkspace(); const conversation = value();
  const patch = acceptedSuggestionPatch(conversation, note, 'reason', '2026-10-22T12:00:00Z');
  assert.deepEqual(conversation.contexts, {});
  workspace.conversations = [{ ...conversation, ...patch }]; workspace.activeId = conversation.id;
  const saved = validateWorkspace(JSON.parse(JSON.stringify(workspace))).conversations[0];
  assert.equal(saved.contexts.T1.reason, note.reason); assert.equal(saved.contexts.T1.source, '现在回忆');
  assert.match(saved.contexts.T1.reference, /AI辅助草稿/); assert.equal(saved.contexts.T1.publishedAt, null);
  assert.equal(buildEvidence(preparationContext(saved)).find(item => item.type === 'background').timeClass, 'recollection');
});

test('fetched evidence preserves source and time, while candidates never write contexts', () => {
  const conversation = value(), input = result(); input.fetchedEvidence = [event];
  const actual = preparedResult(conversation, input);
  assert.equal(actual.patch.contexts, undefined); assert.deepEqual(conversation.evidence, []);
  assert.deepEqual(actual.patch.evidence[0], event); assert.equal(actual.patch.contextRevision, 2);
  assert.equal(buildEvidence(preparationContext({ ...conversation, ...actual.patch })).find(item => item.id === 'event:E1').timeClass, 'after');
  const sameId = preparedResult({ ...conversation, evidence: [event] }, { ...input, fetchedEvidence: [{ ...event, text: '改写原文' }] });
  assert.equal(sameId.patch.evidence[0].text, event.text);
  assert.throws(() => preparedResult(conversation, { ...input, fetchedEvidence: [{ ...event, tradeId: 'FOREIGN' }] }), /范围之外/);
  assert.throws(() => preparedResult(conversation, { ...input, suggestions: [] }), /覆盖每笔/);
});

test('waiting for a connected model does not call AI and starts once after connection', async () => {
  const run = setup(); run.update({ model: null }); run.controller.queue(run.current.conversation.id); run.controller.observe();
  assert.equal(run.controller.get(run.current.conversation.id).phase, 'waiting'); assert.equal(run.calls.length, 0);
  run.update({ model }); run.controller.observe(); run.controller.observe();
  assert.equal(run.calls.length, 1); assert.equal(run.calls[0].task, 'prepare');
  run.pending[0].resolve(result()); await tick();
  assert.equal(run.controller.get(run.current.conversation.id).phase, 'ready'); assert.deepEqual(run.current.conversation.contexts, {});
  run.controller.dispose();
});

test('accepting one candidate keeps remaining candidates but user edits invalidate old suggestions', async () => {
  const run = setup(); const finished = run.controller.start(); run.pending[0].resolve(result()); await finished;
  assert.equal(run.controller.accept('T1', 'reason'), true); assert.equal(run.current.conversation.contexts.T1.reason, note.reason);
  assert.equal(run.controller.get(run.current.conversation.id).suggestions[0].plan, note.plan);
  assert.equal(run.controller.accept('T1', 'reason'), false);
  run.update({ conversation: { ...run.current.conversation, contexts: { T1: { ...run.current.conversation.contexts.T1, plan: '用户计划' } }, contextRevision: 3 } });
  assert.equal(run.controller.accept('T1', 'plan'), false); run.controller.observe();
  assert.equal(run.controller.get(run.current.conversation.id).phase, 'stale'); assert.equal(run.current.conversation.contexts.T1.plan, '用户计划');
  run.controller.dispose();
});

test('dismiss only removes an unconfirmed candidate and has no persistence side effect', async () => {
  const run = setup(); const finished = run.controller.start(); run.pending[0].resolve(result()); await finished;
  const count = run.commits.length; run.controller.dismiss('T1', 'reason');
  assert.equal(run.controller.get(run.current.conversation.id).suggestions[0].reason, ''); assert.equal(run.commits.length, count); assert.deepEqual(run.current.conversation.contexts, {});
  run.controller.dispose();
});

test('switching conversation, editing materials or changing model rejects late results even before observe', async () => {
  for (const change of ['conversation', 'contexts', 'model', 'scope', 'market']) {
    const run = setup(); const originalId = run.current.conversation.id; const finished = run.controller.start();
    if (change === 'conversation') run.update({ conversation: value() });
    if (change === 'contexts') run.update({ conversation: { ...run.current.conversation, contexts: { T1: { reason: '用户输入' } } } });
    if (change === 'model') run.update({ model: { ...model, model: 'changed' } });
    if (change === 'scope') run.update({ conversation: { ...run.current.conversation, selectedIds: [] } });
    if (change === 'market') run.update({ conversation: { ...run.current.conversation, contextRevision: 2 } });
    run.pending[0].resolve(result()); await finished; assert.equal(run.commits.length, 0, change);
    run.controller.observe(); assert.notEqual(run.controller.get(run.current.conversation.id).phase, 'running', change);
    assert.notEqual(run.controller.get(originalId).phase, 'running', change); run.controller.dispose();
  }
});

test('reimport/retry and cancel discard prior responses even if the transport ignores abort', async () => {
  const run = setup(); const first = run.controller.start(); const second = run.controller.start();
  assert.equal(run.calls[0].signal.aborted, true); run.pending[0].resolve(result()); await first; assert.equal(run.commits.length, 0);
  run.pending[1].resolve(result()); await second; assert.equal(run.commits.length, 1);
  const third = run.controller.start({ restart: true }); run.controller.cancel(); run.pending[2].resolve(result()); await third;
  assert.equal(run.commits.length, 1); assert.equal(run.controller.get(run.current.conversation.id).phase, 'stopped'); run.controller.dispose();
});

test('failed preparation and failed persistence retain all input and allow retry', async () => {
  const run = setup(); const original = structuredClone(run.current.conversation); const failed = run.controller.start();
  run.pending[0].reject(new Error('外部调用失败')); await failed;
  assert.equal(run.controller.get(original.id).phase, 'error'); assert.deepEqual(run.current.conversation, original);
  const retry = run.controller.start(); run.pending[1].resolve(result()); await retry; assert.equal(run.commits.length, 1); run.controller.dispose();
  const storage = setup({ failSave: true }); const blocked = storage.controller.start(); storage.pending[0].resolve(result()); await blocked;
  assert.equal(storage.controller.get(storage.current.conversation.id).phase, 'error'); assert.equal(storage.commits.length, 0); storage.controller.dispose();
});

test('timeout stops preparation without deleting imported data', async () => {
  const run = setup({ timeoutMs: 10 }); const finished = run.controller.start(); await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(run.calls[0].signal.aborted, true); assert.equal(run.controller.get(run.current.conversation.id).phase, 'stopped');
  run.pending[0].resolve(result()); await finished; assert.equal(run.commits.length, 0); assert.deepEqual(run.current.conversation.trades, [trade]); run.controller.dispose();
});

test('an active review postpones background preparation until the shared slot is free', async () => {
  const run = setup(); run.update({ busy: true }); await run.controller.start();
  assert.equal(run.controller.get(run.current.conversation.id).phase, 'blocked'); assert.equal(run.calls.length, 0);
  run.update({ busy: false }); run.controller.observe(); assert.equal(run.calls.length, 1);
  run.pending[0].resolve(result()); await tick(); run.controller.dispose();
});

test('queued preparation with a connected busy model waits without showing a reconnect prompt', async () => {
  const run = setup(); run.update({ busy: true }); run.controller.queue(run.current.conversation.id); run.controller.observe();
  assert.equal(run.controller.get(run.current.conversation.id).phase, 'blocked'); assert.equal(run.calls.length, 0);
  run.controller.cancel(); run.update({ busy: false }); run.controller.observe();
  assert.equal(run.controller.get(run.current.conversation.id).phase, 'stopped'); assert.equal(run.calls.length, 0); run.controller.dispose();
});

test('prepare API sends financial configuration without research actions or cross-session history', async () => {
  const original = globalThis.fetch; let body;
  globalThis.fetch = async (_path, options) => { body = JSON.parse(options.body); return new Response(`data: ${JSON.stringify({ type: 'result', result: result() })}\n\n`, { headers: { 'content-type': 'text/event-stream' } }); };
  setFinancialConfig({ enabled: false });
  try { await runAgent({ task: 'prepare', prepareTradeIds: ['T1'], model, context: preparationContext(value()), text: '准备背景' }); }
  finally { globalThis.fetch = original; setFinancialConfig(null); }
  assert.deepEqual(body.financialConfig, { enabled: false }); assert.deepEqual(body.prepareTradeIds, ['T1']); assert.equal(body.research, undefined); assert.deepEqual(body.messages, []);
});

test('SSE failures preserve approved app error codes without exposing provider diagnostics', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(`data: ${JSON.stringify({ type: 'error', code: 'MODEL_ERROR', message: '模型服务未完成请求', providerError: 'private provider response', diagnostic: { body: 'secret' } })}\n\n`);
  try {
    await assert.rejects(runAgent({ task: 'prepare', model, context: preparationContext(value()), text: '准备背景' }), error => error.code === 'MODEL_ERROR' && error.message === '模型服务未完成请求（MODEL_ERROR）' && error.diagnostic === undefined);
  } finally { globalThis.fetch = original; }
});

function batchSetup(count = 12) {
  const run = setup();
  const trades = Array.from({ length: count }, (_, index) => ({ ...trade, id: `T${index + 1}`, time: `2025-09-${String(index + 2).padStart(2, '0')}T09:45` }));
  run.update({ conversation: { ...run.current.conversation, trades, selectedIds: trades.map(item => item.id) } });
  return run;
}
const batchResult = ids => ({ ...result(), suggestions: ids.map(tradeId => ({ ...note, tradeId, evidenceIds: [`trade:${tradeId}`] })) });

test('sequential batches prepare at most five trades while each request retains all confirmed history', async () => {
  const run = batchSetup(); const finished = run.controller.start();
  assert.deepEqual(run.calls[0].prepareTradeIds, ['T1', 'T2', 'T3', 'T4', 'T5']);
  assert.equal(run.calls.length, 1);
  const first = batchResult(run.calls[0].prepareTradeIds); first.fetchedEvidence = [event];
  run.pending[0].resolve(first); await tick();
  assert.equal(run.controller.get(run.current.conversation.id).completed, 5); assert.equal(run.current.conversation.evidence.length, 1);
  assert.deepEqual(run.calls[1].prepareTradeIds, ['T6', 'T7', 'T8', 'T9', 'T10']);
  assert.equal(run.calls[1].context.evidence[0].id, 'E1');
  run.pending[1].resolve(batchResult(run.calls[1].prepareTradeIds)); await tick();
  assert.deepEqual(run.calls[2].prepareTradeIds, ['T11', 'T12']);
  run.pending[2].resolve(batchResult(run.calls[2].prepareTradeIds)); await finished;
  assert.equal(run.controller.get(run.current.conversation.id).phase, 'ready'); assert.equal(run.controller.get(run.current.conversation.id).completed, 12);
  assert.equal(run.controller.get(run.current.conversation.id).suggestions.length, 12); assert.equal(run.commits.length, 3);
  for (const call of run.calls) { assert.equal(call.context.trades.length, 12); assert.deepEqual(call.context.contexts, {}); }
  run.controller.dispose();
});

test('a failed later batch retains completed candidates and retries only remaining trade IDs', async () => {
  const run = batchSetup(7); const firstRun = run.controller.start();
  run.pending[0].resolve(batchResult(run.calls[0].prepareTradeIds)); await tick();
  run.pending[1].reject(new Error('MODEL_ERROR')); await firstRun;
  let view = run.controller.get(run.current.conversation.id);
  assert.equal(view.phase, 'error'); assert.equal(view.completed, 5); assert.equal(view.suggestions.length, 5);
  const retry = run.controller.start(); assert.deepEqual(run.calls[2].prepareTradeIds, ['T6', 'T7']);
  run.pending[2].resolve(batchResult(run.calls[2].prepareTradeIds)); await retry;
  view = run.controller.get(run.current.conversation.id); assert.equal(view.completed, 7); assert.equal(view.phase, 'ready');
  assert.equal(run.commits.length, 2); run.controller.dispose();
});

test('stopping a later batch preserves progress and late transport output cannot commit', async () => {
  const run = batchSetup(7); const firstRun = run.controller.start();
  run.pending[0].resolve(batchResult(run.calls[0].prepareTradeIds)); await tick();
  run.controller.cancel(); assert.equal(run.calls[1].signal.aborted, true);
  assert.equal(run.controller.get(run.current.conversation.id).completed, 5);
  const retry = run.controller.start(); assert.deepEqual(run.calls[2].prepareTradeIds, ['T6', 'T7']);
  run.pending[1].resolve(batchResult(run.calls[1].prepareTradeIds)); await firstRun;
  assert.equal(run.commits.length, 1); assert.equal(run.controller.get(run.current.conversation.id).phase, 'running');
  run.pending[2].resolve(batchResult(run.calls[2].prepareTradeIds)); await retry;
  assert.equal(run.commits.length, 2); assert.equal(run.controller.get(run.current.conversation.id).completed, 7); run.controller.dispose();
});

test('accepting a completed suggestion stops remaining batches and resume uses the confirmed background', async () => {
  const run = batchSetup(7); const firstRun = run.controller.start();
  run.pending[0].resolve(batchResult(run.calls[0].prepareTradeIds)); await tick();
  assert.equal(run.controller.accept('T1', 'reason'), true);
  assert.equal(run.calls[1].signal.aborted, true); assert.equal(run.current.conversation.contexts.T1.reason, note.reason);
  let view = run.controller.get(run.current.conversation.id);
  assert.equal(view.phase, 'stopped'); assert.equal(view.completed, 5); assert.match(view.detail, /更新后的材料继续/);
  run.pending[1].resolve(batchResult(run.calls[1].prepareTradeIds)); await firstRun;
  assert.equal(run.commits.length, 2);
  const retry = run.controller.start(); assert.deepEqual(run.calls[2].prepareTradeIds, ['T6', 'T7']);
  assert.equal(run.calls[2].context.contexts.T1.source, '现在回忆'); assert.match(run.calls[2].context.contexts.T1.reference, /AI辅助草稿/);
  assert.equal(run.calls[2].context.contexts.T2, undefined);
  run.pending[2].resolve(batchResult(run.calls[2].prepareTradeIds)); await retry;
  view = run.controller.get(run.current.conversation.id); assert.equal(view.completed, 7); assert.equal(view.phase, 'ready'); run.controller.dispose();
});

test('manual material edits invalidate completed candidates and prevent later batch writes', async () => {
  const run = batchSetup(7); const finished = run.controller.start();
  run.pending[0].resolve(batchResult(run.calls[0].prepareTradeIds)); await tick();
  run.update({ conversation: { ...run.current.conversation, contexts: { T1: { reason: '手动写入' } }, contextRevision: 2 } });
  run.controller.observe(); const view = run.controller.get(run.current.conversation.id);
  assert.equal(view.phase, 'stale'); assert.equal(view.completed, 0); assert.equal(view.suggestions.length, 0);
  run.pending[1].resolve(batchResult(run.calls[1].prepareTradeIds)); await finished;
  assert.equal(run.commits.length, 1); assert.equal(run.current.conversation.contexts.T1.reason, '手动写入'); run.controller.dispose();
});

test('a later successful lookup does not erase an earlier batch source failure', async () => {
  const run = batchSetup(7); const finished = run.controller.start();
  run.pending[0].resolve({ ...batchResult(run.calls[0].prepareTradeIds), retrievalStatus: '部分外部查询失败，已有资料保留。' }); await tick();
  run.pending[1].resolve({ ...batchResult(run.calls[1].prepareTradeIds), retrievalStatus: '本批已查询，没有新增资料。' }); await finished;
  assert.match(run.current.conversation.retrievalStatus, /部分外部查询失败/);
  assert.match(run.current.conversation.retrievalStatus, /本批已查询/);
  assert.equal(run.controller.get(run.current.conversation.id).completed, 7); run.controller.dispose();
});

test('restored trades remain idle until the user explicitly prepares them', async () => {
  const run = setup();
  run.controller.observe(); run.controller.observe();
  assert.equal(run.controller.get(run.current.conversation.id).phase, 'idle'); assert.equal(run.calls.length, 0);
  const manual = run.controller.start(); assert.equal(run.calls.length, 1);
  run.pending[0].resolve(result()); await manual;
  assert.equal(run.controller.get(run.current.conversation.id).phase, 'ready'); run.controller.dispose();
});
