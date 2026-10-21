import test from 'node:test';
import assert from 'node:assert/strict';
import { SIDEBAR_LAYOUT_KEY, clampSidebarWidth, normalizeSidebarPreferences, readSidebarPreferences, sidebarWidthForKey } from '../src/sidebar-layout.js';

test('sidebar preferences recover safely from missing, corrupt, and inaccessible storage', () => {
  for (const value of [null, 'bad-json', 'null', '[]', '"wide"', '{"width":"360","collapsed":"true"}']) {
    assert.deepEqual(readSidebarPreferences({ getItem: key => { assert.equal(key, SIDEBAR_LAYOUT_KEY); return value; } }), { width: 248, collapsed: false });
  }
  assert.deepEqual(readSidebarPreferences({ getItem() { throw new Error('Storage blocked'); } }), { width: 248, collapsed: false });
  assert.deepEqual(readSidebarPreferences(undefined), { width: 248, collapsed: false });
});

test('sidebar width clamps drag and saved values while preserving the independent collapsed preference', () => {
  assert.equal(clampSidebarWidth(100), 220);
  assert.equal(clampSidebarWidth(500), 360);
  assert.equal(clampSidebarWidth(277.8), 278);
  for (const invalid of [NaN, Infinity, -Infinity, undefined, null, '300']) assert.equal(clampSidebarWidth(invalid), 248);
  assert.deepEqual(normalizeSidebarPreferences({ width: 999, collapsed: true, extra: 'drop' }), { width: 360, collapsed: true });
  assert.deepEqual(normalizeSidebarPreferences({ width: 300, collapsed: false }), { width: 300, collapsed: false });
  assert.deepEqual(normalizeSidebarPreferences({ width: 72, collapsed: true }), { width: 220, collapsed: true });
  assert.deepEqual(readSidebarPreferences({ getItem: () => '{"width":312,"collapsed":true}' }), { width: 312, collapsed: true });
});

test('keyboard resizing uses 16 pixel steps and respects both endpoints', () => {
  assert.equal(sidebarWidthForKey(248, 'ArrowLeft'), 232);
  assert.equal(sidebarWidthForKey(248, 'ArrowRight'), 264);
  assert.equal(sidebarWidthForKey(225, 'ArrowLeft'), 220);
  assert.equal(sidebarWidthForKey(355, 'ArrowRight'), 360);
  assert.equal(sidebarWidthForKey(220, 'ArrowLeft'), 220);
  assert.equal(sidebarWidthForKey(360, 'ArrowRight'), 360);
  assert.equal(sidebarWidthForKey(300, 'Home'), 220);
  assert.equal(sidebarWidthForKey(300, 'End'), 360);
  for (const key of ['ArrowUp', 'ArrowDown', 'Tab', 'Escape', 'Enter']) assert.equal(sidebarWidthForKey(248, key), null);
});
