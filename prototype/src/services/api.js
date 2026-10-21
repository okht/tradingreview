import { modelIdentity } from '../model-connection.js';
import { experienceHeaders } from '../experience-mode.js';

// Credentials live only in this module for the lifetime of the page.
let sessionConfig = null;
let financialConfig = null;
export function setFinancialConfig(value) { financialConfig = value ? { ...value } : null; }
export function getFinancialConfig() { return financialConfig ? { ...financialConfig } : null; }

export function clearSessionConfig() { sessionConfig = null; }
export function setSessionConfig(config) { sessionConfig = { ...config }; }
export function getSessionConfig(model) {
  if (model?.mode !== 'live') throw new Error('请先连接模型。');
  if (sessionConfig && modelIdentity({ ...sessionConfig, mode: 'live' }) === modelIdentity(model)) return { ...sessionConfig };
  if (model.auth === 'oauth') return { provider: model.provider, model: model.model, auth: 'oauth' };
  throw new Error('本页尚未连接模型。刷新后需要重新填写 API Key。');
}
export function hasSessionConfig(model) { try { getSessionConfig(model); return true; } catch { return false; } }

const AGENT_ERROR_CODES = new Set(['ANALYSIS_FAILED', 'INVALID_MESSAGES', 'INPUT_TOO_LONG', 'INVALID_TASK', 'INVALID_IMPORT', 'INVALID_INPUT', 'INVALID_CONTEXT', 'IMAGE_UNSUPPORTED', 'ABORTED', 'TIMEOUT', 'RUN_LIMIT', 'MODEL_ERROR', 'IMPORT_TOO_LARGE', 'INVALID_RESULT']);
function agentError(value, fallback) {
  const code = AGENT_ERROR_CODES.has(value?.code) ? value.code : undefined;
  const message = value?.message || value?.error?.message || (typeof value?.error === 'string' ? value.error : fallback);
  const error = new Error(`${message}${code ? `（${code}）` : ''}`);
  if (code) error.code = code;
  return error;
}

export async function apiRequest(path, { body, signal, method = body === undefined ? 'GET' : 'POST' } = {}) {
  const response = await fetch(path, { method, signal, credentials: 'same-origin', headers: { ...experienceHeaders(), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  let result;
  try { result = await response.json(); } catch { throw new Error('服务没有返回有效结果，请确认本地服务已启动。'); }
  if (!response.ok || result?.ok === false) throw new Error(result?.message || result?.error?.message || (typeof result?.error === 'string' ? result.error : `请求失败（${response.status}）`));
  return result;
}

// Supports CRLF, chunk boundaries and multi-line SSE data fields.
export function createSseDecoder(onEvent) {
  let buffer = '';
  function process(block) {
    const data = block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
    if (!data || data === '[DONE]') return;
    let event;
    try { event = JSON.parse(data); } catch { throw new Error('服务返回了无法读取的事件。'); }
    if (!event || typeof event.type !== 'string') throw new Error('服务事件缺少类型。');
    onEvent(event);
  }
  return {
    push(chunk) {
      buffer += chunk;
      let match;
      while ((match = /\r?\n\r?\n/.exec(buffer))) { process(buffer.slice(0, match.index)); buffer = buffer.slice(match.index + match[0].length); }
    },
    finish() { if (buffer.trim()) process(buffer); buffer = ''; },
  };
}

export async function runAgent({ task, model, context, research, prepareTradeIds, messages = [], text = '', images = [], signal, onEvent = () => {} }) {
  const config = getSessionConfig(model);
  const response = await fetch('/api/agent/stream', { method: 'POST', signal, credentials: 'same-origin', headers: { ...experienceHeaders(), 'Content-Type': 'application/json', Accept: 'text/event-stream' }, body: JSON.stringify({ task, config, context, messages, text, ...(['review', 'prepare'].includes(task) ? { financialConfig } : {}), ...(task === 'prepare' && prepareTradeIds !== undefined ? { prepareTradeIds } : {}), ...(task === 'review' ? { research } : {}), ...(task === 'import' ? { images } : {}) }) });
  if (!response.ok) {
    let error;
    try { error = await response.json(); } catch { /* Keep HTTP status fallback. */ }
    throw agentError(error, `请求失败（${response.status}）`);
  }
  if (!response.body) throw new Error('服务没有返回响应内容。');
  let result;
  let completed = false;
  const decoder = createSseDecoder(event => {
    if (event.type === 'error') throw agentError(event, '本次处理失败，请重试。');
    if (event.type === 'result') { result = event.result; completed = true; }
    onEvent(event);
  });
  const reader = response.body.getReader();
  const utf8 = new TextDecoder();
  try {
    while (true) { const { done, value } = await reader.read(); if (done) break; decoder.push(utf8.decode(value, { stream: true })); }
    decoder.push(utf8.decode()); decoder.finish();
  } catch (error) {
    try { await reader.cancel(); } catch { /* Preserve the original failure. */ }
    throw error;
  } finally { reader.releaseLock(); }
  if (signal?.aborted) throw new DOMException('已停止', 'AbortError');
  if (!completed || result == null) throw new Error('连接已结束，但没有收到完整结果。可以重试。');
  return result;
}

export function parseTradeFile({ model, text, images = [], signal, onEvent }) {
  return runAgent({ task: 'import', model, text, images, signal, onEvent });
}
