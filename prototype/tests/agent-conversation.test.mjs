import test from 'node:test';
import assert from 'node:assert/strict';
import { canRetryRequest, confirmPendingTrades, conversationContext, conversationHistory, conversationScopeKey, messageIsCurrent, parseRequestText, parseResponseText, pendingFromParse, reviewMessageResult } from '../src/agent-conversation-state.js';
import { modelIdentity } from '../src/model-connection.js';

const model = { mode: 'live', provider: 'openai-compatible', model: 'model-a', auth: 'api', baseUrl: 'https://api.deepseek.com/v1' };
const otherModel = { ...model, baseUrl: 'https://openrouter.ai/api/v1' };
const trade = { id: 'real-1', symbol: '600000', name: '浦发银行', time: '2025-09-02T09:45', side: 'buy', quantity: 100, price: 12, fee: null };
const conversation = { id: 'conversation-1', trades: [trade, { ...trade, id: 'real-2', time: '2025-09-03T10:00' }], selectedIds: ['real-1'], contexts: { 'real-1': { reason: '当前理由' }, 'real-2': { reason: '未选理由' } }, origin: '用户导入', marketMode: 'import', evidence: [{ id: 'raw-1', tradeId: 'real-1', type: 'event' }, { id: 'raw-2', tradeId: 'real-2', type: 'event' }], marketData: null, contextRevision: 2, messages: [], draft: '', pendingTrades: null, lastRequest: null };
const message = (id, overrides = {}) => ({ id, role: 'assistant', text: '当前回复', contextRevision: 2, modelSignature: modelIdentity(model), ...overrides });

test('run context includes only selected raw material and excludes message-generated evidence', () => {
  const input = { ...conversation, messages: [message('answer', { evidence: [{ id: 'derived', tradeId: 'real-1' }] })] };
  const actual = conversationContext(input);
  assert.deepEqual(actual.trades, [trade]);
  assert.deepEqual(Object.keys(actual.contexts), ['real-1']);
  assert.deepEqual(actual.evidence.map(item => item.id), ['raw-1']);
  const empty = conversationContext({ ...input, selectedIds: [], marketData: { bars: [] } });
  assert.deepEqual(empty.trades, []); assert.deepEqual(empty.evidence, []); assert.equal(empty.marketData, null);
});

test('scope changes for selection, background, market data, model endpoint and revision but not draft', () => {
  const initial = conversationScopeKey(conversation, model);
  assert.equal(initial, conversationScopeKey({ ...conversation, draft: '仍在输入' }, model));
  assert.notEqual(initial, conversationScopeKey({ ...conversation, selectedIds: ['real-2'] }, model));
  assert.notEqual(initial, conversationScopeKey({ ...conversation, contexts: { 'real-1': { reason: '改动' } } }, model));
  assert.notEqual(initial, conversationScopeKey({ ...conversation, marketData: { bars: [{ close: 12 }] } }, model));
  assert.notEqual(initial, conversationScopeKey({ ...conversation, contextRevision: 3 }, model));
  assert.notEqual(initial, conversationScopeKey(conversation, otherModel));
});

test('history never feeds old material or a same-name different endpoint answer into a new run', () => {
  const messages = [message('old', { contextRevision: 1 }), message('other', { modelSignature: modelIdentity(otherModel) }), message('current'), message('sending', { role: 'user', text: '本轮问题' })];
  const before = structuredClone(messages);
  assert.deepEqual(conversationHistory(messages, conversation, model, 'sending'), [{ role: 'assistant', text: '当前回复' }]);
  assert.deepEqual(messages, before);
  assert.equal(messageIsCurrent(messages[1], conversation, model), false);
});

test('initial user reasons survive trade confirmation and model changes as explicitly unverified historical context', () => {
  const messages = [message('initial', { role: 'user', text: '因为看到了订单消息，我决定加仓。', contextRevision: 0, modelSignature: modelIdentity(otherModel) }), message('old-answer', { contextRevision: 0 }), message('current-question', { role: 'user', text: '核对这次决定' })];
  const history = conversationHistory(messages, conversation, model, 'current-question');
  assert.equal(history.length, 1); assert.equal(history[0].role, 'user');
  assert.match(history[0].text, /因为看到了订单消息/);
  assert.match(history[0].text, /现在回忆/); assert.match(history[0].text, /可能属于此前材料/); assert.match(history[0].text, /冲突先问/);
  assert.equal(messages[0].text, '因为看到了订单消息，我决定加仓。');
});

test('request history is bounded without deleting stored messages', () => {
  const messages = Array.from({ length: 190 }, (_, index) => message(`m-${index}`, { text: '文'.repeat(8000) }));
  const history = conversationHistory(messages, conversation, model);
  assert.ok(JSON.stringify(history).length <= 30000);
  assert.equal(history.length, 3);
  assert.equal(messages.length, 190); assert.equal(messages[0].text.length, 8000);
});

