import { timestampMillis, validateContext } from './contracts.js';
import { readonlyFinancialToolSchema, MAX_FINANCIAL_TOOLS } from './financial-tool-policy.js';
import { canUseFuyaoNewsRest, verifyFuyaoNewsRest } from './fuyao-news-rest.js';

// Verified 2026-10-21 against the provider's published field contract:
// https://fuyao.aicubes.cn/docs/api-reference/prices/
// https://fuyao.aicubes.cn/docs/mcp/overview/
// HTTP MCP transport: https://modelcontextprotocol.io/specification/2025-06-18/basic/transports
const FUYAO_HISTORY = 'https://fuyao.aicubes.cn/api/a-share/prices/historical';
const MAX_RESPONSE = 2 * 1024 * 1024;
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function text(value, label, limit = 4096) {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) fail(`${label}格式无效。`);
  return value.trim();
}
function day(value, label) {
  const valueText = text(value, label, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(valueText)) fail(`${label}需要 YYYY-MM-DD。`);
  timestampMillis(`${valueText}T00:00`);
  return valueText;
}
function sourceTime(value) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 8640000000000000) fail('行情时间字段无效。', 502);
  return value;
}
function positive(value, label, allowZero = false) {
  if (typeof value !== 'number' || !Number.isFinite(value) || (allowZero ? value < 0 : value <= 0)) fail(`行情 ${label} 字段无效。`, 502);
  return value;
}
function chinaDay(ms) { return new Date(ms + 8 * 3600000).toISOString().slice(0, 10); }
function nextDay(date) { return new Date(Date.parse(`${date}T00:00:00Z`) + 86400000).toISOString().slice(0, 10); }

export function validateFinancialEndpoint(input, provider) {
  let endpoint;
  try { endpoint = new URL(text(input, 'HTTP MCP 地址', 4096)); } catch { fail('请粘贴官方生成的 HTTP MCP 地址。'); }
  const host = endpoint.hostname;
  const permitted = provider === 'fuyao' ? host === 'fuyao.aicubes.cn'
    : provider === 'ifind' && (host === '51ifind.com' || host.endsWith('.51ifind.com'));
  if (!permitted || endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.hash || (endpoint.port && endpoint.port !== '443')) fail('仅支持扶摇或 51ifind 官方域名的 HTTPS MCP 地址，不支持代理或跳转。');
  return endpoint;
}

async function fetchChecked(endpoint, options, fetchImpl) {
  let response;
  try { response = await fetchImpl(endpoint, { ...options, redirect: 'error' }); }
  catch (error) { if (options.signal?.aborted) throw options.signal.reason ?? error; fail('数据源连接失败，请检查配置或稍后重试。', 502); }
  if (!response.ok) {
    try { await response.body?.cancel(); } catch { /* Ignore cleanup. */ }
    throw Object.assign(new Error(response.status === 429 ? '数据源调用已限流，请稍后重试。' : `数据源返回 HTTP ${response.status}，请核对权限和连接配置。`), { status: response.status === 429 ? 429 : 502, upstreamStatus: response.status });
  }
  return response;
}
async function boundedText(response) {
  if (!response.body) fail('数据源没有返回内容。', 502);
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let size = 0, output = '';
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_RESPONSE) { await reader.cancel(); fail('数据源响应超过读取范围，请缩小日期范围。', 502); }
      output += decoder.decode(part.value, { stream: true });
    }
    return output + decoder.decode();
  } finally { reader.releaseLock(); }
}
function parseJson(raw) { try { return JSON.parse(raw); } catch { fail('数据源返回了无法读取的 JSON。', 502); } }

/** Date bars become available conservatively on the next China-local date.
 * This availability policy is ours; date_ms does not encode the provider's
 * intraday finalization instant. We do not claim current-day candles are final.
 */
