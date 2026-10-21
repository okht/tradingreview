import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { validateResult, buildEvidence } from '../server/contracts.js';
import { runAgent } from '../server/agent-runner.js';
import { normalizeReviewResult } from '../src/live-chat-state.js';
import { cases, context, answer } from '../verification/ai-contract-eval/cases.mjs';

for (const item of cases) test(`grounding boundary: ${item.id}`, () => {
  const run = () => validateResult('review', item.candidate, item.context || context);
  if (item.good) assert.doesNotThrow(run); else assert.throws(run, error => error.status === 400);
});

const unknownBackgroundContext = { ...context, contexts: { T1: { source: '当时记录', reason: '分批建立仓位。', plan: '核对预算后再继续。' } } };
const unknownBackgroundAnswer = text => answer({ text, textEvidenceIds: ['background:T1'], evidenceIds: ['trade:T1', 'background:T1'] });
const recollectionContext = { ...unknownBackgroundContext, contexts: { T1: { ...unknownBackgroundContext.contexts.T1, source: '现在回忆' } } };

test('recollection and unknown-time interpretations share explicit proof and judgment limitations', () => {
  for (const input of [recollectionContext, unknownBackgroundContext]) {
    for (const text of ['仅凭用户回忆不能证明当时严格执行了分批计划。', '仅凭用户回忆无法证明当时已经知道公告。', '仅凭用户回忆无法判断买入的原因是分批计划。', '仅凭用户回忆不能判断用户当时是否掌握完整信息。']) {
      assert.doesNotThrow(() => validateResult('review', answer({ interpretations: [{ text, evidenceIds: ['background:T1'] }], evidenceIds: ['trade:T1', 'background:T1'] }), input));
      assert.doesNotThrow(() => validateResult('review', unknownBackgroundAnswer(text), input));
    }
  }
  assert.equal(buildEvidence(recollectionContext).find(item => item.id === 'background:T1').timeClass, 'recollection');
});

test('recollection still cannot prove certain knowledge, execution, causes, or psychological bias', () => {
  for (const text of ['用户当时严格执行了分批计划。', '用户当时知道公告。', '分批计划促使买入。', '用户存在过度自信。']) {
    assert.throws(() => validateResult('review', answer({ interpretations: [{ text, evidenceIds: ['background:T1'] }], evidenceIds: ['trade:T1', 'background:T1'] }), recollectionContext), /interpretations\[0\]：基于事后回忆的解释必须明确不确定性/);
  }
});

test('neutral recollection source facts and original trade facts do not require interpretation hedges', () => {
  assert.doesNotThrow(() => validateResult('review', answer({ facts: [{ text: '买入 500 股。', evidenceIds: ['trade:T1'] }, { text: '用户自述：分批建立仓位。', evidenceIds: ['background:T1'] }], evidenceIds: ['trade:T1', 'background:T1'] }), recollectionContext));
  assert.throws(() => validateResult('review', answer({ facts: [{ text: '当时严格执行了分批计划。', evidenceIds: ['background:T1'] }], evidenceIds: ['background:T1'] }), recollectionContext), /回忆只能支持用户陈述的事实/);
});

test('recollection repair guidance gives scoped valid examples and never repeats rejected output', () => {
  const marker = 'PRIVATE_REJECTED_RECOLLECTION';
  assert.throws(() => validateResult('review', answer({ interpretations: [{ text: `用户当时严格执行了分批计划。${marker}`, evidenceIds: ['background:T1'] }], evidenceIds: ['trade:T1', 'background:T1'] }), recollectionContext), error => {
    assert.match(error.message, /^interpretations\[0\]：/);
    assert.match(error.message, /仅凭用户回忆无法证明当时严格执行了计划/);
    assert.match(error.message, /中性来源转述可放入 facts/);
    assert.ok(!error.message.includes(marker));
    return true;
  });
  for (const text of ['仅凭用户回忆无法证明当时严格执行了计划', '根据用户回忆，可能与计划有关，仍需核实']) {
    assert.doesNotThrow(() => validateResult('review', answer({ interpretations: [{ text, evidenceIds: ['background:T1'] }], evidenceIds: ['trade:T1', 'background:T1'] }), recollectionContext));
  }
});

test('unknown note time permits narrowly attributed source statements without treating their contents as verified history', () => {
  for (const text of ['用户填写了分批计划。', '用户自述：分批建立仓位。', '记录写到：核对预算后再继续。', '用户填写了分批计划，记录时间未知。']) {
    const result = validateResult('review', unknownBackgroundAnswer(text), unknownBackgroundContext);
    assert.equal(result.text, text);
  }
  assert.equal(buildEvidence(unknownBackgroundContext).find(item => item.id === 'background:T1').timeClass, 'unknown');
  assert.doesNotThrow(() => validateResult('review', answer({ interpretations: [{ text: '用户填写了分批计划。', evidenceIds: ['background:T1'] }], evidenceIds: ['trade:T1', 'background:T1'] }), unknownBackgroundContext));
});

test('an attributed source prefix cannot remove uncertainty from causal or behavioral conclusions', () => {
  for (const text of ['用户填写了分批计划，因此用户当时严格执行计划。', '用户自述：分批计划促使买入。', '记录写到分批计划。用户当时已经知道后续会上涨。', '用户填写了分批计划，说明存在过度自信。', '用户当时严格执行了计划。']) {
    assert.throws(() => validateResult('review', unknownBackgroundAnswer(text), unknownBackgroundContext), /text：证据时点未知/);
  }
  assert.doesNotThrow(() => validateResult('review', unknownBackgroundAnswer('根据用户填写的计划，这笔交易可能与分批安排有关，仍需原始记录核实。'), unknownBackgroundContext));
});

