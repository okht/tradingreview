import { selectSyntheticChartData } from '../src/synthetic-market.js';

// A deliberately small, executable rule language. Model output never supplies
// performance numbers, arbitrary code, or a retrospective optimal fill price.
const DAY = 86400000;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const round = (value, digits = 6) => Math.round(value * 10 ** digits) / 10 ** digits;
const clone = value => JSON.parse(JSON.stringify(value));
const dayOf = time => new Date(time + 8 * 3600000).toISOString().slice(0, 10);
const iso = time => new Date(time).toISOString();
const fail = message => { const error = new Error(message); error.status = 400; throw error; };
const unavailable = (reason, extra = {}) => ({ status: 'unavailable', reason, metrics: null, ...extra });
function text(value, fallback = '', max = 2000) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || value.length > max) fail('交易方法文本格式无效。');
  return value.trim();
}
function num(value, min, max, label, integer = false) {
  if (!finite(value) || value < min || value > max || integer && !Number.isInteger(value)) fail(`${label}超出可执行范围。`);
  return value;
}
function time(value, end = false) {
  if (typeof value !== 'string') fail('需要有效的日期或北京时间。');
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  if (!dateOnly && !/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?$/.test(value)) fail('日期时间格式无效。');
  const day = value.slice(0, 10), midnight = Date.parse(`${day}T00:00:00Z`);
  if (!finite(midnight) || new Date(midnight).toISOString().slice(0, 10) !== day) fail('日期无效。');
  if (!dateOnly) {
    const match = value.match(/[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
    if (+match[1] > 23 || +match[2] > 59 || +(match[3] || 0) > 59) fail('时间无效。');
  }
  const parsed = Date.parse(dateOnly ? `${value}T${end ? '23:59:59.999' : '00:00:00'}+08:00` : /(Z|[+-]\d{2}:\d{2})$/.test(value) ? value : `${value}+08:00`);
  if (!finite(parsed)) fail('时间无效。');
  return parsed;
}
function hash(value) { let result = 2166136261; for (const character of value) result = Math.imul(result ^ character.charCodeAt(0), 16777619); return (result >>> 0).toString(36); }

export function validateMethod(input) {
  if (!object(input) || !object(input.rules)) fail('交易方法缺少可执行规则。');
  const rule = input.rules;
  if (Object.keys(rule).some(key => !['kind', 'lookback', 'entryDeviationPct', 'exitDeviationPct', 'allocationPct', 'stopLossPct', 'takeProfitPct', 'maxHoldBars'].includes(key))) fail('包含未支持的交易规则，需先明确为可执行条件。');
  if (!['trend', 'mean-reversion'].includes(rule.kind)) fail('当前可执行规则支持趋势与均值回归。');
  const rules = {
    kind: rule.kind,
    lookback: num(rule.lookback, 2, 120, '回看 K 线数', true),
    entryDeviationPct: num(rule.entryDeviationPct ?? 0, 0, 30, '入场偏离幅度'),
    exitDeviationPct: num(rule.exitDeviationPct ?? 0, 0, 30, '离场偏离幅度'),
    allocationPct: num(rule.allocationPct ?? 80, 1, 100, '仓位比例'),
    stopLossPct: rule.stopLossPct == null ? null : num(rule.stopLossPct, 0.1, 90, '止损比例'),
    takeProfitPct: rule.takeProfitPct == null ? null : num(rule.takeProfitPct, 0.1, 500, '止盈比例'),
    maxHoldBars: rule.maxHoldBars == null ? null : num(rule.maxHoldBars, 1, 1000, '最长持有 K 线数', true),
  };
  const origin = input.origin ?? 'inferred';
  if (!['inferred', 'user-described', 'improved'].includes(origin)) fail('交易方法来源无效。');
  const rawDerivation = input.derivation ?? {};
  if (!object(rawDerivation)) fail('方法推导范围无效。');
  const tradeIds = rawDerivation.tradeIds ?? [];
  if (!Array.isArray(tradeIds) || tradeIds.length > 500 || tradeIds.some(id => typeof id !== 'string' || id.length > 120)) fail('方法关联成交无效。');
  for (const field of ['from', 'to']) if (rawDerivation[field]) time(rawDerivation[field], field === 'to');
  if (rawDerivation.from && rawDerivation.to && time(rawDerivation.from) > time(rawDerivation.to, true)) fail('方法推导时间范围无效。');
  const derivation = { symbol: text(rawDerivation.symbol, '', 40), from: text(rawDerivation.from, '', 40), to: text(rawDerivation.to, '', 40), tradeIds: [...new Set(tradeIds)] };
  const method = {
    id: text(input.id, `method-${hash(JSON.stringify([rules, derivation]))}`, 160),
    title: text(input.title, rules.kind === 'trend' ? '均线趋势候选' : '均值回归候选', 120),
    version: num(input.version ?? 1, 1, 10000, '方法版本', true),
    parentId: input.parentId == null ? null : text(input.parentId, '', 160),
    origin, status: input.status === 'ready' ? 'ready' : 'candidate', rules, derivation,
    description: text(input.description),
  };
  method.rulesSummary = [
    `以最近 ${rules.lookback} 根完整 K 线均价为基准，${rules.kind === 'trend' ? '高于' : '低于'}均价 ${rules.entryDeviationPct}% 时产生买入信号`,
    `${rules.kind === 'trend' ? '低于' : '高于'}均价 ${rules.exitDeviationPct}% 时产生卖出信号`,
    `单次投入不超过初始资金的 ${rules.allocationPct}%，不叠加持仓`,
    ...(rules.stopLossPct === null ? [] : [`完整 K 线确认亏损达到 ${rules.stopLossPct}% 后退出`]),
    ...(rules.takeProfitPct === null ? [] : [`完整 K 线确认盈利达到 ${rules.takeProfitPct}% 后退出`]),
    ...(rules.maxHoldBars === null ? [] : [`最多持有 ${rules.maxHoldBars} 根 K 线后提出退出`]),
    '信号形成后的下一可用开盘执行，卖出遵守 T+1',
  ];
  // Compact derived evidence survives persistence, while unrecognized metrics
  // and executable fields are dropped. Service code must only accept this
  // analysis from inferMethods, never use model-provided scores as verification.
  if (input.analysis !== undefined) {
    const analysis = input.analysis;
    if (!object(analysis)) fail('方法证据格式无效。');
    const ids = field => {
      const values = analysis[field] ?? [];
      if (!Array.isArray(values) || values.length > 500 || values.some(id => typeof id !== 'string' || id.length > 120 || !tradeIds.includes(id))) fail('方法证据关联了范围外的成交。');
      return [...new Set(values)];
    };
    const supportedTradeIds = ids('supportedTradeIds'), counterexampleTradeIds = ids('counterexampleTradeIds'), unassessableTradeIds = ids('unassessableTradeIds');
    if (new Set([...supportedTradeIds, ...counterexampleTradeIds, ...unassessableTradeIds]).size !== supportedTradeIds.length + counterexampleTradeIds.length + unassessableTradeIds.length) fail('方法证据分类冲突。');
    const nonTradeSignals = analysis.nonTradeSignals ?? [];
    if (!Array.isArray(nonTradeSignals) || nonTradeSignals.length > 40) fail('未成交信号数量无效。');
    method.analysis = { supportedTradeIds, counterexampleTradeIds, unassessableTradeIds,
      agreementPct: supportedTradeIds.length + counterexampleTradeIds.length ? round(100 * supportedTradeIds.length / (supportedTradeIds.length + counterexampleTradeIds.length), 2) : null,
      nonTradeSignalCount: num(analysis.nonTradeSignalCount ?? nonTradeSignals.length, nonTradeSignals.length, 4000, '未成交信号数', true),
      nonTradeSignals: nonTradeSignals.map(signal => {
        if (!object(signal) || !['buy', 'sell'].includes(signal.side)) fail('未成交信号格式无效。');
        return { time: iso(time(signal.time)), side: signal.side, deviationPct: num(signal.deviationPct, -100, 10000, '偏离幅度') };
      }), scope: text(analysis.scope),
      limitations: Array.isArray(analysis.limitations) && analysis.limitations.length <= 10 ? analysis.limitations.map(value => text(value)) : [] };
  }
  return method;
}

function marketBars(data) {
  if (!object(data) || data.status !== 'ok') fail('尚未取得可用于回测的行情。');
  if (data.currency !== 'CNY' || data.timeZone !== 'Asia/Shanghai' || data.adjust !== 'none') fail('当前回测仅支持人民币、不复权、北京时间行情。');
  let bars;
  if (data.provider === 'synthetic' && data.synthetic === true && data.interval === '5m') {
    if (!Array.isArray(data.pricePoints) || !data.pricePoints.length || data.pricePoints.length > 10000) fail('合成行情观测数量无效。');
    let previous = -Infinity;
    for (const point of data.pricePoints) {
      if (!Number.isSafeInteger(point.time) || point.time <= previous || point.time % 300 !== 0 || !finite(point.price) || point.price <= 0) fail('合成价格观测无效或重复。');
      previous = point.time;
    }
    bars = selectSyntheticChartData({ marketData: data, trades: [{ id: 'analysis', symbol: data.symbol }], interval: '4H' }).candles
      .map(bar => ({ ...bar, openAt: time(bar.sourceFrom), availableAt: time(bar.endAt), markAt: time(bar.lastObservedAt) }));
    // A partial observation window cannot be treated as a final candle.
    bars = bars.filter(bar => bar.startAt.slice(11, 16) === '08:00'
      ? bar.markAt >= time(`${dayOf(bar.openAt)}T11:30`) : bar.markAt >= time(`${dayOf(bar.openAt)}T15:00`));
  } else if (data.provider === 'fuyao' && data.interval === '1D' && Array.isArray(data.bars) && data.bars.length <= 4000) {
    bars = data.bars.map(bar => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(bar.time) || bar.isPartial || bar.status === 'partial') fail('完整日线日期无效。');
      const openAt = time(`${bar.time}T09:30`), markAt = time(`${bar.time}T15:00`);
      const nextDay = new Date(time(bar.time) + DAY + 8 * 3600000).toISOString().slice(0, 10);
      const availableAt = time(`${nextDay}T00:00`);
      if (!bar.closedAt || time(bar.closedAt) !== availableAt) fail('日线必须遵守次日可用口径。');
      if (data.observedAt && availableAt > time(data.observedAt)) fail('行情采集时日线尚未完整。');
      return { ...bar, openAt, availableAt, markAt };
    });
  } else fail('当前行情源尚未支持可复现回测。');
  bars.sort((a, b) => a.openAt - b.openAt);
  if (!bars.length) fail('没有完整 K 线可用于回测。');
  for (let index = 0; index < bars.length; index++) {
    const bar = bars[index];
    if (['open', 'high', 'low', 'close'].some(field => !finite(bar[field]) || bar[field] <= 0 || bar[field] > 1e9)
      || bar.high < Math.max(bar.open, bar.close, bar.low) || bar.low > Math.min(bar.open, bar.close, bar.high)
      || index > 0 && bar.openAt <= bars[index - 1].openAt) fail('行情价格或时间不自洽。');
  }
  return bars;
}
function signalAt(bars, index, rules) {
  if (index < rules.lookback - 1) return null;
  const average = bars.slice(index - rules.lookback + 1, index + 1).reduce((sum, bar) => sum + bar.close, 0) / rules.lookback;
  const deviationPct = (bars[index].close / average - 1) * 100;
  return { average, deviationPct,
    buy: rules.kind === 'trend' ? deviationPct > rules.entryDeviationPct : deviationPct < -rules.entryDeviationPct,
    sell: rules.kind === 'trend' ? deviationPct < -rules.exitDeviationPct : deviationPct > rules.exitDeviationPct };
}
function executionIndex(bars, decisionIndex) {
  for (let index = decisionIndex + 1; index < bars.length; index++) if (bars[index].openAt >= bars[decisionIndex].availableAt) return index;
  return -1;
}
function methodAnalysis(method, trades, bars) {
  const supportedTradeIds = [], counterexampleTradeIds = [], unassessableTradeIds = [];
  for (const trade of trades) {
    const at = time(trade.time);
    const index = bars.findLastIndex(bar => bar.availableAt <= at);
    const signal = index < 0 ? null : signalAt(bars, index, method.rules);
    if (!signal) unassessableTradeIds.push(trade.id);
    else if (signal[trade.side] === true) supportedTradeIds.push(trade.id);
    else counterexampleTradeIds.push(trade.id);
  }
  const nonTradeSignals = [];
  const start = Math.min(...trades.map(trade => time(trade.time))), end = Math.max(...trades.map(trade => time(trade.time)));
  for (let index = method.rules.lookback - 1; index < bars.length - 1; index++) {
    const fillIndex = executionIndex(bars, index);
    if (fillIndex < 0) continue;
    const bar = bars[fillIndex];
    if (bar.openAt < start || bar.openAt > end) continue;
    const signal = signalAt(bars, index, method.rules);
    const side = signal.buy ? 'buy' : signal.sell ? 'sell' : null;
    // Compare all opportunities in the observed window, including bars with no
    // recorded action. This is association coverage, not a motive probability.
    if (side && !trades.some(trade => trade.side === side && time(trade.time) >= bar.openAt && time(trade.time) <= bar.markAt))
      nonTradeSignals.push({ time: iso(bar.openAt), side, deviationPct: round(signal.deviationPct) });
  }
  return { supportedTradeIds, counterexampleTradeIds, unassessableTradeIds,
    agreementPct: supportedTradeIds.length + counterexampleTradeIds.length ? round(100 * supportedTradeIds.length / (supportedTradeIds.length + counterexampleTradeIds.length), 2) : null,
    nonTradeSignalCount: nonTradeSignals.length, nonTradeSignals: nonTradeSignals.slice(0, 40),
    scope: '仅衡量已有行情特征与成交方向的相符程度；仓位、主观动机及完整候选标的集合未知。',
    limitations: ['同一成交可能符合多种规则，不能据此还原真实意图。', '未成交信号只表示当前账户记录未出现对应成交，不证明用户当时观察过该机会。', '参数采用固定候选值，未按历史收益择优。'] };
}

