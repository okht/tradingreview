import { validateContext } from '../server/contracts.js';
import { JOURNEY_KEY } from './journey-state.js';
import { safeModelBaseUrl } from './model-connection.js';
import { buildLiveContext, liveContextKey } from './live-chat-state.js';
import { validateResearch } from './research-state.js';
import { validateMethod } from '../server/strategy-engine.js';

export const WORKSPACE_KEY = 'huikan.agent.workspace.v2';
export const WORKSPACE_LIMITS = Object.freeze({ conversations: 30, messages: 200, trades: 500, savedItems: 300, bytes: 900000 });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const DEMO = /^(?:DEMO(?:[-\d]|$)|sample[-_])/i;
const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };
const record = (value, label) => { if (!object(value)) fail(`${label}格式无效。`); return value; };
function text(value, label, max = 1000, empty = false) {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim())) fail(`${label}格式或长度无效。`);
  return value;
}
function array(value, label, max) { if (!Array.isArray(value) || value.length > max) fail(`${label}数量或格式无效。`); return value; }
function integer(value, label) { if (!Number.isSafeInteger(value) || value < 0 || value > 1000000000) fail(`${label}无效。`); return value; }
function timestamp(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) fail(`${label}需要带时区的 ISO 时间。`);
  const at = Date.parse(value);
  if (!Number.isFinite(at)) fail(`${label}无效。`);
  const [day, clock] = value.split('T');
  const calendar = new Date(`${day}T00:00:00Z`);
  if (calendar.toISOString().slice(0, 10) !== day || Number(clock.slice(0, 2)) > 23 || Number(clock.slice(3, 5)) > 59 || Number(clock.slice(6, 8)) > 59) fail(`${label}无效。`);
  return new Date(at).toISOString();
}
function ids(value = [], label = '引用', max = 100) {
  const entries = array(value, label, max).map(item => text(item, label, 400));
  if (new Set(entries).size !== entries.length) fail(`${label}不能重复。`);
  return entries;
}
function unique(items, label) { if (new Set(items.map(item => item.id)).size !== items.length) fail(`${label}标识重复。`); return items; }
function realTrades(trades) {
  if (trades.some(trade => DEMO.test(trade?.id ?? '') || DEMO.test(trade?.symbol ?? ''))) fail('正式工作区不接收构造示例交易。');
  return trades;
}
function model(value) {
  if (value == null) return null;
  record(value, '模型');
  if (value.mode !== 'live' || !['openai', 'anthropic', 'openai-compatible'].includes(value.provider) || !['api', 'oauth'].includes(value.auth)) fail('模型连接信息无效。');
  const output = { mode: 'live', provider: value.provider, model: text(value.model, '模型名称', 150).trim(), auth: value.auth };
  if (/[\r\n\0]/.test(output.model)) fail('模型名称无效。');
  if (value.auth === 'oauth' && (value.provider !== 'openai' || value.baseUrl)) fail('订阅授权连接信息无效。');
  if (value.baseUrl) {
    const safe = safeModelBaseUrl(value.baseUrl);
    const expectedHost = value.provider === 'openai' ? 'api.openai.com' : value.provider === 'anthropic' ? 'api.anthropic.com' : null;
    if (!safe || (expectedHost && new URL(safe).hostname !== expectedHost)) fail('模型接口地址无效。');
    output.baseUrl = safe;
  }
  return output;
}
function learning(value) {
  if (value == null) return null;
  record(value, '检查项');
  const output = Object.fromEntries(['title', 'trigger', 'action', 'exception'].map(key => [key, text(value[key], `检查项 ${key}`, 3000, key === 'exception')]));
  if (value.analysisRunId != null) output.analysisRunId = text(value.analysisRunId, '分析记录 ID', 120);
  if (value.evidenceIds !== undefined) output.evidenceIds = ids(value.evidenceIds);
  return output;
}
function reference(value) {
  record(value, '消息引用');
  if (!['trades', 'background', 'evidence', 'market'].includes(value.panel)) fail('消息引用面板无效。');
  const output = { panel: value.panel, label: text(value.label, '引用标题', 300) };
  for (const key of ['tradeId', 'evidenceId']) if (value[key] !== undefined) output[key] = text(value[key], key, 400, true);
  return output;
}
function signature(value) {
  text(value, '模型身份', 4000);
  let fields; try { fields = JSON.parse(value); } catch { fail('模型身份格式无效。'); }
  if (!Array.isArray(fields) || fields.length !== 5) fail('模型身份格式无效。');
  const metadata = model({ mode: fields[0], provider: fields[1], model: fields[2], auth: fields[3], baseUrl: fields[4] });
  return JSON.stringify([metadata.mode, metadata.provider, metadata.model, metadata.auth, metadata.baseUrl || '']);
}
function evidenceSnapshot(value) {
  record(value, '消息证据');
  if (!['trade', 'background', 'event', 'market'].includes(value.type) || !['before', 'after', 'unknown', 'recollection'].includes(value.timeClass)) fail('消息证据类型或时点无效。');
  const output = { id: text(value.id, '证据 ID', 400), tradeId: text(value.tradeId ?? '', '证据交易 ID', 120, true), type: value.type, timeClass: value.timeClass,
    title: text(value.title ?? '', '证据标题', 300, true), text: text(value.text ?? '', '证据原文', 20000, true), source: text(value.source ?? '', '证据来源', 500, true) };
  for (const key of ['publishedAt', 'recordedAt']) output[key] = value[key] == null ? null : text(value[key], key, 40, true);
  for (const key of ['marketState', 'cutoff', 'rangeStart', 'rangeEnd']) if (value[key] !== undefined) output[key] = text(value[key], key, 80, true);
  if (value.barCount !== undefined) output.barCount = integer(value.barCount, '行情根数');
  if (value.synthetic === true) output.synthetic = true;
  if (value.url) {
    let link; try { link = new URL(text(value.url, '证据链接', 2048)); } catch { fail('证据链接无效。'); }
    if (!['https:', 'http:'].includes(link.protocol) || link.username || link.password) fail('证据链接无效。');
    if (![...link.searchParams.keys()].some(key => /token|secret|password|api[-_]?key|authorization/i.test(key))) output.url = link.href;
  }
  return output;
}
function message(value, revision) {
  record(value, '消息');
  if (!['user', 'assistant'].includes(value.role)) fail('消息角色无效。');
  const output = { id: text(value.id, '消息 ID', 120), role: value.role, text: text(value.text, '消息内容', 24000, true),
    refs: array(value.refs ?? [], '消息引用', 100).map(reference),
    suggestions: unique(array(value.suggestions ?? [], '追问建议', 10).map(item => { record(item, '追问建议'); return { id: text(item.id, '建议 ID', 120), text: text(item.text, '建议内容', 2000) }; }), '追问建议'),
  };
  if (value.learning !== undefined) output.learning = learning(value.learning);
  if (value.research !== undefined) output.research = validateResearch(value.research);
  if (value.analysisRunId != null) output.analysisRunId = text(value.analysisRunId, '分析记录 ID', 120);
  if (value.evidenceIds !== undefined) output.evidenceIds = ids(value.evidenceIds);
  if (value.createdAt !== undefined) output.createdAt = timestamp(value.createdAt, '消息时间');
  if (value.modelLabel !== undefined) output.modelLabel = text(value.modelLabel, '模型标签', 200, true);
  if (value.modelSignature !== undefined) output.modelSignature = signature(value.modelSignature);
  if (value.evidence !== undefined) output.evidence = unique(array(value.evidence, '消息证据', 100).map(evidenceSnapshot), '消息证据');
  if (value.contextRevision !== undefined) {
    output.contextRevision = integer(value.contextRevision, '消息材料版本');
    if (output.contextRevision > revision) fail('消息材料版本超出当前会话版本。');
  }
  return output;
}
function pendingTrades(value) {
  if (value == null) return null;
  record(value, '待确认交易');
  const trades = realTrades(array(value.trades, '待确认交易', WORKSPACE_LIMITS.trades)).map(item => {
    record(item, '待确认交易');
    const output = {};
    for (const key of ['id', 'symbol', 'name', 'time']) output[key] = item[key] == null ? null : text(item[key], key, key === 'name' ? 200 : 120, true);
    if (item.side != null && !['', 'buy', 'sell'].includes(item.side)) fail('待确认方向无效。');
    output.side = item.side ?? null;
    for (const key of ['quantity', 'price', 'fee']) {
      if (item[key] != null && (typeof item[key] !== 'number' || !Number.isFinite(item[key]) || item[key] < 0 || item[key] > Number.MAX_SAFE_INTEGER / 100)) fail('待确认数值无效。');
      output[key] = item[key] ?? null;
    }
    return output;
  });
  const output = { trades, questions: array(value.questions ?? [], '待确认问题', 20).map(item => text(item, '待确认问题', 2000)), warnings: array(value.warnings ?? [], '待确认提示', 20).map(item => text(item, '待确认提示', 2000)), origin: text(value.origin ?? '', '待确认来源', 300, true) };
  return output;
}
function lastRequest(value, revision) {
  if (value == null) return null;
  record(value, '未完成请求');
  const output = { id: text(value.id, '请求 ID', 120), text: text(value.text, '请求内容', 16000) };
  if (value.task !== undefined) { if (!['parse', 'background', 'review'].includes(value.task)) fail('请求任务无效。'); output.task = value.task; }
  if (value.createdAt !== undefined) output.createdAt = timestamp(value.createdAt, '请求时间');
  if (value.modelLabel !== undefined) output.modelLabel = text(value.modelLabel, '请求模型', 200, true);
  if (value.modelSignature !== undefined) output.modelSignature = signature(value.modelSignature);
  if (value.contextRevision !== undefined) { output.contextRevision = integer(value.contextRevision, '请求材料版本'); if (output.contextRevision > revision) fail('请求材料版本无效。'); }
  return output;
}

