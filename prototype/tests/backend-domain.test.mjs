import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sampleTrades } from '../src/domain.js';
import { buildEvidence, evidenceAtDecision, timestampMillis, validateContext, validateResult } from '../server/contracts.js';
import { createReviewTools } from '../server/review-tools.js';

const copy = value => JSON.parse(JSON.stringify(value));
const row = (overrides = {}) => ({ ...sampleTrades[0], id: 'T1', symbol: '600001', name: '测试标的', ...overrides });
const context = (overrides = {}) => ({ trades: [row()], contexts: {}, marketMode: 'import', origin: '用户 CSV', ...overrides });
const sample = (overrides = {}) => context({ trades: copy(sampleTrades), marketMode: 'sample', ...overrides });
const event = (overrides = {}) => ({ id: 'notice', tradeId: 'T1', title: '公开公告', text: '公告原文节选。', source: '用户提供的公司公告', publishedAt: '2025-09-02T11:30', recordedAt: '2025-09-04T12:00', ...overrides });
const bad = callback => assert.throws(callback, error => error instanceof Error && error.status === 400);
const tool = (ctx, name) => createReviewTools(ctx).find(item => item.name === name);
const read = async (ctx, name, args = {}) => (await tool(ctx, name).execute('test-call', args)).details;
const review = (overrides = {}) => ({
  text: '先核对已提供的成交与背景，资料不足的部分保留待确认。',
  facts: [{ text: '这笔成交记录了买入 500 股。', evidenceIds: ['trade:T1'] }],
  interpretations: [], uncertainties: ['缺少当时决策依据，暂不能归因。'],
  suggestions: ['补充当时计划和信息出处。'], learning: null, evidenceIds: ['trade:T1'], ...overrides,
});

test('context normalization is detached, removes unrelated backgrounds, and preserves unknown price/fee', () => {
  const input = context({ trades: [row({ time: '2025-09-02 09:45:00', price: null, fee: null, ignored: 'secret' })], contexts: { T1: { reason: ' 我记得按计划执行 ', source: '现在回忆' }, OLD: { reason: '其他复盘' } }, secret: 'discard' });
  const result = validateContext(input);
  assert.equal(result.trades[0].time, '2025-09-02T09:45');
  assert.equal(result.trades[0].price, null);
  assert.equal(result.trades[0].fee, null);
  assert.equal(result.contexts.T1.reason, '我记得按计划执行');
  assert.equal(result.contexts.T1.publishedAt, null);
  assert.deepEqual(Object.keys(result.contexts), ['T1']);
  assert.equal(result.secret, undefined);
  assert.equal(result.trades[0].ignored, undefined);
  result.trades[0].quantity = 1;
  result.contexts.T1.reason = 'changed';
  assert.equal(input.trades[0].quantity, 500);
  assert.equal(input.contexts.T1.reason, ' 我记得按计划执行 ');
});

test('confirmed context rejects missing fields, impossible dates, malformed numbers and unsupported financial scope', () => {
  for (const changes of [{ fee: undefined }, { price: 0 }, { price: NaN }, { quantity: null }, { quantity: '100' }, { fee: -1 }, { time: '2025-02-29T10:00' }, { time: '2025-09-02' }, { time: '2025-09-02T09:45Z' }, { side: 'short' }, { currency: 'USD' }, { feeCurrency: 'BTC' }, { leverage: 2 }, { assetType: 'future' }]) {
    bad(() => validateContext(context({ trades: [row(changes)] })));
  }
  const noFee = row(); delete noFee.fee;
  bad(() => validateContext(context({ trades: [noFee] })));
  assert.equal(validateContext(context({ trades: [row({ time: '2024-02-29T10:00', price: null, fee: 0 })] })).trades[0].fee, 0);
});

