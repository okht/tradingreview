import Papa from 'papaparse';

const FIELDS = ['id', 'symbol', 'name', 'time', 'side', 'quantity', 'price', 'fee'];
const MAX_ROWS = 500;
const MAX_CENTS = BigInt(Number.MAX_SAFE_INTEGER);

// All trades and the instrument below are fictional demonstration data.
export const sampleTrades = [
  { id: 'DEMO-01', symbol: 'DEMO001', name: '远川科技', time: '2025-09-02T09:45', side: 'buy', quantity: 500, price: 40, fee: 5 },
  { id: 'DEMO-02', symbol: 'DEMO001', name: '远川科技', time: '2025-09-08T10:00', side: 'buy', quantity: 300, price: 42, fee: 5 },
  { id: 'DEMO-03', symbol: 'DEMO001', name: '远川科技', time: '2025-09-18T14:30', side: 'sell', quantity: 800, price: 46, fee: 23.4 },
];

export const sampleCsv = Papa.unparse(sampleTrades, { columns: FIELDS, newline: '\n' });

export const defaultLearning = {
  title: '加仓前，核对理由和信息时间',
  trigger: '准备对已有持仓继续加仓时',
  action: '记录本次加仓依据及信息发布时间，并注明是否属于原定分批计划。',
  exception: '按原定分批计划执行时，补充计划来源；资料不足时保留待确认，不直接判断执行有误。',
};

// Local wall-clock time is always interpreted as Asia/Shanghai. We deliberately
// reject date-only input and offsets rather than silently shifting a decision.
function normalizeTime(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!match) return null;
  const [, y, m, d, hh, mm, ss = '00'] = match;
  const [year, month, day, hour, minute, second] = [y, m, d, hh, mm, ss].map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1]
    || hour > 23 || minute > 59 || second > 59) return null;
  return `${y}-${m}-${d}T${hh}:${mm}${ss === '00' ? '' : `:${ss}`}`;
}

// Convert a finite nonnegative number's decimal representation to integers.
// This also handles scientific notation, without rounding tiny positions away.
function decimalParts(value) {
  const [mantissa, exponent = '0'] = String(value).toLowerCase().split('e');
  const [whole, fraction = ''] = mantissa.split('.');
  let integer = BigInt(whole + fraction);
  let scale = fraction.length - Number(exponent);
  if (scale < 0) {
    integer *= 10n ** BigInt(-scale);
    scale = 0;
  }
  return { integer, scale };
}

// Round each execution's cash amount once to cents (decimal half-up), then sum
// cents. Fees are rounded independently. The prototype does not model dividends.
function cents(value, quantity = 1) {
  const a = decimalParts(value);
  const b = decimalParts(quantity);
  const integer = a.integer * b.integer;
  const scale = a.scale + b.scale;
  if (scale <= 2) return integer * 10n ** BigInt(2 - scale);
  const divisor = 10n ** BigInt(scale - 2);
  return (integer + divisor / 2n) / divisor;
}

