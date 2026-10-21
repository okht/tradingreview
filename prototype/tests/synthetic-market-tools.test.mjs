import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildEvidence, validateContext, validateResult } from '../server/contracts.js';
import { createReviewTools } from '../server/review-tools.js';
import { createWorkspace, validateWorkspace } from '../src/agent-workspace-state.js';
const bundle = JSON.parse(await readFile(new URL('../public/fixtures/complete-synthetic-review.json', import.meta.url), 'utf8'));
const context = { trades: bundle.trades, contexts: {}, marketMode: 'import', origin: '合成行情验收', marketData: bundle.marketData };

test('synthetic market contracts reject ambiguous provenance and invalid observations', () => {
  for (const mutate of [x => x.synthetic = false, x => x.source = '真实行情', x => x.interval = '1D', x => x.symbol = '600001.SH', x => x.pricePoints.reverse(), x => x.pricePoints[0].price = 0,
    x => x.pricePoints[0].time += 1, x => x.pricePoints[0].time -= 3600, x => x.pricePoints.push(x.pricePoints[0])]) {
    const changed = structuredClone(bundle.marketData); mutate(changed);
    assert.throws(() => validateContext({ ...context, marketData: changed }));
  }
  const changed = structuredClone(context); changed.marketData.symbol = 'SIM_NEXT'; changed.trades.forEach(trade => trade.symbol = 'SIM_NEXT');
  assert.equal(validateContext(changed).marketData.symbol, 'SIM_NEXT');
});

test('read_market returns cutoff OHLC and excludes future observations unless requested', async () => {
  const tool = createReviewTools(context).find(item => item.name === 'read_market');
  const trade = context.trades[15], args = { tradeId: trade.id };
  const result = (await tool.execute('test', args)).details;
  assert.equal(result.synthetic, true); assert.equal(result.interval, '4H');
  assert.equal(result.currentBar.ohlc.close, trade.price);
  assert.equal(result.after.returnedBars, 0); assert.deepEqual(result.after.bars, []);
  const cutoff = Date.parse(`${trade.time}+08:00`);
  assert.ok(result.before.bars.every(bar => Date.parse(bar.endAt) <= cutoff));
  const full = (await tool.execute('test', { ...args, includeAfter: true })).details;
  assert.ok(full.after.returnedBars > 0);
});

test('synthetic evidence must remain labeled in claims and saved messages', () => {
  const clean = validateContext(context), evidence = buildEvidence(clean).find(item => item.marketState === 'synthetic-current');
  const answer = { text: '继续核对', facts: [{ text: '当时真实价格已确认。', evidenceIds: [evidence.id] }], interpretations: [], uncertainties: [], suggestions: [], learning: null, evidenceIds: [evidence.id] };
  assert.throws(() => validateResult('review', answer, clean), /合成/);
  answer.facts[0].text = '合成行情记录了当时的价格状态。';
  assert.doesNotThrow(() => validateResult('review', answer, clean));
  const workspace = createWorkspace(), conversation = workspace.conversations[0];
  Object.assign(conversation, { trades: bundle.trades, marketData: bundle.marketData, selectedIds: bundle.trades.map(t => t.id), origin: '合成资料' });
  conversation.messages = [{ id: 'synthetic-answer', role: 'assistant', text: '合成行情', createdAt: new Date().toISOString(), evidence: [evidence] }];
  const restored = validateWorkspace(workspace);
  assert.equal(restored.conversations[0].marketData.synthetic, true);
  assert.equal(restored.conversations[0].messages[0].evidence[0].synthetic, true);
});