test('duplicate executions, mixed symbols/accounts, row limits and cash overflow fail as whole inputs', () => {
  for (const trades of [
    [row(), row({ price: 41 })],
    [row(), row({ id: 'T2' })],
    [row(), row({ id: 'T2', symbol: 'OTHER' })],
    [row({ accountId: 'A' }), row({ id: 'T2', price: 41, accountId: 'B' })],
    [row({ accountId: 'A' }), row({ id: 'T2', price: 41 })],
    Array.from({ length: 501 }, (_, index) => row({ id: `T${index}`, quantity: index + 1 })),
    [row({ price: Number.MAX_SAFE_INTEGER, quantity: 2 })],
    [row({ price: 60000000000000, quantity: 1 }), row({ id: 'T2', price: 60000000000000, quantity: 1, time: '2025-09-03T10:00' })],
  ]) bad(() => validateContext(context({ trades })));
  assert.equal(validateContext(context({ trades: [] })).trades.length, 0);
});

test('sample evidence is confined to exact constructed trades; imported or changed DEMO ids cannot borrow it', () => {
  assert.equal(buildEvidence(sample()).filter(item => item.id === 'event:demo-order:DEMO-02').length, 1);
  assert.equal(buildEvidence(sample({ marketMode: 'import' })).filter(item => item.type === 'event').length, 0);
  bad(() => validateContext(sample({ trades: sampleTrades.map(item => ({ ...item, price: item.price + 1 })) })));
  assert.equal(buildEvidence(sample({ trades: [sampleTrades[0]] })).filter(item => item.type === 'event').length, 0);
});

test('evidence keeps recollection separate from timestamped originals and never invents time from a date', () => {
  const recalled = buildEvidence(context({ contexts: { T1: { reason: '我记得先有计划', source: '现在回忆', publishedAt: '2025-09-01T08:00', recordedAt: '2025-09-04T12:00' } } })).find(item => item.type === 'background');
  assert.equal(recalled.timeClass, 'recollection');
  assert.equal(recalled.recordedAt, '2025-09-04T12:00');
  assert.equal(evidenceAtDecision(recalled, '2025-09-05T10:00').timeClass, 'recollection');
  const original = publishedAt => buildEvidence(context({ contexts: { T1: { reason: '摘录计划', source: '当时记录', publishedAt } } })).find(item => item.type === 'background');
  assert.equal(original('2025-09-01T08:00').timeClass, 'before');
  assert.equal(original('2025-09-02T10:00').timeClass, 'after');
  assert.equal(original('2025-09-01').timeClass, 'unknown');
  assert.equal(original(undefined).publishedAt, null);
  bad(() => validateContext(context({ contexts: { T1: { source: 'AI 确认的事实' } } })));
});

test('external evidence validates ownership, source identity, dates and link protocols and ignores claimed time class', () => {
  const evidence = buildEvidence(context({ evidence: [event({ timeClass: 'before', url: 'https://example.com/notice' })] }));
  const item = evidence.find(value => value.id === 'event:notice');
  assert.equal(item.timeClass, 'after');
  assert.equal(item.source, '用户提供的公司公告');
  assert.equal(item.url, 'https://example.com/notice');
  for (const entries of [[event({ tradeId: 'OLD' })], [event({ type: 'trade' })], [event({ url: 'javascript:alert(1)' })], [event({ url: 'https://user:password@example.com' })], [event({ publishedAt: '2025-04-31T12:00' })], [event(), event()]]) {
    bad(() => validateContext(context({ evidence: entries })));
  }
});

test('time comparison is explicit Beijing time and handles equivalent UTC and offset boundaries', () => {
  assert.equal(timestampMillis('2025-09-08T10:00'), timestampMillis('2025-09-08T02:00Z'));
  assert.equal(timestampMillis('2025-09-08T10:00+08:00'), timestampMillis('2025-09-07T22:00-04:00'));
  assert.equal(evidenceAtDecision(event({ publishedAt: '2025-09-08T02:00Z' }), '2025-09-08T10:00').timeClass, 'before');
  assert.equal(evidenceAtDecision(event({ publishedAt: '2025-09-08T02:00:01Z' }), '2025-09-08T10:00').timeClass, 'after');
  for (const value of ['2025-09-08', '2025-09-08T25:00', '2025-09-08T10:00+14:30', 'yesterday']) bad(() => timestampMillis(value));
});

