import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { validateResult, buildEvidence, validatePrepareTradeIds } from '../server/contracts.js';
import { runAgent, AgentRunError } from '../server/agent-runner.js';
import { createApi } from '../server/api.js';
import { MemoryStore } from '../server/storage.js';

const context = { trades: [
  { id: 'T1', symbol: '600519.SH', name: '贵州茅台', time: '2025-03-03T09:40', side: 'buy', quantity: 100, price: 1500, fee: 39 },
  { id: 'T2', symbol: '600519.SH', name: '贵州茅台', time: '2025-03-04T10:35', side: 'buy', quantity: 100, price: 1510, fee: 39.26 },
], contexts: {}, marketMode: 'import', origin: '测试构造成交' };
const draft = (tradeId, overrides = {}) => ({ tradeId, reason: '先建立仓位，观察后续走势。', plan: '分批投入，并在后续调整前核对持仓与预算。', basis: '根据当前成交行为推测，不代表当时已确认的理由或计划。', evidenceIds: [`trade:${tradeId}`], unknown: true, ...overrides });
const prepared = overrides => ({ suggestions: context.trades.map(trade => draft(trade.id)), missing: ['主观理由仍待确认。'], ...overrides });
const check = (result = prepared(), input = context, evidence) => validateResult('prepare', result, input, evidence);

test('prepare covers every trade without mutating context or promoting editable candidates to confirmed notes', () => {
  const before = structuredClone(context), result = check();
  assert.deepEqual(result.suggestions.map(item => item.tradeId), ['T1', 'T2']);
  assert.ok(result.suggestions.every(item => item.unknown));
  assert.deepEqual(context, before);
  assert.equal(result.researchIntent, undefined); assert.equal(result.learning, undefined);
  assert.deepEqual(check(prepared({ suggestions: context.trades.map(trade => draft(trade.id, { reason: '', plan: '', evidenceIds: [] })) })).suggestions.map(item => item.reason), ['', '']);
});

test('prepare blocks omissions, duplicates, out-of-scope and unread citations', () => {
  assert.throws(() => check(prepared({ suggestions: [draft('T1')] })), /覆盖每笔/);
  assert.throws(() => check(prepared({ suggestions: [draft('T1'), draft('T1')] })), /重复/);
  assert.throws(() => check(prepared({ suggestions: [draft('T1'), draft('OTHER')] })), /范围外/);
  assert.throws(() => check(prepared(), context, []), /引用/);
  assert.throws(() => check(prepared({ suggestions: [draft('T1', { evidenceIds: ['trade:T2'] }), draft('T2')] })), /后续成交/);
});

test('prepare batch scope accepts one to five existing distinct IDs only and keeps the old full-context default', () => {
  const input = { ...context, trades: Array.from({ length: 6 }, (_, index) => ({ ...context.trades[0], id: `T${index + 1}` })) };
  assert.equal(validatePrepareTradeIds('prepare', undefined, input), undefined);
  assert.deepEqual(validatePrepareTradeIds('prepare', ['T1', 'T2', 'T3', 'T4', 'T5'], input), ['T1', 'T2', 'T3', 'T4', 'T5']);
  for (const ids of [[], null, 'T1', ['T1', 'T1'], ['T1', ' T1 '], ['FOREIGN'], ['T1', 'T2', 'T3', 'T4', 'T5', 'T6']]) assert.throws(() => validatePrepareTradeIds('prepare', ids, input));
  assert.throws(() => validatePrepareTradeIds('review', ['T1'], input), /仅用于/);
  assert.throws(() => validateResult('background', { questions: [], missing: [] }, input, undefined, { prepareTradeIds: ['T1'] }), /仅用于/);
  assert.equal(check().suggestions.length, 2);
  assert.equal(validateResult('prepare', prepared({ suggestions: [draft('T2')] }), context, undefined, { prepareTradeIds: ['T2'] }).suggestions.length, 1);
  assert.throws(() => validateResult('prepare', prepared(), context, undefined, { prepareTradeIds: ['T2'] }), /只能输出本批/);
  assert.throws(() => validateResult('prepare', prepared({ suggestions: [] }), context, undefined, { prepareTradeIds: ['T2'] }), /覆盖本批每笔/);
});

