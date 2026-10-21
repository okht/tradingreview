import { defaultLearning } from './domain.js';

// Match the public provider hosts accepted by the server. Credentials are
// supplied separately and never become part of the persisted model identity.
const PROVIDER_HOSTS = new Set(['api.openai.com', 'api.anthropic.com', 'api.deepseek.com', 'openrouter.ai', 'api.siliconflow.cn', 'dashscope.aliyuncs.com', 'api.minimax.io']);
export function safeModelBaseUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !PROVIDER_HOSTS.has(url.hostname) || url.username || url.password || url.search || url.hash || (url.port && url.port !== '443')) return undefined;
    return url.href.replace(/\/+$/, '');
  } catch { return undefined; }
}
export function modelMetadata(input) {
  if (input?.mode !== 'live') return { mode: 'demo' };
  const baseUrl = safeModelBaseUrl(input.baseUrl);
  return { mode: 'live', provider: input.provider, model: input.model, auth: input.auth, ...(baseUrl ? { baseUrl } : {}) };
}
export function modelIdentity(input) {
  const metadata = modelMetadata(input);
  return JSON.stringify([metadata.mode, metadata.provider || '', metadata.model || '', metadata.auth || '', metadata.baseUrl || '']);
}
export function modelTransitionPatch(state, input) {
  const metadata = modelMetadata(input);
  if (modelIdentity(state.model) === modelIdentity(metadata)) return { model: metadata };
  return { model: metadata, step: 0, reached: Math.min(3, state.reached || 0), analyzed: false, question: '', questionKind: '', liveReviewChat: null, reviewChat: null, activeLearningId: null, editingLearningId: null, learning: { ...defaultLearning }, correction: '', nextDecision: '', nextChecked: false };
}
