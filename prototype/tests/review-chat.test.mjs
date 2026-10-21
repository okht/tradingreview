import test from 'node:test';
import assert from 'node:assert/strict';
import { sampleTrades } from '../src/domain.js';
import { EXAMPLE_CONTEXT } from '../src/journey-state.js';
import { reviewContextKey, createReviewChat, restoreReviewChat, sendReviewMessage } from '../src/review-chat-state.js';

const context = (patch = {}) => ({ trades: structuredClone(sampleTrades), contexts: structuredClone(EXAMPLE_CONTEXT), marketMode: 'sample', origin: '构造示例', ...patch });
const last = thread => thread.messages.at(-1);
function choose(thread, ctx, id) {
  const pick = last(thread).suggestions.find(item => item.id === id);
  assert.ok(pick, `available suggestion ${id}`);
  return sendReviewMessage({ ...thread, draft: pick.text, pick: { ...pick } }, ctx);
}
function write(thread, ctx, draft) { return sendReviewMessage({ ...thread, draft, pick: null }, ctx); }

test('opening offers the actual scope topics and empty scope remains inactive', () => {
  const ctx = context();
  const thread = createReviewChat(ctx);
  assert.deepEqual(last(thread).suggestions.map(item => item.id), ['add', 'exit', 'learn']);
  assert.equal(thread.messages.length, 1);
  assert.equal(last(thread).allowLearning, false);
  assert.equal(thread.draft, '');
  assert.equal(thread.pick, null);
  assert.match(last(thread).text, /3 笔交易/);
  const empty = context({ trades: [] });
  const fresh = createReviewChat(empty);
  assert.deepEqual(last(fresh).suggestions, []);
  assert.equal(write(fresh, empty, '开始').messages.length, 1);
});

test('context key is deterministic across display order and irrelevant background changes', () => {
  const ctx = context();
  const reordered = context({ trades: [...sampleTrades].reverse(), contexts: { extra: { reason: '范围外记录' }, ...EXAMPLE_CONTEXT } });
  assert.equal(reviewContextKey(ctx), reviewContextKey(reordered));
  assert.equal(reviewContextKey(ctx), reviewContextKey(structuredClone(ctx)));
});

test('trade fields, scope, source and selected background changes invalidate earlier analysis', () => {
  const ctx = context();
  const thread = choose(createReviewChat(ctx), ctx, 'add');
  const variants = [context({ trades: sampleTrades.slice(0, 2) }), context({ marketMode: 'import' }), context({ origin: '另一份 CSV' })];
  for (const [field, value] of [['name', '其他名称'], ['symbol', 'OTHER'], ['time', '2025-09-02T10:00'], ['side', 'sell'], ['quantity', 501], ['price', 41], ['fee', 6], ['id', 'OTHER-ID']]) {
    const changed = context();
    changed.trades[0][field] = value;
    variants.push(changed);
  }
  for (const [field, value] of [['reason', '另一个理由'], ['plan', '计划更新'], ['source', '当时记录'], ['reference', '原始笔记'], ['unknown', true]]) {
    const changed = context();
    changed.contexts['DEMO-02'][field] = value;
    variants.push(changed);
  }
  for (const changed of variants) {
    assert.notEqual(reviewContextKey(ctx), reviewContextKey(changed));
    assert.deepEqual(restoreReviewChat(thread, changed), createReviewChat(changed));
  }
});

test('known add example asks one time-specific question with traceable evidence', () => {
  const ctx = context();
  const thread = choose(createReviewChat(ctx), ctx, 'add');
  assert.equal(thread.messages.length, 3);
  assert.deepEqual(thread.topic, { kind: 'add', question: '这次加仓，符合原来的计划吗？', tradeId: 'DEMO-02' });
  assert.match(last(thread).text, /11:30/);
  assert.match(last(thread).text, /10:00/);
  assert.match(last(thread).text, /90 分钟/);
  assert.equal((last(thread).text.match(/？/g) ?? []).length, 1);
  assert.equal(last(thread).allowLearning, false);
  assert.ok(last(thread).refs.some(item => item.panel === 'evidence' && item.tradeId === 'DEMO-02'));
  assert.equal(last(thread).suggestions.length, 3);
  assert.equal(thread.draft, '');
  assert.equal(thread.pick, null);
});

