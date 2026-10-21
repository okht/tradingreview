import test from 'node:test';
import assert from 'node:assert/strict';
import { currentTradePatch, scopeSelectionPatch } from '../src/review-material-state.js';
import { createWorkspace, validateWorkspace } from '../src/agent-workspace-state.js';

const first = { id: 'TRADE-1', symbol: '600001', name: '测试标的', time: '2025-09-02T09:45', side: 'buy', quantity: 100, price: 40, fee: 5 };
const second = { ...first, id: 'TRADE-2', time: '2025-09-03T09:45', side: 'sell', price: 42 };
function conversation() {
  return { ...createWorkspace().conversations[0], trades: [first, second], selectedIds: [first.id, second.id], contextRevision: 3, origin: '用户上传 CSV',
    contexts: { [first.id]: { reason: '保留理由', source: '现在回忆', noPlan: true } },
    evidence: [{ id: 'EVENT-1', tradeId: first.id, type: 'event', title: '原文', text: '原始内容', source: '用户录入', publishedAt: null, recordedAt: '2025-09-05T03:00Z' }] };
}

test('confirming a range preserves all records and draft selection cannot alter current material', () => {
  const source = conversation(); const before = structuredClone(source);
  const draft = [...source.selectedIds]; draft.splice(0, 1);
  assert.deepEqual(source, before);
  const patch = scopeSelectionPatch(source, draft);
  assert.deepEqual(patch, { selectedIds: [second.id], contextRevision: 4 });
  assert.deepEqual(source, before);
  assert.throws(() => scopeSelectionPatch(source, []), /至少选择一笔/);
  assert.throws(() => scopeSelectionPatch(source, ['missing']), /不在当前复盘/);
  assert.throws(() => scopeSelectionPatch(source, [first.id], [first.id]), /范围已更新/);
});

test('editing an execution preserves stable identity, associations and hidden notes through persistence', () => {
  const source = conversation(); const before = structuredClone(source);
  const patch = currentTradePatch(source, first.id, { id: 'attempted-change', symbol: 'OTHER', name: 'wrong', price: '41.25', quantity: '200', fee: '' }, first);
  assert.equal(patch.trades[0].id, first.id);
  assert.equal(patch.trades[0].symbol, first.symbol);
  assert.equal(patch.trades[0].name, first.name);
  assert.equal(patch.trades[0].price, 41.25);
  assert.equal(patch.trades[0].quantity, 200);
  assert.equal(patch.trades[0].fee, null);
  assert.equal(patch.contextRevision, 4);
  const workspace = createWorkspace();
  workspace.conversations[0] = { ...source, ...patch }; workspace.activeId = source.id;
  const saved = validateWorkspace(JSON.parse(JSON.stringify(workspace))).conversations[0];
  assert.deepEqual(saved.selectedIds, source.selectedIds);
  assert.equal(saved.contexts[first.id].reason, '保留理由');
  assert.equal(saved.contexts[first.id].noPlan, true);
  assert.equal(saved.evidence[0].tradeId, first.id);
  assert.deepEqual(source, before);
});

test('time corrections reorder the list without changing links, invalid or stale updates fail atomically', () => {
  const source = conversation();
  const patch = currentTradePatch(source, first.id, { time: '2025-09-04T10:00' });
  assert.deepEqual(patch.trades.map(item => item.id), [second.id, first.id]);
  assert.throws(() => currentTradePatch(source, first.id, { quantity: '-1' }), /成交数量/);
  assert.throws(() => currentTradePatch(source, first.id, { time: '2025-02-30T10:00' }), /成交日期/);
  assert.throws(() => currentTradePatch(source, first.id, { ...second }), /重复/);
  assert.throws(() => currentTradePatch(source, first.id, { price: '41' }, { ...first, price: 39 }), /记录已更新/);
  assert.equal(source.trades[0].price, 40);
});
