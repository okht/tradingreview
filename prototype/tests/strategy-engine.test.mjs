import test from 'node:test';
import assert from 'node:assert/strict';
import { validateMethod, inferMethods, evaluateCandidate, improveMethod, backtestMethod, compareMethod, batchBacktest } from '../server/strategy-engine.js';

function fixture(prices = Array.from({ length: 60 }, (_, index) => 40 + index * .1 + Math.sin(index / 3) * 3)) {
  const days = []; const date = new Date('2025-01-02T00:00:00Z');
  while (days.length < prices.length) { if (![0, 6].includes(date.getUTCDay())) days.push(date.toISOString().slice(0, 10)); date.setUTCDate(date.getUTCDate() + 1); }
  const bars = prices.map((close, index) => ({ time: days[index], open: close + .1, high: close + .3, low: close - .3, close,
    closedAt: `${new Date(Date.parse(`${days[index]}T00:00:00Z`) + 86400000).toISOString().slice(0, 10)}T00:00+08:00` }));
  return { provider: 'fuyao', status: 'ok', symbol: '600001.SH', tradeSymbol: '600001', currency: 'CNY', adjust: 'none', timeZone: 'Asia/Shanghai', interval: '1D',
    observedAt: '2026-01-01T00:00:00Z', from: days[0], to: days.at(-1), bars };
}
const method = changes => validateMethod({ id: 'method-test', title: '趋势候选', origin: 'inferred', rules: { kind: 'trend', lookback: 3, entryDeviationPct: .1, exitDeviationPct: .1, allocationPct: 80, ...changes } });
const trade = (data, index, side, changes = {}) => ({ id: `t-${index}`, symbol: '600001', name: '测试股票', time: `${data.bars[index].time}T10:00`, side, price: data.bars[index].close, quantity: 100, fee: 5, ...changes });
const options = changes => ({ method: method(), marketData: fixture(), initialCapital: 100000, ...changes });

test('method validation uses a small allowlisted DSL and derives human-readable rules', () => {
  const checked = validateMethod({ ...method(), maliciousCode: 'eval()', metrics: { returnPct: 900 }, rulesSummary: ['任意保证收益'] });
  assert.equal(checked.maliciousCode, undefined); assert.equal(checked.metrics, undefined);
  assert.match(checked.rulesSummary.join(' '), /下一可用开盘/);
  assert.throws(() => method({ kind: 'script' }), /可执行规则/);
  assert.throws(() => method({ lookback: 1 }), /回看/);
  assert.throws(() => method({ code: 'future.close' }), /未支持/);
  assert.throws(() => method({ allocationPct: Infinity }), /仓位/);
});

test('missing or invalid initial capital does not become an invented account return', () => {
  for (const initialCapital of [undefined, null, NaN, 0, -1, Infinity]) {
    const result = backtestMethod(options({ initialCapital }));
    assert.equal(result.status, 'unavailable'); assert.equal(result.metrics, null);
    assert.match(result.reason, /资金/);
  }
});

test('signals execute at later opens only, cash remains nonnegative, and sell respects T+1', () => {
  const result = backtestMethod(options());
  assert.equal(result.status, 'ok'); assert.ok(result.executions.length > 3);
  let quantity = 0, lastBuy;
  for (const fill of result.executions) {
    assert.ok(Date.parse(fill.time) > Date.parse(fill.decisionAt));
    if (fill.side === 'buy') { assert.equal(quantity, 0); assert.equal(fill.quantity % 100, 0); lastBuy = fill.time; quantity += fill.quantity; }
    else { assert.equal(fill.quantity, quantity); assert.ok(fill.time.slice(0, 10) > lastBuy.slice(0, 10)); quantity = 0; }
  }
  assert.ok(result.equityCurve.every(point => point.cash >= -1e-6 && point.quantity >= 0));
  assert.ok(result.metrics.fees > 0); assert.ok(result.metrics.slippageCost > 0);
});

