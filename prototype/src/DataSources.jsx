import React, { useEffect, useId, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { CheckCircle2, ChevronDown, CircleAlert, CircleX, Clock3, Database, FileText, Info, KeyRound, Link2, LoaderCircle, Plus, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button, IconButton, Tag } from './ui.jsx';
import { apiRequest, setFinancialConfig, getFinancialConfig } from './services/api.js';
import { StyledSelect } from './SelectionControls.jsx';
import DateTimePicker from './DateTimePicker.jsx';
import './evidence-entry.css';

function Field({ label, children, hint }) {
  return <label className="j-form-field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}
function exportTools(result) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'TradingReview-已发现工具.json'; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Temporary credentials and secret-bearing MCP URLs only live in DOM/ref memory.
 * Parent callbacks receive completed source data or one server-stamped event.
 * Failed, cancelled and stale requests never update the parent's data.
 */
export default function DataSources({ trades = [], selectedTradeId, marketData, evidence = [], onMarketData, onEvidence, mode = 'all' }) {
  const scopeKey = JSON.stringify(trades.map(({ id, symbol, time }) => [id, symbol, time]));
  const initialSymbol = trades[0]?.symbol ?? '';
  const [symbol, setSymbol] = useState(initialSymbol);
  const [from, setFrom] = useState(trades[0]?.time?.slice(0, 10) ?? '');
  const [to, setTo] = useState(trades.at(-1)?.time?.slice(0, 10) ?? '');
  const [provider, setProvider] = useState('ifind');
  const [authHeader, setAuthHeader] = useState('');
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState(null);
  const [toolsResult, setToolsResult] = useState(null);
  const [serverConnections, setServerConnections] = useState({});
  const [autoEvidence, setAutoEvidence] = useState(() => Boolean(getFinancialConfig()));
  const [event, setEvent] = useState({ title: '', text: '', source: '', publishedAt: '', url: '' });
  const [eventOpen, setEventOpen] = useState(false);
  const [moreDetails, setMoreDetails] = useState(false);
  const detailsId = useId();
  const eventTitleInput = useRef(null);
  const keyInput = useRef(null), endpointInput = useRef(null), mcpKeyInput = useRef(null);
  const controller = useRef(null), sequence = useRef(0);
  const requestKind = useRef('');
  const latest = useRef({ scopeKey, onMarketData, onEvidence });
  latest.current = { scopeKey, onMarketData, onEvidence };
  const trade = trades.find(item => item.id === selectedTradeId) ?? trades[0];

  useEffect(() => {
    if (mode === 'evidence') return;
    const request = new AbortController();
    apiRequest('/api/status', { signal: request.signal }).then(result => {
      if (!request.signal.aborted) setServerConnections(result.financialConnections ?? {});
    }).catch(() => { /* Individual connection actions still show request failures. */ });
    return () => request.abort();
  }, [mode]);

  useEffect(() => {
    sequence.current += 1; controller.current?.abort(); setBusy(''); setNotice(null); setToolsResult(null);
    setSymbol(trades[0]?.symbol ?? ''); setFrom(trades[0]?.time?.slice(0, 10) ?? ''); setTo(trades.at(-1)?.time?.slice(0, 10) ?? '');
    setEvent({ title: '', text: '', source: '', publishedAt: '', url: '' });
    setEventOpen(false); setMoreDetails(false);
    // Credentials are never persisted, and are cleared on a dataset change.
    for (const ref of [keyInput, endpointInput, mcpKeyInput]) if (ref.current) ref.current.value = '';
    return () => { sequence.current += 1; controller.current?.abort(); };
  }, [scopeKey, mode]);
  useEffect(() => {
    // A pasted event belongs to one decision. Switching the selected trade
    // must not silently attach that draft or a pending receipt to another one.
    setEvent({ title: '', text: '', source: '', publishedAt: '', url: '' });
    setEventOpen(false); setMoreDetails(false);
    if (requestKind.current === 'event') { sequence.current += 1; controller.current?.abort(); setBusy(''); setNotice(null); }
  }, [trade?.id]);

  async function run(kind, body) {
    controller.current?.abort(); const active = new AbortController(); controller.current = active;
    requestKind.current = kind;
    const requestId = ++sequence.current; const currentScope = scopeKey;
    setBusy(kind); setNotice(null);
    try {
      const result = await apiRequest(kind === 'event' ? '/api/financial/evidence' : '/api/financial/query', { body, signal: active.signal });
      if (active.signal.aborted || requestId !== sequence.current || latest.current.scopeKey !== currentScope) return;
      if (result.status === 'empty' && kind !== 'tools') { setNotice({ error: false, text: '请求完成，范围内没有可用数据，已有材料保留。' }); return; }
      if (result.status !== 'ok' && !(kind === 'tools' && result.status === 'empty')) throw new Error('数据源未返回可用结果，已有材料保留。');
      if (kind === 'bars') {
        if (!Array.isArray(result.bars) || !result.bars.length || result.symbol !== body.symbol.toUpperCase()) throw new Error('行情结果与所选标的不符，未保存。');
        latest.current.onMarketData?.({ ...result, tradeSymbol: initialSymbol });
        setNotice({ error: false, tone: 'success', text: `已读取 ${result.bars.length} 根真实日 K，未复权。获取时间：${result.observedAt.replace('T', ' ')}。` });
      } else if (kind === 'tools') {
        if (!Array.isArray(result.tools)) throw new Error('工具目录格式无效。');
        const readOnlyToolCount = result.readOnlyToolCount ?? result.tools.filter(item => item.annotations?.readOnlyHint === true && item.annotations?.destructiveHint !== true).length;
        if (readOnlyToolCount > 0) setFinancialConfig(body.useServerConfig ? { provider: body.provider, useServerConfig: true } : { provider: body.provider, endpoint: body.endpoint, apiKey: body.apiKey, authHeader: body.authHeader });
        setAutoEvidence(readOnlyToolCount > 0);
        if (body.useServerConfig) setServerConnections(previous => ({ ...previous, [body.provider]: result.connection ?? { ...previous[body.provider], configured: true, status: readOnlyToolCount > 0 ? 'connected' : 'unavailable', readOnlyToolCount } }));
        setToolsResult(result); setNotice({ error: readOnlyToolCount === 0, tone: readOnlyToolCount > 0 ? 'success' : 'error', text: readOnlyToolCount > 0 ? `${result.transport === 'rest' ? '官方资讯 API 已连接' : '连接验证通过'}，可使用 ${readOnlyToolCount} 个只读工具自动取证。` : `已发现 ${result.tools.length} 个工具，暂没有可用于自动取证的只读工具。` });
      } else {
        if (!result.evidence?.id || result.evidence.tradeId !== body.event.tradeId || !result.evidence.recordedAt) throw new Error('事件保存结果不完整，请重试。');
        latest.current.onEvidence?.(result.evidence);
        setEvent({ title: '', text: '', source: '', publishedAt: '', url: '' });
        if (mode === 'evidence') { setEventOpen(false); setMoreDetails(false); setNotice(null); toast.success('证据已添加'); }
        else setNotice({ error: false, tone: 'success', text: '事件原文已保存，发布时间按你的填写保留，采集时间由服务端记录。' });
      }
    } catch (error) {
      if (!active.signal.aborted && requestId === sequence.current) {
        if (kind === 'tools' && body.useServerConfig) setServerConnections(previous => ({ ...previous, [body.provider]: { ...previous[body.provider], status: 'error', readOnlyToolCount: 0 } }));
        setNotice({ error: true, text: error.message || '请求失败，已有材料保留。' });
      }
    } finally { if (requestId === sequence.current) { setBusy(''); controller.current = null; requestKind.current = ''; } }
  }
  function fetchBars() {
    const requested = symbol.trim().toUpperCase();
    const selected = initialSymbol.toUpperCase();
    if (!(requested === selected || (/^\d{6}$/.test(selected) && requested.startsWith(`${selected}.`)))) { setNotice({ error: true, text: '行情代码需要对应当前交易标的。请先导入对应标的的真实成交。' }); return; }
    run('bars', { provider: 'fuyao', kind: 'bars', ...(serverConnections.fuyao?.barsConfigured ? { useServerConfig: true } : { apiKey: keyInput.current?.value ?? '' }), symbol: requested, from, to });
  }
  function stop() { sequence.current += 1; controller.current?.abort(); controller.current = null; requestKind.current = ''; setBusy(''); setNotice({ error: false, text: '已停止，已有材料保留。' }); }
  const changeEvent = (key, value) => setEvent(previous => ({ ...previous, [key]: value }));
  function closeEvent() {
    if (requestKind.current === 'event') { sequence.current += 1; controller.current?.abort(); controller.current = null; requestKind.current = ''; setBusy(''); }
    setNotice(null); setEventOpen(false);
  }

  if (mode === 'evidence') {
    const canSave = !busy && trade && event.title.trim() && event.text.trim() && event.source.trim();
    return <Dialog.Root open={eventOpen} onOpenChange={open => open ? (setNotice(null), setEventOpen(true)) : closeEvent()}>
      <Dialog.Trigger asChild><Button variant="secondary" size="sm" disabled={!trade}><Plus size={14}/>添加证据</Button></Dialog.Trigger>
      <Dialog.Portal><Dialog.Overlay className="overlay"/><Dialog.Content className="modal evidence-dialog" onPointerDownOutside={e => e.preventDefault()} onOpenAutoFocus={e => { e.preventDefault(); eventTitleInput.current?.focus(); }}>
        <div className="modal-head"><div><Dialog.Title>添加证据</Dialog.Title><Dialog.Description>{trade ? `${trade.name}  ${trade.time.replace('T', ' ').slice(0, 16)}` : '请选择关联交易'}</Dialog.Description></div><Dialog.Close asChild><IconButton label="关闭添加证据"><X size={18}/></IconButton></Dialog.Close></div>
        <form onSubmit={e => { e.preventDefault(); if (canSave) run('event', { trades, event: { ...event, tradeId: trade.id, publishedAt: event.publishedAt || null, url: event.url || undefined } }); }}>
          <div className="evidence-fields">
            <div className="evidence-field-row"><Field label="标题"><input ref={eventTitleInput} value={event.title} onChange={e => changeEvent('title', e.target.value)} maxLength={300} disabled={Boolean(busy)} placeholder="为这份材料命名"/></Field><Field label="来源"><input value={event.source} onChange={e => changeEvent('source', e.target.value)} maxLength={260} disabled={Boolean(busy)} placeholder="公告、新闻或当时记录"/></Field></div>
            <Field label="原文内容"><textarea rows={5} value={event.text} onChange={e => changeEvent('text', e.target.value)} maxLength={20000} disabled={Boolean(busy)} placeholder="粘贴原文或需要核对的摘录"/></Field>
            <button type="button" className="evidence-details-toggle" aria-expanded={moreDetails} aria-controls={detailsId} onClick={() => setMoreDetails(value => !value)}><ChevronDown size={14} className={moreDetails ? 'is-expanded' : ''}/>发布时间与链接<span>选填</span></button>
            {moreDetails && <div id={detailsId} className="evidence-details"><div className="evidence-detail-field"><div className="evidence-detail-label"><span>发布时间</span><small>北京时间</small></div><DateTimePicker value={event.publishedAt} onChange={value => changeEvent('publishedAt', value)} allowDateOnly disabled={Boolean(busy)}/></div><label className="evidence-detail-field"><span className="evidence-detail-label">原文链接</span><div className="evidence-link-input"><Link2 size={16}/><input type="url" value={event.url} onChange={e => changeEvent('url', e.target.value)} maxLength={2048} disabled={Boolean(busy)} placeholder="粘贴原文链接"/></div></label></div>}
            {notice && <p className={`evidence-notice ${notice.error ? 'is-error' : notice.tone === 'success' ? 'is-success' : ''}`} role={notice.error ? 'alert' : 'status'}>{notice.error ? <CircleX size={15} aria-hidden="true"/> : notice.tone === 'success' ? <CheckCircle2 size={15} aria-hidden="true"/> : <Info size={15} aria-hidden="true"/>}<span>{notice.text}</span></p>}
          </div>
          <div className="modal-actions"><Button variant="ghost" onClick={closeEvent}>取消</Button><Button type="submit" disabled={!canSave}>{busy && <LoaderCircle size={15} className="evidence-spinner"/>}{busy ? '正在保存' : '保存证据'}</Button></div>
        </form>
      </Dialog.Content></Dialog.Portal>
    </Dialog.Root>;
  }

  const Wrapper = mode === 'connections' ? 'section' : 'details';
  return <Wrapper className={mode === 'connections' ? 'aw-data-settings' : 'j-panel'}>
    {mode !== 'connections' && <summary><span className="j-inline">{mode === 'evidence' ? <FileText size={16}/> : <Database size={16}/>}<strong>{mode === 'evidence' ? '补充证据' : '行情与事件来源'}</strong>{mode === 'all' && <Tag>{marketData?.status === 'ok' ? <CheckCircle2 size={14} aria-hidden="true"/> : <Clock3 size={14} aria-hidden="true"/>}{marketData?.status === 'ok' ? '已读取行情' : '按需补充'}</Tag>}</span></summary>}
    <div className="j-stack">
      {mode !== 'evidence' && <>
      <p className="j-hint">用真实历史行情和带出处的原文辅助复盘。你可以只补充需要核对的部分。</p>
      {Object.entries(serverConnections).filter(([, connection]) => connection.configured).map(([sourceProvider, connection]) => <section className="aw-data-connection" data-status={connection.status || 'configured'} key={sourceProvider} aria-label={`${sourceProvider === 'fuyao' ? '扶摇' : 'iFinD'}服务端连接`}>
        <div className="j-inline"><span className="aw-source-icon"><Database size={16}/></span><strong>{sourceProvider === 'fuyao' ? '扶摇' : 'iFinD'}</strong><Tag className="aw-source-status">{connection.status === 'connected' ? <CheckCircle2 size={14} aria-hidden="true"/> : connection.status === 'error' ? <CircleX size={14} aria-hidden="true"/> : connection.status === 'unavailable' ? <CircleAlert size={14} aria-hidden="true"/> : <Clock3 size={14} aria-hidden="true"/>}{({connected:'连接验证通过',error:'连接需检查',unavailable:'未发现可用工具'})[connection.status] || '服务端已配置'}</Tag>{connection.status === 'connected' && connection.transport === 'rest' && <Tag>官方资讯 API</Tag>}</div>
        <p className="j-hint">凭证由服务端保管，刷新后仍可使用。{connection.status === 'connected' ? `已确认 ${connection.readOnlyToolCount ?? 0} 个只读工具。` : '验证后可确认当前账号的可用工具。'}</p>
        <Button variant={connection.status === 'connected' ? 'secondary' : 'feature'} size="sm" disabled={Boolean(busy)} onClick={() => run('tools', { provider: sourceProvider, kind: 'tools', useServerConfig: true })}>{connection.status === 'connected' ? '重新验证连接' : '验证自动取证连接'}</Button>
      </section>)}
      <section className="j-stack" aria-label="扶摇历史行情">
        <div className="j-inline"><KeyRound size={16}/><h3>扶摇历史日 K</h3><Tag>未复权</Tag></div>
        {!serverConnections.fuyao?.barsConfigured && <Field label="扶摇 API Key" hint="仅保留在当前页面内存。刷新或切换数据后需要重新填写。"><input ref={keyInput} type="password" autoComplete="off" disabled={Boolean(busy)} placeholder="填写你为本次使用创建的密钥"/></Field>}
        <div className="j-field-grid"><Field label="官方标的代码" hint="含交易所后缀，例如 600519.SH，不自动推断交易所。"><input value={symbol} onChange={e => setSymbol(e.target.value)} disabled={Boolean(busy)} maxLength={20}/></Field><Field label="开始日期"><DateTimePicker label="行情开始日期" mode="date" value={from} onChange={setFrom} max={to} disabled={Boolean(busy)}/></Field><Field label="结束日期"><DateTimePicker label="行情结束日期" mode="date" value={to} onChange={setTo} min={from} disabled={Boolean(busy)}/></Field></div>
        <div className="j-inline"><Button variant="secondary" size="sm" disabled={Boolean(busy) || !trades.length} onClick={fetchBars}>读取历史日 K</Button><a className="j-link" href="https://fuyao.aicubes.cn/docs/api-reference/prices/" target="_blank" rel="noreferrer">接口与权限说明</a></div>
        <p className="j-hint">当前接口提供完整日线。还原成交时未收盘的 K 线需要盘中数据，缺少时会单独提示；不会使用当天最终收盘结果代替。</p>
      </section>
      <div className="j-divider"/>
      <details><summary>从官方 HTTP MCP 配置发现工具</summary><div className="j-stack">
        <p className="j-hint">连接后，AI 会按成交时点与决策背景查询相关证据。凭证仅保留在本页内存，刷新后需要重新连接。</p>
        {autoEvidence && !getFinancialConfig()?.useServerConfig && <div className="j-inline"><Tag><CheckCircle2 size={14} aria-hidden="true"/>临时连接已启用</Tag><Button variant="ghost" size="sm" onClick={() => { setFinancialConfig(null); setAutoEvidence(false); }}>断开临时连接</Button></div>}
        <div className="j-field-grid"><Field label="服务来源"><StyledSelect label="服务来源" value={provider} disabled={Boolean(busy)} onChange={value => { setProvider(value); setAuthHeader(value === 'fuyao' ? 'X-api-key' : ''); setToolsResult(null); if (endpointInput.current) endpointInput.current.value = ''; if (mcpKeyInput.current) mcpKeyInput.current.value = ''; }} options={[{ value: 'ifind', label: 'iFinD' }, { value: 'fuyao', label: '扶摇' }]}/></Field><Field label="官方配置的鉴权请求头"><StyledSelect label="官方配置的鉴权请求头" value={authHeader || 'url'} onChange={value => setAuthHeader(value === 'url' ? '' : value)} disabled={Boolean(busy)} options={[{ value: 'url', label: '使用 URL 授权' }, { value: 'X-api-key', label: 'X-api-key' }, { value: 'Authorization', label: 'Authorization' }]}/></Field></div>
        <Field label="官方 HTTP MCP URL" hint="仅接受 51ifind 官方域名或 fuyao.aicubes.cn 的 HTTPS 地址，URL 不保存。"><input ref={endpointInput} type="password" autoComplete="off" disabled={Boolean(busy)} placeholder="从官方生成配置复制完整 URL"/></Field>
        <Field label="鉴权值（按官方配置填写）" hint="Authorization 请填写官方配置中的完整值；URL 已含授权时可留空。"><input ref={mcpKeyInput} type="password" autoComplete="off" disabled={Boolean(busy)}/></Field>
        <div className="j-inline"><Button variant="feature" disabled={Boolean(busy)} onClick={() => run('tools', { provider, kind: 'tools', endpoint: endpointInput.current?.value ?? '', apiKey: mcpKeyInput.current?.value ?? '', authHeader: authHeader || undefined })}><KeyRound size={15}/>连接并启用自动取证</Button>{toolsResult && <Button variant="ghost" size="sm" onClick={() => exportTools(toolsResult)}>导出工具定义</Button>}</div>
        {toolsResult && <div className="j-fact"><strong>{toolsResult.tools.length} 个已发现工具</strong><p className="j-hint">{toolsResult.tools.slice(0, 8).map(item => item.name).join('、')}{toolsResult.tools.length > 8 ? '，完整列表见导出文件。' : ''}</p><p className="j-hint">工具发现成功不代表已取得公告或行情。</p></div>}
      </div></details>
      </>}
      {mode === 'all' && <div className="j-divider"/>}
      {mode !== 'connections' &&
      <section className="j-stack" aria-label="录入事件原文">
        <div className="j-inline"><FileText size={16}/><h3>补充一条带出处的事件</h3><Tag>{evidence.filter(item => item.tradeId === trade?.id).length} 条</Tag></div>
        <p className="j-hint">关联当前决定：{trade ? `${trade.name}，${trade.time.replace('T', ' ')}` : '请先选择交易'}。此处保存原文与出处，不会自动证明你当时已看到它。</p>
        <Field label="事件标题"><input value={event.title} onChange={e => changeEvent('title', e.target.value)} maxLength={300} disabled={Boolean(busy)}/></Field>
        <Field label="原文或原始摘录"><textarea rows={3} value={event.text} onChange={e => changeEvent('text', e.target.value)} maxLength={20000} disabled={Boolean(busy)} placeholder="粘贴需要核对的原文，避免把自己的解释写成原文"/></Field>
        <div className="j-field-grid"><Field label="原文来源"><input value={event.source} onChange={e => changeEvent('source', e.target.value)} maxLength={260} disabled={Boolean(busy)} placeholder="例如：公司公告、交易所网站"/></Field><Field label="原文发布时间（北京时间，选填）" hint="可只填日期，不清楚时留空。"><DateTimePicker value={event.publishedAt} onChange={value => changeEvent('publishedAt', value)} allowDateOnly disabled={Boolean(busy)}/></Field></div>
        <Field label="原文链接（选填）"><input type="url" value={event.url} onChange={e => changeEvent('url', e.target.value)} maxLength={2048} disabled={Boolean(busy)} placeholder="https://"/></Field>
        <div className="j-inline"><Button variant="secondary" size="sm" disabled={Boolean(busy) || !trade || !event.title.trim() || !event.text.trim() || !event.source.trim()} onClick={() => run('event', { trades, event: { ...event, tradeId: trade.id, publishedAt: event.publishedAt || null, url: event.url || undefined } })}>保存事件原文</Button></div>
      </section>}
      {busy && <div className="j-inline" role="status"><LoaderCircle size={15}/><span className="j-hint">正在请求服务，已有材料保持可用</span><Button variant="ghost" size="sm" onClick={stop}>停止</Button></div>}
      {notice && <div className={`aw-data-notice ${notice.error ? 'is-error' : notice.tone === 'success' ? 'is-success' : ''}`} role={notice.error ? 'alert' : 'status'}>{notice.error ? <CircleX size={15} aria-hidden="true"/> : notice.tone === 'success' ? <CheckCircle2 size={15} aria-hidden="true"/> : <Info size={15} aria-hidden="true"/>}<span>{notice.text}</span></div>}
    </div>
  </Wrapper>;
}
