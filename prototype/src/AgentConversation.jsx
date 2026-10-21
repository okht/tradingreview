import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Bookmark, Check, CheckCircle2, ChevronDown, CircleAlert, CircleX, FileText, Info, LoaderCircle, Paperclip, Plus, RotateCcw, Sparkles, Square, Trash2, Import } from 'lucide-react';
import { Button, IconButton, Tag } from './ui.jsx';
import { hasSessionConfig, runAgent, apiRequest } from './services/api.js';
import ResearchPanel from './ResearchPanel.jsx';
import InlineCitations from './InlineCitations.jsx';
import { executeResearchWorkflow } from './research-workflow.js';
import { importIssues } from './import-dialog-state.js';
import { modelIdentity } from './model-connection.js';
import { StyledSelect } from './SelectionControls.jsx';
import DateTimePicker from './DateTimePicker.jsx';
import { canRetryRequest, confirmPendingTrades, CONVERSATION_MESSAGE_LIMIT, conversationContext, conversationHistory, conversationScopeKey, messageIsCurrent, parseRequestText, parseResponseText, pendingFromParse, reviewMessageResult } from './agent-conversation-state.js';
import './agent-conversation.css';

const now = () => new Date().toISOString();
const labelFor = model => model?.model || '连接模型';
const numericFields = new Set(['quantity', 'price', 'fee']);
const candidateFields = [
  ['name', '标的名称', 'text'], ['symbol', '标的代码', 'text'],
  ['time', '成交时间（北京时间）', 'datetime-local'], ['quantity', '数量 / 股', 'number'],
  ['price', '成交价 / 元（可留空）', 'number'], ['fee', '费用 / 元（可留空）', 'number'],
  ['id', '记录编号', 'text'],
];

function CandidateTrades({ pending, disabled, onChange, onConfirm, onError }) {
  const issues = importIssues(pending.trades);
  const [visibleCount, setVisibleCount] = useState(5);
  function update(index, field, value) {
    const numeric = numericFields.has(field);
    const next = numeric ? value === '' ? null : Number(value) : value;
    if (numeric && next !== null && (!Number.isFinite(next) || next < 0 || next > Number.MAX_SAFE_INTEGER / 100)) {
      onError('请填写有效的非负数值；记不清的价格和费用可以留空。'); return;
    }
    onChange({ ...pending, trades: pending.trades.map((trade, i) => i === index ? { ...trade, [field]: next } : trade) });
  }
  return <section className="ac-candidates" aria-label="待确认交易">
    <div className="ac-section-heading"><div><h2>核对交易</h2><p>缺失信息可以继续补充。确认前不会用于复盘。</p></div><Tag className="ac-pending-badge"><CircleAlert size={14} aria-hidden="true"/>{pending.trades.length} 笔待确认</Tag></div>
    <div className="ac-candidate-list">{pending.trades.slice(0, visibleCount).map((trade, index) => <details key={index} className="ac-candidate" open={pending.trades.length === 1 ? true : undefined}>
      <summary><span><strong>{trade.name || '标的待补充'}</strong><span>{trade.time?.replace('T', ' ') || '时间待补充'}</span></span><ChevronDown size={14}/></summary>
      <div className="ac-candidate-fields">{candidateFields.map(([field, label, type]) => <label key={field}><span>{label}</span>{type === 'datetime-local' ? <DateTimePicker label="成交时间" value={trade[field] ?? ''} disabled={disabled} onChange={value => update(index, field, value)}/> : <input type={type} value={trade[field] ?? ''} min={type === 'number' ? 0 : undefined} step={type === 'number' ? 'any' : undefined} maxLength={field === 'name' ? 200 : 120} disabled={disabled} onChange={event => update(index, field, event.target.value)} placeholder={field === 'price' || field === 'fee' ? '未知' : '待补充'}/>}</label>)}
        <label><span>买卖方向</span><StyledSelect label="买卖方向" value={trade.side || 'unknown'} disabled={disabled} onChange={value => update(index, 'side', value === 'unknown' ? '' : value)} options={[{ value: 'unknown', label: '待补充' }, { value: 'buy', label: '买入' }, { value: 'sell', label: '卖出' }]}/></label>
      </div>
      <div className="ac-candidate-footer"><Button variant="ghost" size="sm" disabled={disabled} onClick={() => onChange({ ...pending, trades: pending.trades.filter((_, i) => i !== index) })}><Trash2 size={13}/>删除这笔</Button></div>
    </details>)}</div>
    {pending.trades.length > visibleCount && <Button variant="ghost" size="sm" onClick={() => setVisibleCount(count => count + 20)}>显示更多交易（还有 {pending.trades.length - visibleCount} 笔）</Button>}
    {issues.length > 0 && <p className="ac-candidate-note" role="status"><CircleAlert size={14}/><span>{issues.slice(0, 3).join(' ')}{issues.length > 3 ? ` 还有 ${issues.length - 3} 项待核对。` : ''}</span></p>}
    <div className="ac-candidate-actions"><Button variant="ghost" size="sm" disabled={disabled || pending.trades.length >= 500} onClick={() => { setVisibleCount(pending.trades.length + 1); onChange({ ...pending, trades: [...pending.trades, { id: crypto.randomUUID(), name: '', symbol: '', time: '', side: '', quantity: null, price: null, fee: null }] }); }}><Plus size={14}/>补充一笔</Button><Button variant="secondary" size="sm" disabled={disabled || issues.length > 0} onClick={onConfirm}><Check size={14}/>确认交易</Button></div>
  </section>;
}

