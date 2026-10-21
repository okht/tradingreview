import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { executeResearch } from '../server/research-service.js';
import { backtestMethod, validateMethod } from '../server/strategy-engine.js';
import { executeResearchWorkflow } from '../src/research-workflow.js';
import { saveMethodVersions, validateResearch } from '../src/research-state.js';
import { createWorkspace, validateWorkspace } from '../src/agent-workspace-state.js';

// Generated prices exercise the workflow contract, with no model or external data.
function fixture() {
  const days = [], date = new Date('2025-01-02T00:00:00Z');
  while (days.length < 60) { if (![0, 6].includes(date.getUTCDay())) days.push(date.toISOString().slice(0, 10)); date.setUTCDate(date.getUTCDate() + 1); }
  const bars = days.map((day, index) => {
    const close = 40 + index * .1 + Math.sin(index / 3) * 3;
    return { time: day, open: close + .1, high: close + .3, low: close - .3, close, closedAt: `${new Date(Date.parse(`${day}T00:00:00Z`) + 86400000).toISOString().slice(0, 10)}T00:00+08:00` };
  });
  const trades = [[8, 'buy'], [14, 'sell'], [25, 'buy'], [38, 'sell']].map(([index, side]) => ({ id: `T${index}`, symbol: '600001', name: '测试标的', time: `${days[index]}T10:00`, side, quantity: 100, price: bars[index].close, fee: 5 }));
  const context = { marketMode: 'import', origin: '生成测试数据', contexts: {}, trades, marketData: { source: '同花顺扶摇 A 股历史 K 线', provider: 'fuyao', status: 'ok', symbol: '600001.SH', currency: 'CNY', adjust: 'none', timeZone: 'Asia/Shanghai', interval: '1D', availabilityPolicy: 'next-day', observedAt: '2026-01-01T00:00:00Z', from: days[0], to: days.at(-1), bars } };
  const original = validateMethod({ id: 'original-method', title: '原版方法', origin: 'user-described', rules: { kind: 'trend', lookback: 3, entryDeviationPct: .1, exitDeviationPct: .1, allocationPct: 80 } });
  const assumptions = { initialCapital: 100000, feeBps: 3, slippageBps: 4, lotSize: 100, from: days[8], to: days[38] };
  return { context, original, assumptions, research: validateResearch({ methods: [original], assumptions }) };
}
function recorder(hook = body => executeResearch(body)) {
  const calls = [];
  return { calls, request: async body => { calls.push(structuredClone(body)); return hook(body, calls.length); } };
}
const inputFor = (data, action = 'improve') => ({ intent: { action, methodId: data.original.id, changeIds: ['stop-loss'] }, context: data.context, research: data.research, methods: [], assumptions: data.assumptions });

test('selected improvement compares original rule replay with improved rule replay using the same conditions', async () => {
  const data = fixture(), input = inputFor(data), before = structuredClone(input), api = recorder();
  const result = await executeResearchWorkflow(input, api.request);
  const improved = result.research.methods.at(-1), comparison = result.research.comparison;
  assert.equal(api.calls.length, 2);
  assert.equal(api.calls[1].intent.action, 'compare');
  assert.equal(api.calls[1].intent.methodId, data.original.id);
  assert.deepEqual(api.calls[1].context, api.calls[0].context);
  assert.deepEqual(api.calls[1].assumptions, api.calls[0].assumptions);
  assert.deepEqual(improved.rules, { ...data.original.rules, stopLossPct: 8 });
  assert.equal(comparison.mode, 'method-pair'); assert.equal(comparison.status, 'ok');
  assert.equal(comparison.baseline.methodId, data.original.id); assert.equal(comparison.alternative.methodId, improved.id);
  assert.deepEqual(comparison.baseline.assumptions, comparison.alternative.assumptions);
  assert.deepEqual(comparison.baseline.metrics, backtestMethod({ method: data.original, marketData: data.context.marketData, ...data.assumptions }).metrics);
  assert.deepEqual(comparison.alternative.metrics, backtestMethod({ method: improved, marketData: data.context.marketData, ...data.assumptions }).metrics);
  assert.equal(comparison.actualReference.metrics.tradeCount, 4);
  assert.equal(comparison.interval, '1D'); assert.deepEqual(result.savedMethods, []);
  assert.deepEqual(input, before);
});

test('one adoption returns both validated versions for an atomic idempotent save without overwriting original rules', async () => {
  const data = fixture(), api = recorder();
  const result = await executeResearchWorkflow({ ...inputFor(data, 'save_improved'), intent: { ...inputFor(data, 'save_improved').intent, title: '只加止损版' } }, api.request);
  assert.deepEqual(api.calls.map(call => call.intent.action), ['save_improved', 'save_original', 'compare']);
  assert.equal(api.calls[1].intent.title, undefined); assert.equal(api.calls[1].intent.changeIds, undefined);
  assert.equal(result.savedMethods.length, 2);
  const library = saveMethodVersions([], result.savedMethods);
  assert.equal(library[0].title, '原版方法'); assert.equal(library[0].rules.stopLossPct, null);
  assert.equal(library[1].title, '只加止损版'); assert.equal(library[1].parentId, library[0].id); assert.equal(library[1].rules.stopLossPct, 8);
  assert.notEqual(library[0].id, library[1].id);
  assert.deepEqual(saveMethodVersions(library, result.savedMethods), library);
});

