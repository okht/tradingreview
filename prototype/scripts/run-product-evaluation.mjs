import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { resolve, dirname, relative, basename, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { validateContext, buildEvidence, timestampMillis } from '../server/contracts.js';
import { createReviewTools } from '../server/review-tools.js';
import { readTradeFile } from '../src/trade-file-reader.js';
import { getAvailableIntervals, selectChartData } from '../src/market-data.js';
import { createSseDecoder } from '../src/services/api.js';
import Papa from 'papaparse';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const sha = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const clone = value => structuredClone(value);
const iso = () => new Date().toISOString();
const pause = ms => new Promise(resolvePause => setTimeout(resolvePause, ms));
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const writeJson = async (path, value) => writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
const KEYS = /^(?:api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|authorization|password|secret|cookie|credential|credentials)$/i;
const ACCOUNT = /^(?:accountId|account|ownerId|owner_id|userId|user_id|email)$/i;

/** The runner never reads credentials. This is additional artifact hygiene. */
export function redact(value, key = '') {
  if (KEYS.test(key)) return '[REDACTED]';
  if (ACCOUNT.test(key) && value != null) return `anonymous-${sha(String(value)).slice(0, 12)}`;
  if (Array.isArray(value)) return value.map(item => redact(item));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redact(item, name)]));
  if (typeof value !== 'string') return value;
  return value.replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{10,}\b/g, '[REDACTED]')
    .replace(/([?&](?:api_key|apiKey|token|access_token|key|signature|secret)=)[^\s&#]+/gi, '$1[REDACTED]')
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[REDACTED_EMAIL]');
}

function parseArgs(argv) {
  const out = { mode: 'offline', manifest: resolve(ROOT, 'evaluation/fixtures/equity-50/manifest.json'), baseUrl: 'http://127.0.0.1:8788', offset: 0, limit: Infinity, timeoutMs: 120000, delayMs: 5100, questionIndex: 0, resume: false, retryFailed: false, baselineNoMarket: false, serverVersion: 'unknown' };
  const names = { mode: 'mode', manifest: 'manifest', 'base-url': 'baseUrl', model: 'model', limit: 'limit', offset: 'offset', output: 'output', 'timeout-ms': 'timeoutMs', 'delay-ms': 'delayMs', 'question-index': 'questionIndex', 'server-version': 'serverVersion' };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--help' || flag === '-h') { out.help = true; continue; }
    if (flag === '--resume') { out.resume = true; continue; }
    if (flag === '--retry-failed') { out.retryFailed = true; continue; }
    if (flag === '--baseline-no-market') { out.baselineNoMarket = true; continue; }
    if (!flag.startsWith('--') || !names[flag.slice(2)] || argv[i + 1] === undefined || argv[i + 1].startsWith('--')) throw new Error(`未知或缺值参数：${flag}`);
    out[names[flag.slice(2)]] = argv[++i];
  }
  if (!['offline', 'live'].includes(out.mode)) throw new Error('--mode 仅支持 offline 或 live');
  for (const key of ['offset', 'limit', 'timeoutMs', 'delayMs', 'questionIndex']) {
    if (out[key] === Infinity) continue;
    out[key] = Number(out[key]);
    if (!Number.isSafeInteger(out[key]) || out[key] < 0) throw new Error(`${key} 需要非负整数`);
  }
  if (out.timeoutMs < 1000 || out.timeoutMs > 300000) throw new Error('timeout-ms 需要在1000至300000之间');
  if (out.mode === 'live' && !out.help && (!out.model?.trim() || out.model.length > 150)) throw new Error('live 模式必须明确填写 --model，不猜测模型');
  const base = new URL(out.baseUrl);
  if (!['http:', 'https:'].includes(base.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) || base.username || base.password || base.search || base.hash || !['', '/'].includes(base.pathname)) throw new Error('base-url 只接受无凭证的本地服务根地址');
  out.baseUrl = base.origin;
  out.manifest = resolve(out.manifest);
  out.output = resolve(out.output || resolve(ROOT, `evaluation/results/${iso().replace(/[:.]/g, '-')}-${out.mode}`));
  return out;
}

function contained(base, input) {
  const path = resolve(base, input), rel = relative(base, path);
  if (!rel || rel.startsWith(`..${sep}`) || rel === '..' || /^[A-Za-z]:/.test(rel)) throw new Error(`资料路径超出manifest目录：${input}`);
  return path;
}

