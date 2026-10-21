import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { createApi, validateModelConfig } from '../server/api.js';
import { MemoryStore } from '../server/storage.js';
import { createJourney } from '../src/journey-state.js';

const testKey = 'fake-api-route-key';
const config = { provider: 'openai', auth: 'api', model: 'synthetic-model', apiKey: testKey };
const taskBody = { task: 'parse', config, text: '我买了 100 股。' };
const result = { trades: [], questions: ['请补充成交记录。'], warnings: ['尚待确认。'] };
const owner = () => `api-test-${crypto.randomUUID()}`;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function request(path, { method = 'GET', body, signal, headers = {} } = {}) {
  return new Request(`https://huikan.test${path}`, { method, signal, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
}
const streamRequest = options => request('/api/agent/stream', { method: 'POST', body: taskBody, ...options });
async function events(response) {
  return (await response.text()).split('\n\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
}

test('identity comes from the server argument and cross-site requests are rejected', async () => {
  const api = createApi();
  assert.equal((await api(request('/api/workspace', { headers: { 'oai-authenticated-user-id': 'forged' } }))).status, 401);
  assert.equal((await api(request('/api/workspace'), {})).status, 401);
  assert.equal((await api(request('/api/workspace', { headers: { origin: 'https://other.test' } }), owner())).status, 403);
  assert.equal((await api(request('/api/workspace', { headers: { 'sec-fetch-site': 'cross-site' } }), owner())).status, 403);
});

test('workspace revisions and run snapshots stay within their owner', async () => {
  const store = new MemoryStore(); const api = createApi({ store }); const alice = owner(), bob = owner();
  const state = { ...createJourney(), question: 'Alice record', config: { apiKey: testKey }, nested: { accessToken: testKey, access_token: testKey, refresh_token: testKey, api_key: testKey } };
  assert.equal((await api(request('/api/workspace', { method: 'PUT', body: { state, revision: 0 } }), alice)).status, 200);
  const saved = await (await api(request('/api/workspace'), alice)).json();
  assert.equal(saved.revision, 1); assert.equal(saved.state.question, 'Alice record');
  assert.ok(!JSON.stringify(saved).includes(testKey));
  assert.deepEqual(await (await api(request('/api/workspace'), bob)).json(), { state: null, revision: 0 });
  assert.equal((await api(request('/api/workspace', { method: 'PUT', body: { state, revision: 0 } }), alice)).status, 409);
  const runId = crypto.randomUUID();
  await store.saveRun(alice, { id: runId, result });
  assert.equal((await api(request(`/api/runs/${runId}`), alice)).status, 200);
  assert.equal((await api(request(`/api/runs/${runId}`), bob)).status, 404);
  await store.saveRun(`${alice}:extra`, { id: runId, result });
  assert.equal((await api(request(`/api/runs/extra:${runId}`), alice)).status, 404);
});

test('two simultaneous writes with the same revision have only one winner', async () => {
  const api = createApi(); const identity = owner(); const state = createJourney();
  const responses = await Promise.all([0, 1].map(index => api(request('/api/workspace', { method: 'PUT', body: { state: { ...state, question: String(index) }, revision: 0 } }), identity)));
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
  assert.equal((await (await api(request('/api/workspace'), identity)).json()).revision, 1);
});

test('invalid empty drafts cannot silently reset a saved workspace', async () => {
  const api = createApi(); const identity = owner(); const state = { ...createJourney(), question: '保留这段输入' };
  assert.equal((await api(request('/api/workspace', { method: 'PUT', body: { state, revision: 0 } }), identity)).status, 200);
  const invalid = { ...createJourney(), selectedIds: ['missing-trade'] };
  assert.equal((await api(request('/api/workspace', { method: 'PUT', body: { state: invalid, revision: 1 } }), identity)).status, 400);
  const stored = await (await api(request('/api/workspace'), identity)).json();
  assert.equal(stored.revision, 1); assert.equal(stored.state.question, '保留这段输入');
  assert.ok(!Object.hasOwn(stored.state, '__huikanWorkspaceValidation'));
});

test('invalid JSON schemas and oversized bodies fail before invoking a model', async () => {
  let called = 0; const api = createApi({ runner: async () => { called++; return result; } });
  for (const body of [null, [], { ...taskBody, text: ' ' }, { ...taskBody, messages: {} }, { ...taskBody, messages: [null] }, { ...taskBody, messages: Array(101).fill({ role: 'user', text: 'x' }) }]) {
    assert.equal((await api(streamRequest({ body }), owner())).status, 400);
  }
  assert.equal((await api(streamRequest({ body: { ...taskBody, text: 'a'.repeat(1048576) } }), owner())).status, 413);
  assert.equal((await api(request('/api/workspace', { method: 'PUT', body: { state: createJourney(), revision: 1.2 } }), owner())).status, 400);
  assert.equal(called, 0);
});

test('model configuration rejects credential URL leaks, wrong hosts and malformed auth', () => {
  for (const baseUrl of ['http://api.openai.com/v1', 'https://127.0.0.1/v1', 'https://api.openai.com.evil.test/v1', 'https://user:pass@api.openai.com/v1', 'https://api.openai.com/v1?apiKey=fake', 'https://api.openai.com/v1#secret', 'https://api.openai.com:8443/v1', 'https://api.anthropic.com/v1']) {
    assert.throws(() => validateModelConfig({ ...config, baseUrl }));
  }
  for (const overrides of [{ auth: 'oops' }, { apiKey: '      ' }, { apiKey: `${testKey}\n` }, { model: 'bad\nmodel' }]) assert.throws(() => validateModelConfig({ ...config, ...overrides }));
  assert.throws(() => validateModelConfig({ ...config, provider: 'openai-compatible', baseUrl: 'file://localhost/test' }, { test: true }));
  assert.equal(validateModelConfig({ ...config, provider: 'openai-compatible', baseUrl: 'https://api.deepseek.com/v1' }).baseUrl, 'https://api.deepseek.com/v1');
});

test('model catalog uses the real runtime and returns only public model metadata', async () => {
  const api = createApi(); const response = await api(request('/api/models?provider=openai'), owner());
  assert.equal(response.status, 200); const data = await response.json();
  assert.ok(data.models.length); assert.deepEqual(Object.keys(data.models[0]).sort(), ['id', 'name']);
  assert.deepEqual(await (await api(request('/api/models?provider=openai-compatible'), owner())).json(), { models: [] });
  assert.equal((await api(request('/api/models?provider=openai&auth=oauth'), owner())).status, 422);
});

test('local ChatGPT model catalog includes the complete installed provider list without reading OAuth secrets', async () => {
  let reads = 0;
  const api = createApi({ local: true, oauth: { credentials: { read() { reads++; throw new Error('catalog must not read credentials'); } } } });
  const response = await api(request('/api/models?provider=openai&auth=oauth'), owner());
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.deepEqual(data.models, openaiProvider().getModels().map(model => ({ id: model.id, name: model.name })));
  assert.equal(reads, 0);
  assert.ok(data.models.length > 0);
});

test('source queries forward credentials only to the adapter and do not persist them', async () => {
  const store = new MemoryStore(); let captured;
  const api = createApi({ store, financialQuery: async (body, options) => { captured = { body, options }; return { status: 'empty', bars: [] }; } });
  const controller = new AbortController(); const identity = owner();
  const response = await api(request('/api/financial/query', { method: 'POST', body: { provider: 'fuyao', kind: 'bars', apiKey: testKey }, signal: controller.signal }), identity);
  assert.equal(response.status, 200); assert.equal(captured.body.apiKey, testKey); assert.equal(captured.options.signal.aborted, false);
  assert.ok(!(await response.text()).includes(testKey)); assert.equal(store.workspaces.size, 0); assert.equal(store.runs.size, 0);
  const failed = createApi({ financialQuery: async () => { throw Object.assign(new Error(`upstream ${testKey}`), { status: 429 }); } });
  const failure = await failed(request('/api/financial/query', { method: 'POST', body: {} }), owner());
  assert.equal(failure.status, 429); assert.ok(!(await failure.text()).includes(testKey));
});

test('manual evidence route assigns a new ID and server receipt time', async () => {
  const trades = [{ id: 'T1', symbol: '600001', name: '示例标的', time: '2025-09-02T09:45', side: 'buy', quantity: 100, price: 40, fee: 5 }];
  const event = { id: 'client-id', title: '用户录入的公告', text: '公司披露订单消息。', source: '公司公告', publishedAt: '2025-09-01T18:00+08:00', recordedAt: '2000-01-01T00:00Z', tradeId: 'T1' };
  const response = await createApi()(request('/api/financial/evidence', { method: 'POST', body: { trades, event } }), owner());
  assert.equal(response.status, 200); const data = await response.json();
  assert.notEqual(data.evidence.id, 'client-id'); assert.ok(data.evidence.recordedAt.startsWith(new Date().toISOString().slice(0, 10)));
  assert.ok(data.evidence.source.startsWith('用户录入：'));
});

test('account preview is disabled by default and uses server-configured hosts', async () => {
  let calls = 0, captured;
  const accountPreview = async (body, options) => { calls++; captured = { body, options }; return { trades: [], warnings: [] }; };
  const disabled = createApi({ accountPreview }); const identity = owner();
  assert.equal((await (await disabled(request('/api/status'), identity)).json()).accountApiConfigured, false);
  const response = await disabled(request('/api/account-trades/preview', { method: 'POST', body: { token: testKey, allowedHosts: ['attacker.test'] } }), identity);
  assert.equal(response.status, 503); assert.equal(calls, 0);
  const enabled = createApi({ accountHosts: ['account.example.test'], accountPreview });
  assert.equal((await (await enabled(request('/api/status'), identity)).json()).accountApiConfigured, true);
  const success = await enabled(request('/api/account-trades/preview', { method: 'POST', body: { token: testKey, allowedHosts: ['attacker.test'] } }), identity);
  assert.equal(success.status, 200); assert.deepEqual(captured.options.allowedHosts, ['account.example.test']);
  assert.equal(captured.body.token, testKey); assert.ok(!(await success.text()).includes(testKey));
});

test('model connection suppresses upstream exceptions with sensitive status bodies', async () => {
  const runtimeFactory = () => ({ model: { id: config.model }, models: { completeSimple: async () => { throw Object.assign(new Error(`raw body ${testKey}`), { status: 401 }); } } });
  const api = createApi({ runtimeFactory });
  const response = await api(request('/api/models/connect', { method: 'POST', body: { config } }), owner());
  assert.equal(response.status, 502); const text = await response.text();
  assert.ok(!text.includes(testKey)); assert.ok(!text.includes('raw body'));
});

test('connection timeout returns even if a provider ignores cancellation', async () => {
  let observedSignal;
  const api = createApi({ connectTimeoutMs: 20, runtimeFactory: () => ({ model: { id: config.model }, models: { completeSimple: (_model, _context, options) => { observedSignal = options.signal; return new Promise(() => {}); } } }) });
  const response = await api(request('/api/models/connect', { method: 'POST', body: { config } }), owner());
  assert.equal(response.status, 502); assert.equal(observedSignal.aborted, true);
});

test('local OAuth uses the injected credential store and exact route paths', async () => {
  const credentials = {}; let captured;
  const oauth = { credentials, status: () => ({ status: 'connected' }), start: async () => ({ status: 'connecting' }), cancel() {} };
  const api = createApi({ local: true, oauth, runtimeFactory: (_config, options) => { captured = options.credentials; return { model: { id: 'oauth-model' }, models: { completeSimple: async () => ({ stopReason: 'stop' }) } }; } });
  assert.equal((await api(request('/api/models/connect', { method: 'POST', body: { config: { provider: 'openai', auth: 'oauth', model: 'oauth-model' } } }))).status, 200);
  assert.equal(captured, credentials);
  assert.equal((await api(request('/api/oauth/nested/status'))).status, 404);
  assert.equal((await api(request('/api/oauth/status'))).status, 200);
});

test('OAuth cancel and disconnect await lifecycle completion and expose only safe status', async () => {
  let state = { status: 'connected', persisted: true }, cancelled = false, disconnected = false;
  const oauth = { status: () => state,
    async cancel() { await Promise.resolve(); cancelled = true; },
    async disconnect() { await Promise.resolve(); disconnected = true; state = { status: 'idle' }; },
  };
  const api = createApi({ local: true, oauth });
  const cancel = await api(request('/api/oauth/cancel', { method: 'POST', body: {} }));
  assert.equal(cancelled, true); assert.equal((await cancel.json()).status, 'connected');
  const disconnect = await api(request('/api/oauth/disconnect', { method: 'POST', body: {} }));
  assert.equal(disconnected, true); assert.deepEqual(await disconnect.json(), { status: 'idle' });
  assert.equal((await api(request('/api/oauth/disconnect'))).status, 404);
  const cloud = createApi({ oauth });
  assert.notEqual((await cloud(request('/api/oauth/disconnect', { method: 'POST', body: {} }), owner())).status, 200);
});

test('successful SSE results are persisted without model keys', async () => {
  const store = new MemoryStore(); const identity = owner();
  const api = createApi({ store, runner: async ({ onEvent }) => { onEvent({ type: 'status', text: '正在核对' }); return result; } });
  const response = await api(streamRequest(), identity); assert.equal(response.status, 200);
  const output = await events(response); const completed = output.find(event => event.type === 'result');
  assert.ok(completed.result.analysisRunId);
  const run = await store.getRun(identity, completed.result.analysisRunId);
  assert.deepEqual(run.result, result); assert.ok(!JSON.stringify(run).includes(testKey));
  assert.ok(!JSON.stringify(output).includes(testKey));
});

test('save failure emits no result and releases the owner task slot', async () => {
  let saves = 0; const store = new MemoryStore();
  store.saveRun = async () => { if (++saves === 1) throw Object.assign(new Error(`write failed ${testKey}`), { status: 500 }); };
  const api = createApi({ store, runner: async () => result }); const identity = owner();
  const first = await events(await api(streamRequest(), identity));
  assert.ok(first.some(event => event.type === 'error')); assert.ok(!first.some(event => event.type === 'result')); assert.ok(!JSON.stringify(first).includes(testKey));
  const second = await events(await api(streamRequest(), identity)); assert.ok(second.some(event => event.type === 'result'));
});

test('cancelled old task cannot delete a newer task slot when it eventually returns', async () => {
  const pending = []; const store = new MemoryStore();
  const api = createApi({ store, runner: () => { const entry = deferred(); pending.push(entry); return entry.promise; } }); const identity = owner();
  const first = await api(streamRequest(), identity);
  assert.equal((await api(streamRequest(), identity)).status, 409);
  await first.body.cancel();
  const second = await api(streamRequest(), identity); assert.equal(second.status, 200);
  pending[0].resolve(result); await tick();
  assert.equal((await api(streamRequest(), identity)).status, 409);
  pending[1].resolve(result); assert.ok((await events(second)).some(event => event.type === 'result'));
  assert.equal(store.runs.size, 1);
});

test('request abort closes SSE immediately and permits a replacement task', async () => {
  let calls = 0; const controller = new AbortController();
  const api = createApi({ runner: () => ++calls === 1 ? new Promise(() => {}) : result }); const identity = owner();
  const first = await api(streamRequest({ signal: controller.signal }), identity); controller.abort();
  assert.ok((await events(first)).some(event => event.type === 'error'));
  const second = await api(streamRequest(), identity); assert.equal(second.status, 200);
  assert.ok((await events(second)).some(event => event.type === 'result'));
});

test('server timeout closes SSE and releases a task whose runner ignores cancellation', async () => {
  let calls = 0, observedSignal;
  const api = createApi({ runTimeoutMs: 20, runner: ({ signal }) => { observedSignal = signal; return ++calls === 1 ? new Promise(() => {}) : result; } }); const identity = owner();
  // Keep one referenced timer while awaiting the server's unref'd lifecycle timer.
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    const first = await events(await api(streamRequest(), identity));
    assert.equal(observedSignal.aborted, true); assert.ok(first.some(event => event.type === 'error'));
    const second = await events(await api(streamRequest(), identity)); assert.ok(second.some(event => event.type === 'result'));
  } finally { clearTimeout(keepAlive); }
});

test('rate limits are shared across newly created router instances for one owner', async () => {
  const identity = owner(); let responses = [];
  for (let index = 0; index < 13; index++) {
    responses.push(await createApi()(request('/api/models/connect', { method: 'POST', body: {} }), identity));
  }
  assert.equal(responses.at(-1).status, 429);
  assert.equal((await createApi()(request('/api/models/connect', { method: 'POST', body: {} }), owner())).status, 400);
});

test('connect route and real Pi runtime complete against a local synthetic SSE service', async t => {
  let calls = 0;
  const server = createServer(async (req, res) => {
    let body = ''; for await (const part of req) body += part;
    const payload = JSON.parse(body); calls++;
    assert.equal(payload.model, 'local-test-model');
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: 'test', object: 'chat.completion.chunk', created: 1, model: 'local-test-model', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    chunk({ role: 'assistant', content: 'OK' }); chunk({}, 'stop'); res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const api = createApi({ test: true });
  const response = await api(request('/api/models/connect', { method: 'POST', body: { config: { provider: 'openai-compatible', auth: 'api', model: 'local-test-model', apiKey: testKey, baseUrl: `http://127.0.0.1:${server.address().port}/v1` } } }), owner());
  assert.equal(response.status, 200); assert.equal(calls, 1);
  assert.deepEqual(await response.json(), { ok: true, model: 'local-test-model', provider: 'openai-compatible' });
});
