import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTradesCsv, summarizeTrades, sampleCsv, sampleTrades } from '../src/domain.js';

const header = 'id,symbol,name,time,side,quantity,price,fee';
const csv = (rows) => [header, ...rows].join('\n');
const row = (overrides = {}) => ({ ...sampleTrades[0], ...overrides });
const rowCsv = (overrides = {}) => Object.values(row(overrides)).join(',');

test('standard sample CSV parses all three constructed trades', () => {
  const result = parseTradesCsv(sampleCsv);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.trades, sampleTrades);
});

test('PapaParse preserves quoted commas, quotes, and embedded newlines', () => {
  const result = parseTradesCsv(csv(['Q1,DEMO001,"远川,""科技""\n演示",2025-09-02T09:45,buy,500,40,5']));
  assert.deepEqual(result.errors, []);
  assert.equal(result.trades[0].name, '远川,"科技"\n演示');
});

test('empty input, absent rows, missing columns, and absent values block import', () => {
  for (const input of ['', '   ', header, 'id,symbol\n1,DEMO001', csv([rowCsv({ fee: '' })])]) {
    const result = parseTradesCsv(input);
    assert.equal(result.trades.length, 0);
    assert.ok(result.errors.length > 0);
  }
});

test('duplicate ids and duplicated execution content block the entire import', () => {
  for (const extra of [rowCsv({ price: 41 }), rowCsv({ id: 'DIFFERENT-ID' })]) {
    const result = parseTradesCsv(csv([rowCsv(), extra]));
    assert.deepEqual(result.trades, []);
    assert.match(result.errors.join(' '), /重复/);
  }
});

test('strict local dates reject normalized impossible dates and timezone ambiguity', () => {
  for (const time of ['2025-02-29T10:00', '2025-04-31T10:00', '2025-13-01T10:00', '2025-09-02T24:00', '2025-09-02T10:60', '2025-09-02', '2025-09-02T10:00Z', '2025-09-02T10:00+08:00']) {
    assert.ok(parseTradesCsv(csv([rowCsv({ time })])).errors.length > 0, time);
  }
  assert.equal(parseTradesCsv(csv([rowCsv({ time: '2024-02-29 10:00:00' })])).trades[0].time, '2024-02-29T10:00');
});

test('invalid side, nonpositive or nonfinite numbers, and negative fee are rejected', () => {
  for (const overrides of [{ side: 'BUY' }, { price: 0 }, { quantity: -1 }, { fee: -1 }, { price: 'Infinity' }, { quantity: 'NaN' }, { price: '0x20' }, { price: '999999999999999999999999999999999' }]) {
    assert.ok(parseTradesCsv(csv([rowCsv(overrides)])).errors.length > 0);
  }
});

test('one-instrument and 500-record limit are enforced', () => {
  assert.match(parseTradesCsv(csv([rowCsv(), rowCsv({ id: 'B', symbol: 'OTHER' })])).errors.join(' '), /一个标的/);
  const many = Array.from({ length: 501 }, (_, index) => rowCsv({ id: `R${index}`, quantity: index + 1 }));
  assert.match(parseTradesCsv(csv(many)).errors.join(' '), /500/);
});

test('malformed quotes, duplicate columns, and column count mismatches block import', () => {
  for (const input of [csv(['R1,DEMO001,"unclosed']), `${header},fee\n${rowCsv()},5`, csv([`${rowCsv()},extra`])]) {
    assert.deepEqual(parseTradesCsv(input).trades, []);
    assert.ok(parseTradesCsv(input).errors.length > 0);
  }
});

test('one closed cycle reports exact cash amounts and explicitly defined return denominator', () => {
  const snapshot = JSON.stringify(sampleTrades);
  const result = summarizeTrades([...sampleTrades].reverse());
  assert.equal(result.buyAmount, 32600);
  assert.equal(result.sellAmount, 36800);
  assert.equal(result.fees, 33.4);
  assert.equal(result.netPnl, 4166.6);
  assert.equal(result.returnPct, 416660 / 3261000 * 100);
  assert.equal(result.position, 0);
  assert.equal(result.isComplete, true);
  assert.deepEqual(result.issues, []);
  assert.equal(JSON.stringify(sampleTrades), snapshot);
});