export async function loadCase(item, manifestDirectory, questionIndex = 0) {
  const casePath = item.casePath || item.caseFile || item.path || item.file;
  const data = casePath ? await json(contained(manifestDirectory, casePath)) : item;
  const bundlePath = item.bundlePath || item.bundleFile || item.files?.bundle || data.bundlePath;
  const bundle = bundlePath ? await json(contained(manifestDirectory, bundlePath)) : data.bundle || (data.format === 'huikan-review-bundle' ? data : null);
  if (!bundle) throw new Error('案例缺少 bundle 或 bundlePath');
  const contextPath = item.contextPath || item.files?.context || data.contextPath;
  const suppliedContext = contextPath ? await json(contained(manifestDirectory, contextPath)) : data.context || item.context;
  const context = suppliedContext || { trades: bundle.trades, contexts: data.contexts || bundle.contexts || {}, evidence: data.evidence || bundle.evidence || [], marketData: bundle.marketData, marketMode: 'import', origin: '构造评测成交' };
  const oraclePath = item.oraclePath || item.files?.oracle;
  const oracle = oraclePath ? await json(contained(manifestDirectory, oraclePath)) : data.oracle || {};
  const question = oracle.questions?.[questionIndex];
  if (oracle.questions?.length && !question) throw new Error(`question-index ${questionIndex} 超出该案例问题范围`);
  const prompt = question?.prompt || item.prompt || item.question || data.prompt || data.question || data.evaluation?.prompt;
  if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('案例缺少明确的 prompt/question');
  const expected = question || item.expected || data.expected || data.evaluation?.expected || {};
  const integrity = await Promise.all(Object.entries(item.files || {}).map(async ([key, path]) => ({ key, expected: item.sha256?.[key] || null, actual: sha(await readFile(contained(manifestDirectory, path))) })));
  let candles15m = [];
  if (item.files?.candles15m) {
    const parsed = Papa.parse(await readFile(contained(manifestDirectory, item.files.candles15m), 'utf8'), { header: true, skipEmptyLines: true });
    if (parsed.errors.length) throw new Error('15分钟参考CSV解析失败');
    candles15m = parsed.data;
  }
  return { id: item.id || data.id, item, bundle, context, prompt, expected, oracle, candles15m, integrity, questionId: question?.id || null, selectedTradeIds: question?.selectedTradeIds || null, messages: data.messages || [], inputHash: sha({ bundle, context, prompt, expected, oracle, candles15m }) };
}

function moneyCents(value) {
  if (!Number.isFinite(value)) throw new Error('金额未知，无法独立核算');
  const match = /^(\d+)(?:\.(\d+))?$/.exec(String(value));
  if (!match) throw new Error('独立核算只接受非负普通十进制金额');
  const decimal = (match[2] || '').padEnd(3, '0');
  return BigInt(match[1]) * 100n + BigInt(decimal.slice(0, 2)) + (Number(decimal[2]) >= 5 ? 1n : 0n);
}
function independentAccounting(trades, initialCapital) {
  let buy = 0n, sell = 0n, fees = 0n, cycleCash = 0n, cycleFees = 0n, cashDelta = 0n, maxCashRequired = 0n, position = 0, peakPosition = 0, tPlusOne = true;
  const lots = [], cycles = [], cashLedger = []; let cycleIds = [];
  for (const trade of [...trades].sort((a, b) => a.time.localeCompare(b.time))) {
    if (!Number.isSafeInteger(trade.quantity)) throw new Error('本评测独立账本要求整数股数');
    const amount = moneyCents(trade.price) * BigInt(trade.quantity), fee = moneyCents(trade.fee), day = trade.time.slice(0, 10);
    fees += fee; cycleFees += fee; cycleIds.push(trade.id);
    if (trade.side === 'buy') { buy += amount; cycleCash -= amount + fee; position += trade.quantity; lots.push({ day, quantity: trade.quantity }); }
    else {
      let left = trade.quantity; const available = lots.filter(lot => lot.day < day).reduce((sum, lot) => sum + lot.quantity, 0);
      if (available < left) tPlusOne = false;
      for (const lot of lots) { if (lot.day >= day) continue; const used = Math.min(left, lot.quantity); lot.quantity -= used; left -= used; }
      sell += amount; cycleCash += amount - fee; position -= trade.quantity;
    }
    if (position < 0) throw new Error('独立账本检测到超卖');
    peakPosition = Math.max(peakPosition, position);
    cashDelta += (trade.side === 'buy' ? -amount : amount) - fee;
    if (-cashDelta > maxCashRequired) maxCashRequired = -cashDelta;
    if (initialCapital !== undefined) cashLedger.push({ tradeId: trade.id, time: trade.time, positionAfter: position, cashAfter: Number(moneyCents(initialCapital) + cashDelta) / 100 });
    if (position === 0) { cycles.push({ tradeIds: cycleIds, netPnl: Number(cycleCash) / 100, fees: Number(cycleFees) / 100 }); cycleCash = 0n; cycleFees = 0n; cycleIds = []; }
  }
  return { buyAmount: Number(buy) / 100, sellAmount: Number(sell) / 100, fees: Number(fees) / 100, aggregateNetCashPnl: Number(sell - buy - fees) / 100, endingPosition: position, peakPosition, tPlusOne, cycles, maximumCashRequired: Number(maxCashRequired) / 100, cashLedger, endingCash: initialCapital === undefined ? null : Number(moneyCents(initialCapital) + cashDelta) / 100 };
}

