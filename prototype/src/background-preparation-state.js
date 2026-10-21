import { validateContext, validateResult } from '../server/contracts.js';
import { activeDecisionNotes } from './decision-background.js';
import { modelIdentity } from './model-connection.js';

const AI_REFERENCE = 'AI辅助草稿，经用户确认；不等同当时记录';
const idle = () => ({ phase: 'idle', detail: '', suggestions: [], missing: [], completedIds: [], total: 0, retrievalStatuses: [] });

/** Candidates and messages never enter this context. Only this conversation is used. */
export function preparationContext(conversation) {
  return validateContext({ trades: conversation.trades, contexts: activeDecisionNotes(conversation.contexts), evidence: conversation.evidence || [], marketMode: 'import', origin: conversation.origin, marketData: conversation.marketData });
}

export function preparationScopeKey(conversation, model) {
  return JSON.stringify([conversation.id, conversation.contextRevision, modelIdentity(model), conversation.selectedIds, conversation.trades, conversation.contexts, conversation.evidence, conversation.marketData, conversation.origin]);
}

export function suggestionText(note = {}, suggestion, field) {
  if (!['reason', 'plan'].includes(field) || !suggestion || (note[field] || '').length) return '';
  if ((field === 'reason' && note.unknown) || (field === 'plan' && note.noPlan)) return '';
  // A note has one provenance field. Do not relabel an existing original record.
  if (note.source === '当时记录' && (note.reason || note.plan)) return '';
  return suggestion[field] || '';
}

export function shouldAcceptSuggestion(event, value, suggestion) {
  return event.key === 'Tab' && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey && !event.isComposing && !event.nativeEvent?.isComposing && !value && Boolean(suggestion);
}

export function acceptedSuggestionPatch(conversation, suggestion, field, now = new Date().toISOString()) {
  if (!conversation.trades.some(item => item.id === suggestion?.tradeId)) throw new Error('这笔成交已变化，请重新准备背景。');
  const previous = conversation.contexts[suggestion.tradeId] || {};
  const text = suggestionText(previous, suggestion, field);
  if (!text) return null;
  const reference = previous.reference?.includes(AI_REFERENCE) ? previous.reference : [previous.reference, AI_REFERENCE].filter(Boolean).join('；');
  if (reference.length > 2048) throw new Error('背景出处已达到长度限制，请手动填写并保留原出处。');
  return { contexts: { ...conversation.contexts, [suggestion.tradeId]: { ...previous, [field]: text, source: '现在回忆', reference, recordedAt: now } }, contextRevision: conversation.contextRevision + 1 };
}

export function preparedResult(conversation, result, prepareTradeIds) {
  if (!Array.isArray(result?.fetchedEvidence ?? [])) throw new Error('自动取证结果格式无效，可以重试。');
  const known = new Map((conversation.evidence || []).map(item => [item.id, item]));
  const context = preparationContext(conversation);
  // Validate every returned entry before merging, including duplicated IDs.
  const fetched = validateContext({ ...context, evidence: result.fetchedEvidence || [] }).evidence;
  for (const item of fetched) if (!known.has(item.id)) known.set(item.id, item);
  const evidence = [...known.values()];
  const clean = validateContext({ ...context, evidence });
  const candidates = validateResult('prepare', result, clean, result.evidence, { prepareTradeIds });
  const changed = evidence.length !== (conversation.evidence || []).length;
  return { ...candidates, patch: { evidence: clean.evidence, retrievalStatus: typeof result.retrievalStatus === 'string' ? result.retrievalStatus : '自动取证未返回状态，请核对相关证据。', contextRevision: conversation.contextRevision + (changed ? 1 : 0) } };
}

function waitForBatch(milliseconds, signal) {
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, milliseconds);
    const abort = () => { clearTimeout(timer); reject(new DOMException('已停止', 'AbortError')); };
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
  });
}

