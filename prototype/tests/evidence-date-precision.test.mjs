import test from 'node:test';
import assert from 'node:assert/strict';
import { recordManualEvidence } from '../server/financial-sources.js';
import { buildEvidence, validateContext, validateResult } from '../server/contracts.js';
import { normalizeExternalEvidence } from '../server/evidence-retrieval.js';
import { createReviewTools } from '../server/review-tools.js';

const trades = [{ id: 'T1', symbol: '600519.SH', name: '测试标的', time: '2025-09-08T10:00', side: 'buy', quantity: 100, price: 100, fee: 5 }];
const now = () => new Date('2025-10-21T02:30:45Z');
const input = publishedAt => ({
  trades,
  event: { tradeId: 'T1', title: '用户提供的原文', text: '原始材料内容', source: '公司公告', publishedAt },
});

test('date-only manual evidence survives storage and the agent tool without an invented midnight', async () => {
  const saved = recordManualEvidence(input('2025-09-08'), { now, randomUUID: () => 'date-only' });
  assert.equal(saved.evidence.publishedAt, '2025-09-08');
  assert.equal(saved.evidence.recordedAt, '2025-10-21T02:30:45Z');
  const context = validateContext({ trades, evidence: [saved.evidence] });
  assert.equal(context.evidence[0].publishedAt, '2025-09-08');
  const tool = createReviewTools(context).find(item => item.name === 'read_evidence');
  const result = await tool.execute('read-date-only', { decisionAt: trades[0].time });
  const evidence = result.details.evidence.find(item => item.type === 'event');
  assert.equal(evidence.publishedAt, '2025-09-08');
  assert.equal(evidence.timeClass, 'unknown');
  assert.match(result.details.limitations.join(' '), /unknown.*不能作为当时已知信息的证明/);
});

test('date-only publication cannot justify a certain decision explanation, while minute times preserve their boundary', () => {
  const saved = recordManualEvidence(input('2025-09-08'), { now, randomUUID: () => 'date-only' });
  const context = { trades, evidence: [saved.evidence] };
  const review = {
    text: '材料只有发布日期，无法确认成交时是否已经公开。', textEvidenceIds: ['event:date-only'],
    facts: [], interpretations: [{ text: '这条公告直接解释了成交。', evidenceIds: ['event:date-only'] }],
    uncertainties: [], suggestions: [], learning: null, evidenceIds: ['event:date-only'],
  };
  assert.throws(() => validateResult('review', review, context), /证据时点未知/);
  review.interpretations[0].text = '这条公告可能有关，但无法确认成交时已经公开。';
  assert.equal(validateResult('review', review, context).interpretations.length, 1);

  for (const [publishedAt, expected] of [['2025-09-08T09:59', 'before'], ['2025-09-08T10:01', 'after']]) {
    const evidence = recordManualEvidence(input(publishedAt), { now, randomUUID: () => 'minute' }).evidence;
    assert.equal(evidence.publishedAt, publishedAt);
    assert.equal(buildEvidence({ trades, evidence: [evidence] }).find(item => item.type === 'event').timeClass, expected);
  }
});

test('external date-only fields retain the provider precision and invalid calendar dates stay unknown', () => {
  const result = normalizeExternalEvidence({ structuredContent: { data: [
    { title: '日期精度', content: '原文', publish_date: '2025-09-08', thscode: '600519.SH' },
    { title: '错误日期', content: '原文', publish_date: '2025-02-29', thscode: '600519.SH' },
  ] } }, { provider: 'fuyao', toolName: 'lookup', trades, now });
  assert.equal(result.events[0].publishedAt, '2025-09-08');
  assert.equal(result.events[1].publishedAt, null);
  assert.deepEqual(result.evidence.map(item => item.timeClass), ['unknown', 'unknown']);
});