test('changing future OHLC never changes earlier executions or equity', () => {
  const data = fixture(), later = structuredClone(data), cut = data.bars[30].time;
  later.bars.slice(31).forEach(bar => { for (const field of ['open', 'high', 'low', 'close']) bar[field] *= 10; });
  const first = backtestMethod(options({ marketData: data }));
  const second = backtestMethod(options({ marketData: later }));
  const earlier = items => items.filter(item => new Date(Date.parse(item.time) + 8 * 3600000).toISOString().slice(0, 10) <= cut);
  assert.deepEqual(earlier(first.executions), earlier(second.executions));
  assert.deepEqual(earlier(first.equityCurve), earlier(second.equityCurve));
});

test('explicit from/to windows cannot execute outside the chosen interval and retain only past warm-up', () => {
  const data = fixture(), from = data.bars[20].time, to = data.bars[35].time;
  const result = backtestMethod(options({ marketData: data, from, to }));
  assert.equal(result.status, 'ok');
  assert.ok(result.equityCurve.every(item => item.time >= result.assumptions.from && item.time <= result.assumptions.to));
  assert.ok(result.executions.every(item => item.time >= result.assumptions.from && item.time <= result.assumptions.to));
  assert.equal(backtestMethod(options({ from: '2025-02-30' })).status, 'unavailable');
  assert.equal(backtestMethod(options({ from: '2025-01-05', to: '2025-01-01' })).status, 'unavailable');
});

test('insufficient history and malformed or duplicate OHLC remain unavailable', () => {
  const bad = fixture(); bad.bars[3].high = 1;
  assert.equal(backtestMethod(options({ marketData: bad })).status, 'unavailable');
  const duplicate = fixture(); duplicate.bars[2] = duplicate.bars[1];
  assert.equal(backtestMethod(options({ marketData: duplicate })).status, 'unavailable');
  assert.equal(backtestMethod(options({ marketData: fixture([10, 11]) })).status, 'unavailable');
  const earlyClose = fixture(); earlyClose.bars[2].closedAt = `${earlyClose.bars[2].time}T15:00+08:00`;
  assert.equal(backtestMethod(options({ marketData: earlyClose })).status, 'unavailable');
});

test('constant prices and short samples produce finite metrics and unavailable Sharpe', () => {
  for (const data of [fixture(Array(40).fill(10)), fixture([10, 11, 12, 11, 10, 11])]) {
    const result = backtestMethod(options({ marketData: data }));
    assert.equal(result.status, 'ok'); assert.equal(result.metrics.sharpe, null);
    for (const value of Object.values(result.metrics)) assert.ok(value === null || Number.isFinite(value));
    assert.doesNotMatch(JSON.stringify(result), /NaN|Infinity/);
  }
});

test('inference works with all rationale blank and retains multiple hypotheses and non-actions', () => {
  const marketData = fixture(); const trades = [trade(marketData, 8, 'buy'), trade(marketData, 14, 'sell'), trade(marketData, 25, 'buy'), trade(marketData, 38, 'sell')];
  const context = { marketData, trades, contexts: Object.fromEntries(trades.map(item => [item.id, { reason: '', unknown: true, plan: '', noPlan: true }])) };
  const before = structuredClone(context), result = inferMethods(context);
  assert.equal(result.status, 'ok'); assert.equal(result.methods.length, 2); assert.deepEqual(context, before);
  for (const candidate of result.methods) {
    assert.equal(candidate.origin, 'inferred'); assert.equal(candidate.status, 'candidate');
    const a = candidate.analysis;
    assert.equal(a.supportedTradeIds.length + a.counterexampleTradeIds.length + a.unassessableTradeIds.length, trades.length);
    assert.ok(a.nonTradeSignalCount > 0); assert.ok(a.nonTradeSignals.length > 0);
    assert.equal(candidate.metrics, undefined);
    assert.deepEqual(validateMethod(candidate).analysis, a);
  }
});