test('Pi tools expose only read operations and detached results with structured and textual parity', async () => {
  const input = context();
  const tools = createReviewTools(input);
  assert.deepEqual(tools.map(item => item.name), ['read_trades', 'read_evidence', 'get_summary']);
  input.trades[0].price = 999;
  for (const item of tools) {
    assert.equal(item.parameters.type, 'object');
    assert.equal(item.parameters.additionalProperties, false);
    assert.equal(typeof item.label, 'string');
    const result = await item.execute('call', {});
    assert.deepEqual(JSON.parse(result.content[0].text), result.details);
  }
  const trades = tools[0];
  const first = await trades.execute('first', {});
  assert.equal(first.details.trades[0].price, 40);
  first.details.trades[0].price = 666;
  assert.equal((await trades.execute('second', {})).details.trades[0].price, 40);
  const aborted = new AbortController(); aborted.abort(new Error('cancelled'));
  await assert.rejects(trades.execute('abort', {}, aborted.signal), /cancelled/);
});

test('read tools enforce selected trade ids and cutoff, rejecting invented parameters and ambiguous dates', async () => {
  const ctx = sample();
  assert.deepEqual((await read(ctx, 'read_trades', { decisionAt: '2025-09-08T02:00Z' })).trades.map(item => item.id), ['DEMO-01', 'DEMO-02']);
  assert.deepEqual((await read(ctx, 'read_trades', { tradeIds: ['DEMO-02'] })).trades.map(item => item.id), ['DEMO-02']);
  for (const name of ['read_trades', 'read_evidence', 'get_summary']) {
    for (const args of [{ tradeIds: ['OLD'] }, { tradeIds: ['DEMO-01', 'DEMO-01'] }, { arbitrary: true }, { decisionAt: '2025-09-08' }]) {
      await assert.rejects(read(ctx, name, args), error => error.status === 400);
    }
  }
});

test('evidence cutoff hides future event and future decision recollections unless explicitly requested', async () => {
  const ctx = sample({ contexts: { 'DEMO-02': { reason: '记得有消息', source: '现在回忆' }, 'DEMO-03': { reason: '后来决定兑现收益', source: '现在回忆' } } });
  const atDecision = await read(ctx, 'read_evidence', { decisionAt: '2025-09-08T10:00' });
  assert.equal(atDecision.evidence.some(item => item.id === 'event:demo-order:DEMO-02'), false);
  assert.equal(atDecision.evidence.some(item => item.tradeId === 'DEMO-03'), false);
  assert.equal(atDecision.evidence.find(item => item.id === 'background:DEMO-02').timeClass, 'recollection');
  const withAfter = await read(ctx, 'read_evidence', { tradeIds: ['DEMO-02'], decisionAt: '2025-09-08T10:00', includeAfter: true });
  assert.equal(withAfter.evidence.find(item => item.type === 'event').timeClass, 'after');
  const noon = await read(ctx, 'read_evidence', { tradeIds: ['DEMO-02'], decisionAt: '2025-09-08T12:00' });
  assert.equal(noon.evidence.find(item => item.type === 'event').timeClass, 'before');
  assert.equal(noon.marketDataAvailable, false);
  const dateOnly = await read(context({ evidence: [event({ publishedAt: '2025-09-02' })] }), 'read_evidence');
  assert.equal(dateOnly.evidence.find(item => item.type === 'event').timeClass, 'unknown');
});

test('summary reuses exact cent arithmetic and preserves incomplete-cycle and unknown-fee boundaries', async () => {
  const result = await read(sample(), 'get_summary');
  assert.equal(result.buyAmount, 32600);
  assert.equal(result.sellAmount, 36800);
  assert.equal(result.fees, 33.4);
  assert.equal(result.netPnl, 4166.6);
  assert.equal(result.returnPct, 416660 / 3261000 * 100);
  assert.equal(result.isComplete, true);
  assert.match(result.calculationBasis, /累计买入额加买入费/);
  const incomplete = await read(sample(), 'get_summary', { decisionAt: '2025-09-08T10:00' });
  assert.equal(incomplete.position, 800);
  assert.equal(incomplete.netPnl, null);
  assert.match(incomplete.issues.join(' '), /尚未清仓/);
  const unknown = await read(sample({ marketMode: 'import', trades: sampleTrades.map((item, index) => ({ ...item, fee: index === 0 ? null : item.fee })) }), 'get_summary');
  assert.equal(unknown.fees, null);
  assert.equal(unknown.netPnl, null);
  assert.equal(unknown.returnPct, null);
  assert.equal(unknown.isComplete, false);
  assert.deepEqual(unknown.missing, [{ tradeId: 'DEMO-01', field: 'fee' }]);
  assert.equal((await read(context({ trades: [] }), 'get_summary')).netPnl, null);
});