test('the order example requires exact known reasoning and valid unchanged fixture fields', () => {
  const variations = [
    context({ contexts: {} }),
    context({ contexts: { ...EXAMPLE_CONTEXT, 'DEMO-02': { ...EXAMPLE_CONTEXT['DEMO-02'], unknown: true } } }),
    context({ contexts: { ...EXAMPLE_CONTEXT, 'DEMO-02': { ...EXAMPLE_CONTEXT['DEMO-02'], reason: '我没有因为订单消息买入' } } }),
    context({ contexts: { ...EXAMPLE_CONTEXT, 'DEMO-02': { ...EXAMPLE_CONTEXT['DEMO-02'], reason: '我看到了一个消息' } } }),
  ];
  for (const [field, value] of [['time', '2025-09-08T09:55'], ['time', '2025-09-08T99:00'], ['symbol', 'REAL001'], ['quantity', 301]]) {
    const changed = context();
    changed.trades[1][field] = value;
    variations.push(changed);
  }
  for (const ctx of variations) {
    const thread = choose(createReviewChat(ctx), ctx, 'add');
    assert.doesNotMatch(last(thread).text, /11:30|90 分钟/);
    assert.ok(last(thread).refs.every(item => item.panel !== 'evidence'));
  }
  const seconds = context();
  seconds.trades[1].time = '2025-09-08T10:00:00';
  assert.match(last(choose(createReviewChat(seconds), seconds, 'add')).text, /11:30/);
});

test('missing or unknown reasons prompt for the reason before interpreting a plan', () => {
  const ctx = context({ contexts: {} });
  const thread = choose(createReviewChat(ctx), ctx, 'add');
  assert.match(last(thread).text, /没有对应的理由/);
  assert.match(last(thread).text, /主要依据是什么/);
  assert.deepEqual(last(thread).suggestions.map(item => item.id), ['answer:reason:plan', 'answer:reason:record', 'answer:reason:unknown']);
});

test('predefined answer is current recollection and does not rewrite previous backgrounds', () => {
  const ctx = context();
  const before = structuredClone(ctx);
  const first = choose(createReviewChat(ctx), ctx, 'add');
  const firstSnapshot = structuredClone(first);
  const thread = choose(first, ctx, 'answer:time:earlier');
  assert.match(last(thread).text, /这轮补充/);
  assert.match(last(thread).text, /可能解释/);
  assert.match(last(thread).text, /尚未|还需要/);
  assert.equal(last(thread).allowLearning, true);
  assert.equal(thread.topic.kind, 'add');
  assert.deepEqual(ctx, before);
  assert.deepEqual(first, firstSnapshot);
  assert.ok(last(thread).suggestions.length <= 3);
});

test('entry, exit, holding and learning produce only scope-relevant topics and references', () => {
  const fixtures = [
    ['entry', context({ trades: [sampleTrades[0]] }), 'DEMO-01'],
    ['holding', context({ trades: [sampleTrades[0]] }), 'DEMO-01'],
    ['exit', context({ trades: [sampleTrades[2]] }), 'DEMO-03'],
    ['learn', context(), 'DEMO-02'],
  ];
  for (const [kind, ctx, tradeId] of fixtures) {
    const thread = choose(createReviewChat(ctx), ctx, kind);
    assert.equal(thread.topic.kind, kind);
    assert.equal(thread.topic.tradeId, tradeId);
    assert.ok(last(thread).refs.every(item => ctx.trades.some(trade => trade.id === item.tradeId)));
    assert.equal(last(thread).allowLearning, kind === 'learn');
    if (kind !== 'learn') assert.equal((last(thread).text.match(/？/g) ?? []).length, 1);
  }
});

