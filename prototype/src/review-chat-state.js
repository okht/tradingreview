import { EXAMPLE_CONTEXT, questionOptions } from './journey-state.js';
import { sampleTrades } from './domain.js';

// Pure, local demonstration dialogue. No model call, semantic classification,
// timestamp inference, or writes to the user's earlier background records.
const VERSION = 1;
const MAX_DRAFT = 6000;
const MAX_TEXT = 12000;
const MAX_MESSAGES = 101; // Opening plus 50 complete exchanges, all retained.
const PANELS = new Set(['trades', 'background', 'evidence']);
const KINDS = new Set(['', 'add', 'entry', 'exit', 'holding', 'learn', 'custom']);
const TRADE_FIELDS = ['id', 'symbol', 'name', 'time', 'side', 'quantity', 'price', 'fee'];
const NOTE_FIELDS = ['reason', 'plan', 'source', 'reference', 'unknown'];
const ANSWERS = Object.freeze({
  'answer:reason:plan': '我记得是按原先计划执行的',
  'answer:reason:record': '我能找到当时的理由记录',
  'answer:reason:unknown': '记不清当时的具体依据了',
  'answer:plan:record': '有当时的计划记录可以核对',
  'answer:plan:memory': '我记得有计划，暂时找不到记录',
  'answer:plan:unknown': '没有明确记录，先保留未知',
  'answer:source:record': '我能找到当时的信息出处',
  'answer:source:memory': '目前只有回忆，还没有原始出处',
  'answer:source:unknown': '记不清信息来自哪里了',
  'answer:time:earlier': '我记得有更早的消息，还没找到记录',
  'answer:time:later': '可能把后来的公告记成当时依据了',
  'answer:time:unknown': '记不清消息出现的时间',
  'deeper:records': '还需要补充哪些原始记录？',
  'deeper:checklist': '怎样写成下次的检查项？',
});

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const boundedString = (value, max, allowEmpty = false) => typeof value === 'string' && value.length <= max && (allowEmpty || value.trim().length > 0);
const text = value => typeof value === 'string' ? value : '';
const clean = value => text(value).trim();
const copy = value => JSON.parse(JSON.stringify(value));

function contextTrades(context) {
  if (!Array.isArray(context?.trades)) return [];
  return context.trades.filter(trade => object(trade) && boundedString(trade.id, 200)
    && typeof trade.time === 'string' && ['buy', 'sell'].includes(trade.side)
    && Number.isFinite(trade.quantity) && trade.quantity > 0)
    .slice().sort((a, b) => a.time.localeCompare(b.time) || a.id.localeCompare(b.id));
}
function noteFor(context, tradeId) {
  return object(context?.contexts?.[tradeId]) ? context.contexts[tradeId] : {};
}
function topics(context) { return questionOptions(contextTrades(context)); }
function suggestions(ids) { return ids.map(id => ({ id, text: ANSWERS[id] })); }
function topicSuggestions(context) { return topics(context).map(({ id, text: label }) => ({ id, text: label })).slice(0, 3); }
function deeperSuggestions(context, topic) {
  const nextTopic = topics(context).find(option => option.id !== topic.kind);
  return [...suggestions(['deeper:records', 'deeper:checklist']), ...(nextTopic ? [{ id: nextTopic.id, text: nextTopic.text }] : [])];
}
function registry(context) {
  const hasOrder = contextTrades(context).some(trade => hasOrderFixture(context, trade));
  return new Map([...Object.entries(ANSWERS).filter(([id]) => !id.startsWith('answer:time:') || hasOrder), ...topics(context).map(option => [option.id, option.text])]);
}
function ref(panel, trade, label) { return trade ? { panel, tradeId: trade.id, label } : null; }
function refs(...items) { return items.filter(Boolean); }
function tradeFor(context, topic) {
  const trades = contextTrades(context);
  return trades.find(trade => trade.id === topic.tradeId) ?? trades[0];
}
function describeTrade(trade) {
  if (!trade) return '当前没有选中的交易。';
  const price = trade.price == null ? '成交价待补充' : `成交价 ${trade.price} 元`;
  return `${trade.name || trade.symbol || '当前标的'}在 ${trade.time.replace('T', ' ')} ${trade.side === 'buy' ? '买入' : '卖出'} ${trade.quantity} 股，${price}。`;
}
function quote(value) {
  const valueText = text(value);
  return `「${valueText.length > 700 ? `${valueText.slice(0, 700)}…` : valueText}」`;
}
function sourceLimit(context) {
  return context?.marketMode === 'sample' ? '' : '当前只有你提供的成交与背景，尚无对应行情或事件数据。\n\n';
}
function backgroundText(note) {
  if (note.unknown || !clean(note.reason)) return '';
  const source = note.source === '当时记录' ? '你标记为「当时记录」的内容，原始出处和时间仍需核实' : '现在补充的回忆';
  return `你留下的理由是${quote(note.reason)}。这属于${source}。\n\n`;
}

