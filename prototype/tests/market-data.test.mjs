import test from 'node:test';
import assert from 'node:assert/strict';
import { sampleTrades } from '../src/domain.js';
import { sampleCandles, sampleFourHourCandles, sampleIntradayPoints, selectChartData, aggregateCandles, getAvailableIntervals, groupChartMarkers } from '../src/market-data.js';

test('constructed OHLC is chronological, complete, and contains the example executions', () => {
  assert.equal(sampleCandles[0].time, '2025-09-01');
  assert.equal(sampleCandles.at(-1).time, '2025-09-18');
  assert.equal(sampleCandles.length, 14);
  sampleCandles.forEach((candle, index) => {
    assert.match(candle.time, /^2025-09-\d{2}$/);
    assert.ok(candle.low <= Math.min(candle.open, candle.close));
    assert.ok(candle.high >= Math.max(candle.open, candle.close));
    assert.ok(candle.low > 0);
    if (index) assert.ok(candle.time > sampleCandles[index - 1].time);
  });
  for (const trade of sampleTrades) {
    const candle = sampleCandles.find((item) => item.time === trade.time.slice(0, 10));
    assert.ok(candle.low <= trade.price && candle.high >= trade.price);
  }
});

test('a past decision retains the known current candle while hiding its later changes and later trades', () => {
  const data = selectChartData({ trades: sampleTrades, mode: 'sample', cutoff: '2025-09-08T10:00', showFuture: false });
  assert.equal(data.candles.at(-1).time, '2025-09-08');
  assert.equal(data.candles.length, 6);
  assert.deepEqual(data.markers.map((marker) => marker.id), ['DEMO-01', 'DEMO-02']);
  assert.ok(data.candles.every((candle) => candle.time <= '2025-09-08'));
  assert.equal(data.candles.at(-1).isPartial, true);
  assert.deepEqual(data.currentBar.ohlc, { open: 41.5, high: 42, low: 41.2, close: 42 });
  assert.equal(data.currentBar.status, 'partial');
  assert.equal(data.currentBar.asOf, '2025-09-08T10:00:00+08:00');
});

test('first-trade view includes the execution at the cutoff and reveal includes all final example data', () => {
  const past = selectChartData({ trades: sampleTrades, mode: 'sample', cutoff: '2025-09-02T09:45', showFuture: false });
  assert.equal(past.candles.length, 2);
  assert.equal(past.markers.length, 1);
  assert.equal(past.candles.at(-1).close, 40);
  assert.equal(past.candles.at(-1).low, 39.6);
  assert.equal(past.candles.at(-1).high, 40);
  const all = selectChartData({ trades: [...sampleTrades].reverse(), mode: 'sample', cutoff: '2025-09-02T09:45', showFuture: true });
  assert.equal(all.candles.length, 14);
  assert.deepEqual(all.markers.map((marker) => marker.text), ['B', 'B', 'S']);
  assert.equal(all.markers.at(-1).time, '2025-09-18');
});

test('imported executions never become synthetic market candles or markers', () => {
  for (const mode of ['import', undefined, 'other']) {
    assert.deepEqual(selectChartData({ trades: sampleTrades, mode, showFuture: true }), { candles: [], markers: [] });
  }
});

test('empty cutoff ranges stay empty and non-demo symbols are not placed on demo prices', () => {
  const before = selectChartData({ trades: sampleTrades, mode: 'sample', cutoff: '2025-09-01T09:29:59', showFuture: false });
  assert.deepEqual(before, { candles: [], markers: [] });
  const wrongSymbol = selectChartData({ trades: sampleTrades.map((trade) => ({ ...trade, symbol: 'OTHER' })), mode: 'sample' });
  assert.equal(wrongSymbol.markers.length, 0);
});

