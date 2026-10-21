import { isSyntheticMarketData, selectSyntheticChartData } from './synthetic-market.js';
import { tokens } from '@okht/huikan-design-system/tokens';

// Fictional daily OHLC for the DEMO001 walkthrough. These are constructed
// candles, not downloaded prices and not inferred from imported executions.
export const sampleCandles = Object.freeze([
  { time: '2025-09-01', open: 39.6, high: 39.9, low: 38.9, close: 39.3 },
  { time: '2025-09-02', open: 39.6, high: 40.8, low: 39.3, close: 40.2 },
  { time: '2025-09-03', open: 40.3, high: 40.6, low: 39.4, close: 39.7 },
  { time: '2025-09-04', open: 39.8, high: 40.8, low: 39.5, close: 40.4 },
  { time: '2025-09-05', open: 40.5, high: 41.6, low: 40.2, close: 41.1 },
  { time: '2025-09-08', open: 41.5, high: 43.0, low: 41.2, close: 42.7 },
  { time: '2025-09-09', open: 42.8, high: 43.8, low: 42.4, close: 43.4 },
  { time: '2025-09-10', open: 43.5, high: 43.9, low: 42.6, close: 42.9 },
  { time: '2025-09-11', open: 43.0, high: 44.5, low: 42.8, close: 44.1 },
  { time: '2025-09-12', open: 44.2, high: 44.6, low: 43.2, close: 43.6 },
  { time: '2025-09-15', open: 43.9, high: 45.7, low: 43.6, close: 45.3 },
  { time: '2025-09-16', open: 45.4, high: 45.8, low: 44.5, close: 44.9 },
  { time: '2025-09-17', open: 45.0, high: 46.9, low: 44.8, close: 46.5 },
  { time: '2025-09-18', open: 46.4, high: 46.9, low: 45.6, close: 46.2 },
].map(Object.freeze));

/**
 * Fictional 4-hour demonstration windows, not a broker's official bar scheme.
 * 08:00–12:00 covers the 09:30–11:30 session; 12:00–16:00 covers 13:00–15:00.
 * Window boundaries, including conservative availability at endAt, are in
 * Asia/Shanghai. No lunch, overnight, or weekend market activity is invented.
 * These explicitly constructed samples are designed to reconcile to daily OHLC.
 */
export const sampleFourHourCandles = Object.freeze(sampleCandles.flatMap((day) => {
  const round = (value) => Math.round(value * 100) / 100;
  const middle = round((day.open + day.close) / 2);
  const rising = day.close >= day.open;
  const windowBar = (start, end, sourceStart, sourceEnd, ohlc) => {
    const startAt = `${day.time}T${start}:00+08:00`;
    return Object.freeze({
      time: Date.parse(startAt) / 1000,
      ...ohlc,
      startAt,
      endAt: `${day.time}T${end}:00+08:00`,
      sourceFrom: `${day.time}T${sourceStart}:00+08:00`,
      sourceTo: `${day.time}T${sourceEnd}:00+08:00`,
    });
  };
  return [
    windowBar('08:00', '12:00', '09:30', '11:30', {
      open: day.open,
      high: rising ? round(Math.min(day.high, Math.max(day.open, middle) + 0.25)) : day.high,
      low: rising ? day.low : round(Math.max(day.low, Math.min(day.open, middle) - 0.25)),
      close: middle,
    }),
    windowBar('12:00', '16:00', '13:00', '15:00', {
      open: middle,
      high: rising ? day.high : round(Math.min(day.high, Math.max(middle, day.close) + 0.25)),
      low: rising ? round(Math.max(day.low, Math.min(middle, day.close) - 0.25)) : day.low,
      close: day.close,
    }),
  ];
}));

/** Explicitly fictional minute price path. These points are scenario material,
 * not observations recovered from OHLC. Extremes have chosen occurrence times;
 * a replay first discards future points, then calculates visible OHLC afresh.
 * The path reconciles to the existing demo bars and includes all demo fills.
 */
