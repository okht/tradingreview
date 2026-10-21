import { sampleTrades, summarizeTrades } from '../src/domain.js';
import { selectChartData } from '../src/market-data.js';
import { selectSyntheticChartData } from '../src/synthetic-market.js';

const FIELDS = ['id', 'symbol', 'name', 'time', 'side', 'quantity', 'price', 'fee'];
const MAX_ROWS = 500;
const MAX_AMOUNT = Number.MAX_SAFE_INTEGER / 100;
const TYPES = new Set(['trade', 'background', 'event', 'market']);
const CLASSES = new Set(['before', 'after', 'unknown', 'recollection']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function fail(message) {
  const error = new Error(message);
  error.status = 400;
  error.code = 'CONTRACT_VALIDATION';
  throw error;
}
function record(value, label) { if (!object(value)) fail(`${label}必须为对象。`); return value; }
function string(value, label, max = 10000, empty = false) {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim())) fail(`${label}不是有效文本。`);
  return value.trim();
}
function optionalString(value, label, max = 10000) { return value == null ? '' : string(value, label, max, true); }
function list(value, label, max) { if (!Array.isArray(value) || value.length > max) fail(`${label}数量或格式无效。`); return value; }
function strings(value, label, max = 20, itemMax = 2000) { return list(value, label, max).map((item, index) => string(item, `${label}[${index}]`, itemMax)); }
function number(value, label, allowNull = false, zero = false) {
  if (value === null && allowNull) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || (zero ? value < 0 : value <= 0) || value > MAX_AMOUNT) fail(`${label}必须是${zero ? '非负' : '正'}有限数值${allowNull ? '或 null' : ''}。`);
  return value;
}

/** No environment timezone, Date rollover, or invented time of day. */
function timestamp(value, label, { allowDate = false, localOnly = false, nullable = false } = {}) {
  if (value == null && nullable) return null;
  const source = string(value, label, 40);
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})?)?$/.exec(source);
  if (!match) fail(`${label}需要有效日期时间。`);
  const [, y, m, d, hh, mm, ss = '00', fraction, zone] = match;
  const year = Number(y), month = Number(m), day = Number(d);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1]
    || (!hh && !allowDate) || (hh && (Number(hh) > 23 || Number(mm) > 59 || Number(ss) > 59))
    || (localOnly && (zone || fraction))) fail(`${label}的日期、时刻或时区无效。`);
  if (zone && zone !== 'Z') {
    const [hours, minutes] = zone.slice(1).split(':').map(Number);
    if (hours > 14 || minutes > 59 || (hours === 14 && minutes !== 0)) fail(`${label}的时区偏移无效。`);
  }
  if (!hh) return `${y}-${m}-${d}`;
  return `${y}-${m}-${d}T${hh}:${mm}${ss === '00' && !fraction ? '' : `:${ss}`}${fraction ? `.${fraction}` : ''}${zone ?? ''}`;
}

/** Used by read-only tools; naive full timestamps mean Asia/Shanghai. */
export function timestampMillis(value) {
  const normalized = timestamp(value, 'decisionAt');
  return Date.parse(/(Z|[+-]\d{2}:\d{2})$/.test(normalized) ? normalized : `${normalized}+08:00`);
}

/** File payloads are transient model input. Never include them in persisted runs. */
export function validateImportInput({ text, images = [] } = {}) {
  if (typeof text !== 'string' || text.length > 60000) fail('文件提取内容需在 60000 字以内，请缩小文件范围后重试。');
  list(images, '图片', 4);
  let total = 0;
  const checked = images.map((item, index) => {
    record(item, `图片 ${index + 1}`);
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(item.mimeType)) fail('图片需要为 PNG、JPEG 或 WebP 格式。');
    if (typeof item.data !== 'string' || !item.data || item.data.length > 1398104
      || item.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(item.data)) fail('图片编码无效或超过 1 MB，请重新选择图片。');
    let binary;
    try { binary = atob(item.data); } catch { fail('图片编码无效，请重新选择图片。'); }
    if (btoa(binary) !== item.data || binary.length > 1048576) fail('单张图片需在 1 MB 以内，请缩小图片后重试。');
    total += binary.length;
    const bytes = (...values) => values.every((value, at) => binary.charCodeAt(at) === value);
    const matches = item.mimeType === 'image/png' ? bytes(137, 80, 78, 71, 13, 10, 26, 10)
      : item.mimeType === 'image/jpeg' ? bytes(255, 216, 255)
        : binary.slice(0, 4) === 'RIFF' && binary.slice(8, 12) === 'WEBP';
    if (!matches) fail('图片内容与声明格式不匹配，请重新导出图片。');
    return { type: 'image', mimeType: item.mimeType, data: item.data };
  });
  if (total > 3145728) fail('本次图片合计需在 3 MB 以内，请减少图片后重试。');
  if (!text.trim() && !checked.length) fail('没有可识别的文字或图片，请选择包含成交记录的文件。');
  return { text: text.trim(), images: checked };
}

function importTrade(value, index) {
  record(value, `第 ${index + 1} 笔候选交易`);
  const trade = {};
  for (const field of FIELDS) {
    if (!own(value, field)) fail(`候选交易缺少 ${field}，未知内容需要保留 null。`);
    if (value[field] === null) { trade[field] = null; continue; }
    if (['id', 'symbol', 'name'].includes(field)) trade[field] = string(value[field], field, field === 'name' ? 200 : 120);
    else if (field === 'time') {
      const normalized = timestamp(value.time, '成交时间', { allowDate: true });
      // Only an explicit offset permits timezone conversion; never infer one from the host.
      trade.time = /(Z|[+-]\d{2}:\d{2})$/.test(normalized)
        ? timestamp(new Date(timestampMillis(normalized) + 8 * 3600000).toISOString().replace(/Z$/, '').replace(/\.000$/, ''), '北京时间') : normalized;
    } else if (field === 'side') {
      if (!['buy', 'sell'].includes(value.side)) fail('候选方向只接受 buy、sell 或 null，未确认方向请保留 null。');
      trade.side = value.side;
    } else trade[field] = number(value[field], field, true, field === 'fee');
  }
  for (const field of ['accountId', 'currency', 'feeCurrency', 'quantityUnit', 'assetType', 'market', 'positionSide']) {
    trade[field] = value[field] == null ? null : string(value[field], field, 120);
  }
  trade.leverage = value.leverage == null ? null : number(value.leverage, '杠杆倍数');
  if (value.margin != null && typeof value.margin !== 'boolean') fail('margin 需要为布尔值或 null。');
  trade.margin = value.margin ?? null;
  if (trade.price !== null && trade.quantity !== null && trade.price * trade.quantity > MAX_AMOUNT) fail('候选成交金额超过可精确处理的范围。');
  return trade;
}

