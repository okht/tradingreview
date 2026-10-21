import test from 'node:test';
import assert from 'node:assert/strict';
import { paginationItems, paginationWindow } from '../src/pagination.js';
import { importGroups } from '../src/import-dialog-state.js';

test('ten-record pages visit each of 500 executions exactly once', () => {
  const rows = Array.from({ length: 500 }, (_, id) => ({ id }));
    const visited = [];
    for (let page = 1; page <= paginationWindow(rows.length).pageCount; page++) {
      const { start, end } = paginationWindow(rows.length, page);
      assert.equal(end - start, 10);
      visited.push(...rows.slice(start, end).map(row => row.id));
    }
    assert.deepEqual(visited, rows.map(row => row.id));
});

test('page offsets still address the original execution in interleaved account groups', () => {
  const rows = Array.from({ length: 42 }, (_, id) => ({ id: `T${id}`, symbol: 'SIM086', accountId: id % 2 ? 'B' : 'A' }));
  const group = importGroups(rows).find(item => item.account === 'B');
  const { start, end } = paginationWindow(group.trades.length, 2, 10);
  const displayed = group.trades.slice(start, end);
  displayed.forEach((trade, row) => assert.equal(rows[group.indices[start + row]].id, trade.id));
  assert.equal(rows[group.indices[start]].id, 'T21');
  assert.equal(rows.length, 42);
});

test('deleting the last execution on the last page selects the preceding valid page', () => {
  const before = paginationWindow(41, 5, 10);
  const after = paginationWindow(40, before.page, 10);
  assert.equal(after.page, 4);
  assert.equal(after.end - after.start, 10);
  assert.deepEqual(paginationWindow(0, 5, 10), { page: 1, pageSize: 10, pageCount: 1, start: 0, end: 0 });
});

test('large lists always retain the current, first and last page without unbounded controls', () => {
  for (let page = 1; page <= 50; page++) {
    const items = paginationItems(page, 50);
    assert.ok(items.includes(page)); assert.ok(items.includes(1)); assert.ok(items.includes(50));
    assert.ok(items.length <= 7); assert.equal(new Set(items).size, items.length);
  }
});