function independentCandle(points, row) {
  const start = timestampMillis(row.startAt) / 1000, end = timestampMillis(row.endAt) / 1000;
  const isOpen = /T(?:09:30|13:00):00/.test(row.startAt);
  const included = points.filter(point => (isOpen ? point.time >= start : point.time > start) && point.time <= end);
  return included.length ? { open: included[0].price, high: Math.max(...included.map(point => point.price)), low: Math.min(...included.map(point => point.price)), close: included.at(-1).price, observations: included.length, lastObservedAt: included.at(-1).time } : null;
}

function checker() {
  const checks = [];
  return {
    checks,
    check(id, applicable, condition, detail = '') { checks.push({ id, status: applicable ? condition ? 'pass' : 'fail' : 'not_applicable', detail }); },
    error(id, error) { checks.push({ id, status: 'fail', detail: redact(error?.message || String(error)) }); },
  };
}

/** Real product paths only. No model/provider is instantiated in offline mode. */
export async function runOfflineCase(data) {
  const started = performance.now(), c = checker();
  const body = JSON.stringify(data.bundle);
  let extracted, context, evidence, tools;
  for (const item of data.integrity || []) c.check('fixture_file_integrity', Boolean(item.expected), item.actual === item.expected, item.key);
  try {
    extracted = await readTradeFile(new File([body], `${data.id || 'case'}.json`, { type: 'application/json' }));
    c.check('bundle_parser_preserves_trade_count', true, extracted.trades.length === data.bundle.trades.length, `${extracted.trades.length}/${data.bundle.trades.length}`);
    const fields = ['id', 'symbol', 'time', 'side', 'quantity', 'price', 'fee'];
    const matched = data.bundle.trades.every((trade, index) => fields.every(key => extracted.trades[index]?.[key] === trade[key]));
    c.check('bundle_parser_preserves_raw_fields', true, matched);
    c.check('bundle_parser_preserves_market', true, sha(extracted.marketData) === sha(data.bundle.marketData));
  } catch (error) { c.error('bundle_parser', error); }
  try { context = validateContext(data.context); c.check('context_contract', true, true); }
  catch (error) { c.error('context_contract', error); return { durationMs: Math.round(performance.now() - started), checks: c.checks, status: 'failed', error: { stage: 'context', message: redact(error.message) } }; }
  try {
    evidence = buildEvidence(context); tools = createReviewTools(context);
    const call = async (name, args) => {
      const tool = tools.find(value => value.name === name);
      if (!tool) throw new Error(`工具 ${name} 不可用`);
      return (await tool.execute(`offline-${name}`, args)).details;
    };
    c.check('evidence_ids_unique', true, new Set(evidence.map(item => item.id)).size === evidence.length);
    c.check('evidence_source_and_time_identity', true, evidence.every(item => item.source && ['before', 'after', 'unknown', 'recollection'].includes(item.timeClass)));
    const allTrades = await call('read_trades', {});
    c.check('read_trades_exact_fields', true, sha(allTrades.trades) === sha(context.trades));
    const summary = await call('get_summary', {}), missing = context.trades.some(trade => trade.price === null || trade.fee === null);
    c.check('unknown_money_not_zero', missing, summary.netPnl === null && summary.returnPct === null && summary.fees === null && summary.missing.length > 0);
    if (context.trades.length) {
      const incomplete = clone(context); incomplete.trades[0].fee = null;
      const check = (await createReviewTools(incomplete).find(item => item.name === 'get_summary').execute('offline-missing-fee', {})).details;
      c.check('missing_fee_mutation_preserves_unknown', true, check.fees === null && check.netPnl === null && check.returnPct === null && check.missing.some(item => item.tradeId === incomplete.trades[0].id && item.field === 'fee'));
    }
    if (data.oracle?.accounting && !missing) {
      const oracle = data.oracle.accounting, ledger = independentAccounting(context.trades, oracle.initialCapital);
      for (const key of ['buyAmount', 'sellAmount', 'fees', 'aggregateNetCashPnl', 'endingPosition', 'peakPosition']) c.check('independent_accounting_oracle', true, Math.abs(ledger[key] - oracle[key]) < 0.000001, key);
      c.check('independent_t_plus_one', true, ledger.tPlusOne);
      if (oracle.initialCapital !== undefined) {
        c.check('independent_cash_funding', true, Math.abs(ledger.maximumCashRequired - oracle.maximumCashRequired) < 0.000001 && Math.abs(ledger.endingCash - oracle.endingCash) < 0.000001 && ledger.cashLedger.every(item => item.cashAfter >= 0));
        c.check('independent_cash_ledger', true, sha(ledger.cashLedger) === sha(oracle.cashLedger));
      }
      c.check('independent_cycle_count', true, ledger.cycles.length === oracle.cycles.length);
      for (const [index, cycle] of ledger.cycles.entries()) {
        const expected = oracle.cycles[index], product = await call('get_summary', { tradeIds: cycle.tradeIds });
        c.check('independent_cycle_oracle', true, expected && sha(cycle.tradeIds) === sha(expected.tradeIds) && Math.abs(cycle.netPnl - expected.netPnl) < 0.000001 && Math.abs(cycle.fees - expected.fees) < 0.000001, `cycle-${index + 1}`);
        c.check('product_cycle_accounting', true, product.isComplete === true && Math.abs(product.netPnl - cycle.netPnl) < 0.000001 && Math.abs(product.fees - cycle.fees) < 0.000001, `cycle-${index + 1}`);
      }
      c.check('multiple_cycles_no_single_return', ledger.cycles.length > 1, summary.isComplete === true && Math.abs(summary.netPnl - ledger.aggregateNetCashPnl) < 0.000001 && summary.returnPct === null && oracle.overallReturnPct === null);
    }
    for (const [id, expected] of Object.entries(data.oracle?.temporalClasses || {})) c.check('oracle_temporal_class', true, evidence.find(item => item.id === id)?.timeClass === expected, id);
    const fullEvidence = await call('read_evidence', { includeAfter: true });
    c.check('explicit_after_retains_label', true, fullEvidence.evidence.every(item => evidence.some(original => original.id === item.id && original.timeClass === item.timeClass)));
    const dateOnly = evidence.filter(item => /^\d{4}-\d{2}-\d{2}$/.test(item.publishedAt || ''));
    c.check('date_only_stays_unknown', dateOnly.length > 0, dateOnly.every(item => item.timeClass === 'unknown' || item.timeClass === 'recollection'));
    const intervals = getAvailableIntervals({ trades: context.trades, marketData: context.marketData });
    c.check('fifteen_minute_available', Boolean(context.marketData), intervals.includes('15m'), intervals.join(','));
    if (context.marketData?.provider === 'synthetic' && data.candles15m?.length) {
      const product = selectChartData({ trades: context.trades, marketData: context.marketData, interval: '15m', mode: 'import', showFuture: true });
      c.check('full_fifteen_minute_count', true, product.candles.length === data.candles15m.length);
      for (const [index, row] of data.candles15m.entries()) {
        const independent = independentCandle(context.marketData.pricePoints, row), actual = product.candles[index];
        const fields = ['open', 'high', 'low', 'close'];
        c.check('independent_full_fifteen_minute_oracle', true, independent && fields.every(key => independent[key] === Number(row[key])) && independent.observations === Number(row.observations) && independent.lastObservedAt === timestampMillis(row.lastObservedAt) / 1000, row.startAt);
        c.check('product_full_fifteen_minute_oracle', true, actual && actual.startAt === row.startAt && actual.endAt === row.endAt && fields.every(key => actual[key] === Number(row[key])) && actual.lastObservedAt === row.lastObservedAt, row.startAt);
      }
    }
    for (const trade of context.trades) {
      const known = await call('read_evidence', { tradeIds: [trade.id], decisionAt: trade.time });
      c.check('default_evidence_hides_after', true, known.evidence.every(item => item.timeClass !== 'after'), trade.id);
      if (!context.marketData) continue;
      const market = await call('read_market', { tradeId: trade.id });
      c.check('market_default_hides_after', true, (market.after?.bars?.length || 0) === 0 && !market.after?.evidence, trade.id);
      c.check('market_completed_before_cutoff', true, (market.before?.bars || []).every(bar => timestampMillis(bar.endAt || bar.closedAt) <= timestampMillis(trade.time)), trade.id);
      if (context.marketData.provider !== 'synthetic' || !intervals.includes('15m')) continue;
      const options = { trades: context.trades, marketData: context.marketData, mode: 'import', interval: '15m', cutoff: trade.time, showFuture: false };
      const prefix = selectChartData(options), cutoff = timestampMillis(trade.time) / 1000;
      const future = { ...context.marketData, pricePoints: context.marketData.pricePoints.map(point => point.time > cutoff ? { ...point, price: point.price * 7 + 123 } : point) };
      c.check('fifteen_minute_future_invariance', true, sha(prefix) === sha(selectChartData({ ...options, marketData: future })), trade.id);
      c.check('fifteen_minute_observation_cutoff', true, prefix.candles.every(bar => timestampMillis(bar.lastObservedAt) <= timestampMillis(trade.time)), trade.id);
    }
    return { durationMs: Math.round(performance.now() - started), status: c.checks.some(item => item.status === 'fail') ? 'failed' : 'completed', checks: c.checks, observation: { parsedTrades: extracted?.trades.length ?? null, trades: context.trades.length, evidence: evidence.length, intervals, summary: redact(summary), modelInvoked: false } };
  } catch (error) { c.error('read_only_tool_contract', error); return { durationMs: Math.round(performance.now() - started), status: 'failed', checks: c.checks, error: { stage: 'tools', message: redact(error.message) } }; }
}