export function normalizeFuyaoBars(payload, { from, to }) {
  if (!object(payload) || payload.code !== 0) {
    const code = Number.isInteger(payload?.code) ? `（业务 code ${payload.code}）` : '';
    fail(`扶摇未返回成功结果${code}，请核对 API Key、权限与参数。`, 502);
  }
  if (!object(payload.data) || !Array.isArray(payload.data.item) || payload.data.item.length > 4000) fail('扶摇历史 K 线结构与公开契约不一致。', 502);
  if (!payload.data.item.length) return { bars: [], dataTimestamp: payload.data.timestamp == null ? null : sourceTime(payload.data.timestamp) };
  const dataTimestamp = sourceTime(payload.data.timestamp);
  const seen = new Set();
  const bars = payload.data.item.map(item => {
    if (!object(item)) fail('行情记录无效。', 502);
    const time = chinaDay(sourceTime(item.date_ms));
    const bar = { time, open: positive(item.open_price, 'open'), high: positive(item.high_price, 'high'), low: positive(item.low_price, 'low'), close: positive(item.close_price, 'close'), closedAt: `${nextDay(time)}T00:00:00+08:00` };
    if (bar.high < Math.max(bar.open, bar.close, bar.low) || bar.low > Math.min(bar.open, bar.close, bar.high) || seen.has(time)) fail('行情包含重复日期或不自洽的 OHLC，未保存。', 502);
    seen.add(time);
    if (item.volume != null) bar.volume = positive(item.volume, 'volume', true);
    if (item.turnover != null) bar.turnover = positive(item.turnover, 'turnover', true);
    return bar;
  }).filter(bar => bar.time >= from && bar.time <= to).sort((a, b) => a.time.localeCompare(b.time));
  return { bars, dataTimestamp };
}

export function filterFinancialBars(bars, decisionAt) {
  const cutoff = timestampMillis(decisionAt);
  return bars.filter(bar => timestampMillis(bar.closedAt) <= cutoff).map(bar => ({ ...bar }));
}

async function historical(body, { signal, fetchImpl, now }) {
  const symbol = text(body.symbol, '标的代码', 20).toUpperCase();
  if (!/^\d{6}\.(SH|SZ|BJ)$/.test(symbol)) fail('请填写带交易所后缀的 A 股代码，例如 600519.SH；不会推断交易所。');
  const from = day(body.from, '开始日期'), to = day(body.to, '结束日期');
  const start = timestampMillis(`${from}T00:00`), end = timestampMillis(`${to}T23:59:59`);
  if (from > to || end - start > 10 * 366 * 86400000) fail('日期范围须按先后排列且不超过十年。');
  const apiKey = text(body.apiKey, '扶摇 API Key');
  if (/[\r\n]/.test(apiKey)) fail('API Key 格式无效。');
  // Only this verified read endpoint is used. Client input cannot change it.
  if (body.endpoint && body.endpoint !== FUYAO_HISTORY) fail('历史行情使用已核实的扶摇官方固定端点。');
  const endpoint = new URL(FUYAO_HISTORY);
  for (const [key, value] of Object.entries({ thscode: symbol, interval: '1d', start, end, adjust: 'none' })) endpoint.searchParams.set(key, String(value));
  const response = await fetchChecked(endpoint, { headers: { 'X-api-key': apiKey, Accept: 'application/json' }, signal }, fetchImpl);
  const normalized = normalizeFuyaoBars(parseJson(await boundedText(response)), { from, to });
  const observedAt = now().toISOString();
  // Full responses may still contain the current partial day. Always remove it.
  const availableAt = observedAt.replace(/\.\d{3}Z$/, 'Z');
  const bars = filterFinancialBars(normalized.bars, body.decisionAt ?? availableAt)
    .filter(bar => timestampMillis(bar.closedAt) <= timestampMillis(availableAt));
  return { provider: 'fuyao', status: bars.length ? 'ok' : 'empty', source: '同花顺扶摇 A 股历史 K 线', symbol, from, to, interval: '1D', adjust: 'none', currency: 'CNY', timeZone: 'Asia/Shanghai', availabilityPolicy: 'next-day', bars, dataTimestamp: normalized.dataTimestamp, observedAt };
}

