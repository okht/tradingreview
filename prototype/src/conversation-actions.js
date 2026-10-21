import { createConversation, validateWorkspace } from './agent-workspace-state.js';

export const CONVERSATION_TITLE_LIMIT = 80;

export function conversationTitleError(value) {
  if (typeof value !== 'string' || !value.trim()) return '请输入复盘名称。';
  if (value.trim().length > CONVERSATION_TITLE_LIMIT) return `名称最多 ${CONVERSATION_TITLE_LIMIT} 个字符。`;
  return '';
}

function requireConversation(state, id) {
  const index = state.conversations.findIndex(item => item.id === id);
  if (index < 0) throw new Error('这次复盘已不存在，请关闭窗口后重试。');
  return index;
}

export function renameConversation(state, id, title) {
  requireConversation(state, id);
  const error = conversationTitleError(title);
  if (error) throw new Error(error);
  return validateWorkspace({ ...state, conversations: state.conversations.map(item => item.id === id
    ? { ...item, title: title.trim(), updatedAt: new Date().toISOString() } : item) });
}

export function deleteConversation(state, id) {
  const index = requireConversation(state, id);
  const conversations = state.conversations.filter(item => item.id !== id);
  if (!conversations.length) conversations.push(createConversation());
  const activeId = state.activeId === id ? conversations[Math.min(index, conversations.length - 1)].id : state.activeId;
  // Saved checks and methods are independent snapshots; keep their source IDs.
  return validateWorkspace({ ...state, activeId, conversations });
}
