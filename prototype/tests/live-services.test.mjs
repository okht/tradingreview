import test from 'node:test';
import assert from 'node:assert/strict';
import { clearSessionConfig, createSseDecoder, getSessionConfig, runAgent, setSessionConfig } from '../src/services/api.js';
import { buildLiveContext, candidateIssues, createLiveChat, liveContextKey, normalizeReviewResult, prepareTradeCandidates, restoreLiveChat } from '../src/live-chat-state.js';
import { inspectWorkspace, workspaceCanSave, workspaceNeedsInspection, workspaceSnapshot } from '../src/useWorkspaceSync.js';
import { sampleTrades } from '../src/domain.js';

const context = { trades: sampleTrades, contexts: {}, marketMode: 'sample', origin: '示例' };
const metadata = { mode: 'live', provider: 'openai', model: 'test-model', auth: 'api' };

test('SSE parser handles split CRLF and UTF-8 decoded chunks', () => {
  const events = []; const decoder = createSseDecoder(event => events.push(event));
  decoder.push(': keepalive\r\ndata: {"type":"status","text":"正在');
  decoder.push('核对"}\r'); decoder.push('\n\r\ndata: {"type":"result",\n');
  decoder.push('data: "result":{"text":"完成"}}\n\n'); decoder.finish();
  assert.deepEqual(events, [{ type: 'status', text: '正在核对' }, { type: 'result', result: { text: '完成' } }]);
});

test('SSE malformed event is an error', () => {
  const decoder = createSseDecoder(() => {});
  assert.throws(() => decoder.push('data: {bad}\n\n'), /无法读取/);
});

test('credential is page-memory only and metadata cannot recreate an API session', () => {
  clearSessionConfig(); assert.throws(() => getSessionConfig(metadata), /重新填写/);
  setSessionConfig({ provider: 'openai', model: 'test-model', auth: 'api', apiKey: 'test-only-key' });
  assert.equal(getSessionConfig(metadata).apiKey, 'test-only-key');
  const snapshot = workspaceSnapshot({ model: { ...metadata, apiKey: 'must-strip' }, config: { apiKey: 'must-strip' }, apiKey: 'must-strip', trades: [] });
  assert.equal(JSON.stringify(snapshot).includes('must-strip'), false);
  clearSessionConfig(); assert.throws(() => getSessionConfig(metadata), /重新填写/);
});

test('live request requires a final result, reports server errors and keeps AbortSignal', async () => {
  const previousFetch = globalThis.fetch;
  setSessionConfig({ provider: 'openai', model: 'test-model', auth: 'api', apiKey: 'test-only-key' });
  const controller = new AbortController();
  try {
    globalThis.fetch = async (_url, options) => { assert.equal(options.signal, controller.signal); return new Response('data: {"type":"status","text":"处理中"}\n\n', { headers: { 'Content-Type': 'text/event-stream' } }); };
    await assert.rejects(runAgent({ task: 'review', model: metadata, context, signal: controller.signal }), /没有收到完整结果/);
    globalThis.fetch = async () => new Response('data: {"type":"error","message":"模型不可用"}\n\n');
    await assert.rejects(runAgent({ task: 'review', model: metadata, context }), /模型不可用/);
    globalThis.fetch = async () => new Response('data: {"type":"result","result":{"text":"已完成"}}\n\n');
    assert.deepEqual(await runAgent({ task: 'review', model: metadata, context }), { text: '已完成' });
  } finally { globalThis.fetch = previousFetch; clearSessionConfig(); }
});

test('live chat restores arbitrary real suggestions and preserves incomplete user turn', () => {
  const thread = createLiveChat(context);
  thread.draft = '待发送';
  thread.messages.push({ id: 'user-1', role: 'user', text: '自由问题', refs: [], suggestions: [] });
  thread.lastRequest = { id: 'user-1', text: '自由问题' };
  const restored = restoreLiveChat(JSON.parse(JSON.stringify(thread)), context);
  assert.equal(restored.messages.length, 2); assert.equal(restored.draft, '待发送'); assert.equal(restored.lastRequest.id, 'user-1');
  assert.equal(restoreLiveChat(thread, { ...context, trades: sampleTrades.slice(0, 1) }).messages.length, 1);
  thread.messages[0].refs = [null]; assert.equal(restoreLiveChat(thread, context).messages.length, 1);
});

test('real review references only returned evidence and retains uncertainty', () => {
  const normalized = normalizeReviewResult({ analysisRunId: 'run-1', text: '先核对来源。', facts: [{ text: '已记录买入', evidenceIds: ['t1', 'missing'] }], interpretations: [], uncertainties: ['记录时间未知'], suggestions: ['继续核对'], learning: { title: '检查来源', trigger: '下次决定前', action: '核对形成时间', exception: '', evidenceIds: ['t1'] }, evidenceIds: ['missing'], evidence: [{ id: 't1', title: '成交', tradeId: sampleTrades[0].id, text: '买入', timeClass: 'before' }] }, context);
  assert.deepEqual(normalized.refs.map(ref => ref.evidenceId), ['t1']);
  assert.match(normalized.text, /记录时间未知/); assert.equal(normalized.learning.title, '检查来源');
  assert.equal(normalized.learning.analysisRunId, 'run-1'); assert.deepEqual(normalized.learning.evidenceIds, ['t1']);
});