function inferenceInputs(context) {
  const trades = Array.isArray(context.trades) ? context.trades : [];
  if (!trades.length || trades.length > 500) fail('请先导入 1 至 500 笔需要提炼的成交记录。');
  const bars = marketBars(context.marketData);
  if (trades.some(trade => !['buy', 'sell'].includes(trade.side) || !trade.id || !trade.time || !sameSymbol(trade.symbol, context.marketData))) fail('成交标的或方向与行情不一致。');
  if (new Set(trades.map(trade => trade.id)).size !== trades.length) fail('成交编号重复。');
  trades.forEach(trade => time(trade.time));
  const ordered = [...trades].sort((a, b) => time(a.time) - time(b.time));
  const derivation = { symbol: context.marketData.symbol, from: ordered[0].time, to: ordered.at(-1).time, tradeIds: ordered.map(trade => trade.id) };
  return { bars, ordered, derivation };
}
const inferenceLimitations = ['候选方法来自可观察的成交与行情，原有理由和计划保持不变。', '方法相符度与盈利能力分别评估。', '当前支持单一人民币股票的现货多头规则；新闻驱动或主观判断需继续补充。'];

/** Ground a model-proposed rule in observed features, never model-supplied scores. */
export function evaluateCandidate({ rules, title, description = '', context = {} } = {}) {
  try {
    const { bars, ordered, derivation } = inferenceInputs(context);
    const method = validateMethod({ rules, title, description, origin: 'inferred', derivation });
    const analysis = methodAnalysis(method, ordered, bars);
    if (analysis.unassessableTradeIds.length === ordered.length) return unavailable('成交前的完整行情不足，暂时无法检验该候选规则。', { method: null });
    return { status: 'ok', method: { ...method, analysis }, limitations: [...inferenceLimitations, '规则由模型提出，关联结果由确定性计算得到；不能把较高相符度当作真实动机已获证实。'] };
  } catch (error) { return unavailable(error.message, { method: null }); }
}