async function rpcResponse(response, id) {
  if (!response.headers.get('content-type')?.includes('text/event-stream')) {
    const payload = parseJson(await boundedText(response));
    if (payload?.jsonrpc !== '2.0' || payload.id !== id || payload.error || !object(payload.result)) fail('MCP 请求未成功，请核对官方配置与服务权限。', 502);
    return payload.result;
  }
  const reader = response.body?.getReader();
  if (!reader) fail('MCP 没有返回响应流。', 502);
  const decoder = new TextDecoder(); let size = 0, buffer = '';
  const parseBlock = block => {
    const data = block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data) return null;
    const payload = parseJson(data);
    if (payload?.id !== id) return null;
    if (payload.jsonrpc !== '2.0' || payload.error || !object(payload.result)) fail('MCP 请求未成功，请核对官方配置与服务权限。', 502);
    return payload.result;
  };
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) { buffer += decoder.decode(); const result = parseBlock(buffer); if (result) return result; fail('MCP 响应在结果返回前结束。', 502); }
      size += chunk.value.byteLength;
      if (size > MAX_RESPONSE) fail('MCP 工具目录超过读取范围。', 502);
      buffer += decoder.decode(chunk.value, { stream: true });
      let match;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        const block = buffer.slice(0, match.index); buffer = buffer.slice(match.index + match[0].length);
        const result = parseBlock(block); if (result) return result;
      }
    }
  } finally { try { await reader.cancel(); } catch {} reader.releaseLock(); }
}

async function discoverTools(body, { signal, fetchImpl, now }) {
  const endpoint = validateFinancialEndpoint(body.endpoint, body.provider);
  const headerName = body.authHeader ?? (body.provider === 'fuyao' ? 'X-api-key' : null);
  if (body.apiKey && !['X-api-key', 'Authorization'].includes(headerName)) fail('请按官方配置选择鉴权请求头。');
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  if (body.apiKey) { const key = text(body.apiKey, '鉴权值'); if (/[\r\n]/.test(key)) fail('鉴权值格式无效。'); headers[headerName] = key; }
  let session;
  const send = async (method, params, id) => {
    const response = await fetchChecked(endpoint, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, ...(params === undefined ? {} : { params }) }), signal }, fetchImpl);
    if (id === undefined) { try { await response.body?.cancel(); } catch {} return null; }
    if (method === 'initialize') {
      session = response.headers.get('mcp-session-id');
      if (session) { if (!/^[\x21-\x7e]{1,512}$/.test(session)) fail('MCP 会话标识无效。', 502); headers['Mcp-Session-Id'] = session; }
    }
    return rpcResponse(response, id);
  };
  try {
    const init = await send('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'huikan-readonly', version: '0.1.0' } }, 1);
    if (!['2025-03-26', '2025-06-18'].includes(init.protocolVersion)) fail('当前仅支持 Streamable HTTP MCP，请使用官方 HTTP 配置。', 422);
    headers['MCP-Protocol-Version'] = init.protocolVersion;
    await send('notifications/initialized');
    const tools = []; const cursors = new Set(); let cursor;
    for (let page = 0; page < 5; page++) {
      const result = await send('tools/list', cursor ? { cursor } : {}, page + 2);
      if (!Array.isArray(result.tools) || result.tools.length > 500) fail('MCP 工具列表格式无效。', 502);
      for (const item of result.tools) {
        if (!object(item) || typeof item.name !== 'string' || !item.name || item.name.length > 200 || !object(item.inputSchema) || (item.description !== undefined && typeof item.description !== 'string')) fail('MCP 工具定义格式无效。', 502);
        const annotations = Object.fromEntries(['readOnlyHint', 'destructiveHint'].filter(key => typeof item.annotations?.[key] === 'boolean').map(key => [key, item.annotations[key]]));
        tools.push({ name: item.name, description: (item.description ?? '').slice(0, 4000), inputSchema: item.inputSchema, annotations });
      }
      if (!result.nextCursor) break;
      if (page === 4 || typeof result.nextCursor !== 'string' || cursors.has(result.nextCursor)) fail('MCP 工具列表分页未完成，请缩小所选服务范围。', 502);
      cursor = result.nextCursor; cursors.add(cursor);
    }
    if (tools.length > 500 || new Set(tools.map(item => item.name)).size !== tools.length) fail('MCP 工具目录过大或名称重复。', 502);
    const encoded = JSON.stringify(tools);
    const secrets = [body.apiKey, body.apiKey?.replace(/^Bearer\s+/i, ''), endpoint.href, ...endpoint.searchParams.values()].filter(value => typeof value === 'string' && value.length >= 6);
    if (secrets.some(secret => encoded.includes(secret))) fail('数据源返回了认证信息，工具目录未保存。', 502);
    const readOnlyToolCount = Math.min(MAX_FINANCIAL_TOOLS, tools.filter(tool => readonlyFinancialToolSchema(tool)).length);
    return { provider: body.provider, status: tools.length ? 'ok' : 'empty', tools, readOnlyToolCount, transport: 'mcp', source: body.provider === 'ifind' ? 'iFinD HTTP MCP 工具目录' : '扶摇 HTTP MCP 工具目录', observedAt: now().toISOString(), endpointOrigin: endpoint.origin, limitation: '本次仅完成工具发现，未调用金融查询工具，也未获取公告或行情。' };
  } finally {
    if (session && !signal?.aborted) { try { const response = await fetchImpl(endpoint, { method: 'DELETE', headers, redirect: 'error', signal }); await response.body?.cancel(); } catch { /* Session cleanup must not hide an otherwise valid result. */ } }
  }
}

