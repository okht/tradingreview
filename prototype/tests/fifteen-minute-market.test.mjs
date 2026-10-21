import test from 'node:test';
import assert from 'node:assert/strict';
import { validateContext, buildEvidence } from '../server/contracts.js';
import { createReviewTools } from '../server/review-tools.js';
import { selectSyntheticChartData } from '../src/synthetic-market.js';
import { getAvailableIntervals } from '../src/market-data.js';

const at = clock => Date.parse(`2025-03-03T${clock}:00+08:00`) / 1000;
const trades = [{ id: 'EVAL-T1', symbol: '600519.SH', name: '贵州茅台', time: '2025-03-03T09:50', side: 'buy', quantity: 100, price: 12, fee: 5 }];
const marketData = { provider: 'synthetic', synthetic: true, source: '用户导入的合成行情', status: 'ok', symbol: '600519.SH', instrumentKind: 'real-equity', interval: '5m', reviewInterval: '15m', currency: 'CNY', timeZone: 'Asia/Shanghai', adjust: 'none', from: '2025-03-03', to: '2025-03-03', pricePoints: [['09:30', 10], ['09:35', 9], ['09:40', 11], ['09:45', 10], ['09:50', 12], ['09:55', 13], ['10:00', 14], ['11:25', 15], ['11:30', 16], ['13:00', 17], ['13:05', 18], ['13:15', 19], ['14:55', 20], ['15:00', 21]].map(([clock, price]) => ({ time: at(clock), price })) };
const context = () => validateContext({ trades, contexts: {}, marketData, origin: '真实标的，合成行情与行为' });

test('real instrument identity never removes the synthetic provenance requirement', () => {
  const ctx = context();
  assert.equal(ctx.marketData.instrumentKind, 'real-equity');
  assert.equal(ctx.marketData.synthetic, true);
  for (const patch of [{ instrumentKind: undefined }, { synthetic: false }, { source: '真实行情' }, { reviewInterval: '1m' }]) {
    assert.throws(() => validateContext({ ...ctx, marketData: { ...marketData, ...patch } }));
  }
  assert.ok(getAvailableIntervals(ctx).includes('15m'));
});

test('15m boundaries are right closed and never create lunch or post-close bars', () => {
  const view = selectSyntheticChartData({ trades, marketData, interval: '15m' });
  assert.deepEqual(view.candles.map(b => [b.startAt.slice(11, 16), b.endAt.slice(11, 16)]), [['09:30', '09:45'], ['09:45', '10:00'], ['11:15', '11:30'], ['13:00', '13:15'], ['14:45', '15:00']]);
  assert.deepEqual(Object.fromEntries(['open', 'high', 'low', 'close'].map(k => [k, view.candles[0][k]])), { open: 10, high: 11, low: 9, close: 10 });
  assert.equal(view.candles.at(-1).close, 21);
  assert.equal(view.markers[0].time, at('09:45'));
});

test('cutoff 15m candle and server tool share the observed prefix and immutable future boundary', async () => {
  const ctx = context(), options = { trades, interval: '15m', cutoff: trades[0].time, showFuture: false };
  const before = selectSyntheticChartData({ ...options, marketData });
  assert.equal(before.currentBar.ohlc.close, 12);
  assert.equal(before.currentBar.ohlc.high, 12);
  const changed = { ...marketData, pricePoints: marketData.pricePoints.map(p => p.time > at('09:50') ? { ...p, price: 9999 } : p) };
  assert.deepEqual(selectSyntheticChartData({ ...options, marketData: changed }), before);
  const tool = createReviewTools(ctx).find(t => t.name === 'read_market');
  const value = (await tool.execute('check', { tradeId: trades[0].id })).details;
  assert.equal(value.interval, '15m');
  assert.equal(value.before.returnedBars, 1);
  assert.equal(value.after.returnedBars, 0);
  assert.deepEqual(value.currentBar.ohlc, before.currentBar.ohlc);
  assert.ok(buildEvidence(ctx).some(e => e.title.includes('15 分钟') && e.synthetic));
});