test('only backed sample intervals are available and unsupported minute choices yield no prices', () => {
  assert.deepEqual(getAvailableIntervals({ mode: 'sample', trades: sampleTrades }), ['4H', '1D', '1W', '1M']);
  for (const options of [
    { mode: 'import', trades: sampleTrades },
    { mode: 'sample', trades: [] },
    { mode: 'sample', trades: [...sampleTrades, { ...sampleTrades[0], symbol: 'OTHER' }] },
  ]) {
    assert.deepEqual(getAvailableIntervals(options), []);
    assert.deepEqual(selectChartData({ ...options, interval: '1W' }), { candles: [], markers: [] });
  }
  assert.deepEqual(selectChartData({ mode: 'sample', trades: sampleTrades, interval: '1m' }), { candles: [], markers: [] });
});

test('weekly aggregation uses first open, extreme high/low, last close and actual daily coverage', () => {
  const result = selectChartData({ mode: 'sample', trades: sampleTrades, interval: '1W' });
  assert.deepEqual(result.candles, [
    { time: '2025-09-01', open: 39.6, high: 41.6, low: 38.9, close: 41.1, sourceFrom: '2025-09-01', sourceTo: '2025-09-05', sourceCount: 5 },
    { time: '2025-09-08', open: 41.5, high: 44.6, low: 41.2, close: 43.6, sourceFrom: '2025-09-08', sourceTo: '2025-09-12', sourceCount: 5 },
    { time: '2025-09-15', open: 43.9, high: 46.9, low: 43.6, close: 46.2, sourceFrom: '2025-09-15', sourceTo: '2025-09-18', sourceCount: 4 },
  ]);
  assert.deepEqual(result.markers.map(({ id, time }) => ({ id, time })), [
    { id: 'DEMO-01', time: '2025-09-01' },
    { id: 'DEMO-02', time: '2025-09-08' },
    { id: 'DEMO-03', time: '2025-09-15' },
  ]);
});

test('monthly aggregation reports observed coverage and maps all visible fills to the month', () => {
  const result = selectChartData({ mode: 'sample', trades: sampleTrades, interval: '1M' });
  assert.deepEqual(result.candles, [
    { time: '2025-09-01', open: 39.6, high: 46.9, low: 38.9, close: 46.2, sourceFrom: '2025-09-01', sourceTo: '2025-09-18', sourceCount: 14 },
  ]);
  assert.deepEqual(result.markers.map(({ time, text }) => ({ time, text })), [
    { time: '2025-09-01', text: 'B' },
    { time: '2025-09-01', text: 'B' },
    { time: '2025-09-01', text: 'S' },
  ]);
});

test('mid-week and mid-month review cutoffs are applied before aggregation and marker placement', () => {
  const options = { mode: 'sample', trades: sampleTrades, cutoff: '2025-09-10T10:00', showFuture: false };
  const weekly = selectChartData({ ...options, interval: '1W' });
  assert.deepEqual(weekly.candles.at(-1), {
    time: '2025-09-08', open: 41.5, high: 43.8, low: 41.2, close: 43.11, sourceFrom: '2025-09-08', sourceTo: '2025-09-10', sourceCount: 3,
    isPartial: true, asOf: '2025-09-10T10:00:00+08:00', lastObservedAt: '2025-09-10T10:00:00+08:00',
  });
  const monthly = selectChartData({ ...options, interval: '1M' });
  assert.equal(monthly.candles[0].high, 43.8);
  assert.equal(monthly.candles[0].close, 43.11);
  assert.equal(monthly.candles[0].sourceTo, '2025-09-10');
  assert.equal(monthly.candles[0].sourceCount, 8);
  for (const result of [weekly, monthly]) {
    assert.deepEqual(result.markers.map((marker) => marker.id), ['DEMO-01', 'DEMO-02']);
    assert.ok(result.candles.every((candle) => candle.sourceTo <= '2025-09-10'));
    assert.equal(result.currentBar.status, 'partial');
  }
  for (const interval of ['1W', '1M']) {
    const addDecision = selectChartData({ ...options, interval, cutoff: '2025-09-08T10:00' });
    assert.deepEqual(addDecision.markers.map((marker) => marker.id), ['DEMO-01', 'DEMO-02']);
    assert.equal(addDecision.candles.at(-1).sourceTo, '2025-09-08');
    assert.equal(addDecision.candles.at(-1).close, 42);
  }
});

