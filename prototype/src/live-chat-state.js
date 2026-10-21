import { reviewContextKey } from './review-chat-state.js';
import { activeDecisionNotes } from './decision-background.js';

const clean = value => typeof value === 'string' ? value.trim() : '';
const strings = value => Array.isArray(value) ? value.filter(v => typeof v === 'string' && v.trim()).map(v => v.trim()) : [];
export function buildLiveContext(state, trades) {
  return { trades, contexts: activeDecisionNotes(state.contexts), marketMode: state.marketMode, origin: state.origin, evidence: state.evidence || [], marketData: state.marketData || null };
}
export function liveContextKey(context) {
  const parts = [reviewContextKey(context), context.evidence || []];
  if (context.marketData) parts.push(context.marketData);
  return JSON.stringify(parts);
}
export function createLiveChat(context) {
  return { version: 1, contextKey: liveContextKey(context), draft: '', topic: { kind: 'custom', question: '', tradeId: context.trades[0]?.id || '' }, messages: [{ id: 'live-opening', role: 'assistant', text: '交易和背景已准备好。你想先核对哪个决定？发送后，我会结合本次材料回答；缺少依据的部分会保留不确定性。', refs: [], suggestions: [], allowLearning: false }], evidence: [], lastRequest: null };
}
export function restoreLiveChat(saved, context) {
  const fresh = createLiveChat(context);
  if (!saved || saved.version !== 1 || saved.contextKey !== fresh.contextKey || typeof saved.draft !== 'string' || !Array.isArray(saved.messages) || !saved.messages.length || saved.messages.length > 201) return fresh;
  if (saved.messages.some(m => !m || !['user', 'assistant'].includes(m.role) || typeof m.id !== 'string' || typeof m.text !== 'string' || !Array.isArray(m.refs) || !Array.isArray(m.suggestions) || m.refs.some(r => !r || !['trades', 'background', 'evidence'].includes(r.panel) || typeof r.label !== 'string' || typeof r.tradeId !== 'string') || m.suggestions.some(s => !s || typeof s.id !== 'string' || typeof s.text !== 'string'))) return fresh;
  return { ...fresh, ...saved, topic: { ...fresh.topic, ...saved.topic }, evidence: normalizeEvidence(saved.evidence), lastRequest: saved.lastRequest && typeof saved.lastRequest.id === 'string' && typeof saved.lastRequest.text === 'string' ? saved.lastRequest : null };
}
function normalizeEvidence(value) {
  return Array.isArray(value) ? value.filter(item => item && typeof item.id === 'string').map(item => Object.fromEntries(['id', 'tradeId', 'type', 'title', 'text', 'source', 'publishedAt', 'recordedAt', 'timeClass', 'url'].map(key => [key, clean(item[key])]))) : [];
}
export function normalizeReviewResult(result, context) {
  if (!result || typeof result !== 'object' || !clean(result.text)) throw new Error('模型没有返回完整的复盘内容，请重试。');
  const evidence = normalizeEvidence(result.evidence);
  const known = new Set(evidence.map(item => item.id));
  const referenceIds = [...new Set([...strings(result.textEvidenceIds), ...(Array.isArray(result.facts) ? result.facts.flatMap(f => strings(f?.evidenceIds)) : []), ...(Array.isArray(result.interpretations) ? result.interpretations.flatMap(f => strings(f?.evidenceIds)) : []), ...strings(result.learning?.evidenceIds), ...strings(result.evidenceIds)])].filter(id => known.has(id));
  const numbers = new Map(referenceIds.map((id, index) => [id, index + 1]));
  const citations = ids => [...new Set(strings(ids))].filter(id => numbers.has(id)).map(id => `[${numbers.get(id)}]`).join('');
  const citedText = item => `${clean(item?.text)}${citations(item?.evidenceIds) ? ` ${citations(item.evidenceIds)}` : ''}`;
  const refs = referenceIds.map(id => { const item = evidence.find(item => item.id === id); return { panel: 'evidence', evidenceId: id, tradeId: context.trades.some(t => t.id === item.tradeId) ? item.tradeId : context.trades[0]?.id, label: `[${numbers.get(id)}] ${item.title || item.label || '查看材料'}` }; });
  const sections = [citedText({ text: result.text, evidenceIds: result.textEvidenceIds })];
  const facts = Array.isArray(result.facts) ? result.facts.filter(item => clean(item?.text)).map(citedText) : [];
  const interpretations = Array.isArray(result.interpretations) ? result.interpretations.filter(item => clean(item?.text)).map(citedText) : [];
  const uncertainties = strings(result.uncertainties);
  if (facts.length) sections.push(`依据材料整理的事实\n${facts.map(t => `• ${t}`).join('\n')}`);
  if (interpretations.length) sections.push(`解释与判断\n${interpretations.map(t => `• ${t}`).join('\n')}`);
  if (uncertainties.length) sections.push(`仍需确认\n${uncertainties.map(t => `• ${t}`).join('\n')}`);
  const learningRefs = [...new Set(strings(result.learning?.evidenceIds))].filter(id => known.has(id));
  const learning = result.learning && learningRefs.length && ['title', 'trigger', 'action'].every(key => clean(result.learning[key])) ? { title: clean(result.learning.title), trigger: clean(result.learning.trigger), action: clean(result.learning.action), exception: clean(result.learning.exception), analysisRunId: clean(result.analysisRunId) || null, evidenceIds: learningRefs } : null;
  if (learning) sections.push(`检查项依据 ${citations(learningRefs)}`);
  return { text: sections.join('\n\n'), refs, suggestions: strings(result.suggestions).slice(0, 3).map((text, i) => ({ id: `suggestion-${i}`, text })), evidence, evidenceIds: referenceIds, learning };
}

