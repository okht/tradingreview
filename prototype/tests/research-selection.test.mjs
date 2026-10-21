import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { executeResearch } from '../server/research-service.js';
import { validateMethod, improveMethod } from '../server/strategy-engine.js';
import { executeResearchWorkflow } from '../src/research-workflow.js';
import { saveMethodVersions } from '../src/research-state.js';

// Pure deterministic calls over the committed synthetic fixture; no model,
// network, workspace writes or trading operations are used.
const bundle = JSON.parse(await readFile(new URL('../public/fixtures/complete-synthetic-review.json', import.meta.url), 'utf8'));
const context = { trades: bundle.trades, marketData: bundle.marketData, contexts: {}, marketMode: 'import', origin: '构造回归数据' };
const assumptions = { initialCapital: 500000, feeBps: 3, slippageBps: 5, lotSize: 100 };
function fixture() {
  const original = validateMethod({ id: 'selection-original', title: '原规则', origin: 'user-described', rules: { kind: 'trend', lookback: 5, entryDeviationPct: .5, exitDeviationPct: 0, allocationPct: 80 } });
  const generated = executeResearch({ context, assumptions, research: { methods: [original], assumptions }, intent: { action: 'improve', methodId: original.id } });
  return { original, proposal: generated.research.methods.at(-1), research: generated.research };
}
const input = (data, intent) => ({ context, assumptions, research: data.research, methods: [], intent: { action: 'save_improved', methodId: data.proposal.id, ...intent } });

test('selecting only stop loss from a three-change proposal reuses its original and excludes unselected changes', () => {
  const data = fixture(), before = structuredClone(data);
  assert.equal(data.proposal.rules.allocationPct, 50); assert.equal(data.proposal.rules.maxHoldBars, 20);
  const result = executeResearch(input(data, { changeIds: ['stop-loss'] }));
  assert.deepEqual(result.savedMethod.rules, { ...data.original.rules, stopLossPct: 8 });
  assert.equal(result.savedMethod.parentId, data.original.id);
  assert.equal(result.savedMethod.version, data.original.version + 1);
  assert.deepEqual(result.research.methods.map(method => method.id), [data.original.id, result.savedMethod.id]);
  assert.deepEqual(data, before);
});

test('selecting the original or its proposal produces the same selected version and rule replay', () => {
  const data = fixture();
  const fromOriginal = executeResearch(input(data, { methodId: data.original.id, changeIds: ['stop-loss'] }));
  const fromProposal = executeResearch(input(data, { changeIds: ['stop-loss'] }));
  assert.deepEqual(fromProposal.savedMethod, fromOriginal.savedMethod);
  assert.deepEqual(fromProposal.research.comparison, fromOriginal.research.comparison);
});

test('each selected subset excludes all other proposed constraints', () => {
  const data = fixture();
  for (const [changeIds, patch] of [[['position'], { allocationPct: 50 }], [['max-hold'], { maxHoldBars: 20 }], [['position', 'stop-loss'], { allocationPct: 50, stopLossPct: 8 }]]) {
    const result = executeResearch(input(data, { changeIds }));
    assert.deepEqual(result.savedMethod.rules, { ...data.original.rules, ...patch });
  }
});

test('partial improvement uses the same parent when only previewing and never returns a save receipt', () => {
  const data = fixture(), result = executeResearch(input(data, { action: 'improve', changeIds: ['stop-loss'] }));
  assert.equal(result.savedMethod, null);
  assert.deepEqual(result.research.methods.at(-1).rules, { ...data.original.rules, stopLossPct: 8 });
  assert.equal(result.research.methods.at(-1).parentId, data.original.id);
});

test('missing or self-referencing proposal parents explicitly reject partial adoption', () => {
  const data = fixture();
  for (const proposal of [data.proposal, { ...data.proposal, parentId: data.proposal.id }]) {
    assert.throws(() => executeResearch({ ...input(data, { changeIds: ['stop-loss'] }), research: { ...data.research, methods: [proposal] } }), error => error.status === 400 && /对应的原版本/.test(error.message));
  }
});

test('a parent in the saved library is resolved without requiring a duplicate research card', () => {
  const data = fixture();
  const result = executeResearch({ ...input(data, { changeIds: ['stop-loss'] }), research: { ...data.research, methods: [data.proposal] }, methods: [data.original] });
  assert.equal(result.savedMethod.parentId, data.original.id);
  assert.deepEqual(result.savedMethod.rules, { ...data.original.rules, stopLossPct: 8 });
});

test('whole-proposal adoption without a subset keeps the exact proposal', () => {
  const data = fixture(), result = executeResearch(input(data));
  assert.deepEqual(result.savedMethod, data.proposal);
});

test('a later proposal is based on its declared parent version and does not reset previously accepted rules', () => {
  const data = fixture();
  const accepted = validateMethod(improveMethod(data.original, ['stop-loss']));
  const later = validateMethod(improveMethod(accepted));
  const result = executeResearch({ ...input(data, { methodId: later.id, changeIds: ['position'] }), research: { ...data.research, methods: [data.original, accepted, later] } });
  assert.equal(result.savedMethod.parentId, accepted.id);
  assert.deepEqual(result.savedMethod.rules, { ...accepted.rules, allocationPct: 50 });
  assert.equal(result.savedMethod.rules.maxHoldBars, null);
});

test('UI workflow saves original plus the selected subset and compares those exact versions at shared costs', async () => {
  const data = fixture();
  const result = await executeResearchWorkflow(input(data, { changeIds: ['stop-loss'], title: '只加止损版' }), async body => executeResearch(body));
  const library = saveMethodVersions([], result.savedMethods), comparison = result.research.comparison;
  assert.equal(library.length, 2); assert.equal(library[0].id, data.original.id);
  assert.equal(library[1].parentId, data.original.id); assert.equal(library[1].title, '只加止损版');
  assert.deepEqual(library[0].rules, data.original.rules);
  assert.deepEqual(library[1].rules, { ...data.original.rules, stopLossPct: 8 });
  assert.equal(comparison.mode, 'method-pair'); assert.equal(comparison.status, 'ok');
  assert.equal(comparison.baseline.methodId, library[0].id); assert.equal(comparison.alternative.methodId, library[1].id);
  assert.deepEqual(comparison.baseline.assumptions, comparison.alternative.assumptions);
  assert.equal(comparison.assumptions.initialCapital, 500000);
});
