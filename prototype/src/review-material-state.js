import { editedTrade, importIssues } from './import-dialog-state.js';
import { validateContext } from '../server/contracts.js';

/** Apply an explicitly confirmed scope without rewriting any material. */
export function scopeSelectionPatch(conversation, draftIds, originalIds = conversation.selectedIds) {
  const sameIds = (a, b) => a.length === b.length && a.every(id => b.includes(id));
  if (!sameIds(originalIds, conversation.selectedIds)) throw new Error('复盘范围已更新，请重新打开调整范围。');
  if (!Array.isArray(draftIds) || !draftIds.length) throw new Error('至少选择一笔交易。');
  const ids = new Set(draftIds);
  if (ids.size !== draftIds.length || draftIds.some(id => !conversation.trades.some(trade => trade.id === id))) throw new Error('选择的交易不在当前复盘内。');
  return { selectedIds: conversation.trades.filter(trade => ids.has(trade.id)).map(trade => trade.id), contextRevision: conversation.contextRevision + 1 };
}

/** Keep identity, provenance and links stable when correcting one execution. */
export function currentTradePatch(conversation, tradeId, draft, originalTrade) {
  const current = conversation.trades.find(trade => trade.id === tradeId);
  if (!current) throw new Error('这笔交易已不在当前复盘中。');
  if (originalTrade && JSON.stringify(current) !== JSON.stringify(originalTrade)) throw new Error('成交记录已更新，请重新打开修改。');
  const fields = ['time', 'side', 'quantity', 'price', 'fee'];
  const changes = Object.fromEntries(fields.filter(field => Object.hasOwn(draft, field)).map(field => [field, draft[field]]));
  const corrected = editedTrade({ ...current, ...changes });
  const trades = conversation.trades.map(trade => trade.id === tradeId ? corrected : trade).sort((a, b) => a.time.localeCompare(b.time));
  const issues = importIssues(trades);
  if (issues.length) throw new Error(issues.join(' '));
  const checked = validateContext({ ...conversation, trades, marketMode: 'import' });
  return { trades: checked.trades, contextRevision: conversation.contextRevision + 1 };
}
