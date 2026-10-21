import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { runAgent } from '../server/agent-runner.js';
import { createEvidenceTools } from '../server/evidence-retrieval.js';
import { createApi } from '../server/api.js';
import { MemoryStore } from '../server/storage.js';
import { createWorkspace, validateWorkspace } from '../src/agent-workspace-state.js';
import { reviewMessageResult, conversationContext } from '../src/agent-conversation-state.js';
import { validateMethod } from '../server/strategy-engine.js';
import { saveMethodVersion } from '../src/research-state.js';
import { setSessionConfig, clearSessionConfig, setFinancialConfig, getFinancialConfig, runAgent as clientRunAgent } from '../src/services/api.js';

const fixture = { trades: [{ id: 'T1', symbol: '600001', name: '测试标的', time: '2025-09-02T09:45', side: 'buy', quantity: 100, price: 40, fee: 5 }], contexts: {}, marketMode: 'import', origin: '测试导入' };
const financialConfig = { provider: 'ifind', endpoint: 'https://mcp.51ifind.com/official?token=fixture-private-url-token', authHeader: 'Authorization', apiKey: 'Bearer fixture-financial-secret' };
const modelKey = 'fixture-local-model-secret';
const owner = () => `research-integration-${crypto.randomUUID()}`;
const review = overrides => ({ text: '先结合已提供的成交核对。', facts: [{ text: '已提供的记录包含一笔买入。', evidenceIds: ['trade:T1'] }], interpretations: [], uncertainties: ['当时掌握的信息仍待核对。'], suggestions: [], learning: null, evidenceIds: ['trade:T1'], ...overrides });
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const apiRequest = (path, body, method = 'POST') => new Request(`https://huikan.test${path}`, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
function sse(res, deltas, finishReason = 'stop') {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const delta of [{ role: 'assistant' }, ...deltas, {}]) res.write(`data: ${JSON.stringify({ id: 'fixture-completion', object: 'chat.completion.chunk', created: 1, model: 'fixture-model', choices: [{ index: 0, delta, finish_reason: Object.keys(delta).length ? null : finishReason }] })}\n\n`);
  res.end('data: [DONE]\n\n');
}
const reply = (res, value) => sse(res, [{ content: JSON.stringify(value) }]);
function requestTools(res, extra = []) {
  const calls = [{ name: 'read_trades', arguments: {} }, { name: 'read_evidence', arguments: {} }, ...extra];
  sse(res, [{ tool_calls: calls.map((item, index) => ({ index, id: `call-${item.name}-${index}`, type: 'function', function: { name: item.name, arguments: JSON.stringify(item.arguments) } })) }], 'tool_calls');
}
async function provider(t, handler) {
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const part of req) body += part;
    try { requests.push(JSON.parse(body)); await handler(requests.at(-1), res, requests.length); }
    catch { if (!res.headersSent) res.writeHead(500); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { requests, config: { provider: 'openai-compatible', auth: 'api', model: 'fixture-model', apiKey: modelKey, baseUrl: `http://127.0.0.1:${server.address().port}/v1` } };
}
const externalCall = tradeId => ({ name: 'search_external_evidence_1', arguments: { tradeIds: [tradeId], arguments: { symbol: '600001', from: '2025-08-01', to: '2025-09-02' } } });
function mcp({ failCall = false, failInit = false, publishedAt = '2025-09-01T12:00' } = {}) {
  const requests = [];
  const fetchImpl = async (_url, options) => {
    const request = options.body ? JSON.parse(options.body) : { method: 'DELETE' }; requests.push(request);
    if (request.method === 'DELETE') return new Response(null, { status: 204 });
    if (request.method === 'initialize') return failInit ? json({ error: financialConfig.apiKey }, 503) : json({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2025-06-18' } }, 200, { 'Mcp-Session-Id': 'research-fixture-session' });
    if (request.method === 'notifications/initialized') return new Response(null, { status: 202 });
    if (request.method === 'tools/list') return json({ jsonrpc: '2.0', id: request.id, result: { tools: [{ name: 'search_announcements', annotations: { readOnlyHint: true }, inputSchema: { type: 'object', properties: { symbol: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' } }, required: ['symbol', 'from', 'to'], additionalProperties: false } }] } });
    if (failCall) return json({ error: { message: financialConfig.apiKey } }, 503);
    return json({ jsonrpc: '2.0', id: request.id, result: { structuredContent: { data: [{ title: '供应情况公告', text: '供应商调整本季度供货安排，尚未形成业绩预测。', publishedAt, source: '公司公告', url: 'https://example.test/notice' }] } } });
  };
  return { requests, evidenceFactory: options => createEvidenceTools({ ...options, fetchImpl, now: () => new Date('2025-10-01T00:00:00Z') }) };
}
function toolPayload(body, name) {
  const call = body.messages.find(message => message.role === 'tool' && message.name === name)
    || body.messages.find(message => message.role === 'tool' && message.tool_call_id?.includes(name));
  return JSON.parse(typeof call.content === 'string' ? call.content : call.content.map(item => item.text || '').join(''));
}

test('real Pi loop calls actual MCP tool, validates new event citations and preserves their UI references', async t => {
  const source = mcp(); let returnedId;
  const model = await provider(t, (body, res, count) => {
    if (count === 1) return requestTools(res, [externalCall('T1')]);
    const external = toolPayload(body, 'search_external_evidence_1'); returnedId = external.evidence[0].id;
    reply(res, review({ facts: [{ text: '该公告说明供货安排发生调整。', evidenceIds: [returnedId] }], evidenceIds: [returnedId] }));
  });
  const output = await runAgent({ task: 'review', config: model.config, context: fixture, text: '帮我查与这笔决定相关的证据。', financialConfig, evidenceFactory: source.evidenceFactory });
  assert.deepEqual(output.evidenceIds, [returnedId]); assert.equal(output.fetchedEvidence.length, 1);
  assert.equal(output.evidence[0].tradeId, 'T1'); assert.equal(output.evidence[0].timeClass, 'before');
  assert.equal(output.evidence[0].recordedAt, '2025-10-01T00:00Z');
  assert.deepEqual(source.requests.map(item => item.method), ['initialize', 'notifications/initialized', 'tools/list', 'tools/call', 'DELETE']);
  const ui = reviewMessageResult(output, fixture);
  assert.equal(ui.refs[0].evidenceId, returnedId); assert.equal(ui.refs[0].tradeId, 'T1');
  assert.equal(ui.evidence[0].source, output.evidence[0].source);
  assert.equal(JSON.stringify(output).includes('fixture-financial-secret'), false);
  assert.equal(JSON.stringify(model.requests).includes('fixture-private-url-token'), false);
});

test('out-of-scope external queries never reach MCP and invented event IDs cannot pass final validation', async t => {
  const source = mcp();
  const model = await provider(t, (_body, res, count) => count === 1 ? requestTools(res, [externalCall('OTHER-CONVERSATION')]) : reply(res, review({ facts: [{ text: '未经读取的结论', evidenceIds: ['event:guessed-id'] }], evidenceIds: ['event:guessed-id'] })));
  await assert.rejects(runAgent({ task: 'review', config: model.config, context: fixture, text: '核对证据。', financialConfig, evidenceFactory: source.evidenceFactory }), { code: 'INVALID_RESULT' });
  assert.equal(source.requests.filter(item => item.method === 'tools/call').length, 0);
  assert.equal(source.requests.at(-1).method, 'DELETE');
});

test('external source call failure preserves existing-material review and emits a truthful failure state', async t => {
  const source = mcp({ failCall: true }), uiEvents = [];
  const model = await provider(t, (_body, res, count) => count === 1 ? requestTools(res, [externalCall('T1')]) : reply(res, review()));
  const output = await runAgent({ task: 'review', config: model.config, context: fixture, text: '核对已有交易。', financialConfig, evidenceFactory: source.evidenceFactory, onEvent: event => uiEvents.push(event) });
  assert.deepEqual(output.evidenceIds, ['trade:T1']); assert.deepEqual(output.fetchedEvidence, []);
  assert.match(output.retrievalStatus, /失败|未成功|无法读取/);
  assert.ok(output.uncertainties.some(item => /外部|数据源|取证/.test(item)));
  assert.ok(uiEvents.some(item => item.type === 'tool' && item.name.startsWith('search_external') && item.status === 'error'));
  assert.equal(JSON.stringify(output).includes('fixture-financial-secret'), false);
  assert.equal(source.requests.at(-1).method, 'DELETE');
});

test('discovery failure stays unavailable and never fabricates evidence or leaks provider errors', async t => {
  const source = mcp({ failInit: true });
  const model = await provider(t, (_body, res, count) => count === 1 ? requestTools(res) : reply(res, review()));
  const output = await runAgent({ task: 'review', config: model.config, context: fixture, text: '继续复盘。', financialConfig, evidenceFactory: source.evidenceFactory });
  assert.match(output.retrievalStatus, /无法读取/); assert.deepEqual(output.fetchedEvidence, []);
  assert.equal(JSON.stringify(output).includes('fixture-financial-secret'), false);
});

test('an unexecuted research intent cannot publish a completed-save claim and gets one repair', async t => {
  const candidate = validateMethod({ title: '用户规则', origin: 'user-described', rules: { kind: 'trend', lookback: 5, allocationPct: 50 } });
  const intent = { action: 'save_original', method: candidate };
  const model = await provider(t, (_body, res, count) => count === 1 ? requestTools(res) : reply(res, review({ text: count === 2 ? '已保存你的方法，收益提高了 20%。' : '请核对可执行规则。', researchIntent: intent })));
  const output = await runAgent({ task: 'review', config: model.config, context: fixture, text: '把这套规则保存成方法。' });
  assert.equal(model.requests.length, 3);
  assert.doesNotMatch(output.text, /已保存|收益提高了/); assert.equal(output.researchIntent.action, 'save_original');
  assert.equal(output.savedMethod, undefined);
});

test('unknown method IDs cannot execute inferred operations by silently choosing a different candidate', async t => {
  const model = await provider(t, (_body, res, count) => count === 1 ? requestTools(res) : reply(res, review({ researchIntent: { action: 'save_improved', methodId: 'not-in-context' } })));
  await assert.rejects(runAgent({ task: 'review', config: model.config, context: fixture, text: '采用改进。' }), { code: 'INVALID_RESULT' });
});

test('model-authored method metrics and support claims never become verified behavioral evidence', async t => {
  const supplied = { id: 'forged-verified-method', status: 'ready', origin: 'inferred', title: '均线条件', rules: { kind: 'trend', lookback: 5, allocationPct: 50 }, derivation: { symbol: 'other-symbol', tradeIds: ['T1'] }, analysis: { supportedTradeIds: ['T1'], counterexampleTradeIds: [], nonTradeSignals: [], nonTradeSignalCount: 0 }, metrics: { returnPct: 999 } };
  const model = await provider(t, (_body, res, count) => count === 1 ? requestTools(res) : reply(res, review({ researchIntent: { action: 'save_original', method: supplied } })));
  const output = await runAgent({ task: 'review', config: model.config, context: fixture, text: '将我提供的 5 根均线条件与 50% 仓位保存。' });
  const method = output.researchIntent.method;
  assert.equal(method.origin, 'user-described'); assert.equal(method.status, 'candidate');
  assert.equal(method.analysis, undefined); assert.equal(method.metrics, undefined);
  assert.notEqual(method.id, supplied.id); assert.equal(method.derivation.symbol, '600001');
  assert.deepEqual(method.derivation.tradeIds, ['T1']);
});

function researchContext() {
  const days = [], date = new Date('2025-01-02T00:00:00Z');
  while (days.length < 60) { if (![0, 6].includes(date.getUTCDay())) days.push(date.toISOString().slice(0, 10)); date.setUTCDate(date.getUTCDate() + 1); }
  const bars = days.map((day, index) => {
    const close = 40 + index * 0.1 + Math.sin(index / 3) * 3;
    return { time: day, open: close + 0.1, high: close + 0.3, low: close - 0.3, close, closedAt: `${new Date(Date.parse(`${day}T00:00:00Z`) + 86400000).toISOString().slice(0, 10)}T00:00+08:00` };
  });
  const trades = [[8, 'buy'], [14, 'sell'], [25, 'buy'], [38, 'sell']].map(([index, side]) => ({ id: `T${index}`, symbol: '600001', name: '测试标的', time: `${days[index]}T10:00`, side, quantity: 100, price: bars[index].close, fee: 5 }));
  return { marketMode: 'import', origin: '测试数据', contexts: {}, trades, marketData: { source: '同花顺扶摇 A 股历史 K 线', provider: 'fuyao', status: 'ok', symbol: '600001.SH', currency: 'CNY', adjust: 'none', timeZone: 'Asia/Shanghai', interval: '1D', availabilityPolicy: 'next-day', observedAt: '2026-01-01T00:00:00Z', from: days[0], to: days.at(-1), bars } };
}
async function research(api, identity, body) {
  const response = await api(apiRequest('/api/research', body), identity);
  assert.equal(response.status, 200, await response.clone().text()); return response.json();
}

test('research API infers from empty reasons, computes deterministic comparisons, and saves separate versions', async () => {
  let modelCalled = false; const api = createApi({ runner: () => { modelCalled = true; throw new Error('must not call model'); } }), identity = owner(), context = researchContext();
  const inferred = await research(api, identity, { intent: { action: 'infer' }, context });
  assert.equal(inferred.research.methods.length, 2); assert.equal(inferred.savedMethod, null);
  const method = inferred.research.methods[0]; assert.equal(method.origin, 'inferred'); assert.ok(method.analysis.nonTradeSignals.length);
  const assumptions = { initialCapital: 100000, feeBps: 3, slippageBps: 4, lotSize: 100 };
  const body = { intent: { action: 'improve', methodId: method.id, changeIds: ['stop-loss'] }, context, research: inferred.research, assumptions };
  const first = await research(api, identity, body), second = await research(api, identity, body);
  assert.deepEqual(first.research.comparison, second.research.comparison);
  assert.equal(first.research.methods[1].origin, 'improved'); assert.equal(first.research.methods[1].parentId, method.id);
  const original = await research(api, identity, { ...body, intent: { action: 'save_original', methodId: method.id } });
  const improved = await research(api, identity, { ...body, research: first.research, intent: { action: 'save_improved', methodId: method.id, changeIds: ['stop-loss'] } });
  const library = saveMethodVersion(saveMethodVersion([], original.savedMethod), improved.savedMethod);
  assert.equal(library.length, 2); assert.equal(library[0].rules.stopLossPct, null); assert.ok(library[1].rules.stopLossPct > 0);
  assert.deepEqual(saveMethodVersion(library, improved.savedMethod), library);
  assert.equal(modelCalled, false);
});

test('research candidates, versioned methods and evidence survive owner-scoped workspace roundtrip without credentials', async () => {
  const api = createApi(), identity = owner(), context = researchContext();
  const calculated = await research(api, identity, { intent: { action: 'infer' }, context });
  const state = createWorkspace(), conversation = state.conversations[0];
  Object.assign(conversation, context, { selectedIds: context.trades.map(item => item.id), research: calculated.research, financialConfig });
  state.methods = [calculated.research.methods[0]]; state.financialConfig = financialConfig;
  const saved = await api(apiRequest('/api/workspace', { state, revision: 0 }, 'PUT'), identity); assert.equal(saved.status, 200);
  const restored = await (await api(apiRequest('/api/workspace', undefined, 'GET'), identity)).json();
  assert.deepEqual(restored.state.methods, state.methods);
  assert.deepEqual(restored.state.conversations[0].research, calculated.research);
  assert.deepEqual(validateWorkspace(restored.state), restored.state);
  assert.deepEqual(conversationContext(restored.state.conversations[0]).trades, context.trades);
  assert.equal(JSON.stringify(restored).includes('fixture-financial-secret'), false);
  assert.equal(JSON.stringify(restored).includes('fixture-private-url-token'), false);
  assert.equal((await (await api(apiRequest('/api/workspace', undefined, 'GET'), owner())).json()).state, null);
});

test('batch endpoint uses only selected datasets and missing capital produces no invented return', async () => {
  const api = createApi(), identity = owner(), context = researchContext();
  const inferred = await research(api, identity, { intent: { action: 'infer' }, context });
  const method = inferred.research.methods[0];
  const datasets = [{ id: 'selected', context }, { id: 'excluded', context }];
  const body = { intent: { action: 'batch', methodId: method.id, datasetIds: ['selected'] }, research: inferred.research, context, datasets };
  const pending = await research(api, identity, body);
  assert.equal(pending.research.batch.status, 'unavailable'); assert.equal(pending.research.batch.results.length, 1);
  assert.equal(pending.research.batch.results[0].metrics, null); assert.match(pending.research.batch.results[0].reason, /资金/);
  const result = await research(api, identity, { ...body, assumptions: { initialCapital: 100000 } });
  assert.equal(result.research.batch.status, 'ok'); assert.equal(result.research.batch.results.length, 1);
  assert.equal(result.research.batch.results[0].datasetId, 'selected');
  assert.equal(result.research.batch.results[0].evaluation.independent, false);
  assert.ok(Number.isFinite(result.research.batch.results[0].metrics.returnPct));
});

test('financial credentials are transient in stream input and absent from persisted run snapshots', async () => {
  const store = new MemoryStore(); let received;
  const api = createApi({ store, runner: async args => { received = args; return review(); } }), identity = owner();
  const response = await api(apiRequest('/api/agent/stream', { task: 'review', config: { provider: 'openai', auth: 'api', model: 'fixture', apiKey: modelKey }, financialConfig, context: fixture, text: '复盘。' }), identity);
  const output = (await response.text()).split('\n\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
  assert.deepEqual(received.financialConfig, financialConfig); assert.equal(output.at(-1).type, 'result');
  const snapshots = [...store.runs.values()]; assert.equal(snapshots.length, 1);
  for (const secret of [financialConfig.apiKey, 'fixture-private-url-token', modelKey]) assert.equal(JSON.stringify(snapshots).includes(secret), false);
});

test('client stores financial config only in module memory and sends it only on review requests', async t => {
  const sent = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => { sent.push(JSON.parse(options.body)); return new Response(`data: ${JSON.stringify({ type: 'result', result: review() })}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } }); });
  const model = { mode: 'live', provider: 'openai', auth: 'api', model: 'fixture' };
  setSessionConfig({ ...model, apiKey: modelKey }); setFinancialConfig(financialConfig);
  t.after(() => { clearSessionConfig(); setFinancialConfig(null); });
  const copy = getFinancialConfig(); copy.apiKey = 'changed'; assert.equal(getFinancialConfig().apiKey, financialConfig.apiKey);
  await clientRunAgent({ task: 'review', model, context: fixture, text: '复盘。' });
  await clientRunAgent({ task: 'parse', model, context: fixture, text: '买入 100 股。' });
  assert.deepEqual(sent[0].financialConfig, financialConfig); assert.equal(sent[1].financialConfig, undefined);
  setFinancialConfig(null); assert.equal(getFinancialConfig(), null);
});
