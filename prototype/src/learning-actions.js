import { WORKSPACE_KEY, validateWorkspace } from './agent-workspace-state.js';

const fields = ['title', 'trigger', 'action', 'exception'];
const fingerprint = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const content = value => Object.fromEntries(fields.map(key => [key, typeof value?.[key] === 'string' ? value[key].trim() : key === 'exception' ? '' : value?.[key]]));
const sameContent = (left, right) => fingerprint(content(left)) === fingerprint(content(right));

function requireSource(state, conversationId, messageId) {
  const conversation = state.conversations.find(item => item.id === conversationId);
  const index = conversation?.messages.findIndex(item => item.id === messageId) ?? -1;
  const message = conversation?.messages[index];
  if (!conversation || message?.role !== 'assistant' || !message.learning) throw new Error('这条复盘建议已不存在，请重新打开检查项来源。');
  if (message.contextRevision !== conversation.contextRevision) throw new Error('材料已更新，请重新核对后再保存检查项。');
  const evidenceIds = message.learning.evidenceIds;
  if (!Array.isArray(evidenceIds) || !evidenceIds.length || evidenceIds.some(id => !message.evidence?.some(item => item.id === id))) throw new Error('检查项缺少对应的来源证据，请重新核对后再保存。');
  if (message.analysisRunId && message.learning.analysisRunId && message.analysisRunId !== message.learning.analysisRunId) throw new Error('检查项与来源分析记录不一致，请重新核对。');
  const question = conversation.messages.slice(0, index).findLast(item => item.role === 'user')?.text || conversation.title;
  return { conversation, message, question };
}

function sourceFingerprint(message) {
  return fingerprint({ id: message.id, contextRevision: message.contextRevision, analysisRunId: message.analysisRunId, learning: message.learning, evidence: message.evidence });
}

function findSourceItem(state, conversationId, message) {
  const matches = state.savedItems.filter(item => item.conversationId === conversationId && (item.messageId === message.id || (!item.messageId && item.analysisRunId && item.analysisRunId === (message.learning.analysisRunId || message.analysisRunId))));
  if (matches.length > 1) throw new Error('同一来源已有多个检查项，请在检查项列表中选择要编辑的记录。');
  return matches[0];
}

/** Opening a draft never writes anything. A repeated source reopens user edits. */
export function learningDraftFromMessage(state, conversationId, messageId) {
  const { conversation, message, question } = requireSource(state, conversationId, messageId);
  const existing = findSourceItem(state, conversationId, message);
  return { ...(existing || message.learning), conversationId, messageId, question,
    _source: { conversationId, messageId, contextRevision: conversation.contextRevision, fingerprint: sourceFingerprint(message) },
    _baseSaved: existing ? fingerprint(existing) : null };
}

/** Saved reminders remain editable even when their original conversation was removed. */
export function learningDraftFromSaved(state, id) {
  const existing = state.savedItems.find(item => item.id === id);
  if (!existing) throw new Error('这条检查项已不存在，请重新打开列表。');
  return { ...existing, _baseSaved: fingerprint(existing) };
}

/** Validate against the latest state without mutating the workspace or draft. */
export function saveLearningDraft(state, draft, { now = () => new Date().toISOString(), createId = () => crypto.randomUUID() } = {}) {
  if (!draft || typeof draft !== 'object') throw new Error('请先打开要保存的检查项。');
  let existing = draft.id ? state.savedItems.find(item => item.id === draft.id) : null;
  if (draft.id && !existing) throw new Error('这条检查项已不存在，请重新打开列表。');
  let source;
  if (draft._source) {
    source = requireSource(state, draft._source.conversationId, draft._source.messageId);
    if (source.conversation.contextRevision !== draft._source.contextRevision || sourceFingerprint(source.message) !== draft._source.fingerprint) throw new Error('检查项来源已更新，请重新打开并核对后保存。');
    const sourceItem = findSourceItem(state, source.conversation.id, source.message);
    if (existing && sourceItem?.id !== existing.id) throw new Error('检查项来源与保存记录不一致，请重新打开。');
    existing ||= sourceItem;
  } else if (!existing) throw new Error('请从已核对的复盘回答中打开检查项，再确认保存。');

  if (existing) {
    if (draft._baseSaved && draft._baseSaved !== fingerprint(existing)) throw new Error('检查项已被更新，请重新打开后再修改。当前编辑内容已保留。');
    if (!draft._baseSaved) {
      // A repeated click may arrive with the pre-save draft. Never overwrite an
      // existing user's changes with the original AI candidate.
      if (sameContent(draft, existing)) return state;
      throw new Error('此来源的检查项已经保存，请从列表重新打开后修改。当前编辑内容已保留。');
    }
  }

  const provenance = source ? { conversationId: source.conversation.id, messageId: source.message.id, question: source.question,
    analysisRunId: source.message.learning.analysisRunId || source.message.analysisRunId || undefined,
    evidenceIds: [...source.message.learning.evidenceIds] } : {};
  const item = { ...existing, ...content(draft), ...provenance, id: existing?.id || createId() };
  if (existing && fingerprint({ ...item, savedAt: undefined }) === fingerprint({ ...existing, savedAt: undefined })) return state;
  item.savedAt = now();
  return validateWorkspace({ ...state, savedItems: existing ? state.savedItems.map(value => value.id === existing.id ? item : value) : [item, ...state.savedItems] });
}

/** Publish state only after the single durable browser write succeeds. */
export function persistLearningDraft(state, draft, storage, options) {
  const next = saveLearningDraft(state, draft, options);
  if (next !== state) storage.setItem(WORKSPACE_KEY, JSON.stringify(next));
  return next;
}