export async function runLiveCase(data, options) {
  const started = performance.now(), events = [], toolTrace = [];
  const context = clone(data.context);
  if (data.selectedTradeIds?.length) {
    const ids = new Set(data.selectedTradeIds);
    context.trades = context.trades.filter(item => ids.has(item.id));
    context.contexts = Object.fromEntries(Object.entries(context.contexts || {}).filter(([id]) => ids.has(id)));
    context.evidence = (context.evidence || []).filter(item => ids.has(item.tradeId));
  }
  if (options.baselineNoMarket) delete context.marketData;
  const text = options.baselineNoMarket ? `${data.prompt}\n\n评测输入边界：本次未提供行情，无法核对15分钟K线。标的身份真实，所有成交、背景和事件为构造评测材料，不能当作真实历史。请依据现有材料回答，并保留行情缺失限制。` : data.prompt;
  const input = { task: 'review', config: { provider: 'openai', auth: 'oauth', model: options.model.trim() }, context, messages: data.messages, text, financialConfig: {} };
  let result = null, streamError = null, httpStatus = null, bytes = 0;
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await fetch(`${options.baseUrl}/api/agent/stream`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' }, body: JSON.stringify(input), signal: controller.signal });
    httpStatus = response.status;
    if (!response.ok) {
      let payload = null; try { payload = await response.json(); } catch { /* HTTP fallback only. */ }
      throw new Error(payload?.message || payload?.error?.message || `HTTP ${response.status}`);
    }
    if (!response.body) throw new Error('响应缺少SSE流');
    const decoder = createSseDecoder(event => {
      if (event.type === 'heartbeat') return;
      const saved = { elapsedMs: Math.round(performance.now() - started), ...redact(event) };
      events.push(saved);
      if (event.type === 'tool') toolTrace.push(saved);
      if (event.type === 'result') {
        if (result !== null) throw new Error('收到多个result事件');
        result = event.result;
      }
      if (event.type === 'error') streamError = { code: event.code || 'STREAM_ERROR', message: redact(event.message || '服务返回错误') };
    });
    const reader = response.body.getReader(), text = new TextDecoder();
    try {
      while (true) {
        const chunk = await reader.read(); if (chunk.done) break;
        bytes += chunk.value.byteLength; if (bytes > 8 * 1024 * 1024) throw new Error('SSE超过8MB评测记录上限');
        decoder.push(text.decode(chunk.value, { stream: true }));
      }
      decoder.push(text.decode()); decoder.finish();
    } catch (error) { try { await reader.cancel(); } catch {} throw error; }
    finally { reader.releaseLock(); }
    if (streamError) throw new Error(streamError.message);
    if (!result || typeof result !== 'object' || !result.text) throw new Error('流结束但没有完整result');
    const returnedIds = new Set((result.evidence || []).map(item => item.id));
    const references = [...(result.evidenceIds || []), ...(result.facts || []).flatMap(item => item.evidenceIds || []), ...(result.interpretations || []).flatMap(item => item.evidenceIds || [])];
    return { status: 'completed', durationMs: Math.round(performance.now() - started), httpStatus, attempted: true, input: redact(input), output: redact(result), events, toolTrace,
      repairObserved: events.some(event => event.type === 'status' && /重新核对输出格式与引用/.test(event.text || '')),
      automatedObservations: { referenceIdOpportunities: references.length, referencesPresent: references.filter(id => returnedIds.has(id)).length, referencesMissing: [...new Set(references.filter(id => !returnedIds.has(id)))], note: '仅检查引用ID是否在返回证据中，未自动判断语义正确、真实来源或时点归因。' } };
  } catch (error) {
    return { status: 'failed', durationMs: Math.round(performance.now() - started), httpStatus, attempted: true, input: redact(input), output: result ? redact(result) : null, events, toolTrace,
      repairObserved: events.some(event => event.type === 'status' && /重新核对输出格式与引用/.test(event.text || '')),
      error: { stage: httpStatus && httpStatus !== 200 ? 'http' : controller.signal.aborted ? 'timeout' : 'stream', message: redact(error.message), ...(streamError ? { stream: streamError } : {}) } };
  } finally { clearTimeout(timeout); }
}