test('prepare batches retain earlier history citations without weakening future, unread or unknown restrictions', () => {
  const input = { ...context, contexts: { T1: { source: '现在回忆', reason: '我记得计划分批买入', plan: '最多分 2 次建立仓位。' } } };
  const candidate = draft('T2', { reason: '延续此前分批建仓的节奏。', plan: '沿用最多分 2 次建立仓位的安排。', basis: '用户现在回忆曾考虑分批，是否适用于这笔成交仍待确认。', evidenceIds: ['trade:T2', 'background:T1'], unknown: false });
  const result = prepared({ suggestions: [candidate] });
  const options = { prepareTradeIds: ['T2'] };
  assert.equal(validateResult('prepare', result, input, buildEvidence(input), options).suggestions[0].unknown, true);
  assert.throws(() => validateResult('prepare', result, input, buildEvidence(input).filter(item => item.id !== 'background:T1'), options), /引用/);
  assert.throws(() => validateResult('prepare', prepared({ suggestions: [draft('T1', { evidenceIds: ['trade:T2'] })] }), input, undefined, { prepareTradeIds: ['T1'] }), /后续成交/);
  assert.throws(() => validateResult('prepare', result, { ...input, contexts: { ...input.contexts, T2: { source: '现在回忆', reason: '', plan: '', unknown: true } } }, undefined, options), /记不清/);
});

test('prepare preserves unknown reason and no-plan acknowledgements', () => {
  const input = { ...context, contexts: { T1: { source: '现在回忆', reason: '', plan: '', unknown: true, noPlan: true } } };
  assert.throws(() => check(prepared(), input), /记不清/);
  const result = prepared({ suggestions: [draft('T1', { reason: '', plan: '', basis: '用户表示记不清理由且当时没有计划，更多主观材料仍待确认。', evidenceIds: ['background:T1'] }), draft('T2')] });
  assert.equal(check(result, input).suggestions[0].reason, '');
  assert.throws(() => check(prepared({ suggestions: [draft('T1', { reason: '', plan: '是否补充一个计划？' }), draft('T2')] }), input), /没有计划/);
});

test('prepare fills only empty fields and never replaces user-written reason or plan', () => {
  const input = { ...context, contexts: { T1: { source: '现在回忆', reason: '用户自己填写的判断', plan: '用户自己填写的安排' } } };
  const before = structuredClone(input);
  const result = check(prepared(), input);
  assert.equal(result.suggestions[0].reason, ''); assert.equal(result.suggestions[0].plan, '');
  assert.deepEqual(input, before);
  assert.equal(result.suggestions[1].reason, draft('T2').reason);
  assert.equal(result.suggestions[1].unknown, true);
});

test('prepare rejects question placeholders, invented parameters and news, advice and action receipts', () => {
  for (const reason of ['请补充当时的买入理由。', '待确认：需要用户补充依据。', '按 5% 止损安排买入。', '公司发布利好公告，因此开始建仓。', '请立即买入这只股票。']) {
    assert.throws(() => check(prepared({ suggestions: [draft('T1', { reason }), draft('T2')] })));
  }
  assert.equal(check(prepared({ suggestions: [draft('T1', { unknown: false }), draft('T2')] })).suggestions[0].unknown, true);
  assert.throws(() => check(prepared({ suggestions: [draft('T1', { basis: '已保存你的背景。' }), draft('T2')] })), /已保存/);
  assert.throws(() => check({ ...prepared(), researchIntent: { action: 'infer' } }), /研究/);
  assert.throws(() => check({ ...prepared(), learning: { title: 'fake' } }), /保存经验/);
});