test('inference never scores a trade with its containing future candle', () => {
  const marketData = fixture(), trades = [trade(marketData, 8, 'buy'), trade(marketData, 14, 'sell')];
  const result = inferMethods({ marketData, trades });
  const altered = structuredClone(marketData);
  altered.bars[14] = { ...altered.bars[14], open: 1, close: 100, high: 101, low: .5 };
  const changed = inferMethods({ marketData: altered, trades });
  assert.deepEqual(result.methods.map(m => m.analysis.supportedTradeIds), changed.methods.map(m => m.analysis.supportedTradeIds));
  assert.deepEqual(result.methods.map(m => m.analysis.counterexampleTradeIds), changed.methods.map(m => m.analysis.counterexampleTradeIds));
});

test('analysis references cannot escape its derivation or fabricate conflicting classifications', () => {
  const marketData = fixture(), result = inferMethods({ marketData, trades: [trade(marketData, 8, 'buy')] });
  const candidate = structuredClone(result.methods[0]); candidate.analysis.supportedTradeIds = ['unknown'];
  assert.throws(() => validateMethod(candidate), /范围外/);
  const conflicting = structuredClone(result.methods[0]); conflicting.analysis.supportedTradeIds = ['t-8']; conflicting.analysis.counterexampleTradeIds = ['t-8'];
  assert.throws(() => validateMethod(conflicting), /分类冲突/);
});

test('model-proposed rules receive deterministic evidence and cannot overwrite user rationale or scores', () => {
  const marketData = fixture(), trades = [trade(marketData, 15, 'buy'), trade(marketData, 25, 'sell')];
  const context = { marketData, trades, contexts: { 't-15': { unknown: true, reason: '' } } }, before = structuredClone(context);
  const proposal = { rules: { ...method().rules, lookback: 7, entryDeviationPct: 1.2 }, title: '七根均线候选', context, metrics: { returnPct: 999 } };
  const result = evaluateCandidate(proposal);
  assert.equal(result.status, 'ok'); assert.equal(result.method.origin, 'inferred'); assert.equal(result.method.rules.lookback, 7);
  assert.equal(result.method.metrics, undefined); assert.deepEqual(context, before);
  assert.ok(result.method.analysis.nonTradeSignalCount > 0);
  const later = structuredClone(context);
  later.marketData.bars.slice(26).forEach(bar => { for (const key of ['open', 'high', 'low', 'close']) bar[key] *= 7; });
  assert.deepEqual(evaluateCandidate({ ...proposal, context: later }).method.analysis, result.method.analysis);
  assert.equal(evaluateCandidate({ ...proposal, rules: { kind: 'code', source: 'eval()' } }).status, 'unavailable');
});

test('improvement keeps the original version and supports only the selected improvement', () => {
  const original = method(), before = structuredClone(original), improved = improveMethod(original), partial = improveMethod(original, ['stop-loss']);
  assert.deepEqual(original, before); assert.notEqual(improved.id, original.id); assert.equal(improved.parentId, original.id);
  assert.equal(improved.version, 2); assert.equal(improved.origin, 'improved'); assert.equal(improved.rules.allocationPct, 50);
  assert.equal(improved.performanceClaim, null); assert.equal(partial.rules.allocationPct, original.rules.allocationPct);
  assert.equal(partial.rules.stopLossPct, 8); assert.equal(partial.rules.maxHoldBars, null);
  assert.deepEqual(partial.modifications.map(change => change.id), ['stop-loss']);
  assert.notEqual(partial.id, improved.id); assert.throws(() => improveMethod(original, ['magic']), /改进项/);
});

