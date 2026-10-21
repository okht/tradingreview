import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspace, createConversation } from '../src/agent-workspace-state.js';
import { createResearchRequestController } from '../src/research-request-state.js';
import { validateMethod, improveMethod } from '../server/strategy-engine.js';

const method = validateMethod({ id: 'original', title: '原方法', origin: 'user-described', rules: { kind: 'trend', lookback: 5 } });
const options = { intent: { action: 'save_original', methodId: method.id } };
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function response(savedMethod = method) { return { savedMethod, research: { methods: [method], assumptions: {}, limitations: [] } }; }
function harness() {
  let state = createWorkspace();
  state.methods = [];
  Object.assign(state.conversations[0], { trades: [{ id: 'T1', symbol: '600519.SH', name: '贵州茅台', time: '2025-03-03T10:00', side: 'buy', quantity: 100, price: 1200, fee: 36 }], selectedIds: ['T1'], research: { methods: [method], assumptions: {} } });
  const calls = [], commits = [], busy = [];
  const controller = createResearchRequestController({ readState: () => state, request: (body, signal) => { const wait = deferred(); calls.push({ body, signal, ...wait }); return wait.promise; }, onBusyChange: value => busy.push(value) });
  return { controller, calls, commits, busy, get state() { return state; }, setState(next) { state = next; }, run(input = options) { return controller.run(input, (result, id) => commits.push({ result, id })); } };
}

test('current research commits the validated result once and ignores draft/title edits', async () => {
  const run = harness(), pending = run.run();
  const target = run.state.activeId;
  run.state.conversations[0].draft = '继续输入'; run.state.conversations[0].title = '新名称'; run.controller.refresh();
  assert.equal(run.calls[0].signal.aborted, false);
  run.calls[0].resolve(response());
  const result = await pending;
  assert.equal(result.savedMethods[0].id, method.id); assert.equal(run.commits[0].id, target); assert.equal(run.commits.length, 1);
  assert.deepEqual(run.busy, [true, false]);
});

test('material, method, model, selection, deleted-conversation and switched-conversation changes abort and discard late success', async () => {
  const changes = [
    state => { state.conversations[0].contextRevision++; },
    state => { state.conversations[0].trades[0].price = 1250; },
    state => { state.conversations[0].selectedIds = []; },
    state => { state.conversations[0].contexts = { T1: { reason: '更新的背景' } }; },
    state => { state.conversations[0].marketData = { source: '新行情', pricePoints: [] }; },
    state => { state.conversations[0].research = { ...state.conversations[0].research, assumptions: { initialCapital: 900000 } }; },
    state => { state.methods = [method]; },
    state => { state.model = { mode: 'live', provider: 'openai', auth: 'oauth', model: 'changed' }; },
    state => { const other = createConversation(); state.conversations.push(other); state.activeId = other.id; },
    state => { state.conversations = []; },
  ];
  for (const change of changes) {
    const run = harness(), pending = run.run(); change(run.state); run.controller.refresh();
    assert.equal(run.calls[0].signal.aborted, true); assert.deepEqual(run.busy, [true, false]);
    run.calls[0].resolve(response()); assert.equal(await pending, null); assert.deepEqual(run.commits, []);
  }
});

test('the final guard catches changes before the React refresh effect and suppresses stale errors', async () => {
  for (const outcome of ['resolve', 'reject']) {
    const run = harness(), pending = run.run();
    run.state.conversations[0].contextRevision++;
    run.calls[0][outcome](outcome === 'resolve' ? response() : new Error('obsolete result'));
    assert.equal(await pending, null); assert.equal(run.calls[0].signal.aborted, true); assert.deepEqual(run.commits, []); assert.deepEqual(run.busy, [true, false]);
  }
});

test('an old completion cannot release the busy state or save into a newer request', async () => {
  const run = harness(), first = run.run(), second = run.run();
  assert.equal(run.calls[0].signal.aborted, true); assert.equal(run.calls[1].signal.aborted, false);
  run.calls[0].resolve(response()); assert.equal(await first, null);
  assert.equal(run.busy.at(-1), true); assert.equal(run.commits.length, 0);
  run.calls[1].resolve(response()); await second;
  assert.equal(run.commits.length, 1); assert.deepEqual(run.busy, [true, false, true, false]);
});

test('batch invalidation tracks selected source materials and leaves unrelated conversations alone', async () => {
  const run = harness();
  const selected = { ...structuredClone(run.state.conversations[0]), id: 'selected-source', marketData: { source: '测试', pricePoints: [] } };
  const unrelated = { ...structuredClone(selected), id: 'unselected-source' };
  run.state.conversations.push(selected, unrelated);
  const pending = run.run({ intent: { action: 'batch', methodId: method.id }, datasetIds: [selected.id] });
  unrelated.contextRevision++; run.controller.refresh(); assert.equal(run.calls[0].signal.aborted, false);
  selected.trades[0].price = 1300; run.controller.refresh(); assert.equal(run.calls[0].signal.aborted, true);
  assert.equal(run.calls[0].body.datasets[0].context.trades[0].price, 1200);
  run.calls[0].resolve(response(null)); assert.equal(await pending, null); assert.equal(run.commits.length, 0);
});

test('cancellation during a multi-call adoption cannot save either version', async () => {
  const run = harness(), improved = improveMethod(method);
  const pending = run.run({ intent: { action: 'save_improved', methodId: method.id } });
  run.calls[0].resolve({ savedMethod: improved, research: { methods: [method, improved], assumptions: {} } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(run.calls.length, 2); assert.equal(run.calls[1].body.intent.action, 'save_original');
  run.controller.cancel(); run.calls[1].resolve(response());
  assert.equal(await pending, null); assert.deepEqual(run.commits, []); assert.equal(run.calls[1].signal.aborted, true);
});

test('active transport and persistence failures propagate and unlock for retry', async () => {
  const run = harness(), first = run.run();
  run.calls[0].reject(new Error('网络失败')); await assert.rejects(first, /网络失败/); assert.equal(run.busy.at(-1), false);
  const next = run.controller.run(options, () => { throw new Error('本机保存失败'); });
  run.calls[1].resolve(response()); await assert.rejects(next, /本机保存失败/); assert.equal(run.busy.at(-1), false);
  const last = run.run(); run.calls[2].resolve(response()); await last; assert.equal(run.commits.length, 1);
});

test('unmount cancellation sends no state update and ignores a response that arrives later', async () => {
  const run = harness(), pending = run.run();
  run.controller.cancel({ notify: false }); assert.equal(run.calls[0].signal.aborted, true);
  run.calls[0].resolve(response()); assert.equal(await pending, null); assert.deepEqual(run.busy, [true]); assert.deepEqual(run.commits, []);
});
