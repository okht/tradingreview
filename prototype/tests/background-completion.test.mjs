import test from 'node:test';
import assert from 'node:assert/strict';
import { backgroundCompletion, completionForField } from '../src/background-completion.js';
import { acceptedSuggestionPatch } from '../src/background-preparation-state.js';
import { createWorkspace, validateWorkspace } from '../src/agent-workspace-state.js';

const trade = (id, day, extra = {}) => ({ id, name: '浦发银行', symbol: '600000', time: `2025-09-${day}T09:45`, side: 'buy', quantity: 100, price: 12, fee: 5, ...extra });
const conversation = (id, trades, contexts = {}) => ({ ...createWorkspace().conversations[0], id, trades, selectedIds: trades.map(item => item.id), contexts, origin: '用户文件', contextRevision: 1 });
const recall = (reason, plan = '') => ({ reason, plan, source: '现在回忆', recordedAt: '2026-10-22T12:00:00Z' });

test('confirmed history produces concrete inline reason and plan without saving or network access', () => {
  const earlier = conversation('earlier', [trade('old', '01')], { old: recall('我采用分批建仓。', '每次追加前检查剩余预算和仓位上限。') });
  const current = conversation('current', [trade('now', '02')]);
  const original = JSON.stringify([current, earlier]);
  const result = backgroundCompletion(current, 'now', [earlier, current]);
  assert.match(result.reason, /延续分批买入/);
  assert.match(result.plan, /剩余预算和仓位上限/);
  assert.doesNotMatch(result.reason + result.plan, /[？?]|请补充|待确认|AI草稿/);
  assert.equal(result.unknown, true);
  assert.deepEqual(result.memoryRefs, [{ conversationId: 'earlier', tradeId: 'old' }]);
  assert.equal(JSON.stringify([current, earlier]), original);
});

test('first trade still offers low-confidence action-based statements', () => {
  const current = conversation('current', [trade('now', '02')]);
  const result = backgroundCompletion(current, 'now');
  assert.equal(result.confidence, 'low');
  assert.match(result.reason, /先建立/);
  assert.match(result.plan, /再决定是否继续投入/);
  assert.doesNotMatch(result.reason + result.plan, /惯例|一直|历史偏好|[0-9]|公告|新闻/);
});

test('future trades, inactive fields, unsaved model drafts and messages never become preference memory', () => {
  const current = conversation('current', [trade('now', '02'), trade('future', '03')], { future: recall('分批买入', '预算优先') });
  current.messages = [{ role: 'assistant', text: '用户习惯分批买入和止盈' }];
  current.suggestions = [{ tradeId: 'now', reason: '分批买入', plan: '预算优先' }];
  const earlier = conversation('earlier', [trade('old', '01')], { old: { ...recall('分批买入', '预算优先'), unknown: true, noPlan: true } });
  const result = backgroundCompletion(current, 'now', [earlier]);
  assert.deepEqual(result.memoryRefs, []);
  assert.doesNotMatch(result.reason + result.plan, /分批|预算/);
});

test('negative and numeric historical rules do not leak into positive or invented specific claims', () => {
  const earlier = conversation('earlier', [trade('old', '01')], { old: recall('不要分批买入。', '不再追加预算。跌到 10.5 元止损。') });
  const current = conversation('current', [trade('now', '02')]);
  const result = backgroundCompletion(current, 'now', [earlier]);
  assert.doesNotMatch(result.reason + result.plan, /分批|预算|10\.5|[0-9]/);
  assert.match(result.plan, /退出条件/);
});

test('closed prior holdings do not imply adding to an existing position', () => {
  const current = conversation('current', [trade('old', '01'), trade('exit', '02', { side: 'sell' }), trade('now', '03')]);
  assert.match(backgroundCompletion(current, 'now').reason, /先建立/);
});

test('budget caps are positive preferences and recent rejection supersedes an older habit', () => {
  const earlier = conversation('earlier', [trade('old', '01'), trade('recent', '02')], {
    old: recall('分批买入'), recent: recall('不再分批买入。', '仓位不得超过预算上限。'),
  });
  const current = conversation('current', [trade('now', '03')]);
  const result = backgroundCompletion(current, 'now', [earlier]);
  assert.doesNotMatch(result.reason + result.plan, /分批/);
  assert.match(result.plan, /剩余预算和仓位上限/);
});

test('duplicate imports do not inflate historical trade counts', () => {
  const historical = trade('old', '01');
  const earlier = conversation('earlier', [historical], { old: recall('分批买入') });
  const current = conversation('current', [{ ...historical, id: 'copy' }, trade('now', '02')], { copy: recall('分批买入') });
  const result = backgroundCompletion(current, 'now', [earlier, current]);
  assert.equal(result.memoryRefs.length, 1);
  assert.equal(result.memoryRefs[0].conversationId, 'current');
});

test('existing input, explicit unknown/no-plan and original record provenance are respected', () => {
  for (const note of [recall('用户写的原因', '用户写的计划'), { ...recall(''), unknown: true, noPlan: true }, { reason: '原件', source: '当时记录' }]) {
    const current = conversation('current', [trade('now', '02')], { now: note });
    const result = backgroundCompletion(current, 'now');
    assert.equal(result.reason, '');
    assert.equal(result.plan, '');
  }
});

test('each field prefers model output, dismissal hides both origins, and typing overrides both', () => {
  const local = { reason: '本机理由', plan: '本机计划' };
  const model = { reason: '模型理由', plan: '' };
  assert.equal(completionForField({}, model, local, 'reason').origin, 'model');
  assert.equal(completionForField({}, model, local, 'plan').origin, 'local');
  assert.equal(completionForField({}, model, local, 'reason', true), null);
  assert.equal(completionForField({ reason: '手动输入' }, model, local, 'reason'), null);
});

test('explicit local acceptance saves only the accepted field with recalled provenance', () => {
  const current = conversation('current', [trade('now', '02')]);
  const result = backgroundCompletion(current, 'now');
  const patch = acceptedSuggestionPatch(current, result, 'reason', '2026-10-22T12:00:00Z');
  const workspace = createWorkspace();
  workspace.activeId = current.id;
  workspace.conversations = [{ ...current, ...patch }];
  const saved = validateWorkspace(workspace).conversations[0].contexts.now;
  assert.equal(saved.reason, result.reason);
  assert.equal(saved.plan, '');
  assert.equal(saved.source, '现在回忆');
  assert.match(saved.reference, /AI辅助草稿，经用户确认/);
  assert.equal(saved.publishedAt, null);
  assert.deepEqual(current.contexts, {});
});