export function inferMethods(context = {}) {
  let bars, ordered, derivation;
  try { ({ bars, ordered, derivation } = inferenceInputs(context)); }
  catch (error) { return unavailable(error.message, { methods: [] }); }
  // Fixed hypotheses; no price-outcome search or retrospective parameter tuning.
  const methods = ['trend', 'mean-reversion'].map(kind => {
    const method = validateMethod({ title: kind === 'trend' ? '跟随均线方向' : '偏离均线后回归', origin: 'inferred', derivation,
      rules: { kind, lookback: 5, entryDeviationPct: 0.5, exitDeviationPct: 0, allocationPct: 80 },
      description: kind === 'trend' ? '已完成的 K 线收盘价高于 5 根均价 0.5% 时提出买入信号，低于均价时提出卖出信号。'
        : '已完成的 K 线收盘价低于 5 根均价 0.5% 时提出买入信号，高于均价时提出卖出信号。' });
    return { ...method, analysis: methodAnalysis(method, ordered, bars) };
  });
  if (methods.every(method => method.analysis.unassessableTradeIds.length === ordered.length)) return unavailable('成交前的完整行情不足，暂时无法形成有证据支持的候选规则。', { methods: [] });
  return { status: 'ok', methods, limitations: [...inferenceLimitations] };
}