export function createConversation() {
  const now = new Date().toISOString();
  return { id: crypto.randomUUID(), title: '新对话', createdAt: now, updatedAt: now, trades: [], selectedIds: [], origin: '', contexts: {}, marketMode: 'import', marketData: null, evidence: [], messages: [], draft: '', pendingTrades: null, lastRequest: null, contextRevision: 0 };
}
export function createWorkspace() {
  const conversation = createConversation();
  return { version: 2, model: null, activeId: conversation.id, conversations: [conversation], savedItems: [] };
}

function conversation(value) {
  record(value, '会话');
  if (value.marketMode !== 'import') fail('正式工作区只接收真实导入材料。');
  const context = validateContext({ trades: realTrades(array(value.trades, '交易', WORKSPACE_LIMITS.trades)), contexts: value.contexts, marketMode: 'import', origin: value.origin,
    evidence: value.evidence ?? [], ...(value.marketData ? { marketData: value.marketData } : {}) });
  const selectedIds = ids(value.selectedIds, '选中交易', WORKSPACE_LIMITS.trades);
  if (selectedIds.some(id => !context.trades.some(trade => trade.id === id))) fail('选中交易超出当前会话。');
  const contextRevision = integer(value.contextRevision, '材料版本');
  const output = { id: text(value.id, '会话 ID', 120), title: text(value.title, '会话标题', 200), createdAt: timestamp(value.createdAt, '创建时间'), updatedAt: timestamp(value.updatedAt, '更新时间'),
    trades: context.trades, selectedIds, origin: text(value.origin, '材料来源', 300, true), contexts: context.contexts, marketMode: 'import', marketData: context.marketData ?? null, evidence: context.evidence ?? [],
    messages: unique(array(value.messages, '会话消息', WORKSPACE_LIMITS.messages).map(item => message(item, contextRevision)), '消息'), draft: text(value.draft, '草稿', 16000, true), pendingTrades: pendingTrades(value.pendingTrades), lastRequest: lastRequest(value.lastRequest, contextRevision), contextRevision };
  if (Date.parse(output.updatedAt) < Date.parse(output.createdAt)) fail('更新时间不能早于创建时间。');
  if (value.research !== undefined) output.research = validateResearch(value.research);
  if (value.retrievalStatus !== undefined) output.retrievalStatus = text(value.retrievalStatus, '取证状态', 1000, true);
  return output;
}
function savedItem(value) {
  record(value, '保存检查项');
  const output = { ...learning(value), id: text(value.id, '检查项 ID', 120) };
  if (value.conversationId !== undefined) output.conversationId = text(value.conversationId, '检查项会话 ID', 120);
  for (const key of ['reviewId', 'messageId']) if (value[key] != null) output[key] = text(value[key], key, 120);
  if (value.question !== undefined) output.question = text(value.question, '检查项问题', 16000, true);
  if (value.savedAt !== undefined) output.savedAt = timestamp(value.savedAt, '保存时间');
  return output;
}