test('weekly and monthly buckets handle cross-month and cross-year dates without mutating input', () => {
  const days = [
    { time: '2025-12-31', open: 20, high: 24, low: 19, close: 23 },
    { time: '2026-01-02', open: 23, high: 25, low: 21, close: 22 },
    { time: '2026-01-05', open: 22, high: 26, low: 20, close: 25 },
  ];
  const snapshot = JSON.stringify(days);
  const weekly = aggregateCandles([...days].reverse(), '1W');
  assert.deepEqual(weekly[0], { time: '2025-12-29', open: 20, high: 25, low: 19, close: 22, sourceFrom: '2025-12-31', sourceTo: '2026-01-02', sourceCount: 2 });
  assert.equal(weekly[1].time, '2026-01-05');
  const monthly = aggregateCandles([...days].reverse(), '1M');
  assert.deepEqual(monthly.map((bar) => bar.time), ['2025-12-01', '2026-01-01']);
  assert.deepEqual(monthly[1], { time: '2026-01-01', open: 23, high: 26, low: 20, close: 25, sourceFrom: '2026-01-02', sourceTo: '2026-01-05', sourceCount: 2 });
  const crossMonth = aggregateCandles([
    { time: '2025-09-30', open: 10, high: 12, low: 9, close: 11 },
    { time: '2025-10-01', open: 11, high: 14, low: 10, close: 13 },
  ], '1W');
  assert.equal(crossMonth.length, 1);
  assert.equal(crossMonth[0].time, '2025-09-29');
  assert.equal(crossMonth[0].sourceTo, '2025-10-01');
  assert.equal(JSON.stringify(days), snapshot);
});

test('colocated monthly trade markers compact by direction and preserve traceable execution ids', () => {
  const original = selectChartData({ mode: 'sample', trades: sampleTrades, interval: '1M' }).markers;
  const snapshot = JSON.stringify(original);
  const grouped = groupChartMarkers(original);
  assert.equal(grouped.length, 2);
  assert.equal(grouped[0].text, 'B×2');
  assert.equal(grouped[0].id, 'DEMO-01');
  assert.deepEqual(grouped[0].tradeIds, ['DEMO-01', 'DEMO-02']);
  assert.equal(grouped[0].position, 'belowBar');
  assert.equal(grouped[0].color, original[0].color);
  assert.equal(grouped[1].text, 'S');
  assert.deepEqual(grouped[1].tradeIds, ['DEMO-03']);
  assert.equal(grouped[1].position, 'aboveBar');
  assert.notEqual(grouped[0], original[0]);
  assert.equal(JSON.stringify(original), snapshot);
  assert.deepEqual(groupChartMarkers(grouped), grouped);
});

test('marker groups remain time-ordered and stable without mixing sides or distinct positions', () => {
  const original = [
    { time: '2025-09-09', position: 'aboveBar', text: 'S', id: 'later-sell' },
    { time: '2025-09-02', position: 'belowBar', text: 'B', id: 'first-buy' },
    { time: '2025-09-02', position: 'belowBar', text: 'S', id: 'same-position-sell' },
    { time: '2025-09-02', position: 'aboveBar', text: 'B', id: 'other-position-buy' },
    { time: '2025-09-02', position: 'belowBar', text: 'B', id: 'second-buy' },
  ];
  const snapshot = JSON.stringify(original);
  const grouped = groupChartMarkers(original);
  assert.deepEqual(grouped.map((marker) => marker.id), ['first-buy', 'same-position-sell', 'other-position-buy', 'later-sell']);
  assert.deepEqual(grouped.map((marker) => marker.text), ['B×2', 'S', 'B', 'S']);
  assert.deepEqual(grouped[0].tradeIds, ['first-buy', 'second-buy']);
  assert.equal(JSON.stringify(original), snapshot);
  assert.deepEqual(groupChartMarkers([]), []);
});