test('imported data never borrows sample announcements even when IDs and reasons match', () => {
  const ctx = context({ marketMode: 'import', origin: '用户 CSV' });
  let thread = choose(createReviewChat(ctx), ctx, 'add');
  assert.match(last(thread).text, /尚无对应行情或事件数据/);
  assert.doesNotMatch(last(thread).text, /11:30|90 分钟/);
  assert.ok(last(thread).refs.every(item => item.panel !== 'evidence'));
  thread = choose(thread, ctx, last(thread).suggestions[0].id);
  thread = choose(thread, ctx, 'deeper:records');
  assert.ok(thread.messages.flatMap(message => message.refs).every(item => item.panel !== 'evidence'));
  assert.doesNotMatch(last(thread).text, /11:30/);
});

test('free text is saved without automatic attribution and keeps an existing topic', () => {
  const ctx = context();
  const fresh = createReviewChat(ctx);
  const custom = write(fresh, ctx, '我看到订单公告才买的，你帮我判断一下');
  assert.equal(custom.topic.kind, 'custom');
  assert.equal(custom.topic.question, '我看到订单公告才买的，你帮我判断一下');
  assert.match(last(custom).text, /未对自由输入自动归因/);
  assert.doesNotMatch(last(custom).text, /11:30|90 分钟/);
  assert.equal(last(custom).allowLearning, false);
  const add = choose(fresh, ctx, 'add');
  const followup = write(add, ctx, '我现在想补充另一个说法');
  assert.deepEqual(followup.topic, add.topic);
  assert.equal(followup.messages.at(-2).text, '我现在想补充另一个说法');
  assert.match(last(followup).text, /未对自由输入自动归因/);
});

test('editing a picked suggestion or replaying an old suggestion becomes free input', () => {
  const ctx = context();
  const fresh = createReviewChat(ctx);
  const pick = last(fresh).suggestions[0];
  for (const state of [
    { ...fresh, pick, draft: `${pick.text} 我另有补充` },
    { ...fresh, pick: { id: pick.id, text: '不同文案' }, draft: '不同文案' },
    { ...fresh, pick: { id: 'not-current', text: pick.text }, draft: pick.text },
    { ...fresh, pick, draft: ` ${pick.text}` },
  ]) {
    const thread = sendReviewMessage(state, ctx);
    assert.equal(thread.topic.kind, 'custom');
    assert.match(last(thread).text, /未对自由输入自动归因/);
  }
  const first = choose(fresh, ctx, 'add');
  const replay = sendReviewMessage({ ...first, pick, draft: pick.text }, ctx);
  assert.equal(replay.topic.kind, 'add');
  assert.match(last(replay).text, /未对自由输入自动归因/);
});

test('selecting a new available topic updates the question and focused trade', () => {
  const ctx = context();
  let thread = choose(createReviewChat(ctx), ctx, 'add');
  thread = choose(thread, ctx, 'answer:time:unknown');
  thread = choose(thread, ctx, 'exit');
  assert.equal(thread.topic.kind, 'exit');
  assert.equal(thread.topic.tradeId, 'DEMO-03');
  assert.match(last(thread).text, /退出条件/);
});

test('valid persisted messages and draft restore detached, while stale picks are cleared', () => {
  const ctx = context();
  const thread = choose(createReviewChat(ctx), ctx, 'add');
  thread.pick = { ...last(thread).suggestions[0] };
  thread.draft = thread.pick.text;
  const restored = restoreReviewChat(thread, ctx);
  assert.deepEqual(restored, thread);
  restored.messages[0].text = '只修改副本';
  assert.notEqual(thread.messages[0].text, restored.messages[0].text);
  const stalePick = { ...thread, draft: '改过的内容' };
  const safe = restoreReviewChat(stalePick, ctx);
  assert.equal(safe.pick, null);
  assert.equal(safe.draft, '改过的内容');
  assert.equal(safe.messages.length, 3);
});

