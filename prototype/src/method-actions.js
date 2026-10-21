import { validateWorkspace } from './agent-workspace-state.js';

export const METHOD_TITLE_LIMIT = 120;

export function methodTitleError(value) {
  if (typeof value !== 'string' || !value.trim()) return '请输入交易方法名称。';
  if (value.trim().length > METHOD_TITLE_LIMIT) return `名称最多 ${METHOD_TITLE_LIMIT} 个字符。`;
  return '';
}

function requireSavedMethod(state, id) {
  if (!state.methods?.some(item => item.id === id)) throw new Error('这套交易方法已不存在，请关闭窗口后重试。');
}

export function renameSavedMethod(state, id, title) {
  requireSavedMethod(state, id);
  const error = methodTitleError(title);
  if (error) throw new Error(error);
  const rename = method => method.id === id ? { ...method, title: title.trim() } : method;
  const research = value => value ? { ...value, methods: value.methods.map(rename) } : value;
  return validateWorkspace({ ...state, methods: state.methods.map(rename), conversations: state.conversations.map(item => ({ ...item,
    ...(item.research !== undefined ? { research: research(item.research) } : {}),
    messages: item.messages.map(message => message.research !== undefined ? { ...message, research: research(message.research) } : message),
  })) });
}

export function deleteSavedMethod(state, id) {
  requireSavedMethod(state, id);
  // Research snapshots remain available for later inspection or saving again.
  return validateWorkspace({ ...state, methods: state.methods.filter(item => item.id !== id) });
}
