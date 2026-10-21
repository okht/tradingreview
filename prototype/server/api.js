import { runAgent, AgentRunError } from './agent-runner.js';
import { createRuntime, ModelConfigError } from './model-runtime.js';
import { validateContext, validateImportInput, validateImportResult, validatePrepareTradeIds } from './contracts.js';
import { MemoryStore } from './storage.js';
import { handleFinancialQuery, recordManualEvidence } from './financial-sources.js';
import { fetchAccountTrades } from './account-source.js';
import { executeResearch } from './research-service.js';
import { validateResearch } from '../src/research-state.js';
import { createFinancialDefaults, resolveFinancialRequest, resolveReviewFinancialConfig } from './financial-config.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
class PublicError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
const failure = (message, status = 400) => new PublicError(message, status);
const providerHosts = new Set(['api.openai.com', 'api.anthropic.com', 'api.deepseek.com', 'openrouter.ai', 'api.siliconflow.cn', 'dashscope.aliyuncs.com', 'api.minimax.io']);
const active = new Map();
const rate = new Map();
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const BODY_BYTES = Symbol('bodyBytes');

function publicFailure(error) {
  if (error instanceof PublicError || error instanceof ModelConfigError) return json({ message: error.message }, error.status);
  const messages = {
    400: '提交的数据格式无效，请核对后重试',
    401: '连接认证未通过，请重新确认凭证和权限',
    403: '此请求未获允许，请检查服务地址和权限',
    409: '服务器记录已有更新，请重新载入后重试。当前本机内容已保留。',
    413: '提交的内容超过保存上限，请缩小范围后重试',
    422: '当前配置或材料不在支持范围，请调整后重试',
    429: '请求较频繁，请稍后重试',
    502: '外部服务未完成请求，请检查连接和权限后重试',
    504: '服务响应超时或请求已取消，请稍后重试',
  };
  if (Object.hasOwn(messages, error?.status)) return json({ message: messages[error.status] }, error.status);
  return json({ message: '服务暂时不可用，请稍后重试' }, 503);
}

function untilAborted(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) { Promise.resolve(promise).catch(() => {}); reject(signal.reason); return; }
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export async function readBody(request, { maxBytes = 1048576 } = {}) {
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw failure('请使用 JSON 请求', 415);
  const reader = request.body?.getReader();
  if (!reader) throw failure('请求内容为空');
  let bytes = 0; let text = ''; const decoder = new TextDecoder();
  while (true) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.length; if (bytes > maxBytes) { await reader.cancel(); throw failure(`请求内容超过 ${maxBytes / 1048576} MB`, 413); } text += decoder.decode(chunk.value, { stream: true }); }
  let body; try { body = JSON.parse(text + decoder.decode()); } catch { throw failure('JSON 格式无效'); }
  if (!object(body)) throw failure('JSON 请求需要使用对象格式');
  Object.defineProperty(body, BODY_BYTES, { value: bytes });
  return body;
}