export function improveMethod(input, selectedChanges = ['position', 'stop-loss', 'max-hold']) {
  const original = validateMethod(input);
  if (!Array.isArray(selectedChanges) || !selectedChanges.length || selectedChanges.length > 3 || selectedChanges.some(id => !['position', 'stop-loss', 'max-hold'].includes(id))) fail('请选择支持的改进项。');
  const rules = { ...original.rules };
  const modifications = [];
  for (const id of [...new Set(selectedChanges)]) {
    const [field, value, title] = id === 'position' ? ['allocationPct', Math.min(rules.allocationPct, 50), '限制单次投入不超过 50%']
      : id === 'stop-loss' ? ['stopLossPct', rules.stopLossPct ?? 8, '补充 8% 收盘确认止损']
        : ['maxHoldBars', rules.maxHoldBars ?? 20, '补充 20 根 K 线持有期限'];
    if (rules[field] !== value) modifications.push({ id, field, title, from: rules[field], to: value });
    rules[field] = value;
  }
  const { analysis: _oldAnalysis, ...base } = original;
  return { ...validateMethod({ ...base, id: `${original.id}-v${original.version + 1}-${hash(JSON.stringify(rules))}`, version: original.version + 1, parentId: original.id,
    title: `${original.title.replace(/（风险约束版）$/, '')}（风险约束版）`, origin: 'improved', rules,
    description: modifications.length ? modifications.map(change => change.title).join('；') : '所选约束已存在，保留原规则。' }),
    changes: modifications.map(change => change.title), modifications,
    rationale: '这是一组可检验的风险约束候选。可能降低资金暴露，也可能减少收益、增加换手或错过后续上涨。',
    performanceClaim: null };
}