// An exact known fixture protects against false matches such as a user saying
// they did NOT trade because of an order announcement. Free text is not parsed.
function hasOrderFixture(context, trade) {
  const original = sampleTrades.find(item => item.id === 'DEMO-02');
  if (context?.marketMode !== 'sample' || !trade || !original) return false;
  const normalizedTime = trade.time === '2025-09-08T10:00:00' ? '2025-09-08T10:00' : trade.time;
  if (!TRADE_FIELDS.every(field => (field === 'time' ? normalizedTime : trade[field]) === original[field])) return false;
  const note = noteFor(context, trade.id);
  return note.unknown !== true && clean(note.reason) === EXAMPLE_CONTEXT['DEMO-02'].reason;
}

/** Exact canonical serialization avoids hash collisions and ignores display order. */
export function reviewContextKey(context) {
  const trades = contextTrades(context);
  const noPlan = trades.filter(trade => noteFor(context, trade.id).noPlan === true).map(trade => trade.id);
  return JSON.stringify({
    version: VERSION,
    marketMode: text(context?.marketMode),
    origin: text(context?.origin),
    trades: trades.map(trade => TRADE_FIELDS.map(field => trade[field] ?? null)),
    contexts: trades.map(trade => [trade.id, ...NOTE_FIELDS.map(field => noteFor(context, trade.id)[field] ?? null)]),
    // Preserve existing keys when the new option has never been selected.
    ...(noPlan.length ? { noPlan } : {}),
  });
}

function opening(context) {
  const trades = contextTrades(context);
  const recorded = trades.filter(trade => clean(noteFor(context, trade.id).reason) || noteFor(context, trade.id).unknown === true).length;
  return {
    id: 'm-0', role: 'assistant',
    text: trades.length
      ? `已整理这次选择的 ${trades.length} 笔交易，其中 ${recorded} 笔已补充理由或标记为记不清。\n\n你想先弄清哪个问题？可以从下面选一个，也可以直接说说你的疑问。`
      : '请先选择至少一笔交易，再开始复盘。',
    refs: [], suggestions: topicSuggestions(context), allowLearning: false,
  };
}

export function createReviewChat(context) {
  return { version: VERSION, contextKey: reviewContextKey(context), messages: [opening(context)], draft: '', pick: null, topic: { kind: '', question: '', tradeId: '' } };
}

function validTopic(topic, context) {
  if (!object(topic) || !KINDS.has(topic.kind) || !boundedString(topic.question, MAX_DRAFT, true) || typeof topic.tradeId !== 'string') return false;
  if (!topic.kind) return topic.question === '' && topic.tradeId === '';
  if (!clean(topic.question) || !contextTrades(context).some(trade => trade.id === topic.tradeId)) return false;
  if (topic.kind === 'custom') return true;
  return topics(context).some(option => option.id === topic.kind && option.text === topic.question && option.tradeId === topic.tradeId);
}
function validRef(value, context) {
  if (!object(value) || !PANELS.has(value.panel) || !boundedString(value.label, 200)) return false;
  const trade = contextTrades(context).find(item => item.id === value.tradeId);
  return Boolean(trade) && (value.panel !== 'evidence' || hasOrderFixture(context, trade));
}
function validSuggestion(value, known) {
  return object(value) && typeof value.id === 'string' && known.get(value.id) === value.text;
}