function percentile(values, fraction) { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] : null; }
function ratio(numerator, denominator) { return { numerator, denominator, rate: denominator ? numerator / denominator : null }; }
function reviewEntry(record, rubric) {
  return { caseId: record.id, attempt: record.attempts.length, inputHash: record.inputHash || null, resultHash: record.attempts.at(-1)?.output ? sha(record.attempts.at(-1).output) : null, reviewer: '', reviewedAt: '', evidenceNotes: '',
    hardGates: Object.fromEntries(rubric.hardGates.map(gate => [gate.id, { status: 'pending', reason: '', evidence: '' }])),
    quality: Object.fromEntries(rubric.qualityDimensions.map(dimension => [dimension.id, { score: null, reason: '', evidence: '' }])),
    overall: 'pending', badcases: [] };
}

export function summarize(records, selectedCount, mode, rubric, reviews = []) {
  const latest = records.map(record => ({ ...record.attempts.at(-1), id: record.id }));
  const completed = latest.filter(item => item.status === 'completed'), allAttempts = records.flatMap(record => record.attempts), attempted = allAttempts.filter(item => item.attempted);
  const checks = {};
  for (const item of latest) for (const check of item.checks || []) {
    const count = checks[check.id] ||= { applicable: 0, passed: 0, failed: 0, notApplicable: 0 };
    if (check.status === 'not_applicable') count.notApplicable++;
    else { count.applicable++; count[check.status === 'pass' ? 'passed' : 'failed']++; }
  }
  const successfulIds = new Set(completed.map(item => item.id));
  const recordById = new Map(records.map(record => [record.id, record]));
  const verifiedReviews = mode === 'live' ? reviews.filter(review => {
    const record = recordById.get(review.caseId), current = record?.attempts.at(-1);
    return successfulIds.has(review.caseId) && review.attempt === record.attempts.length && review.resultHash === (current.output ? sha(current.output) : null) && review.reviewer?.trim() && review.reviewedAt && review.evidenceNotes?.trim();
  }) : [];
  const hardGates = Object.fromEntries(rubric.hardGates.map(gate => {
    const values = verifiedReviews.map(review => review.hardGates?.[gate.id]).filter(value => value && value.reason?.trim() && ['pass', 'fail', 'not_applicable'].includes(value.status));
    const judged = values.filter(value => value.status !== 'not_applicable'), failures = judged.filter(value => value.status === 'fail').length;
    return [gate.id, { targetViolations: 0, ...ratio(failures, judged.length), passed: judged.length - failures, notApplicable: values.length - judged.length, awaitingReview: completed.length - values.length, withoutValidOutput: selectedCount - completed.length, plannedCases: selectedCount }];
  }));
  const quality = Object.fromEntries(rubric.qualityDimensions.map(dimension => {
    const scores = verifiedReviews.map(review => review.quality?.[dimension.id]).filter(value => value && Number.isInteger(value.score) && value.score >= 1 && value.score <= 5 && value.reason?.trim() && value.evidence?.trim()).map(value => value.score);
    return [dimension.id, { group: dimension.group, targetMinimum: 4, reviewed: scores.length, plannedCases: selectedCount, mean: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null, oneScoreCount: scores.filter(value => value === 1).length }];
  }));
  return { mode, plannedCases: selectedCount, recordedCases: records.length, unrecordedCases: selectedCount - records.length,
    completedCases: completed.length, failedCases: latest.filter(item => item.status === 'failed').length, blockedCases: latest.filter(item => item.status === 'blocked').length,
    completionRate: ratio(completed.length, selectedCount), executionAttempts: allAttempts.length, modelCalls: attempted.length, failedModelAttempts: attempted.filter(item => item.status === 'failed').length, repairRate: ratio(attempted.filter(item => item.repairObserved).length, attempted.length),
    latency: { completed: { count: completed.length, p50Ms: percentile(completed.map(item => item.durationMs), .5), p95Ms: percentile(completed.map(item => item.durationMs), .95) }, failures: { count: latest.filter(item => item.status === 'failed').length, p95Ms: percentile(latest.filter(item => item.status === 'failed').map(item => item.durationMs), .95) } },
    offlineChecks: checks, hardGates, quality, acceptance: mode === 'offline' ? 'offline_contract_results_only' : 'requires_human_review',
    caveat: mode === 'offline' ? '没有调用模型；这些结果不能证明AI任务质量或语义合规。' : '模型成功返回与自动引用存在性检查不能替代语义审阅；阈值是目标，未审阅项保持待验收。' };
}

