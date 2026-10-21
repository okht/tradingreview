import test from 'node:test';
import assert from 'node:assert/strict';
import { sampleTrades, defaultLearning } from '../src/domain.js';
import { JOURNEY_KEY, createJourney, readJourney, replaceJourneyTrades, questionOptions } from '../src/journey-state.js';

const storageOf = value => ({ getItem(key) { assert.equal(key, JOURNEY_KEY); return JSON.stringify(value); } });
const ready = () => ({
  ...createJourney(), connected: '示例模型', trades: sampleTrades.map(t => ({ ...t })),
  selectedIds: sampleTrades.map(t => t.id), step: 3, reached: 3, marketMode: 'sample',
});
const fill = (id, time, side, quantity) => ({ ...sampleTrades[0], id, time, side, quantity });

test('new journeys do not share mutable drafts or record collections', () => {
  const a = createJourney();
  const b = createJourney();
  a.learning.title = '仅修改这次草稿';
  a.savedItems.push({ id: 'old' });
  a.contexts['DEMO-01'] = { reason: '回忆' };
  assert.deepEqual(b.learning, defaultLearning);
  assert.deepEqual(b.savedItems, []);
  assert.deepEqual(b.contexts, {});
});

test('missing, unreadable and malformed local storage safely starts a new journey', () => {
  for (const storage of [undefined, null, { getItem() { return null; } }, { getItem() { return '{broken'; } }, { getItem() { throw new Error('denied'); } }]) {
    assert.deepEqual(readJourney(storage), createJourney());
  }
});

test('invalid versions, step ranges and top-level collections are rejected on restore', () => {
  for (const patch of [
    { version: 2 }, { step: -1 }, { step: 6 }, { step: 1.5 }, { reached: 2 }, { reached: 6 },
    { trades: null }, { selectedIds: {} }, { savedItems: null }, { trades: [] },
  ]) assert.deepEqual(readJourney(storageOf({ ...ready(), ...patch })), createJourney(), JSON.stringify(patch));
});

test('malformed nested saved records cannot reach components that dereference them', () => {
  for (const patch of [
    { trades: [null] },
    { trades: [{ ...sampleTrades[0], time: null }] },
    { contexts: null },
    { contexts: { 'DEMO-01': { reason: { text: 'bad shape' } } } },
    { learning: null },
    { learning: { ...defaultLearning, title: null } },
    { question: null },
    { savedItems: [null] },
  ]) assert.deepEqual(readJourney(storageOf({ ...ready(), ...patch })), createJourney(), JSON.stringify(patch));
});

test('valid saved progress preserves recalled context and deliberately unknown price or fee', () => {
  const state = ready();
  state.trades[0] = { ...state.trades[0], price: null, fee: null };
  state.contexts = { 'DEMO-01': { reason: '', plan: '', source: '现在回忆', unknown: true } };
  state.learning = { ...defaultLearning, title: '我的草稿' };
  assert.deepEqual(readJourney(storageOf(state)), state);
});

test('replacing the trading dataset clears prior review state while preserving saved checks and model setup', () => {
  const savedItems = [{ ...defaultLearning, id: 'CHECK-1', question: '旧问题', savedAt: '2026-10-21T00:00:00Z' }];
  const before = {
    ...ready(), step: 5, reached: 5, contexts: { 'DEMO-02': { reason: '旧数据的理由' } }, contextIndex: 2,
    question: '旧问题', questionKind: 'add', analyzed: true, correction: '旧问题的更正',
    reviewChat: { messages: [{ role: 'assistant', text: '旧数据的分析' }] },
    learning: { ...defaultLearning, title: '旧草稿' }, savedItems, activeLearningId: 'CHECK-1',
    nextDecision: '基于旧检查项的下一次决定', nextChecked: true,
  };
  const snapshot = structuredClone(before);
  const incoming = [
    fill('NEW-2', '2025-10-03T10:00', 'sell', 500),
    fill('NEW-1', '2025-10-01T10:00', 'buy', 500),
  ];
  const next = replaceJourneyTrades(before, incoming, 'import', '新 CSV');
  assert.deepEqual(next.trades.map(t => t.id), ['NEW-1', 'NEW-2']);
  assert.deepEqual([...next.selectedIds].sort(), ['NEW-1', 'NEW-2']);
  assert.equal(next.marketMode, 'import');
  assert.equal(next.origin, '新 CSV');
  assert.deepEqual(next.contexts, {});
  assert.equal(next.contextIndex, 0);
  assert.equal(next.question, '');
  assert.equal(next.questionKind, '');
  assert.equal(next.correction, '');
  assert.equal(next.analyzed, false);
  assert.equal(next.reviewChat, null);
  assert.equal(next.activeLearningId, null);
  assert.deepEqual(next.learning, defaultLearning);
  assert.deepEqual(next.savedItems, savedItems);
  assert.equal(next.connected, before.connected);
  assert.equal(next.provider, before.provider);
  assert.equal(next.step, 2);
  assert.equal(next.reached, 2);
  assert.deepEqual(before, snapshot);
  assert.deepEqual(incoming.map(t => t.id), ['NEW-2', 'NEW-1']);
});

test('a new trading dataset cannot inherit a prior next-decision completion state', () => {
  const next = replaceJourneyTrades({ ...ready(), nextDecision: '旧决定', nextChecked: true }, sampleTrades, 'sample', '示例');
  assert.equal(next.nextDecision, '');
  assert.equal(next.nextChecked, false);
});

test('a single buy offers entry and holding questions without invented additional buys or exits', () => {
  const options = questionOptions([sampleTrades[0]]);
  assert.ok(options.some(option => option.id === 'entry'));
  assert.ok(options.some(option => option.id === 'holding'));
  assert.ok(options.every(option => option.tradeId === sampleTrades[0].id));
  assert.ok(options.every(option => !['add', 'exit'].includes(option.id) && !option.text.includes('加仓')));
});

test('sample add and exit questions reference the matching execution rather than row labels', () => {
  const options = questionOptions(sampleTrades);
  assert.equal(options.find(option => option.id === 'add')?.tradeId, 'DEMO-02');
  assert.equal(options.find(option => option.id === 'exit')?.tradeId, 'DEMO-03');
});

test('a reopened position after full liquidation is not presented as an additional purchase', () => {
  const trades = [fill('OPEN-1', '2025-09-01T10:00', 'buy', 500), fill('CLOSE-1', '2025-09-02T10:00', 'sell', 500), fill('OPEN-2', '2025-09-03T10:00', 'buy', 300)];
  const options = questionOptions(trades);
  assert.ok(options.every(option => option.id !== 'add' && !option.text.includes('加仓')));
});

test('a purchase after a partial sale still adds to an existing position', () => {
  const trades = [fill('OPEN', '2025-09-01T10:00', 'buy', 500), fill('TRIM', '2025-09-02T10:00', 'sell', 200), fill('ADD', '2025-09-03T10:00', 'buy', 300)];
  assert.equal(questionOptions(trades).find(option => option.id === 'add')?.tradeId, 'ADD');
});

test('sell-only or empty selections do not invent a buy decision', () => {
  const sellOnly = questionOptions([sampleTrades[2]]);
  assert.ok(sellOnly.every(option => !['entry', 'add'].includes(option.id) && !/买入时|加仓/.test(option.text)));
  assert.ok(sellOnly.every(option => option.tradeId === sampleTrades[2].id));
  assert.deepEqual(questionOptions([]), []);
});
