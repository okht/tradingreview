import test from 'node:test';
import assert from 'node:assert/strict';
import { sampleTrades } from '../src/domain.js';
import { handleFinancialQuery, normalizeFuyaoBars, filterFinancialBars, recordManualEvidence, validateFinancialEndpoint } from '../server/financial-sources.js';

const key = 'local-test-only-not-a-credential';
const now = () => new Date('2025-09-20T02:00:00.123Z');
const query = changes => ({ provider: 'fuyao', kind: 'bars', symbol: '600519.SH', from: '2025-09-01', to: '2025-09-19', apiKey: key, ...changes });
const bar = (day, changes = {}) => ({ date_ms: Date.parse(`${day}T00:00:00+08:00`), open_price: 40, high_price: 44, low_price: 39, close_price: 42, volume: 100, turnover: 4200, ...changes });
const payload = items => ({ code: 0, request_id: 'test-request', data: { timestamp: Date.parse('2025-09-19T15:00:00+08:00'), item: items } });
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const expectError = (fn, pattern) => assert.rejects(fn, error => error.status >= 400 && (!pattern || pattern.test(error.message)));

test('Fuyao calls only the documented historical REST path, header and unadjusted day schema', async () => {
  let captured;
  const result = await handleFinancialQuery(query(), { now, fetchImpl: async (url, options) => { captured = { url: new URL(url), options }; return json(payload([bar('2025-09-18'), bar('2025-09-17')])); } });
  assert.equal(captured.url.origin, 'https://fuyao.aicubes.cn');
  assert.equal(captured.url.pathname, '/api/a-share/prices/historical');
  assert.equal(captured.url.searchParams.get('thscode'), '600519.SH');
  assert.equal(captured.url.searchParams.get('interval'), '1d');
  assert.equal(captured.url.searchParams.get('adjust'), 'none');
  assert.equal(captured.url.searchParams.get('start'), String(Date.parse('2025-09-01T00:00:00+08:00')));
  assert.equal(captured.options.headers['X-api-key'], key);
  assert.equal(captured.options.redirect, 'error');
  assert.deepEqual(result.bars.map(value => value.time), ['2025-09-17', '2025-09-18']);
  assert.equal(result.bars[0].open, 40);
  assert.equal(result.bars[0].closedAt, '2025-09-18T00:00:00+08:00');
  assert.equal(result.observedAt, now().toISOString());
  assert.equal(result.dataTimestamp, payload([]).data.timestamp);
  assert.equal(result.status, 'ok');
  assert.equal(JSON.stringify(result).includes(key), false);
});

test('HTTP success with business failure never becomes available market data or reflects upstream messages', async () => {
  for (const [status, body] of [[401, { message: key }], [200, { code: 2003, message: key, data: null }], [200, { code: '0', data: { item: [] } }]]) {
    await assert.rejects(handleFinancialQuery(query(), { fetchImpl: async () => json(body, status) }), error => error.status === 502 && !error.message.includes(key));
  }
  await expectError(() => handleFinancialQuery(query(), { fetchImpl: async () => new Response('not json') }), /JSON/);
  await expectError(() => handleFinancialQuery(query(), { fetchImpl: async () => json({}, 429) }), /限流/);
});

test('malformed OHLC, duplicates, string numbers and absent envelope data fail without partial import', () => {
  for (const data of [payload([bar('2025-09-18', { high_price: 39 })]), payload([bar('2025-09-18', { low_price: 43 })]), payload([bar('2025-09-18', { close_price: '42' })]), payload([bar('2025-09-18', { date_ms: null })]), payload([bar('2025-09-18'), bar('2025-09-18')]), { code: 0, data: null }]) {
    assert.throws(() => normalizeFuyaoBars(data, { from: '2025-09-01', to: '2025-09-19' }), error => error.status === 502);
  }
  assert.deepEqual(normalizeFuyaoBars(payload([]), { from: '2025-09-01', to: '2025-09-19' }).bars, []);
});

