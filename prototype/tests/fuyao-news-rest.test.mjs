import test from 'node:test';
import assert from 'node:assert/strict';
import { handleFinancialQuery } from '../server/financial-sources.js';
import { createEvidenceTools, normalizeExternalEvidence } from '../server/evidence-retrieval.js';
import { fetchFuyaoStockNews } from '../server/fuyao-news-rest.js';

const key = 'fixture-fuyao-news-key';
const config = { provider: 'fuyao', endpoint: 'https://fuyao.aicubes.cn/mcp/news', apiKey: key, authHeader: 'X-api-key' };
const trade = { id: 'T1', symbol: '600519.SH', name: '贵州茅台', time: '2025-09-02T09:45', side: 'buy', quantity: 100, price: 1500, fee: 5 };
const context = { trades: [trade], contexts: {}, marketMode: 'import' };
const news = (time, overrides = {}) => ({ title: '资讯标题', summary: '服务返回的摘要', publish_time_ms: Date.parse(time), source: '公开来源', jump_url: 'https://example.test/article', ...overrides });
const json = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
function transport(items = [news('2025-09-01T10:00:00+08:00')]) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const parsed = new URL(url); calls.push({ url: parsed, options });
    if (options.method === 'POST') return new Response('not available', { status: 405 });
    assert.equal(parsed.origin, 'https://fuyao.aicubes.cn'); assert.equal(parsed.pathname, '/api/news/stock/timeline-list');
    assert.equal(options.headers['X-api-key'], key); assert.equal(options.redirect, 'error');
    return json({ code: 0, data: { items: parsed.searchParams.get('thscode') === '300033.SZ' ? [] : items, has_more: true, offset: 'opaque-next' } });
  };
  return { calls, fetchImpl };
}

test('official news MCP 405 falls back to one verified REST tool and labels the transport explicitly', async () => {
  const { calls, fetchImpl } = transport();
  const result = await handleFinancialQuery({ ...config, kind: 'tools' }, { fetchImpl });
  assert.equal(result.transport, 'rest'); assert.equal(result.readOnlyToolCount, 1);
  assert.equal(result.tools[0].name, 'get_news_stock_timeline_list'); assert.match(result.fallbackReason, /REST/);
  assert.equal(calls.length, 2); assert.equal(calls[1].url.searchParams.get('size'), '1');
  assert.equal(JSON.stringify(result).includes(key), false);
});

test('authentication, rate-limit and unrelated endpoint errors never trigger REST fallback', async () => {
  for (const [endpoint, status] of [[config.endpoint, 401], [config.endpoint, 403], [config.endpoint, 429], [config.endpoint, 500], ['https://fuyao.aicubes.cn/mcp/a-share', 405], ['https://mcp.51ifind.com/mcp', 405]]) {
    let calls = 0;
    await assert.rejects(handleFinancialQuery({ ...config, provider: endpoint.includes('51ifind') ? 'ifind' : 'fuyao', endpoint, kind: 'tools' }, { fetchImpl: async () => { calls++; return new Response(key, { status }); } }));
    assert.equal(calls, 1);
  }
});

test('REST tool saves explicit publication time and original fields, with usable pagination', async () => {
  const { fetchImpl } = transport(), saved = [];
  const agent = await createEvidenceTools({ config, context, fetchImpl, onEvidence: events => saved.push(...events) });
  try {
    const result = await agent.tools[0].execute('1', { tradeIds: ['T1'], arguments: { thscode: '600519.SH', offset: 'first', size: 2 } });
    assert.equal(agent.transport, 'rest'); assert.equal(result.details.transport, 'rest'); assert.equal(saved.length, 1);
    assert.equal(saved[0].publishedAt, '2025-09-01T02:00Z');
    assert.match(saved[0].text, /publish_time_ms/); assert.match(saved[0].text, /summary/); assert.match(saved[0].source, /REST/);
    assert.equal(saved[0].url, 'https://example.test/article');
    assert.deepEqual(result.details.pagination, { hasMore: true, offset: 'opaque-next' });
    assert.equal(JSON.stringify(saved).includes(key), false);
  } finally { await agent.close(); }
});