export const sampleIntradayPoints = Object.freeze(sampleFourHourCandles.flatMap(bar => {
  const day = bar.startAt.slice(0, 10);
  const morning = bar.startAt.slice(11, 16) === '08:00';
  const seconds = hhmm => Date.parse(`${day}T${hhmm}:00+08:00`) / 1000;
  const anchors = morning
    ? [[seconds('09:30'), bar.open], [seconds('09:50'), bar.low], [seconds('10:50'), bar.high], [seconds('11:30'), bar.close]]
    : [[seconds('13:00'), bar.open], [seconds('13:30'), bar.high], [seconds('14:45'), bar.low], [seconds('15:00'), bar.close]];
  const fills = { '2025-09-02T09:45': 40, '2025-09-08T10:00': 42, '2025-09-18T14:30': 46 };
  for (const [at, price] of Object.entries(fills)) {
    const time = Date.parse(`${at}+08:00`) / 1000;
    if (time >= anchors[0][0] && time <= anchors.at(-1)[0]) anchors.push([time, price]);
  }
  anchors.sort((a, b) => a[0] - b[0]);
  const points = []; let segment = 0;
  for (let time = anchors[0][0]; time <= anchors.at(-1)[0]; time += 60) {
    while (segment < anchors.length - 2 && time > anchors[segment + 1][0]) segment++;
    const [start, from] = anchors[segment], [end, to] = anchors[segment + 1];
    const price = Math.round((from + (to - from) * (time - start) / (end - start)) * 100) / 100;
    points.push(Object.freeze({ time, price }));
  }
  return points;
}));

// Mainland-equity convention used consistently in candles and trade markers.
export const chartColors = Object.freeze({ up: tokens['chart-up'], down: tokens['chart-down'] });

const DAILY_DERIVED_INTERVALS = Object.freeze(['1D', '1W', '1M']);
const AVAILABLE_SAMPLE_INTERVALS = Object.freeze(['4H', ...DAILY_DERIVED_INTERVALS]);

/** This fixture supplies constructed prices for exactly one fictional instrument. */
export function getAvailableIntervals({ mode, trades = [], marketData } = {}) {
  if (isSyntheticMarketData(marketData, trades)) return ['15m', ...AVAILABLE_SAMPLE_INTERVALS];
  if (matchingMarketData(marketData, trades)) return [...DAILY_DERIVED_INTERVALS];
  return mode === 'sample' && trades.length > 0 && trades.every((trade) => trade.symbol === 'DEMO001')
    ? [...AVAILABLE_SAMPLE_INTERVALS]
    : [];
}

function matchingMarketData(data, trades) {
  return data?.status === 'ok' && data.interval === '1D' && data.currency === 'CNY'
    && data.timeZone === 'Asia/Shanghai' && data.adjust === 'none'
    && Array.isArray(data.bars) && data.bars.length > 0 && trades.length > 0
    && trades.every(t => t.symbol === data.symbol || t.symbol === data.tradeSymbol);
}

function periodStart(day, interval) {
  if (interval === '1D') return day;
  if (interval === '1M') return `${day.slice(0, 7)}-01`;
  // Business-day strings are date labels in Asia/Shanghai. UTC arithmetic keeps
  // Monday grouping independent of the browser's timezone and daylight savings.
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
  return date.toISOString().slice(0, 10);
}

/**
 * Aggregate already-visible daily OHLC. Callers must apply information cutoffs
 * before calling this function. Weekly buckets start Monday; months start day 1.
 * sourceFrom/sourceTo/sourceCount describe observed coverage, not a guarantee
 * that every exchange session in a calendar period is present or has closed.
 */
export function aggregateCandles(dailyCandles, interval = '1D') {
  if (!DAILY_DERIVED_INTERVALS.includes(interval)) return [];
  const ordered = [...dailyCandles].sort((a, b) => a.time.localeCompare(b.time));
  if (interval === '1D') return ordered.map((candle) => ({ ...candle }));
  const periods = new Map();
  for (const candle of ordered) {
    const time = periodStart(candle.time, interval);
    const current = periods.get(time);
    if (!current) {
      periods.set(time, {
        time,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        sourceFrom: candle.time,
        sourceTo: candle.time,
        sourceCount: 1,
      });
    } else {
      current.high = Math.max(current.high, candle.high);
      current.low = Math.min(current.low, candle.low);
      current.close = candle.close;
      current.sourceTo = candle.time;
      current.sourceCount += 1;
    }
  }
  return [...periods.values()];
}

