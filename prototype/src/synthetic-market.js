import { tokens } from '@okht/huikan-design-system/tokens';

// Imported, explicitly synthetic observations. Replay aggregates only the
// observed prefix; it never derives a past state from a final candle.
const INTERVALS = ['15m', '4H', '1D', '1W', '1M'];
function seconds(value) {
  if (typeof value === 'number') return Number.isFinite(value) && Number.isFinite(new Date(value * 1000).getTime()) ? value : NaN;
  if (typeof value !== 'string') return NaN;
  const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?$/.exec(value);
  if (!match) return NaN;
  const [, day, hour, minute, second = '00', fraction = '', offset = '+08:00'] = match;
  const date = new Date(`${day}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== day || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return NaN;
  return Date.parse(`${day}T${hour}:${minute}:${second}${fraction}${offset}`) / 1000;
}
const local = time => `${new Date((time + 28800) * 1000).toISOString().slice(0, 19)}+08:00`;
const dayOf = time => local(time).slice(0, 10);
function inSession(time) {
  if (!Number.isFinite(time) || !Number.isFinite(new Date((time + 28800) * 1000).getTime())) return false;
  const stamp = local(time), clock = stamp.slice(11, 19), weekday = new Date((time + 28800) * 1000).getUTCDay();
  return weekday !== 0 && weekday !== 6 && (clock >= '09:30:00' && clock <= '11:30:00' || clock >= '13:00:00' && clock <= '15:00:00');
}

export function isSyntheticMarketData(data, trades = []) {
  return data?.provider === 'synthetic' && data.synthetic === true && data.status === 'ok'
    && data.interval === '5m' && data.currency === 'CNY' && data.timeZone === 'Asia/Shanghai'
    && data.adjust === 'none' && Array.isArray(data.pricePoints) && data.pricePoints.length > 0
    && trades.length > 0 && trades.every(trade => trade.symbol === data.symbol);
}

function period(time, interval) {
  const stamp = local(time), day = stamp.slice(0, 10);
  if (interval === '15m') {
    // Right-closed session buckets: the 09:45 observation closes 09:30–09:45.
    // Session open belongs to the first bucket; lunch never creates a bar.
    const start = seconds(`${day}T${stamp.slice(11, 16) <= '11:30' ? '09:30' : '13:00'}:00+08:00`);
    return start + Math.max(0, Math.ceil((time - start) / 900) - 1) * 900;
  }
  if (interval === '4H') return seconds(`${day}T${stamp.slice(11, 16) < '12:00' ? '08:00' : '12:00'}:00+08:00`);
  if (interval === '1D') return day;
  if (interval === '1M') return `${day.slice(0, 7)}-01`;
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
  return date.toISOString().slice(0, 10);
}

function bounds(key, interval) {
  if (interval === '15m') return [key, key + 900];
  if (interval === '4H') return [key, key + 14400];
  let endDay = key;
  const date = new Date(`${key}T00:00:00Z`);
  if (interval === '1W') { date.setUTCDate(date.getUTCDate() + 4); endDay = date.toISOString().slice(0, 10); }
  if (interval === '1M') {
    date.setUTCMonth(date.getUTCMonth() + 1); date.setUTCDate(0);
    while ([0, 6].includes(date.getUTCDay())) date.setUTCDate(date.getUTCDate() - 1);
    endDay = date.toISOString().slice(0, 10);
  }
  return [seconds(`${key}T09:30:00+08:00`), seconds(`${endDay}T15:00:00+08:00`)];
}

export function selectSyntheticChartData({ trades = [], marketData, cutoff, showFuture = true, interval = '4H' }) {
  const empty = { candles: [], markers: [], currentBar: null };
  if (!isSyntheticMarketData(marketData, trades) || !INTERVALS.includes(interval)) return empty;
  const limited = !showFuture && cutoff !== undefined && cutoff !== null && cutoff !== '';
  const limit = limited ? seconds(cutoff) : Infinity;
  if (limited && !Number.isFinite(limit)) return empty;
  // Saved bundles are validated at the boundary. Keep this display adapter
  // defensive as well: invalid dates must never throw or create marker days.
  const points = marketData.pricePoints.filter(point => point && Number.isSafeInteger(point.time) && point.time % 300 === 0
    && Number.isFinite(point.price) && point.price > 0 && point.time <= limit && inSession(point.time)
    && (!marketData.from || dayOf(point.time) >= marketData.from) && (!marketData.to || dayOf(point.time) <= marketData.to))
    .sort((a, b) => a.time - b.time);
  const groups = new Map();
  for (const point of points) {
    const key = period(point.time, interval);
    const previous = groups.get(key);
    if (previous) {
      previous.high = Math.max(previous.high, point.price); previous.low = Math.min(previous.low, point.price);
      previous.close = point.price; previous.last = point.time;
    } else groups.set(key, { time: key, open: point.price, high: point.price, low: point.price, close: point.price, first: point.time, last: point.time });
  }
  const candles = [...groups.values()].map(({ first, last, ...bar }) => {
    const [start, end] = bounds(bar.time, interval), isPartial = limit < end;
    return { ...bar, startAt: local(start), endAt: local(end), sourceFrom: ['15m', '4H'].includes(interval) ? local(first) : dayOf(first), sourceTo: ['15m', '4H'].includes(interval) ? local(last) : dayOf(last),
      lastObservedAt: local(last), ...(isPartial ? { isPartial: true, asOf: local(limit) } : {}) };
  });
  const visible = new Set(candles.map(bar => bar.time));
  const knownDays = new Set(points.map(point => dayOf(point.time)));
  const markers = trades.map(trade => ({ trade, time: seconds(trade.time) }))
    .filter(({ trade, time }) => Number.isFinite(time) && time <= limit && inSession(time) && knownDays.has(dayOf(time)) && ['buy', 'sell'].includes(trade.side) && visible.has(period(time, interval)))
    .sort((a, b) => a.time - b.time).map(({ trade, time }) => ({ id: trade.id, time: period(time, interval), position: trade.side === 'buy' ? 'belowBar' : 'aboveBar',
      color: trade.side === 'buy' ? tokens['chart-up'] : tokens['chart-down'], shape: trade.side === 'buy' ? 'arrowUp' : 'arrowDown', text: trade.side === 'buy' ? 'B' : 'S', size: 1 }));
  const current = candles.at(-1);
  const currentBar = current?.isPartial ? { time: current.time, asOf: current.asOf, lastObservedAt: current.lastObservedAt, status: 'partial',
    ohlc: { open: current.open, high: current.high, low: current.low, close: current.close } } : null;
  return { candles, markers, currentBar };
}