test('decimal cent arithmetic and fractional quantities avoid floating-point residuals', () => {
  const trades = [
    row({ id: 'A', quantity: 0.1, price: 10.05, fee: 0 }),
    row({ id: 'B', time: '2025-09-03T10:00', quantity: 0.2, price: 10, fee: 0 }),
    row({ id: 'C', time: '2025-09-04T10:00', side: 'sell', quantity: 0.3, price: 11, fee: 0 }),
  ];
  const result = summarizeTrades(trades);
  assert.equal(result.buyAmount, 3.01);
  assert.equal(result.sellAmount, 3.3);
  assert.equal(result.netPnl, 0.29);
  assert.equal(result.position, 0);
  assert.equal(result.isComplete, true);
  const small = parseTradesCsv(csv([
    rowCsv({ id: 'SMALL-BUY', quantity: '0.00000001', price: 1000000, fee: 0 }),
    rowCsv({ id: 'SMALL-SELL', time: '2025-09-03T10:00', side: 'sell', quantity: '0.00000001', price: 2000000, fee: 0 }),
  ]));
  assert.deepEqual(small.errors, []);
  assert.equal(summarizeTrades(small.trades).netPnl, 0.01);
});

test('an open position never produces an exact cycle P&L or return', () => {
  const result = summarizeTrades(sampleTrades.slice(0, 2));
  assert.equal(result.position, 800);
  assert.equal(result.isComplete, false);
  assert.equal(result.netPnl, null);
  assert.equal(result.returnPct, null);
  assert.match(result.issues.join(' '), /尚未清仓/);
});

test('sell-first, overselling, and a trailing open cycle preserve unknown overall P&L', () => {
  const examples = [
    [row({ side: 'sell' })],
    [sampleTrades[0], row({ id: 'OVER', time: '2025-09-03T10:00', side: 'sell', quantity: 501 })],
    [...sampleTrades, { ...sampleTrades[0], id: 'OPEN-2', time: '2025-10-02T09:45' }],
  ];
  for (const input of examples) {
    const result = summarizeTrades(input);
    assert.equal(result.isComplete, false);
    assert.equal(result.netPnl, null);
    assert.equal(result.returnPct, null);
    assert.ok(result.issues.length > 0);
  }
});

test('multiple completed cycles add exact cash P&L and fees while keeping separate return denominators', () => {
  const second = sampleTrades.map(trade => ({ ...trade, id: `${trade.id}-2`, time: trade.time.replace('2025-09', '2025-10') }));
  const result = summarizeTrades([...sampleTrades, ...second]);
  assert.equal(result.isComplete, true); assert.equal(result.cycleCount, 2);
  assert.equal(result.netPnl, 8333.2); assert.equal(result.fees, 66.8); assert.equal(result.returnPct, null);
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.cycles.map(cycle => cycle.netPnl), [4166.6, 4166.6]);
  assert.ok(result.cycles.every(cycle => cycle.returnPct === 416660 / 3261000 * 100));
  assert.deepEqual(result.cycles[1].tradeIds, second.map(trade => trade.id));
  assert.deepEqual(summarizeTrades([...second, ...sampleTrades].reverse()), result);
});

test('out-of-order executions yield the same cycle after chronological sorting', () => {
  const chronological = summarizeTrades(sampleTrades);
  for (const order of [[1, 2, 0], [2, 0, 1], [2, 1, 0]]) {
    assert.deepEqual(summarizeTrades(order.map((index) => sampleTrades[index])), chronological);
  }
});

test('same-time mixed directions remain readable but never infer sequence or complete P&L from CSV order', () => {
  const sameTime = [
    row({ id: 'SAME-BUY', quantity: 500 }),
    row({ id: 'SAME-SELL', side: 'sell', quantity: 200 }),
  ];
  const expected = summarizeTrades(sameTime);
  assert.equal(expected.position, 300);
  assert.equal(expected.netPnl, null);
  assert.equal(expected.returnPct, null);
  assert.equal(expected.isComplete, false);
  assert.match(expected.issues.join(' '), /同一时刻.*无法确定成交顺序/);
  assert.deepEqual(summarizeTrades([...sameTime].reverse()), expected);
  const parsed = parseTradesCsv(csv(sameTime.map((trade) => Object.values(trade).join(','))));
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.trades.length, 2);
  const flat = [sameTime[0], { ...sameTime[1], quantity: 500 }];
  assert.equal(summarizeTrades(flat).position, 0);
  assert.equal(summarizeTrades(flat).netPnl, null);
  assert.equal(summarizeTrades(flat).isComplete, false);
  const sameSide = [sampleTrades[0], { ...sampleTrades[1], time: sampleTrades[0].time }, sampleTrades[2]];
  assert.equal(summarizeTrades(sameSide).isComplete, true);
});