test('28 constructed 4-hour bars exactly reconcile to original daily OHLC and cover example fills', () => {
  assert.equal(sampleFourHourCandles.length, 28);
  assert.ok(Object.isFrozen(sampleFourHourCandles));
  for (const day of sampleCandles) {
    const bars = sampleFourHourCandles.filter((bar) => bar.startAt.startsWith(day.time));
    assert.equal(bars.length, 2);
    assert.deepEqual({ time: day.time, open: bars[0].open, high: Math.max(...bars.map((bar) => bar.high)), low: Math.min(...bars.map((bar) => bar.low)), close: bars[1].close }, day);
    assert.equal(bars[0].close, bars[1].open);
    for (const bar of bars) {
      assert.equal(bar.time, Date.parse(bar.startAt) / 1000);
      assert.equal(Date.parse(bar.endAt) - Date.parse(bar.startAt), 4 * 60 * 60 * 1000);
      assert.ok(bar.low <= Math.min(bar.open, bar.close));
      assert.ok(bar.high >= Math.max(bar.open, bar.close));
    }
  }
  for (const trade of sampleTrades) {
    const at = Date.parse(`${trade.time}+08:00`);
    const bar = sampleFourHourCandles.find((item) => at >= Date.parse(item.sourceFrom) && at <= Date.parse(item.sourceTo));
    assert.ok(bar && bar.low <= trade.price && bar.high >= trade.price);
  }
});

test('4-hour samples represent daytime trading sessions only and lunch/weekend fills receive no marker', () => {
  for (const bar of sampleFourHourCandles) {
    const weekday = new Date(`${bar.startAt.slice(0, 10)}T00:00:00Z`).getUTCDay();
    assert.ok(weekday >= 1 && weekday <= 5);
    assert.ok(['08:00', '12:00'].includes(bar.startAt.slice(11, 16)));
    const expectedSession = bar.startAt.slice(11, 16) === '08:00' ? ['09:30', '11:30'] : ['13:00', '15:00'];
    assert.deepEqual([bar.sourceFrom.slice(11, 16), bar.sourceTo.slice(11, 16)], expectedSession);
  }
  const extra = [
    { ...sampleTrades[0], id: 'LUNCH', time: '2025-09-02T12:30' },
    { ...sampleTrades[0], id: 'WEEKEND', time: '2025-09-06T10:00' },
    { ...sampleTrades[0], id: 'OVERNIGHT', time: '2025-09-02T20:00' },
  ];
  const data = selectChartData({ mode: 'sample', trades: [...sampleTrades, ...extra], interval: '4H' });
  assert.deepEqual(data.markers.map((marker) => marker.id), sampleTrades.map((trade) => trade.id));
});

test('10:00 and 14:30 reviews expose only the observed prefix of their unfinished 4-hour bars', () => {
  const options = { mode: 'sample', trades: sampleTrades, interval: '4H', showFuture: false };
  const morning = selectChartData({ ...options, cutoff: '2025-09-08T10:00' });
  assert.equal(morning.candles.length, 11);
  assert.equal(morning.candles.at(-1).startAt, '2025-09-08T08:00:00+08:00');
  assert.equal(morning.candles.at(-1).sourceTo, '2025-09-08T10:00:00+08:00');
  assert.deepEqual(morning.currentBar.ohlc, { open: 41.5, high: 42, low: 41.2, close: 42 });
  assert.deepEqual(morning.markers.map((marker) => marker.id), ['DEMO-01', 'DEMO-02']);
  const afternoon = selectChartData({ ...options, cutoff: '2025-09-18T14:30' });
  assert.equal(afternoon.candles.length, 28);
  assert.equal(afternoon.candles.at(-1).startAt, '2025-09-18T12:00:00+08:00');
  assert.equal(afternoon.candles.at(-1).sourceTo, '2025-09-18T14:30:00+08:00');
  assert.deepEqual(afternoon.currentBar.ohlc, { open: 46.3, high: 46.55, low: 46, close: 46 });
  assert.deepEqual(afternoon.markers.map((marker) => marker.id), ['DEMO-01', 'DEMO-02', 'DEMO-03']);
  const closed = selectChartData({ ...options, cutoff: '2025-09-18T16:00' });
  assert.equal(closed.candles.length, 28);
  assert.equal(closed.markers.at(-1).id, 'DEMO-03');
  assert.equal(closed.currentBar, null);
  assert.equal(closed.candles.at(-1).close, 46.2);
  assert.equal(closed.candles.at(-1).low, 45.6);
});

