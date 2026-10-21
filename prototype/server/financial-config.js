import { validateFinancialEndpoint } from './financial-sources.js';

const providers = ['fuyao', 'ifind'];
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const emptyState = () => ({ configured: false, status: 'unconfigured', readOnlyToolCount: 0, mcpConfigured: false, barsConfigured: false, verifiedAt: null });
function value(raw, limit = 4096) {
  if (raw === undefined || raw === null || raw === '') return '';
  if (typeof raw !== 'string' || raw.length > limit || /[\r\n\0]/.test(raw)) throw new Error('Invalid financial configuration');
  return raw.trim();
}

/** Server-only credentials stay inside this closure; public metadata contains
 * neither endpoint URLs (which may contain tokens) nor authentication values. */
export function createFinancialDefaults(env = {}) {
  let ownerId = '';
  try { ownerId = value(env.FINANCIAL_OWNER_ID, 300); } catch { /* Fail closed. */ }
  const configs = {}, states = {};
  for (const provider of providers) {
    states[provider] = emptyState();
    try {
      const apiKey = value(provider === 'fuyao' ? env.FUYAO_API_KEY : env.IFIND_API_KEY);
      const rawEndpoint = value(provider === 'fuyao' ? env.FUYAO_MCP_URL : env.IFIND_MCP_URL);
      const endpoint = rawEndpoint || (provider === 'fuyao' && apiKey ? 'https://fuyao.aicubes.cn/mcp/news' : '');
      const authHeader = provider === 'fuyao' ? 'X-api-key' : value(env.IFIND_AUTH_HEADER, 50);
      if (apiKey && !['X-api-key', 'Authorization'].includes(authHeader)) throw new Error('Invalid financial authentication');
      if (endpoint) validateFinancialEndpoint(endpoint, provider);
      if (apiKey || endpoint) {
        configs[provider] = Object.freeze({ provider, ...(endpoint ? { endpoint } : {}), ...(apiKey ? { apiKey, authHeader } : {}) });
        states[provider] = { ...emptyState(), configured: true, status: 'configured', mcpConfigured: Boolean(endpoint), barsConfigured: provider === 'fuyao' && Boolean(apiKey) };
      }
    } catch { states[provider] = { ...emptyState(), status: 'invalid' }; }
  }
  const allowed = (owner, local) => local ? owner === 'local-owner' : Boolean(ownerId && owner === ownerId);
  function check(owner, local) { if (!allowed(owner, local)) fail('当前用户未获服务端金融连接授权。', 403); }
  function connection(provider, owner, local) { return { ...(allowed(owner, local) ? states[provider] : emptyState()) }; }
  return Object.freeze({
    publicStatus(owner, local = false) {
      const financialConnections = Object.fromEntries(providers.map(provider => [provider, connection(provider, owner, local)]));
      const financialSources = Object.fromEntries(providers.map(provider => [provider, financialConnections[provider].status === 'connected' ? 'connected' : financialConnections[provider].configured ? 'configured' : 'unconfigured']));
      return { financialSources, financialConnections };
    },
    select(provider, kind, owner, local = false) {
      check(owner, local);
      if (!providers.includes(provider) || !['bars', 'tools', 'review'].includes(kind)) fail('请选择已支持的金融连接。');
      const config = configs[provider];
      if (!config || (kind === 'bars' ? !states[provider].barsConfigured : !config.endpoint)) fail('服务端尚未配置所需金融连接。', 422);
      return kind === 'bars' ? { provider, apiKey: config.apiKey } : { ...config };
    },
    review(owner, local = false) {
      if (!allowed(owner, local)) return null;
      const provider = providers.find(item => configs[item]?.endpoint && states[item].status === 'connected') || providers.find(item => configs[item]?.endpoint);
      return provider ? { ...configs[provider] } : null;
    },
    verified(provider, result, owner, local = false) {
      check(owner, local);
      if (!states[provider]?.configured) fail('服务端尚未配置所需金融连接。', 422);
      const readOnlyToolCount = Number.isInteger(result?.readOnlyToolCount) ? Math.max(0, Math.min(32, result.readOnlyToolCount)) : 0;
      states[provider] = { ...states[provider], status: readOnlyToolCount ? 'connected' : 'unavailable', readOnlyToolCount, verifiedAt: new Date().toISOString(),
        transport: result?.transport === 'rest' ? 'rest' : 'mcp', ...(result?.transport === 'rest' ? { fallbackReason: '扶摇资讯 MCP 暂不可用，已通过官方资讯 REST 接口连接。' } : { fallbackReason: null }) };
      return connection(provider, owner, local);
    },
    failed(provider, owner, local = false) {
      if (allowed(owner, local) && states[provider]?.configured) states[provider] = { ...states[provider], status: 'error', readOnlyToolCount: 0, verifiedAt: null, transport: null, fallbackReason: null };
    },
  });
}

export function resolveFinancialRequest(body, defaults, owner, local) {
  if (body.useServerConfig !== true) return body;
  if (['endpoint', 'apiKey', 'authHeader'].some(key => Object.hasOwn(body, key))) fail('服务端连接不能同时填写其他地址或鉴权值。');
  const config = defaults.select(body.provider, body.kind, owner, local);
  // Copy query parameters only. Client objects can never override the selected
  // server credential, header or endpoint, even with future adapter fields.
  return { ...Object.fromEntries(['kind', 'symbol', 'from', 'to', 'decisionAt'].filter(key => body[key] !== undefined).map(key => [key, body[key]])), ...config };
}

export function resolveReviewFinancialConfig(input, defaults, owner, local) {
  if (input == null) return defaults.review(owner, local);
  if (input?.useServerConfig !== true) return input;
  return resolveFinancialRequest({ ...input, kind: 'review' }, defaults, owner, local);
}