/** Invalid or stale chat data resets only this chat, not the surrounding journey. */
export function restoreReviewChat(saved, context) {
  const fresh = () => createReviewChat(context);
  try {
    if (!object(saved) || saved.version !== VERSION || saved.contextKey !== reviewContextKey(context)
      || !boundedString(saved.draft, MAX_DRAFT, true) || !validTopic(saved.topic, context)
      || !Array.isArray(saved.messages) || !saved.messages.length || saved.messages.length > MAX_MESSAGES || saved.messages.length % 2 !== 1) return fresh();
    const known = registry(context);
    const ids = new Set();
    for (let index = 0; index < saved.messages.length; index++) {
      const message = saved.messages[index];
      if (!object(message) || !/^m-\d{1,9}$/.test(message.id) || ids.has(message.id)
        || message.role !== (index % 2 === 0 ? 'assistant' : 'user') || !boundedString(message.text, MAX_TEXT)
        || typeof message.allowLearning !== 'boolean' || !Array.isArray(message.refs) || message.refs.length > 10
        || message.refs.some(item => !validRef(item, context)) || !Array.isArray(message.suggestions) || message.suggestions.length > 3
        || message.suggestions.some(item => !validSuggestion(item, known))
        || new Set(message.suggestions.map(item => item.id)).size !== message.suggestions.length
        || (message.role === 'user' && (message.refs.length || message.suggestions.length || message.allowLearning))) return fresh();
      ids.add(message.id);
    }
    if (saved.messages[0].id !== 'm-0' || saved.messages[0].allowLearning) return fresh();
    if (saved.pick !== null && (!object(saved.pick) || !boundedString(saved.pick.id, 200) || !boundedString(saved.pick.text, MAX_DRAFT))) return fresh();
    const restored = copy(saved);
    const last = restored.messages.at(-1);
    if (restored.pick && (restored.draft !== restored.pick.text || !last.suggestions.some(item => item.id === restored.pick.id && item.text === restored.pick.text))) restored.pick = null;
    return restored;
  } catch { return fresh(); }
}

function responseForTopic(context, topic) {
  const trade = tradeFor(context, topic);
  const note = noteFor(context, trade?.id);
  const baseRefs = refs(ref('trades', trade, '查看对应成交'), ref('background', trade, '查看这笔背景'));
  const facts = `${sourceLimit(context)}${describeTrade(trade)}\n\n`;
  if (topic.kind === 'learn') return {
    text: `${facts}可以先留下一个可尝试的记录方法：决定前写下依据、来源时间，以及需要重新评估的变化条件。\n\n这是候选检查项，不说明本次操作已经被证明有效；当时理由不清楚的部分继续保留未知。`,
    refs: baseRefs, suggestions: deeperSuggestions(context, topic), allowLearning: true,
  };
  if (note.unknown || !clean(note.reason)) return {
    text: `${facts}${note.unknown ? '你把这笔理由标记为记不清，目前仍保留未知。' : '这笔决定还没有对应的理由。'}\n\n当时促使你作出这次决定的主要依据是什么？`,
    refs: baseRefs, suggestions: suggestions(['answer:reason:plan', 'answer:reason:record', 'answer:reason:unknown']), allowLearning: false,
  };
  if (topic.kind === 'add' && hasOrderFixture(context, trade)) return {
    text: `${facts}${backgroundText(note)}与这份示例理由对应的构造公告在 09-08 11:30 发布，晚于 10:00 的成交 90 分钟，不能直接作为买入前已知的依据。\n\n你当时看到的消息，有更早的原始记录可以核对吗？`,
    refs: [...baseRefs, ref('evidence', trade, '查看示例订单公告')], suggestions: suggestions(['answer:time:earlier', 'answer:time:later', 'answer:time:unknown']), allowLearning: false,
  };
  const question = topic.kind === 'entry' ? '支持这次买入的主要信息，有当时的原始出处吗？'
    : topic.kind === 'exit' ? '卖出前，是否已经写下退出条件？'
      : topic.kind === 'holding' ? '当时是否写下过需要重新评估持仓的变化条件？'
        : '这次追加之前，是否已有写下的加仓条件？';
  return {
    text: `${facts}${backgroundText(note)}${question}`,
    refs: baseRefs,
    suggestions: topic.kind === 'entry' ? suggestions(['answer:source:record', 'answer:source:memory', 'answer:source:unknown']) : suggestions(['answer:plan:record', 'answer:plan:memory', 'answer:plan:unknown']),
    allowLearning: false,
  };
}