export function validateModelConfig(input, { local = false, test = false } = {}) {
  if (!object(input) || !['openai', 'anthropic', 'openai-compatible'].includes(input.provider)) throw failure('请选择支持的模型服务商');
  if (input.auth !== undefined && !['api', 'oauth'].includes(input.auth)) throw failure('模型认证方式无效');
  if (typeof input.model !== 'string' || !input.model.trim() || input.model.length > 150 || /[\r\n\0]/.test(input.model)) throw failure('请填写有效的模型 ID');
  const config = { provider: input.provider, model: input.model.trim(), auth: input.auth === 'oauth' ? 'oauth' : 'api' };
  if (config.auth === 'oauth') {
    if (!local || config.provider !== 'openai' || input.baseUrl) throw failure('ChatGPT 订阅授权请在本地回看服务中连接', 422);
  } else {
    if (typeof input.apiKey !== 'string' || input.apiKey.trim().length < 6 || input.apiKey.length > 4096 || /[\r\n\0]/.test(input.apiKey)) throw failure('请重新填写 API Key，密钥只保留在当前页面内存中', 401);
    config.apiKey = input.apiKey.trim();
  }
  if (input.baseUrl) {
    let url; try { url = new URL(input.baseUrl); } catch { throw failure('接口地址无效'); }
    const loopbackTest = test && ['http:', 'https:'].includes(url.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    const matchingProvider = config.provider === 'openai-compatible' || url.hostname === (config.provider === 'openai' ? 'api.openai.com' : 'api.anthropic.com');
    if ((!loopbackTest && (url.protocol !== 'https:' || !providerHosts.has(url.hostname) || !matchingProvider || (url.port && url.port !== '443'))) || url.username || url.password || url.search || url.hash) throw failure('接口地址需使用对应服务商的 HTTPS 地址，暂不支持任意代理');
    config.baseUrl = url.href.replace(/\/$/, '');
  }
  return config;
}

function checkRate(owner) {
  const now = Date.now(); const times = (rate.get(owner) || []).filter(time => now - time < 60000);
  if (times.length >= 12) throw failure('请求较频繁，请一分钟后重试', 429);
  times.push(now); rate.set(owner, times);
  if (rate.size > 2000) for (const [key, value] of rate) if (!value.some(t => now - t < 60000)) rate.delete(key);
}

export function createApi({ store = new MemoryStore(), local = false, oauth = null, runner = runAgent, runtimeFactory = createRuntime, test = false, runTimeoutMs, connectTimeoutMs = 30000, accountHosts = [], financialQuery = handleFinancialQuery, financialDefaults = createFinancialDefaults(), manualEvidence = recordManualEvidence, accountPreview = fetchAccountTrades } = {}) {
  return async function api(request, identity) {
    try {
      const url = new URL(request.url);
      const owner = local ? 'local-owner' : identity;
      if (typeof owner !== 'string' || !owner.trim() || owner.length > 300) return json({ message: '请先登录后使用回看服务' }, 401);
      if (request.headers.get('origin') && request.headers.get('origin') !== url.origin) return json({ message: '不接受跨站请求' }, 403);
      if (request.headers.get('sec-fetch-site') === 'cross-site') return json({ message: '不接受跨站请求' }, 403);
      const path = url.pathname;
      if (path === '/api/status' && request.method === 'GET') return json({ runtime: local ? 'local' : 'cloud', oauth: Boolean(local && oauth), ...financialDefaults.publicStatus(owner, local), accountApiConfigured: accountHosts.length > 0, storage: local ? 'local-server' : 'cloud' });
      if (path === '/api/workspace') {
        if (request.method === 'GET') return json(await store.get(owner));
        if (request.method === 'PUT') { const body = await readBody(request); if (!Number.isInteger(body.revision) || body.revision < 0) throw failure('保存版本无效'); return json(await store.put(owner, body.state, body.revision)); }
      }
      if (path.startsWith('/api/runs/') && request.method === 'GET') {
        const id = path.slice('/api/runs/'.length);
        if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id)) return json({ message: '未找到这次分析' }, 404);
        const result = await store.getRun(owner, id); return result ? json(result) : json({ message: '未找到这次分析' }, 404);
      }
      if (path.startsWith('/api/oauth/')) {
        if (!local || !oauth) throw failure('在线版支持模型 API；订阅授权需要运行本地回看服务', 422);
        if (path === '/api/oauth/status' && request.method === 'GET') return json(oauth.status());
        if (path === '/api/oauth/start' && request.method === 'POST') { checkRate(owner); return json(await oauth.start()); }
        if (path === '/api/oauth/cancel' && request.method === 'POST') { await oauth.cancel(); return json(oauth.status()); }
        if (path === '/api/oauth/disconnect' && request.method === 'POST') { active.get(owner)?.abort(); await oauth.disconnect(); return json(oauth.status()); }
      }
      if (path === '/api/financial/query' && request.method === 'POST') {
        checkRate(owner);
        const body = await readBody(request);
        const query = resolveFinancialRequest(body, financialDefaults, owner, local);
        const verifying = body.useServerConfig === true && body.kind === 'tools';
        try {
          const result = await financialQuery(query, { signal: request.signal });
          return json(verifying ? { ...result, connection: financialDefaults.verified(body.provider, result, owner, local) } : result);
        } catch (error) { if (verifying) financialDefaults.failed(body.provider, owner, local); throw error; }
      }
      if (path === '/api/research' && request.method === 'POST') {
        checkRate(owner);
        return json(executeResearch(await readBody(request, { maxBytes: 4194304 })));
      }
      if (path === '/api/financial/evidence' && request.method === 'POST') {
        checkRate(owner);
        return json(await manualEvidence(await readBody(request)));
      }
      if (path === '/api/account-trades/preview' && request.method === 'POST') {
        checkRate(owner);
        if (!accountHosts.length) throw failure('账户接口尚未配置，请先使用 CSV 导入，或联系管理员配置允许域名。', 503);
        return json(await accountPreview(await readBody(request), { allowedHosts: accountHosts, signal: request.signal, test }));
      }
      if (path === '/api/models' && request.method === 'GET') {
        const provider = url.searchParams.get('provider') || 'openai';
        const auth = url.searchParams.get('auth') || 'api';
        if (!['openai', 'anthropic', 'openai-compatible'].includes(provider) || !['api', 'oauth'].includes(auth)) throw failure('模型服务或认证方式无效');
        if (auth === 'oauth' && (!local || provider !== 'openai')) throw failure('ChatGPT 订阅授权请在本地回看服务中连接', 422);
        if (provider === 'openai-compatible') return json({ models: [] });
        const { models, providerId } = runtimeFactory({ provider, auth }, { credentials: oauth?.credentials });
        const list = models.getModels(providerId);
        return json({ models: list.map(model => ({ id: model.id, name: model.name })) });
      }
      if (path === '/api/models/connect' && request.method === 'POST') {
        checkRate(owner); const body = await readBody(request); const config = validateModelConfig(body.config, { local, test });
        if (config.auth === 'oauth' && oauth?.status().status !== 'connected') throw failure('请先完成 ChatGPT 授权', 401);
        const { models, model } = runtimeFactory(config, { credentials: oauth?.credentials });
        let result;
        const connection = new AbortController();
        const connectionTimeout = setTimeout(() => connection.abort(), connectTimeoutMs);
        const connectionSignal = AbortSignal.any([request.signal, connection.signal]);
        try {
          connectionSignal.throwIfAborted();
          result = await untilAborted(models.completeSimple(model, { messages: [{ role: 'user', content: 'Reply OK.', timestamp: Date.now() }] }, { maxTokens: 32, signal: connectionSignal }), connectionSignal);
        } catch { throw failure('模型连接验证失败，请检查服务商、模型权限和密钥', 502); }
        finally { clearTimeout(connectionTimeout); }
        if (!result || ['error', 'aborted'].includes(result.stopReason)) throw failure('模型连接验证失败，请检查服务商、模型权限和密钥', 502);
        return json({ ok: true, model: model.id, provider: config.provider });
      }
      if (path === '/api/agent/stream' && request.method === 'POST') {
        checkRate(owner); const body = await readBody(request, { maxBytes: 4718592 });
        if (!['parse', 'background', 'prepare', 'review', 'import'].includes(body.task)) throw failure('未知任务');
        let images = [];
        if (body.task === 'import') {
          try { ({ text: body.text, images } = validateImportInput(body)); } catch (error) { throw failure(error.message); }
        } else {
          if (body[BODY_BYTES] > 1048576) throw failure('请求内容超过 1 MB', 413);
          if (body.images !== undefined && (!Array.isArray(body.images) || body.images.length)) throw failure('图片仅用于文件识别');
          if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 16000) throw failure('输入过长、为空或格式无效');
        }
        const config = validateModelConfig(body.config, { local, test });
        if (config.auth === 'oauth' && oauth?.status().status !== 'connected') throw failure('ChatGPT 授权尚未完成，请返回连接页面', 401);
        const context = ['parse', 'import'].includes(body.task) ? { trades: [], contexts: {}, marketMode: 'import', origin: body.task === 'import' ? '交易文件待确认' : '自然语言待确认' } : validateContext(body.context);
        let prepareTradeIds;
        try { prepareTradeIds = validatePrepareTradeIds(body.task, body.prepareTradeIds, context); }
        catch (error) { throw failure(error.message); }
        const financialConfig = ['review', 'prepare'].includes(body.task) ? resolveReviewFinancialConfig(body.financialConfig, financialDefaults, owner, local) : null;
        if (body.messages !== undefined && (!Array.isArray(body.messages) || body.messages.length > 100)) throw failure('对话格式无效');
        const messages = (body.messages || []).map(m => { if (!object(m) || !['user', 'assistant'].includes(m.role) || typeof m.text !== 'string' || m.text.length > 24000) throw failure('对话格式无效'); return { role: m.role, text: m.text.slice(0, 8000) }; }).slice(-12);
        if (JSON.stringify(messages).length > 32000) throw failure('对话记录过长，请缩小复盘范围');
        if (active.has(owner)) throw failure('上一项任务仍在运行，请先停止或等待完成', 409);
        const controller = new AbortController(); active.set(owner, controller);
        const signal = AbortSignal.any([controller.signal, request.signal]);
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          start(output) {
            let closed = false;
            const emit = (data, force = false) => { if (!closed && (force || !signal.aborted)) { try { output.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`)); } catch { closed = true; controller.abort(); } } };
            const heartbeat = setInterval(() => emit({ type: 'heartbeat' }), 15000);
            const timeout = setTimeout(() => controller.abort(), runTimeoutMs ?? (body.task === 'review' ? 180000 : 90000));
            heartbeat.unref?.(); timeout.unref?.();
            const cleanup = () => {
              clearInterval(heartbeat); clearTimeout(timeout); signal.removeEventListener('abort', aborted);
              if (active.get(owner) === controller) active.delete(owner);
              if (!closed) { closed = true; try { output.close(); } catch {} }
            };
            const aborted = () => { emit({ type: 'error', message: '本次生成已停止或超时，已有记录保留。' }, true); cleanup(); };
            signal.addEventListener('abort', aborted, { once: true });
            if (signal.aborted) { aborted(); return; }
            (async () => {
              try {
                emit({ type: 'status', text: body.task === 'import' ? '正在读取文件内容' : '正在准备本次复盘材料' });
                const response = await runner({ task: body.task, config, context, messages, text: body.text, images, signal, onEvent: emit, credentials: oauth?.credentials, financialConfig, research: body.task === 'review' ? validateResearch(body.research) : null, prepareTradeIds });
                signal.throwIfAborted();
                const result = body.task === 'import' ? validateImportResult(response) : response;
                // Original file text and image payloads remain transient, even after successful recognition.
                const question = body.task === 'import' ? `交易文件识别，文字 ${body.text.length} 字，图片 ${images.length} 张` : body.text;
                const run = { id: crypto.randomUUID(), task: body.task, createdAt: new Date().toISOString(), model: { provider: config.provider, id: config.model }, context, question, result, ...(prepareTradeIds ? { prepareTradeIds } : {}) };
                await store.saveRun(owner, run);
                emit({ type: 'result', result: { ...result, analysisRunId: run.id, createdAt: run.createdAt } });
              } catch (error) {
                // Upstream messages may contain request headers or provider bodies. Never echo them.
                const importError = body.task === 'import' && error instanceof AgentRunError ? error.message : null;
                const diagnostic = error instanceof AgentRunError ? error.diagnostic : undefined;
                const message = signal.aborted ? '本次生成已停止或超时，已有记录保留。' : importError || (body.task === 'import' ? '文件识别未完成，请重试或检查模型连接。已编辑的内容保留。' : '本次分析未通过验证或服务调用失败，请重试或检查连接。未生成复盘结论。');
                emit({ type: 'error', code: error instanceof AgentRunError ? error.code : 'ANALYSIS_FAILED', message: diagnostic && !signal.aborted ? `${message} 校验原因：${diagnostic.message}` : message, ...(diagnostic && !signal.aborted ? { diagnostic } : {}) });
              } finally { cleanup(); }
            })();
          },
          cancel() { controller.abort(); if (active.get(owner) === controller) active.delete(owner); },
        });
        return new Response(stream, { headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no', 'x-content-type-options': 'nosniff' } });
      }
      return json({ message: '接口不存在或请求方法不支持' }, 404);
    } catch (error) {
      return publicFailure(error);
    }
  };
}
