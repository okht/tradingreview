import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { createRuntime } from '../server/model-runtime.js';
import { runAgent } from '../server/agent-runner.js';
import { buildEvidence, validateContext } from '../server/contracts.js';

const fixture = {
  trades: [{ id: 'T1', symbol: '600001', name: '示例标的', time: '2025-09-02T09:45', side: 'buy', quantity: 100, price: 40, fee: 5 }],
  contexts: { T1: { reason: '我记得按计划买入', source: '现在回忆', unknown: false } },
  marketMode: 'import', origin: '测试 CSV',
};
const testKey = 'fake-local-test-key';

function events(res, deltas, finishReason = 'stop') {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  const chunk = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({
    id: 'fake-completion', object: 'chat.completion.chunk', created: 1, model: 'fake-review-model',
    choices: [{ index: 0, delta, finish_reason }],
  })}\n\n`);
  chunk({ role: 'assistant' });
  for (const delta of deltas) chunk(delta);
  chunk({}, finishReason);
  res.write(`data: ${JSON.stringify({ id: 'fake-completion', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } })}\n\n`);
  res.end('data: [DONE]\n\n');
}

function requestTools(res, names = ['read_trades', 'read_evidence']) {
  events(res, [{ tool_calls: names.map((name, index) => ({ index, id: `call-${name}`, type: 'function', function: { name, arguments: '{}' } })) }], 'tool_calls');
}

function reply(res, value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const split = Math.ceil(text.length / 2);
  events(res, [{ content: text.slice(0, split) }, { content: text.slice(split) }]);
}

async function fakeProvider(t, handler) {
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const part of req) body += part;
    try {
      const parsed = JSON.parse(body);
      requests.push(parsed);
      await handler(parsed, res, requests.length);
    } catch {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const config = { provider: 'openai-compatible', auth: 'api', model: 'fake-review-model', apiKey: testKey, baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
  return { config, requests };
}

function review(overrides = {}) {
  const id = buildEvidence(validateContext(fixture)).find(item => item.id.startsWith('trade:')).id;
  return {
    text: '先核对成交记录，再补充当时的计划。',
    facts: [{ text: '这笔记录为买入 100 股。', evidenceIds: [id] }],
    interpretations: [], uncertainties: ['当时掌握的信息仍待确认。'],
    suggestions: ['补充事前计划的来源。'], learning: null, evidenceIds: [id], ...overrides,
  };
}

test('runtime uses explicit API credentials without reading an injected OAuth store', async () => {
  let reads = 0;
  const runtime = createRuntime({ provider: 'openai', auth: 'api', apiKey: testKey }, {
    credentials: { read() { reads++; throw new Error('must not read'); } },
  });
  const auth = await runtime.models.getAuth('openai');
  assert.equal(auth.auth.apiKey, testKey);
  assert.equal(reads, 0);
  assert.ok(runtime.models.getModels('openai').length > 0);
  assert.equal(runtime.model, undefined);
  assert.throws(() => createRuntime({ provider: 'openai', auth: 'oauth', baseUrl: 'https://example.com' }), { code: 'MODEL_CONFIG' });
});

test('ChatGPT OAuth uses the installed OpenAI subscription provider and its credential identity', async () => {
  const reads = [];
  const credential = { type: 'oauth', access: 'synthetic-subscription-token', refresh: 'unused-synthetic-refresh', expires: Date.now() + 3600000, clientId: 'synthetic-client', scopes: ['chatgpt.tokens.use.direct'] };
  const runtime = createRuntime({ provider: 'openai', auth: 'oauth' }, { credentials: { async read(id) { reads.push(id); return structuredClone(credential); } } });
  const expected = openaiProvider();
  assert.equal(runtime.providerId, expected.id);
  assert.deepEqual(runtime.models.getModels(runtime.providerId), expected.getModels());
  assert.equal(reads.length, 0, 'catalog enumeration must not read credentials');
  assert.ok(runtime.models.getModels(runtime.providerId).every(model => model.api === 'openai-responses' && model.baseUrl.startsWith('https://api.openai.com/')));
  const auth = await runtime.models.getAuth(runtime.providerId);
  assert.equal(auth.auth.apiKey, credential.access);
  assert.ok(reads.length > 0); assert.ok(reads.every(id => id === 'openai'));
});

test('real Pi loop executes the registered tools before a validated review', async t => {
  const uiEvents = [];
  const { config, requests } = await fakeProvider(t, (_body, res, count) => count === 1 ? requestTools(res) : reply(res, review()));
  const result = await runAgent({ task: 'review', config, context: fixture, text: '核对这笔买入。', onEvent: event => uiEvents.push(event) });
  assert.equal(result.facts.length, 1);
  assert.deepEqual(result.evidence.map(item => item.id), result.evidenceIds);
  assert.equal(result.evidence[0].type, 'trade');
  assert.equal(requests.length, 2);
  const toolReplies = requests[1].messages.filter(message => message.role === 'tool');
  assert.equal(toolReplies.length, 2);
  assert.ok(toolReplies.some(message => JSON.stringify(message.content).includes('T1')));
  assert.ok(uiEvents.some(event => event.type === 'tool' && event.name === 'read_evidence' && event.status === 'complete'));
  assert.ok(uiEvents.every(event => event.type !== 'delta'));
  assert.ok(!JSON.stringify(uiEvents).includes(result.text));
});

test('parse task preserves unknown trade fields after reading current records', async t => {
  const draft = {
    trades: [{ id: null, symbol: null, name: null, time: null, side: 'buy', quantity: 100, price: null, fee: null }],
    questions: ['买入的标的、成交日期、价格和费用分别是什么？'], warnings: ['记录仍待补充确认。'],
  };
  const { config, requests } = await fakeProvider(t, (_body, res, count) => count === 1 ? requestTools(res, ['read_trades']) : reply(res, draft));
  const result = await runAgent({ task: 'parse', config, context: { trades: [], contexts: {}, marketMode: 'import' }, text: '我买了 100 股。' });
  assert.deepEqual(result, draft);
  assert.equal(requests.length, 2);
});

test('background task reads evidence before returning clarification questions', async t => {
  const background = { questions: ['这次交易前有留下计划吗？'], missing: ['事前计划来源'] };
  const { config, requests } = await fakeProvider(t, (_body, res, count) => count === 1 ? requestTools(res) : reply(res, background));
  const result = await runAgent({ task: 'background', config, context: fixture, text: '还需要补充哪些背景？' });
  assert.deepEqual(result, background);
  assert.equal(requests.length, 2);
});

test('review with supplied market data executes read_market and returns a validated market citation', async t => {
  const context = { ...fixture, marketData: { provider: 'fuyao', source: '同花顺扶摇 A 股历史 K 线', symbol: '600001.SH', from: '2025-09-01', to: '2025-09-01', interval: '1D', adjust: 'none', currency: 'CNY', timeZone: 'Asia/Shanghai', availabilityPolicy: 'next-day', observedAt: '2025-09-05T03:04:05Z', bars: [{ time: '2025-09-01', open: 39, high: 41, low: 38, close: 40, closedAt: '2025-09-02T00:00+08:00' }] } };
  const marketResult = review({ facts: [{ text: '所提供的决策前日线收盘为 40 元。', evidenceIds: ['market:T1:before'] }], evidenceIds: ['market:T1:before'] });
  const { config, requests } = await fakeProvider(t, (_body, res, count) => {
    if (count === 1) events(res, [{ tool_calls: ['read_trades', 'read_evidence', 'read_market'].map((name, index) => ({ index, id: `call-${name}`, type: 'function', function: { name, arguments: JSON.stringify(name === 'read_market' ? { tradeId: 'T1' } : {}) } })) }], 'tool_calls');
    else reply(res, marketResult);
  });
  const output = await runAgent({ task: 'review', config, context, text: '请核对当时可见的行情。' });
  assert.deepEqual(output.evidenceIds, ['market:T1:before']);
  assert.equal(requests[1].messages.filter(message => message.role === 'tool').length, 3);
  assert.ok(requests[1].messages.some(message => message.role === 'tool' && JSON.stringify(message.content).includes('availabilityPolicy')));
});

test('review cannot bypass reading supplied market data by returning a valid-looking result', async t => {
  const context = { ...fixture, marketData: { provider: 'fuyao', source: '同花顺扶摇 A 股历史 K 线', symbol: '600001.SH', from: '2025-09-01', to: '2025-09-01', interval: '1D', adjust: 'none', currency: 'CNY', timeZone: 'Asia/Shanghai', availabilityPolicy: 'next-day', observedAt: '2025-09-05T03:04:05Z', bars: [{ time: '2025-09-01', open: 39, high: 41, low: 38, close: 40, closedAt: '2025-09-02T00:00+08:00' }] } };
  const { config, requests } = await fakeProvider(t, (_body, res, count) => count === 1 ? requestTools(res) : reply(res, review()));
  await assert.rejects(runAgent({ task: 'review', config, context, text: '请复盘。' }), { code: 'INVALID_RESULT' });
  assert.equal(requests.length, 3);
});

test('existing but unread after-market evidence cannot be guessed into a result', async t => {
  const context = { ...fixture, marketData: { provider: 'fuyao', source: '同花顺扶摇 A 股历史 K 线', symbol: '600001.SH', from: '2025-09-02', to: '2025-09-02', interval: '1D', adjust: 'none', currency: 'CNY', timeZone: 'Asia/Shanghai', availabilityPolicy: 'next-day', observedAt: '2025-09-05T03:04:05Z', bars: [{ time: '2025-09-02', open: 40, high: 43, low: 39, close: 42, closedAt: '2025-09-03T00:00+08:00' }] } };
  const unread = review({ facts: [{ text: '决策后所提供的日线收盘为 42 元。', evidenceIds: ['market:T1:after'] }], evidenceIds: ['market:T1:after'] });
  const { config } = await fakeProvider(t, (_body, res, count) => {
    if (count === 1) events(res, [{ tool_calls: ['read_trades', 'read_evidence', 'read_market'].map((name, index) => ({ index, id: `call-${name}`, type: 'function', function: { name, arguments: JSON.stringify(name === 'read_market' ? { tradeId: 'T1' } : {}) } })) }], 'tool_calls');
    else reply(res, unread);
  });
  await assert.rejects(runAgent({ task: 'review', config, context, text: '请复盘。' }), { code: 'INVALID_RESULT' });
});

test('malformed JSON gets one repair attempt without streaming unvalidated output', async t => {
  const uiEvents = [];
  const { config, requests } = await fakeProvider(t, (_body, res, count) => {
    if (count === 1) requestTools(res);
    else reply(res, count === 2 ? '未经验证的原始输出' : review());
  });
  const result = await runAgent({ task: 'review', config, context: fixture, text: '请复盘。', onEvent: event => uiEvents.push(event) });
  assert.equal(requests.length, 3);
  assert.ok(result.text);
  assert.ok(!JSON.stringify(uiEvents).includes('未经验证的原始输出'));
});

test('invented evidence IDs cannot become a completed review', async t => {
  const invalid = review({ facts: [{ text: '无依据结论', evidenceIds: ['invented:1'] }], evidenceIds: ['invented:1'] });
  const { config, requests } = await fakeProvider(t, (_body, res, count) => count === 1 ? requestTools(res) : reply(res, invalid));
  await assert.rejects(runAgent({ task: 'review', config, context: fixture, text: '请复盘。' }), { code: 'INVALID_RESULT', status: 422 });
  assert.equal(requests.length, 3);
});

test('a caller abort cancels a pending provider stream', async t => {
  const controller = new AbortController();
  const { config } = await fakeProvider(t, (_body, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.flushHeaders();
    controller.abort();
  });
  await assert.rejects(runAgent({ task: 'review', config, context: fixture, text: '请复盘。', signal: controller.signal }), { code: 'ABORTED', status: 499 });
});

test('an abort during the initial status event prevents a provider request', async t => {
  const controller = new AbortController();
  const { config, requests } = await fakeProvider(t, (_body, res) => reply(res, review()));
  await assert.rejects(runAgent({
    task: 'review', config, context: fixture, text: '请复盘。', signal: controller.signal,
    onEvent: () => controller.abort(),
  }), { code: 'ABORTED', status: 499 });
  assert.equal(requests.length, 0);
});

test('repeated tool requests stop at the model and tool budget', async t => {
  const { config, requests } = await fakeProvider(t, (_body, res) => requestTools(res, ['read_trades']));
  await assert.rejects(runAgent({ task: 'review', config, context: fixture, text: '请复盘。' }), { code: 'RUN_LIMIT', status: 422 });
  assert.equal(requests.length, 8);
});

test('upstream error details and generated test credentials stay out of public errors', async t => {
  const { config } = await fakeProvider(t, (_body, res) => {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `Sensitive upstream body ${testKey}`, type: 'authentication_error' } }));
  });
  await assert.rejects(runAgent({ task: 'review', config, context: fixture, text: '请复盘。' }), error => {
    assert.equal(error.code, 'MODEL_ERROR');
    assert.ok(!error.message.includes(testKey));
    assert.ok(!error.message.includes('Sensitive upstream body'));
    return true;
  });
});