test('invalid shapes, missing fields, oversized content and broken references restore only a fresh chat', () => {
  const ctx = context();
  const good = choose(createReviewChat(ctx), ctx, 'add');
  const variants = [null, {}, { ...good, version: 2 }, { ...good, draft: undefined }, { ...good, draft: 'x'.repeat(6001) }, { ...good, topic: null }, { ...good, pick: [] }, { ...good, messages: [] }, { ...good, messages: good.messages.slice(0, 2) }];
  const mutate = fn => { const value = structuredClone(good); fn(value); variants.push(value); };
  mutate(value => { value.messages[2].refs[0].tradeId = 'OUTSIDE'; });
  mutate(value => { value.messages[2].refs[0].panel = 'unknown'; });
  mutate(value => { value.messages[2].refs[0].label = ''; });
  mutate(value => { value.messages[2].text = 'x'.repeat(12001); });
  mutate(value => { value.messages[2].role = 'system'; });
  mutate(value => { value.messages[2].id = value.messages[0].id; });
  mutate(value => { value.messages[2].allowLearning = 'true'; });
  mutate(value => { value.messages[2].suggestions[0].text = '篡改预设文案'; });
  mutate(value => { value.messages[1].refs = [value.messages[2].refs[0]]; });
  mutate(value => { value.topic.tradeId = 'OUTSIDE'; });
  mutate(value => { value.topic.question = '错误关联的问题'; });
  for (const value of variants) assert.deepEqual(restoreReviewChat(value, ctx), createReviewChat(ctx));
});

test('a forged imported thread cannot restore an announcement suggestion or evidence link', () => {
  const ctx = context({ marketMode: 'import' });
  const fresh = createReviewChat(ctx);
  const withSuggestion = structuredClone(fresh);
  withSuggestion.messages[0].suggestions = [{ id: 'answer:time:earlier', text: '我记得有更早的消息，还没找到记录' }];
  assert.deepEqual(restoreReviewChat(withSuggestion, ctx), fresh);
  const withRef = structuredClone(fresh);
  withRef.messages[0].refs = [{ panel: 'evidence', tradeId: 'DEMO-02', label: '伪造公告' }];
  assert.deepEqual(restoreReviewChat(withRef, ctx), fresh);
});

test('a stale dataset cannot send its old draft into the new conversation', () => {
  const ctx = context();
  const thread = { ...createReviewChat(ctx), draft: '上一段交易的补充' };
  const changed = context({ trades: [sampleTrades[0]] });
  assert.deepEqual(sendReviewMessage(thread, changed), createReviewChat(changed));
});

test('the 50-turn limit preserves every existing message and the unsent draft', () => {
  const ctx = context();
  let thread = choose(createReviewChat(ctx), ctx, 'learn');
  for (let index = 0; index < 49; index++) thread = choose(thread, ctx, 'deeper:records');
  assert.equal(thread.messages.length, 101);
  assert.equal(thread.messages[0].id, 'm-0');
  assert.equal(thread.messages[1].id, 'm-1');
  assert.equal(last(thread).id, 'm-100');
  assert.equal(new Set(thread.messages.map(message => message.id)).size, 101);
  assert.deepEqual(restoreReviewChat(thread, ctx), thread);
  const pick = { ...last(thread).suggestions[0] };
  const pending = { ...thread, draft: pick.text, pick };
  const result = sendReviewMessage(pending, ctx);
  assert.deepEqual(result, pending);
  assert.deepEqual(result.messages, thread.messages);
  assert.equal(result.draft, pick.text);
  assert.equal(last(result).id, 'm-100');
  const freeDraft = { ...thread, draft: '尚未发送的补充', pick: null };
  assert.deepEqual(sendReviewMessage(freeDraft, ctx), freeDraft);
  for (const message of thread.messages) {
    assert.ok(message.suggestions.length <= 3);
    assert.ok(message.refs.every(item => ctx.trades.some(trade => trade.id === item.tradeId)));
    assert.ok(!message.text.includes('·'));
  }
});

test('blank messages append nothing and direct state calls never mutate context or input thread', () => {
  const ctx = context();
  const before = structuredClone(ctx);
  const thread = createReviewChat(ctx);
  const snapshot = structuredClone(thread);
  assert.equal(write(thread, ctx, '  \n ').messages.length, 1);
  choose(thread, ctx, 'learn');
  assert.deepEqual(thread, snapshot);
  assert.deepEqual(ctx, before);
});