export function prepareTradeCandidates(result) {
  if (!result || !Array.isArray(result.trades)) throw new Error('没有收到可核对的交易记录。');
  if (result.trades.length > 500) throw new Error('本次交易超过 500 笔，请缩小范围后重试。');
  return result.trades.map((trade, index) => ({ id: clean(trade?.id) || `AI-${index + 1}`, symbol: clean(trade?.symbol), name: clean(trade?.name), time: clean(trade?.time), side: ['buy', 'sell'].includes(trade?.side) ? trade.side : '', quantity: typeof trade?.quantity === 'number' && Number.isFinite(trade.quantity) ? trade.quantity : null, price: typeof trade?.price === 'number' && Number.isFinite(trade.price) ? trade.price : null, fee: typeof trade?.fee === 'number' && Number.isFinite(trade.fee) ? trade.fee : null }));
}
export function candidateIssues(trades) {
  const issues = []; const ids = new Set(); const symbols = new Set();
  trades.forEach((t, index) => {
    const date = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(t.time) ? new Date(`${t.time}Z`) : null;
    const exactDate = date && Number.isFinite(date.getTime()) && date.toISOString().slice(0, t.time.length) === t.time;
    if (!clean(t.name) || !clean(t.symbol) || !exactDate || !['buy', 'sell'].includes(t.side) || !Number.isFinite(t.quantity) || t.quantity <= 0) issues.push(`第 ${index + 1} 笔的标的、时间、方向或数量待补充。`);
    if (t.price !== null && (!Number.isFinite(t.price) || t.price <= 0) || t.fee !== null && (!Number.isFinite(t.fee) || t.fee < 0)) issues.push(`第 ${index + 1} 笔的价格或费用无效。`);
    if (ids.has(t.id)) issues.push(`第 ${index + 1} 笔的交易编号重复。`);
    ids.add(t.id); if (t.symbol) symbols.add(t.symbol);
  });
  if (symbols.size > 1) issues.push('本次请保留一个标的，其他标的可以另建复盘。');
  return issues;
}