test('real contexts include market data and invalidate saved analysis when it changes', () => {
  const first = buildLiveContext({ ...context, marketData: { source: '行情接口', bars: [{ time: '2025-09-01', close: 40 }] } }, sampleTrades);
  const changed = buildLiveContext({ ...context, marketData: { source: '行情接口', bars: [{ time: '2025-09-01', close: 41 }] } }, sampleTrades);
  assert.equal(first.marketData.bars[0].close, 40);
  const saved = { ...createLiveChat(first), draft: '旧行情下的草稿' };
  assert.equal(restoreLiveChat(saved, first).draft, '旧行情下的草稿');
  assert.equal(restoreLiveChat(saved, changed).draft, '');
  assert.notEqual(liveContextKey(first), liveContextKey(changed));
  assert.equal(liveContextKey(context), liveContextKey({ ...context, marketData: null }));
});

test('demo refresh discovers remote live records without allowing a demo overwrite', async () => {
  const previousFetch = globalThis.fetch; const remote = { model: metadata, trades: sampleTrades };
  try {
    globalThis.fetch = async (_url, options) => { assert.equal(options.method, 'GET'); return Response.json({ state: remote, revision: 4 }); };
    const plan = await inspectWorkspace({ live: false });
    assert.deepEqual(plan.pendingRemote, remote); assert.equal(plan.status, 'choice'); assert.equal(plan.ready, false);
    assert.equal(workspaceCanSave({ model: { mode: 'demo' } }, true, 4), false);
    assert.equal(workspaceCanSave({ model: metadata }, false, 4), false);
    assert.equal(workspaceCanSave({ model: metadata }, true, null), false);
    assert.equal(workspaceCanSave({ model: metadata }, true, 4), true);
  } finally { globalThis.fetch = previousFetch; }
});

test('unavailable sync remains local in demo and reports errors in live mode', async () => {
  const previousFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => { throw new Error('测试服务离线'); };
    assert.deepEqual(await inspectWorkspace({ live: false }), { revision: null, pendingRemote: null, ready: false, status: 'local' });
    await assert.rejects(inspectWorkspace({ live: true }), /测试服务离线/);
    globalThis.fetch = async () => Response.json({ state: null, revision: -1 });
    await assert.rejects(inspectWorkspace({ live: true }), /无效版本/);
  } finally { globalThis.fetch = previousFetch; }
});

test('restoring a discovered live workspace does not repeat the choice on mode change', async () => {
  const previousFetch = globalThis.fetch; let reads = 0;
  try {
    globalThis.fetch = async () => { reads++; return Response.json({ state: { model: metadata }, revision: 4 }); };
    let inspection = null;
    assert.equal(workspaceNeedsInspection(inspection, 0), true);
    const plan = await inspectWorkspace({ live: false });
    inspection = { reload: 0, revision: plan.revision };
    // Both restore-remote and keep-local retain this successful observation.
    if (workspaceNeedsInspection(inspection, 0)) await inspectWorkspace({ live: true });
    assert.equal(reads, 1);
    assert.equal(workspaceNeedsInspection(inspection, 1), true);
  } finally { globalThis.fetch = previousFetch; }
});

test('failed initial demo inspection retries after entering live mode', async () => {
  const previousFetch = globalThis.fetch; let reads = 0;
  try {
    globalThis.fetch = async () => { reads++; if (reads === 1) throw new Error('离线'); return Response.json({ state: null, revision: 0 }); };
    const initial = await inspectWorkspace({ live: false });
    const inspection = { reload: 0, revision: initial.revision };
    assert.equal(workspaceNeedsInspection(inspection, 0), true);
    const live = await inspectWorkspace({ live: true });
    assert.equal(reads, 2); assert.equal(live.ready, true);
    assert.equal(workspaceNeedsInspection({ reload: 0, revision: live.revision }, 0), false);
  } finally { globalThis.fetch = previousFetch; }
});

test('trade extraction preserves missing fields and blocks invalid or ambiguous confirmation', () => {
  const [candidate] = prepareTradeCandidates({ trades: [{ name: '示例', symbol: 'DEMO001', side: null, time: null, quantity: null }] });
  assert.equal(candidate.quantity, null); assert.equal(candidate.side, ''); assert.equal(candidate.price, null);
  assert.ok(candidateIssues([candidate]).length > 0);
  assert.ok(candidateIssues([{ ...sampleTrades[0], time: '2025-02-30T10:00' }]).length > 0);
  assert.equal(candidateIssues([{ ...sampleTrades[0], price: null, fee: null }]).length, 0);
});