test('adopting an existing proposal finds its parent from the prior research and reuses an already saved parent', async () => {
  const data = fixture();
  const generated = executeResearch(inputFor(data)); const improved = generated.research.methods.at(-1), api = recorder();
  const result = await executeResearchWorkflow({ ...inputFor(data), intent: { action: 'save_improved', methodId: improved.id }, research: generated.research, methods: [data.original] }, api.request);
  assert.deepEqual(api.calls.map(call => call.intent.action), ['save_improved', 'compare']);
  assert.deepEqual(result.savedMethods.map(method => method.id), [data.original.id, improved.id]);
  assert.deepEqual(result.research.methods.map(method => method.id), [data.original.id, improved.id]);
  assert.equal(result.research.comparison.mode, 'method-pair');
});

test('saved methods and paired replay survive existing workspace persistence and compact report validation', async () => {
  const data = fixture(), result = await executeResearchWorkflow(inputFor(data, 'save_improved'), async body => executeResearch(body));
  const state = createWorkspace(); state.methods = saveMethodVersions([], result.savedMethods);
  state.conversations[0].research = result.research;
  state.conversations[0].messages = [{ id: 'answer', role: 'assistant', text: '两版已分别保留。', research: result.research }];
  const restored = validateWorkspace(JSON.parse(JSON.stringify(state)));
  assert.equal(restored.methods.length, 2);
  assert.deepEqual(restored.conversations[0].research.comparison, result.research.comparison);
  assert.equal(restored.conversations[0].messages[0].research.comparison.mode, 'method-pair');
});

test('missing capital yields an explicit unavailable pair without comparing actual trades as original rules', async () => {
  const data = fixture(), api = recorder();
  const result = await executeResearchWorkflow({ ...inputFor(data), assumptions: {}, research: { methods: [data.original], assumptions: {} } }, api.request);
  assert.equal(api.calls.length, 1); assert.equal(result.research.comparison.mode, 'method-pair');
  assert.equal(result.research.comparison.status, 'unavailable'); assert.equal(result.research.comparison.delta, null);
  assert.match(result.research.comparison.reason, /资金/);
});

test('an unavailable actual ledger does not block two complete rule replays', async () => {
  const data = fixture(); data.context.trades[0].fee = null;
  const result = await executeResearchWorkflow(inputFor(data), async body => executeResearch(body));
  assert.equal(result.research.comparison.status, 'ok');
  assert.equal(result.research.comparison.actualReference.status, 'unavailable');
  assert.equal(result.research.comparison.baseline.methodId, data.original.id);
});

test('failure to validate original prevents any save receipt, without mutating the existing library', async () => {
  const data = fixture(), input = inputFor(data, 'save_improved');
  await assert.rejects(executeResearchWorkflow(input, async body => { if (body.intent.action === 'save_original') throw new Error('原版请求失败'); return executeResearch(body); }), /原版请求失败/);
  assert.deepEqual(input.methods, []);
});

test('a failed original replay preserves validated versions but never presents an actual-trade comparison as a paired result', async () => {
  const data = fixture();
  const result = await executeResearchWorkflow(inputFor(data, 'save_improved'), async body => { if (body.intent.action === 'compare') throw new Error('连接中断'); return executeResearch(body); });
  assert.equal(result.savedMethods.length, 2); assert.equal(result.research.comparison.mode, 'method-pair');
  assert.equal(result.research.comparison.status, 'unavailable'); assert.equal(result.research.comparison.delta, null);
  assert.match(result.research.comparison.reason, /连接中断/);
});

test('mismatched replay assumptions are rejected as a comparison rather than producing a misleading delta', async () => {
  const data = fixture();
  const result = await executeResearchWorkflow(inputFor(data), async body => {
    const response = executeResearch(body);
    if (body.intent.action === 'compare') response.research.comparison.alternative.assumptions.slippageBps = 20;
    return response;
  });
  assert.equal(result.research.comparison.status, 'unavailable'); assert.equal(result.research.comparison.delta, null);
  assert.match(result.research.comparison.reason, /不一致/);
});

test('capacity errors cannot leave only the original version saved', () => {
  const data = fixture(), existing = Array.from({ length: 59 }, (_, index) => validateMethod({ ...data.original, id: `existing-${index}` }));
  const before = structuredClone(existing), generated = executeResearch(inputFor(data, 'save_improved'));
  assert.throws(() => saveMethodVersions(existing, [data.original, generated.savedMethod]), /60/);
  assert.deepEqual(existing, before);
});