test('all-future first page keeps cursor for historical paging and does not save future news as evidence', async () => {
  const { fetchImpl } = transport([news('2026-10-21T10:00:00+08:00')]); let saves = 0;
  const agent = await createEvidenceTools({ config, context, fetchImpl, onEvidence: () => saves++ });
  try {
    const result = await agent.tools[0].execute('1', { tradeIds: ['T1'], arguments: { thscode: '600519.SH', offset: 'first', size: 2 } });
    assert.equal(result.details.status, 'empty'); assert.equal(result.details.excludedAfter, 1); assert.equal(saves, 0);
    assert.equal(result.details.pagination.offset, 'opaque-next'); assert.match(result.details.limitations.at(-1), /没有直接日期过滤/);
  } finally { await agent.close(); }
});

test('publication milliseconds survive the evidence contract and preserve before/after trade boundaries', () => {
  const items = [
    news('2025-09-02T01:44:59.999Z', { title: '成交前1毫秒' }),
    news('2025-09-02T01:45:00.000Z', { title: '与成交同刻' }),
    news('2025-09-02T01:45:00.001Z', { title: '成交后1毫秒' }),
    news('2025-09-02T01:45:00.123Z', { title: '成交后123毫秒' }),
  ];
  const input = { structuredContent: { items } };
  const current = normalizeExternalEvidence(input, { provider: 'fuyao', toolName: 'REST', trades: [trade] });
  assert.deepEqual(current.events.map(event => event.title), ['成交前1毫秒', '与成交同刻']);
  assert.equal(current.events[0].publishedAt, '2025-09-02T01:44:59.999Z');
  assert.equal(current.events[1].publishedAt, '2025-09-02T01:45Z');
  assert.equal(current.excludedAfter, 2);
  const all = normalizeExternalEvidence(input, { provider: 'fuyao', toolName: 'REST', trades: [trade], includeAfter: true });
  assert.equal(all.events[2].publishedAt, '2025-09-02T01:45:00.001Z');
  assert.equal(all.events[3].publishedAt, '2025-09-02T01:45:00.123Z');
  assert.deepEqual(all.evidence.map(event => event.timeClass), ['before', 'before', 'after', 'after']);
});

test('REST stock queries cannot attach another symbol or real stock news to simulated trades', async () => {
  for (const symbol of ['SIM086', '600001.SH']) {
    const { calls, fetchImpl } = transport();
    const agent = await createEvidenceTools({ config, context: { ...context, trades: [{ ...trade, symbol }] }, fetchImpl });
    try {
      const before = calls.length;
      await assert.rejects(agent.tools[0].execute('1', { tradeIds: ['T1'], arguments: { thscode: '600519.SH', offset: 'first', size: 2 } }), /标的/);
      assert.equal(calls.length, before);
    } finally { await agent.close(); }
  }
  const { fetchImpl } = transport();
  const agent = await createEvidenceTools({ config, context: { ...context, trades: [{ ...trade, symbol: '600519' }] }, fetchImpl });
  try { assert.equal((await agent.tools[0].execute('1', { tradeIds: ['T1'], arguments: { thscode: '600519.SH', offset: 'first', size: 2 } })).details.events.length, 1); }
  finally { await agent.close(); }
});

test('REST validates business success, response bounds and credentials without reflecting raw errors', async () => {
  for (const payload of [{ code: 2003, message: key }, { code: 0, data: { items: [], has_more: 'false' } }, { code: 0, data: { items: [{ summary: key }], has_more: false } }]) {
    await assert.rejects(fetchFuyaoStockNews(config, { thscode: '600519.SH', offset: 'first', size: 1 }, { fetchImpl: async () => json(payload) }), error => !error.message.includes(key));
  }
  const result = normalizeExternalEvidence({ structuredContent: { items: [news('2025-09-01T10:00:00+08:00', { publish_time_ms: null, create_time_ms: Date.parse('2025-09-01T10:00:00+08:00') })] } }, { provider: 'fuyao', toolName: 'REST', trades: [trade] });
  assert.equal(result.events[0].publishedAt, null);
});