/** Compact colocated trade labels without changing their underlying records. */
export function groupChartMarkers(markers) {
  const groups = new Map();
  // Modern stable sorting preserves input order for markers at the same time.
  const ordered = [...markers].sort((a, b) => typeof a.time === 'number' && typeof b.time === 'number'
    ? a.time - b.time
    : String(a.time).localeCompare(String(b.time)));
  for (const marker of ordered) {
    const letter = marker.side === 'buy' ? 'B' : marker.side === 'sell' ? 'S' : marker.text.split('×')[0];
    const key = JSON.stringify([marker.time, marker.position, letter]);
    const tradeIds = marker.tradeIds ? [...marker.tradeIds] : [marker.id];
    const current = groups.get(key);
    if (!current) {
      groups.set(key, { ...marker, text: letter, tradeIds });
    } else {
      current.tradeIds.push(...tradeIds);
    }
  }
  return [...groups.values()].map((marker) => ({
    ...marker,
    text: marker.tradeIds.length > 1 ? `${marker.text}×${marker.tradeIds.length}` : marker.text,
  }));
}

/**
 * Future real intraday source contract (not yet enabled by this adapter):
 * { symbol, currency:'CNY', timeZone:'Asia/Shanghai', source, observedAt,
 *   nativeInterval:'tick'|'1m', points:[{ time:UTC_seconds, price, availableAt }]
 *   OR bars:[{ time:UTC_seconds, endAt, availableAt, open,high,low,close }] }
 * Use only points whose time AND availableAt are <= cutoff. For minute OHLC,
 * use only completed minutes; an unfinished minute requires an actual snapshot
 * with an explicit asOf, never its later full OHLC. Provider contracts and
 * time/adjustment semantics must be verified before real intraday is enabled.
 */

// Cutoff/decision timestamps without an offset mean China local time, never the
// host computer's timezone. Explicit offsets and UTC timestamps remain exact.
function chinaTimestampSeconds(value) {
  if (typeof value !== 'string') return NaN;
  const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:\d{2})?$/.exec(value);
  if (!match) return NaN;
  const [, day, hour, minute, second = '00', offset = '+08:00'] = match;
  const date = new Date(`${day}T00:00:00Z`);
  if (!Number.isFinite(date.valueOf()) || date.toISOString().slice(0, 10) !== day
    || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return NaN;
  return Date.parse(`${day}T${hour}:${minute}:${second}${offset}`) / 1000;
}

function chinaIso(seconds) { return `${new Date((seconds + 8 * 3600) * 1000).toISOString().slice(0, 19)}+08:00`; }
function chinaDay(seconds) { return chinaIso(seconds).slice(0, 10); }
function sessionAt(seconds) {
  const local = chinaIso(seconds), hhmmss = local.slice(11, 19);
  if (hhmmss >= '09:30:00' && hhmmss <= '11:30:00') return 'morning';
  if (hhmmss >= '13:00:00' && hhmmss <= '15:00:00') return 'afternoon';
  return null;
}
function replayBucket(seconds, interval) {
  const day = chinaDay(seconds);
  return interval === '4H' ? chinaTimestampSeconds(`${day}T${sessionAt(seconds) === 'morning' ? '08:00' : '12:00'}`) : periodStart(day, interval);
}
function periodEnd(time, interval) {
  if (interval === '4H') return time + 4 * 3600;
  let date = time;
  if (interval === '1W') date = new Date(Date.parse(`${time}T00:00:00Z`) + 4 * 86400000).toISOString().slice(0, 10);
  if (interval === '1M') {
    const last = new Date(`${time}T00:00:00Z`);
    last.setUTCMonth(last.getUTCMonth() + 1); last.setUTCDate(0);
    while ([0, 6].includes(last.getUTCDay())) last.setUTCDate(last.getUTCDate() - 1);
    date = last.toISOString().slice(0, 10);
  }
  return chinaTimestampSeconds(`${date}T15:00`);
}

/** Aggregate the known prefix of the explicit sample path, never final bars. */
function replaySample(cutoffSeconds, interval) {
  const groups = new Map();
  for (const point of sampleIntradayPoints) {
    if (point.time > cutoffSeconds) break;
    const time = replayBucket(point.time, interval), day = chinaDay(point.time);
    const existing = groups.get(time);
    if (!existing) groups.set(time, { time, open: point.price, high: point.price, low: point.price, close: point.price, first: point.time, last: point.time, days: new Set([day]) });
    else { existing.high = Math.max(existing.high, point.price); existing.low = Math.min(existing.low, point.price); existing.close = point.price; existing.last = point.time; existing.days.add(day); }
  }
  return [...groups.values()].map(({ first, last, days, ...bar }) => {
    const isPartial = cutoffSeconds < periodEnd(bar.time, interval);
    const metadata = interval === '4H'
      ? { startAt: chinaIso(bar.time), endAt: chinaIso(periodEnd(bar.time, interval)), sourceFrom: chinaIso(first), sourceTo: chinaIso(last) }
      : interval === '1D' ? {} : { sourceFrom: chinaDay(first), sourceTo: chinaDay(last), sourceCount: days.size };
    return { ...bar, ...metadata, ...(isPartial ? { isPartial: true, asOf: chinaIso(cutoffSeconds), lastObservedAt: chinaIso(last) } : {}) };
  });
}