/** Shared strict validation for browser persistence and the server write boundary. */
export function validateWorkspace(input) {
  record(input, '工作区');
  if (input.version !== 2) fail('工作区版本无效。');
  const conversations = unique(array(input.conversations, '会话', WORKSPACE_LIMITS.conversations).map(conversation), '会话');
  const conversationIds = new Set(conversations.map(item => item.id));
  const activeId = input.activeId == null ? null : text(input.activeId, '当前会话 ID', 120);
  if ((conversations.length && !conversationIds.has(activeId)) || (!conversations.length && activeId !== null)) fail('当前会话不存在。');
  const output = { version: 2, model: model(input.model), activeId, conversations, savedItems: unique(array(input.savedItems, '保存检查项', WORKSPACE_LIMITS.savedItems).map(savedItem), '检查项') };
  if (input.methods !== undefined) output.methods = unique(array(input.methods, '交易方法', 60).map(validateMethod), '交易方法');
  if (new TextEncoder().encode(JSON.stringify(output)).byteLength > WORKSPACE_LIMITS.bytes) throw Object.assign(new Error('工作区超过 900 KB，请导出归档或减少历史会话。'), { status: 413 });
  return output;
}

/** Only one legacy review with identifiable imported data can be migrated. */
export function migrateJourney(input) {
  const next = createWorkspace();
  if (!object(input) || input.version !== 1) return next;
  try { if (input.model?.mode === 'live') next.model = model(input.model); } catch { /* Invalid metadata never restores a credential. */ }
  const real = input.marketMode === 'import' && Array.isArray(input.trades) && input.trades.length > 0
    && !input.trades.some(trade => DEMO.test(trade?.id ?? '') || DEMO.test(trade?.symbol ?? '')) && !/示例|演示|构造|sample|demo/i.test(input.origin ?? '');
  if (!real) return next;
  const base = next.conversations[0];
  let imported;
  try {
    imported = conversation({ ...base, title: typeof input.question === 'string' && input.question.trim() ? input.question.trim().slice(0, 200) : '已导入的复盘', trades: input.trades,
      selectedIds: Array.isArray(input.selectedIds) ? input.selectedIds : input.trades.map(trade => trade.id), origin: typeof input.origin === 'string' ? input.origin : '', contexts: input.contexts ?? {}, marketData: input.marketData ?? null, evidence: input.evidence ?? [] });
  } catch { return next; }
  const legacyContext = buildLiveContext(input, input.trades.filter(trade => imported.selectedIds.includes(trade.id)));
  const savedChat = input.liveReviewChat;
  const chat = input.model?.mode === 'live' && object(savedChat) && savedChat.version === 1 && savedChat.contextKey === liveContextKey(legacyContext) ? savedChat : null;
  if (chat) {
    try {
      const snapshots = Array.isArray(chat.evidence) ? chat.evidence : [];
      imported.messages = unique(array(chat.messages ?? [], '旧消息', WORKSPACE_LIMITS.messages + 1).filter(item => item?.id !== 'live-opening').map(item => {
        const referenced = new Set([...(Array.isArray(item.evidenceIds) ? item.evidenceIds : []), ...(Array.isArray(item.refs) ? item.refs.map(ref => ref?.evidenceId) : [])]);
        return message({ ...item, evidence: item.evidence ?? snapshots.filter(proof => referenced.has(proof?.id)) }, 0);
      }), '旧消息');
      if (imported.messages.length > WORKSPACE_LIMITS.messages) fail('旧消息过多。');
      imported.draft = text(chat.draft ?? '', '旧草稿', 16000, true);
      imported.lastRequest = lastRequest(chat.lastRequest, 0);
    } catch { imported.messages = []; imported.draft = ''; imported.lastRequest = null; }
  }
  next.conversations = [imported]; next.activeId = imported.id;
  const realRuns = new Set(imported.messages.filter(item => item.role === 'assistant').flatMap(item => [item.analysisRunId, item.learning?.analysisRunId]).filter(Boolean));
  next.savedItems = (Array.isArray(input.savedItems) ? input.savedItems : []).slice(0, WORKSPACE_LIMITS.savedItems).flatMap(item => {
    if (!object(item) || typeof input.reviewId !== 'string' || item.reviewId !== input.reviewId || !realRuns.has(item.analysisRunId)) return [];
    try { return [savedItem({ ...item, conversationId: imported.id })]; } catch { return []; }
  });
  return validateWorkspace(next);
}

/** Read only: migration never modifies or removes the legacy key. */
export function readWorkspace(storage) {
  const saved = storage?.getItem(WORKSPACE_KEY);
  if (saved != null) {
    let parsed; try { parsed = JSON.parse(saved); } catch { fail('本机工作区无法读取，原记录仍保留，请先导出原始数据。'); }
    return validateWorkspace(parsed);
  }
  const legacy = storage?.getItem(JOURNEY_KEY);
  if (!legacy) return createWorkspace();
  try { return migrateJourney(JSON.parse(legacy)); } catch { return createWorkspace(); }
}
