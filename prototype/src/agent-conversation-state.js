import { buildLiveContext, liveContextKey, normalizeReviewResult, prepareTradeCandidates } from './live-chat-state.js';
import { editedTrade, importIssues } from './import-dialog-state.js';
import { modelIdentity } from './model-connection.js';
import { validateContext } from '../server/contracts.js';

const strings = value => Array.isArray(value) ? value.filter(item => typeof item === 'string' && item.trim()) : [];
export const CONVERSATION_MESSAGE_LIMIT = 200;

/** Only selected raw materials enter a new run. Generated evidence stays on messages. */
export function conversationContext(conversation) {
  const selected = new Set(conversation.selectedIds || []);
  const trades = (conversation.trades || []).filter(trade => selected.has(trade.id));
  const ids = new Set(trades.map(trade => trade.id));
  return buildLiveContext({ ...conversation,
    contexts: Object.fromEntries(Object.entries(conversation.contexts || {}).filter(([id]) => ids.has(id))),
    evidence: (conversation.evidence || []).filter(item => ids.has(item.tradeId)),
    marketData: trades.length ? conversation.marketData : null,
  }, trades);
}

export function conversationScopeKey(conversation, model) {
  return JSON.stringify([conversation.id, conversation.contextRevision, modelIdentity(model), liveContextKey(conversationContext(conversation))]);
}

export function messageIsCurrent(message, conversation, model) {
  return message.contextRevision === conversation.contextRevision && message.modelSignature === modelIdentity(model);
}

/** Bound only the request context, never truncate the user's stored history. */
export function conversationHistory(messages, conversation, model, excludeId) {
  const candidates = messages.filter(message => message.id !== excludeId && (message.role === 'user' || messageIsCurrent(message, conversation, model))).slice(-12);
  const history = [];
  for (let index = candidates.length - 1; index >= 0; index--) {
    const message = candidates[index];
    const value = message.role === 'user' ? `历史用户补充 / 现在回忆，可能属于此前材料，请核对当前范围。以当前已确认成交为准，遇到冲突先问。\n${message.text}` : message.text;
    const entry = { role: message.role, text: value.slice(0, 8000) };
    if (JSON.stringify([entry, ...history]).length > 30000) break;
    history.unshift(entry);
  }
  return history;
}

export function pendingFromParse(result) {
  return { trades: prepareTradeCandidates(result), questions: strings(result.questions), warnings: strings(result.warnings), origin: '对话补充' };
}

export function parseResponseText(result, pending) {
  const text = typeof result.text === 'string' ? result.text.trim() : '';
  const sections = [text || (pending.trades.length ? `已整理出 ${pending.trades.length} 笔待确认交易，请核对下方记录。` : '还没有足够信息整理出交易记录，可以继续补充。')];
  if (pending.questions.length) sections.push(`需要补充\n${pending.questions.map(item => `• ${item}`).join('\n')}`);
  if (pending.warnings.length) sections.push(`核对提示\n${pending.warnings.map(item => `• ${item}`).join('\n')}`);
  return sections.join('\n\n');
}

export function confirmPendingTrades(conversation) {
  if (conversation.trades?.length) throw new Error('当前已有成交材料，请通过导入入口核对替换范围。');
  const candidates = (conversation.pendingTrades?.trades || []).map(trade => editedTrade({ ...trade, id: trade.id ?? '', name: trade.name ?? '', symbol: trade.symbol ?? '' }));
  const issues = importIssues(candidates);
  if (issues.length) throw new Error(issues.join(' '));
  const { trades } = validateContext({ trades: candidates, contexts: {}, marketMode: 'import', origin: '对话补充' });
  return { trades, selectedIds: trades.map(trade => trade.id), origin: '对话补充', marketMode: 'import',
    contexts: {}, evidence: [], marketData: null, pendingTrades: null, lastRequest: null,
    ...(!conversation.title || conversation.title === '新对话' ? { title: `${trades[0].name.slice(0, 198)}复盘` } : {}),
    contextRevision: (conversation.contextRevision || 0) + 1 };
}

export function reviewMessageResult(result, context) {
  const answer = normalizeReviewResult(result, context);
  const originals = new Map((Array.isArray(result.evidence) ? result.evidence : []).filter(item => item && typeof item.id === 'string').map(item => [item.id, item]));
  answer.evidence = answer.evidence.map(item => {
    const original = originals.get(item.id);
    const metadata = {};
    for (const key of ['marketState', 'cutoff', 'rangeStart', 'rangeEnd']) if (typeof original?.[key] === 'string') metadata[key] = original[key];
    if (Number.isSafeInteger(original?.barCount) && original.barCount >= 0) metadata.barCount = original.barCount;
    if (original?.synthetic === true) metadata.synthetic = true;
    return { ...item, ...metadata };
  });
  return answer;
}

export function parseRequestText(text, pending) {
  if (!pending?.trades?.length) return text;
  // These are explicitly unconfirmed user-edited drafts, never read_trades facts.
  return `${text}\n\n以下是当前尚未确认的交易草稿，请保留用户已补充的字段，并根据本轮描述核对。缺失或冲突请提问，不能填造。\n${JSON.stringify(pending.trades)}`;
}

export function canRetryRequest(conversation, model) {
  const request = conversation.lastRequest;
  if (!request || !messageIsCurrent(request, conversation, model)) return false;
  const task = conversation.trades?.length ? 'review' : 'parse';
  return request.task === task && conversation.messages.some(message => message.role === 'user' && message.id === request.id)
    && !conversation.messages.some(message => message.id === `${request.id}-answer`);
}