test('parse retains unknown numbers and explicit questions and warnings, without assumed trades', () => {
  const result = { trades: [{ ...trade, id: null, quantity: null, price: null, fee: null }], questions: ['数量是多少？'], warnings: ['手续费待确认'] };
  const pending = pendingFromParse(result);
  assert.equal(pending.trades[0].id, 'AI-1');
  assert.equal(pending.trades[0].quantity, null); assert.equal(pending.trades[0].price, null); assert.equal(pending.trades[0].fee, null);
  assert.match(parseResponseText(result, pending), /数量是多少/); assert.match(parseResponseText(result, pending), /手续费待确认/);
  assert.throws(() => confirmPendingTrades({ ...conversation, trades: [], pendingTrades: pending }), /待补充/);
  assert.equal(result.trades[0].id, null);
});

test('confirmation requires valid candidates and makes a fresh scope while keeping history intact', () => {
  const messages = [message('past')];
  const input = { ...conversation, trades: [], messages, pendingTrades: pendingFromParse({ trades: [{ ...trade, price: null, fee: null }], questions: [], warnings: [] }) };
  const patch = confirmPendingTrades(input);
  assert.equal(patch.contextRevision, 3); assert.deepEqual(patch.selectedIds, ['real-1']);
  assert.equal(patch.trades[0].price, null); assert.equal(patch.trades[0].fee, null);
  assert.equal(patch.pendingTrades, null); assert.equal(patch.origin, '对话补充');
  assert.equal(patch.title, '浦发银行复盘');
  assert.deepEqual(patch.contexts, {}); assert.deepEqual(patch.evidence, []); assert.equal(patch.marketData, null);
  assert.equal(Object.hasOwn(patch, 'messages'), false); assert.equal(input.messages, messages);
});

test('confirming candidates retains an explicitly named conversation title', () => {
  const input = { ...conversation, title: '九月执行纪律', trades: [], pendingTrades: pendingFromParse({ trades: [trade] }) };
  assert.equal(Object.hasOwn(confirmPendingTrades(input), 'title'), false);
});

test('confirmation blocks duplicate, impossible-date and replaced-context candidates', () => {
  const empty = { ...conversation, trades: [] };
  const pending = trades => ({ trades, questions: [], warnings: [] });
  assert.throws(() => confirmPendingTrades({ ...empty, pendingTrades: pending([trade, { ...trade, id: 'real-2' }]) }), /重复/);
  assert.throws(() => confirmPendingTrades({ ...empty, pendingTrades: pending([{ ...trade, time: '2025-02-30T12:00' }]) }), /待补充/);
  assert.throws(() => confirmPendingTrades({ ...empty, pendingTrades: pending([{ ...trade, id: null }]) }), /编号/);
  assert.throws(() => confirmPendingTrades({ ...conversation, pendingTrades: pending([trade]) }), /已有成交/);
  assert.throws(() => confirmPendingTrades({ ...empty, pendingTrades: pending([{ ...trade, quantity: 10000000000, price: 1000000 }]) }), /金额超过/);
});

test('review message preserves bounded market evidence metadata without copying raw extra fields', () => {
  const evidence = { id: 'market:real-1:current', tradeId: 'real-1', type: 'market', title: '当前根未知', text: '缺少盘中行情', source: '用户提供日线', timeClass: 'unknown', marketState: 'unknown-current', cutoff: trade.time, barCount: 2, rangeStart: '2025-09-01', rangeEnd: '2025-09-02', apiKey: 'must-not-copy' };
  const result = { text: '当前根仍需盘中记录。', evidence: [evidence], evidenceIds: [evidence.id], facts: [], interpretations: [], suggestions: [], learning: null };
  const actual = reviewMessageResult(result, conversationContext(conversation));
  assert.equal(actual.evidence[0].marketState, 'unknown-current'); assert.equal(actual.evidence[0].cutoff, trade.time);
  assert.equal(actual.evidence[0].barCount, 2); assert.equal(actual.evidence[0].rangeStart, '2025-09-01');
  assert.equal(Object.hasOwn(actual.evidence[0], 'apiKey'), false);
  assert.equal(actual.refs[0].evidenceId, evidence.id);
});

test('parse follow-up carries edited candidates as unconfirmed data without turning null into zero', () => {
  const pending = pendingFromParse({ trades: [{ ...trade, price: null }] });
  const text = parseRequestText('数量改为 200', pending);
  assert.match(text, /尚未确认/); assert.match(text, /"price":null/); assert.match(text, /数量改为 200/);
  assert.equal(parseRequestText('单独描述', null), '单独描述');
  assert.equal(pending.trades[0].quantity, 100);
});

test('retry reuses only unfinished current-scope current-model requests', () => {
  const request = { id: 'u1', text: '核对理由', task: 'review', contextRevision: 2, modelSignature: modelIdentity(model) };
  const current = { ...conversation, lastRequest: request, messages: [message('u1', { role: 'user' })] };
  assert.equal(canRetryRequest(current, model), true);
  assert.equal(canRetryRequest(current, otherModel), false);
  assert.equal(canRetryRequest({ ...current, contextRevision: 3 }, model), false);
  assert.equal(canRetryRequest({ ...current, messages: [...current.messages, message('u1-answer')] }, model), false);
  assert.equal(canRetryRequest({ ...current, trades: [] }, model), false);
  assert.equal(canRetryRequest({ ...current, messages: [] }, model), false);
});