test('4-hour partial status uses window boundaries and equivalent timezone cutoffs produce identical replay', () => {
  const options = { mode: 'sample', trades: sampleTrades, interval: '4H', showFuture: false };
  const beforeEnd = selectChartData({ ...options, cutoff: '2025-09-02T11:59:59' });
  assert.equal(beforeEnd.candles.length, 3);
  assert.equal(beforeEnd.markers.length, 1);
  assert.equal(beforeEnd.candles.at(-1).isPartial, true);
  const atEnd = selectChartData({ ...options, cutoff: '2025-09-02T12:00' });
  assert.equal(atEnd.candles.length, 3);
  assert.equal(atEnd.markers[0].id, 'DEMO-01');
  assert.equal(atEnd.currentBar, null);
  for (const cutoff of ['2025-09-02T12:00+08:00', '2025-09-02T04:00:00Z', '2025-09-01T21:00:00-07:00']) {
    assert.deepEqual(selectChartData({ ...options, cutoff }), atEnd);
  }
  const newDay = selectChartData({ ...options, cutoff: '2025-09-02T00:00' });
  assert.equal(newDay.candles.length, 2);
  assert.deepEqual(selectChartData({ ...options, cutoff: '2025-09-01T16:00Z' }), newDay);
  const opening = selectChartData({ ...options, cutoff: '2025-09-01T09:30' });
  assert.deepEqual(opening.currentBar.ohlc, { open: 39.6, high: 39.6, low: 39.6, close: 39.6 });
  assert.deepEqual(opening.markers, []);
  assert.deepEqual(selectChartData({ ...options, cutoff: '2025-02-30T10:00' }), { candles: [], markers: [] });
});

test('4-hour markers use numeric window starts and numeric grouping preserves order and traceability', () => {
  const data = selectChartData({ mode: 'sample', trades: sampleTrades, interval: '4H' });
  assert.deepEqual(data.markers.map((marker) => marker.time), [
    Date.parse('2025-09-02T08:00:00+08:00') / 1000,
    Date.parse('2025-09-08T08:00:00+08:00') / 1000,
    Date.parse('2025-09-18T12:00:00+08:00') / 1000,
  ]);
  const input = [data.markers[2], data.markers[0], { ...data.markers[0], id: 'EXTRA-BUY' }, data.markers[1]];
  const snapshot = JSON.stringify(input);
  const grouped = groupChartMarkers(input);
  assert.deepEqual(grouped.map((marker) => marker.time), data.markers.map((marker) => marker.time));
  assert.equal(grouped[0].text, 'B×2');
  assert.deepEqual(grouped[0].tradeIds, ['DEMO-01', 'EXTRA-BUY']);
  assert.equal(JSON.stringify(input), snapshot);
  assert.deepEqual(selectChartData({ mode: 'import', trades: sampleTrades, interval: '4H' }), { candles: [], markers: [] });
  assert.deepEqual(selectChartData({ mode: 'sample', trades: sampleTrades.map((trade) => ({ ...trade, symbol: 'OTHER' })), interval: '4H' }), { candles: [], markers: [] });
});