/** No ambient credentials, retries, trade endpoints, or filesystem access. */
export async function handleFinancialQuery(body, { signal, fetchImpl = fetch, now = () => new Date() } = {}) {
  if (!object(body) || !['fuyao', 'ifind'].includes(body.provider) || !['bars', 'tools'].includes(body.kind)) fail('请选择已支持的数据来源与查询类型。');
  const requestSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(20000)]);
  requestSignal.throwIfAborted();
  if (body.kind === 'bars' && body.provider !== 'fuyao') fail('iFinD 当前仅支持按官方 HTTP 配置发现工具，尚未核实行情字段。', 422);
  if (body.kind === 'bars') return historical(body, { signal: requestSignal, fetchImpl, now });
  try { return await discoverTools(body, { signal: requestSignal, fetchImpl, now }); }
  catch (error) { if (canUseFuyaoNewsRest(body, error)) return verifyFuyaoNewsRest(body, { signal: requestSignal, fetchImpl }); throw error; }
}

/** Store user-pasted source text with a server receipt time, without claiming
 * the URL was fetched or the user supplied publication time was verified. */
export function recordManualEvidence(body, { now = () => new Date(), randomUUID = () => crypto.randomUUID() } = {}) {
  if (!object(body) || !object(body.event)) fail('请填写事件原文与来源。');
  const observedAt = now().toISOString();
  const event = { ...body.event, id: randomUUID(), type: 'event', source: `用户录入：${text(body.event.source, '原文来源', 260)}`, recordedAt: observedAt.replace(/\.\d{3}Z$/, 'Z') };
  const context = validateContext({ trades: body.trades, contexts: {}, marketMode: 'import', origin: '用户提供', evidence: [event] });
  return { status: 'ok', evidence: context.evidence[0], observedAt };
}

// The evidence agent reuses the same bounded HTTP/SSE transport. Authentication
// remains inside each request-scoped connection and is never included in data.
export { fetchChecked as fetchFinancialChecked, rpcResponse as readFinancialRpcResponse };