function assumptionsFor(options, bars) {
  if (!finite(options.initialCapital) || options.initialCapital <= 0) fail('请填写用于公平对比的起始资金，成交金额不能代替账户本金。');
  const initialCapital = num(options.initialCapital, 1, 1e12, '起始资金');
  const fromMs = options.from ? time(options.from) : bars[0].openAt;
  const toMs = options.to ? time(options.to, true) : bars.at(-1).markAt;
  if (fromMs > toMs) fail('回测起始日期不能晚于结束日期。');
  return { initialCapital, from: iso(fromMs), to: iso(toMs), feeBps: num(options.feeBps ?? 3, 0, 1000, '费用基点'),
    slippageBps: num(options.slippageBps ?? 5, 0, 1000, '滑点基点'), lotSize: num(options.lotSize ?? 100, 1, 100000, '买入单位', true),
    initialPosition: 0, cashFlows: 'none', execution: 'next-available-bar-open', sellRule: 'T+1',
    feeModel: '模拟成交金额按配置费率双向计费，未另加最低佣金和印花税；实际记录使用已记录费用。',
    valuation: '期末保留持仓并按最后收盘价估值，收益包含未实现盈亏；不强制平仓。',
    priceBasis: '不复权价格，不含分红和拆股调整。' };
}
function evaluation(method, data, assumptions) {
  if (!method.derivation?.to || !method.derivation?.symbol) return { kind: 'unverified', label: '未声明方法推导范围', independent: false };
  const same = sameSymbol(method.derivation.symbol, data);
  if (time(assumptions.from) > time(method.derivation.to, true)) return { kind: same ? 'out-of-time' : 'out-of-time-and-symbol', label: same ? '推导期之后' : '新标的与推导期之后', independent: true };
  if (!same) return { kind: 'cross-symbol', label: '跨标的同期验证', independent: false };
  return { kind: 'in-sample', label: '含方法推导区间', independent: false };
}
function sameSymbol(symbol, data) { return typeof symbol === 'string' && (symbol === data.symbol || symbol === data.tradeSymbol || symbol.toUpperCase().replace(/\.(SH|SZ|BJ)$/, '') === String(data.symbol).toUpperCase().replace(/\.(SH|SZ|BJ)$/, '')); }
function metricsFor(curve, executions, capital, closedTrades = []) {
  let peak = capital, maxDrawdownPct = 0;
  for (const point of curve) { peak = Math.max(peak, point.equity); maxDrawdownPct = Math.max(maxDrawdownPct, (peak - point.equity) / peak * 100); }
  const daily = new Map(); for (const point of curve) daily.set(dayOf(time(point.time)), point.equity);
  const returns = []; let previous = capital;
  for (const equity of daily.values()) { returns.push(equity / previous - 1); previous = equity; }
  let sharpe = null;
  if (returns.length >= 20) { const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length; const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (returns.length - 1); if (variance > 1e-16) sharpe = mean / Math.sqrt(variance) * Math.sqrt(252); }
  const finalEquity = curve.at(-1)?.equity ?? capital;
  return { netPnl: round(finalEquity - capital, 2), returnPct: round((finalEquity / capital - 1) * 100, 4), finalEquity: round(finalEquity, 2),
    maxDrawdownPct: round(maxDrawdownPct, 4), sharpe: sharpe === null ? null : round(sharpe, 4),
    fees: round(executions.reduce((sum, fill) => sum + fill.fee, 0), 2), slippageCost: round(executions.reduce((sum, fill) => sum + (fill.slippageCost ?? 0), 0), 2),
    tradeCount: executions.length, closedTradeCount: closedTrades.length,
    winRatePct: closedTrades.length ? round(closedTrades.filter(pnl => pnl > 0).length / closedTrades.length * 100, 2) : null };
}
function warningsFor(data) {
  return [data.provider === 'synthetic' ? '使用合成测试行情，结果仅用于验证流程。' : '结果仅覆盖已提供行情，未联网核验每个交易日是否完整。',
    '成交按下一可用开盘价和配置滑点估算；未模拟停牌、涨跌停无法成交、市场冲击和成交量限制。',
    '回撤采用持有期间各根完整 K 线收盘估值，盘中回撤可能更大。',
    '夏普率采用已提供交易日的日收益、252 日年化和零无风险收益，少于 20 个交易日或零波动时不显示。',
    '规则在完整 K 线可用后产生信号；止损也遵循这一口径，无法保证按阈值成交。'];
}