function markdownReport(run, summary, records) {
  const rows = records.map(record => { const last = record.attempts.at(-1); return `| ${record.id} | ${last.status} | ${last.durationMs ?? 0} | ${last.repairObserved ? '观察到' : last.attempted ? '未观察到' : '未调用模型'} | ${last.error?.message?.replace(/[|\r\n]/g, ' ') || '待人工语义审阅'} |`; });
  return `# 产品评测运行记录\n\n- 模式：${run.mode}\n- 开始：${run.startedAt}\n- 模型：${run.model || '未调用'}\n- 数据集散列：${run.manifestHash}\n- 本地代码指纹：${run.codeFingerprint}\n- 服务版本（运行者声明）：${run.serverVersion}\n- 省略行情基线模式：${run.baselineNoMarket ? '是；本次不能评判15分钟行情能力' : '否'}\n- 计划案例：${summary.plannedCases}；完成：${summary.completedCases}；失败：${summary.failedCases}；权限/环境阻塞：${summary.blockedCases}。\n- 完成率：${summary.completionRate.numerator}/${summary.completionRate.denominator}，分母保留全部计划案例。\n- 有效结果耗时：p50 ${summary.latency.completed.p50Ms ?? '—'} ms；p95 ${summary.latency.completed.p95Ms ?? '—'} ms；样本 ${summary.latency.completed.count}。\n\n${summary.caveat}\n\n四个硬门槛目标均为零违规。每项的适用、人工已审、待审、无输出分母详见 summary.json。AI质量评分为空时不会自动补分。请填写 manual-review.json 中的审阅者、时间、依据及评分；resume会重新汇总。\n\n| 案例 | 执行状态 | 耗时ms | 格式修复 | 备注 |\n|---|---|---:|---|---|\n${rows.join('\n')}\n\n轨迹仅为产品SSE暴露的工具名称及运行/完成/失败状态；不包含未暴露的模型思考、工具参数或工具完整返回。live请求仅使用已连接OAuth及fixture材料，financialConfig为空对象，未请求真实金融账户。若服务将外部连接显示为不可用，需按运行环境限制记录。服务会记录独立分析运行快照，runner不写工作区。本地源码指纹不自动证明运行中的服务已加载同一版本。\n`;
}

