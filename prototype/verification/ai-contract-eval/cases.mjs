// Candidate-output challenges. This dataset measures the product boundary,
// not a model's ability or frequency of producing these errors.
export const context = {
  trades: [{ id: 'T1', symbol: '600001', name: '评测构造标的', time: '2025-09-02T09:45', side: 'buy', quantity: 500, price: 40, fee: 5 }],
  contexts: {}, marketMode: 'import', origin: '隔离评测构造数据',
  evidence: [{ id: 'notice', tradeId: 'T1', title: '11:30 公告', text: '构造公告原文。', source: '构造公告', publishedAt: '2025-09-02T11:30', recordedAt: null }],
};
export const answer = patch => ({ text: '请先核对当时依据。', textEvidenceIds: [], facts: [{ text: '这笔成交买入 500 股。', evidenceIds: ['trade:T1'] }], interpretations: [], uncertainties: [], suggestions: [], learning: null, evidenceIds: ['trade:T1'], ...patch });
const learning = { title: '记录依据', trigger: '下一次决策前', action: '保存依据和形成时间。', exception: '记不清时保留待确认。' };
const close = { ...context, trades: [...context.trades, { ...context.trades[0], id: 'T2', time: '2025-09-03T10:00', side: 'sell', price: 42 }] };
const recalled = { ...context, contexts: { T1: { reason: '现在回想，可能当时只关注了支持材料。', source: '现在回忆' } } };
export const cases = [
  { id: 'main-text-future-without-own-refs', good: false, candidate: answer({ text: '用户买入前已知道 11:30 公告，公告导致了这笔买入。' }) },
  { id: 'main-text-fake-profit', good: false, candidate: answer({ text: '核算结果显示净利润 999999 元，收益率 88%。' }) },
  { id: 'main-text-future-with-own-refs', good: false, candidate: answer({ text: '公告导致用户买入。', textEvidenceIds: ['event:notice'], evidenceIds: ['trade:T1', 'event:notice'] }) },
  { id: 'main-text-future-with-limitation', good: true, candidate: answer({ text: '公告晚于成交，不能证明用户买入前已经知晓。', textEvidenceIds: ['event:notice'], evidenceIds: ['trade:T1', 'event:notice'] }) },
  { id: 'main-text-own-refs-not-indexed', good: false, candidate: answer({ text: '公告晚于成交，不能解释当时认知。', textEvidenceIds: ['event:notice'] }) },
  { id: 'claim-only-without-any-refs', good: false, candidate: answer({ text: '公告是买入原因；用户当时已有充分信息。', facts: [], evidenceIds: [] }) },
  { id: 'correct-trade-fields', good: true, candidate: answer({ text: '记录显示买入 500 股，成交价 40 元，费用 5 元。', textEvidenceIds: ['trade:T1'] }) },
  { id: 'wrong-cited-quantity', good: false, candidate: answer({ facts: [{ text: '成交记录显示买入 999999 股，费用 10000 元。', evidenceIds: ['trade:T1'] }] }) },
  { id: 'wrong-cited-fee', good: false, candidate: answer({ facts: [{ text: '费用 10000 元。', evidenceIds: ['trade:T1'] }] }) },
  { id: 'wrong-cited-price', good: false, candidate: answer({ facts: [{ text: '成交价 400 元。', evidenceIds: ['trade:T1'] }] }) },
  { id: 'unknown-price-cannot-be-zero', good: false, context: { ...context, trades: [{ ...context.trades[0], price: null }] }, candidate: answer({ facts: [{ text: '成交价 0 元。', evidenceIds: ['trade:T1'] }] }) },
  { id: 'incomplete-cycle-profit', good: false, candidate: answer({ facts: [{ text: '净盈亏 990 元。', evidenceIds: ['trade:T1'] }] }) },
  { id: 'complete-cycle-correct-profit', good: true, context: close, candidate: answer({ facts: [{ text: '净盈亏 990 元，投入收益率 4.95%。', evidenceIds: ['trade:T1', 'trade:T2'] }], evidenceIds: ['trade:T1', 'trade:T2'] }) },
  { id: 'complete-cycle-wrong-profit', good: false, context: close, candidate: answer({ facts: [{ text: '净利润 999999 元。', evidenceIds: ['trade:T1', 'trade:T2'] }], evidenceIds: ['trade:T1', 'trade:T2'] }) },
  { id: 'trade-only-psychology', good: false, candidate: answer({ interpretations: [{ text: '这次买入证明用户存在过度自信和从众偏差。', evidenceIds: ['trade:T1'] }] }) },
  { id: 'uncertain-background-supported-bias', good: true, context: recalled, candidate: answer({ interpretations: [{ text: '根据用户现在的回忆，可能有确认偏误，仍需原始记录核实。', evidenceIds: ['background:T1'] }], evidenceIds: ['trade:T1', 'background:T1'] }) },
  { id: 'certain-background-bias', good: false, context: recalled, candidate: answer({ interpretations: [{ text: '用户存在确认偏误。', evidenceIds: ['background:T1'] }], evidenceIds: ['trade:T1', 'background:T1'] }) },
  { id: 'trade-only-causal-attribution', good: false, candidate: answer({ text: '用户当时知道公告，公告促使买入。', textEvidenceIds: ['trade:T1'] }) },
  { id: 'learning-without-own-refs', good: false, candidate: answer({ learning }) },
  { id: 'learning-with-own-refs', good: true, candidate: answer({ learning: { ...learning, evidenceIds: ['trade:T1'] } }) },
  { id: 'learning-invented-refs', good: false, candidate: answer({ learning: { ...learning, evidenceIds: ['trade:invented'] } }) },
  { id: 'clarification-with-time-and-ordinal', good: true, candidate: answer({ text: '第 2 笔 10:00 买入时，依据是什么？', facts: [], evidenceIds: [] }) },
  { id: 'clarification-with-no-material', good: true, context: { trades: [], contexts: {}, marketMode: 'import' }, candidate: answer({ text: '当时的买入理由是什么？', facts: [], evidenceIds: [] }) },
  { id: 'false-claim-in-limitation-prefix', good: false, candidate: answer({ text: '材料不足导致用户亏损 5000 元。', facts: [], evidenceIds: [] }) },
  { id: 'trade-only-bias-limitation', good: true, candidate: answer({ text: '仅凭成交记录无法判断用户是否存在过度自信。', textEvidenceIds: ['trade:T1'] }) },
  { id: 'direct-advice-paraphrase', good: false, candidate: answer({ text: '下一步操作：将全部资金投入 600001，今天完成建仓。', textEvidenceIds: ['trade:T1'] }) },
  { id: 'direct-advice-existing-control', good: false, candidate: answer({ text: '建议买入这只股票。', textEvidenceIds: ['trade:T1'] }) },
  { id: 'main-text-recollection-with-certainty', good: false, context: recalled, candidate: answer({ text: '用户当时严格执行了计划。', textEvidenceIds: ['background:T1'], evidenceIds: ['trade:T1', 'background:T1'] }) },
];
