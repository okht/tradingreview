import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { runAgent } from '../server/agent-runner.js';
import { context, answer } from '../verification/ai-contract-eval/cases.mjs';

const input = { ...context, contexts: { T1: { source: '现在回忆', reason: 'PRIVATE_BACKGROUND_SHOULD_NOT_BE_CAPTURED', plan: 'PRIVATE_PLAN_SHOULD_NOT_BE_CAPTURED' } } };
const rejected = text => answer({ interpretations: [{ text, evidenceIds: ['background:T1'] }], evidenceIds: ['trade:T1', 'background:T1'] });

async function provider(t, candidates) {
  let calls = 0;
  const server = createServer(async (request, response) => {
    for await (const _ of request) { /* Discard local test requests. */ }
    calls++;
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunk = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ id: 'observer-test', object: 'chat.completion.chunk', created: 1, model: 'observer-test', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    chunk({ role: 'assistant' });
    if (calls === 1) {
      chunk({ tool_calls: ['read_trades', 'read_evidence'].map((name, index) => ({ index, id: name, type: 'function', function: { name, arguments: '{}' } })) });
      chunk({}, 'tool_calls');
    } else {
      const candidate = candidates[Math.min(calls - 2, candidates.length - 1)];
      chunk({ content: typeof candidate === 'string' ? candidate : JSON.stringify(candidate) }); chunk({}, 'stop');
    }
    response.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { config: { provider: 'openai-compatible', auth: 'api', model: 'observer-test', apiKey: 'test-only-private-config-secret', baseUrl: `http://127.0.0.1:${server.address().port}/v1` } };
}

test('opt-in observer identifies first and repaired failures without sending item text to SSE', async t => {
  const first = '用户的回忆证明当时按计划执行。后一句保留完整表述。';
  const second = '用户当时严格执行了计划。';
  const { config } = await provider(t, [rejected(first), rejected(second)]);
  const observed = [], events = [];
  await assert.rejects(runAgent({ task: 'review', config, context: input, text: '核对计划。', onValidationFailure: detail => observed.push(detail), onEvent: event => events.push(event) }), { code: 'INVALID_RESULT' });
  assert.deepEqual(observed.map(item => [item.attempt, item.phase, item.failedItem.path]), [[1, 'initial', 'interpretations[0]'], [2, 'repair', 'interpretations[0]']]);
  assert.equal(observed[0].failedItem.text, first);
  assert.equal(observed[1].failedItem.text, second);
  assert.equal(observed[0].failedItem.uncertaintyMatched, false);
  assert.deepEqual(observed[0].failedItem.evidence, [{ type: 'background', timeClass: 'recollection' }]);
  assert.equal(observed[0].diagnostic.code, 'CONTRACT_VALIDATION');
  assert.ok(!JSON.stringify(events).includes(first)); assert.ok(!JSON.stringify(events).includes(second));
  assert.deepEqual(Object.keys(observed[0]).sort(), ['attempt', 'diagnostic', 'failedItem', 'phase']);
  assert.ok(!JSON.stringify(observed).includes('PRIVATE_BACKGROUND')); assert.ok(!JSON.stringify(observed).includes('PRIVATE_PLAN'));
});

test('observer redacts known identities, config key, credential-shaped strings, addresses, paths, and numbers', async t => {
  const secrets = ['评测构造标的', '600001', 'T1', 'test-only-private-config-secret', 'sk-privateABC123', 'secret-access-value', 'person@example.test', 'https://private.test/a?token=secret', 'C:\\private\\folder\\note.txt', '99999'];
  const text = `用户当时严格执行了计划，${secrets.map(value => value === 'secret-access-value' ? `access_token=${value}` : value).join('，')}，access_token=private-token-value，Bearer private-bearer-value。`;
  const { config } = await provider(t, [rejected(text)]), observed = [];
  await assert.rejects(runAgent({ task: 'review', config, context: input, text: '核对。', onValidationFailure: detail => observed.push(detail) }), { code: 'INVALID_RESULT' });
  const captured = JSON.stringify(observed);
  for (const secret of secrets) assert.ok(!captured.includes(secret), `must redact ${secret}`);
  assert.ok(!captured.includes('private-token-value')); assert.ok(!captured.includes('private-bearer-value'));
  assert.match(observed[0].failedItem.text, /用户当时严格执行了计划/);
});

test('full-item uncertainty remains observable when its later sentence is truncated', async t => {
  const text = `用户当前记录${'材料'.repeat(500)}。仍需核实。买入 999999 股。`;
  const candidate = answer({ facts: [{ text, evidenceIds: ['trade:T1'] }] });
  const { config } = await provider(t, [candidate]), observed = [];
  await assert.rejects(runAgent({ task: 'review', config, context: input, text: '核对。', onValidationFailure: detail => observed.push(detail) }), { code: 'INVALID_RESULT' });
  assert.equal(observed[0].failedItem.path, 'facts[0]');
  assert.equal([...observed[0].failedItem.text].length, 800);
  assert.equal(observed[0].failedItem.truncated, true);
  assert.equal(observed[0].failedItem.uncertaintyMatched, true);
  assert.deepEqual(observed[0].failedItem.uncertaintyMatches, ['仍需']);
  assert.ok(!observed[0].failedItem.text.includes('仍需'));
});

test('invalid JSON has only an app diagnostic and no parser fragment or rejected raw output', async t => {
  const { config } = await provider(t, ['{"private": "PARSER_PRIVATE_MARKER"']), observed = [];
  await assert.rejects(runAgent({ task: 'review', config, context: input, text: '核对。', onValidationFailure: detail => observed.push(detail) }), { code: 'INVALID_RESULT' });
  assert.equal(observed.length, 2);
  assert.ok(observed.every(item => item.failedItem === null && item.diagnostic.code === 'INVALID_JSON'));
  assert.ok(!JSON.stringify(observed).includes('PARSER_PRIVATE_MARKER'));
});

test('observer errors and mutations cannot override rejection or poison a successful repair', async t => {
  const bad = rejected('用户当时严格执行了计划。');
  const { config } = await provider(t, [bad, answer()]); let calls = 0;
  const result = await runAgent({ task: 'review', config, context: input, text: '核对。', onValidationFailure: async detail => { calls++; detail.failedItem.text = 'observer changed its detached copy'; detail.failedItem.evidence.length = 0; throw new Error('OBSERVER_PRIVATE_ERROR'); } });
  assert.equal(calls, 1); assert.equal(result.text, answer().text);
  const failed = await provider(t, [bad]);
  await assert.rejects(runAgent({ task: 'review', config: failed.config, context: input, text: '核对。', onValidationFailure: () => { throw new Error('observer failure'); } }), { code: 'INVALID_RESULT' });
});

test('diagnostic uncertainty predicate stays identical to the acceptance predicate', () => {
  const contracts = readFileSync(new URL('../server/contracts.js', import.meta.url), 'utf8');
  const runner = readFileSync(new URL('../server/agent-runner.js', import.meta.url), 'utf8');
  const contractPattern = /const UNCERTAIN_CLAIM = \/(.+)\//.exec(contracts)?.[1];
  const diagnosticPattern = /const DIAGNOSTIC_UNCERTAINTY = \/(.+)\//.exec(runner)?.[1];
  assert.ok(contractPattern); assert.equal(diagnosticPattern, contractPattern, 'the observational flag must never drift from the actual gate');
});