test('decision filtering never reveals the current entire daily bar and uses China day rather than host timezone', async () => {
  const input = payload([bar('2025-09-17'), bar('2025-09-18'), bar('2025-09-19')]);
  const normalized = normalizeFuyaoBars(input, { from: '2025-09-01', to: '2025-09-19' });
  assert.deepEqual(filterFinancialBars(normalized.bars, '2025-09-18T14:30').map(item => item.time), ['2025-09-17']);
  assert.deepEqual(filterFinancialBars(normalized.bars, '2025-09-18T16:00:00Z').map(item => item.time), ['2025-09-17', '2025-09-18']);
  const result = await handleFinancialQuery(query({ decisionAt: '2025-09-18T10:00' }), { now, fetchImpl: async () => json(input) });
  assert.deepEqual(result.bars.map(item => item.time), ['2025-09-17']);
  const intraday = await handleFinancialQuery(query(), { now: () => new Date('2025-09-19T06:00:00Z'), fetchImpl: async () => json(input) });
  assert.deepEqual(intraday.bars.map(item => item.time), ['2025-09-17', '2025-09-18']);
  const empty = await handleFinancialQuery(query({ decisionAt: '2025-09-17T10:00' }), { now, fetchImpl: async () => json(input) });
  assert.equal(empty.status, 'empty');
});

test('symbols, dates, API keys and non-Fuyao bar providers are checked before any network access', async () => {
  let calls = 0; const options = { fetchImpl: async () => { calls++; return json(payload([])); } };
  for (const changes of [{ symbol: '600519' }, { symbol: '600519.SH,000001.SZ' }, { from: '2025-02-29' }, { from: '2025-09-20' }, { from: '2000-01-01' }, { apiKey: '' }, { apiKey: 'invalid\nheader' }, { provider: 'ifind' }, { endpoint: 'https://example.com/' }]) {
    await expectError(() => handleFinancialQuery(query(changes), options));
  }
  assert.equal(calls, 0);
});

test('official MCP URL validation rejects lookalike domains, non-HTTPS, credentials and redirects', async () => {
  for (const endpoint of ['http://mcp.51ifind.com/mcp', 'https://mcp.51ifind.com.evil.test/mcp', 'https://evil51ifind.com/mcp', 'https://user:pass@mcp.51ifind.com/mcp', 'https://mcp.51ifind.com:8443/mcp', 'https://127.0.0.1/mcp', 'https://mcp.51ifind.com/mcp#token']) {
    assert.throws(() => validateFinancialEndpoint(endpoint, 'ifind'), error => error.status === 400);
  }
  assert.equal(validateFinancialEndpoint('https://mcp.51ifind.com/official?token=opaque', 'ifind').hostname, 'mcp.51ifind.com');
  assert.throws(() => validateFinancialEndpoint('https://fuyao.aicubes.cn/mcp/a-share', 'ifind'));
  await expectError(() => handleFinancialQuery({ provider: 'ifind', kind: 'tools', endpoint: 'https://mcp.51ifind.com/official' }, { fetchImpl: async (_url, options) => { assert.equal(options.redirect, 'error'); throw new TypeError('redirect'); } }), /连接失败/);
});

test('HTTP MCP performs initialize, initialized, tools/list and session cleanup with no tool invocation', async () => {
  const requests = [];
  const result = await handleFinancialQuery({ provider: 'ifind', kind: 'tools', endpoint: 'https://mcp.51ifind.com/official-generated?token=secret-query', apiKey: `Bearer ${key}`, authHeader: 'Authorization' }, { now, fetchImpl: async (_url, options) => {
    const request = options.body ? JSON.parse(options.body) : { method: 'DELETE' }; requests.push(request);
    assert.equal(options.headers.Authorization, `Bearer ${key}`);
    if (request.method === 'initialize') return json({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } } }, 200, { 'Mcp-Session-Id': 'session-test' });
    assert.equal(options.headers['Mcp-Session-Id'], 'session-test');
    if (request.method === 'notifications/initialized') return new Response(null, { status: 202 });
    if (request.method === 'DELETE') return new Response(null, { status: 204 });
    assert.equal(options.headers['MCP-Protocol-Version'], '2025-06-18');
    return json({ jsonrpc: '2.0', id: request.id, result: { tools: [{ name: 'query_announcements', description: 'Fixture schema only', inputSchema: { type: 'object', properties: {} } }] } });
  } });
  assert.deepEqual(requests.map(item => item.method), ['initialize', 'notifications/initialized', 'tools/list', 'DELETE']);
  assert.equal(result.tools[0].name, 'query_announcements');
  assert.equal(result.endpointOrigin, 'https://mcp.51ifind.com');
  assert.equal(JSON.stringify(result).includes('secret-query'), false);
  assert.equal(JSON.stringify(result).includes(key), false);
  assert.match(result.limitation, /未调用/);
});