test('explicit simulated minute path contains every example fill and never invents lunch, night or weekend observations', () => {
  assert.equal(sampleIntradayPoints.length, 14 * 242);
  assert.ok(Object.isFrozen(sampleIntradayPoints));
  for (const [index, point] of sampleIntradayPoints.entries()) {
    const local = new Date((point.time + 8 * 3600) * 1000).toISOString();
    const time = local.slice(11, 19), weekday = new Date(local).getUTCDay();
    assert.ok(weekday >= 1 && weekday <= 5);
    assert.ok(time >= '09:30:00' && time <= '11:30:00' || time >= '13:00:00' && time <= '15:00:00');
    assert.ok(Number.isFinite(point.price) && point.price > 0);
    if (index) assert.ok(point.time > sampleIntradayPoints[index - 1].time);
  }
  for (const trade of sampleTrades) {
    assert.equal(sampleIntradayPoints.find(point => point.time === Date.parse(`${trade.time}+08:00`) / 1000).price, trade.price);
  }
});

test('full replay exactly reconciles to every original 4-hour and day candle, and weekly/monthly OHLC', () => {
  const options = { mode: 'sample', trades: sampleTrades, showFuture: false, cutoff: '2025-09-18T16:00' };
  assert.deepEqual(selectChartData({ ...options, interval: '4H' }).candles, sampleFourHourCandles);
  assert.deepEqual(selectChartData({ ...options, interval: '1D' }).candles, sampleCandles);
  const ohlc = ({ time, open, high, low, close, sourceFrom, sourceTo, sourceCount }) => ({ time, open, high, low, close, sourceFrom, sourceTo, sourceCount });
  for (const interval of ['1W', '1M']) {
    assert.deepEqual(selectChartData({ ...options, interval }).candles.map(ohlc), aggregateCandles(sampleCandles, interval).map(ohlc));
  }
});

test('exact trade boundary adds its current quote and marker, while prior seconds cannot include it', () => {
  for (const interval of ['4H', '1D', '1W', '1M']) {
    const options = { mode: 'sample', trades: sampleTrades, showFuture: false, interval };
    const before = selectChartData({ ...options, cutoff: '2025-09-08T09:59:59' });
    const at = selectChartData({ ...options, cutoff: '2025-09-08T10:00' });
    assert.equal(before.markers.some(marker => marker.id === 'DEMO-02'), false);
    assert.equal(at.markers.some(marker => marker.id === 'DEMO-02'), true);
    assert.equal(at.candles.at(-1).close, 42);
    assert.equal(at.candles.at(-1).isPartial, true);
    assert.equal(at.candles.at(-1).lastObservedAt, '2025-09-08T10:00:00+08:00');
    assert.equal(at.markers.some(marker => marker.id === 'DEMO-03'), false);
  }
});

test('lunch reuses the last observed quote without adding observations, and daily close ends partial status', () => {
  const options = { mode: 'sample', trades: sampleTrades, showFuture: false };
  const lunch = selectChartData({ ...options, cutoff: '2025-09-08T12:30' });
  assert.equal(lunch.candles.at(-1).lastObservedAt, '2025-09-08T11:30:00+08:00');
  assert.equal(lunch.candles.at(-1).isPartial, true);
  const lunchtime4h = selectChartData({ ...options, interval: '4H', cutoff: '2025-09-08T12:30' });
  assert.equal(lunchtime4h.candles.length, 11);
  assert.equal(lunchtime4h.currentBar, null);
  const close = selectChartData({ ...options, cutoff: '2025-09-08T15:00' });
  assert.equal(close.currentBar, null);
  assert.deepEqual(close.candles.at(-1), sampleCandles.find(bar => bar.time === '2025-09-08'));
  const weekend = selectChartData({ ...options, cutoff: '2025-09-06T10:00' });
  assert.equal(weekend.candles.at(-1).time, '2025-09-05');
  assert.equal(weekend.currentBar, null);
});