async function sourceFingerprint() {
  const paths = ['scripts/run-product-evaluation.mjs', 'evaluation/rubric.json', 'server/contracts.js', 'server/review-tools.js', 'server/agent-runner.js', 'src/trade-file-reader.js', 'src/synthetic-market.js', 'src/market-data.js'];
  return sha(await Promise.all(paths.map(async path => [path, sha(await readFile(resolve(ROOT, path)))])));
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) { console.log('node scripts/run-product-evaluation.mjs --mode offline|live [--manifest evaluation/fixtures/equity-50/manifest.json] [--base-url http://127.0.0.1:8788] [--model MODEL_ID] [--limit N] [--offset N] [--question-index 0] [--output DIR] [--resume] [--retry-failed] [--baseline-no-market] [--server-version COMMIT] [--timeout-ms 120000] [--delay-ms 5100]\nlive只使用已连接的本地ChatGPT OAuth；不会读取API Key或主动发起登录。baseline-no-market只供旧服务基线，明确省略行情。'); return; }
  const manifestText = await readFile(options.manifest, 'utf8'), manifest = JSON.parse(manifestText), rubric = await json(resolve(ROOT, 'evaluation/rubric.json'));
  const cases = Array.isArray(manifest) ? manifest : [manifest.cases, manifest.datasets, manifest.groups].find(Array.isArray);
  if (!Array.isArray(cases) || !cases.length) throw new Error('manifest缺少非空cases数组');
  if (cases.some(item => !item.id) || new Set(cases.map(item => item.id)).size !== cases.length) throw new Error('manifest的每个案例必须具有唯一id');
  const selected = cases.slice(options.offset, options.limit === Infinity ? undefined : options.offset + options.limit);
  if (!selected.length) throw new Error('当前limit/offset未选择任何案例');
  await mkdir(options.output, { recursive: true });
  const runPath = resolve(options.output, 'run.json'), fingerprint = await sourceFingerprint();
  let previous = null; try { previous = await json(runPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (previous && !options.resume) throw new Error('输出目录已有运行记录；请使用新目录，或显式--resume');
  const identity = { mode: options.mode, model: options.mode === 'live' ? options.model.trim() : null, baseUrl: options.mode === 'live' ? options.baseUrl : null, manifestHash: sha(manifestText), codeFingerprint: fingerprint, serverVersion: options.serverVersion, baselineNoMarket: options.baselineNoMarket, questionIndex: options.questionIndex, selectedIds: selected.map(item => item.id) };
  if (previous && Object.entries(identity).some(([key, value]) => JSON.stringify(previous[key]) !== JSON.stringify(value))) throw new Error('resume的模式、模型、数据集、代码或选择范围发生变化；请使用新的输出目录，避免混合结果');
  const run = { ...identity, version: 1, startedAt: previous?.startedAt || iso(), updatedAt: iso(), sourceManifest: relative(ROOT, options.manifest), selectedCount: selected.length, provider: options.mode === 'live' ? 'openai' : null, authentication: options.mode === 'live' ? 'oauth-existing-session' : null, credentialsRead: false, financialNetworkEnabled: false, thresholdsAreTargets: true };
  await writeJson(runPath, run);
  await mkdir(resolve(options.output, 'cases'), { recursive: true });
  const records = [];
  for (const filename of await readdir(resolve(options.output, 'cases'))) if (filename.endsWith('.json')) records.push(await json(resolve(options.output, 'cases', filename)));
  const recordMap = new Map(records.map(record => [record.id, record]));
  let reviews = []; try { reviews = (await json(resolve(options.output, 'manual-review.json'))).cases || []; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const updateReports = async () => {
    const ordered = selected.map(item => recordMap.get(item.id)).filter(Boolean);
    for (const record of ordered) if (!reviews.some(review => review.caseId === record.id && review.attempt === record.attempts.length)) reviews.push(reviewEntry(record, rubric));
    const summary = summarize(ordered, selected.length, options.mode, rubric, reviews);
    await writeJson(resolve(options.output, 'manual-review.json'), { version: rubric.version, instructions: '由人工填写。pending/null不得改成自动通过；每项必须附原因和原文/字段依据。离线结果不评分AI质量。', cases: reviews });
    await writeJson(resolve(options.output, 'summary.json'), summary);
    await writeFile(resolve(options.output, 'REPORT.md'), markdownReport(run, summary, ordered));
    return summary;
  };
  let preflightError = null;
  if (options.mode === 'live') {
    try {
      const response = await fetch(`${options.baseUrl}/api/oauth/status`, { signal: AbortSignal.timeout(10000) });
      const state = await response.json();
      if (!response.ok || state.status !== 'connected') throw new Error('本地ChatGPT OAuth尚未连接；请在产品设置完成连接后重试。');
    } catch (error) { preflightError = redact(error.message); }
  }
  let previousStarted = 0;
  for (let index = 0; index < selected.length; index++) {
    const item = selected[index], old = recordMap.get(item.id), last = old?.attempts.at(-1);
    if (old && !(options.retryFailed && ['failed', 'blocked'].includes(last?.status))) continue;
    const record = old || { id: item.id, scenario: item.scenario || item.category || null, tags: item.tags || [], attempts: [] };
    let attempt;
    try {
      const data = await loadCase(item, dirname(options.manifest), options.questionIndex);
      if (record.inputHash && record.inputHash !== data.inputHash) throw new Error('案例输入内容变化，不能合并到相同运行');
      record.inputHash = data.inputHash; record.expected = redact(data.expected); record.prompt = redact(data.prompt); record.questionId = data.questionId;
      record.limitations = options.baselineNoMarket ? ['旧服务基线显式省略marketData，本次不能评价15分钟行情处理。', 'financialConfig为空对象，外部取证未启用；若服务将其显示为不可用，按环境限制记录。'] : ['financialConfig为空对象，仅使用评测集材料。'];
      if (preflightError) attempt = { status: 'blocked', attempted: false, durationMs: 0, error: { stage: 'oauth_preflight', message: preflightError } };
      else if (options.mode === 'offline') attempt = await runOfflineCase(data);
      else {
        // Validate the real context locally before a billed provider request.
        validateContext(data.context);
        if (previousStarted) await pause(Math.max(0, options.delayMs - (performance.now() - previousStarted)));
        previousStarted = performance.now();
        attempt = await runLiveCase(data, options);
      }
      attempt.input = attempt.input || redact({ context: data.context, bundleFormat: data.bundle.format, bundleVersion: data.bundle.version, text: data.prompt });
    } catch (error) { attempt = { status: 'failed', attempted: false, durationMs: 0, error: { stage: 'case_input', message: redact(error.message) } }; }
    record.attempts.push({ attempt: record.attempts.length + 1, recordedAt: iso(), ...attempt });
    recordMap.set(item.id, record);
    const filename = `${String(options.offset + index + 1).padStart(3, '0')}-${String(item.id).replace(/[^a-zA-Z0-9_-]/g, '_')}.json`;
    await writeJson(resolve(options.output, 'cases', filename), record);
    await updateReports();
    console.log(`${index + 1}/${selected.length} ${item.id}: ${attempt.status} (${attempt.durationMs}ms)`);
  }
  const summary = await updateReports();
  await writeJson(runPath, { ...run, updatedAt: iso(), finishedAt: iso() });
  console.log(JSON.stringify({ mode: options.mode, output: options.output, planned: summary.plannedCases, completed: summary.completedCases, failed: summary.failedCases, blocked: summary.blockedCases, modelCalls: summary.modelCalls, semanticReview: 'pending-until-human-scored' }));
  if (summary.failedCases || summary.blockedCases || summary.unrecordedCases) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(redact(error.message)); process.exitCode = 1; });
