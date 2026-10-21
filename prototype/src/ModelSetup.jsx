import React, { useEffect, useRef, useState } from 'react';
import { ArrowRight, ArrowUpRight, CheckCircle2, FlaskConical, KeyRound, ShieldCheck, Sparkles } from 'lucide-react';
import { Button, Tag } from './ui.jsx';
import { apiRequest, clearSessionConfig, hasSessionConfig, setSessionConfig } from './services/api.js';
import { modelMetadata, modelTransitionPatch } from './model-connection.js';
import './model-setup.css';

function Field({ label, hint, children }) { return <label className="j-form-field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>; }
function oauthState(value) {
  return { status: ['idle', 'pending', 'connected', 'error'].includes(value?.status) ? value.status : 'error', ...(typeof value?.message === 'string' ? { message: value.message } : {}), ...(value?.status === 'pending' && typeof value.url === 'string' && /^https?:\/\//.test(value.url) ? { url: value.url } : {}) };
}
export default function ModelSetup({ state, patch, go }) {
  const [method, setMethod] = useState(state.model?.auth === 'oauth' ? 'oauth' : 'api');
  const [provider, setProvider] = useState(state.model?.provider || 'openai');
  const [model, setModel] = useState(state.model?.model || '');
  const [runtime, setRuntime] = useState(null);
  const [serviceError, setServiceError] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [oauth, setOauth] = useState({ status: 'checking' });
  const [verified, setVerified] = useState(state.model?.mode === 'live' && state.model.auth === 'api' && hasSessionConfig(state.model));
  const [models, setModels] = useState([]);
  const keyInput = useRef(null);
  const baseInput = useRef(null);
  const modelValue = useRef(model);
  modelValue.current = model;
  const active = useRef(true);
  const request = useRef(null), oauthStatusRequest = useRef(null), sequence = useRef(0), ownsPendingOAuth = useRef(false);
  const locked = busy || oauth.status === 'pending' || (method === 'oauth' && oauth.status === 'checking');
  useEffect(() => { active.current = true; const controller = new AbortController(); apiRequest('/api/status', { signal: controller.signal }).then(value => { if (!controller.signal.aborted) setRuntime(value); }).catch(e => { if (e.name !== 'AbortError') setServiceError(e.message); }); return () => { active.current = false; sequence.current++; controller.abort(); request.current?.abort(); oauthStatusRequest.current?.abort(); if (ownsPendingOAuth.current) apiRequest('/api/oauth/cancel', { body: {} }).catch(() => {}); }; }, []);
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
    if (method !== 'oauth' || !runtime?.oauth) return;
    const controller = new AbortController();
    apiRequest('/api/models?provider=openai&auth=oauth', { signal: controller.signal }).then(result => setModels(Array.isArray(result.models) ? result.models : [])).catch(() => setModels([]));
    return () => controller.abort();
  }, [method, runtime?.oauth]);
  async function connect(config) {
    request.current?.abort(); const controller = new AbortController(); request.current = controller; const token = ++sequence.current;
    setError(''); setBusy(true); setVerified(false);
    try {
      const result = await apiRequest('/api/models/connect', { body: { config }, signal: controller.signal });
      if (!active.current || controller.signal.aborted || sequence.current !== token) return;
      if (result.ok !== true) throw new Error('模型连接尚未验证成功。');
      const metadata = modelMetadata({ mode: 'live', provider: result.provider || config.provider, model: result.model || config.model, auth: config.auth, baseUrl: config.baseUrl });
      setSessionConfig({ ...config, provider: metadata.provider, model: metadata.model });
      patch({ ...modelTransitionPatch(state, metadata), provider: config.auth === 'oauth' ? 'chatgpt' : 'api', connected: metadata.model });
      if (keyInput.current) keyInput.current.value = '';
      setVerified(true);
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
        setOauth(result);
        if (result.status === 'connected') { const shouldVerify = ownsPendingOAuth.current; ownsPendingOAuth.current = false; if (shouldVerify) await connect({ provider: 'openai', model: modelValue.current.trim(), auth: 'oauth' }); }
        else if (result.status === 'pending') timer = setTimeout(poll, 1800);
        else { ownsPendingOAuth.current = false; setError(result.message || '授权未完成，请重试。'); }
      } catch (e) { if (!controller.signal.aborted && active.current && sequence.current === token) { setError(e.message); setOauth({ status: 'error' }); } }
    };
    timer = setTimeout(poll, 1200);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [oauth.status]);
  function changeMethod(value) { setMethod(value); setError(''); setVerified(false); }
  async function startOAuth() {
    if (!model.trim()) { setError('请填写要使用的模型 ID。'); return; }
    if (oauth.status === 'connected') { await connect({ provider: 'openai', model: model.trim(), auth: 'oauth' }); return; }
    request.current?.abort(); const controller = new AbortController(); request.current = controller; const token = ++sequence.current;
    setBusy(true); setError(''); setVerified(false);
    try {
      const result = oauthState(await apiRequest('/api/oauth/start', { body: {}, signal: controller.signal }));
      if (!active.current || controller.signal.aborted || sequence.current !== token) return;
      ownsPendingOAuth.current = result.status === 'pending'; setOauth(result);
      if (result.status === 'connected') await connect({ provider: 'openai', model: model.trim(), auth: 'oauth' });
      else if (result.status !== 'pending') setError(result.message || '授权未启动。');
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
      ownsPendingOAuth.current = false; setOauth(oauthState(result)); setVerified(false);
      if (state.model?.auth !== 'api') clearSessionConfig();
      if (state.model?.auth === 'oauth') patch({ model: null, connected: '', provider: '' });
    } catch (e) { if (active.current && sequence.current === token) setError(e.message); }
    finally { if (active.current && sequence.current === token) setBusy(false); }
  }
  function submit(event) {
    event.preventDefault();
    const apiKey = keyInput.current?.value.trim();
    if (!apiKey || !model.trim()) { setError('请填写模型 ID 和 API Key。'); return; }
    const baseUrl = baseInput.current?.value.trim();
    connect({ provider, model: model.trim(), apiKey, auth: 'api', ...(baseUrl ? { baseUrl } : {}) });
  }
  const ready = ((state.model?.mode === 'demo' || !state.model) && Boolean(state.connected)) || verified;
  return <>
    <div className="j-two-col"><div className="j-stack">
      <div className="j-options">{[['api', KeyRound, '模型 API', '使用自己的模型服务'], ['oauth', Sparkles, 'ChatGPT 授权', '在支持授权的本地环境连接']].map(([id, Icon, title, description]) => <button key={id} className={`j-option ${method === id ? 'selected' : ''}`} aria-pressed={method === id} disabled={locked} onClick={() => changeMethod(id)}><span className="j-option-icon"><Icon size={21}/></span><span className="j-option-copy"><strong>{title}</strong><p>{description}</p></span><span className="j-radio">{method === id && <span/>}</span></button>)}</div>
      <div className="j-panel j-demo-entry"><div className="j-inline"><FlaskConical size={18}/><strong>先体验一下</strong></div><p className="j-hint">用预设对话和构造交易走完一次复盘。</p><Button variant="secondary" onClick={() => { clearSessionConfig(); patch({ ...modelTransitionPatch(state, { mode: 'demo' }), connected: '示例模型' }); go(1); }}>使用示例体验<ArrowRight size={16}/></Button></div>
    </div><div className="j-panel j-stack">
      <div className="j-panel-head"><h2>{method === 'api' ? '配置模型 API' : '连接 ChatGPT'}</h2><Tag>{runtime?.runtime === 'local' ? '本地服务' : runtime?.runtime === 'cloud' ? '在线服务' : '检查服务'}</Tag></div>
      {serviceError && <p className="model-help" role="status">{serviceError} 仍可使用示例体验。</p>}
      {method === 'api' ? <form className="j-stack" onSubmit={submit}>
        <Field label="服务商"><select disabled={busy} value={provider} onChange={e => { setProvider(e.target.value); setVerified(false); }}><option value="openai">OpenAI</option><option value="anthropic">Anthropic</option><option value="openai-compatible">OpenAI 兼容接口</option></select></Field>
        {provider === 'openai-compatible' && <Field label="接口地址"><input disabled={busy} ref={baseInput} type="url" required defaultValue={state.model?.baseUrl || ''} placeholder="https://你的服务地址/v1" autoComplete="off" onChange={() => setVerified(false)}/></Field>}
        <Field label="模型 ID"><input disabled={busy} value={model} required placeholder="填写服务商提供的模型 ID" onChange={e => { setModel(e.target.value); setVerified(false); }}/></Field>
        <Field label="API Key" hint="仅用于当前页面的连接，刷新后需重新填写。不会写入复盘记录。"><input disabled={busy} ref={keyInput} type="password" required autoComplete="off" onChange={() => setVerified(false)}/></Field>
        <Button variant="feature" type="submit" disabled={busy || !runtime}>{busy ? '正在验证连接…' : '验证并连接'}<ArrowRight size={16}/></Button>
      </form> : <div className="j-stack">
        <Field label="模型 ID"><input disabled={locked} list="oauth-model-options" value={model} placeholder="选择或填写授权后可用的模型 ID" onChange={e => { setModel(e.target.value); setVerified(false); }}/><datalist id="oauth-model-options">{models.map(item => <option key={item.id} value={item.id}>{item.name || item.id}</option>)}</datalist></Field>
        <p className="model-help"><ShieldCheck size={14}/> 授权在提供方页面完成，TradingReview 会在授权后验证模型连接。</p>
        {!runtime?.oauth && <p className="model-help">当前环境未开放订阅授权，可以使用模型 API 或示例体验。</p>}
        {oauth.status === 'connected' && <p className="model-help" role="status"><CheckCircle2 size={16}/>使用已保存授权。验证所选模型后即可连接。</p>}
        {oauth.status === 'checking' && runtime?.oauth && <p className="j-hint" role="status">正在读取授权状态…</p>}
        {oauth.status === 'unavailable' && <p className="model-error" role="alert">{oauth.message}</p>}
        {oauth.status === 'unavailable' ? <Button variant="feature" disabled={busy} onClick={readOAuthStatus}>重新检查授权</Button> : <Button variant="feature" disabled={!runtime?.oauth || locked} onClick={startOAuth}>{busy ? '正在处理…' : oauth.status === 'connected' ? '验证并连接' : '开始授权'}{oauth.status === 'connected' ? <KeyRound size={16}/> : <ArrowUpRight size={16}/>}</Button>}
        {oauth.status === 'connected' && <Button variant="ghost" disabled={busy} onClick={disconnectOAuth}>断开授权</Button>}
        {oauth.status === 'pending' && <div className="j-stack"><p className="j-hint">正在等待你完成授权。</p>{oauth.url && /^https?:\/\//.test(oauth.url) && <a className="j-link" href={oauth.url} target="_blank" rel="noopener noreferrer">打开授权页面<ArrowUpRight size={14}/></a>}<Button variant="ghost" disabled={busy} onClick={cancelOAuth}>取消授权</Button></div>}
      </div>}
      {verified && <div className="j-inline model-connection-status" role="status"><CheckCircle2 size={16}/>{state.model?.model} 已通过连接验证</div>}
      {state.model?.mode === 'live' && !verified && !busy && <p className="j-hint">请完成当前配置的连接验证后继续。</p>}
      {error && <p className="model-error" role="alert">{error}</p>}
    </div></div>
    <div className="j-footer"><span className="j-hint">交易内容在你发起 AI 处理时发送给所选模型。</span><Button disabled={!ready || busy} onClick={() => go(1)}>继续，添加交易<ArrowRight size={16}/></Button></div>
  </>;
}
