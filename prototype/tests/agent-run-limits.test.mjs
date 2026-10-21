import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { runAgent } from '../server/agent-runner.js';
import { context, answer } from '../verification/ai-contract-eval/cases.mjs';

const secret = 'private-local-limit-test-key';
async function provider(t, responseFor) {
  let calls = 0;
  const server = createServer(async (request, response) => {
    for await (const _ of request) { /* Synthetic requests are never persisted. */ }
    const result = responseFor(++calls);
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunk = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ id: 'limit-test', object: 'chat.completion.chunk', created: 1, model: 'limit-test', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    chunk({ role: 'assistant' });
    if (result.tools) {
      chunk({ tool_calls: result.tools.map((name, index) => ({ index, id: `call-${calls}-${index}`, type: 'function', function: { name, arguments: '{}' } })) });
      chunk({}, 'tool_calls');
    } else { chunk({ content: JSON.stringify(result.answer || answer()) }); chunk({}, 'stop'); }
    const usage = result.usage || { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 };
    response.write(`data: ${JSON.stringify({ id: 'limit-test', object: 'chat.completion.chunk', choices: [], usage })}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { config: { provider: 'openai-compatible', auth: 'api', model: 'limit-test', apiKey: secret, baseUrl: `http://127.0.0.1:${server.address().port}/v1` }, calls: () => calls };
}

async function rejectedRun(config, expectedCode, overrides = {}) {
  let error;
  await assert.rejects(runAgent({ task: 'review', config, context, text: '核对当前材料并提出检查项。', ...overrides }), caught => {
    error = caught;
    assert.equal(caught.code, 'RUN_LIMIT'); assert.equal(caught.status, 422);
    assert.equal(caught.diagnostic.code, expectedCode);
    assert.ok(!JSON.stringify(caught).includes(secret));
    const numbers = value => Object.values(value).every(item => typeof item === 'object' ? numbers(item) : Number.isSafeInteger(item) && item >= 0);
    assert.ok(numbers(caught.diagnostic.counts)); assert.ok(numbers(caught.diagnostic.limits));
    assert.ok(caught.diagnostic.usageByTurn.every(numbers));
    return true;
  });
  return error.diagnostic;
}

test('ordinary follow-up with four tools can finish after exceeding the former 32000 token budget', async t => {
  const toolOrder = ['read_trades', 'read_evidence', 'get_summary', 'read_trades'];
  const fake = await provider(t, turn => ({ ...(turn <= 4 ? { tools: [toolOrder[turn - 1]] } : {}), usage: { prompt_tokens: 6400, completion_tokens: 100, total_tokens: 6500, prompt_tokens_details: { cached_tokens: 6000 } } }));
  let validationCalls = 0;
  const result = await runAgent({ task: 'review', config: fake.config, context, text: '核对当前材料并提出检查项。',
    messages: [{ role: 'user', text: 'PRIVATE_PREVIOUS_USER' }, { role: 'assistant', text: 'PRIVATE_PREVIOUS_REVIEW' }],
    onValidationFailure: () => { validationCalls++; },
  });
  assert.equal(result.text, answer().text); assert.equal(fake.calls(), 5); assert.equal(validationCalls, 0);
});

test('cache reads are counted once and exactly 96000 total tokens passes', async t => {
  const fake = await provider(t, turn => ({ ...(turn === 1 ? { tools: ['read_trades', 'read_evidence'] } : {}), usage: { prompt_tokens: 47900, completion_tokens: 100, total_tokens: 48000, prompt_tokens_details: { cached_tokens: 45000 } } }));
  const result = await runAgent({ task: 'review', config: fake.config, context, text: '核对材料。' });
  assert.equal(result.text, answer().text); assert.equal(fake.calls(), 2);
});

test('review still stops above 96000 with safe counts and no validation callback', async t => {
  const toolOrder = ['read_trades', 'read_evidence', 'get_summary', 'read_trades'];
  const fake = await provider(t, turn => ({ ...(turn <= 4 ? { tools: [toolOrder[turn - 1]] } : {}), usage: { prompt_tokens: 19200, completion_tokens: 100, total_tokens: 19300, prompt_tokens_details: { cached_tokens: 18000 } } }));
  let validationCalls = 0;
  const diagnostic = await rejectedRun(fake.config, 'RUN_TOKEN_LIMIT', { onValidationFailure: () => { validationCalls++; } });
  assert.equal(fake.calls(), 5); assert.equal(validationCalls, 0);
  assert.deepEqual(diagnostic.counts, { modelTurns: 5, toolCalls: 4, inputTokens: 6000, outputTokens: 500, cacheReadTokens: 90000, cacheWriteTokens: 0, totalTokens: 96500 });
  assert.deepEqual(diagnostic.limits, { modelTurns: 8, toolCalls: 16, totalTokens: 96000 });
  assert.equal(diagnostic.usageByTurn.length, 5);
});

test('the observed three-turn no-cache follow-up usage now leaves room to return the answer', async t => {
  const totals = [3457, 15995, 17132, 3600], toolOrder = ['read_trades', 'read_evidence', 'get_summary'];
  const fake = await provider(t, turn => ({ ...(turn <= 3 ? { tools: [toolOrder[turn - 1]] } : {}), usage: { prompt_tokens: totals[turn - 1] - 100, completion_tokens: 100, total_tokens: totals[turn - 1] } }));
  const result = await runAgent({ task: 'review', config: fake.config, context, text: '提出检查项。', messages: [{ role: 'assistant', text: '上轮已核对成交和来源。' }] });
  assert.equal(result.text, answer().text); assert.equal(fake.calls(), 4);
});

test('repeated model tool-use turns report the turn limit independently of token usage', async t => {
  const fake = await provider(t, () => ({ tools: ['read_trades'] }));
  const diagnostic = await rejectedRun(fake.config, 'RUN_TURN_LIMIT');
  assert.equal(diagnostic.counts.modelTurns, 8); assert.equal(diagnostic.counts.toolCalls, 8);
  assert.equal(diagnostic.counts.totalTokens, 240); assert.equal(fake.calls(), 8);
});

test('a single model batch cannot execute the seventeenth tool and reports safe tool counts', async t => {
  const fake = await provider(t, () => ({ tools: Array.from({ length: 17 }, () => 'read_trades') }));
  const diagnostic = await rejectedRun(fake.config, 'RUN_TOOL_LIMIT');
  assert.equal(diagnostic.counts.toolCalls, 16); assert.equal(diagnostic.counts.modelTurns, 1);
  assert.equal(fake.calls(), 1);
});

test('cache write usage is a separate breakdown without double-counting the run total', async t => {
  const fake = await provider(t, turn => ({ ...(turn === 1 ? { tools: ['read_trades', 'read_evidence'] } : {}), usage: { prompt_tokens: 48500, completion_tokens: 100, total_tokens: 48600, prompt_tokens_details: { cached_tokens: 45000, cache_write_tokens: 1500 } } }));
  const diagnostic = await rejectedRun(fake.config, 'RUN_TOKEN_LIMIT');
  assert.deepEqual(diagnostic.counts, { modelTurns: 2, toolCalls: 2, inputTokens: 4000, outputTokens: 200, cacheReadTokens: 90000, cacheWriteTokens: 3000, totalTokens: 97200 });
});

for (const [task, limit] of [['import', 128000], ['prepare', 64000], ['parse', 32000], ['background', 32000]]) {
  test(`${task} retains its existing token budget`, async t => {
    const fake = await provider(t, () => ({ usage: { prompt_tokens: limit, completion_tokens: 1, total_tokens: limit + 1 } }));
    const diagnostic = await rejectedRun(fake.config, 'RUN_TOKEN_LIMIT', { task });
    assert.equal(diagnostic.limits.totalTokens, limit);
    assert.equal(diagnostic.counts.totalTokens, limit + 1); assert.equal(fake.calls(), 1);
  });
}