/** Candidates can span accounts and instruments; saving a review remains strict. */
export function validateImportResult(value) {
  record(value, '文件识别结果');
  const trades = list(value.trades, '候选交易', MAX_ROWS).map(importTrade);
  const questions = strings(value.questions, 'questions', 20);
  const warnings = strings(value.warnings, 'warnings', 30);
  const add = message => { if (!warnings.includes(message)) warnings.push(message); };
  if (!trades.length) add('没有识别到可确认的成交记录，请补充成交明细或说明文件内容。');
  if (trades.some(trade => FIELDS.some(field => trade[field] === null))) add('部分成交字段缺失，请补充或确认后再导入。');
  if (trades.some(trade => trade.time && /^\d{4}-\d{2}-\d{2}$/.test(trade.time))) add('部分记录只有成交日期，请补充具体时刻。');
  if (!warnings.includes('带明确时区的成交时间已换算为北京时间。') && value.trades.some(trade => trade.time && !/(Z|[+-]\d{2}:\d{2})$/.test(trade.time))) add('未标注时区的成交时间尚待确认；当前复盘使用北京时间。');
  if (value.trades.some(trade => trade.time && /(Z|[+-]\d{2}:\d{2})$/.test(trade.time))) add('带明确时区的成交时间已换算为北京时间。');
  if (trades.some(trade => ['currency', 'feeCurrency', 'quantityUnit', 'assetType', 'market'].some(field => trade[field] === null))) add('市场、币种或数量单位仍有缺失，请按原始记录补充确认。');
  if (trades.some(trade => (trade.leverage !== null && trade.leverage !== 1) || trade.margin === true || trade.positionSide === 'short')) add('记录包含杠杆、保证金或空头信息，请保留原始属性核对，当前普通股票复盘不能直接确认。');
  const ids = new Set(), signatures = new Set();
  for (const trade of trades) {
    if (trade.id !== null) { if (ids.has(trade.id)) add('存在重复的成交编号，请核对后保留有效记录。'); ids.add(trade.id); }
    if (['symbol', 'time', 'side', 'quantity', 'price', 'fee'].every(field => trade[field] !== null)) {
      const signature = JSON.stringify(['accountId', 'symbol', 'time', 'side', 'quantity', 'price', 'fee', 'currency'].map(field => trade[field]));
      if (signatures.has(signature)) add('存在内容相同的候选成交，请核对是否重复导入。');
      signatures.add(signature);
    }
  }
  if (new Set(trades.map(trade => trade.symbol)).size > 1 || new Set(trades.map(trade => trade.accountId)).size > 1) add('识别到多个标的或账户，请选择本次复盘的交易范围。');
  if (warnings.length > 30) fail('识别问题过多，请合并同类提示后重新核对。');
  safeTexts([...questions, ...warnings]);
  return { trades, questions, warnings };
}

