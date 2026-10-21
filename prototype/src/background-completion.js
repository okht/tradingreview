import { activeDecisionNotes } from './decision-background.js';
import { suggestionText } from './background-preparation-state.js';

const identity = trade => [trade.symbol, trade.time, trade.side, trade.quantity, trade.price].join('|');
const time = trade => Date.parse(trade?.time);
function preference(texts, expression) {
  for (const text of texts) {
    const part = text.split(/[，。；、\n]/).find(value => expression.test(value));
    if (!part) continue;
    // A cap is an affirmative risk preference; an explicit rejection overrides older notes.
    const statement = part.replace(/不得超过|不超过|未超过|不高于|不大于/g, '限制在');
    return !/(?:不|没|无|避免|放弃|禁止|取消|停止|未)[^，。；]{0,8}/.test(statement);
  }
  return false;
}

/** Local, disposable predictions. Only saved user notes and earlier trades can inform them. */
export function backgroundCompletion(conversation, tradeId, conversations = []) {
  const trade = conversation.trades.find(item => item.id === tradeId);
  if (!trade || !Number.isFinite(time(trade))) return null;
  const currentNote = activeDecisionNotes(conversation.contexts)[tradeId] || {};
  const records = new Map();
  // Current conversation wins when a file has been imported more than once.
  for (const source of [...conversations.filter(item => item.id !== conversation.id), conversation]) {
    const notes = activeDecisionNotes(source.contexts || {});
    for (const previous of source.trades || []) {
      if (time(previous) >= time(trade) || !Number.isFinite(time(previous))) continue;
      records.set(identity(previous), { trade: previous, note: notes[previous.id] || {}, conversationId: source.id });
    }
  }
  const earlier = [...records.values()].sort((a, b) => time(b.trade) - time(a.trade));
  const sameSymbol = earlier.filter(item => item.trade.symbol === trade.symbol);
  const confirmed = earlier.filter(item => (item.note.reason || item.note.plan) && ['现在回忆', '当时记录'].includes(item.note.source));
  // Prefer the same instrument, then the user's most recent confirmed notes.
  const memory = [...confirmed.filter(item => item.trade.symbol === trade.symbol), ...confirmed.filter(item => item.trade.symbol !== trade.symbol)].slice(0, 8);
  const texts = [currentNote.reason || '', currentNote.plan || '', ...memory.flatMap(item => [item.note.reason || '', item.note.plan || ''])];
  const prefers = expression => preference(texts, expression);
  const batch = prefers(/分批|分段|逐步|小仓|轻仓|试仓/);
  const budget = prefers(/预算|仓位上限|控制仓位|资金上限/);
  const risk = prefers(/止损|退出条件|风险|最大亏损/);
  const trend = prefers(/趋势|突破|均线|量价/);
  const longTerm = prefers(/长期|长线|基本面|估值/);
  const profit = prefers(/止盈|锁定收益|兑现收益|落袋/);
  const isBuy = trade.side === 'buy';
  const priorBuy = sameSymbol.reduce((quantity, item) => quantity + (item.trade.side === 'buy' ? 1 : -1) * item.trade.quantity, 0) > 0;
  let reason = isBuy
    ? (priorBuy ? '我想继续增加这只标的的持仓，延续前面的买入判断。' : '我想先建立这只标的的仓位，再观察后续表现。')
    : '我想先降低这只标的的持仓，把仓位风险收回来。';
  let plan = isBuy
    ? '先观察买入后的表现，再决定是否继续投入；判断不再成立时退出。'
    : '先减少持仓，观察后续表现，再决定是否保留或重新买入。';
  if (isBuy && batch) {
    reason = priorBuy ? '我想延续分批买入的节奏，逐步增加这只标的的持仓。' : '我想先用一笔仓位参与，保留后续分批买入的空间。';
    plan = '按分批投入的方式推进，每次追加前重新检查判断依据和剩余资金。';
  } else if (isBuy && trend) {
    reason = '我想先参与这只标的，再用后续趋势表现检验这次买入判断。';
    plan = '继续跟踪趋势是否延续，出现与买入判断相反的变化时减少仓位。';
  } else if (isBuy && longTerm) {
    reason = '我想围绕这只标的做较长周期的配置，先建立持仓。';
    plan = '持续核对基本面和估值变化，判断逻辑没有变化时保持观察。';
  } else if (!isBuy && profit) {
    reason = '我想分步兑现持仓，减少继续承担的价格波动。';
    plan = '按持仓安排退出，再根据后续表现决定是否重新参与。';
  }
  if (budget) plan = isBuy
    ? (batch ? '按分批投入的方式推进，每次追加前核对剩余预算和仓位上限。' : '先核对剩余预算和仓位上限，再决定是否继续投入。')
    : '先把仓位降下来，重新核对资金安排，再决定后续操作。';
  if (risk && !budget && !batch) plan = isBuy
    ? '持有期间持续检查买入判断，触及退出条件时减少仓位。'
    : '先减少风险敞口，重新检查持有理由，再决定后续仓位。';
  const input = {
    tradeId,
    reason,
    plan,
    unknown: true,
    confidence: memory.length || currentNote.reason || currentNote.plan ? 'medium' : 'low',
    basis: memory.length
      ? `根据此前 ${memory.length} 笔已填写背景及本笔${isBuy ? '买入' : '卖出'}行为推测；采用前不记入背景。`
      : '根据本笔成交与此前可见行为推测，历史偏好材料不足；采用前不记入背景。',
    memoryRefs: memory.map(item => ({ conversationId: item.conversationId, tradeId: item.trade.id })),
  };
  return { ...input, reason: suggestionText(currentNote, input, 'reason'), plan: suggestionText(currentNote, input, 'plan') };
}

/** A visible model candidate takes precedence, independently for each field. */
export function completionForField(note, model, local, field, dismissed = false) {
  if (dismissed) return null;
  if (suggestionText(note, model, field)) return { ...model, origin: 'model' };
  if (suggestionText(note, local, field)) return { ...local, origin: 'local' };
  return null;
}
