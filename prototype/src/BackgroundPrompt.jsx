import React, { useEffect, useRef, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { Button } from './ui.jsx';
import { runAgent } from './services/api.js';
import { buildLiveContext, liveContextKey } from './live-chat-state.js';

export default function BackgroundPrompt({ state, trade }) {
  const [questions, setQuestions] = useState([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const controller = useRef(null);
  const sequence = useRef(0);
  const selectedTrades = state.trades.filter(item => state.selectedIds.includes(item.id));
  const context = buildLiveContext(state, selectedTrades);
  const contextKey = JSON.stringify([trade?.id, liveContextKey(context), state.model]);
  useEffect(() => { sequence.current++; controller.current?.abort(); controller.current = null; setBusy(false); setQuestions([]); setStatus(''); setError(''); return () => { sequence.current++; controller.current?.abort(); }; }, [contextKey]);
  async function ask() {
    if (busy || !trade) return;
    const request = new AbortController(); controller.current = request; const token = ++sequence.current;
    setBusy(true); setError(''); setStatus('正在核对这笔决定的背景…');
    try {
      const result = await runAgent({ task: 'background', model: state.model, context, text: `当前正在补充 ${trade.time} 的交易（${trade.id}）。请根据已有记录，提出这笔决定最需要补充的背景问题。不要代写我的理由。`, signal: request.signal, onEvent: event => { if (sequence.current === token && event.type === 'status') setStatus(event.text || '正在核对背景…'); } });
      if (sequence.current !== token) return;
      const prompts = [...(Array.isArray(result.questions) ? result.questions : []), ...(Array.isArray(result.missing) ? result.missing : [])].filter(item => typeof item === 'string' && item.trim());
      if (!prompts.length) throw new Error('这次没有收到可用的追问，可以补充内容后重试。');
      setQuestions(prompts); setStatus('这些问题供你回忆和补充，已填写内容保持不变。');
    } catch (e) { if (sequence.current === token) { if (e.name === 'AbortError') setStatus('已停止追问，已填写的背景仍保留。'); else { setError(e.message); setStatus(''); } } }
    finally { if (sequence.current === token) { setBusy(false); controller.current = null; } }
  }
  if (state.model?.mode !== 'live') return null;
  return <div className="j-stack"><div className="model-actions"><Button variant="secondary" disabled={busy} onClick={ask}><Sparkles size={15}/>{busy ? '正在核对…' : questions.length ? '重新生成追问' : '帮我梳理还缺什么'}</Button>{busy && <Button variant="ghost" onClick={() => controller.current?.abort()}>停止</Button>}</div>{questions.length > 0 && <ul className="live-prompt-list">{questions.map((question, i) => <li key={i}>{question}</li>)}</ul>}{status && <p className="j-hint" role="status">{status}</p>}{error && <p className="model-error" role="alert">{error}</p>}</div>;
}
