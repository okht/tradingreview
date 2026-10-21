import React, { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, ArrowUp, Bookmark, CalendarDays, ChartCandlestick, ChevronDown, FileText, MessageSquareText, Pencil, Sparkles, X } from 'lucide-react';
import { Button, IconButton, Tag } from './ui.jsx';
import { toast } from 'sonner';
import { learningForQuestion } from './journey-state.js';
import { restoreReviewChat, sendReviewMessage } from './review-chat-state.js';
import './review-chat.css';

const PriceChart = lazy(() => import('./PriceChart.jsx'));
const fmt = value => value == null || value === '' ? '待补充' : Number(value).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
const timeLabel = value => value?.replace('T', ' ').slice(5, 16) || '待补充';
const panes = [
  { id: 'trades', label: '交易与 K 线', icon: ChartCandlestick },
  { id: 'background', label: '决策背景', icon: MessageSquareText },
  { id: 'evidence', label: '相关证据', icon: FileText },
];

function TradePicker({ trades, selected, onChange }) {
  return <div className="rc-trade-picker" role="group" aria-label="选择行情对应的交易">{trades.map(trade => <button key={trade.id} className={selected === trade.id ? 'active' : ''} aria-pressed={selected === trade.id} onClick={() => onChange(trade.id)}>
    {timeLabel(trade.time)} <span className={trade.side === 'buy' ? 'buy-text' : 'sell-text'}>{trade.side === 'buy' ? '买入' : '卖出'}</span>
  </button>)}</div>;
}

function TradeRecords({ trades }) {
  return <div className="j-table"><table><caption className="sr-only">本次复盘选择的成交记录</caption><thead><tr><th>成交时间</th><th>方向</th><th>价格 / 元</th><th>数量 / 股</th><th>费用 / 元</th></tr></thead><tbody>{trades.map(trade => <tr key={trade.id} data-trade-id={trade.id}><td>{timeLabel(trade.time)}</td><td className={trade.side === 'buy' ? 'buy-text' : 'sell-text'}>{trade.side === 'buy' ? '买入' : '卖出'}</td><td>{fmt(trade.price)}</td><td>{fmt(trade.quantity)}</td><td>{fmt(trade.fee)}</td></tr>)}</tbody></table></div>;
}