function validateRecords(records) {
  const errors = [];
  const trades = [];
  const ids = new Set();
  const signatures = new Set();
  if (!Array.isArray(records) || !records.length) return { trades: [], errors: ['没有可用的交易记录。'] };
  if (records.length > MAX_ROWS) return { trades: [], errors: [`最多支持 ${MAX_ROWS} 条交易，请先筛选一个持仓周期。`] };

  records.forEach((record, index) => {
    const prefix = `第 ${index + 1} 条交易`;
    const row = Object.fromEntries(FIELDS.map((field) => [field, String(record?.[field] ?? '').trim()]));
    const missing = FIELDS.filter((field) => !row[field]);
    if (missing.length) {
      errors.push(`${prefix}缺少必填值：${missing.join('、')}。`);
      return;
    }
    const time = normalizeTime(row.time);
    if (!time) errors.push(`${prefix}的 time 无效，请填写有效的中国本地日期时间，如 2025-09-08T10:00。`);
    if (!['buy', 'sell'].includes(row.side)) errors.push(`${prefix}的 side 只支持 buy 或 sell。`);
    const numbers = {};
    for (const field of ['quantity', 'price', 'fee']) {
      const number = Number(row[field]);
      const isDecimalInput = typeof record[field] === 'number' || /^\d+(?:\.\d+)?$/.test(row[field]);
      if (!isDecimalInput || !Number.isFinite(number)
        || (field === 'fee' ? number < 0 : number <= 0)) {
        errors.push(`${prefix}的 ${field} 必须为${field === 'fee' ? '非负' : '正'}有限十进制数。`);
      } else {
        numbers[field] = number;
      }
    }
    if (ids.has(row.id)) errors.push(`${prefix}的 id 重复：${row.id}。`);
    ids.add(row.id);
    if (!time || !['buy', 'sell'].includes(row.side) || Object.keys(numbers).length !== 3) return;
    const trade = { ...row, time, ...numbers };
    const signature = JSON.stringify([trade.symbol, time, trade.side, trade.quantity, trade.price, trade.fee]);
    if (signatures.has(signature)) errors.push(`${prefix}与其他记录重复，请核对成交时间、方向、数量、价格和费用。`);
    signatures.add(signature);
    if (cents(trade.price, trade.quantity) > MAX_CENTS || cents(trade.fee) > MAX_CENTS) {
      errors.push(`${prefix}的金额超过原型可精确处理的范围。`);
    }
    trades.push(trade);
  });
  if (new Set(trades.map((trade) => trade.symbol)).size > 1) errors.push('当前原型每次只支持一个标的，请筛选后重新导入。');
  return { trades: errors.length ? [] : trades, errors };
}

/** Any invalid row blocks the whole import: no silent partial portfolio. */
export function parseTradesCsv(text) {
  if (typeof text !== 'string' || !text.trim()) return { trades: [], errors: ['请先粘贴或选择 CSV 交易记录。'] };
  const parsed = Papa.parse(text.replace(/^\uFEFF/, ''), { delimiter: ',', skipEmptyLines: 'greedy' });
  const errors = parsed.errors.map((error) => `CSV 格式错误：${error.message}`);
  const [rawHeader = [], ...rows] = parsed.data;
  const header = rawHeader.map((cell) => String(cell).trim());
  const missing = FIELDS.filter((field) => !header.includes(field));
  if (missing.length) errors.push(`CSV 缺少必需列：${missing.join('、')}。`);
  if (new Set(header).size !== header.length) errors.push('CSV 存在重复列名，请使用标准模板。');
  if (rows.length > MAX_ROWS) errors.push(`最多支持 ${MAX_ROWS} 条交易，请先筛选一个持仓周期。`);
  rows.forEach((row, index) => {
    if (row.length !== header.length) errors.push(`第 ${index + 1} 条交易的列数与表头不一致。`);
  });
  if (errors.length) return { trades: [], errors };
  return validateRecords(rows.map((row) => Object.fromEntries(header.map((field, index) => [field, row[index]]))));
}

/**
 * Flat-boundary state loop adapted from tradr's walkScope (Apache-2.0):
 * https://github.com/madmatt112/tradr/blob/78e63c0a40d1467aad9795f3f219d1f455e6d4db/apps/api/src/features/csv-import/csv-segment.ts
 * Changes: single instrument, long-only, explicit buy/sell, BigInt quantity
 * arithmetic instead of decimal.js, and local errors. No network or DB access.
 * See the bundled third-party license notice for the upstream Apache-2.0 terms.
 */