function url(value) {
  if (value == null || value === '') return undefined;
  const raw = string(value, '证据 URL', 2048);
  let parsed;
  try { parsed = new URL(raw); } catch { fail('证据 URL 无效。'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) fail('证据 URL 仅接受无凭证的 HTTP(S) 地址。');
  return parsed.href;
}

function tradeRecord(value, index, draft = false) {
  record(value, `第 ${index + 1} 笔交易`);
  const result = {};
  for (const field of FIELDS) {
    if (!own(value, field)) fail(`第 ${index + 1} 笔交易缺少 ${field}；未知字段请显式填写 null。`);
    if (draft && value[field] === null) { result[field] = null; continue; }
    if (['id', 'symbol', 'name'].includes(field)) result[field] = string(value[field], field, field === 'name' ? 200 : 120);
    else if (field === 'time') result.time = timestamp(value.time, '成交时间', { localOnly: true });
    else if (field === 'side') { if (!['buy', 'sell'].includes(value.side)) fail('交易方向只支持 buy/sell，当前不支持做空或衍生品。'); result.side = value.side; }
    else result[field] = number(value[field], field, ['price', 'fee'].includes(field), field === 'fee');
  }
  if (value.accountId !== undefined) result.accountId = string(value.accountId, 'accountId', 120);
  if (value.currency !== undefined && value.currency !== 'CNY') fail('当前核算仅支持人民币 CNY，请勿混入其他计价或费用币种。');
  if (value.feeCurrency !== undefined && value.feeCurrency !== 'CNY') fail('费用币种必须为 CNY。');
  if (value.quantityUnit !== undefined && value.quantityUnit !== 'share' && value.quantityUnit !== '股') fail('当前交易数量单位为股。');
  if (value.assetType !== undefined && !['stock', 'spot'].includes(value.assetType)) fail('当前仅支持现货多头交易。');
  if ((value.leverage !== undefined && value.leverage !== 1) || value.margin === true || value.positionSide === 'short') fail('当前不支持杠杆、保证金或空头持仓。');
  if (result.price != null && result.quantity != null && result.price * result.quantity > MAX_AMOUNT) fail('成交金额超过可精确处理的范围。');
  return result;
}
function validateTradeCollection(values, draft = false) {
  const trades = list(values, '交易', MAX_ROWS).map((trade, index) => tradeRecord(trade, index, draft));
  const ids = new Set(), signatures = new Set(), symbols = new Set(), accounts = new Set();
  for (const trade of trades) {
    if (trade.id !== null) { if (ids.has(trade.id)) fail('交易 id 重复，请核对导入记录。'); ids.add(trade.id); }
    if (trade.symbol !== null) symbols.add(trade.symbol);
    if (trade.accountId !== undefined) accounts.add(trade.accountId);
    // Incomplete drafts remain distinct until the user supplies their fields.
    if (['symbol', 'time', 'side', 'quantity', 'price', 'fee'].every(field => trade[field] !== null)) {
      const signature = JSON.stringify(['symbol', 'time', 'side', 'quantity', 'price', 'fee'].map(field => trade[field]));
      if (signatures.has(signature)) fail('存在内容重复的交易，请核对记录。');
      signatures.add(signature);
    }
  }
  if (symbols.size > 1) fail('每次复盘只支持一个标的，请拆分交易范围。');
  if (accounts.size > 1 || (accounts.size === 1 && trades.some(trade => trade.accountId === undefined))) fail('每次复盘只支持一个明确的账户。');
  if (!draft && trades.length && trades.every(trade => trade.price !== null && trade.fee !== null)) {
    const summary = summarizeTrades(trades);
    if (summary.issues.some(issue => issue.includes('超过原型可精确处理'))) fail('累计金额超过可精确处理的范围。');
  }
  return trades.sort((a, b) => (a.time ?? '').localeCompare(b.time ?? '') || (a.id ?? '').localeCompare(b.id ?? ''));
}

function marketTimestamp(value, label) {
  const raw = string(value, label, 40);
  if (!/(Z|[+-]\d{2}:\d{2})$/.test(raw)) fail(`${label}必须包含时区。`);
  return timestamp(raw.replace(/\.\d{1,3}(?=Z|[+-]\d{2}:\d{2}$)/, ''), label);
}
function marketDay(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail(`${label}必须为日期。`);
  return timestamp(value, label, { allowDate: true });
}
function validateMarketData(input, trades) {
  record(input, 'marketData');
  if (input.provider === 'synthetic') return validateSyntheticMarketData(input, trades);
  if (input.provider !== 'fuyao' || input.interval !== '1D' || input.adjust !== 'none'
    || input.currency !== 'CNY' || input.timeZone !== 'Asia/Shanghai' || input.availabilityPolicy !== 'next-day') fail('当前仅接受扶摇人民币日线、不复权和次日可用口径。');
  if (['intraday', 'minuteBars', 'pricePoints', 'partialBars'].some(key => input[key] !== undefined)) fail('当前真实行情契约仅支持历史日线，盘中记录须先接入已核实的数据源契约。');
  const symbol = string(input.symbol, '行情代码', 20).toUpperCase();
  if (!/^\d{6}\.(SH|SZ|BJ)$/.test(symbol) || !trades.length || trades.some(trade => {
    const code = /^(\d{6})(?:\.(SH|SZ|BJ))?$/.exec(trade.symbol.toUpperCase());
    return !code || code[1] !== symbol.slice(0, 6) || (code[2] && `${code[1]}.${code[2]}` !== symbol);
  })) fail('行情必须与当前复盘的单一 A 股标的一致。');
  if (input.source !== '同花顺扶摇 A 股历史 K 线') fail('行情来源字段与当前支持的数据契约不符。');
  const from = marketDay(input.from, '行情起始日期'), to = marketDay(input.to, '行情结束日期');
  if (from > to) fail('行情日期范围无效。');
  const observedAt = marketTimestamp(input.observedAt, '行情采集时间');
  const observed = timestampMillis(observedAt);
  if (observed > Date.now() + 300000) fail('行情采集时间不能晚于当前时间。');
  const seen = new Set();
  const bars = list(input.bars, '行情日线', 4000).map((item, index) => {
    record(item, `日线 ${index + 1}`);
    if (item.isPartial === true || item.status === 'partial' || item.asOf !== undefined) fail('历史日线记录不能标记为盘中局部 K 线。');
    const time = marketDay(item.time, '行情日期');
    if (seen.has(time) || time < from || time > to) fail('行情日期重复或超出请求范围。');
    seen.add(time);
    const tomorrow = new Date(Date.parse(`${time}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
    const closedAt = `${tomorrow}T00:00+08:00`;
    if (timestampMillis(marketTimestamp(item.closedAt, '日线可用时间')) !== timestampMillis(closedAt) || timestampMillis(closedAt) > observed) fail('日线可用时间不符合次日口径，或在采集时尚未完整。');
    const bar = { time, open: number(item.open, 'open'), high: number(item.high, 'high'), low: number(item.low, 'low'), close: number(item.close, 'close'), closedAt };
    if (bar.high < Math.max(bar.open, bar.close, bar.low) || bar.low > Math.min(bar.open, bar.close, bar.high)) fail('日线 OHLC 不自洽。');
    if (item.volume !== undefined) bar.volume = number(item.volume, 'volume', false, true);
    if (item.turnover !== undefined) bar.turnover = number(item.turnover, 'turnover', false, true);
    return bar;
  }).sort((a, b) => a.time.localeCompare(b.time));
  return { provider: 'fuyao', status: bars.length ? 'ok' : 'empty', source: input.source, symbol, tradeSymbol: trades[0].symbol, from, to, interval: '1D', adjust: 'none', currency: 'CNY', timeZone: 'Asia/Shanghai', availabilityPolicy: 'next-day', observedAt, bars,
    provenance: 'workspace-supplied', sourceVerification: '本次仅校验结构与时点，未重新联网核验行情来源。' };
}

function validateSyntheticMarketData(input, trades) {
  const realInstrument = input.instrumentKind === 'real-equity' && /^\d{6}\.(SH|SZ)$/.test(input.symbol);
  if (input.synthetic !== true || input.status !== 'ok' || input.source !== '用户导入的合成行情'
    || typeof input.symbol !== 'string' || (!/^SIM[A-Z0-9_-]{1,16}$/.test(input.symbol) && !realInstrument) || input.interval !== '5m' || input.adjust !== 'none'
    || input.currency !== 'CNY' || input.timeZone !== 'Asia/Shanghai') fail('合成行情必须明确标记来源、标的身份和 5 分钟观测口径；真实股票代码需声明 real-equity，价格仍为合成。');
  if (input.reviewInterval !== undefined && !['15m', '4H'].includes(input.reviewInterval)) fail('合成复盘周期仅支持 15 分钟或 4 小时。');
  if (!trades.length || trades.some(trade => trade.symbol !== input.symbol)) fail('合成行情必须与当前交易的测试标的一致。');
  const from = marketDay(input.from, '合成行情起始日期'), to = marketDay(input.to, '合成行情结束日期');
  if (from > to) fail('合成行情日期范围无效。');
  let previous = -Infinity;
  const pricePoints = list(input.pricePoints, '合成价格观测', 10000).map((point, index) => {
    record(point, `合成观测 ${index + 1}`);
    if (!Number.isSafeInteger(point.time) || point.time <= previous || point.time % 300 !== 0) fail('合成观测需按 5 分钟时点升序排列，时间不能重复。');
    previous = point.time;
    const date = new Date((point.time + 8 * 3600) * 1000);
    if (!Number.isFinite(date.getTime())) fail('合成观测时间无效。');
    const day = date.toISOString().slice(0, 10), clock = date.toISOString().slice(11, 19), weekday = date.getUTCDay();
    if (day < from || day > to || weekday === 0 || weekday === 6
      || !(clock >= '09:30:00' && clock <= '11:30:00' || clock >= '13:00:00' && clock <= '15:00:00')) fail('合成观测超出日期范围或声明的工作日交易时段。');
    const value = { time: point.time, price: number(point.price, '合成价格') };
    if (point.volume !== undefined) value.volume = number(point.volume, '合成成交量', false, true);
    return value;
  });
  if (!pricePoints.length) fail('合成行情需要价格观测记录。');
  return { provider: 'synthetic', source: '用户导入的合成行情', synthetic: true, status: 'ok', symbol: input.symbol,
    ...(realInstrument ? { instrumentKind: 'real-equity' } : {}), ...(input.reviewInterval ? { reviewInterval: input.reviewInterval } : {}),
    interval: '5m', adjust: 'none', currency: 'CNY', timeZone: 'Asia/Shanghai', from, to, pricePoints,
    availabilityPolicy: 'observation-time', provenance: 'file-synthetic', sourceVerification: '全部价格为用户导入的合成测试数据，未引用真实市场行情。' };
}

/** The trade timestamp is the immutable cutoff for each market evidence pair. */
export function marketAtDecision(marketData, decisionAt) {
  if (marketData.provider === 'synthetic') {
    const options = { trades: [{ id: 'market-boundary', symbol: marketData.symbol, time: decisionAt, side: 'buy' }], marketData, cutoff: decisionAt, interval: marketData.reviewInterval || '4H' };
    const visible = selectSyntheticChartData({ ...options, showFuture: false });
    const full = selectSyntheticChartData({ ...options, showFuture: true });
    const cutoff = timestampMillis(decisionAt);
    return { before: visible.candles.filter(bar => !bar.isPartial && timestampMillis(bar.endAt) <= cutoff), after: full.candles.filter(bar => timestampMillis(bar.endAt) > cutoff) };
  }
  const cutoff = timestampMillis(decisionAt);
  return {
    before: marketData.bars.filter(bar => timestampMillis(bar.closedAt) <= cutoff),
    after: marketData.bars.filter(bar => timestampMillis(bar.closedAt) > cutoff),
  };
}

/** Uses the same information-time view as the chart; the daily source has no intraday path. */
export function currentMarketBar(marketData, trade) {
  if (marketData.provider === 'synthetic') return selectSyntheticChartData({ trades: [trade], marketData, cutoff: trade.time, showFuture: false, interval: marketData.reviewInterval || '4H' }).currentBar ?? null;
  const view = selectChartData({ trades: [trade], mode: 'import', marketData, cutoff: trade.time, showFuture: false, interval: '1D' });
  // A chart partial cannot enter this daily-only server contract until native
  // intraday inputs have their own validation. Missing coverage remains unknown.
  return view.currentBar?.status === 'unknown' && view.currentBar.ohlc === null ? view.currentBar
    : { time: trade.time.slice(0, 10), asOf: `${new Date(timestampMillis(trade.time) + 8 * 3600000).toISOString().slice(0, 19)}+08:00`, status: 'unknown', ohlc: null, reason: 'daily-only-no-intraday' };
}

function marketEvidence(context, trade) {
  if (!context.marketData) return [];
  const data = context.marketData;
  const groups = marketAtDecision(data, trade.time);
  if (data.provider === 'synthetic') {
    const periodLabel = data.reviewInterval === '15m' ? '15 分钟' : '4 小时';
    const entries = ['before', 'after'].flatMap(timeClass => {
      const bars = groups[timeClass]; if (!bars.length) return [];
      const first = bars[0], last = bars.at(-1);
      return [{ id: `market:${encodeURIComponent(trade.id)}:${timeClass}`, tradeId: trade.id, type: 'market', synthetic: true,
        title: timeClass === 'before' ? `决策前已完整的合成 ${periodLabel} K 线` : `决策后的合成 ${periodLabel} K 线`,
        text: `合成测试行情，共 ${bars.length} 根 ${periodLabel}窗口，范围 ${first.startAt} 至 ${last.endAt}。首根开盘 ${first.open} 元，区间最高 ${Math.max(...bars.map(bar => bar.high))} 元，区间最低 ${Math.min(...bars.map(bar => bar.low))} 元，末根收盘 ${last.close} 元。${timeClass === 'after' ? '这些完整价格包含决策后的变化，不能代表决策时状态。' : '仅含截止时点前已完整的窗口。'}数据全部为合成观测，不能作为真实市场事实。`,
        source: data.source, publishedAt: last.endAt, recordedAt: null, timeClass, cutoff: trade.time, rangeStart: first.startAt, rangeEnd: last.endAt, barCount: bars.length }];
    });
    const current = currentMarketBar(data, trade);
    if (current) entries.push({ id: `market:${encodeURIComponent(trade.id)}:current`, tradeId: trade.id, type: 'market', synthetic: true,
      title: '当根截至决策时点的合成价格状态',
      text: current.ohlc ? `截至 ${current.asOf} 的合成测试观测：当前根开盘 ${current.ohlc.open} 元，已知最高 ${current.ohlc.high} 元，已知最低 ${current.ohlc.low} 元，当前价格 ${current.ohlc.close} 元。尚未包含后续观测；真实盘中状态不能由这些合成数据证明。`
        : `截至 ${current.asOf}，当前根缺少可用合成观测，状态未知。`,
      source: data.source, publishedAt: current.asOf, recordedAt: null, timeClass: current.ohlc ? 'before' : 'unknown', marketState: current.ohlc ? 'synthetic-current' : 'unknown-current', cutoff: trade.time });
    return entries;
  }
  const history = ['before', 'after'].flatMap(timeClass => {
    const bars = groups[timeClass]; if (!bars.length) return [];
    const first = bars[0], last = bars.at(-1);
    const rangeHigh = Math.max(...bars.map(bar => bar.high)), rangeLow = Math.min(...bars.map(bar => bar.low));
    const boundary = timeClass === 'before' ? '决策前已完整的历史日线' : '决策后才可用的完整日线数据，不能代表当根 K 线截至决策时点的状态';
    return [{ id: `market:${encodeURIComponent(trade.id)}:${timeClass}`, tradeId: trade.id, type: 'market', title: boundary,
      text: `所提供的 ${data.symbol} 不复权日线：${boundary}，共 ${bars.length} 根，日期范围 ${first.time} 至 ${last.time}；首根开盘 ${first.open} 元，区间最高 ${rangeHigh} 元，区间最低 ${rangeLow} 元，末根收盘 ${last.close} 元。以每根 closedAt 相对 ${trade.time} 分区；仅覆盖已提供日期，不保证区间完整。`,
      source: `${data.source}（工作区提交，本次未重新联网核验）`, publishedAt: last.closedAt, recordedAt: data.observedAt, timeClass,
      cutoff: trade.time, rangeStart: first.time, rangeEnd: last.time, barCount: bars.length }];
  });
  const currentBar = currentMarketBar(data, trade);
  const current = { id: `market:${encodeURIComponent(trade.id)}:current`, tradeId: trade.id, type: 'market', title: '当前根截至决策时点的状态未知',
    text: `截至 ${currentBar.asOf}，当前源只有历史日线，缺少还原该根当时 OHLC/current 所需的盘中记录。不能以最终收盘数据或成交价补造，也不能据此断言当时没有 K 线。`,
    source: `${data.source}（工作区提交，本次未重新联网核验）`, publishedAt: null, recordedAt: data.observedAt, timeClass: 'unknown', marketState: 'unknown-current', cutoff: trade.time };
  return [...history, current];
}

/** Return a detached, allow-listed context. Empty trades support the parse task. */
export function validateContext(input) {
  record(input, 'context');
  const trades = validateTradeCollection(input.trades);
  const ids = new Set(trades.map(trade => trade.id));
  const sourceContexts = input.contexts === undefined ? {} : record(input.contexts, 'contexts');
  const contexts = {};
  for (const [tradeId, value] of Object.entries(sourceContexts)) {
    if (!ids.has(tradeId)) continue; // Selection contexts must not import other decisions.
    record(value, '交易背景');
    const source = value.source === undefined ? '现在回忆' : string(value.source, '背景来源', 40);
    if (!['现在回忆', '当时记录'].includes(source)) fail('背景来源需要区分现在回忆与当时记录。');
    if (value.unknown !== undefined && typeof value.unknown !== 'boolean') fail('unknown 必须为布尔值。');
    if (value.noPlan !== undefined && typeof value.noPlan !== 'boolean') fail('noPlan 必须为布尔值。');
    const note = {
      reason: optionalString(value.reason, '理由'), plan: optionalString(value.plan, '计划'),
      source, reference: optionalString(value.reference, '背景出处', 2048), unknown: value.unknown === true,
      publishedAt: timestamp(value.publishedAt ?? value.claimedAt, '原记录时间', { allowDate: true, nullable: true }),
      recordedAt: timestamp(value.recordedAt, '补录时间', { nullable: true }),
    };
    if (value.noPlan !== undefined) note.noPlan = value.noPlan;
    if (value.sourceDocumentId !== undefined) note.sourceDocumentId = string(value.sourceDocumentId, '原记录 id', 200);
    Object.defineProperty(contexts, tradeId, { value: note, enumerable: true, configurable: true, writable: true });
  }
  const marketMode = input.marketMode ?? 'import';
  if (!['sample', 'import'].includes(marketMode)) fail('marketMode 无效。');
  if (marketMode === 'sample' && trades.some(trade => !sampleTrades.some(sample => FIELDS.every(field => sample[field] === trade[field])))) fail('演示行情只允许对应的构造交易，修改后的记录请使用 import 模式。');
  const context = { trades, contexts, marketMode, origin: optionalString(input.origin, '交易来源', 300) || '用户提供' };
  if (input.marketData !== undefined && input.marketData !== null) context.marketData = validateMarketData(input.marketData, trades);
  if (input.evidence !== undefined) {
    const seen = new Set();
    context.evidence = list(input.evidence, '事件证据', 500).map((item, index) => {
      record(item, `事件证据 ${index + 1}`);
      const id = string(item.id, '事件证据 id', 160);
      if (seen.has(id)) fail('事件证据 id 重复。');
      seen.add(id);
      if (!ids.has(item.tradeId)) fail('事件证据引用了当前范围之外的交易。');
      if (item.type !== undefined && item.type !== 'event') fail('外部证据只能作为 event，不能覆盖成交与用户背景。');
      const entry = {
        id, tradeId: item.tradeId, type: 'event', title: string(item.title, '证据标题', 300),
        text: string(item.text, '证据原文', 20000), source: string(item.source, '证据来源', 300),
        publishedAt: timestamp(item.publishedAt, '公开时间', { allowDate: true, nullable: true }),
        recordedAt: timestamp(item.recordedAt, '采集时间', { nullable: true }),
      };
      const link = url(item.url);
      if (link) entry.url = link;
      return entry;
    });
  }
  return context;
}

/** Recollection/unknown never become pre-decision proof merely by filtering. */
export function evidenceAtDecision(item, decisionAt) {
  if (item.timeClass === 'recollection') return { ...item, timeClass: 'recollection' };
  if (!item.publishedAt || /^\d{4}-\d{2}-\d{2}$/.test(item.publishedAt)) return { ...item, timeClass: 'unknown' };
  return { ...item, timeClass: timestampMillis(item.publishedAt) <= timestampMillis(decisionAt) ? 'before' : 'after' };
}

/** Builds only supplied evidence and an explicitly labelled known demo event. */
export function buildEvidence(input) {
  const context = validateContext(input);
  const items = [];
  for (const trade of context.trades) {
    const key = encodeURIComponent(trade.id);
    items.push({ id: `trade:${key}`, tradeId: trade.id, type: 'trade', title: '成交记录',
      text: `${trade.name}（${trade.symbol}）在 ${trade.time.replace('T', ' ')} ${trade.side === 'buy' ? '买入' : '卖出'} ${trade.quantity} 股；成交价 ${trade.price === null ? '未知' : `${trade.price} 元`}；费用 ${trade.fee === null ? '未知' : `${trade.fee} 元`}。`,
      source: context.marketMode === 'sample' ? '构造成交示例' : context.origin, publishedAt: trade.time, recordedAt: null, timeClass: 'before' });
    const note = context.contexts[trade.id];
    if (note && (note.reason || note.plan || note.unknown || note.noPlan)) {
      const item = { id: `background:${key}`, tradeId: trade.id, type: 'background', title: '用户提供的决策背景',
        text: `${note.unknown ? '用户表示记不清当时的理由。' : `理由：${note.reason || '未补充'}。`}${note.noPlan ? '用户表示当时没有计划。' : `计划：${note.plan || '未补充'}。`}${note.reference ? `出处：${note.reference}。` : ''}`,
        source: note.source === '当时记录' ? '用户标记为当时记录，原件尚需核实' : '用户现在回忆，未经原始记录验证',
        publishedAt: note.publishedAt, recordedAt: note.recordedAt, timeClass: note.source === '现在回忆' || note.unknown ? 'recollection' : 'unknown' };
      items.push(evidenceAtDecision(item, trade.time));
    }
    if (context.marketMode === 'sample' && trade.id === 'DEMO-02') items.push({
      id: 'event:demo-order:DEMO-02', tradeId: trade.id, type: 'event', title: '构造订单公告',
      text: '构造公告于 2025-09-08 11:30 发布新签订单消息。它晚于这笔 10:00 的成交，不能作为成交前已公开的信息。',
      source: '构造示例，未接入真实公告', publishedAt: '2025-09-08T11:30', recordedAt: null, timeClass: 'after',
    });
    items.push(...marketEvidence(context, trade));
  }
  for (const entry of context.evidence ?? []) {
    const trade = context.trades.find(item => item.id === entry.tradeId);
    items.push(evidenceAtDecision({ ...entry, id: `event:${encodeURIComponent(entry.id)}`, timeClass: 'unknown' }, trade.time));
  }
  if (new Set(items.map(item => item.id)).size !== items.length) fail('证据标识冲突。');
  return items;
}

function unsafeAdvice(value) {
  const direct = /(?:建议|推荐|应该|应当|务必|立即|马上|现在就|赶紧|最好|请)(?:你|您)?(?:立即|现在|继续|择机|分批|逢低|逢高)?(?:买入|卖出|加仓|减仓|清仓|抄底|做多|做空)(?!前|之前|时)|(?:^|[。！？\n])\s*(?:买入|卖出|加仓|减仓|清仓)(?:这只|该股|该标的|这支)|\b(?:you should|you must|recommend you|buy now|sell now)\s*(?:buy|sell|short)?/i;
  if (direct.test(value)) return true;
  if (/(?:将|把|用).{0,12}(?:全部资金|所有资金|全部仓位|满仓).{0,12}(?:投入|投向|买进|买入|建仓)|(?:今天|明天|现在|立刻|马上).{0,8}(?:完成建仓|建仓|进场|梭哈)|(?:操作|执行)[：:]\s*(?:建仓|进场|满仓|梭哈)/.test(value)) return true;
  const guarantee = /稳赚|必赚|必涨|必跌|不会亏|绝不亏|保本保收益|(?:保证|承诺).{0,6}(?:收益|盈利|获利|赚钱|上涨|下跌)|(?:一定|必然|肯定|确定).{0,5}(?:上涨|下跌|翻倍)|(?:guaranteed|risk[- ]free)\s*(?:returns?|profits?)|will definitely (?:rise|fall)/gi;
  for (const clause of value.split(/[。！？；\n，,]/)) {
    for (const match of clause.matchAll(guarantee)) {
      const before = clause.slice(0, match.index).trim();
      if (!/(?:不能|无法|不得|不应|不可|不会|不|避免)(?:作出|作|提供|任何)?$/.test(before)) return true;
    }
  }
  return false;
}
function safeTexts(values) { if (values.some(value => unsafeAdvice(value))) fail('结果包含直接买卖建议、收益承诺或确定性涨跌表述。'); }
function referenceIds(value, label, available, allowEmpty = false) {
  const ids = strings(value, label, 100, 400);
  if ((!allowEmpty && !ids.length) || new Set(ids).size !== ids.length || ids.some(id => !available.has(id))) fail(`${label}必须引用当前已存在的证据，且不能重复。`);
  return ids;
}
function attributedBackgroundStatement(text, used) {
  if (text.length > 800 || !used.length || used.some(entry => entry.type !== 'background')) return false;
  // Only reporting what the user wrote is exempt from the unknown-time
  // interpretation gate. A causal or behavioral inference still needs a hedge.
  if (/因此|所以|因而|从而|由此|据此|可见|说明|证明|表明|导致|促使|确认了|证实|当时已|事前已|买入前已|决策前已|严格执行|确实|实际执行|已经执行|行为偏差|认知偏差|过度自信|从众|心理|(?:原因|动机)(?:是|为)/.test(text)) return false;
  const statements = text.split(/[。！？!?；;\n]+/u).map(part => part.trim()).filter(Boolean);
  return statements.length > 0 && statements.every(part => /^(?:用户填写(?:了)?|用户自述|记录写到)[:：\s]*\S/u.test(part));
}

function prospectiveBackgroundReminder(text, used) {
  // A future checklist can be useful without proving past execution. Recognize
  // that narrow boundary explicitly; a generic investment disclaimer is not a
  // substitute for uncertainty about history. These remain language guardrails.
  if (!used.length || used.some(entry => entry.type !== 'background' || !['recollection', 'unknown'].includes(entry.timeClass))) return false;
  if (!/回忆|自述|用户填写|现在填写/.test(text) || !/未来|下一次|下次|今后/.test(text) || !/流程提醒|检查项|核对清单|核查清单/.test(text)) return false;
  const clauses = text.split(/[，,。！？!?；;\n]+/u).map(part => part.trim()).filter(Boolean);
  // Match an entire clause, so quoting or negating the disclaimer itself does
  // not count. Remove only the historical denial, then inspect the rest.
  const denial = /^(?:它|此提醒|这条提醒|该提醒|此检查项|这条检查项|该检查项)?(?:并|也)?(?:不是对(?:过去|当时|历史)(?:的)?(?:实际)?(?:执行情况|计划执行情况|执行)(?:的)?(?:认定|证明|确认)|不代表(?:用户)?(?:当时|过去)(?:已经|已|曾经|曾)?(?:制定|执行)(?:了|过)?(?:(?:或|并|和|且)(?:已)?(?:制定|执行)(?:了|过)?)?(?:计划)?)$/u;
  if (!clauses.some(clause => denial.test(clause))) return false;
  const remaining = clauses.filter(clause => !denial.test(clause)).join('。');
  return !/(?:当时|过去|历史|此前|事前)|因此|所以|因而|从而|由此|据此|说明|证明|证实|确认了|认定|导致|促使|(?:原因|动机)(?:是|为)|确实|实际执行|(?:已经|已)(?:执行|完成|遵守|制定)|(?:买入|卖出|加仓|减仓|建仓|交易|执行|制定|遵守|完成)(?:了|过)/.test(remaining)
    && !CAUSAL_CLAIM.test(remaining) && !BEHAVIOR_CLAIM.test(remaining);
}

function temporalClaim(item, evidence, interpretation) {
  const used = item.evidenceIds.map(id => evidence.get(id));
  if (used.some(entry => entry.synthetic === true) && !/合成|模拟|测试/.test(item.text)) fail('引用合成行情时需要明确标记合成或测试数据，不能表述为真实市场事实。');
  const uncertain = UNCERTAIN_CLAIM.test(item.text);
  const prospectiveReminder = interpretation && prospectiveBackgroundReminder(item.text, used);
  if (used.some(entry => entry.marketState === 'unknown-current') && !/未知|缺少|缺乏|缺失|不足|无法|不能|尚未|未提供|待补充/.test(item.text)) fail('当前根状态未知的证据只能支持数据缺口与还原限制，不能支持确定的价格状态。');
  if (used.some(entry => entry.timeClass === 'recollection')) {
    if (interpretation && !uncertain && !prospectiveReminder) fail('基于事后回忆的解释必须明确不确定性。可写「仅凭用户回忆无法证明当时严格执行了计划」或「根据用户回忆，可能与计划有关，仍需核实」。中性来源转述可放入 facts 并写明「用户自述」；无需给逐笔成交事实添加回忆免责声明。');
    if (!interpretation && !/回忆|补充|自述|记得|表示|用户称|用户记录|用户填写/.test(item.text)) fail('回忆只能支持用户陈述的事实，不能直接证明当时情况。');
  }
  if (used.some(entry => entry.timeClass === 'unknown') && interpretation && !uncertain && !prospectiveReminder && !attributedBackgroundStatement(item.text, used)) fail('证据时点未知，解释必须保留不确定性。仅转述用户填写内容时请明确来源；涉及当时认知、执行或因果判断时仍需标明待核实。');
  if (used.some(entry => entry.timeClass === 'after')) {
    const limitation = /事后|晚于|成交后|决策后|之后|后发布/.test(item.text) && /不能|无法|不应|不足以|不代表|不证明|不构成|不可/.test(item.text);
    if ((interpretation && !limitation) || (/事前已知|当时已知|买入前已|决策前已|促使.{0,8}(?:买入|卖出)|导致.{0,8}(?:买入|卖出)/.test(item.text) && !limitation)) fail('决策后证据不能作为事前决策的归因依据。');
    if (!interpretation && used.some(entry => entry.type === 'market' && entry.timeClass === 'after') && !/事后|晚于|成交后|决策后|之后/.test(item.text)) fail('事后行情事实必须明确标注其相对决策的时点。');
  }
}

// A reference-free opening is limited to process guidance or an actual question.
// Questions can mention a row number/time. They must not smuggle a declarative
// conclusion before the question. These checks are conservative guardrails, not
// a proof that arbitrary natural-language claims follow from their sources.
function referenceFreeGuidance(text) {
  return text.length <= 1200 && text.split(/(?<=[。！？!?])\s*|\n+/u).filter(Boolean).every(sentence => {
    if (/[^？?][？?]$/.test(sentence) && sentence.length <= 400
      && !/既然|已经证明|事实证明|显然|因此|所以/.test(sentence)) return true;
    const clauses = sentence.replace(/[。！!]+$/, '').split(/[，,；;]/).map(part => part.trim()).filter(Boolean);
    return clauses.every(part => {
      if (/^(?:这些|当前|本次|所提供的)?(?:材料|资料|证据|信息)(?:不足|缺失|不完整|仍需核对|仍待确认|需要补充|有待核实)$/.test(part)) return true;
      if (/^(?:资料不足的部分|缺少依据的部分|未知部分|不清楚的部分)(?:保留待确认|仍需核对|仍待确认)$/.test(part)) return true;
      if (/\d|已知|确认了|证明|导致|促使|因此|所以|偏差|自信|从众|亏损|盈利|利润|收益|当时已经|当时存在/.test(part)) return false;
      return /^(?:(?:请(?:先|再)?|先|再|继续|我们先|我想先|可以先|建议先)(?:结合[^。！？]{0,40})?)?(?:核对|补充|确认|提供|说明|回忆|记录|查看|检查|整理|先看)/.test(part);
    });
  });
}

const UNCERTAIN_CLAIM = /可能|不确定|待核实|待确认|无法确认|不能确认|无法判断|不能判断|尚不能|仍需|有待|未证实|不足以|不能(?:直接)?证明|无法证明|不代表|并非(?:已经)?证明|不能替代|未经(?:另行)?检验/;
const BEHAVIOR_CLAIM = /行为偏差|认知偏差|过度自信|从众|追涨杀跌|恐慌|贪婪|冲动交易|锚定|损失厌恶|确认偏误|侥幸/;
// Completed market windows are observable timing facts. Require a cognition or
// personal-plan verb after the temporal prefix before treating it as attribution.
const CAUSAL_CLAIM = /促使.{0,12}(?:买入|卖出|加仓|减仓)|导致.{0,12}(?:买入|卖出|加仓|减仓)|(?:买入|卖出|决策|交易)(?:的)?(?:原因|动机)(?:是|为)|(?:当时|买入前|成交前)已(?:经)?(?:知|看过|看到|看完|掌握|了解|获悉|阅读|听说|制定|执行|设置|设定|遵守)|用户当时(?:知道|掌握|认为|相信|预期)/;

function numericClaims(text, patterns, allowed, label, tolerance = 0.005) {
  for (const pattern of patterns) for (const match of text.matchAll(pattern)) {
    const value = Number(match[1].replaceAll(',', ''));
    if (!allowed.some(number => typeof number === 'number' && Number.isFinite(number) && Math.abs(number - value) <= tolerance)) fail(`${label}与所引用的原始字段或确定性核算不一致；数据不完整时不能生成数值结论。`);
  }
}

function groundedClaim(item, evidence, context, interpretation, prospective = false) {
  // The learning schema is a future trigger/action/exception, not a historical
  // interpretation. Only explicit affirmative claims about past execution or
  // knowledge inside that card need the historical attribution checks.
  if (prospective) {
    const clauses = item.text.split(/[，,。！？!?；;\n]+/u).map(part => part.trim()).filter(Boolean);
    for (const text of clauses) {
      const historical = /(?:当时|过去|历史上|此前|曾经|已经).{0,12}(?:执行|遵守|制定|知道|掌握|认为|相信)|(?:已经|已)(?:执行|制定|遵守)|(?:执行|制定|遵守)(?:了|过)/.test(text) || CAUSAL_CLAIM.test(text);
      if (historical && !/不|未|无|是否/.test(text) && !UNCERTAIN_CLAIM.test(text)) groundedClaim({ ...item, text }, evidence, context, true);
    }
    numericGrounding(item, evidence, context);
    return;
  }
  temporalClaim(item, evidence, interpretation);
  const used = item.evidenceIds.map(id => evidence.get(id));
  const uncertain = UNCERTAIN_CLAIM.test(item.text);
  const limitation = /不能|无法|不足以|尚不能|不代表|不证明|不构成/.test(item.text);
  if (BEHAVIOR_CLAIM.test(item.text) && !limitation && (!uncertain || !used.some(entry => entry.type === 'background'))) fail('行为偏差只能作为有用户背景依据的待核实解释，不能从成交或行情直接断言心理动机。');
  if (CAUSAL_CLAIM.test(item.text) && !limitation && (!uncertain || !used.some(entry => entry.type === 'background'))) fail('公开信息和成交记录不能直接证明用户当时的认知或买卖动机。');
  numericGrounding(item, evidence, context);
}

function numericGrounding(item, evidence, context) {
  const used = item.evidenceIds.map(id => evidence.get(id));
  // Trade amounts are checked against the cited trades, not against arbitrary
  // numbers elsewhere in the context. Aggregate P/L uses the same cent-based
  // calculation as get_summary and stays unknown for an incomplete cycle.
  const trades = context.trades.filter(trade => used.some(entry => entry.type === 'trade' && entry.tradeId === trade.id));
  const sum = key => trades.reduce((total, trade) => total + trade[key], 0);
  const summary = summarizeTrades(trades);
  const amount = '(-?\\d[\\d,]*(?:\\.\\d+)?)';
  const quantity = [new RegExp(`${amount}\\s*股`, 'g')];
  numericClaims(item.text, quantity, [...trades.map(trade => trade.quantity), ...(trades.length ? [sum('quantity')] : [])], '成交数量', 1e-9);
  numericClaims(item.text, [new RegExp(`(?:成交价|成交价格|买入价|卖出价|每股价格)(?:格)?(?:为|是|约为|约|[:：])?\\s*${amount}`, 'g')], trades.map(trade => trade.price), '成交价格');
  numericClaims(item.text, [new RegExp(`(?:费用|手续费|交易费)(?:合计|总计|共|为|是|[:：])?\\s*${amount}`, 'g')], [...trades.map(trade => trade.fee), ...(trades.length && trades.every(trade => trade.fee !== null) ? [sum('fee')] : [])], '费用');
  numericClaims(item.text, [new RegExp(`(?:净盈亏|净利润|净收益|净盈利|实现盈亏|已实现盈亏)(?:合计|总计|为|是|约为|约|[:：])?\\s*${amount}`, 'g')], [summary.netPnl], '净盈亏');
  numericClaims(item.text, [new RegExp(`(?:收益率|回报率)(?:为|是|约为|约|[:：])?\\s*${amount}\\s*[%％]`, 'g')], [summary.returnPct], '投入收益率', 0.01);
}

function groundedClaimAt(item, evidence, context, interpretation, path, prospective = false) {
  try { groundedClaim(item, evidence, context, interpretation, prospective); }
  catch (error) {
    // Path and message are application-authored; never include the rejected
    // model text or an upstream response in repair feedback or UI diagnostics.
    if (error?.code === 'CONTRACT_VALIDATION') fail(`${path}：${error.message}`);
    throw error;
  }
}

/** Limit one preparation response while retaining the whole session as readable history. */
export function validatePrepareTradeIds(task, value, context) {
  if (value === undefined) return undefined;
  if (task !== 'prepare') fail('prepareTradeIds 仅用于导入背景准备。');
  const ids = list(value, '本批准备成交', 5).map(id => string(id, '本批准备成交 ID', 160));
  if (!ids.length) fail('本批准备成交需要 1 至 5 笔。');
  if (new Set(ids).size !== ids.length) fail('本批准备成交不能重复。');
  const known = new Set(context.trades.map(trade => trade.id));
  if (ids.some(id => !known.has(id))) fail('本批准备成交超出当前会话范围。');
  return ids;
}

/** Structural and conservative evidence checks; never substitutes for human verification. */
export function validateResult(task, value, input, suppliedEvidence, options = {}) {
  record(value, '模型结果');
  record(options, '结果校验选项');
  if (task !== 'prepare' && options.prepareTradeIds !== undefined) fail('prepareTradeIds 仅用于导入背景准备。');
  if (task === 'import') return validateImportResult(value);
  const context = validateContext(input);
  if (task === 'parse') {
    const result = { trades: validateTradeCollection(value.trades, true), questions: strings(value.questions, 'questions', 10), warnings: strings(value.warnings, 'warnings', 20) };
    if ((!result.trades.length || result.trades.some(trade => FIELDS.some(field => trade[field] === null))) && !result.questions.length && !result.warnings.length) fail('缺失或有歧义的交易需要明确待确认问题，不能静默补齐。');
    safeTexts([...result.questions, ...result.warnings]);
    return result;
  }
  if (task === 'background') {
    const result = { questions: strings(value.questions, 'questions', 5), missing: strings(value.missing, 'missing', 20) };
    safeTexts([...result.questions, ...result.missing]);
    return result;
  }
  if (!['review', 'prepare'].includes(task)) fail('不支持的任务类型。');
  const canonical = new Map(buildEvidence(context).map(item => [item.id, item]));
  const entries = suppliedEvidence === undefined ? [...canonical.values()] : list(suppliedEvidence, '可引用证据', 3000).map(item => {
    if (!object(item) || !canonical.has(item.id) || !TYPES.has(item.type) || !CLASSES.has(item.timeClass)) fail('传入了当前范围之外的证据。');
    return canonical.get(item.id);
  });
  const available = new Map(entries.map(item => [item.id, item]));
  if (task === 'prepare') {
    if (value.researchIntent != null || value.learning != null) fail('导入准备只能生成未确认候选，不能执行研究或保存经验。');
    const seen = new Set(), trades = new Map(context.trades.map(trade => [trade.id, trade]));
    const targets = new Set(validatePrepareTradeIds(task, options.prepareTradeIds, context) ?? trades.keys());
    const suggestions = list(value.suggestions, '背景候选', 500).map((item, index) => {
      record(item, `背景候选 ${index + 1}`);
      const tradeId = string(item.tradeId, '候选成交 ID', 160), trade = trades.get(tradeId);
      if (!trade || seen.has(tradeId)) fail('背景候选必须逐笔对应当前成交，不能引用范围外成交或重复。');
      if (!targets.has(tradeId)) fail('背景候选只能输出本批 prepareTradeIds 指定的成交。');
      seen.add(tradeId);
      if (typeof item.unknown !== 'boolean') fail('背景候选必须明确 unknown，不能把推测当作已确认背景。');
      const result = { tradeId, reason: string(item.reason, '候选理由', 800, true), plan: string(item.plan, '候选计划', 800, true),
        basis: string(item.basis, '候选依据与边界', 1200), evidenceIds: referenceIds(item.evidenceIds, '候选 evidenceIds', available, true), unknown: true };
      const note = context.contexts[tradeId];
      if (note?.unknown && result.reason) fail('用户已表示记不清理由，该笔候选理由须留空。');
      if (note?.noPlan && result.plan) fail('用户已表示当时没有计划，该笔候选计划须留空。');
      // Existing editor text belongs to the user. Preparation only fills empty
      // fields and its declarative suggestions remain unconfirmed metadata.
      if (note?.reason?.trim()) result.reason = '';
      if (note?.plan?.trim()) result.plan = '';
      const used = result.evidenceIds.map(id => available.get(id));
      if (used.some(entry => entry.timeClass === 'after' || timestampMillis(trades.get(entry.tradeId)?.time) > timestampMillis(trade.time))) fail('背景候选不能把后续成交或事后证据作为该笔决策的依据。');
      if (result.reason || result.plan) {
        if (!used.length) fail('非空背景候选必须引用已读取证据。');
        for (const field of ['reason', 'plan']) {
          if (!result[field]) continue;
          const background = used.filter(entry => entry.type === 'background').map(entry => context.contexts[entry.tradeId]).filter(note => note && !(field === 'reason' ? note.unknown : note.noPlan)).map(note => note[field]).filter(Boolean).join('。');
          if (/请补充|请说明|[？?]|^(?:待确认|待补充|AI\s*草稿|候选)[:：\s]/.test(result[field])) fail('背景建议应是可直接填入的理由或计划陈述，不使用反问、请补充或待确认稿；没有依据时留空。');
          if (/公告|新闻|财报|研报/.test(result[field]) && !/公告|新闻|财报|研报/.test(background) && !used.some(entry => entry.type === 'event')) fail('没有对应背景或事件来源时，不能编造新闻作为理由或计划。');
          const suppliedNumbers = new Set((background.match(/\d+(?:\.\d+)?/g) || []).map(Number));
          if ((result[field].match(/\d+(?:\.\d+)?/g) || []).some(number => !suppliedNumbers.has(Number(number)))) fail('背景候选不能新增用户未提供的计划或动机数值。');
        }
      }
      if (context.marketData?.synthetic === true && !/合成|模拟|测试/.test(result.basis)) fail('合成资料的背景候选必须标明合成或测试边界。');
      if (used.length) groundedClaim({ text: result.basis, evidenceIds: result.evidenceIds }, available, context, true);
      // 「已确认的成交」 describes existing input. Reject a receipt that claims
      // the preparation itself confirmed a note, or saved/adopted any output.
      const receipt = /已(?:经)?(?:保存|采用)|已(?:经)?确认(?:了)?(?:你的|您的|本次|本笔|这些|这条|这笔|这个|该|上述|全部|所有)?(?:决策背景|背景|候选|建议|草稿|理由|计划|经验|检查项)|(?:决策背景|背景|候选|建议|草稿|理由|计划|经验|检查项)已(?:经)?(?:保存|确认|采用)|已(?:经)?确认(?:[。！；\n]|$)/;
      if (receipt.test([result.reason, result.plan, result.basis].join('。')) || /保证盈利|稳赚/.test([result.reason, result.plan, result.basis].join('。'))) fail('背景候选不能声称已保存、已确认或保证盈利。');
      safeTexts([result.reason, result.plan, result.basis]);
      return result;
    });
    if (suggestions.length !== targets.size) fail(options.prepareTradeIds === undefined ? '背景候选必须覆盖每笔已导入成交；证据不足时提供空理由、空计划和 unknown:true，并在 basis 说明缺口。' : '背景候选必须覆盖本批每笔 prepareTradeIds 成交；证据不足时提供空理由、空计划和 unknown:true，并在 basis 说明缺口。');
    const missing = strings(value.missing, 'missing', 30, 1200);
    safeTexts(missing);
    return { suggestions, missing };
  }
  const claims = (items, label, interpretation) => list(items, label, 30).map((item, index) => {
    record(item, label);
    const claim = { text: string(item.text, `${label}[${index}].text`, 6000), evidenceIds: referenceIds(item.evidenceIds, `${label}[${index}].evidenceIds`, available) };
    groundedClaimAt(claim, available, context, interpretation, `${label}[${index}]`);
    return claim;
  });
  const result = {
    text: string(value.text, 'text', 18000), facts: claims(value.facts, 'facts', false),
    interpretations: claims(value.interpretations, 'interpretations', true), uncertainties: strings(value.uncertainties, 'uncertainties', 30),
    suggestions: strings(value.suggestions, 'suggestions', 10), learning: null,
    evidenceIds: referenceIds(value.evidenceIds, 'evidenceIds', available, true),
  };
  const textEvidenceIds = referenceIds(value.textEvidenceIds ?? [], 'textEvidenceIds', available, true);
  if (textEvidenceIds.length) groundedClaimAt({ text: result.text, evidenceIds: textEvidenceIds }, available, context, true, 'text');
  else if (!referenceFreeGuidance(result.text)) fail('主回复中的结论必须提供 textEvidenceIds；无引用时只能提出澄清问题或中性的核对引导。');
  // Preserve old reference-free conversation records; new model replies always
  // use the explicit field in the prompt. Never borrow another claim's refs.
  if (value.textEvidenceIds !== undefined || textEvidenceIds.length) result.textEvidenceIds = textEvidenceIds;
  if (value.learning !== null) {
    record(value.learning, 'learning');
    result.learning = Object.fromEntries(['title', 'trigger', 'action', 'exception'].map(key => [key, string(value.learning[key], `learning.${key}`, 3000, key === 'exception')]));
    result.learning.evidenceIds = referenceIds(value.learning.evidenceIds, 'learning.evidenceIds', available);
    groundedClaimAt({ text: Object.values(result.learning).filter(value => typeof value === 'string').join('。'), evidenceIds: result.learning.evidenceIds }, available, context, true, 'learning', true);
  }
  const allReferences = [...textEvidenceIds, ...[...result.facts, ...result.interpretations].flatMap(item => item.evidenceIds), ...(result.learning?.evidenceIds || [])];
  if (allReferences.some(id => !result.evidenceIds.includes(id))) fail('evidenceIds 未包含结论实际引用的全部证据。');
  safeTexts([result.text, ...result.facts.map(item => item.text), ...result.interpretations.map(item => item.text), ...result.uncertainties, ...result.suggestions, ...Object.values(result.learning ?? {}).filter(value => typeof value === 'string')]);
  return result;
}
