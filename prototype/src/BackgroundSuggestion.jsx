import React, { useId } from 'react';
import { Button } from './ui.jsx';
import { shouldAcceptSuggestion } from './background-preparation-state.js';
import './background-suggestion.css';

export function PreparationStatus({ preparation, onConnect, onOpen }) {
  if (!preparation) return null;
  if (preparation.phase === 'idle') return <div className="aw-preparation"><Button variant="ghost" size="sm" disabled={preparation.blocked} onClick={() => {
    if (preparation.connected) preparation.retry();
    else { preparation.queueCurrent(); onConnect(); }
  }}>准备背景与证据</Button></div>;
  const busy = ['queued', 'running'].includes(preparation.phase);
  return <div className="aw-preparation" role="status" aria-live="polite">
    <span>{preparation.total > 0 && <strong>已完成 {preparation.completed}/{preparation.total} 笔 · </strong>}{preparation.detail}</span>
    {busy ? <Button variant="ghost" size="sm" onClick={() => preparation.cancel()}>停止准备</Button> : preparation.phase === 'waiting' ? <Button variant="ghost" size="sm" onClick={onConnect}>连接模型</Button> : <Button variant="ghost" size="sm" disabled={preparation.blocked} onClick={() => preparation.retry({ restart: preparation.phase === 'ready' })}>{preparation.phase === 'ready' ? '重新准备' : preparation.completed > 0 ? '继续剩余成交' : '重试准备'}</Button>}
    {preparation.suggestions.length > 0 && <Button variant="ghost" size="sm" onClick={onOpen}>查看背景</Button>}
  </div>;
}

export default function BackgroundSuggestion({ value, suggestion, basis, onAccept, onDismiss, onChange, ...props }) {
  const hintId = useId();
  const offered = !value && suggestion;
  return <div className={`aw-background-input${offered ? ' has-suggestion' : ''}`}>
    <textarea {...props} value={value} onChange={onChange} placeholder={offered || props.placeholder} aria-describedby={offered ? hintId : undefined} onKeyDown={event => {
      if (shouldAcceptSuggestion(event, value, offered) && onAccept()) event.preventDefault();
      if (event.key === 'Escape' && offered) { onDismiss(); event.preventDefault(); }
    }}/>
    {offered && <><span id={hintId} className="aw-background-sr-hint">补全建议。按 Tab 采用，直接输入可改写，按 Escape 忽略。</span><button className="aw-background-accept" type="button" title={basis || '补全建议，按 Tab 采用'} onClick={onAccept} aria-label="采用补全建议"><kbd>Tab</kbd><span>采用</span></button></>}
  </div>;
}