function segmentLongOnly(ordered) {
  const quantityParts = ordered.map((trade) => decimalParts(trade.quantity));
  const scale = Math.max(...quantityParts.map((part) => part.scale));
  const sidesByTime = new Map();
  for (const trade of ordered) {
    const sides = sidesByTime.get(trade.time) ?? new Set();
    sides.add(trade.side);
    sidesByTime.set(trade.time, sides);
  }
  if ([...sidesByTime.values()].some((sides) => sides.size > 1)) {
    // CSV row order cannot establish an intratimestamp execution sequence.
    // A net quantity is order-independent, but cycle boundaries are unknown.
    const netQuantity = quantityParts.reduce((total, part, index) => {
      const quantity = part.integer * 10n ** BigInt(scale - part.scale);
      return total + (ordered[index].side === 'buy' ? quantity : -quantity);
    }, 0n);
    return {
      position: Number(`${netQuantity}e-${scale}`),
      segments: [],
      issues: ['同一时刻包含买入与卖出，现有时间精度无法确定成交顺序。请补充更精确的成交时间，再核对持仓周期和盈亏。'],
    };
  }
  let net = 0n;
  let current = [];
  const segments = [];
  const issues = [];
  for (let index = 0; index < ordered.length; index++) {
    const trade = ordered[index];
    const part = quantityParts[index];
    const qty = part.integer * 10n ** BigInt(scale - part.scale);
    const signedQty = trade.side === 'buy' ? qty : -qty;
    const nextNet = net + signedQty;
    if (nextNet < 0n) {
      issues.push(net === 0n ? '记录中出现先卖出后买入，请补齐期初交易；当前不支持做空。' : '卖出数量超过当时持仓，请核对是否遗漏买入记录。');
      return { position: Number(`${net}e-${scale}`), segments, issues };
    }
    current.push(trade);
    net = nextNet;
    if (net === 0n) {
      segments.push({ executions: current, closes: true });
      current = [];
    }
  }
  if (current.length > 0) segments.push({ executions: current, closes: false });
  return { position: Number(`${net}e-${scale}`), segments, issues };
}

function cashTotals(trades) {
  let buy = 0n;
  let sell = 0n;
  let buyFees = 0n;
  let fees = 0n;
  for (const trade of trades) {
    const amount = cents(trade.price, trade.quantity);
    const fee = cents(trade.fee);
    fees += fee;
    if (trade.side === 'buy') { buy += amount; buyFees += fee; }
    else sell += amount;
  }
  return { buy, sell, buyFees, fees };
}

/**
 * Net P&L sums all validated flat-to-flat holding cycles in this selection.
 * Each cycle's return denominator is its buy amounts plus buy fees. Multiple
 * cycles may reuse capital, so their aggregate return remains unknown.
 */
export function summarizeTrades(input) {
  const empty = { buyAmount: 0, sellAmount: 0, fees: 0, netPnl: null, returnPct: null, position: 0, isComplete: false, cycleCount: 0, cycles: [], issues: [] };
  const checked = validateRecords(input);
  if (checked.errors.length) return { ...empty, issues: checked.errors };
  const ordered = [...checked.trades].sort((a, b) => a.time.localeCompare(b.time));
  const { position, segments, issues } = segmentLongOnly(ordered);
  const { buy, sell, buyFees, fees } = cashTotals(ordered);
  if ([buy, sell, fees, buy + buyFees].some((value) => value > MAX_CENTS)) {
    return { ...empty, position, issues: [...issues, '累计金额超过原型可精确处理的范围。'] };
  }
  if (position !== 0 && !issues.length) issues.push('当前持仓尚未清仓。缺少期末估值，暂不计算完整周期盈亏和收益率。');
  const isComplete = !issues.length && segments.length > 0 && segments.every(segment => segment.closes);
  const profit = sell - buy - fees;
  const cycles = isComplete ? segments.map(({ executions }) => {
    const totals = cashTotals(executions);
    const net = totals.sell - totals.buy - totals.fees;
    return { tradeIds: executions.map(trade => trade.id), from: executions[0].time, to: executions.at(-1).time,
      buyAmount: Number(totals.buy) / 100, sellAmount: Number(totals.sell) / 100, fees: Number(totals.fees) / 100,
      netPnl: Number(net) / 100, returnPct: totals.buy + totals.buyFees > 0n ? Number(net) / Number(totals.buy + totals.buyFees) * 100 : null };
  }) : [];
  return {
    buyAmount: Number(buy) / 100,
    sellAmount: Number(sell) / 100,
    fees: Number(fees) / 100,
    netPnl: isComplete ? Number(profit) / 100 : null,
    returnPct: isComplete && cycles.length === 1 ? cycles[0].returnPct : null,
    position,
    isComplete,
    cycleCount: cycles.length,
    cycles,
    issues,
  };
}