function responseForAnswer(context, topic, id, userText) {
  const trade = tradeFor(context, topic);
  const baseRefs = refs(ref('trades', trade, '查看对应成交'), ref('background', trade, '查看原先背景'));
  const order = hasOrderFixture(context, trade);
  if (id === 'deeper:records') return {
    text: `${sourceLimit(context)}可以优先补齐三类材料：成交原始字段；这笔决定前的理由或计划记录；相关信息的原文和公开时间。\n\n${order ? '示例公告的 11:30 发布时间晚于 10:00 成交。若你记得更早的信息，仍需找到那条信息的原始出处。' : '现在补录的内容继续注明为回忆，记录的时间与所述事件发生时间分开核对。'}`,
    refs: [...baseRefs, ...(order ? [ref('evidence', trade, '核对示例公告时点')] : [])], suggestions: deeperSuggestions(context, topic), allowLearning: true,
  };
  if (id === 'deeper:checklist') return {
    text: '可以写成一条候选检查项：\n\n适用时机：准备作出类似的投资决定前。\n具体动作：写下当前依据、信息来源和时间，再核对原先计划及变化条件。\n例外与边界：缺少记录或记不清时，保留待确认，不把回忆当成已验证事实。\n\n你可以继续编辑这些措辞，再保存到下一步。',
    refs: baseRefs, suggestions: deeperSuggestions(context, topic), allowLearning: true,
  };
  let conclusion;
  if (id.startsWith('answer:time:') && !order) conclusion = '当前没有与这笔决定匹配的公告证据，先保留你本轮补充的回忆，信息时间仍需核对。';
  else if (id === 'answer:time:earlier') conclusion = '更早的信息是你这轮补充的可能解释，还需要原文和发布时间支持；现有 11:30 示例公告与 10:00 成交的时间差仍然保留。';
  else if (id === 'answer:time:later') conclusion = '你提出了记忆关联可能出错的解释。当前不能据此认定存在某种行为偏差，仍需核对当时资料。';
  else if (id === 'answer:time:unknown' || id.endsWith(':unknown')) conclusion = '这部分保留未知。缺少记录不足以判断决定质量，可以把需要补齐的材料留到下一次检查。';
  else if (id.endsWith(':record')) conclusion = '下一步可核对原记录的内容、形成时间和出处；目前这里只保存了你表示能找到记录的补充，尚未验证材料本身。';
  else conclusion = '目前这是你本轮补充的回忆。是否已有计划、是否按计划执行，仍需决策前的原记录支持。';
  return {
    text: `${sourceLimit(context)}你这轮补充的是${quote(userText)}。\n\n${conclusion}\n\n这条补充仅保留在当前对话，之前的背景记录未被改写。`,
    refs: [...baseRefs, ...(id.startsWith('answer:time:') && order ? [ref('evidence', trade, '核对示例公告时点')] : [])],
    suggestions: deeperSuggestions(context, topic), allowLearning: true,
  };
}

/** Appends a complete synchronous demonstration turn, never a fabricated AI run. */
export function sendReviewMessage(thread, context) {
  const current = restoreReviewChat(thread, context);
  if (current.messages.length >= MAX_MESSAGES) return current;
  const raw = current.draft;
  const userText = raw.trim();
  if (!userText || !contextTrades(context).length) return current;
  const available = current.messages.at(-1).suggestions;
  const picked = current.pick && raw === current.pick.text
    && available.find(item => item.id === current.pick.id && item.text === current.pick.text);
  const selectedTopic = picked && topics(context).find(option => option.id === picked.id && option.text === picked.text);
  let topic = { ...current.topic };
  let response;
  if (selectedTopic) {
    topic = { kind: selectedTopic.id, question: selectedTopic.text, tradeId: selectedTopic.tradeId };
    response = responseForTopic(context, topic);
  } else if (picked && topic.kind && topic.kind !== 'custom' && Object.hasOwn(ANSWERS, picked.id)) {
    response = responseForAnswer(context, topic, picked.id, userText);
  } else {
    if (!topic.kind) topic = { kind: 'custom', question: userText, tradeId: contextTrades(context)[0].id };
    response = {
      text: `${sourceLimit(context)}这段文字已保留在当前对话。当前为示例模式，未调用真实 AI，未对自由输入自动归因，也未改写之前的背景记录。\n\n你可以选择下方预设问题继续体验核对过程，或返回补充原始材料。`,
      refs: refs(ref('background', tradeFor(context, topic), '查看对应背景')), suggestions: topicSuggestions(context), allowLearning: false,
    };
  }
  const nextId = Math.max(...current.messages.map(message => Number(message.id.slice(2)))) + 1;
  const messages = [...current.messages,
    { id: `m-${nextId}`, role: 'user', text: userText, refs: [], suggestions: [], allowLearning: false },
    { id: `m-${nextId + 1}`, role: 'assistant', ...response },
  ];
  return { ...current, messages, draft: '', pick: null, topic };
}
