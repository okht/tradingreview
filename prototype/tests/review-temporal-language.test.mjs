import test from 'node:test';
import assert from 'node:assert/strict';
import { validateResult, buildEvidence } from '../server/contracts.js';
import { context, answer } from '../verification/ai-contract-eval/cases.mjs';

const recalled = { ...context, contexts: { T1: { source: '现在回忆', reason: '分批建立仓位。', plan: '核对预算后再继续。' } } };
const unknown = { ...recalled, contexts: { T1: { ...recalled.contexts.T1, source: '当时记录' } } };
const claim = text => answer({ interpretations: [{ text, evidenceIds: ['background:T1'] }], evidenceIds: ['trade:T1', 'background:T1'] });
// Exact rejected synthetic acceptance outputs, preserved across both attempts.
const initial = '这段回忆可整理为“继续分批建立仓位前，先核对预算与分批安排”的未来流程提醒；它不是对过去执行情况的认定，也不构成具体买卖建议。';
const repaired = '已将你现在填写的模拟回忆整理为面向下一次的可编辑检查项。它仅是流程提醒草稿，不代表当时已制定或执行过；先不保存，不补充金额或止损参数。';

test('captured initial future reminder explicitly denies historical execution proof', () => {
  assert.doesNotThrow(() => validateResult('review', claim(initial), recalled));
});

test('captured repair describes a future editable draft, not a verified historical plan', () => {
  assert.doesNotThrow(() => validateResult('review', answer({ text: repaired, textEvidenceIds: ['background:T1'], evidenceIds: ['trade:T1', 'background:T1'] }), recalled));
});

test('future reminder exception also respects an unknown note timestamp', () => {
  assert.doesNotThrow(() => validateResult('review', claim(initial), unknown));
});

test('structured future checklist uses prospective semantics without a mandatory disclaimer', () => {
  const learning = { title: '分批交易前核对预算', trigger: '下一次拟按分批计划建立或继续增加仓位前', action: '对照自己填写的预算与分批计划，核对已投入金额、本批拟投入金额，以及本批之后的累计投入是否仍在预算内；记录核对结果。预算或分批安排不明确时，先补充说明，不将检查标记为通过。此项仅为未来流程提醒，不表示历史上执行过。', exception: '原回忆未提供例外，暂不预设自动豁免；如下一次需要调整预算或分批安排，先写明调整内容与原因，再按更新后的计划重新核对。', evidenceIds: ['background:T1'] };
  assert.doesNotThrow(() => validateResult('review', answer({ learning, evidenceIds: ['trade:T1', 'background:T1'] }), recalled));
  assert.doesNotThrow(() => validateResult('review', answer({ learning: { ...learning, action: '核对预算与分批安排，记录核对结果。', exception: '' }, evidenceIds: ['trade:T1', 'background:T1'] }), recalled));
  assert.throws(() => validateResult('review', answer({ learning: { ...learning, action: '用户当时严格执行了分批计划。' }, evidenceIds: ['trade:T1', 'background:T1'] }), recalled), /learning：基于事后回忆/);
  assert.throws(() => validateResult('review', answer({ learning: { ...learning, evidenceIds: [] } }), recalled), /必须引用当前已存在的证据/);
  assert.throws(() => validateResult('review', answer({ learning: { ...learning, action: '本次净盈亏 999999 元。' }, evidenceIds: ['trade:T1', 'background:T1'] }), recalled), /净盈亏/);
});

test('the prospective reminder exception does not exempt affirmative historical claims', () => {
  for (const text of [
    `${initial}用户当时严格执行了计划。`,
    `${initial}分批计划促使买入。`,
    `${initial}用户成交前已经看过公告。`,
    `${initial}用户按计划买入了股票。`,
    `${initial}这说明用户存在过度自信。`,
    `用户当时严格执行了计划。${initial}`,
    '这段回忆整理为未来流程提醒；不存在「不是对过去执行情况的认定」的限制。',
  ]) assert.throws(() => validateResult('review', claim(text), recalled), /基于事后回忆的解释必须明确不确定性/);
});

test('a generic advice disclaimer or future label is insufficient without source and historical limits', () => {
  for (const text of [
    '这段回忆可整理为未来流程提醒，不构成具体买卖建议。',
    '这是未来流程提醒；它不是对过去执行情况的认定。',
    '用户回忆已经执行了分批计划，不构成具体买卖建议。',
    '这段回忆就是计划执行的认定；它不是对过去执行情况的认定。',
  ]) assert.throws(() => validateResult('review', claim(text), recalled));
  const unknownEvent = { ...context, evidence: [{ ...context.evidence[0], publishedAt: null }] };
  assert.throws(() => validateResult('review', answer({ interpretations: [{ text: initial, evidenceIds: ['event:notice'] }], evidenceIds: ['trade:T1', 'event:notice'] }), unknownEvent), /证据时点未知/);
});

const marketContext = {
  trades: [{ id: 'EQ01-T20', symbol: '600519.SH', name: '测试标的', time: '2025-03-03T09:50', side: 'buy', quantity: 100, price: 12, fee: 5 }], contexts: {},
  marketData: { provider: 'synthetic', synthetic: true, source: '用户导入的合成行情', status: 'ok', symbol: '600519.SH', instrumentKind: 'real-equity', interval: '5m', reviewInterval: '15m', currency: 'CNY', timeZone: 'Asia/Shanghai', adjust: 'none', from: '2025-03-03', to: '2025-03-03', pricePoints: [['09:30', 10], ['09:35', 9], ['09:40', 11], ['09:45', 10], ['09:50', 12]].map(([clock, price]) => ({ time: Date.parse(`2025-03-03T${clock}:00+08:00`) / 1000, price })) },
};
const marketIds = ['market:EQ01-T20:before', 'market:EQ01-T20:current'];
const marketAnswer = text => answer({ facts: [{ text, evidenceIds: marketIds }], evidenceIds: marketIds });

test('captured completed pre-trade market window is not a claim about user knowledge', () => {
  const text = '已读取 EQ01-T20 对应的合成测试行情：read_market 返回 interval=15m，未返回独立的 reviewInterval 字段。before 仅含该成交前已完成的窗口，currentBar 仅含截至成交时点的观测；没有读取该成交后的窗口。离散合成观测之间的价格未知。';
  assert.deepEqual(buildEvidence(marketContext).filter(entry => marketIds.includes(entry.id)).map(entry => entry.timeClass), ['before', 'before']);
  assert.doesNotThrow(() => validateResult('review', marketAnswer(text), marketContext));
  assert.doesNotThrow(() => validateResult('review', marketAnswer('合成测试行情仅包含买入前已完成的窗口。'), marketContext));
});

test('pre-trade knowledge verbs and causal attributions still require background support', () => {
  for (const text of [
    '用户成交前已知公告内容（合成测试）。',
    '用户成交前已看过公告（合成测试）。',
    '用户成交前已经掌握完整信息（合成测试）。',
    '用户买入前已知道公告（合成测试）。',
    '用户当时已知公告内容（合成测试）。',
    '用户当时知道公告，公告促使买入（合成测试）。',
  ]) assert.throws(() => validateResult('review', marketAnswer(text), marketContext), /公开信息和成交记录不能直接证明/);
});
