import React, { useEffect, useId, useRef, useState } from 'react';
import { Check, CircleAlert, Download, FileText, Info, KeyRound, Link2, LoaderCircle, Pencil, Plug, ShieldCheck, Sparkles, Trash2, Upload, X } from 'lucide-react';
import { Button, IconButton, Tag } from './ui.jsx';
import { StyledSelect } from './SelectionControls.jsx';
import DateTimePicker from './DateTimePicker.jsx';
import Pagination, { usePagination } from './Pagination.jsx';
import { apiRequest, hasSessionConfig, parseTradeFile } from './services/api.js';
import { readTradeFile } from './trade-file-reader.js';
import { acceptedImportTrades, accountCandidates, confirmStockMetadata, editedTrade, hasUnknownMarket, identifyImportCandidates, importGroups, importIssues, mergeImportCandidates, missingTradeFields, tradesToCsv } from './import-dialog-state.js';
import './agent-dialogs.css';
import './trade-import.css';

function Field({ label, hint, children }) { return <label className="j-form-field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>; }
const display = value => value === null || value === undefined || value === '' ? '待补充' : String(value);
const list = value => Array.isArray(value) ? value.filter(item => typeof item === 'string' && item.trim()) : [];
const bytes = size => size < 1024 * 1024 ? `${Math.max(1, Math.round(size / 1024))} KB` : `${(size / (1024 * 1024)).toFixed(1)} MB`;

export default function ImportTradesDialog({ model, onConnect, onAccept, onClose }) {
  const id = useId();
  const [source, setSource] = useState('file'), [selectedFile, setSelectedFile] = useState(null), [pendingFile, setPendingFile] = useState(null);
  const [extracted, setExtracted] = useState(null), [preview, setPreview] = useState([]), [origin, setOrigin] = useState('导入文件'), [previewSource, setPreviewSource] = useState('file');
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [message, setMessage] = useState('');
  const [warnings, setWarnings] = useState([]), [questions, setQuestions] = useState([]), [needsAI, setNeedsAI] = useState(false);
  const [editing, setEditing] = useState(null), [draft, setDraft] = useState(null), [supplement, setSupplement] = useState('');
  const [groupKey, setGroupKey] = useState(''), [dragging, setDragging] = useState(false);
  const file = useRef(null), endpoint = useRef(null), token = useRef(null), request = useRef(null), sequence = useRef(0), active = useRef(false), editedIds = useRef(new Set()), removedIds = useRef(new Set());
  const groups = importGroups(preview), currentGroup = groups.find(group => group.key === groupKey) || groups[0];
  const currentTrades = currentGroup?.trades || [], currentIndices = currentGroup?.indices || [];
  const pagination = usePagination(currentTrades.length, `${previewSource}:${currentGroup?.key || ''}`);
  const previewTable = useRef(null);
  const issues = currentTrades.length ? importIssues(currentTrades) : [];
  const connected = hasSessionConfig(model);
  const unknownMarket = currentTrades.some(hasUnknownMarket);

  function changePage(page) { pagination.onPageChange(page); requestAnimationFrame(() => previewTable.current?.scrollIntoView({ block: 'start' })); }

  useEffect(() => { active.current = true; return () => { active.current = false; sequence.current++; request.current?.abort(); }; }, []);
  function stop() { sequence.current++; request.current?.abort(); request.current = null; setBusy(''); setMessage('已停止，识别出的记录已保留。'); }
  function begin(stage, status) {
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    const version = ++sequence.current; setBusy(stage); setError(''); setMessage(status);
    return { controller, version, current: () => active.current && sequence.current === version && !controller.signal.aborted };
  }
  function finish(job) { if (job.current()) { setBusy(''); request.current = null; } }
  function resetFile(selected) {
    request.current?.abort(); sequence.current++; setBusy(''); setSelectedFile(selected); setExtracted(null); setPreview([]); setError(''); setMessage('');
    setWarnings([]); setQuestions([]); setNeedsAI(false); setEditing(null); setDraft(null); setSupplement(''); setGroupKey(''); editedIds.current.clear(); removedIds.current.clear();
  }
  function chooseFile(selected) {
    if (!selected || busy) return;
    if (selectedFile || preview.length) { setPendingFile(selected); return; }
    void loadFile(selected);
  }
  function fileChanged(event) { const selected = event.target.files?.[0]; event.target.value = ''; chooseFile(selected); }
  function tabKey(event) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || busy || draft) return;
    event.preventDefault(); const next = event.key === 'Home' ? 'file' : event.key === 'End' ? 'account' : source === 'file' ? 'account' : 'file';
    setSource(next); document.getElementById(`${id}-${next}-tab`)?.focus();
  }
  async function loadFile(selected) {
    setPendingFile(null); resetFile(selected); setSource('file'); setPreviewSource('file'); setOrigin(selected.name);
    const job = begin('read', '正在读取文件…');
    try {
      const result = await readTradeFile(selected, { signal: job.controller.signal, onProgress: status => { if (job.current()) setMessage(status); } });
      if (!job.current()) return;
      setExtracted(result); setWarnings(list(result.warnings)); setPreview(identifyImportCandidates(result.trades || []));
      if (result.trades?.length) setMessage(`已整理 ${result.trades.length} 笔交易，请核对。`);
      else {
        setNeedsAI(true);
        if (connected) { finish(job); await recognize(result); }
        else setMessage('文件已读取，连接 AI 后继续识别。');
      }
    } catch (e) { if (job.current() && e.name !== 'AbortError') { setError(e.message || '文件无法读取，请重新选择。'); setMessage(''); } }
    finally { finish(job); }
  }
  async function recognize(input = extracted, refining = false) {
    if (!input) return;
    if (!hasSessionConfig(model)) { setNeedsAI(true); setMessage('文件和当前记录已保留，连接 AI 后继续识别。'); return; }
    let text = input.text || '';
    if (refining) text += `\n\n当前待核对记录（请沿用交易编号；已人工修改的记录由界面保留）：\n${JSON.stringify(preview)}\n\n补充说明：\n${supplement.trim()}`;
    if (text.length > 60000) { setError('材料和补充说明较长，请直接编辑下方记录，或换用更小范围的文件。当前记录已保留。'); return; }
    const job = begin('ai', refining ? '正在结合补充说明整理…' : '正在识别交易…');
    try {
      const result = await parseTradeFile({ model, text, images: input.images || [], signal: job.controller.signal });
      if (!job.current()) return;
      const trades = identifyImportCandidates(Array.isArray(result.trades) ? result.trades : []).filter(trade => !removedIds.current.has(trade.id));
      setPreview(previous => refining ? mergeImportCandidates(previous, trades, [...editedIds.current]) : trades);
      if (!refining) pagination.resetPage();
      setWarnings([...new Set([...list(input.warnings), ...list(result.warnings)])]); setQuestions(list(result.questions)); setNeedsAI(!trades.length);
      setMessage(trades.length ? refining ? '已更新识别结果，手动修改的记录已保留。' : `已整理 ${trades.length} 笔交易，请核对。` : '还没有识别出完整的交易记录，可以补充说明后重试。');
    } catch (e) { if (job.current() && e.name !== 'AbortError') { setError(e.message || '本次识别未完成，可以重试。'); setNeedsAI(true); setMessage('文件和已识别的记录已保留。'); } }
    finally { finish(job); }
  }
  async function readAccount(event) {
    event.preventDefault(); if (busy) return;
    const address = endpoint.current?.value.trim(), credential = token.current?.value.trim();
    if (!address) { setError('请填写只读成交接口地址。'); return; }
    const job = begin('account', '正在读取成交…');
    try {
      const result = await apiRequest('/api/account-trades/preview', { body: { endpoint: address, ...(credential ? { token: credential } : {}) }, signal: job.controller.signal });
      if (!job.current()) return;
      const trades = accountCandidates(result); setPreview(trades); setOrigin(result.origin || '只读账户接口'); setWarnings(list(result.warnings)); setQuestions([]); setGroupKey(''); editedIds.current.clear(); removedIds.current.clear();
      pagination.resetPage();
      setDraft(null); setEditing(null); setSelectedFile(null); setExtracted(null); setNeedsAI(false); setSupplement(''); setPreviewSource('account'); setMessage(`已整理 ${trades.length} 笔交易，请核对。`); if (token.current) token.current.value = '';
    } catch (e) { if (job.current() && e.name !== 'AbortError') { setMessage(''); setError(e.message); } }
    finally { finish(job); }
  }
  function edit(index) { setEditing(index); setDraft({ ...preview[index] }); }
  function saveEdit(event) {
    event.preventDefault(); const trade = editedTrade(draft); editedIds.current.add(trade.id);
    if (preview[editing].id !== trade.id) removedIds.current.add(preview[editing].id);
    setPreview(items => items.map((item, index) => index === editing ? trade : item)); setEditing(null); setDraft(null);
  }
  function confirmMarket() {
    setPreview(items => items.map((trade, index) => { if (!currentIndices.includes(index)) return trade; editedIds.current.add(trade.id); return confirmStockMetadata(trade); }));
  }
  function exportCsv() {
    const url = URL.createObjectURL(new Blob(['\uFEFF', tradesToCsv(preview)], { type: 'text/csv;charset=utf-8' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'TradingReview-整理后的交易记录.csv'; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function accept() {
    if (busy || draft || !currentTrades.length || issues.length) return;
    setBusy('accept'); setError('');
    try { await onAccept(acceptedImportTrades(currentTrades), origin, previewSource === 'file' ? extracted?.marketData || null : null); }
    catch (e) { if (active.current) setError(e.message || '导入未完成，请重试。'); }
    finally { if (active.current) setBusy(''); }
  }

  return <div className="agent-dialog trade-import j-stack">
    <div className="ad-tabs" role="tablist" aria-label="交易导入方式" onKeyDown={tabKey}>
      {[['file', '导入文件', Upload], ['account', '连接账户', Plug]].map(([value, label, Icon]) => <button key={value} id={`${id}-${value}-tab`} role="tab" aria-selected={source === value} aria-controls={`${id}-${value}-panel`} tabIndex={source === value ? 0 : -1} disabled={Boolean(busy) || Boolean(draft)} onClick={() => setSource(value)}><Icon size={16}/>{label}</button>)}
    </div>
    <div id={`${id}-${source}-panel`} role="tabpanel" aria-labelledby={`${id}-${source}-tab`}>
      {source === 'file' ? <div className="j-stack">
        <input ref={file} type="file" hidden onChange={fileChanged}/>
        {selectedFile ? <div className="ti-file"><span className="ti-file-icon"><FileText size={22}/></span><div><strong>{selectedFile.name}</strong><small>{bytes(selectedFile.size)}</small></div><Button variant="ghost" size="sm" disabled={Boolean(busy)} onClick={() => file.current?.click()}>更换文件</Button></div>
        : <button type="button" className={`ti-dropzone ${dragging ? 'ti-dragging' : ''}`} disabled={Boolean(busy)} onClick={() => file.current?.click()} onDragOver={event => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={event => { event.preventDefault(); setDragging(false); chooseFile(event.dataTransfer.files?.[0]); }}><span className="ti-upload-icon"><Upload size={24}/></span><span className="ti-drop-copy"><strong>选择文件或拖到这里</strong><span>自动整理交易，确认后再导入</span><span className="ti-file-types"><span>交易表格</span><span>账单文档</span><span>成交截图</span></span></span><span className="ti-select-file">选择文件</span></button>}
        {!selectedFile && <p className="ti-privacy"><ShieldCheck size={14}/>需要 AI 识别时，文件内容会发送给当前连接的模型。</p>}
        {pendingFile && <div className="ti-replace" role="alert"><div><strong>更换为 {pendingFile.name}？</strong><p>当前文件的预览和修改会被替换。</p></div><div className="ad-actions"><Button variant="secondary" size="sm" onClick={() => setPendingFile(null)}>保留当前文件</Button><Button size="sm" onClick={() => loadFile(pendingFile)}>更换文件</Button></div></div>}
      </div>
      : <form className="j-stack ti-account-form" onSubmit={readAccount}>
        <div className="ti-account-intro"><span><Plug size={20}/></span><div><strong>从只读接口获取成交</strong><p>连接后读取交易记录，核对后再加入复盘。</p></div></div>
        <div className="ad-account-fields">
          <Field label="只读成交接口"><span className="ad-account-input" data-disabled={Boolean(busy)}><Link2 size={16} aria-hidden="true"/><input ref={endpoint} type="url" required autoComplete="off" disabled={Boolean(busy)} placeholder="粘贴只读成交接口地址"/></span></Field>
          <Field label="访问凭证（选填）"><span className="ad-account-input" data-disabled={Boolean(busy)}><KeyRound size={16} aria-hidden="true"/><input ref={token} type="password" autoComplete="off" disabled={Boolean(busy)} placeholder="接口要求时填写" aria-describedby={`${id}-account-security`}/></span></Field>
        </div>
        <p id={`${id}-account-security`} className="j-hint ad-data-note"><ShieldCheck size={14}/>凭证仅用于本次读取。</p>
        <details className="ti-details"><summary>连接说明</summary><p>当前支持管理员允许的标准成交接口，尚未内置券商或交易所连接器。接口需返回人民币股票成交，数量单位为股。</p></details>
        <div className="ad-actions"><Button type="submit" variant="secondary" disabled={Boolean(busy)}>读取成交</Button></div>
      </form>}
    </div>
    {(message || busy) && <div className={`ti-status ${!busy && preview.length ? 'ti-status-success' : ''}`} role="status">{busy ? <LoaderCircle className="ti-spinner" size={16}/> : preview.length ? <Check size={16}/> : null}<span>{message}</span>{busy && busy !== 'accept' && <Button variant="ghost" size="sm" onClick={stop}>停止</Button>}</div>}
    {error && <div className="ti-error" role="alert"><p><CircleAlert size={16}/><span>{error}</span></p>{extracted && source === 'file' && <Button variant="ghost" size="sm" disabled={Boolean(busy)} onClick={() => recognize(extracted, Boolean(preview.length))}>重试识别</Button>}{!extracted && selectedFile && <Button variant="ghost" size="sm" disabled={Boolean(busy)} onClick={() => loadFile(selectedFile)}>重新读取</Button>}</div>}
    {selectedFile && !extracted && !busy && !error && <Button variant="secondary" size="sm" onClick={() => loadFile(selectedFile)}>继续读取</Button>}
    {needsAI && extracted && !busy && <div className="ti-connect"><Sparkles size={17}/><div><strong>{connected ? '继续识别文件' : '连接 AI 识别文件'}</strong><p>{connected ? `使用 ${model.model} 整理交易，完成后可逐笔核对。` : '文件已保留，连接模型后接着处理。'}</p></div><Button variant={connected ? 'feature' : 'secondary'} size="sm" disabled={Boolean(draft)} onClick={() => connected ? recognize(extracted, Boolean(preview.length)) : onConnect?.()}>{connected ? '开始识别' : '连接 AI'}</Button></div>}
    {preview.length > 0 && <section className="j-stack ti-preview" aria-label="核对导入交易">
      <div className="ad-inline"><div className="ti-heading"><h3>核对交易</h3><Tag>{preview.length} 笔</Tag></div><Button size="sm" variant="ghost" className="ti-export" disabled={Boolean(busy) || Boolean(draft)} onClick={exportCsv}><Download size={14}/>导出 CSV</Button></div>
      <p className="ti-preview-origin">来源：{origin}</p>
      {previewSource === 'file' && extracted?.marketData && <div className="ti-market-attached"><Tag>{extracted.marketData.synthetic ? '合成行情' : '随附行情'}</Tag><span>{extracted.marketData.from} — {extracted.marketData.to}</span></div>}
      {groups.length > 1 && <div className="ti-scope"><Field label="本次复盘范围"><StyledSelect label="本次复盘范围" value={currentGroup.key} onChange={value => { setGroupKey(value); setEditing(null); setDraft(null); }} disabled={Boolean(busy) || Boolean(draft)} options={groups.map(group => ({ value: group.key, label: `${group.name}${group.account ? ` / ${group.account}` : ''} / ${group.trades.length} 笔` }))}/></Field><p className="j-hint">其余 {preview.length - currentTrades.length} 笔保留在文件预览，可切换核对。</p></div>}
      <div ref={previewTable} className="ad-table-scroll ti-paged-table"><table className="ad-trades-table"><thead><tr><th>标的</th><th>成交时间</th><th>方向</th><th>成交价</th><th>数量</th><th>费用</th><th><span className="sr-only">操作</span></th></tr></thead><tbody>{currentTrades.slice(pagination.start, pagination.end).map((trade, row) => {
        const position = pagination.start + row, index = currentIndices[position], missing = missingTradeFields(trade);
        return <tr key={`${trade.id}-${index}`} className={editing === index ? 'ti-editing-row' : ''}><td><strong>{display(trade.name)}</strong><small>{display(trade.symbol)}</small></td><td>{display(trade.time).replace('T', ' ')}</td><td><span className={trade.side === 'buy' ? 'ti-buy' : trade.side === 'sell' ? 'ti-sell' : ''}>{trade.side === 'buy' ? '买入' : trade.side === 'sell' ? '卖出' : '待补充'}</span></td><td>{display(trade.price)}</td><td>{display(trade.quantity)}</td><td>{display(trade.fee)}</td><td><span className="ad-row-actions">{missing.length > 0 && <span className="ti-missing"><CircleAlert size={14} aria-hidden="true"/>待补充</span>}<IconButton size="sm" label={`编辑第 ${position + 1} 笔成交`} disabled={Boolean(busy) || Boolean(draft)} onClick={() => edit(index)}><Pencil size={14}/></IconButton><IconButton size="sm" label={`移除第 ${position + 1} 笔成交`} disabled={Boolean(busy) || Boolean(draft)} onClick={() => { removedIds.current.add(trade.id); setPreview(items => items.filter((_, i) => i !== index)); }}><Trash2 size={14}/></IconButton></span></td></tr>;
      })}</tbody></table></div>
      <Pagination {...pagination} total={currentTrades.length} label="核对交易分页" disabled={Boolean(busy) || Boolean(draft)} onPageChange={changePage}/>
      {unknownMarket && <div className="ti-market"><div><strong>确认这批交易的市场</strong><p>按人民币股票复盘，金额与费用均为人民币，数量单位为股。已识别的其他币种会保留核对。</p></div><Button variant="secondary" size="sm" disabled={Boolean(busy) || Boolean(draft)} onClick={confirmMarket}>确认人民币股票</Button></div>}
      {issues.length > 0 && <div className="ti-issues" role="status"><strong><Info size={15}/>以下信息需要核对</strong><ul>{issues.slice(0, 6).map((issue, index) => { const row = Number(/^第 (\d+) 笔/.exec(issue)?.[1]); return <li key={index}>{row ? <button type="button" className="ti-issue-link" disabled={Boolean(busy) || Boolean(draft)} onClick={() => changePage(Math.ceil(row / pagination.pageSize))}>{issue}</button> : issue}</li>; })}</ul>{issues.length > 6 && <small>还有 {issues.length - 6} 项，可逐笔编辑补充。</small>}</div>}
      {currentTrades.some(trade => trade.price == null || trade.fee == null) && <p className="j-hint">未知的价格和费用已留空，可先导入，补齐后再计算完整盈亏。</p>}
    </section>}
    {draft && <form className="ad-edit j-stack" onSubmit={saveEdit}>
      <div className="ad-inline"><h3>编辑交易</h3><IconButton label="取消修改" size="sm" onClick={() => { setDraft(null); setEditing(null); }}><X size={15}/></IconButton></div>
      <div className="j-field-grid">{[['name', '标的名称', 'text'], ['symbol', '标的代码', 'text'], ['time', '成交时间（北京时间）', 'datetime-local'], ['quantity', '成交数量', 'number'], ['price', '成交价（可留空）', 'number'], ['fee', '费用（可留空）', 'number']].map(([key, label, type]) => <Field key={key} label={label}>{key === 'time' ? <DateTimePicker label="成交时间" value={draft.time ?? ''} onChange={value => setDraft({ ...draft, time: value })}/> : <input type={type} min={type === 'number' ? 0 : undefined} step={type === 'number' ? 'any' : undefined} value={draft[key] ?? ''} onChange={e => setDraft({ ...draft, [key]: e.target.value })}/>}</Field>)}<Field label="方向"><StyledSelect label="成交方向" value={draft.side || 'unknown'} onChange={value => setDraft({ ...draft, side: value === 'unknown' ? '' : value })} options={[{ value: 'unknown', label: '待补充' }, { value: 'buy', label: '买入' }, { value: 'sell', label: '卖出' }]}/></Field></div>
      <details className="ti-details"><summary>记录编号</summary><Field label="记录编号"><input value={draft.id ?? ''} onChange={event => setDraft({ ...draft, id: event.target.value })}/></Field></details>
      <div className="ad-actions"><Button type="submit" size="sm">保存修改</Button><Button variant="ghost" size="sm" onClick={() => { setDraft(null); setEditing(null); }}>取消</Button></div>
    </form>}
    {(questions.length > 0 || warnings.length > 0) && <details className="ti-details" open={questions.length > 0}><summary>{questions.length ? '需要补充的信息' : '识别说明'}</summary><ul>{[...questions, ...warnings].map((value, index) => <li key={index}>{value}</li>)}</ul></details>}
    {extracted && !busy && <details className="ti-details" open={needsAI && connected && !preview.length ? true : undefined}><summary>补充说明</summary><div className="j-stack"><Field label="补充缺少的信息或纠正识别结果"><textarea rows={2} value={supplement} onChange={event => setSupplement(event.target.value)} placeholder="例如：这几笔都是同一账户，买入时间是 9 月 7 日 10:30"/></Field><div className="ad-actions"><Button variant={connected ? 'feature' : 'secondary'} size="sm" disabled={!supplement.trim() || Boolean(draft)} onClick={() => connected ? recognize(extracted, true) : onConnect?.()}><Sparkles size={14}/>{connected ? '更新识别结果' : '连接 AI 继续整理'}</Button><span className="j-hint">手动修改的记录会保留。</span></div></div></details>}
    <div className="ad-footer"><Button variant="ghost" onClick={onClose}>取消</Button><Button disabled={Boolean(busy) || Boolean(draft) || !currentTrades.length || issues.length > 0} onClick={accept}>{busy === 'accept' ? '正在导入…' : currentTrades.length ? `确认导入 ${currentTrades.length} 笔` : '确认导入'}</Button></div>
  </div>;
}
