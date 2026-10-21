import test from 'node:test';
import assert from 'node:assert/strict';
import { createFinancialDefaults, resolveFinancialRequest } from '../server/financial-config.js';
import { createApi } from '../server/api.js';
import { handleFinancialQuery } from '../server/financial-sources.js';
import { createEvidenceTools } from '../server/evidence-retrieval.js';
import { MemoryStore } from '../server/storage.js';
import { sampleTrades } from '../src/domain.js';

const serverKey = 'financial-server-fixture-key';
const clientKey = 'financial-client-fixture-key';
const urlToken = 'financial-fixture-url-token';
const owner = () => `financial-owner-${crypto.randomUUID()}`;
const context = { trades: sampleTrades, contexts: {}, marketMode: 'import', origin: '测试' };
const defaults = identity => createFinancialDefaults({ FINANCIAL_OWNER_ID: identity, FUYAO_API_KEY: serverKey, IFIND_MCP_URL: `https://mcp.51ifind.com/mcp?token=${urlToken}` });
const request = (path, body) => new Request(`https://huikan.test${path}`, { method: body ? 'POST' : 'GET', headers: body ? { 'content-type': 'application/json' } : {}, ...(body ? { body: JSON.stringify(body) } : {}) });
const review = changes => ({ task: 'review', config: { provider: 'openai', auth: 'api', model: 'fixture', apiKey: 'model-fixture-key' }, context, text: '核对成交。', ...changes });
const json = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
const noSecrets = value => { const text = typeof value === 'string' ? value : JSON.stringify(value); for (const secret of [serverKey, clientKey, urlToken]) assert.equal(text.includes(secret), false); };

test('server default status separates configured from verified and never exposes credentials or token URLs', () => {
  const identity = owner(), config = defaults(identity);
  const status = config.publicStatus(identity);
  assert.equal(status.financialSources.fuyao, 'configured');
  assert.deepEqual(status.financialConnections.fuyao, { configured: true, status: 'configured', readOnlyToolCount: 0, mcpConfigured: true, barsConfigured: true, verifiedAt: null });
  assert.equal(config.select('fuyao', 'tools', identity).endpoint, 'https://fuyao.aicubes.cn/mcp/news');
  noSecrets(status); noSecrets(config);
  config.verified('fuyao', { readOnlyToolCount: 3 }, identity);
  assert.equal(config.publicStatus(identity).financialSources.fuyao, 'connected');
  assert.equal(config.publicStatus(identity).financialConnections.fuyao.readOnlyToolCount, 3);
  config.verified('fuyao', { readOnlyToolCount: 0 }, identity);
  assert.equal(config.publicStatus(identity).financialConnections.fuyao.status, 'unavailable');
  config.failed('fuyao', identity);
  assert.equal(config.publicStatus(identity).financialConnections.fuyao.status, 'error');
  config.verified('fuyao', { readOnlyToolCount: 1, transport: 'rest' }, identity);
  assert.equal(config.publicStatus(identity).financialConnections.fuyao.transport, 'rest');
  config.failed('fuyao', identity);
  assert.equal(config.publicStatus(identity).financialConnections.fuyao.transport, null);
  assert.equal(config.publicStatus(identity).financialConnections.fuyao.fallbackReason, null);
  noSecrets(config.publicStatus(identity));
});

test('server defaults require exact cloud owner binding and allow only local-owner locally', () => {
  const identity = owner(), config = defaults(identity);
  for (const other of [owner(), '', undefined]) {
    assert.equal(config.publicStatus(other).financialConnections.fuyao.configured, false);
    assert.equal(config.review(other), null);
    assert.throws(() => config.select('fuyao', 'tools', other), error => error.status === 403);
  }
  const unbound = createFinancialDefaults({ FUYAO_API_KEY: serverKey });
  assert.equal(unbound.publicStatus(identity).financialConnections.fuyao.configured, false);
  assert.equal(unbound.review(identity), null);
  assert.equal(unbound.select('fuyao', 'tools', 'local-owner', true).apiKey, serverKey);
  assert.throws(() => unbound.select('fuyao', 'tools', identity, true), error => error.status === 403);
});

test('invalid endpoint, header and malformed credentials fail closed without leaking their values', () => {
  for (const env of [{ FUYAO_API_KEY: `${serverKey}\n` }, { FUYAO_API_KEY: serverKey, FUYAO_MCP_URL: `https://attacker.test/${serverKey}` }, { IFIND_API_KEY: clientKey, IFIND_AUTH_HEADER: 'Cookie', IFIND_MCP_URL: 'https://mcp.51ifind.com/mcp' }]) {
    const config = createFinancialDefaults(env), status = config.publicStatus('local-owner', true);
    assert.equal(status.financialConnections[env.IFIND_API_KEY ? 'ifind' : 'fuyao'].status, 'invalid');
    assert.equal(config.review('local-owner', true), null);
    noSecrets(status);
  }
});

test('default credentials are selected as one block and cannot be combined with client endpoint overrides', () => {
  const identity = owner(), config = defaults(identity);
  for (const override of [{ endpoint: 'https://fuyao.aicubes.cn/mcp/a-share' }, { endpoint: undefined }, { apiKey: clientKey }, { authHeader: 'Authorization' }]) {
    assert.throws(() => resolveFinancialRequest({ provider: 'fuyao', kind: 'tools', useServerConfig: true, ...override }, config, identity), error => error.status === 400);
  }
  const bars = resolveFinancialRequest({ provider: 'fuyao', kind: 'bars', useServerConfig: true, symbol: '600519.SH', from: '2025-09-01', to: '2025-09-19', unexpected: 'discard' }, config, identity);
  assert.equal(bars.apiKey, serverKey); assert.equal(bars.endpoint, undefined); assert.equal(bars.unexpected, undefined);
  const client = { provider: 'fuyao', kind: 'tools', endpoint: 'https://fuyao.aicubes.cn/mcp/a-share', apiKey: clientKey };
  assert.deepEqual(resolveFinancialRequest(client, config, identity), client);
});