export default function ReviewChat({ state, patch, trades, go, adapter }) {
  const context = useMemo(() => ({ trades, contexts: state.contexts, marketMode: state.marketMode, origin: state.origin }), [trades, state.contexts, state.marketMode, state.origin]);
  const demoThread = useMemo(() => restoreReviewChat(state.reviewChat, context), [state.reviewChat, context]);
  const thread = adapter?.thread || demoThread;
  const [panel, setPanel] = useState('');
  const [selectedTradeId, setSelectedTradeId] = useState(thread.topic.tradeId || trades[0]?.id);
  const [futureTradeId, setFutureTradeId] = useState(null);
  const [showLatest, setShowLatest] = useState(false);
  const composer = useRef(null);
  const messageScroll = useRef(null);
  const panelScroll = useRef(null);
  const panelHeading = useRef(null);
  const returnMessageId = useRef(null);
  const returnFocus = useRef(null);
  const firstMessageRender = useRef(true);
  const focusTrade = trades.find(trade => trade.id === selectedTradeId) || trades[0];
  const note = state.contexts[focusTrade?.id];
  const future = Boolean(focusTrade && futureTradeId === focusTrade.id);
  const currentLearning = state.learning;
  const latestMessageId = thread.messages.at(-1)?.id;
  const hasSampleEvent = state.marketMode === 'sample' && focusTrade?.id === 'DEMO-02' && focusTrade.symbol === 'DEMO001' && focusTrade.time === '2025-09-08T10:00';

  useEffect(() => {
    const scroll = messageScroll.current;
    if (!scroll) return;
    // Keep the current response's beginning visible, even when it is long.
    const last = scroll.querySelector('.rc-message:last-child');
    if (firstMessageRender.current && thread.messages.length === 1) scroll.scrollTop = 0;
    else if (last) scroll.scrollTop += last.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 20;
    firstMessageRender.current = false;
    setShowLatest(false);
  }, [latestMessageId, thread.contextKey]);

  useEffect(() => {
    if (composer.current) {
      composer.current.style.height = 'auto';
      composer.current.style.height = `${Math.min(composer.current.scrollHeight, 144)}px`;
    }
  }, [thread.draft]);

  function selectTrade(id) { setSelectedTradeId(id); setFutureTradeId(null); }
  function scrollToElement(element) {
    const scroll = messageScroll.current;
    if (scroll && element) scroll.scrollTop += element.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 16;
  }
  function closePanel() {
    setPanel('');
    requestAnimationFrame(() => {
      const messages = [...(messageScroll.current?.querySelectorAll('[data-message-id]') || [])];
      scrollToElement(messages.find(message => message.dataset.messageId === returnMessageId.current) || messages.at(-1));
      if (returnFocus.current?.isConnected) returnFocus.current.focus({ preventScroll: true });
      returnMessageId.current = null;
      returnFocus.current = null;
    });
  }
  function openReference(reference, messageId, trigger) {
    returnMessageId.current = messageId;
    returnFocus.current = trigger;
    selectTrade(reference.tradeId);
    setPanel(reference.panel);
    requestAnimationFrame(() => {
      panelHeading.current?.focus({ preventScroll: true });
      const content = panelScroll.current;
      const target = reference.panel === 'evidence' ? (reference.evidenceId ? [...(content?.querySelectorAll('[data-evidence]') || [])].find(item => item.dataset.evidence === reference.evidenceId) : content?.querySelector('[data-evidence="order"]'))
        : reference.panel === 'trades' ? [...(content?.querySelectorAll('[data-trade-id]') || [])].find(row => row.dataset.tradeId === reference.tradeId)
          : panelHeading.current;
      scrollToElement(target || panelHeading.current);
    });
  }
  function chooseSuggestion(suggestion) {
    if (adapter) { adapter.onSuggestion(suggestion); composer.current?.focus({ preventScroll: true }); return; }
    patch({ reviewChat: { ...thread, draft: suggestion.text, pick: { id: suggestion.id, text: suggestion.text } } });
    composer.current?.focus({ preventScroll: true });
  }
  function updateDraft(value) {
    if (adapter) { adapter.onDraftChange(value); return; }
    patch({ reviewChat: { ...thread, draft: value, pick: thread.pick?.text === value ? thread.pick : null } });
  }
  function send(event) {
    event?.preventDefault();
    if (adapter) { if (!adapter.busy && thread.draft.trim()) adapter.onSend(); return; }
    if (!thread.draft.trim()) return;
    const next = sendReviewMessage(thread, context);
    if (next.messages.at(-1)?.id === thread.messages.at(-1)?.id) {
      toast('这段示例对话已达到 50 轮，已有消息和草稿已保留。');
      return;
    }
    const sameTopic = next.topic.kind === thread.topic.kind && next.topic.question === thread.topic.question && next.topic.tradeId === thread.topic.tradeId;
    const canCreateLearning = next.messages.at(-1)?.allowLearning === true || (sameTopic && state.analyzed);
    const learningChanges = sameTopic ? {} : { activeLearningId: null, editingLearningId: null, learning: learningForQuestion(next.topic.kind), nextDecision: '', nextChecked: false };
    patch({ reviewChat: next, question: next.topic.question, questionKind: next.topic.kind, analyzed: canCreateLearning, reached: canCreateLearning ? state.reached : 4, ...learningChanges });
    if (next.topic.tradeId) selectTrade(next.topic.tradeId);
    composer.current?.focus({ preventScroll: true });
  }
  function handleKeyDown(event) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) send(event);
  }
  function jumpToLatest() {
    const scroll = messageScroll.current;
    if (scroll) scroll.scrollTop = scroll.scrollHeight;
    setShowLatest(false);
  }

  return <div className="review-chat">
    <div className="rc-workspace-scroll" ref={messageScroll} onScroll={() => { const el = messageScroll.current; if (el) setShowLatest(el.scrollHeight - el.scrollTop - el.clientHeight > 180); }}>
    <section className="rc-context" aria-label="本次复盘材料">
      <div className="rc-summary">
        <div className="rc-instrument"><strong>{trades[0]?.name}</strong><div className="rc-summary-meta"><span><CalendarDays size={13}/>{trades[0]?.time.slice(0, 10)} — {trades.at(-1)?.time.slice(0, 10)}</span><span>{trades.length} 笔成交</span></div></div>
        <Tag>{adapter?.isLive ? 'AI 复盘' : '示例对话'}</Tag>
      </div>
      <div className="rc-context-actions">{panes.map(({ id, label, icon: Icon }) => <button key={id} className="rc-context-trigger" aria-expanded={panel === id} aria-controls="review-context-panel" onClick={event => { if (panel === id) closePanel(); else { returnFocus.current = event.currentTarget; returnMessageId.current = null; setPanel(id); } }}><Icon size={15}/>{label}<ChevronDown size={14}/></button>)}</div>
      {panel && <section id="review-context-panel" className="rc-context-panel" aria-label={panes.find(pane => pane.id === panel)?.label}>
        <div className="rc-panel-head"><h2 ref={panelHeading} tabIndex={-1}>{panes.find(pane => pane.id === panel)?.label}</h2><IconButton label="收起参考材料" size="sm" onClick={closePanel}><X size={16}/></IconButton></div>
        <div className="rc-panel-scroll" ref={panelScroll}>
          {panel === 'trades' && <div className="j-stack">
            <TradePicker trades={trades} selected={focusTrade?.id} onChange={selectTrade}/>
            <div className="j-action-row"><div className="j-toggle" role="group" aria-label="行情时间视角"><button aria-pressed={!future} onClick={() => setFutureTradeId(null)}>当时可知</button><button aria-pressed={future} onClick={() => setFutureTradeId(focusTrade?.id)}>查看后续</button></div><span className="j-hint">{future ? '包含后续行情' : `截至 ${timeLabel(focusTrade?.time)}`}</span></div>
            {focusTrade?.time && <Suspense fallback={<div className="j-empty">正在准备 K 线</div>}><PriceChart key={focusTrade.id} trades={trades} mode={state.marketMode} marketData={state.marketData} cutoff={focusTrade.time} showFuture={future}/></Suspense>}
            <TradeRecords trades={trades}/>
          </div>}
          {panel === 'background' && <div className="rc-records">
            <TradePicker trades={trades} selected={focusTrade?.id} onChange={selectTrade}/>
            <article className="rc-record"><div className="j-panel-head"><h3>{timeLabel(focusTrade?.time)} {focusTrade?.side === 'buy' ? '买入' : '卖出'}</h3><Tag>{note?.source || '待补充'}</Tag></div><p>{note?.reason || (note?.unknown ? '当时的理由记不清了。' : '尚未补充当时的理由。')}</p><p className="j-hint">原先的计划：{note?.plan || '尚未补充'}</p>{note?.reference && <p className="j-hint">出处：{note.reference}</p>}</article>
            <p className="j-hint">新的补充会保留在对话中。现在回忆的内容与当时记录分开看待。</p><button className="j-link" onClick={() => go(3)}><Pencil size={14}/>修改前面填写的背景</button>
          </div>}
          {panel === 'evidence' && <div className="rc-evidence-list">
            <TradePicker trades={trades} selected={focusTrade?.id} onChange={selectTrade}/>
            <article className="rc-evidence-card"><div className="j-panel-head"><h3>成交记录</h3><Tag>{state.marketMode === 'sample' ? '构造记录' : '用户提供'}</Tag></div><p>{timeLabel(focusTrade?.time)}，{focusTrade?.side === 'buy' ? '买入' : '卖出'} {fmt(focusTrade?.quantity)} 股，成交价 {fmt(focusTrade?.price)} 元。</p><p className="j-hint">{state.origin} / 北京时间</p></article>
            <article className="rc-evidence-card"><div className="j-panel-head"><h3>当时的理由</h3><Tag>{note?.source || '待补充'}</Tag></div><p>{note?.reason || (note?.unknown ? '记不清了，保留待确认。' : '尚缺这次决定的理由。')}</p><p className="j-hint">{note?.reference || '补录内容需要与当时可得的信息进一步核对。'}</p></article>
            {!adapter?.isLive && hasSampleEvent && <article className="rc-evidence-card" data-evidence="order"><div className="j-panel-head"><h3>订单消息</h3><Tag>决策后发布</Tag></div><p>构造公告发布时间为 2025-09-08 11:30，晚于这笔 10:00 的买入。</p><p className="j-hint">用于演示信息时点核对，尚未接入真实公告。</p></article>}
            {[...new Map([...(state.evidence || []), ...(adapter?.evidence || [])].map(item => [item.id, item])).values()].filter(item => !item.tradeId || item.tradeId === focusTrade?.id).map(item => <article key={item.id} className="rc-evidence-card" data-evidence={item.id}><div className="j-panel-head"><h3>{item.title || '相关材料'}</h3><Tag>{{ before: '决策前信息', after: '决策后信息', recollection: '现在回忆', unknown: '时间待确认' }[item.timeClass] || '待核对'}</Tag></div><p>{item.text}</p><p className="j-hint">{item.source || '来源待确认'}{item.publishedAt ? ` / 公开于 ${item.publishedAt}` : ''}{item.recordedAt ? ` / 记录于 ${item.recordedAt}` : ''}</p>{/^https?:\/\//.test(item.url || '') && <a className="j-link" href={item.url} target="_blank" rel="noopener noreferrer">查看原文</a>}</article>)}
            {state.marketMode !== 'sample' && <p className="j-hint">{state.marketData ? '历史行情按成交时点区分，事件以所补充原文和发布时间为准。' : '当前材料来自你提供的交易、背景与事件。可返回补充背景接入历史行情。'}</p>}
          </div>}
          <Button variant="ghost" size="sm" onClick={closePanel}>收起资料，返回对话<ArrowRight size={14}/></Button>
        </div>
      </section>}
    </section>

    <div className="rc-message-scroll">
      <div className="rc-messages" role="log" aria-label="复盘对话" aria-live="polite" aria-relevant="additions">
        {thread.messages.map((message, index) => <article key={message.id} data-message-id={message.id} className={`rc-message ${message.role}`} aria-label={message.role === 'assistant' ? '复盘助手' : '我的消息'}>
          {message.role === 'assistant' && <span className="rc-avatar" aria-hidden="true"><Sparkles size={19}/></span>}
          <div className="rc-message-content">
            <span className="rc-message-label">{message.role === 'assistant' ? '复盘助手' : '你'}</span>
            <div className="rc-message-text">{message.text.split('\n\n').map((paragraph, i) => <p key={i}>{paragraph}</p>)}</div>
            {message.refs.length > 0 && <div className="rc-citations">{message.refs.map((reference, i) => <button key={`${reference.panel}-${reference.tradeId}-${i}`} onClick={event => openReference(reference, message.id, event.currentTarget)}><FileText size={12}/>{reference.label}</button>)}</div>}
            {index === thread.messages.length - 1 && message.suggestions.length > 0 && <div className="rc-suggestions" aria-label="对话建议">{message.suggestions.map(suggestion => <button key={suggestion.id} onClick={() => chooseSuggestion(suggestion)}>{suggestion.text}<ArrowRight size={14}/></button>)}</div>}
            {index === thread.messages.length - 1 && thread.messages.length > 1 && state.analyzed && <div className="rc-learning-inline"><div className="j-inline"><Bookmark size={15}/><strong>留给下次的检查项</strong></div><p>{currentLearning.title}</p><Button variant="secondary" size="sm" onClick={() => go(5)}>整理成检查项<ArrowRight size={14}/></Button></div>}
          </div>
        </article>)}
      </div>
    </div>
    </div>
    <form className="rc-composer-dock" onSubmit={send}>
      <div className="rc-composer-inner">
        {adapter && (adapter.busy || adapter.status || adapter.error || adapter.onRetry) && <div className="live-request-status rc-live-status" role={adapter.error ? 'alert' : 'status'}><span>{adapter.error || adapter.status || '上一次请求未完成，可重试。'}</span><div className="model-actions">{adapter.busy ? <Button variant="ghost" size="sm" onClick={adapter.onCancel}>停止</Button> : adapter.onRetry && <Button variant="ghost" size="sm" onClick={adapter.onRetry}>重试</Button>}</div></div>}
        {showLatest && <button type="button" className="rc-return-button" onClick={jumpToLatest}>回到最新消息<ChevronDown size={14}/></button>}
        <div className="rc-composer-box">
          <textarea ref={composer} aria-label="复盘消息" placeholder="输入你的问题、补充或纠正…" rows={2} maxLength={4000} value={thread.draft} onChange={event => updateDraft(event.target.value)} onKeyDown={handleKeyDown}/>
          <div className="rc-composer-toolbar"><span className="rc-model"><Sparkles size={13}/>{adapter?.modelLabel || '示例模型'}</span><IconButton type="submit" className="rc-send" label="发送消息" disabled={adapter?.busy || !thread.draft.trim()}><ArrowUp size={19}/></IconButton></div>
        </div>
        <p className="rc-composer-hint">{adapter?.isLive ? 'AI 分析需要结合原始材料核对。' : '预设对话演示，支持保存自由输入。'}Enter 发送，Shift + Enter 换行。</p>
      </div>
    </form>
  </div>;
}