test('prepare distinguishes confirmed input wording from confirmation, saving and adoption receipts', () => {
  for (const basis of ['已确认的成交记录只说明执行行为，主观背景仍待确认。', '本次使用已确认成交记录，主观理由仍待确认。']) {
    assert.equal(check(prepared({ suggestions: [draft('T1', { basis }), draft('T2')] })).suggestions[0].basis, basis);
  }
  const input = { ...context, contexts: { T1: { source: '现在回忆', reason: '我记得计划分批买入', plan: '' } } };
  const basis = '用户已确认的背景属于现在回忆，适用范围仍待确认。';
  assert.equal(check(prepared({ suggestions: [draft('T1', { basis, evidenceIds: ['background:T1'] }), draft('T2')] }), input).suggestions[0].basis, basis);
  for (const basis of ['已确认你的背景。', '背景已确认。', '已经确认了本次候选。', '已经保存你的背景。', '已采用这个计划。', '已确认。', '保证盈利。', '稳赚。']) {
    assert.throws(() => check(prepared({ suggestions: [draft('T1', { basis }), draft('T2')] })), /已保存|已确认|保证盈利|买卖建议/);
  }
});

test('prepare behavioral suggestions keep known trade numbers in cited basis without inventing plan parameters', () => {
  const options = { prepareTradeIds: ['T1'] };
  const result = prepared({ suggestions: [draft('T1', { basis: '已确认的成交价为 1500 元，主观理由和原计划仍待确认。' })] });
  assert.equal(validateResult('prepare', result, context, buildEvidence(context), options).suggestions[0].unknown, true);
  for (const reason of ['是否参考了成交价 1500 元作出判断？', '是否在 09:40 按计划买入？', '是否设定了 5% 止损？', '待确认：需要用户补充当时的买入依据。']) {
    assert.throws(() => validateResult('prepare', { ...result, suggestions: [{ ...result.suggestions[0], reason }] }, context, buildEvidence(context), options), /未提供|陈述/);
  }
  assert.throws(() => validateResult('prepare', { ...result, suggestions: [{ ...result.suggestions[0], basis: '成交价为 1600 元，主观理由仍待确认。' }] }, context, buildEvidence(context), options), /成交价格/);
});

test('prepare can reference an earlier confirmed recollection conditionally but cannot invent numeric parameters', () => {
  const input = { ...context, contexts: { T1: { source: '现在回忆', reason: '我记得计划分批买入', plan: '最多分 2 次建立仓位。' } } };
  const result = prepared({ suggestions: [draft('T1'), draft('T2', { reason: '延续此前分批建仓的节奏。', plan: '沿用最多分 2 次建立仓位的安排。', basis: '用户现在回忆曾考虑分批，是否适用于这笔成交仍待确认。', evidenceIds: ['trade:T2', 'background:T1'], unknown: false })] });
  assert.equal(check(result, input).suggestions[1].unknown, true);
  result.suggestions[1].plan = '按 5% 止损管理持仓。';
  assert.throws(() => check(result, input), /未提供/);
});

test('prepare blocks post-decision events and limits field sizes', () => {
  const input = { ...context, evidence: [{ id: 'late', tradeId: 'T1', type: 'event', title: '后发布事件', text: '事件在成交之后发布。', source: '构造事件', publishedAt: '2025-03-03T10:10', recordedAt: null }] };
  assert.throws(() => check(prepared({ suggestions: [draft('T1', { evidenceIds: ['event:late'] }), draft('T2')] }), input), /事后证据/);
  assert.throws(() => check(prepared({ suggestions: [draft('T1', { reason: '待确认'.repeat(300) }), draft('T2')] })), /候选理由/);
});

