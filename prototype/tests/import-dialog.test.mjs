import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptedImportTrades, accountCandidates, confirmStockMetadata, editedTrade, hasUnknownMarket, identifyImportCandidates, importGroups, importIssues, mergeImportCandidates, missingTradeFields, tradesToCsv, TRADE_CSV_TEMPLATE } from '../src/import-dialog-state.js';
import { validateContext } from '../server/contracts.js';

const trade = { id: 'T1', symbol: '600001', name: '测试记录', time: '2025-09-02T09:45', side: 'buy', quantity: 100, price: 10, fee: 1 };
test('download template contains only the eight-column header', () => {
  assert.equal(TRADE_CSV_TEMPLATE.trim().split('\n').length, 1);
  assert.equal(TRADE_CSV_TEMPLATE.trim(), 'id,symbol,name,time,side,quantity,price,fee');
});
test('editing preserves unknown cash fields and does not turn them into zero', () => {
  const edited = editedTrade({ ...trade, quantity: '100', price: '', fee: null });
  assert.equal(edited.price, null); assert.equal(edited.fee, null); assert.equal(edited.quantity, 100); assert.deepEqual(importIssues([edited]), []);
  assert.ok(importIssues([{ ...edited, quantity: null }]).length);
});
test('confirmation rejects duplicate executions, missing ids and mixed instruments', () => {
  assert.ok(importIssues([trade, { ...trade, id: 'T2' }]).some(text => text.includes('内容重复')));
  assert.ok(importIssues([{ ...trade, id: '' }]).some(text => text.includes('交易编号')));
  assert.ok(importIssues([trade, { ...trade, id: 'T2', symbol: '600002' }]).some(text => text.includes('一个标的')));
});
test('historical constructed identifiers are blocked before the production workspace accepts them', () => {
  assert.ok(importIssues([{ ...trade, id: 'DEMO-01' }]).some(text => text.includes('构造数据')));
  assert.ok(importIssues([{ ...trade, symbol: 'DEMO001' }]).some(text => text.includes('构造数据')));
  assert.ok(importIssues([{ ...trade, id: 'sample-trade' }]).some(text => text.includes('构造数据')));
});
test('account preview accepts only complete stock share metadata and explicit unknown cash fields', () => {
  const response = { currency: 'CNY', quantityUnit: 'share', assetType: 'stock', trades: [{ ...trade, fee: null }] };
  assert.equal(accountCandidates(response)[0].fee, null);
  for (const changed of [{ currency: 'USD' }, { quantityUnit: 'coin' }, { assetType: 'crypto' }]) assert.throws(() => accountCandidates({ ...response, ...changed }), /人民币股票/);
  const missing = { ...trade }; delete missing.fee;
  assert.throws(() => accountCandidates({ ...response, trades: [missing] }), /字段不完整/);
});
test('missing fields identify the exact information to ask for', () => {
  assert.deepEqual(missingTradeFields({ ...trade, time: '2026-10-21', quantity: null, price: null, fee: null }), ['成交日期和时间', '成交数量']);
  assert.deepEqual(missingTradeFields({ ...trade, time: '2026-02-30T09:30' }), ['成交日期和时间']);
  assert.ok(importIssues([{ ...trade, symbol: '', time: '' }]).some(text => text.includes('标的代码') && text.includes('成交日期和时间')));
});
test('groups retain every candidate while separating accounts and symbols', () => {
  const rows = [trade, { ...trade, id: 'T2', accountId: 'second' }, { ...trade, id: 'T3', symbol: '000001' }];
  const groups = importGroups(rows);
  assert.equal(groups.length, 3); assert.deepEqual(groups.flatMap(group => group.indices), [0, 1, 2]);
  assert.deepEqual(rows[0], trade);
});
test('AI refinement preserves manual edits and candidates omitted by the model', () => {
  const previous = [trade, { ...trade, id: 'T2', price: 20 }];
  const updated = mergeImportCandidates(previous, [{ ...trade, price: 99 }, { ...trade, id: 'T3' }], ['T1']);
  assert.equal(updated.length, 3); assert.equal(updated[0].price, 10); assert.equal(updated[1].price, 20);
  const duplicate = mergeImportCandidates([trade], [trade, { ...trade }]);
  assert.equal(duplicate.length, 2);
  assert.ok(importIssues(duplicate).some(value => value.includes('重复')));
});
test('candidates without an execution number get stable internal IDs without dropping duplicates', () => {
  const result = identifyImportCandidates([{ ...trade, id: null }, { ...trade, id: null }, trade, { ...trade }]);
  assert.equal(result.length, 4); assert.notEqual(result[0].id, result[1].id);
  assert.deepEqual(identifyImportCandidates([{ ...trade, id: null }])[0], result[0]);
  assert.equal(result[2].id, result[3].id);
});
test('market confirmation fills only unknown information and cannot convert foreign assets', () => {
  const unknown = { ...trade, accountId: null, currency: null, assetType: null, quantityUnit: null, feeCurrency: null, market: null, leverage: null, margin: null, positionSide: null };
  assert.equal(hasUnknownMarket(unknown), true);
  assert.ok(importIssues([unknown]).some(value => value.includes('费用币种待确认')));
  const confirmed = acceptedImportTrades([confirmStockMetadata(unknown)]);
  assert.deepEqual(importIssues(confirmed), []);
  assert.equal(validateContext({ trades: confirmed, contexts: {}, marketMode: 'import' }).trades[0].price, 10);
  const foreign = confirmStockMetadata({ ...unknown, currency: 'USD', feeCurrency: 'USDT', assetType: 'crypto', leverage: 5, positionSide: 'short' });
  assert.equal(foreign.currency, 'USD'); assert.equal(foreign.feeCurrency, 'USDT'); assert.equal(foreign.leverage, 5);
  assert.ok(importIssues([foreign]).some(value => value.includes('暂不支持')));
  assert.equal(acceptedImportTrades([{ ...unknown, fee: null }])[0].feeCurrency, undefined);
});
test('CSV export retains metadata and escapes spreadsheet formulas and quoted cells', () => {
  const csv = tradesToCsv([{ ...trade, name: '=SUM(1,2)', symbol: '  +cmd', accountId: '@SUM(A1)', market: 'SSE', feeCurrency: 'CNY' }]);
  assert.ok(csv.includes('feeCurrency')); assert.ok(csv.includes('market'));
  assert.ok(csv.includes('"\'=SUM(1,2)"')); assert.ok(csv.includes("'  +cmd")); assert.ok(csv.includes("'@SUM(A1)"));
  assert.ok(tradesToCsv([{ ...trade, name: 'quoted "name"' }]).includes('"quoted ""name"""'));
});
