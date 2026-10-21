import test from 'node:test';
import assert from 'node:assert/strict';
import { CHART_PERIODS, CHART_PREFERENCES_KEY, readChartPreferences, rememberChartPeriod, saveChartFavorites } from '../src/chart-preferences.js';

const available = ['4H', '1D', '1W', '1M'];
function storage(seed) {
  const values = new Map(seed ? [[CHART_PREFERENCES_KEY, seed]] : []);
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), values };
}

test('defaults remain independent and include all nine known periods', () => {
  assert.equal(CHART_PERIODS.length, 9);
  assert.deepEqual(readChartPreferences(null), { favorites: available, selected: '4H' });
  const first = readChartPreferences(null);
  first.favorites.pop();
  assert.deepEqual(readChartPreferences(null).favorites, available);
});

test('corrupt storage, empty favorites, duplicates and unknown periods recover safely', () => {
  assert.deepEqual(readChartPreferences(storage('{broken')).favorites, available);
  const stored = storage(JSON.stringify({ version: 1, favorites: ['1M', 'invalid', '1M', '1D'], selected: 'bad' }));
  assert.deepEqual(readChartPreferences(stored), { favorites: ['1M', '1D'], selected: '4H' });
  assert.deepEqual(readChartPreferences(storage(JSON.stringify({ version: 1, favorites: [], selected: '1W' }))), { favorites: available, selected: '1W' });
});

test('remembering a period preserves favorites and touches only the chart key', () => {
  const stored = storage(JSON.stringify({ version: 1, favorites: ['1M', '1D'], selected: '4H' }));
  stored.values.set('huikan-prototype-v1', 'existing-review');
  assert.equal(rememberChartPeriod('1W', stored), true);
  assert.deepEqual(readChartPreferences(stored), { favorites: ['1M', '1D'], selected: '1W' });
  assert.equal(stored.getItem('huikan-prototype-v1'), 'existing-review');
  assert.equal(rememberChartPeriod('invalid', stored), false);
  assert.equal(readChartPreferences(stored).selected, '1W');
});

test('favorites save exact order without changing the latest selected period', () => {
  const stored = storage();
  rememberChartPeriod('1W', stored);
  assert.equal(saveChartFavorites(['1M', '4H'], available, stored), true);
  assert.deepEqual(readChartPreferences(stored), { favorites: ['1M', '4H'], selected: '1W' });
});

test('favorites reject empty, duplicate, invalid or unavailable new entries', () => {
  const stored = storage();
  for (const favorites of [[], ['1D', '1D'], ['bad'], ['1m'], ['1D', '1H']]) {
    assert.equal(saveChartFavorites(favorites, available, stored), false);
  }
  assert.equal(stored.getItem(CHART_PREFERENCES_KEY), null);
  assert.equal(saveChartFavorites(['1m'], ['1m'], stored), true);
});

test('existing favorites may remain when a dataset has no matching data', () => {
  const stored = storage(JSON.stringify({ version: 1, favorites: ['1D', '1W'], selected: '1D' }));
  assert.equal(saveChartFavorites(['1W', '1D'], [], stored), true);
  assert.equal(saveChartFavorites(['1W', '1D', '1M'], [], stored), false);
});

test('editing a detached draft has no effect until save and defaults can be restored', () => {
  const stored = storage(JSON.stringify({ version: 1, favorites: ['1M', '1D'], selected: '1D' }));
  const draft = [...readChartPreferences(stored).favorites];
  draft.reverse();
  assert.deepEqual(readChartPreferences(stored).favorites, ['1M', '1D']);
  assert.equal(saveChartFavorites(available, available, stored), true);
  assert.deepEqual(readChartPreferences(stored), { favorites: available, selected: '1D' });
});

test('denied, full or silently failing storage never reports success', () => {
  const denied = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  const full = { getItem() { return null; }, setItem() { throw new Error('quota'); } };
  const silent = { getItem() { return null; }, setItem() {} };
  for (const unavailable of [null, denied, full, silent]) {
    assert.equal(rememberChartPeriod('1D', unavailable), false);
    assert.equal(saveChartFavorites(['1D'], available, unavailable), false);
  }
});