function tradeMarker(trade, time) {
  return {
    id: trade.id,
    time,
    position: trade.side === 'buy' ? 'belowBar' : 'aboveBar',
    color: trade.side === 'buy' ? chartColors.up : chartColors.down,
    shape: trade.side === 'buy' ? 'arrowUp' : 'arrowDown',
    text: trade.side === 'buy' ? 'B' : 'S',
    size: 1,
  };
}

/** Sample replay includes its observed current bar. Real daily-only input never
 * masquerades as an intraday snapshot, and imported fills never create prices. */
export function selectChartData({ trades = [], mode, marketData, cutoff, showFuture = true, interval = '1D' }) {
  if (isSyntheticMarketData(marketData, trades)) return selectSyntheticChartData({ trades, marketData, cutoff, showFuture, interval });
  if (!getAvailableIntervals({ mode, trades, marketData }).includes(interval)) return { candles: [], markers: [] };
  const limited = !showFuture && Boolean(cutoff);
  const cutoffSeconds = limited ? chinaTimestampSeconds(cutoff) : Infinity;
  if (limited && !Number.isFinite(cutoffSeconds)) return { candles: [], markers: [] };
  if (matchingMarketData(marketData, trades)) {
    const days = new Map();
    for (const bar of marketData.bars) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(bar.time) || !Number.isFinite(chinaTimestampSeconds(`${bar.time}T00:00`)) || ![bar.open, bar.high, bar.low, bar.close].every(v => Number.isFinite(v) && v > 0)
        || bar.high < Math.max(bar.open, bar.close) || bar.low > Math.min(bar.open, bar.close)) continue;
      const closed = typeof bar.closedAt === 'number' ? bar.closedAt : chinaTimestampSeconds(bar.closedAt);
      if (!Number.isFinite(closed) || limited && (closed > cutoffSeconds || bar.time > chinaDay(cutoffSeconds))) continue;
      days.set(bar.time, bar);
    }
    const visibleDaily = [...days.values()];
    const markers = [...trades].filter(t => days.has(t.time.slice(0, 10)) && ['buy', 'sell'].includes(t.side)
      && chinaTimestampSeconds(t.time) <= cutoffSeconds).sort((a, b) => a.time.localeCompare(b.time))
      .map(t => tradeMarker(t, periodStart(t.time.slice(0, 10), interval)));
    const currentBar = limited && !days.has(chinaDay(cutoffSeconds))
      ? { time: periodStart(chinaDay(cutoffSeconds), interval), asOf: chinaIso(cutoffSeconds), status: 'unknown', ohlc: null, reason: 'daily-only-no-intraday' } : null;
    return { candles: aggregateCandles(visibleDaily, interval), markers, ...(currentBar || visibleDaily.length ? { currentBar } : {}) };
  }
  const candles = limited ? replaySample(cutoffSeconds, interval)
    : interval === '4H' ? sampleFourHourCandles.map(bar => ({ ...bar })) : aggregateCandles(sampleCandles, interval);
  const displayed = new Set(candles.map(candle => candle.time));
  const knownDays = new Set(sampleCandles.map(candle => candle.time));
  const markers = [...trades]
    .map(trade => ({ trade, at: chinaTimestampSeconds(trade.time) }))
    .filter(({ trade, at }) => trade.symbol === 'DEMO001' && Number.isFinite(at) && at <= cutoffSeconds && ['buy', 'sell'].includes(trade.side)
      && knownDays.has(chinaDay(at)) && sessionAt(at) && displayed.has(replayBucket(at, interval)))
    .sort((a, b) => a.at - b.at).map(({ trade, at }) => tradeMarker(trade, replayBucket(at, interval)));
  const current = candles.at(-1);
  const currentBar = current?.isPartial ? { time: current.time, asOf: current.asOf, status: 'partial', ohlc: { open: current.open, high: current.high, low: current.low, close: current.close } } : null;
  return candles.length ? { candles, markers, currentBar } : { candles, markers };
}