export function backtestMethod(options = {}) {
  let method, bars, assumptions;
  try { method = validateMethod(options.method); bars = marketBars(options.marketData); assumptions = assumptionsFor(options, bars); }
  catch (error) { return unavailable(error.message, { requiredInputs: !finite(options.initialCapital) ? ['initialCapital'] : [] }); }
  const from = time(assumptions.from), to = time(assumptions.to), active = bars.map((bar, index) => ({ bar, index })).filter(({ bar }) => bar.openAt >= from && bar.markAt <= to);
  if (!active.length) return unavailable('所选时间范围内没有完整行情。', { assumptions });
  if (!active.some(({ index }) => index >= method.rules.lookback)) return unavailable('完整历史 K 线不足，无法计算规则信号。', { assumptions });
  const executions = [], equityCurve = [], closedTrades = [];
  let cash = assumptions.initialCapital, quantity = 0, entryCost = 0, entryIndex = -1, entryDay = '', pending = null;
  for (const { bar, index } of active) {
    // A warm-up signal is usable only if its availability precedes this open.
    if (!pending && !quantity) {
      const priorIndex = bars.findLastIndex((prior, at) => at < index && prior.availableAt <= bar.openAt);
      const priorSignal = priorIndex >= 0 ? signalAt(bars, priorIndex, method.rules) : null;
      if (priorSignal?.buy && executionIndex(bars, priorIndex) === index) pending = { side: 'buy', decisionAt: bars[priorIndex].availableAt, executeAt: index, reason: 'entry' };
    }
    if (pending && pending.executeAt === index) {
      const buying = pending.side === 'buy', price = bar.open * (1 + (buying ? 1 : -1) * assumptions.slippageBps / 10000);
      let size = buying ? Math.floor(Math.min(cash, assumptions.initialCapital * method.rules.allocationPct / 100) / (price * (1 + assumptions.feeBps / 10000)) / assumptions.lotSize) * assumptions.lotSize : quantity;
      if (!buying && dayOf(bar.openAt) <= entryDay) size = 0;
      if (size > 0 && (buying ? !quantity : quantity > 0)) {
        const fee = size * price * assumptions.feeBps / 10000;
        const fill = { time: iso(bar.openAt), decisionAt: iso(pending.decisionAt), side: pending.side, quantity: size, price: round(price), fee: round(fee), slippageCost: round(size * Math.abs(price - bar.open)), reason: pending.reason };
        executions.push(fill);
        if (buying) { cash -= size * price + fee; quantity = size; entryCost = size * price + fee; entryIndex = index; entryDay = dayOf(bar.openAt); }
        else { cash += size * price - fee; closedTrades.push(size * price - fee - entryCost); quantity = 0; entryCost = 0; }
      }
      pending = null;
    }
    equityCurve.push({ time: iso(bar.markAt), equity: round(cash + quantity * bar.close), cash: round(cash), quantity, price: bar.close });
    const signal = signalAt(bars, index, method.rules), next = executionIndex(bars, index);
    if (!signal || next < 0) continue;
    let reason = null;
    if (quantity) {
      const returnPct = (quantity * bar.close / entryCost - 1) * 100;
      if (method.rules.stopLossPct !== null && returnPct <= -method.rules.stopLossPct) reason = 'stop-loss-close';
      else if (method.rules.takeProfitPct !== null && returnPct >= method.rules.takeProfitPct) reason = 'take-profit-close';
      else if (method.rules.maxHoldBars !== null && index - entryIndex + 1 >= method.rules.maxHoldBars) reason = 'max-hold';
      else if (signal.sell) reason = 'exit';
      if (reason) pending = { side: 'sell', executeAt: next, decisionAt: bar.availableAt, reason };
    } else if (signal.buy) pending = { side: 'buy', executeAt: next, decisionAt: bar.availableAt, reason: 'entry' };
  }
  return { status: 'ok', methodId: method.id, methodVersion: method.version, symbol: options.marketData.symbol,
    metrics: metricsFor(equityCurve, executions, assumptions.initialCapital, closedTrades), equityCurve, executions, assumptions,
    evaluation: evaluation(method, options.marketData, assumptions), warnings: warningsFor(options.marketData) };
}