/** Sequential five-trade batches retain the entire confirmed conversation as context. */
export function createPreparationController({ readCurrent, commit, run, connected, notify = () => {}, timeoutMs = 90000, minBatchIntervalMs = 5100 }) {
  const entries = new Map();
  let request = null;
  let disposed = false;
  const snapshot = () => readCurrent();
  const key = value => preparationScopeKey(value.conversation, value.model);
  const publish = (id, value) => { entries.set(id, value); if (!disposed) notify(); };
  const currentRequest = item => !disposed && request === item && !item.controller.signal.aborted && snapshot().conversation.id === item.id && key(snapshot()) === item.scope;
  function cancel(detail = '准备已停止，已完成的候选与证据保留，可继续剩余成交。') {
    if (!request) { const id = snapshot().conversation.id; if (['queued', 'blocked', 'waiting'].includes(entries.get(id)?.phase)) publish(id, { ...entries.get(id), phase: 'stopped', detail }); return; }
    const previous = request; request = null; clearTimeout(previous.timer); previous.controller.abort();
    publish(previous.id, { ...entries.get(previous.id), phase: 'stopped', detail });
  }
  async function start({ restart = false } = {}) {
    const current = snapshot();
    const id = current.conversation.id;
    if (!current.conversation.trades.length) return;
    cancel();
    const prior = entries.get(id);
    const continuing = !restart && prior?.scope === key(current) ? prior : idle();
    const initial = { ...continuing, scope: key(current), total: current.conversation.trades.length };
    if (current.busy) { publish(id, { ...initial, phase: 'blocked', detail: '正在生成复盘回答，完成后会继续准备背景。' }); return; }
    if (!connected(current.model)) { publish(id, { ...initial, phase: 'waiting', detail: '交易已导入，连接模型后会自动准备背景与相关证据。' }); return; }
    const item = { id, scope: key(current), controller: new AbortController() };
    request = item;
    publish(id, { ...initial, phase: 'running', detail: '正在按每批 5 笔整理背景与相关证据…' });
    let previousBatchStarted = 0;
    try {
      while (currentRequest(item)) {
        const entry = entries.get(id), completed = new Set(entry.completedIds);
        const prepareTradeIds = snapshot().conversation.trades.map(trade => trade.id).filter(tradeId => !completed.has(tradeId)).slice(0, 5);
        if (!prepareTradeIds.length) {
          request = null;
          publish(id, { ...entry, phase: 'ready', detail: '背景候选已准备，灰色文字可按 Tab 采用，也可直接输入或忽略。' });
          return;
        }
        const waitMs = Math.max(0, previousBatchStarted + minBatchIntervalMs - Date.now());
        if (waitMs > 0) await waitForBatch(waitMs, item.controller.signal);
        if (!currentRequest(item)) return;
        previousBatchStarted = Date.now();
        item.timer = setTimeout(() => { if (request === item) cancel('当前批次准备超时，已完成的候选与证据保留。可继续剩余成交。'); }, timeoutMs);
        const result = await run({ task: 'prepare', prepareTradeIds, model: snapshot().model, context: preparationContext(snapshot().conversation), text: '只为 prepareTradeIds 指定的本批成交，结合用户此前的交易行为、已填写背景和计划，预测当时的判断依据及原先计划。reason/plan 写成可直接填入输入框的简短第一人称陈述，作为灰色补全建议；避免反问或要求补充。推测依据放在 basis，保留未采用状态，并收集可用证据。不覆盖用户已有内容，不执行交易方法或保存经验。', signal: item.controller.signal,
          onEvent(event) { if (currentRequest(item) && event.type === 'status' && typeof event.text === 'string') publish(id, { ...entries.get(id), detail: event.text }); } });
        clearTimeout(item.timer);
        if (!currentRequest(item)) return;
        const output = preparedResult(snapshot().conversation, result, prepareTradeIds);
        const retrievalStatuses = [...new Set([...entries.get(id).retrievalStatuses, output.patch.retrievalStatus].filter(Boolean))];
        const retrievalSummary = retrievalStatuses.join('；');
        output.patch.retrievalStatus = retrievalSummary.length <= 1000 ? retrievalSummary : `各批取证状态较多，以下为部分记录；仍需核对相关证据与材料缺口。${retrievalSummary.slice(0, 900)}`;
        const next = commit(id, item.scope, output.patch);
        if (!next) return;
        item.scope = preparationScopeKey(next, snapshot().model);
        const latest = entries.get(id);
        const suggestions = [...new Map([...latest.suggestions, ...output.suggestions].map(value => [value.tradeId, value])).values()];
        const nextEntry = { ...latest, scope: item.scope, suggestions, missing: [...new Set([...latest.missing, ...output.missing])], completedIds: [...new Set([...latest.completedIds, ...prepareTradeIds])], retrievalStatuses };
        publish(id, { ...nextEntry, detail: '正在准备下一批。已显示的灰色候选可以采用。' });
      }
    } catch (error) {
      if (!currentRequest(item)) return;
      request = null; clearTimeout(item.timer);
      publish(id, { ...entries.get(id), phase: 'error', detail: `当前批次未完成：${error.message || '请求失败'}。已完成的候选与证据保留，可继续剩余成交。` });
    } finally {
      clearTimeout(item.timer);
      if (request === item) {
        request = null;
        if (entries.get(id)?.phase === 'running' && entries.get(id)?.scope === item.scope) publish(id, { ...entries.get(id), phase: 'stale', detail: '会话或材料已变化，旧准备已停止。可以按当前材料重新准备。' });
      }
    }
  }
  function observe() {
    const current = snapshot();
    if (request && !currentRequest(request)) cancel('会话或材料已变化，旧准备已停止。可以按当前材料重试。');
    const entry = entries.get(current.conversation.id);
    if (entry?.scope && entry.scope !== key(current) && !(['queued', 'waiting', 'blocked'].includes(entry.phase) && !entry.completedIds.length)) {
      publish(current.conversation.id, { ...idle(), phase: 'stale', total: current.conversation.trades.length, detail: '材料已更新，原背景候选已收起。可按当前材料重新准备。' }); return;
    }
    if (['queued', 'waiting', 'blocked'].includes(entry?.phase)) {
      if (connected(current.model) && !current.busy) void start();
      else if (connected(current.model) && current.busy && entry.phase !== 'blocked') publish(current.conversation.id, { ...idle(), phase: 'blocked', detail: '正在生成复盘回答，完成后会继续准备背景。' });
      else if (!connected(current.model) && entry.phase !== 'waiting') publish(current.conversation.id, { ...idle(), phase: 'waiting', detail: '交易已导入，连接模型后会自动准备背景与相关证据。' });
    }
  }
  function accept(tradeId, field) {
    const current = snapshot(), id = current.conversation.id, entry = entries.get(id);
    if (!entry?.suggestions.length || entry.scope !== key(current)) return false;
    const suggestion = entry.suggestions.find(item => item.tradeId === tradeId);
    const patch = acceptedSuggestionPatch(current.conversation, suggestion, field);
    if (!patch) return false;
    // Accepting changes confirmed input. Stop the remaining batch before saving it.
    if (request?.id === id) cancel('已采用背景前先停止剩余准备。');
    const next = commit(id, entry.scope, patch);
    if (!next) return false;
    const remaining = entry.total - entry.completedIds.length;
    publish(id, { ...entry, phase: remaining > 0 ? 'stopped' : 'ready', scope: preparationScopeKey(next, snapshot().model), suggestions: entry.suggestions.map(item => item.tradeId === tradeId ? { ...item, [field]: '' } : item), detail: remaining > 0 ? `背景已由你确认。剩余 ${remaining} 笔准备已暂停，可按更新后的材料继续。` : '背景已由你确认，其余灰色候选仍可编辑或忽略。' });
    return true;
  }
  return {
    get(id) { const entry = entries.get(id) || idle(); const current = snapshot(); const view = entry.scope && (id !== current.conversation.id || entry.scope !== key(current)) ? { ...entry, suggestions: [] } : entry; return { ...view, completed: view.completedIds.length, blocked: Boolean(current.busy) }; },
    queue(id) { cancel(); publish(id, { ...idle(), phase: 'queued', detail: '准备读取本次导入的材料…' }); },
    observe, start, cancel, accept,
    dismiss(tradeId, field) { const current = snapshot(), id = current.conversation.id, entry = entries.get(id); if (entry?.scope === key(current)) publish(id, { ...entry, suggestions: entry.suggestions.map(item => item.tradeId === tradeId ? { ...item, [field]: '' } : item) }); },
    dispose() { disposed = true; cancel(); },
    activate() { disposed = false; },
  };
}