test('source-statement exception stays limited to background references, not unknown events or market states', () => {
  const unknownEvent = { ...context, evidence: [{ ...context.evidence[0], publishedAt: null }] };
  assert.throws(() => validateResult('review', answer({ text: '用户填写了公告内容。', textEvidenceIds: ['event:notice'], evidenceIds: ['trade:T1', 'event:notice'] }), unknownEvent), /text：证据时点未知/);
  assert.throws(() => validateResult('review', unknownBackgroundAnswer('已经完成了计划。'), unknownBackgroundContext), /text：证据时点未知/);
});

test('claim repair diagnostics identify only the application field path and omit rejected model text', () => {
  const marker = 'REJECTED_MODEL_TEXT_MUST_NOT_LEAK';
  const check = (candidate, expectedPath) => assert.throws(() => validateResult('review', candidate, unknownBackgroundContext), error => {
    assert.equal(error.code, 'CONTRACT_VALIDATION'); assert.ok(error.message.startsWith(`${expectedPath}：`)); assert.ok(!error.message.includes(marker)); return true;
  });
  check(answer({ facts: [{ text: '买入 500 股。', evidenceIds: ['trade:T1'] }, { text: `净盈亏 999999 元。${marker}`, evidenceIds: ['trade:T1'] }] }), 'facts[1]');
  check(answer({ interpretations: [{ text: `用户当时严格执行了计划。${marker}`, evidenceIds: ['background:T1'] }], evidenceIds: ['trade:T1', 'background:T1'] }), 'interpretations[0]');
  check(answer({ learning: { title: '执行', trigger: '下次', action: `用户当时严格执行了计划。${marker}`, exception: '', evidenceIds: ['background:T1'] }, evidenceIds: ['trade:T1', 'background:T1'] }), 'learning');
});

test('visible conclusions keep their individual evidence numbers and learning owns its sources', () => {
  const evidence = buildEvidence(context);
  const normalized = normalizeReviewResult(answer({ text: '公告晚于成交，不能解释当时认知。', textEvidenceIds: ['event:notice'], facts: [{ text: '买入 500 股。', evidenceIds: ['trade:T1'] }], interpretations: [{ text: '公告晚于成交，不能证明当时知道。', evidenceIds: ['event:notice'] }], learning: { title: '核对来源时间', trigger: '决策前', action: '记录来源', exception: '事后材料不能代替当时依据', evidenceIds: ['event:notice'] }, evidence, evidenceIds: ['trade:T1', 'event:notice'] }), context);
  assert.match(normalized.text, /当时认知。 \[1\]/);
  assert.match(normalized.text, /买入 500 股。 \[2\]/);
  assert.match(normalized.text, /当时知道。 \[1\]/);
  assert.match(normalized.text, /检查项依据 \[1\]/);
  assert.deepEqual(normalized.refs.map(ref => [ref.evidenceId, ref.label]), [['event:notice', '[1] 11:30 公告'], ['trade:T1', '[2] 成交记录']]);
  assert.deepEqual(normalized.learning.evidenceIds, ['event:notice']);
  assert.doesNotMatch(normalized.text, /已核对的事实/);
  const noOwnRefs = normalizeReviewResult(answer({ evidence, learning: { title: '检查', trigger: '下次', action: '核对', exception: '' } }), context);
  assert.equal(noOwnRefs.learning, null);
});

async function localProvider(t, candidate, names = ['read_trades', 'read_evidence']) {
  let requests = 0;
  const server = createServer(async (req, res) => {
    for await (const _ of req) { /* Consume synthetic request, never persist it. */ }
    requests++;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunk = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: 'local-eval', object: 'chat.completion.chunk', created: 1, model: 'local-eval', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    chunk({ role: 'assistant' });
    if (requests === 1) {
      chunk({ tool_calls: names.map((name, index) => ({ index, id: `call-${name}`, type: 'function', function: { name, arguments: '{}' } })) });
      chunk({}, 'tool_calls');
    } else { chunk({ content: JSON.stringify(candidate) }); chunk({}, 'stop'); }
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { config: { provider: 'openai-compatible', auth: 'api', model: 'local-eval', apiKey: 'synthetic-contract-test', baseUrl: `http://127.0.0.1:${server.address().port}/v1` }, count: () => requests };
}

for (const id of ['main-text-future-without-own-refs', 'wrong-cited-quantity', 'direct-advice-paraphrase']) test(`Pi loop rejects baseline bad case: ${id}`, async t => {
  const { candidate } = cases.find(item => item.id === id);
  const provider = await localProvider(t, candidate);
  const events = [];
  await assert.rejects(runAgent({ task: 'review', config: provider.config, context, text: '请复盘这笔买入。', onEvent: event => events.push(event) }), { code: 'INVALID_RESULT' });
  assert.equal(provider.count(), 3, 'one bounded repair, then fail without a normal-looking answer');
  assert.ok(events.every(event => !JSON.stringify(event).includes(candidate.text)));
});

test('Pi loop requires the summary tool for valid numerical P/L and accepts it after reading', async t => {
  const item = cases.find(item => item.id === 'complete-cycle-correct-profit');
  const unread = await localProvider(t, item.candidate);
  await assert.rejects(runAgent({ task: 'review', config: unread.config, context: item.context, text: '核对这轮盈亏。' }), { code: 'INVALID_RESULT' });
  const read = await localProvider(t, item.candidate, ['read_trades', 'read_evidence', 'get_summary']);
  const result = await runAgent({ task: 'review', config: read.config, context: item.context, text: '核对这轮盈亏。' });
  assert.match(result.facts[0].text, /990/);
});