test('summary does not infer execution order or a missing opening position', async () => {
  const same = context({ trades: [row(), row({ id: 'T2', side: 'sell', price: 42 })] });
  const ambiguous = await read(same, 'get_summary');
  assert.equal(ambiguous.netPnl, null);
  assert.match(ambiguous.issues.join(' '), /同一时刻/);
  const sellFirst = await read(context({ trades: [row({ side: 'sell' })] }), 'get_summary');
  assert.equal(sellFirst.isComplete, false);
  assert.match(sellFirst.issues.join(' '), /先卖出/);
});

test('EQ01 twenty trades reconcile five completed cycles through the tool and visible claim validator', async () => {
  const fixture = JSON.parse(readFileSync(new URL('../evaluation/fixtures/equity-50/EQ01-600519.SH-trend/context.json', import.meta.url), 'utf8'));
  const input = context({ trades: fixture.trades });
  const result = await read(input, 'get_summary');
  assert.equal(result.isComplete, true); assert.equal(result.cycleCount, 5); assert.equal(result.position, 0);
  assert.equal(result.netPnl, 82179.41); assert.equal(result.fees, 3115.59); assert.equal(result.returnPct, null);
  assert.deepEqual(result.cycles.map(cycle => cycle.netPnl), [13255.30, 13984.04, 14370.21, 15671.78, 24898.08]);
  assert.ok(result.cycles.every(cycle => Number.isFinite(cycle.returnPct) && cycle.tradeIds.length === 4));
  assert.match(result.calculationBasis, /周期间可能重复使用资金/);
  const refs = input.trades.map(trade => `trade:${trade.id}`);
  const candidate = review({ text: '累计净盈亏 82179.41 元，费用 3115.59 元。', textEvidenceIds: refs, facts: [], evidenceIds: refs });
  assert.doesNotThrow(() => validateResult('review', candidate, input));
  assert.throws(() => validateResult('review', { ...candidate, text: '整体收益率为 5%。' }, input), /投入收益率/);
});

test('parse result retains explicit missing fields and requires the model to disclose ambiguity', () => {
  const draft = { id: null, symbol: null, name: '用户提到的标的', time: null, side: 'buy', quantity: 100, price: null, fee: null };
  const result = validateResult('parse', { trades: [draft], questions: ['请确认标的代码、成交时间与价格。'], warnings: ['费用尚未提供。'] }, context({ trades: [] }));
  assert.deepEqual(result.trades, [draft]);
  const missing = { ...draft }; delete missing.fee;
  bad(() => validateResult('parse', { trades: [missing], questions: ['费用待补充'], warnings: [] }, context({ trades: [] })));
  bad(() => validateResult('parse', { trades: [draft], questions: [], warnings: [] }, context({ trades: [] })));
  bad(() => validateResult('parse', { trades: [], questions: [], warnings: [] }, context({ trades: [] })));
  assert.equal(validateResult('parse', { trades: [], questions: ['请提供至少一笔成交。'], warnings: [] }, context({ trades: [] })).trades.length, 0);
});

test('background result limits onboarding questions and validates string structure', () => {
  assert.deepEqual(validateResult('background', { questions: ['当时依据是什么？'], missing: ['原始记录时间'] }, context()), { questions: ['当时依据是什么？'], missing: ['原始记录时间'] });
  bad(() => validateResult('background', { questions: Array(6).fill('补充问题'), missing: [] }, context()));
  bad(() => validateResult('background', { questions: [{}], missing: [] }, context()));
  bad(() => validateResult('unsupported', {}, context()));
});