test('synthetic 15 minute review keeps both rule replays on the same declared four hour engine interval', async () => {
  const data = fixture(), bundle = JSON.parse(await readFile(new URL('../public/fixtures/complete-synthetic-review.json', import.meta.url), 'utf8'));
  data.context = { trades: bundle.trades, contexts: {}, origin: '生成测试数据', marketData: { ...bundle.marketData, reviewInterval: '15m' } };
  data.assumptions = { initialCapital: 100000, feeBps: 3, slippageBps: 5, lotSize: 100 };
  data.research = validateResearch({ methods: [data.original], assumptions: data.assumptions });
  const result = await executeResearchWorkflow(inputFor(data), async body => executeResearch(body));
  assert.equal(result.research.comparison.status, 'ok');
  assert.equal(result.research.comparison.interval, '4H');
  assert.equal(result.research.comparison.reviewInterval, '15m');
  assert.match(result.research.comparison.warnings.join(' '), /合成/);
  assert.deepEqual(result.research.comparison.baseline.assumptions, result.research.comparison.alternative.assumptions);
});

test('an orphan improved proposal cannot claim two versions were saved', async () => {
  const data = fixture(), generated = executeResearch(inputFor(data)), improved = generated.research.methods.at(-1);
  const input = { ...inputFor(data), intent: { action: 'save_improved', methodId: improved.id }, research: { ...generated.research, methods: [improved] } };
  await assert.rejects(executeResearchWorkflow(input, async body => executeResearch(body)), /对应的原方法/);
});

test('a saved original with the same ID but different rules cannot be reused for a different snapshot replay', async () => {
  const data = fixture(), saved = validateMethod({ ...data.original, rules: { ...data.original.rules, allocationPct: 50 } });
  const input = { ...inputFor(data, 'save_improved'), methods: [saved] }, before = structuredClone(input);
  await assert.rejects(executeResearchWorkflow(input, async body => executeResearch(body)), /同一方法版本的规则发生冲突/);
  assert.deepEqual(input, before);
});

test('repeated adoption returns the actual saved names and never claims an idempotent save renamed a version', async () => {
  const data = fixture(), first = await executeResearchWorkflow(inputFor(data, 'save_improved'), async body => executeResearch(body));
  const improved = first.savedMethods.at(-1);
  const input = { ...inputFor(data), intent: { action: 'save_improved', methodId: improved.id, title: '新的名称' }, research: first.research, methods: first.savedMethods };
  const second = await executeResearchWorkflow(input, async body => executeResearch(body));
  assert.equal(second.savedMethod.title, improved.title);
  assert.equal(second.savedMethods.at(-1).title, improved.title);
  assert.equal(second.research.methods.find(method => method.id === improved.id).title, improved.title);
  assert.deepEqual(saveMethodVersions(first.savedMethods, second.savedMethods), first.savedMethods);
});

test('an explicit unsupported five percent stop loss never silently saves the fixed eight percent option', async () => {
  for (const requestText of ['只采用5%止损，原版保留。', '请把止损改成 5%。', '增加 5% 收盘确认止损']) {
    const data = fixture(), api = recorder();
    await assert.rejects(executeResearchWorkflow(inputFor(data, 'save_improved'), api.request, { requestText }), /止损为 5%.*止损为 8%/);
    assert.equal(api.calls.length, 1);
  }
});

test('a reply proposing a different stop threshold cannot be paired with a contradictory executed option', async () => {
  const data = fixture();
  await assert.rejects(executeResearchWorkflow(inputFor(data), async body => executeResearch(body), { requestText: '增加止损候选', replyText: '可以考虑5%的止损。' }), /回复中提出的止损为 5%/);
});

test('matching explicit stop losses, including an existing nondefault threshold, remain executable', async () => {
  for (const threshold of [5, 8]) {
    const data = fixture();
    if (threshold === 5) { data.original = validateMethod({ ...data.original, rules: { ...data.original.rules, stopLossPct: 5 } }); data.research = validateResearch({ ...data.research, methods: [data.original] }); }
    const result = await executeResearchWorkflow(inputFor(data, 'save_improved'), async body => executeResearch(body), { requestText: `请保留${threshold}%止损。`, replyText: `方案的止损为${threshold}%。` });
    assert.equal(result.savedMethods.at(-1).rules.stopLossPct, threshold);
  }
});

test('same ID rejects changes to rule versions while explicit renames remain a separate operation', () => {
  const data = fixture();
  for (const patch of [{ version: 2 }, { parentId: 'other' }, { origin: 'inferred' }, { rules: { ...data.original.rules, stopLossPct: 5 } }]) assert.throws(() => saveMethodVersions([data.original], [{ ...data.original, ...patch }]), /规则发生冲突/);
  assert.deepEqual(saveMethodVersions([data.original], [{ ...data.original, title: '其他名称' }]), [data.original]);
});

test('explicitly excluded and original thresholds do not override the requested supported stop loss', async () => {
  for (const requestText of ['不要用5%止损，采用8%止损。', '原止损5%，本次止损改成8%。']) {
    const data = fixture();
    const result = await executeResearchWorkflow(inputFor(data, 'save_improved'), async body => executeResearch(body), { requestText });
    assert.equal(result.savedMethods.at(-1).rules.stopLossPct, 8);
  }
});