function sse(res, delta, finish = 'stop') {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const item of [{ role: 'assistant' }, delta, {}]) res.write(`data: ${JSON.stringify({ id: 'prepare-fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: item, finish_reason: Object.keys(item).length ? null : finish }] })}\n\n`);
  res.end('data: [DONE]\n\n');
}
const reply = (res, value) => sse(res, { content: JSON.stringify(value) });
function callTools(res, extra = []) {
  const calls = [{ name: 'read_trades', arguments: {} }, { name: 'read_evidence', arguments: {} }, ...extra];
  sse(res, { tool_calls: calls.map((call, index) => ({ index, id: `call-${call.name}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) }, 'tool_calls');
}
async function provider(t, handler) {
  const requests = [], server = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    try { const body = JSON.parse(raw); requests.push(body); await handler(body, response, requests.length); }
    catch { if (!response.headersSent) response.writeHead(500); response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { requests, config: { provider: 'openai-compatible', auth: 'api', model: 'fixture', apiKey: 'prepare-fixture-secret', baseUrl: `http://127.0.0.1:${server.address().port}/v1` } };
}

test('prepare Pi loop reads records and evidence, returns candidates and truthfully reports missing source connection', async t => {
  const model = await provider(t, (_body, res, count) => count === 1 ? callTools(res) : reply(res, prepared()));
  const result = await runAgent({ task: 'prepare', config: model.config, context, text: '准备本组已导入成交的背景候选。' });
  assert.equal(result.suggestions.length, 2); assert.deepEqual(result.fetchedEvidence, []);
  assert.match(result.retrievalStatus, /尚未连接/); assert.ok(result.missing.some(item => /尚未连接/.test(item)));
  assert.deepEqual(result.evidence.map(item => item.id), ['trade:T1', 'trade:T2']);
  const tools = model.requests[0].tools.map(item => item.function.name);
  assert.ok(!tools.includes('inspect_patterns')); assert.ok(!tools.includes('evaluate_pattern'));
  assert.equal(result.researchIntent, undefined); assert.equal(result.learning, undefined);
});

test('prepare repairs question placeholders into usable content while retaining inference metadata', async t => {
  const questions = prepared({ suggestions: context.trades.map(trade => draft(trade.id, { reason: '请补充当时买入的依据。', plan: '当时原先如何计划？' })) });
  const model = await provider(t, (_body, res, count) => count === 1 ? callTools(res) : reply(res, count === 2 ? questions : prepared()));
  const result = await runAgent({ task: 'prepare', config: model.config, context, text: '预测可直接填写的背景。' });
  assert.equal(model.requests.length, 3);
  assert.ok(result.suggestions.every(item => item.reason && item.plan && item.unknown));
  assert.ok(result.suggestions.every(item => !/请补充|待确认|[？?]/.test(item.reason + item.plan)));
  assert.ok(result.suggestions.every(item => item.basis.includes('推测')));
  assert.deepEqual(context.contexts, {});
});

test('prepare Pi batch reads complete history, emits only target candidates and retains the target in bounded repair', async t => {
  const input = { ...context, contexts: { T1: { source: '现在回忆', reason: '我记得计划分批买入', plan: '' } } };
  const batch = prepared({ suggestions: [draft('T2', { reason: '延续此前分批建仓的节奏。', plan: '', basis: '用户现在回忆曾考虑分批，是否适用于这笔成交仍待确认。', evidenceIds: ['background:T1', 'trade:T2'], unknown: false })] });
  const model = await provider(t, (_body, res, count) => count === 1 ? callTools(res) : reply(res, count === 2 ? prepared() : batch));
  const output = await runAgent({ task: 'prepare', prepareTradeIds: ['T2'], config: model.config, context: input, text: '准备本批背景候选。' });
  assert.deepEqual(output.suggestions.map(item => item.tradeId), ['T2']); assert.equal(model.requests.length, 3);
  assert.ok(output.evidence.some(item => item.id === 'background:T1'));
  const messageText = item => typeof item.content === 'string' ? item.content : (item.content || []).map(part => part.text || '').join('\n');
  const firstPrompt = model.requests[0].messages.map(messageText).join('\n');
  assert.match(firstPrompt, /prepareTradeIds=\["T2"\]/); assert.match(firstPrompt, /80 字内/);
  assert.match(firstPrompt, /可直接采用的简短陈述/);
  assert.match(firstPrompt, /reason\/plan 中不重复成交日期、价格、数量/);
  assert.match(firstPrompt, /读取材料时使用该笔成交时点为 decisionAt/);
  const tools = model.requests[1].messages.filter(item => item.role === 'tool').map(item => JSON.parse(messageText(item)));
  assert.deepEqual(tools.find(item => item.trades)?.trades.map(item => item.id), ['T1', 'T2']);
  assert.match(JSON.stringify(model.requests[2].messages), /prepareTradeIds/);
  assert.match(model.requests[2].messages.map(messageText).join('\n'), /无主观背景也可根据当笔及此前的行为、节奏与偏好推测/);
  let runtimeCalls = 0;
  await assert.rejects(runAgent({ task: 'prepare', prepareTradeIds: ['FOREIGN'], config: model.config, context, text: '准备候选。', runtimeFactory: () => { runtimeCalls++; } }), { code: 'INVALID_PREPARE_SCOPE' });
  await assert.rejects(runAgent({ task: 'review', prepareTradeIds: ['T1'], config: model.config, context, text: '核对成交。', runtimeFactory: () => { runtimeCalls++; } }), { code: 'INVALID_PREPARE_SCOPE' });
  assert.equal(runtimeCalls, 0);
});

test('prepare enforces tool reads and gets exactly one bounded repair for omitted trades', async t => {
  const model = await provider(t, (_body, res, count) => count === 1 ? callTools(res) : reply(res, prepared({ suggestions: count === 2 ? [draft('T1')] : context.trades.map(trade => draft(trade.id)) })));
  const result = await runAgent({ task: 'prepare', config: model.config, context, text: '准备候选。' });
  assert.equal(result.suggestions.length, 2); assert.equal(model.requests.length, 3);
  const unread = await provider(t, (_body, res) => reply(res, prepared()));
  await assert.rejects(runAgent({ task: 'prepare', config: unread.config, context, text: '准备候选。' }), { code: 'INVALID_RESULT' });
  assert.equal(unread.requests.length, 2);
});

test('prepare actually calls configured external read-only tools and returns validated evidence without secrets', async t => {
  let called = 0, closed = false;
  const event = { id: 'retrieved', tradeId: 'T1', type: 'event', title: '公开材料', text: '未披露盈利预测。', source: '构造只读源', publishedAt: '2025-03-02T10:00', recordedAt: '2025-03-05T10:00' };
  const evidenceFactory = async ({ onEvidence }) => ({ status: 'ready', limitation: '', close: async () => { closed = true; }, tools: [{ name: 'search_external_evidence_1', label: '检索资料', parameters: { type: 'object', properties: {}, additionalProperties: false }, execute: async () => { called++; await onEvidence([{ ...event, extra: 'must-strip' }]); return { content: [{ type: 'text', text: '已取得相关资料，公开过不等于用户读过。' }], details: {} }; } }] });
  const model = await provider(t, (_body, res, count) => count === 1 ? callTools(res, [{ name: 'search_external_evidence_1', arguments: {} }]) : reply(res, prepared()));
  const result = await runAgent({ task: 'prepare', config: model.config, context, text: '准备背景并取证。', financialConfig: { endpoint: 'fixture-only' }, evidenceFactory });
  assert.equal(called, 1); assert.equal(closed, true); assert.equal(result.fetchedEvidence.length, 1);
  assert.equal(result.fetchedEvidence[0].extra, undefined); assert.equal(result.fetchedEvidence[0].tradeId, 'T1');
  assert.doesNotMatch(JSON.stringify(result), /prepare-fixture-secret/); assert.match(result.retrievalStatus, /已自动补充 1/);
});

test('prepare synthetic cases do not mix real company news into simulated behavior', async t => {
  const bundle = JSON.parse(await readFile(new URL('../public/fixtures/complete-synthetic-review.json', import.meta.url), 'utf8'));
  const input = { ...context, trades: [bundle.trades[0]], marketData: bundle.marketData };
  const result = { suggestions: [draft(input.trades[0].id, { reason: '', plan: '', basis: '本组为合成测试资料，主观背景未知。', evidenceIds: [] })], missing: [] };
  let externalCalls = 0;
  const model = await provider(t, (_body, res, count) => count === 1 ? callTools(res) : reply(res, result));
  const output = await runAgent({ task: 'prepare', config: model.config, context: input, text: '准备候选。', financialConfig: { endpoint: 'fixture-only' }, evidenceFactory: async () => { externalCalls++; throw new Error('must not contact source'); } });
  assert.equal(externalCalls, 0); assert.deepEqual(output.fetchedEvidence, []); assert.match(output.retrievalStatus, /合成/);
  assert.ok(output.missing.some(item => /真实公司新闻不能证明模拟决策/.test(item)));
});

test('five synthetic trades with no background accept directly usable gray suggestions with separate attribution', async () => {
  const bundle = JSON.parse(await readFile(new URL('../public/fixtures/complete-synthetic-review.json', import.meta.url), 'utf8'));
  const input = { ...context, trades: bundle.trades, contexts: {}, evidence: [], marketData: bundle.marketData };
  const ids = input.trades.slice(0, 5).map(item => item.id);
  assert.equal(ids.length, 5);
  const suggestions = ids.map(id => draft(id, { basis: '本组为合成测试，根据可见成交推测，不代表已确认的原计划。' }));
  const output = validateResult('prepare', { suggestions, missing: ['合成测试资料没有用户主观背景，仍需本人补充。'] }, input, buildEvidence(input), { prepareTradeIds: ids });
  assert.equal(output.suggestions.length, 5); assert.ok(output.suggestions.every(item => item.unknown));
  assert.deepEqual(input.contexts, {});
});

test('prepare external failure preserves unknown candidates and records the source gap', async t => {
  const model = await provider(t, (_body, res, count) => count === 1 ? callTools(res) : reply(res, prepared()));
  const result = await runAgent({ task: 'prepare', config: model.config, context, text: '准备候选。', financialConfig: { endpoint: 'fixture-only' }, evidenceFactory: async () => { throw new Error('private source detail'); } });
  assert.equal(result.suggestions.length, 2); assert.match(result.retrievalStatus, /无法读取/);
  assert.doesNotMatch(JSON.stringify(result), /private source detail/);
});

test('review also skips real external news for synthetic cases while retaining required local market reads', async t => {
  const bundle = JSON.parse(await readFile(new URL('../public/fixtures/complete-synthetic-review.json', import.meta.url), 'utf8'));
  const input = { ...context, trades: [bundle.trades[0]], marketData: bundle.marketData };
  const review = { text: '请核对本次复盘材料。', textEvidenceIds: [], facts: [], interpretations: [], uncertainties: ['本次资料为合成情境。'], suggestions: [], learning: null, evidenceIds: [] };
  let externalCalls = 0;
  const model = await provider(t, (_body, res, count) => count === 1 ? callTools(res, [{ name: 'read_market', arguments: { tradeId: input.trades[0].id } }]) : reply(res, review));
  const output = await runAgent({ task: 'review', config: model.config, context: input, text: '核对这笔合成成交。', financialConfig: { endpoint: 'fixture-only' }, evidenceFactory: async () => { externalCalls++; throw new Error('must not contact source'); } });
  assert.equal(externalCalls, 0); assert.deepEqual(output.fetchedEvidence, []); assert.match(output.retrievalStatus, /合成/);
});

test('bounded repair failure exposes only safe diagnostic codes and local contract guidance', async t => {
  const malformed = await provider(t, (_body, res, count) => count === 1 ? callTools(res) : sse(res, { content: 'RAW-PROVIDER-PRIVATE-DETAIL {not json' }));
  let failure;
  await assert.rejects(runAgent({ task: 'prepare', config: malformed.config, context, text: '准备候选。' }), error => {
    failure = error; assert.ok(error instanceof AgentRunError); assert.equal(error.code, 'INVALID_RESULT'); assert.equal(error.diagnostic.code, 'INVALID_JSON');
    assert.doesNotMatch(JSON.stringify(error), /RAW-PROVIDER-PRIVATE-DETAIL/); return true;
  });
  const invalid = await provider(t, (_body, res, count) => count === 1 ? callTools(res) : reply(res, prepared({ suggestions: [draft('T1')] })));
  await assert.rejects(runAgent({ task: 'prepare', config: invalid.config, context, text: '准备候选。' }), error => {
    assert.equal(error.diagnostic.code, 'CONTRACT_VALIDATION'); assert.match(error.diagnostic.message, /覆盖每笔/); return true;
  });
  const api = createApi({ runner: async () => { throw failure; } });
  const response = await api(new Request('https://huikan.test/api/agent/stream', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ task: 'prepare', config: { provider: 'openai', auth: 'api', model: 'fixture', apiKey: 'fixture-key' }, context, text: '准备候选。' }) }), `prepare-diagnostic-${crypto.randomUUID()}`);
  const stream = await response.text(); assert.match(stream, /INVALID_JSON/); assert.match(stream, /校验原因/); assert.doesNotMatch(stream, /RAW-PROVIDER-PRIVATE-DETAIL|fixture-key/);
});

test('prepare API forwards financial config without executing research or persisting contexts as confirmed', async () => {
  const store = new MemoryStore(), received = [], identity = `prepare-api-${crypto.randomUUID()}`;
  const api = createApi({ store, runner: async args => { received.push(args); return prepared(); } });
  const financialConfig = { provider: 'fuyao', endpoint: 'https://fuyao.aicubes.cn/mcp/a-share', apiKey: 'prepare-source-fixture-key' };
  const body = { task: 'prepare', config: { provider: 'openai', auth: 'api', model: 'fixture', apiKey: 'prepare-model-fixture-key' }, context, financialConfig, text: '根据本组已导入历史成交准备未确认背景候选。', research: { unexpected: 'ignored' } };
  const response = await api(new Request('https://huikan.test/api/agent/stream', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), identity);
  assert.equal(response.status, 200); const output = await response.text(); assert.match(output, /"type":"result"/);
  assert.equal(received[0].task, 'prepare'); assert.deepEqual(received[0].financialConfig, financialConfig); assert.equal(received[0].research, null);
  assert.deepEqual(received[0].context.contexts, {}); assert.deepEqual(context.contexts, {});
  assert.doesNotMatch(output, /prepare-source-fixture-key|prepare-model-fixture-key/);
});

test('prepare API forwards batch targets with full history and rejects invalid batches before starting a run', async () => {
  const received = [];
  const api = createApi({ runner: async args => { received.push(args); return prepared({ suggestions: [draft('T2')] }); } });
  const body = { task: 'prepare', prepareTradeIds: ['T2'], config: { provider: 'openai', auth: 'api', model: 'fixture', apiKey: 'batch-fixture-key' }, context, text: '准备本批候选。' };
  const request = data => api(new Request('https://huikan.test/api/agent/stream', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) }), `prepare-batch-${crypto.randomUUID()}`);
  const response = await request(body); assert.equal(response.status, 200); assert.match(await response.text(), /"type":"result"/);
  assert.deepEqual(received[0].prepareTradeIds, ['T2']); assert.equal(received[0].context.trades.length, 2); assert.equal(received[0].research, null);
  for (const prepareTradeIds of [[], null, ['T1', 'T1'], ['FOREIGN'], ['T1', 'T2', 'T3', 'T4', 'T5', 'T6']]) {
    const invalid = await request({ ...body, prepareTradeIds }); assert.equal(invalid.status, 400); await invalid.text();
  }
  const otherTask = await request({ ...body, task: 'review' }); assert.equal(otherTask.status, 400); assert.match(await otherTask.text(), /仅用于/);
  assert.equal(received.length, 1);
});
