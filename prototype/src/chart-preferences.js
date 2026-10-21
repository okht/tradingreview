export const CHART_PERIODS = Object.freeze([
  { id: '1m', label: '1分钟' }, { id: '5m', label: '5分钟' },
  { id: '15m', label: '15分钟' }, { id: '30m', label: '30分钟' },
  { id: '1H', label: '1小时' }, { id: '4H', label: '4小时' },
  { id: '1D', label: '日 K' }, { id: '1W', label: '周 K' }, { id: '1M', label: '月 K' },
]);

export const CHART_PREFERENCES_KEY = 'huikan-chart-preferences-v1';
export const CHART_PREFERENCES_EVENT = 'huikan-chart-preferences-change';
export const DEFAULT_CHART_FAVORITES = Object.freeze(['4H', '1D', '1W', '1M']);
const validIds = new Set(CHART_PERIODS.map(period => period.id));
const defaults = () => ({ favorites: [...DEFAULT_CHART_FAVORITES], selected: '4H' });

function browserStorage() {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

export function readChartPreferences(storage = browserStorage()) {
  try {
    const stored = JSON.parse(storage?.getItem(CHART_PREFERENCES_KEY) ?? 'null');
    if (!stored || stored.version !== 1) return defaults();
    const favorites = Array.isArray(stored.favorites)
      ? [...new Set(stored.favorites.filter(id => validIds.has(id)))] : [];
    return {
      favorites: favorites.length ? favorites : [...DEFAULT_CHART_FAVORITES],
      selected: validIds.has(stored.selected) ? stored.selected : '4H',
    };
  } catch { return defaults(); }
}

function persist(preferences, storage) {
  if (!storage) return false;
  try {
    const serialized = JSON.stringify({ version: 1, ...preferences });
    storage.setItem(CHART_PREFERENCES_KEY, serialized);
    if (storage.getItem(CHART_PREFERENCES_KEY) !== serialized) return false;
  } catch { return false; }
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(CHART_PREFERENCES_EVENT));
  return true;
}

export function rememberChartPeriod(id, storage = browserStorage()) {
  if (!validIds.has(id)) return false;
  return persist({ ...readChartPreferences(storage), selected: id }, storage);
}

export function saveChartFavorites(favorites, available, storage = browserStorage()) {
  if (!Array.isArray(favorites) || !favorites.length || !Array.isArray(available)) return false;
  if (new Set(favorites).size !== favorites.length || favorites.some(id => !validIds.has(id))) return false;
  const current = readChartPreferences(storage);
  // Existing preferences survive a dataset change. New entries require data.
  if (favorites.some(id => !current.favorites.includes(id) && !available.includes(id))) return false;
  return persist({ ...current, favorites: [...favorites] }, storage);
}
