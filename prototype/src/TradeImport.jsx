import React, { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, CircleHelp, Download, FileSpreadsheet, FlaskConical, Link2, MessageSquareText, Plus, Upload } from 'lucide-react';
import { Button, Tag } from './ui.jsx';
import DateTimePicker from './DateTimePicker.jsx';
import { sampleCsv, sampleTrades, parseTradesCsv } from './domain.js';
import { NARRATIVE } from './journey-state.js';
import { apiRequest, runAgent } from './services/api.js';
import { candidateIssues, prepareTradeCandidates } from './live-chat-state.js';

export default function TradeImport({ state, patch, accept, go, Field, Notice, Option, Modal, TradesTable, downloadCsv }) {
  const [text, setText] = useState(state.narrativeDraft || '');
  const [csv, setCsv] = useState(state.csvDraft || '');
  const [preview, setPreview] = useState([]);
  const [sample, setSample] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [questions, setQuestions] = useState([]);
  const [edit, setEdit] = useState(null);
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef(null);
  const accountEndpoint = useRef(null);
  const accountToken = useRef(null);
  const [accountOrigin, setAccountOrigin] = useState('账户 API');
  const requestRef = useRef(null);
  const generation = useRef(0);
  const live = state.model?.mode === 'live';
  const issues = candidateIssues(preview);
  function stop() { generation.current++; requestRef.current?.abort(); requestRef.current = null; setBusy(false); }
  useEffect(() => () => { generation.current++; requestRef.current?.abort(); }, []);
  function clearPreview() { stop(); setPreview([]); setSample(false); setError(''); setMessage(''); setQuestions([]); }
  function source(value) { clearPreview(); patch({ source: value }); }
  function parse(content, isSample = false) { clearPreview(); const result = parseTradesCsv(content); setError(result.errors.join(' ')); setPreview(result.trades); setSample(isSample); }
  async function fileChanged(event) {
    const file = event.target.files?.[0]; if (!file) return; clearPreview(); const token = generation.current; event.target.value = '';
    if (file.size > 1024 * 1024) { setError('文件超过 1 MB，请筛选本次交易后导入。'); return; }
    try { const content = await file.text(); if (token !== generation.current) return; setCsv(content); patch({ csvDraft: content }); parse(content); } catch { if (token === generation.current) setError('文件读取失败，请重新选择。'); }
  }
  async function organize() {
    if (!text.trim() || busy) return;
    clearPreview();
    if (!live) {
      if (text === NARRATIVE) { setPreview(sampleTrades.map(t => ({ ...t }))); setSample(true); setMessage('以下是示例描述对应的预设整理结果，请核对后继续。'); }
      else setMessage('描述已保留。请连接真实模型进行整理，或通过「补充一笔交易」确认记录。');
      return;
    }
    const request = new AbortController(); requestRef.current = request; const token = ++generation.current;
    setBusy(true); setMessage('正在整理你描述的交易…');
    try {
      const result = await runAgent({ task: 'parse', model: state.model, text, context: { trades: [], contexts: {}, marketMode: 'import', origin: '自然语言描述' }, signal: request.signal, onEvent: event => { if (generation.current === token && event.type === 'status') setMessage(event.text || '正在整理交易…'); } });
      if (generation.current !== token) return;
      setPreview(prepareTradeCandidates(result)); setSample(false);
      setQuestions([...(Array.isArray(result.questions) ? result.questions : []), ...(Array.isArray(result.warnings) ? result.warnings : [])].filter(item => typeof item === 'string'));
      setMessage('整理完成。请核对每笔交易，补齐缺失字段后确认。');
    } catch (e) { if (generation.current === token) { setMessage(''); setError(e.name === 'AbortError' ? '已停止整理，原描述仍保留。' : e.message); } }
    finally { if (generation.current === token) { requestRef.current = null; setBusy(false); } }
  }
  async function readAccount() {
    if (busy) return;
    const endpoint = accountEndpoint.current?.value.trim();
    if (!endpoint) { setError('请填写只读成交接口地址。'); return; }
    const tokenValue = accountToken.current?.value.trim();
    clearPreview(); const request = new AbortController(); requestRef.current = request; const token = ++generation.current;
    setBusy(true); setMessage('正在读取只读成交接口…');
    try {
      const result = await apiRequest('/api/account-trades/preview', { body: { endpoint, ...(tokenValue ? { token: tokenValue } : {}) }, signal: request.signal });
      if (generation.current !== token) return;
      if (!Array.isArray(result.trades)) throw new Error('接口没有返回可核对的成交记录。');
      setPreview(result.trades); setSample(false); setAccountOrigin(result.origin || '账户 API');
      setQuestions((result.warnings || []).filter(item => typeof item === 'string'));
      setMessage('读取完成。请核对成交后确认导入。');
      if (accountToken.current) accountToken.current.value = '';
    } catch (e) { if (generation.current === token) { setMessage(''); setError(e.name === 'AbortError' ? '已停止读取，未替换当前交易。' : e.message); } }
    finally { if (generation.current === token) { requestRef.current = null; setBusy(false); } }
  }
  function editTrade(index) { setEdit(index); setDraft(index === -1 ? { id: crypto.randomUUID(), symbol: '', name: '', time: '', side: 'buy', quantity: '', price: '', fee: '' } : { ...preview[index] }); }
  function saveTrade(event) {
    event.preventDefault(); const trade = { ...draft, symbol: draft.symbol.trim(), name: draft.name.trim(), quantity: Number(draft.quantity), price: draft.price === '' || draft.price == null ? null : Number(draft.price), fee: draft.fee === '' || draft.fee == null ? null : Number(draft.fee) };
    const validation = candidateIssues([trade]); if (validation.length) { setError(validation.join(' ')); return; }
    if (preview.some((t, i) => i !== edit && t.symbol && t.symbol !== trade.symbol)) { setError('本次先保留一个标的，其他标的可以另建复盘。'); return; }
    setPreview(items => edit === -1 ? [...items, trade] : items.map((item, i) => i === edit ? trade : item)); setSample(false); setDraft(null); setEdit(null); setError('');
  }
  return <>
    <div className="j-source-grid">{[['csv', FileSpreadsheet, '上传 CSV', '从成交记录文件开始'], ['api', Link2, '连接账户 API', '读取标准接口的成交记录'], ['text', MessageSquareText, '描述我的交易', '通过对话补充交易信息']].map(([id, icon, title, description]) => <Option key={id} icon={icon} title={title} description={description} selected={state.source === id} onClick={() => source(id)}/>)}</div>
    <div className="j-panel j-stack">
      {state.source === 'csv' && <><div className="j-upload"><FileSpreadsheet size={30}/><strong>选择交易记录文件</strong><p className="j-hint">CSV 格式，单个标的，最多 500 笔</p><Button variant="secondary" onClick={() => fileRef.current?.click()}><Upload size={16}/>选择文件</Button><input ref={fileRef} type="file" accept=".csv,text/csv" hidden onChange={fileChanged}/></div><div className="j-inline"><button className="j-link" onClick={downloadCsv}><Download size={15}/>下载示例 CSV</button><button className="j-link" onClick={() => { setCsv(sampleCsv); patch({ csvDraft: sampleCsv }); parse(sampleCsv, true); }}>使用示例交易<ArrowRight size={15}/></button></div><details className="j-evidence"><summary>粘贴 CSV 内容</summary><div className="j-stack"><textarea className="j-textarea" aria-label="CSV 内容" value={csv} onChange={e => { setCsv(e.target.value); patch({ csvDraft: e.target.value }); clearPreview(); }} rows={5} placeholder="id,symbol,name,time,side,quantity,price,fee"/><Button variant="secondary" onClick={() => parse(csv)}>预览交易</Button></div></details></>}
      {state.source === 'api' && <><div className="j-panel-head"><h2>连接交易账户</h2><Tag>只读数据</Tag></div><div className="j-field-grid"><Field label="只读成交接口"><input ref={accountEndpoint} type="url" placeholder="https://允许的接口域名/trades" autoComplete="off" disabled={busy} onChange={clearPreview}/></Field><Field label="访问凭证（选填）" hint="以 Bearer 方式发送，仅用于本次读取，不保存到复盘。"><input ref={accountToken} type="password" placeholder="接口要求时填写 Token" autoComplete="off" disabled={busy} onChange={clearPreview}/></Field></div><Notice>管理员需先配置允许的接口域名。接口应返回标准 JSON，明确标注人民币、股票和股数单位。当前没有内置交易所连接器，也不会提交交易。</Notice><div className="model-actions"><Button disabled={busy} onClick={readAccount}>{busy ? '正在读取…' : '读取成交'}<ArrowRight size={16}/></Button>{busy && <Button variant="ghost" onClick={() => { stop(); setMessage('已停止读取，当前交易保持不变。'); }}>停止</Button>}<Button variant="secondary" disabled={busy} onClick={() => { clearPreview(); setPreview(sampleTrades.map(t => ({ ...t }))); setSample(true); setMessage('已载入构造交易，未读取真实账户。'); }}>载入示例交易</Button></div></>}
      {state.source === 'text' && <><div className="j-inline"><MessageSquareText size={20}/><h2>说说这段交易</h2></div><p className="j-hint">可以先说你记得的标的、时间、买卖数量和价格。</p><textarea className="j-textarea" rows={5} aria-label="交易描述" placeholder="例如：我在九月初买入了……后来又……" value={text} onChange={e => { setText(e.target.value); patch({ narrativeDraft: e.target.value }); clearPreview(); }}/><div className="j-action-row"><Button disabled={!text.trim() || busy} onClick={organize}>{busy ? '正在整理…' : '整理交易'}<ArrowRight size={16}/></Button>{busy && <Button variant="ghost" onClick={() => { stop(); setMessage('已停止，原描述仍保留。'); }}>停止</Button>}<button className="j-link" onClick={() => { clearPreview(); setText(NARRATIVE); patch({ narrativeDraft: NARRATIVE }); }}>填入示例描述</button>{!live && <button className="j-link" onClick={() => go(0)}>连接真实模型</button>}</div></>}
      {message && <Notice icon={sample ? FlaskConical : CircleHelp}>{message}</Notice>}
      {questions.length > 0 && <ul className="live-prompt-list">{questions.map((question, i) => <li key={i}>{question}</li>)}</ul>}
      {error && <Notice tone="error">{error}</Notice>}
    </div>
    {(preview.length > 0 || state.source === 'text') && <div className="j-panel j-stack"><div className="j-panel-head"><div className="j-inline"><h2>核对交易</h2><Tag>{preview.length} 笔</Tag>{sample && <Tag><FlaskConical size={12}/>示例数据</Tag>}</div><button className="j-link" disabled={busy || preview.length >= 500} onClick={() => editTrade(-1)}><Plus size={15}/>补充一笔交易</button></div>{preview.length ? <TradesTable trades={preview} onEdit={editTrade}/> : <p className="j-hint">整理后的交易将在这里显示。也可以手动补充。</p>}{issues.length > 0 && <Notice>{issues.join(' ')}</Notice>}</div>}
    <div className="j-footer"><Button variant="ghost" onClick={() => go(0)}><ArrowLeft size={16}/>上一步</Button><div className="j-inline">{state.trades.length > 0 && !preview.length && <Button variant="secondary" disabled={busy} onClick={() => go(2)}>继续已有交易</Button>}<Button disabled={busy || !preview.length || issues.length > 0} onClick={() => accept(preview, sample ? 'sample' : 'import', { csv: 'CSV 文件', api: sample ? '账户示例' : accountOrigin, text: sample ? '示例描述' : '自然语言补录' }[state.source])}>确认交易<ArrowRight size={16}/></Button></div></div>
    <Modal open={!!draft} close={() => { setDraft(null); setEdit(null); }} title={edit === -1 ? '补充交易' : '修改交易'} description="价格或费用记不清时可以留空。">{draft && <form className="j-stack" onSubmit={saveTrade}><div className="j-field-grid">{[['name', '标的名称', 'text'], ['symbol', '标的代码', 'text'], ['time', '成交时间', 'datetime-local'], ['quantity', '数量 / 股', 'number'], ['price', '成交价 / 元', 'number'], ['fee', '费用 / 元', 'number']].map(([key, label, type]) => <Field key={key} label={label}>{key === 'time' ? <DateTimePicker label="成交时间" value={draft.time ?? ''} onChange={value => setDraft({ ...draft, time: value })}/> : <input required={['name', 'symbol', 'quantity'].includes(key)} type={type} step={type === 'number' ? 'any' : undefined} min={type === 'number' ? 0 : undefined} value={draft[key] ?? ''} onChange={e => setDraft({ ...draft, [key]: e.target.value })}/>}</Field>)}<Field label="方向"><select required value={draft.side} onChange={e => setDraft({ ...draft, side: e.target.value })}><option value="" disabled>请选择</option><option value="buy">买入</option><option value="sell">卖出</option></select></Field></div>{error && <Notice tone="error">{error}</Notice>}<Button type="submit">保存交易</Button></form>}</Modal>
  </>;
}
