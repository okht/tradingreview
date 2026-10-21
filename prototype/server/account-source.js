import { validateContext } from './contracts.js';

const MAX_BYTES = 1024 * 1024;
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

function configuredHosts(value) {
  const entries = typeof value === 'string' ? value.split(/[\s,]+/) : value instanceof Set || Array.isArray(value) ? [...value] : [];
  return new Set(entries.filter(item => typeof item === 'string').map(item => item.trim().toLowerCase()).filter(item => item && !/[\s/*:@?#]/.test(item)));
}

export async function fetchAccountTrades(body, { allowedHosts, signal } = {}) {
  const hosts = configuredHosts(allowedHosts);
  if (!hosts.size) throw fail('账户接口尚未配置。请管理员设置 ACCOUNT_API_HOSTS 允许的域名，或先使用 CSV 导入。', 503);
  if (!body || typeof body.endpoint !== 'string' || body.endpoint.length > 2048) throw fail('请填写有效的只读接口地址。');
  let endpoint;
  try { endpoint = new URL(body.endpoint); } catch { throw fail('只读接口地址无效。'); }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.hash) throw fail('账户接口必须使用不含凭证或片段的 HTTPS 地址。');
  if (!hosts.has(endpoint.hostname.toLowerCase())) throw fail('此接口域名未获允许，请联系管理员配置，或使用 CSV 导入。', 403);
  if ([...endpoint.searchParams.keys()].some(key => /(?:token|secret|password|api[-_]?key|authorization|credential)/i.test(key))) throw fail('访问凭证请填写在凭证字段，不能放入接口地址。');
  if (body.token !== undefined && (typeof body.token !== 'string' || body.token.length > 4096 || /[\r\n]/.test(body.token))) throw fail('访问凭证格式无效。');
  const token = body.token?.trim();
  const requestSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(10000)]);
  let response;
  try {
    requestSignal.throwIfAborted();
    response = await fetch(endpoint.href, { method: 'GET', redirect: 'manual', signal: requestSignal, headers: { Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
  } catch {
    throw fail(requestSignal.aborted ? '读取已取消或超过 10 秒，请稍后重试。' : '账户接口暂时无法连接，请检查地址和权限。', requestSignal.aborted ? 504 : 502);
  }
  if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw fail('账户接口返回重定向。请填写允许域名下的最终 HTTPS 地址。', 502); }
  if (!response.ok) { await response.body?.cancel(); throw fail(`账户接口读取失败（HTTP ${response.status}），请检查只读权限。`, 502); }
  if (!/\bapplication\/(?:[a-z0-9.+-]+\+)?json\b/i.test(response.headers.get('content-type') || '')) { await response.body?.cancel(); throw fail('账户接口需返回 JSON 成交记录。', 502); }
  if (Number(response.headers.get('content-length') || 0) > MAX_BYTES) { await response.body?.cancel(); throw fail('账户响应超过 1 MB，请在接口端缩小交易范围。', 413); }
  if (!response.body) throw fail('账户接口没有返回内容。', 502);
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let size = 0; let text = '';
  try {
    while (true) {
      requestSignal.throwIfAborted();
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) throw fail('账户响应超过 1 MB，请在接口端缩小交易范围。', 413);
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } catch (error) {
    try { await reader.cancel(); } catch { /* Preserve only the safe public error. */ }
    if (error.status) throw error;
    throw fail(requestSignal.aborted ? '读取已取消或超过 10 秒，请稍后重试。' : '账户响应未完整接收，请重试。', 502);
  } finally { reader.releaseLock(); }
  let data;
  try { data = JSON.parse(text); } catch { throw fail('账户接口返回了无效 JSON。', 502); }
  if (!data || Array.isArray(data) || data.currency !== 'CNY' || data.quantityUnit !== 'share' || data.assetType !== 'stock') throw fail('账户接口须明确标注 currency 为 CNY、quantityUnit 为 share、assetType 为 stock。当前仅支持人民币股票。');
  if (!Array.isArray(data.trades) || !data.trades.length) throw fail('该范围没有可导入的成交记录。');
  if (data.trades.some(trade => trade?.assetType !== undefined && trade.assetType !== 'stock')) throw fail('本次包含非股票记录，请先筛选人民币股票成交。');
  const context = validateContext({ trades: data.trades, contexts: {}, marketMode: 'import', origin: `只读账户接口：${endpoint.hostname}` });
  return { trades: context.trades, currency: 'CNY', quantityUnit: 'share', assetType: 'stock', origin: context.origin, marketMode: 'import', warnings: context.trades.some(trade => trade.fee === null || trade.price === null) ? ['部分价格或费用未知，已保留 null；完整周期盈亏需要补齐这些字段。'] : [] };
}