export default function AgentConversation({ conversation, model, onPatch, onConnect, onImport, onSaveLearning, onEvidence, onSaveMethod, methods = [], datasets = [], onResearch, researchBusy, preparationBusy = false, onBusyChange, onStopPreparation, children }) {
  const context = useMemo(() => conversationContext(conversation), [conversation.trades, conversation.selectedIds, conversation.contexts, conversation.marketMode, conversation.origin, conversation.evidence, conversation.marketData]);
  const scope = useMemo(() => conversationScopeKey(conversation, model), [conversation.id, conversation.contextRevision, context, model]);
  const scopeRef = useRef(scope); scopeRef.current = scope;
  const current = useRef(conversation); current.current = conversation;
  const handlers = useRef({ onPatch, onConnect, onImport, onSaveLearning, onEvidence }); handlers.current = { onPatch, onConnect, onImport, onSaveLearning, onEvidence };
  const requestRef = useRef(null);
  const generation = useRef(0);
  const composerRef = useRef(null);
  const scrollRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [requestNotice, setRequestNotice] = useState({ text: '', tone: 'neutral' });
  const status = requestNotice.text;
  function setStatus(text, tone = 'neutral') { setRequestNotice({ text, tone }); }
  const [error, setError] = useState('');
  const [showLatest, setShowLatest] = useState(false);
  const connected = hasSessionConfig(model);
  const messages = conversation.messages || [];
  const currentReview = messages.findLast(message => message.role === 'assistant' && message.text?.trim() && messageIsCurrent(message, conversation, model));
  const canRetry = canRetryRequest(conversation, model);
  useEffect(() => { onBusyChange?.(busy); return () => onBusyChange?.(false); }, [busy, onBusyChange]);

  function patch(changes) {
    current.current = { ...current.current, ...changes };
    handlers.current.onPatch(changes);
  }

  useEffect(() => {
    generation.current++;
    const previousRequest = requestRef.current;
    previousRequest?.abort(); requestRef.current = null;
    setBusy(false); setError('');
    if (previousRequest) setStatus('材料或模型已更新，刚才的请求已停止。历史消息已保留。');
    else setRequestNotice(previous => previous.tone === 'success' && conversation.trades.length && !conversation.pendingTrades ? previous : { text: '', tone: 'neutral' });
    return () => { generation.current++; requestRef.current?.abort(); };
  }, [scope]);

  useEffect(() => {
    const scroll = scrollRef.current;
    const last = scroll?.querySelector('.ac-message:last-child');
    if (scroll && last) scroll.scrollTop += last.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 24;
    setShowLatest(false);
  }, [messages.at(-1)?.id]);

  useEffect(() => {
    const input = composerRef.current;
    if (input) { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 168)}px`; }
  }, [conversation.draft]);

  function draft(text) { patch({ draft: text }); }
  function chooseSuggestion(text) { draft(text); composerRef.current?.focus({ preventScroll: true }); }
  function stop() {
    generation.current++; requestRef.current?.abort(); requestRef.current = null;
    setBusy(false); setError(''); setStatus('已停止，消息和草稿已保留。');
  }
  async function send(retry = false) {
    if (requestRef.current) return;
    if (preparationBusy) return;
    const previous = current.current;
    const text = (retry ? previous.lastRequest?.text : previous.draft)?.trim();
    if (!text) return;
    if (!hasSessionConfig(model)) { handlers.current.onConnect(); return; }
    if (retry && !canRetryRequest(previous, model)) { setError('材料或模型已变化，请将原问题填入草稿后重新发送。'); return; }
    if (previous.messages.length + (retry ? 1 : 2) > CONVERSATION_MESSAGE_LIMIT) { setError('这段对话已达到消息上限，已有消息和草稿已保留。可以新建对话继续。'); return; }
    if (previous.trades.length && !context.trades.length) { setError('请先在复盘材料中选择本次要核对的交易。'); return; }
    const task = previous.trades.length ? 'review' : 'parse';
    const requestText = task === 'parse' ? parseRequestText(text, previous.pendingTrades) : `${text}\n\n核对原则：当前工具中的已确认成交优先于历史交易候选。历史用户消息是用户补充和现在回忆，可能属于此前材料，请核对当前范围；存在冲突先提问，不将旧回答视为本次已证实事实。`;
    if (requestText.length > 16000) { setError('本次描述和待确认交易较长，请先核对候选记录，或缩小内容后重试。'); return; }
    const id = retry ? previous.lastRequest.id : crypto.randomUUID();
    const modelSignature = modelIdentity(model);
    const metadata = { contextRevision: previous.contextRevision, modelLabel: labelFor(model), modelSignature, createdAt: now() };
    const nextMessages = retry ? previous.messages : [...previous.messages, { id, role: 'user', text, refs: [], suggestions: [], ...metadata }];
    const lastRequest = { id, task, text, ...metadata };
    patch({ messages: nextMessages, draft: retry ? previous.draft : '', lastRequest });
    const controller = new AbortController(); requestRef.current = controller;
    const token = ++generation.current;
    const startScope = scopeRef.current;
    const active = () => generation.current === token && scopeRef.current === startScope && !controller.signal.aborted;
    setBusy(true); setError(''); setStatus(task === 'parse' ? '正在整理交易信息…' : '正在读取本次复盘材料…');
    try {
      const result = await runAgent({ task, model, context, research: previous.research || { methods: methods.slice(-8), assumptions: {} }, text: requestText,
        messages: conversationHistory(nextMessages, previous, model, id), signal: controller.signal,
        onEvent: event => {
          if (!active()) return;
          if (event.type === 'status') setStatus(event.text || '正在核对材料…');
          if (event.type === 'tool') setStatus(`${event.status === 'complete' ? '已核对' : event.status === 'error' ? '读取失败' : '正在读取'} ${event.label || '相关材料'}`);
        },
      });
      if (!active()) return;
      const baseMessage = { id: `${id}-answer`, role: 'assistant', refs: [], suggestions: [], evidence: [], ...metadata, createdAt: result.createdAt || now(), ...(result.analysisRunId ? { analysisRunId: result.analysisRunId } : {}) };
      if (task === 'parse') {
        const pendingTrades = pendingFromParse(result);
        const answerText = parseResponseText(result, pendingTrades);
        if (answerText.length > 24000) throw new Error('回复超出单条消息长度，请缩小本次描述后重试。');
        patch({ messages: [...current.current.messages, { ...baseMessage, text: answerText }], pendingTrades, lastRequest: null });
      } else {
        const answer = reviewMessageResult(result, context);
        if (answer.text.length > 24000) throw new Error('回复超出单条消息长度，请缩小问题范围后重试。');
        let researchResult;
        if (result.researchIntent) {
          setStatus('正在执行交易方法操作与确定性计算…');
          try {
            researchResult = await executeResearchWorkflow({ intent: result.researchIntent, context, research: previous.research, methods, datasets: result.researchIntent.action === 'batch' ? datasets.filter(item => item.marketData).map(item => ({ id: item.id, context: conversationContext(item) })) : undefined }, body => apiRequest('/api/research', { signal: controller.signal, body }), { requestText: text, replyText: result.text });
          } catch (cause) { if (!active()) return; answer.text += `\n\n交易方法操作未完成：${cause.message}。可以重试，已有记录保留。`; }
        }
        if (!active()) return;
        if (researchResult?.savedMethods?.length) { onSaveMethod?.(researchResult.savedMethods); answer.text += `\n\n已保存${researchResult.savedMethods.map(method => `「${method.title}」`).join('与')}到交易方法。${researchResult.savedMethods.length > 1 ? '原版与改进版分别保留。' : ''}`; }
        const evidence = [...new Map([...(previous.evidence || []), ...(result.fetchedEvidence || [])].map(item => [item.id, item])).values()];
        const changed = evidence.length !== previous.evidence.length;
        const revision = previous.contextRevision + (changed ? 1 : 0);
        patch({ messages: [...current.current.messages, { ...baseMessage, ...answer, contextRevision: revision, ...(researchResult ? { research: researchResult.research } : {}) }], evidence, contextRevision: revision, retrievalStatus: result.retrievalStatus || '', ...(researchResult ? { research: researchResult.research } : {}), lastRequest: null });
      }
      setStatus('');
    } catch (cause) {
      if (!active()) return;
      setError(cause instanceof Error ? cause.message : '本次处理失败，请重试。'); setStatus('');
    } finally {
      if (generation.current === token && scopeRef.current === startScope) { requestRef.current = null; setBusy(false); }
    }
  }
  function confirmCandidates() {
    try { patch(confirmPendingTrades(current.current)); setError(''); setStatus('交易已确认，可以开始提问或补充当时的背景。', 'success'); composerRef.current?.focus({ preventScroll: true }); }
    catch (cause) { setError(cause.message); }
  }
  async function organizeMethod() {
    if (busy || researchBusy || preparationBusy || !currentReview || !messageIsCurrent(currentReview, current.current, model) || current.current.research) return;
    setError('');
    try { await onResearch({ action: 'infer' }); }
    catch (cause) { setError(cause.message || '交易方法未整理完成，请重试。'); }
  }

  return <div className="ac-root">
    <div className={`ac-scroll${!messages.length && !conversation.trades.length && !conversation.research && !conversation.pendingTrades ? ' ac-scroll-welcome' : ''}`} ref={scrollRef} onScroll={event => { const el = event.currentTarget; setShowLatest(el.scrollHeight - el.scrollTop - el.clientHeight > 240); }}>
      {children}
      {conversation.retrievalStatus && <p className="ac-retrieval-status" role="status"><Info size={14} aria-hidden="true"/><span>{conversation.retrievalStatus}</span></p>}
      {!messages.length && <section className={`ac-empty${conversation.trades.length ? ' ac-empty-with-trades' : ''}`}><h1>{conversation.trades.length ? '想先复盘哪个决定？' : '开始一次复盘'}</h1><p>{conversation.trades.length ? '交易已准备好。可以先说说当时的判断，或直接提出问题。' : '从一笔交易开始，梳理判断、核对证据，找到下一次的改进。'}</p>{!conversation.trades.length && <div className="ac-empty-actions"><Button variant="action-red" onClick={onImport}><Import size={15}/>导入交易</Button><Button variant="secondary" onClick={() => composerRef.current?.focus({ preventScroll: true })}>直接描述交易</Button></div>}{!model?.model && <div className="ac-connect-prompt"><span>使用自己的模型开始分析</span><Button variant="feature" onClick={onConnect}>连接 AI<ArrowUp className="ac-connect-arrow" size={13}/></Button></div>}</section>}
      <div className="ac-messages" role="log" aria-label="复盘对话" aria-live="polite" aria-relevant="additions">
        {messages.map((message, index) => {
          const assistant = message.role === 'assistant';
          const currentMessage = messageIsCurrent(message, conversation, model);
          const oldContext = message.contextRevision !== conversation.contextRevision;
          return <article className={`ac-message ac-message-${message.role}`} key={message.id} data-message-id={message.id} aria-label={assistant ? '复盘助手' : '我的消息'}>
            {assistant && <div className="ac-message-heading"><span><Sparkles size={14}/>复盘助手</span><div className="ac-message-meta"><span>{message.modelLabel || '生成模型未记录'}</span>{!currentMessage && <span>{oldContext ? '材料已更新' : '此前模型'}</span>}</div></div>}
            <div className="ac-message-text">{message.text.split('\n\n').map((paragraph, i) => <p key={i}>{assistant ? <InlineCitations text={paragraph} refs={message.refs} onReference={ref => handlers.current.onEvidence({ ...ref, messageId: message.id })}/> : paragraph}</p>)}</div>
            {!!message.refs?.length && <div className="ac-references">{message.refs.map((ref, i) => <button type="button" key={`${ref.evidenceId || ref.tradeId}-${i}`} onClick={() => handlers.current.onEvidence({ ...ref, messageId: message.id })}><FileText size={12}/>{ref.label}</button>)}</div>}
            {message.learning && <div className="ac-learning"><div><Bookmark size={15}/><strong>{message.learning.title}</strong></div><p>{message.learning.action}</p><Button variant="feature" size="sm" disabled={oldContext} onClick={() => { if (message.contextRevision === current.current.contextRevision) handlers.current.onSaveLearning(message.learning, message.id); }}><Bookmark size={13}/>保存检查项</Button>{oldContext && <span className="ac-muted">材料已更新，请重新核对后再保存。</span>}</div>}
            {index === messages.length - 1 && currentMessage && !!message.suggestions?.length && <div className="ac-suggestions" aria-label="可继续追问">{message.suggestions.map(item => <button type="button" key={item.id} disabled={busy} onClick={() => chooseSuggestion(item.text)}>{item.text}<ArrowUp size={13}/></button>)}</div>}
          </article>;
        })}
      </div>
      {!conversation.research && currentReview && context.trades.length > 0 && onResearch && <div className="ac-suggestions"><Button variant="feature" size="sm" disabled={busy || researchBusy || preparationBusy} onClick={organizeMethod}><Sparkles size={14}/>{researchBusy ? '正在整理交易方法…' : '整理交易方法'}</Button></div>}
      {conversation.research && <ResearchPanel research={conversation.research} savedMethods={methods} onAction={onResearch} busy={busy || researchBusy} compact/>}
      {conversation.pendingTrades && <CandidateTrades pending={conversation.pendingTrades} disabled={busy} onChange={pendingTrades => { patch({ pendingTrades }); setError(''); }} onConfirm={confirmCandidates} onError={setError}/>}
    </div>
    <form className="ac-composer-dock" onSubmit={event => { event.preventDefault(); send(); }}>
      <div className="ac-composer-inner">
        {preparationBusy && <div className="ac-request-status" role="status"><span><LoaderCircle size={14} className="ac-loading" aria-hidden="true"/><span>正在准备背景，可先写下问题。完成后发送，或停止准备后继续。</span></span><Button variant="ghost" size="sm" onClick={onStopPreparation}>停止准备</Button></div>}
        {(busy || status || error || conversation.lastRequest) && <div className={`ac-request-status${error ? ' ac-error' : requestNotice.tone === 'success' && !busy ? ' ac-success' : ''}`} role={error ? 'alert' : 'status'}><span>{busy ? <LoaderCircle size={14} className="ac-loading" aria-hidden="true"/> : error ? <CircleX size={14} aria-hidden="true"/> : requestNotice.tone === 'success' ? <CheckCircle2 size={14} aria-hidden="true"/> : conversation.lastRequest && !status ? <CircleAlert size={14} aria-hidden="true"/> : <Info size={14} aria-hidden="true"/>}<span>{error || status || (canRetry ? '上一次请求未完成，可以重试。' : '此前请求未完成，原问题和消息已保留。')}</span></span>{!busy && canRetry && <Button variant="ghost" size="sm" onClick={() => send(true)}><RotateCcw size={13}/>重试</Button>}{!busy && conversation.lastRequest && !canRetry && <Button variant="ghost" size="sm" onClick={() => chooseSuggestion(conversation.lastRequest.text)}>填入原问题</Button>}</div>}
        {showLatest && <button className="ac-jump" type="button" onClick={() => { const scroll = scrollRef.current; if (scroll) scroll.scrollTop = scroll.scrollHeight; setShowLatest(false); }}><ArrowDown size={14}/>最新消息</button>}
        <div className="ac-composer-box"><textarea ref={composerRef} aria-label="复盘消息" value={conversation.draft || ''} placeholder={conversation.trades.length ? '输入你的问题，或补充当时的背景…' : '描述你的交易，或先导入成交记录…'} rows={2} maxLength={16000} onChange={event => draft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); send(); } }}/><div className="ac-composer-toolbar"><div className="ac-composer-tools"><IconButton label="导入交易记录" size="sm" onClick={onImport}><Paperclip size={17}/></IconButton><button type="button" className="ac-model-chip" onClick={onConnect}><Sparkles size={13}/><span>{model?.model ? `${labelFor(model)}${connected ? '' : '（重新连接）'}` : '连接模型'}</span><ChevronDown size={12}/></button></div>{busy ? <IconButton label="停止生成" className="ac-send" onClick={stop}><Square size={14} fill="currentColor"/></IconButton> : <IconButton type="submit" label="发送消息" className="ac-send" disabled={preparationBusy || !conversation.draft?.trim()}><ArrowUp size={18}/></IconButton>}</div></div>
      </div>
    </form>
  </div>;
}
