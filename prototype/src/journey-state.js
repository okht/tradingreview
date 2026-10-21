import { defaultLearning } from './domain.js';

export const JOURNEY_KEY = 'huikan-journey-prototype-v1';
export const STEPS = [
  ['连接 AI', '选择你的模型'], ['添加交易', '导入或描述交易'], ['确认范围', '选择本次复盘'],
  ['补充背景', '还原当时的想法'], ['复盘分析', '围绕问题核对'], ['保存检查项', '留给下次决策'],
];
export const NARRATIVE = '远川科技（DEMO001），2025 年 9 月 2 日 09:45 买入 500 股，价格 40 元，费用 5 元；9 月 8 日 10:00 又买入 300 股，价格 42 元，费用 5 元；9 月 18 日 14:30 卖出全部 800 股，价格 46 元，费用 23.4 元。';
export const EXAMPLE_CONTEXT = {
  'DEMO-01': { reason: '我看好公司订单增长，先买一部分，想等后续信息确认。', plan: '先买 500 股，是否继续买入要看新信息。', source: '现在回忆', unknown: false },
  'DEMO-02': { reason: '我记得看到一条新签订单的消息，所以又买了 300 股。', plan: '没有留下明确的加仓条件，需要核对当时看到消息的时间。', source: '现在回忆', unknown: false },
  'DEMO-03': { reason: '股价上涨后，我想先结束这段持仓，兑现已有收益。', plan: '当时没有写下明确的退出条件。', source: '现在回忆', unknown: false },
};
export function createJourney() {
  return { version: 1, reviewId: null, step: 0, reached: 0, provider: 'chatgpt', connected: '', model: { mode: 'demo' }, source: 'csv', trades: [], selectedIds: [], marketMode: 'import', origin: '', contexts: {}, contextIndex: 0, question: '', questionKind: '', analyzed: false, reviewChat: null, liveReviewChat: null, evidence: [], marketData: null, correction: '', learning: { ...defaultLearning }, savedItems: [], activeLearningId: null, editingLearningId: null, nextDecision: '', nextChecked: false, narrativeDraft: '', csvDraft: '' };
}
export function readJourney(storage) {
  try {
    const value = JSON.parse(storage.getItem(JOURNEY_KEY));
    if (value?.version !== 1 || !Array.isArray(value.trades) || !Array.isArray(value.selectedIds) || !Array.isArray(value.savedItems)) return createJourney();
    if (value.trades.some(t => !t || typeof t.id !== 'string' || typeof t.name !== 'string' || typeof t.symbol !== 'string' || typeof t.time !== 'string' || !['buy', 'sell'].includes(t.side) || !Number.isFinite(t.quantity) || t.quantity <= 0)) return createJourney();
    if (!value.contexts || typeof value.contexts !== 'object' || Array.isArray(value.contexts) || !value.learning || ['title', 'trigger', 'action', 'exception'].some(key => typeof value.learning[key] !== 'string')) return createJourney();
    if (Object.values(value.contexts).some(note => !note || typeof note !== 'object' || ['reason', 'plan', 'source', 'reference'].some(key => note[key] !== undefined && typeof note[key] !== 'string'))) return createJourney();
    if (typeof value.question !== 'string' || typeof value.questionKind !== 'string' || typeof value.correction !== 'string') return createJourney();
    if (value.savedItems.some(item => !item || typeof item.id !== 'string' || ['title', 'trigger', 'action', 'exception'].some(key => typeof item[key] !== 'string'))) return createJourney();
    if (value.selectedIds.some(id => !value.trades.some(t => t.id === id))) return createJourney();
    if (!Number.isInteger(value.step) || value.step < 0 || value.step > 5 || !Number.isInteger(value.reached) || value.reached < value.step || value.reached > 5) return createJourney();
    if (value.step > 1 && !value.trades.length) return createJourney();
    if (value.step > 2 && !value.selectedIds.length) return createJourney();
    return { ...createJourney(), ...value };
  } catch { return createJourney(); }
}
export function replaceJourneyTrades(state, trades, marketMode, origin) {
  return { ...state, reviewId: crypto.randomUUID(), trades: [...trades].sort((a, b) => a.time.localeCompare(b.time)), selectedIds: trades.map(t => t.id), marketMode, origin, contexts: {}, evidence: [], marketData: null, contextIndex: 0, question: '', questionKind: '', analyzed: false, reviewChat: null, liveReviewChat: null, correction: '', activeLearningId: null, editingLearningId: null, nextDecision: '', nextChecked: false, learning: { ...defaultLearning }, step: 2, reached: 2 };
}
export function questionOptions(trades) {
  if (!trades.length) return [];
  const ordered = [...trades].sort((a, b) => a.time.localeCompare(b.time));
  const buys = ordered.filter(t => t.side === 'buy');
  const sell = ordered.findLast(t => t.side === 'sell');
  let position = 0;
  let addition;
  for (const trade of ordered) { if (trade.side === 'buy' && position > 0 && !addition) addition = trade; position += trade.side === 'buy' ? trade.quantity : -trade.quantity; }
  return [
    ...(buys.length ? [addition ? { id: 'add', text: '这次加仓，符合原来的计划吗？', tradeId: addition.id } : { id: 'entry', text: '买入时，我的判断有哪些依据？', tradeId: buys[0].id }] : []),
    sell ? { id: 'exit', text: '卖出时，我的判断发生了什么变化？', tradeId: sell.id } : { id: 'holding', text: '继续持有的依据，还需要核对什么？', tradeId: trades.at(-1)?.id },
    { id: 'learn', text: '哪些做法，值得下一次继续保持？', tradeId: addition?.id || trades[0]?.id },
  ];
}
export function learningForQuestion(kind) {
  if (kind === 'add') return { ...defaultLearning };
  return { title: '交易前，记录判断依据和变化条件', trigger: kind === 'exit' ? '准备卖出已有持仓时' : '准备作出新的投资决定时', action: '写下当前判断、依据的来源与时间，以及什么变化会让自己重新评估。', exception: '信息不足或记忆不清时，保留待确认，并说明尚缺哪些材料。' };
}