test('actual and alternative compare on the same capital/window, preserving recorded fees and negative improvements', () => {
  const marketData = fixture(Array.from({ length: 30 }, (_, index) => 10 + index));
  const trades = [trade(marketData, 5, 'buy', { price: 15, quantity: 1000, fee: 5 }), trade(marketData, 25, 'sell', { price: 35, quantity: 1000, fee: 10 })];
  const result = compareMethod({ method: method({ allocationPct: 1 }), context: { marketData, trades }, initialCapital: 20000, feeBps: 8, slippageBps: 10 });
  assert.equal(result.status, 'ok'); assert.equal(result.baseline.metrics.netPnl, 19985);
  assert.equal(result.baseline.metrics.fees, 15); assert.equal(result.baseline.metrics.slippageCost, null);
  assert.equal(result.baseline.assumptions.initialCapital, result.alternative.assumptions.initialCapital);
  assert.equal(result.baseline.assumptions.from, result.alternative.assumptions.from);
  assert.equal(result.baseline.assumptions.to, result.alternative.assumptions.to);
  assert.ok(result.delta.netPnl < 0); assert.ok(result.delta.returnPct < 0);
});

test('actual ledger rejects missing initial positions, fees, cashflow or market coverage', () => {
  const marketData = fixture(); const run = trades => compareMethod({ method: method(), context: { marketData, trades }, initialCapital: 10000 });
  assert.match(run([trade(marketData, 8, 'sell')]).reason, /期初持仓/);
  assert.match(run([trade(marketData, 8, 'buy', { fee: null })]).reason, /费用/);
  assert.match(run([trade(marketData, 8, 'buy', { quantity: 10000 })]).reason, /资金/);
  assert.match(run([trade(marketData, 8, 'buy', { time: `${marketData.bars[8].time}T23:00` })]).reason, /对应行情/);
  assert.match(run([trade(marketData, 8, 'buy'), trade(marketData, 8, 'sell', { id: 'same-day-sell', time: `${marketData.bars[8].time}T14:00` })]).reason, /T\+1/);
});

test('batch preserves unavailable datasets and labels in-sample vs later or other-symbol evaluation', () => {
  const data = fixture(); const candidate = validateMethod({ ...method(), derivation: { symbol: data.symbol, from: data.bars[0].time, to: data.bars[20].time, tradeIds: [] } });
  const later = backtestMethod(options({ method: candidate, from: data.bars[25].time }));
  assert.equal(later.evaluation.kind, 'out-of-time'); assert.equal(later.evaluation.independent, true);
  const other = structuredClone(data); other.symbol = '600002.SH'; other.tradeSymbol = '600002';
  const batch = batchBacktest({ method: candidate, initialCapital: 100000, datasets: [{ id: 'one', marketData: data }, { id: 'two', marketData: other }, { id: 'missing' }] });
  assert.equal(batch.status, 'ok'); assert.equal(batch.results.length, 3);
  assert.equal(batch.results[0].evaluation.kind, 'in-sample'); assert.equal(batch.results[1].evaluation.kind, 'cross-symbol');
  assert.equal(batch.results[1].evaluation.independent, false); assert.equal(batch.results[2].status, 'unavailable');
  assert.match(batch.warnings.join(' '), /选择偏差/);
});

test('synthetic observations aggregate to completed 4-hour windows and omit the unfinished final window', () => {
  const pricePoints = [];
  for (const [day, base] of [['2025-06-02', 10], ['2025-06-03', 11], ['2025-06-04', 12], ['2025-06-05', 13]]) {
    for (const [clock, add] of [['09:30', 0], ['11:30', .5], ['13:00', .7], ['15:00', 1]]) pricePoints.push({ time: Date.parse(`${day}T${clock}:00+08:00`) / 1000, price: base + add });
  }
  pricePoints.push({ time: Date.parse('2025-06-06T09:30:00+08:00') / 1000, price: 500 });
  const marketData = { provider: 'synthetic', synthetic: true, status: 'ok', symbol: 'SIMTEST', currency: 'CNY', adjust: 'none', timeZone: 'Asia/Shanghai', interval: '5m', from: '2025-06-02', to: '2025-06-06', pricePoints };
  const result = backtestMethod(options({ method: method({ lookback: 2 }), marketData }));
  assert.equal(result.status, 'ok'); assert.equal(result.equityCurve.length, 8);
  assert.ok(result.equityCurve.every(point => point.price < 500));
  assert.match(result.warnings[0], /合成测试/);
});