function actualLedger({ trades, bars, data, assumptions }) {
  if (!Array.isArray(trades) || !trades.length) return unavailable('没有原始成交可供对比。');
  const from = time(assumptions.from), to = time(assumptions.to);
  const ordered = [...trades].filter(trade => time(trade.time) >= from && time(trade.time) <= to).sort((a, b) => time(a.time) - time(b.time));
  if (!ordered.length) return unavailable('所选范围内没有原始成交。');
  const active = bars.filter(bar => bar.openAt >= from && bar.markAt <= to);
  if (!active.length) return unavailable('原始持仓缺少估值行情。');
  for (const trade of ordered) {
    if (!sameSymbol(trade.symbol, data) || !['buy', 'sell'].includes(trade.side) || !finite(trade.price) || trade.price <= 0 || !finite(trade.quantity) || trade.quantity <= 0 || !finite(trade.fee) || trade.fee < 0) return unavailable('原始成交缺少有效价格、数量或费用。');
    const containing = active.find(bar => time(trade.time) >= bar.openAt && time(trade.time) <= bar.markAt);
    if (!containing) return unavailable('部分成交时点没有对应行情，无法公平估值。');
  }
  const executions = [], equityCurve = [], lots = [], closedTrades = [];
  let cash = assumptions.initialCapital, quantity = 0, cost = 0, cursor = 0;
  for (const bar of active) {
    while (cursor < ordered.length && time(ordered[cursor].time) <= bar.markAt) {
      const trade = ordered[cursor++], buying = trade.side === 'buy', amount = trade.quantity * trade.price;
      if (!buying && trade.quantity > quantity + 1e-8) return unavailable('记录涉及期初持仓或缺失买入，需补全持仓来源后再对比。');
      if (buying && amount + trade.fee > cash + 1e-6) return unavailable('起始资金无法覆盖原始成交，请确认本金或补充现金流。');
      if (buying) { cash -= amount + trade.fee; quantity += trade.quantity; cost += amount + trade.fee; lots.push({ day: dayOf(time(trade.time)), quantity: trade.quantity }); }
      else {
        let sellable = lots.filter(lot => lot.day < dayOf(time(trade.time))).reduce((sum, lot) => sum + lot.quantity, 0);
        if (sellable + 1e-8 < trade.quantity) return unavailable('原始记录包含与当前 T+1 口径不一致的卖出，需要核对市场与期初持仓。');
        const proportionCost = cost * trade.quantity / quantity;
        cash += amount - trade.fee; quantity -= trade.quantity; cost -= proportionCost; closedTrades.push(amount - trade.fee - proportionCost);
        let remaining = trade.quantity;
        for (const lot of lots) if (lot.day < dayOf(time(trade.time))) { const take = Math.min(remaining, lot.quantity); remaining -= take; lot.quantity -= take; }
      }
      executions.push({ ...trade, time: iso(time(trade.time)), slippageCost: 0 });
    }
    equityCurve.push({ time: iso(bar.markAt), equity: round(cash + quantity * bar.close), cash: round(cash), quantity, price: bar.close });
  }
  return { status: 'ok', metrics: { ...metricsFor(equityCurve, executions, assumptions.initialCapital, closedTrades), slippageCost: null }, executions, equityCurve,
    assumptions: { ...assumptions, execution: 'recorded-fills', feeModel: '使用原始记录已发生费用；成交价格已包含实际执行影响，无法单独分离滑点。' } };
}

