import React, { useEffect, useMemo, useRef, useState } from 'react';
import ReviewChat from './ReviewChat.jsx';
import { runAgent } from './services/api.js';
import { buildLiveContext, normalizeReviewResult, restoreLiveChat } from './live-chat-state.js';

export default function LiveReviewChat({ state, patch, trades, go }) {
  const context = useMemo(() => buildLiveContext(state, trades), [trades, state.contexts, state.marketMode, state.origin, state.evidence, state.marketData]);
  const thread = useMemo(() => restoreLiveChat(state.liveReviewChat, context), [state.liveReviewChat, context]);
  const current = useRef(thread); current.current = thread;
  const controller = useRef(null);
  const generation = useRef(0);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  useEffect(() => { controller.current = null; setBusy(false); setError(''); setStatus(''); return () => { generation.current++; controller.current?.abort(); controller.current = null; }; }, [thread.contextKey]);
  function saveThread(next) { current.current = next; patch({ liveReviewChat: next }); }
  function updateDraft(draft) { saveThread({ ...current.current, draft }); }
  async function send(retry = false) {
    if (controller.current) return;
    const previous = current.current;
    if (!retry && previous.messages.length >= 201) { setError('本次对话已达到 100 轮，已有消息和草稿已保留。可以保存检查项后新建复盘。'); return; }
    const text = (retry ? previous.lastRequest?.text : previous.draft)?.trim();
    if (!text) return;
    const requestId = retry ? previous.lastRequest.id : crypto.randomUUID();
    const messages = retry ? previous.messages : [...previous.messages, { id: requestId, role: 'user', text, refs: [], suggestions: [], allowLearning: false }];
    const pending = { ...previous, messages, draft: retry ? previous.draft : '', topic: { ...previous.topic, question: previous.topic.question || text }, lastRequest: { id: requestId, text } };
    saveThread(pending); setBusy(true); setError(''); setStatus('正在准备本次材料…');
    const request = new AbortController(); controller.current = request;
    const token = ++generation.current;
    try {
      const result = await runAgent({ task: 'review', model: state.model, context, text, messages: messages.filter(m => m.id !== 'live-opening' && m.id !== requestId).map(({ role, text }) => ({ role, text })), signal: request.signal, onEvent: event => { if (generation.current === token && event.type === 'status') setStatus(event.text || '正在核对材料…'); if (generation.current === token && event.type === 'tool') setStatus('正在核对相关材料…'); } });
      if (generation.current !== token || request.signal.aborted) return;
      const answer = normalizeReviewResult(result, context);
      const next = { ...current.current, messages: [...messages, { id: `${requestId}-answer`, role: 'assistant', text: answer.text, refs: answer.refs, suggestions: answer.suggestions, allowLearning: Boolean(answer.learning), analysisRunId: result.analysisRunId, evidenceIds: answer.evidenceIds, createdAt: result.createdAt }], evidence: [...new Map([...pending.evidence, ...answer.evidence].map(item => [item.id, item])).values()], lastRequest: null };
      current.current = next;
      patch({ liveReviewChat: next, question: next.topic.question, questionKind: 'custom', analyzed: Boolean(answer.learning) || state.analyzed, ...(answer.learning && !state.analyzed ? { learning: answer.learning, activeLearningId: null, editingLearningId: null } : {}) });
      setStatus('');
    } catch (e) { if (generation.current === token) { if (e.name === 'AbortError') setStatus('已停止，已发送的消息仍保留。'); else { setError(e.message); setStatus(''); } } }
    finally { if (generation.current === token) { controller.current = null; setBusy(false); } }
  }
  const adapter = { thread, isLive: true, evidence: thread.evidence, onDraftChange: updateDraft, onSuggestion: suggestion => updateDraft(suggestion.text), onSend: () => send(false), busy, status, error, onCancel: () => controller.current?.abort(), onRetry: thread.lastRequest ? () => send(true) : null, modelLabel: state.model?.model || '已连接模型' };
  return <ReviewChat state={state} patch={patch} trades={trades} go={go} adapter={adapter}/>;
}