test('query routes verify server connections without leaking credentials and preserve verification across API instances', async () => {
  const identity = owner(), financialDefaults = defaults(identity); let captured;
  const financialQuery = async body => { captured = body; return { status: 'ok', tools: [], readOnlyToolCount: 2 }; };
  const api = createApi({ financialDefaults, financialQuery });
  const response = await api(request('/api/financial/query', { provider: 'fuyao', kind: 'tools', useServerConfig: true }), identity);
  assert.equal(response.status, 200); const result = await response.json();
  assert.equal(captured.apiKey, serverKey); assert.equal(captured.endpoint, 'https://fuyao.aicubes.cn/mcp/news');
  assert.equal(result.connection.status, 'connected'); noSecrets(result);
  const status = await (await createApi({ financialDefaults })(request('/api/status'), identity)).json();
  assert.equal(status.financialConnections.fuyao.status, 'connected'); noSecrets(status);
  const unauthorized = await api(request('/api/financial/query', { provider: 'fuyao', kind: 'tools', useServerConfig: true }), owner());
  assert.equal(unauthorized.status, 403); noSecrets(await unauthorized.text());
  const failed = createApi({ financialDefaults, financialQuery: async () => { throw Object.assign(new Error(serverKey), { status: 502 }); } });
  const failure = await failed(request('/api/financial/query', { provider: 'fuyao', kind: 'tools', useServerConfig: true }), identity);
  assert.equal(failure.status, 502); noSecrets(await failure.text());
  assert.equal(financialDefaults.publicStatus(identity).financialConnections.fuyao.status, 'error');
});

test('review resolves the marked or fallback server connection without persisting it, and never lends credentials to another owner', async () => {
  const identity = owner(), financialDefaults = defaults(identity), store = new MemoryStore(); const received = [];
  const api = createApi({ financialDefaults, store, runner: async args => { received.push(args.financialConfig); return { text: '复盘完成', facts: [], uncertainties: [] }; } });
  for (const financialConfig of [undefined, { provider: 'ifind', useServerConfig: true }, { provider: 'fuyao', endpoint: 'https://fuyao.aicubes.cn/mcp/a-share', apiKey: clientKey }]) {
    const response = await api(request('/api/agent/stream', review({ financialConfig })), identity);
    assert.equal(response.status, 200); noSecrets(await response.text());
  }
  assert.equal(received[0].apiKey, serverKey); assert.match(received[1].endpoint, /token=/); assert.equal(received[1].apiKey, undefined); assert.equal(received[2].apiKey, clientKey);
  const unauthorized = await api(request('/api/agent/stream', review({ financialConfig: { provider: 'fuyao', useServerConfig: true } })), owner());
  assert.equal(unauthorized.status, 403);
  const outsider = await api(request('/api/agent/stream', review()), owner());
  assert.equal(outsider.status, 200); await outsider.text(); assert.equal(received.at(-1), null);
  noSecrets([...store.runs.values()]);
});

test('local API fallback works without a cloud owner while status remains credential-free', async () => {
  const financialDefaults = createFinancialDefaults({ FUYAO_API_KEY: serverKey }); let captured;
  const api = createApi({ local: true, financialDefaults, financialQuery: async body => { captured = body; return { status: 'empty', bars: [] }; } });
  const status = await (await api(request('/api/status'))).json();
  assert.equal(status.financialConnections.fuyao.configured, true); noSecrets(status);
  const response = await api(request('/api/financial/query', { provider: 'fuyao', kind: 'bars', useServerConfig: true, symbol: '600519.SH', from: '2025-09-01', to: '2025-09-19' }));
  assert.equal(response.status, 200); assert.equal(captured.apiKey, serverKey); assert.equal(captured.endpoint, undefined);
});

test('tool discovery and Agent apply the same read-only/schema policy and expose only bounded annotations', async () => {
  const tools = [
    { name: 'search_news', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true, destructiveHint: false, customSecret: 'discarded' } },
    { name: 'search_without_annotation', inputSchema: { type: 'object' } },
    { name: 'search_destructive', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true, destructiveHint: true } },
    { name: 'place_order', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
    { name: 'search_refs', inputSchema: { type: 'object', $ref: 'external' }, annotations: { readOnlyHint: true } },
  ];
  const fetchImpl = async (_url, options) => {
    const rpc = JSON.parse(options.body);
    if (rpc.method === 'notifications/initialized') return new Response(null, { status: 202 });
    return json({ jsonrpc: '2.0', id: rpc.id, result: rpc.method === 'initialize' ? { protocolVersion: '2025-06-18' } : { tools } });
  };
  const config = { provider: 'fuyao', endpoint: 'https://fuyao.aicubes.cn/mcp/news', apiKey: serverKey };
  const result = await handleFinancialQuery({ ...config, kind: 'tools' }, { fetchImpl });
  const agent = await createEvidenceTools({ config, context, fetchImpl });
  try {
    assert.equal(result.readOnlyToolCount, 1); assert.equal(agent.tools.length, result.readOnlyToolCount);
    assert.deepEqual(result.tools[0].annotations, { readOnlyHint: true, destructiveHint: false });
    assert.equal(JSON.stringify(result).includes('customSecret'), false); noSecrets(result);
  } finally { await agent.close(); }
});
