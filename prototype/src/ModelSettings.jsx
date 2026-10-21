import React, { useEffect, useId, useRef, useState } from 'react';
import { ArrowUpRight, Braces, CheckCircle2, CircleAlert, CircleX, Clock3, Info, KeyRound, RefreshCw, ShieldCheck, Sparkles } from 'lucide-react';
import { Button } from './ui.jsx';
import { apiRequest, clearSessionConfig, hasSessionConfig, setSessionConfig } from './services/api.js';
import { modelMetadata } from './model-connection.js';
import { ModelPicker, StyledSelect } from './SelectionControls.jsx';
import './agent-dialogs.css';

function Field({ label, hint, error, children }) { return <label className={`j-form-field ${error ? 'ad-field-invalid' : ''}`}><span>{label}</span>{children}{error ? <small className="ad-field-error">{error}</small> : hint && <small>{hint}</small>}</label>; }
function oauthState(value) {
  return { status: ['idle', 'pending', 'connected', 'error'].includes(value?.status) ? value.status : 'error', ...(typeof value?.message === 'string' ? { message: value.message } : {}), ...(value?.status === 'pending' && typeof value.url === 'string' && /^https?:\/\//.test(value.url) ? { url: value.url } : {}) };
}

export default function ModelSettings({ model, onConnected, onDisconnected, onClose }) {
  const id = useId();
  const [method, setMethod] = useState(model?.auth === 'oauth' ? 'oauth' : 'api');
  const [provider, setProvider] = useState(model?.provider || 'openai');
  const [modelId, setModelId] = useState(model?.model || '');
  const [runtime, setRuntime] = useState(null);
  const [runtimeError, setRuntimeError] = useState('');
  const [reload, setReload] = useState(0);
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [oauth, setOauth] = useState({ status: 'checking' });
  const [models, setModels] = useState([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState('');
  const [catalogReload, setCatalogReload] = useState(0);
  const [connected, setConnected] = useState(model?.auth === 'api' && hasSessionConfig(model) ? model : null);
  const keyInput = useRef(null), baseInput = useRef(null);
  const request = useRef(null), oauthStatusRequest = useRef(null), sequence = useRef(0), active = useRef(false), ownsPendingOAuth = useRef(false);
  const modelValue = useRef(modelId); modelValue.current = modelId;
  const locked = busy || oauth.status === 'pending' || (method === 'oauth' && oauth.status === 'checking');

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false; sequence.current++; request.current?.abort(); oauthStatusRequest.current?.abort();
      if (ownsPendingOAuth.current) apiRequest('/api/oauth/cancel', { body: {} }).catch(() => {});
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController(); setRuntimeError('');
    apiRequest('/api/status', { signal: controller.signal }).then(value => { if (!controller.signal.aborted) setRuntime(value); }).catch(e => { if (e.name !== 'AbortError') setRuntimeError(e.message); });
    return () => controller.abort();
  }, [reload]);
  async function readOAuthStatus() {
    oauthStatusRequest.current?.abort(); const controller = new AbortController(); oauthStatusRequest.current = controller;
    setOauth({ status: 'checking' });
    try {
      const result = await apiRequest('/api/oauth/status', { signal: controller.signal });
      if (active.current && !controller.signal.aborted) setOauth(oauthState(result));
    } catch (e) { if (active.current && !controller.signal.aborted && e.name !== 'AbortError') setOauth({ status: 'unavailable', message: '暂时无法读取授权状态，请重试。已保存的授权不会被清除。' }); }
    finally { if (oauthStatusRequest.current === controller) oauthStatusRequest.current = null; }
  }
  useEffect(() => { if (runtime?.oauth) readOAuthStatus(); else if (runtime) setOauth({ status: 'idle' }); }, [runtime?.oauth]);
  useEffect(() => {
    const selectedProvider = method === 'oauth' ? 'openai' : provider;
    setModels([]); setModelsError('');
    if (selectedProvider === 'openai-compatible') { setModelsLoading(false); return; }
    const controller = new AbortController(); setModelsLoading(true);
    apiRequest(`/api/models?provider=${selectedProvider}&auth=${method}`, { signal: controller.signal }).then(value => { if (!controller.signal.aborted) setModels(Array.isArray(value.models) ? value.models : []); }).catch(e => { if (!controller.signal.aborted) setModelsError(e.message); }).finally(() => { if (!controller.signal.aborted) setModelsLoading(false); });
    return () => controller.abort();
  }, [method, provider, catalogReload]);

  async function connect(config) {
    request.current?.abort(); const controller = new AbortController(); request.current = controller; const token = ++sequence.current;
    setBusy(true); setError(''); setFieldErrors({}); setConnected(null);
    try {
      const result = await apiRequest('/api/models/connect', { body: { config }, signal: controller.signal });
      if (!active.current || controller.signal.aborted || sequence.current !== token) return;
      if (result.ok !== true) throw new Error('模型连接尚未验证成功。');
      const metadata = modelMetadata({ mode: 'live', provider: result.provider || config.provider, model: result.model || config.model, auth: config.auth, baseUrl: config.baseUrl });
      setSessionConfig({ ...config, provider: metadata.provider, model: metadata.model });
      if (keyInput.current) keyInput.current.value = '';
      setConnected(metadata); await onConnected(metadata);
    } catch (e) { if (active.current && sequence.current === token && e.name !== 'AbortError') setError(e.message); }
    finally { if (active.current && sequence.current === token) { setBusy(false); request.current = null; } }
  }
  useEffect(() => {
    if (oauth.status !== 'pending') return;
    const controller = new AbortController(); const token = sequence.current; let timer;
    const poll = async () => {
      try {
        const result = oauthState(await apiRequest('/api/oauth/status', { signal: controller.signal }));
        if (controller.signal.aborted || !active.current || sequence.current !== token) return;
        if (result.status === 'connected') {
          const shouldVerify = ownsPendingOAuth.current; ownsPendingOAuth.current = false; setOauth(result);
          if (shouldVerify) await connect({ provider: 'openai', model: modelValue.current.trim(), auth: 'oauth' });
        } else if (result.status === 'pending') { setOauth(result); timer = setTimeout(poll, 1500); }
        else { ownsPendingOAuth.current = false; setOauth(result); setError(result.message || '授权尚未完成，请重新连接。'); }
      } catch (e) { if (!controller.signal.aborted && active.current && sequence.current === token) { setError(e.message); setOauth({ status: 'error' }); } }
    };
    timer = setTimeout(poll, 900);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [oauth.status]);

  async function startOAuth() {
    if (!modelId.trim()) { setFieldErrors({ model: '请选择或填写模型 ID。' }); setError('请先选择或填写要使用的模型 ID。'); return; }
    if (oauth.status === 'connected') { await connect({ provider: 'openai', model: modelId.trim(), auth: 'oauth' }); return; }
    request.current?.abort(); const controller = new AbortController(); request.current = controller; const token = ++sequence.current;
    setBusy(true); setError(''); setConnected(null);
    try {
      const result = oauthState(await apiRequest('/api/oauth/start', { body: {}, signal: controller.signal }));
      if (!active.current || controller.signal.aborted || sequence.current !== token) return;
      ownsPendingOAuth.current = result.status === 'pending'; setOauth(result);
      if (result.status === 'connected') await connect({ provider: 'openai', model: modelId.trim(), auth: 'oauth' });
      else if (result.status !== 'pending') setError(result.message || '授权没有启动，请重试。');
    } catch (e) { if (active.current && sequence.current === token && e.name !== 'AbortError') setError(e.message); }
    finally { if (active.current && sequence.current === token) { setBusy(false); request.current = null; } }
  }
  async function cancelOAuth() {
    const token = ++sequence.current; request.current?.abort(); setBusy(true); setError('');
    try { const result = await apiRequest('/api/oauth/cancel', { body: {} }); if (active.current && sequence.current === token) { ownsPendingOAuth.current = false; setOauth(oauthState(result)); } }
    catch (e) { if (active.current && sequence.current === token) setError(e.message); }
    finally { if (active.current && sequence.current === token) setBusy(false); }
  }
  async function disconnectOAuth() {
    const token = ++sequence.current; request.current?.abort(); setBusy(true); setError('');
    try {
      const result = await apiRequest('/api/oauth/disconnect', { body: {} });
      if (!active.current || sequence.current !== token) return;
      if (result.status !== 'idle') throw new Error('授权尚未断开，请重试。');
      ownsPendingOAuth.current = false; setOauth(oauthState(result));
      if (model?.auth !== 'api' && connected?.auth !== 'api') clearSessionConfig();
      if (model?.auth === 'oauth' || connected?.auth === 'oauth') { setConnected(null); onDisconnected?.(); }
    } catch (e) { if (active.current && sequence.current === token) setError(e.message); }
    finally { if (active.current && sequence.current === token) setBusy(false); }
  }
  function stopConnection() { sequence.current++; request.current?.abort(); request.current = null; setBusy(false); setError('已停止连接验证。'); }
  function choose(value) { if (locked) return; setMethod(value); setError(''); setFieldErrors({}); setConnected(null); }
  function clearField(key) { setFieldErrors(previous => ({ ...previous, [key]: '' })); setError(''); }
  function tabKey(event) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || locked) return;
    event.preventDefault(); const next = event.key === 'Home' ? 'api' : event.key === 'End' ? 'oauth' : method === 'api' ? 'oauth' : 'api'; choose(next); document.getElementById(`${id}-${next}-tab`)?.focus();
  }
  function submit(event) {
    event.preventDefault(); const apiKey = keyInput.current?.value.trim(); const baseUrl = provider === 'openai-compatible' ? baseInput.current?.value.trim() : '';
    const invalid = { ...(!modelId.trim() ? { model: '请选择或填写模型 ID。' } : {}), ...(!apiKey ? { apiKey: '请填写 API Key。' } : {}), ...(provider === 'openai-compatible' && (!baseUrl || baseInput.current?.validity.typeMismatch) ? { baseUrl: '请填写有效的接口地址。' } : {}) };
    setFieldErrors(invalid);
    if (Object.keys(invalid).length) { setError('请检查标记出的连接信息。'); return; }
    connect({ provider, model: modelId.trim(), apiKey, auth: 'api', ...(baseUrl ? { baseUrl } : {}) });
  }

  const modelPicker = <div role="group" aria-label="模型选择" aria-invalid={Boolean(fieldErrors.model) || undefined}><ModelPicker key={`${method}-${provider}`} value={modelId} onChange={value => { setModelId(value); clearField('model'); setConnected(null); }} models={models} disabled={locked} loading={modelsLoading} error={modelsError} onRetry={() => setCatalogReload(value => value + 1)}/></div>;
  return <div className="agent-dialog ad-model-settings j-stack">
    <div className="ad-tabs" role="tablist" aria-label="模型连接方式" onKeyDown={tabKey}>{[['api', 'API 接入'], ['oauth', 'ChatGPT 订阅']].map(([value, label]) => <button key={value} id={`${id}-${value}-tab`} role="tab" aria-selected={method === value} aria-controls={`${id}-${value}-panel`} tabIndex={method === value ? 0 : -1} disabled={locked} onClick={() => choose(value)}>{value === 'api' ? <KeyRound size={15}/> : <Sparkles size={15}/>}{label}</button>)}</div>
    <div className="ad-inline ad-connection-intro"><p className="j-hint">用你选择的模型，整理材料与核对决策。</p><span className={`ad-service-status ${runtimeError ? 'is-error' : runtime ? 'is-ready' : ''}`}>{runtimeError ? <CircleX size={14} aria-hidden="true"/> : runtime ? <CheckCircle2 size={14} aria-hidden="true"/> : <Clock3 size={14} aria-hidden="true"/>}{runtimeError ? '服务连接失败' : runtime?.runtime === 'local' ? '本地服务' : runtime?.runtime === 'cloud' ? '在线服务' : '检查服务'}</span></div>
    {runtimeError && <div className="ad-notice ad-error" role="alert"><CircleX size={16} aria-hidden="true"/><span>{runtimeError}</span><Button size="sm" variant="ghost" onClick={() => setReload(v => v + 1)}><RefreshCw size={14}/>重新检查</Button></div>}
    <div id={`${id}-${method}-panel`} role="tabpanel" aria-labelledby={`${id}-${method}-tab`}>
      {method === 'api' ? <form className="j-stack ad-connection-form" noValidate onSubmit={submit}>
        <div className="ad-model-grid"><Field label="服务商"><StyledSelect label="服务商" value={provider} disabled={locked} onChange={value => { setProvider(value); setModelId(''); setFieldErrors({}); setError(''); setConnected(null); }} options={[{ value: 'openai', label: 'OpenAI', icon: <Sparkles size={15}/> }, { value: 'anthropic', label: 'Anthropic', icon: 'A' }, { value: 'openai-compatible', label: 'OpenAI 兼容接口', icon: <Braces size={15}/> }]}/></Field><Field label="模型" error={fieldErrors.model}>{modelPicker}</Field></div>
        {provider === 'openai-compatible' && <Field label="接口地址" error={fieldErrors.baseUrl}><input ref={baseInput} type="url" required defaultValue={model?.baseUrl || ''} disabled={locked} aria-invalid={Boolean(fieldErrors.baseUrl) || undefined} autoComplete="off" placeholder="https://api.deepseek.com/v1" onChange={() => { clearField('baseUrl'); setConnected(null); }}/></Field>}
        <Field label="API Key" error={fieldErrors.apiKey} hint="仅保留在当前页面内存，刷新后需重新填写。"><input ref={keyInput} type="password" required disabled={locked} aria-invalid={Boolean(fieldErrors.apiKey) || undefined} autoComplete="off" placeholder="输入你的 API Key" onChange={() => { clearField('apiKey'); setConnected(null); }}/></Field>
        <div className="ad-actions"><Button variant="feature" type="submit" disabled={locked || !runtime}><KeyRound size={15}/>{busy ? '正在验证连接…' : '验证并连接'}</Button>{busy && <Button variant="ghost" onClick={stopConnection}>停止</Button>}</div>
      </form> : <div className="j-stack">
        <Field label="模型" error={fieldErrors.model}>{modelPicker}</Field>
        <p className="ad-help"><ShieldCheck size={15}/>授权在提供方页面完成，随后验证所选模型。</p>
        {!runtime?.oauth && <p className="j-hint">订阅授权需要本地 TradingReview 服务。当前环境可使用模型 API。</p>}
        {oauth.status === 'connected' && <p className="ad-success" role="status"><CheckCircle2 size={16}/><span>使用已保存授权。验证所选模型后即可连接。</span></p>}
        {oauth.status === 'checking' && runtime?.oauth && <p className="j-hint" role="status">正在读取授权状态…</p>}
        {oauth.status === 'unavailable' && <p className="ad-error" role="alert">{oauth.message}</p>}
        <div className="ad-actions">{oauth.status === 'unavailable' ? <Button variant="feature" disabled={busy} onClick={readOAuthStatus}><RefreshCw size={15}/>重新检查授权</Button> : <Button variant="feature" disabled={!runtime?.oauth || locked} onClick={startOAuth}>{busy ? '正在处理…' : oauth.status === 'connected' ? '验证并连接' : '开始授权'}{oauth.status === 'connected' ? <KeyRound size={15}/> : <ArrowUpRight size={15}/>}</Button>}{oauth.status === 'pending' && <Button variant="ghost" disabled={busy} onClick={cancelOAuth}>取消授权</Button>}{oauth.status === 'connected' && <Button variant="ghost" disabled={busy} onClick={disconnectOAuth}>断开授权</Button>}</div>
        {oauth.status === 'pending' && <div className="ad-notice" role="status"><Clock3 size={16} aria-hidden="true"/><span>正在等待授权完成。</span>{oauth.url && /^https?:\/\//.test(oauth.url) && <a className="j-link" href={oauth.url} target="_blank" rel="noopener noreferrer">打开授权页面<ArrowUpRight size={14}/></a>}</div>}
      </div>}
    </div>
    {connected && <p className="ad-success" role="status"><CheckCircle2 size={16}/>{connected.model} 已通过连接验证</p>}
    {error && <p className={error === '已停止连接验证。' ? 'ad-notice' : 'ad-error'} role={error === '已停止连接验证。' ? 'status' : 'alert'}>{error === '已停止连接验证。' ? <Info size={16} aria-hidden="true"/> : Object.values(fieldErrors).some(Boolean) ? <CircleAlert size={16} aria-hidden="true"/> : <CircleX size={16} aria-hidden="true"/>}<span>{error}</span></p>}
    <div className="ad-footer"><span className="j-hint ad-data-note"><ShieldCheck size={14}/>发起 AI 处理时，相关材料会发送给所选模型。</span></div>
  </div>;
}