export function compareMethod({ method, context = {}, ...options } = {}) {
  const input = { ...options, method, marketData: context.marketData };
  // Default comparison is the selected trading period, with prior market bars
  // retained only for signal warm-up. Both ledgers start flat at the same time.
  let times;
  try { times = (context.trades ?? []).map(trade => time(trade.time)).sort((a, b) => a - b); }
  catch (error) { return { status: 'unavailable', reason: error.message, baseline: null, alternative: null, delta: null }; }
  if (!input.from && times.length) input.from = dayOf(times[0]);
  if (!input.to && times.length) input.to = dayOf(times.at(-1));
  const alternative = backtestMethod(input);
  if (alternative.status !== 'ok') return { status: 'unavailable', reason: alternative.reason, baseline: null, alternative, delta: null, requiredInputs: alternative.requiredInputs ?? [] };
  let baseline;
  try { baseline = actualLedger({ trades: context.trades, bars: marketBars(context.marketData), data: context.marketData, assumptions: alternative.assumptions }); }
  catch (error) { baseline = unavailable(error.message); }
  if (baseline.status !== 'ok') return { status: 'unavailable', reason: baseline.reason, baseline, alternative, delta: null };
  const fields = ['netPnl', 'returnPct', 'maxDrawdownPct', 'sharpe', 'fees', 'tradeCount'];
  return { status: 'ok', baseline, alternative, delta: Object.fromEntries(fields.map(field => [field, alternative.metrics[field] === null || baseline.metrics[field] === null ? null : round(alternative.metrics[field] - baseline.metrics[field], 4)])),
    assumptions: alternative.assumptions, warnings: [...alternative.warnings, '本次为同一历史区间的规则反事实对比；收益差额不能直接归因于某一条改动，也不构成未来改善幅度。'] };
}

export function batchBacktest({ method, datasets, ...options } = {}) {
  if (!Array.isArray(datasets) || !datasets.length || datasets.length > 100) return unavailable('请选择 1 至 100 份已取得的行情数据。', { results: [] });
  const checked = validateMethod(method), seen = new Set();
  const results = datasets.map((dataset, index) => {
    const datasetId = text(dataset.id, `dataset-${index + 1}`, 160), symbol = dataset.marketData?.symbol ?? '';
    const duplicate = seen.has(datasetId); seen.add(datasetId);
    return { datasetId, symbol, ...(duplicate ? unavailable('重复的数据集编号。') : backtestMethod({ ...options, method: checked, marketData: dataset.marketData })) };
  });
  return { status: results.some(result => result.status === 'ok') ? 'ok' : 'unavailable', results,
    warnings: ['每个标的分别使用相同起始资金，结果不能直接相加作为组合收益。', '批量筛选后的高收益包含选择偏差；需在方法冻结后、未参与筛选的新区间继续验证。', '仅覆盖已提供数据；退市标的、缺失历史和复权问题可能影响结论。'] };
}