test('MCP SSE response is matched by id, handles split CRLF and ignores unrelated notifications', async () => {
  const encoder = new TextEncoder();
  const result = await handleFinancialQuery({ provider: 'fuyao', kind: 'tools', endpoint: 'https://fuyao.aicubes.cn/mcp/a-share', apiKey: key }, { now, fetchImpl: async (_url, options) => {
    const request = JSON.parse(options.body);
    if (request.method === 'notifications/initialized') return new Response(null, { status: 202 });
    const value = request.method === 'initialize' ? { protocolVersion: '2025-06-18' } : { tools: [] };
    const data = `event: message\r\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\r\n\r\nevent: message\r\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: value })}\r\n\r\n`;
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(encoder.encode(data.slice(0, 19))); controller.enqueue(encoder.encode(data.slice(19, 76))); controller.enqueue(encoder.encode(data.slice(76))); controller.close(); } }), { headers: { 'Content-Type': 'text/event-stream' } });
  } });
  assert.equal(result.status, 'empty');
  assert.deepEqual(result.tools, []);
});

test('MCP protocol errors, unsupported transports and malformed schemas stay explicit failures', async () => {
  for (const initializeResult of [{ jsonrpc: '2.0', id: 1, error: { message: key } }, { jsonrpc: '2.0', id: 1, result: { protocolVersion: 'unsupported' } }, { jsonrpc: '2.0', id: 999, result: {} }]) {
    await assert.rejects(handleFinancialQuery({ provider: 'ifind', kind: 'tools', endpoint: 'https://mcp.51ifind.com/official' }, { fetchImpl: async () => json(initializeResult) }), error => error.status >= 400 && !error.message.includes(key));
  }
  await expectError(() => handleFinancialQuery({ provider: 'ifind', kind: 'tools', endpoint: 'https://mcp.51ifind.com/official', apiKey: key }, { fetchImpl: async () => assert.fail('missing auth field must fail before fetch') }), /鉴权/);
});

test('pre-aborted requests stop before calling the data provider', async () => {
  const controller = new AbortController(); controller.abort(new Error('stop'));
  await assert.rejects(handleFinancialQuery(query(), { signal: controller.signal, fetchImpl: async () => assert.fail('must not fetch') }), /stop/);
});

test('manual evidence uses server receipt time/id while preserving unknown publication time and original source', () => {
  const input = { trades: sampleTrades, event: { tradeId: 'DEMO-02', id: 'forged-id', title: '订单公告', text: '用户粘贴的公告原文', source: '公司网站', publishedAt: null, recordedAt: '2001-01-01T00:00', url: 'https://example.com/announcement' } };
  const result = recordManualEvidence(input, { now, randomUUID: () => 'server-uuid' });
  assert.equal(result.evidence.id, 'server-uuid');
  assert.equal(result.evidence.recordedAt, '2025-09-20T02:00Z');
  assert.equal(result.evidence.publishedAt, null);
  assert.equal(result.evidence.source, '用户录入：公司网站');
  assert.equal(result.evidence.text, input.event.text);
  assert.equal(input.event.recordedAt, '2001-01-01T00:00');
  for (const changes of [{ tradeId: 'UNKNOWN' }, { publishedAt: '2025-02-29T10:00' }, { url: 'javascript:alert(1)' }, { source: '' }]) {
    assert.throws(() => recordManualEvidence({ ...input, event: { ...input.event, ...changes } }, { now }), error => error.status === 400);
  }
});