test('review result only accepts current evidence and a complete top-level reference index', () => {
  assert.deepEqual(validateResult('review', review(), context()), review());
  bad(() => validateResult('review', review({ facts: [{ text: '伪造引用', evidenceIds: ['trade:OLD'] }], evidenceIds: ['trade:OLD'] }), context()));
  bad(() => validateResult('review', review({ evidenceIds: [] }), context()));
  bad(() => validateResult('review', review({ facts: [{ text: '无来源结论', evidenceIds: [] }] }), context()));
  bad(() => validateResult('review', review(), context(), [{ id: 'trade:OLD', type: 'trade', timeClass: 'before' }]));
  bad(() => validateResult('review', review({ learning: undefined }), context()));
  const input = review({ learning: { title: '先留记录', trigger: '准备执行计划时', action: '保存依据和时间。', exception: '记不清时保留待确认。', evidenceIds: ['trade:T1'] } });
  assert.deepEqual(validateResult('review', input, context()).learning, input.learning);
});

test('recollections support attributed statements and uncertain interpretations only', () => {
  const ctx = context({ contexts: { T1: { reason: '我记得按计划买入', source: '现在回忆' } } });
  const refs = ['background:T1'];
  const valid = review({ facts: [{ text: '用户回忆自己按计划买入。', evidenceIds: refs }], interpretations: [{ text: '这可能属于计划执行，仍需原始记录核实。', evidenceIds: refs }], evidenceIds: refs });
  assert.equal(validateResult('review', valid, ctx).interpretations.length, 1);
  bad(() => validateResult('review', review({ facts: [{ text: '用户当时严格执行了计划。', evidenceIds: refs }], evidenceIds: refs }), ctx));
  bad(() => validateResult('review', { ...valid, interpretations: [{ text: '这次决策已经证明严格执行了计划。', evidenceIds: refs }] }, ctx));
});

test('post-decision information may explain a timing conflict but cannot justify a past decision', () => {
  const ctx = context({ evidence: [event()] });
  const refs = ['event:notice'];
  const valid = review({ facts: [{ text: '该公告于 11:30 发布。', evidenceIds: refs }], interpretations: [{ text: '公告晚于成交，不能证明成交前已获得这条信息。', evidenceIds: refs }], evidenceIds: refs });
  assert.equal(validateResult('review', valid, ctx).interpretations.length, 1);
  bad(() => validateResult('review', { ...valid, interpretations: [{ text: '这条公告导致用户买入。', evidenceIds: refs }] }, ctx));
  bad(() => validateResult('review', { ...valid, facts: [{ text: '用户买入前已知道公告。', evidenceIds: refs }] }, ctx));
  // The caller cannot relabel canonical evidence to bypass the time boundary.
  bad(() => validateResult('review', { ...valid, interpretations: [{ text: '公告确定支持当时的决策。', evidenceIds: refs }] }, ctx, buildEvidence(ctx).map(item => ({ ...item, timeClass: 'before' }))));
});

test('unknown event publication time cannot become a certain explanation', () => {
  const ctx = context({ evidence: [event({ publishedAt: null })] });
  const refs = ['event:notice'];
  const candidate = review({ interpretations: [{ text: '这条材料可能相关，但发布时间待核实。', evidenceIds: refs }], evidenceIds: ['trade:T1', ...refs] });
  assert.equal(validateResult('review', candidate, ctx).interpretations.length, 1);
  bad(() => validateResult('review', { ...candidate, interpretations: [{ text: '这条材料直接解释了成交。', evidenceIds: refs }] }, ctx));
});

test('review rejects direct trade instructions and guarantees while permitting process checks and explicit limitations', () => {
  for (const text of ['建议买入这只股票。', '应该立即加仓。', '现在就卖出该股。', '保证获得收益。', '这只股票一定上涨。', '稳赚不赔。', 'You should buy this stock.', 'Guaranteed returns.']) {
    bad(() => validateResult('review', review({ suggestions: [text] }), context()));
  }
  const valid = review({ text: '这些材料不能保证收益，也不能证明当时判断一定正确。', textEvidenceIds: ['trade:T1'], suggestions: ['建议买入前记录决策依据。', '加仓前核对信息发布时间与计划条件。'] });
  assert.equal(validateResult('review', valid, context()).suggestions.length, 2);
});
