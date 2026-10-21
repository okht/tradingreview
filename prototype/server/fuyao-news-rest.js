// Official contract verified 2026-10-21:
// https://fuyao.aicubes.cn/docs/api-reference/news-stock-timeline/
// The news MCP gateway currently rejects initialize with HTTP 405. This narrow
// REST adapter is explicit, authenticated, and never probes undocumented paths.
const ENDPOINT = 'https://fuyao.aicubes.cn/api/news/stock/timeline-list';
const fail = (message, status = 502) => { throw Object.assign(new Error(message), { status }); };
export const FUYAO_REST_FALLBACK_REASON = '扶摇资讯 MCP 暂不可用，已通过官方资讯 REST 接口连接。';
export const FUYAO_NEWS_TOOL = Object.freeze({
  name: 'get_news_stock_timeline_list',
  description: '从扶摇官方 REST 接口读取所选股票新闻。thscode 使用完整同花顺代码；offset 首次为 first，继续查询须原样使用返回的 offset。按发布时间核对成交前资料；分页未覆盖到历史时点时保留待确认，不以最新新闻替代历史依据。',
  inputSchema: { type: 'object', properties: {
    thscode: { type: 'string', pattern: '^\\d{6}\\.(SH|SZ|BJ)$' },
    offset: { type: 'string', minLength: 1, maxLength: 512 },
    size: { type: 'integer', minimum: 1, maximum: 40 },
  }, required: ['thscode', 'offset', 'size'], additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false },
});

export function canUseFuyaoNewsRest(config, error) {
  try {
    const url = new URL(config?.endpoint);
    return config.provider === 'fuyao' && url.href === 'https://fuyao.aicubes.cn/mcp/news'
      && typeof config.apiKey === 'string' && Boolean(config.apiKey.trim())
      && (!config.authHeader || config.authHeader === 'X-api-key')
      && [404, 405, 501].includes(error?.upstreamStatus);
  } catch { return false; }
}

export async function fetchFuyaoStockNews(config, args, { signal, fetchImpl = fetch } = {}) {
  if (typeof config?.apiKey !== 'string' || !config.apiKey.trim() || config.apiKey.length > 4096 || /[\r\n\0]/.test(config.apiKey)) fail('扶摇资讯鉴权配置无效。', 400);
  if (!args || Object.keys(args).some(key => !['thscode', 'offset', 'size'].includes(key)) || !/^\d{6}\.(SH|SZ|BJ)$/.test(args.thscode)
    || typeof args.offset !== 'string' || !args.offset || args.offset.length > 512
    || !Number.isInteger(args.size) || args.size < 1 || args.size > 40) fail('个股资讯查询参数无效。', 400);
  const requestSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(20000)]);
  requestSignal.throwIfAborted();
  const url = new URL(ENDPOINT);
  for (const [key, value] of Object.entries(args)) url.searchParams.set(key, String(value));
  let response;
  try { response = await fetchImpl(url, { method: 'GET', headers: { 'X-api-key': config.apiKey.trim(), Accept: 'application/json' }, redirect: 'error', signal: requestSignal }); }
  catch (error) { if (requestSignal.aborted) throw requestSignal.reason ?? error; fail('扶摇资讯连接失败，请稍后重试。'); }
  if (!response.ok) { await response.body?.cancel(); fail('扶摇资讯请求未通过，请检查权限或稍后重试。', response.status === 429 ? 429 : 502); }
  if (!response.body) fail('扶摇资讯没有返回内容。');
  const reader = response.body.getReader(), decoder = new TextDecoder(); let raw = '', bytes = 0;
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 2 * 1024 * 1024) { await reader.cancel(); fail('扶摇资讯响应过大，请缩小读取数量。'); }
      raw += decoder.decode(part.value, { stream: true });
    }
    raw += decoder.decode();
  } finally { reader.releaseLock(); }
  const key = config.apiKey.trim();
  if (raw.includes(key) || raw.includes(encodeURIComponent(key))) fail('数据源返回了认证信息，本次资讯未保存。');
  let payload; try { payload = JSON.parse(raw); } catch { fail('扶摇资讯返回格式无效。'); }
  if (payload?.code !== 0) fail('扶摇资讯查询未成功，请检查权限或稍后重试。', payload?.code === 4001 ? 429 : 502);
  const data = payload.data;
  if (!data || !Array.isArray(data.items) || data.items.length > args.size || typeof data.has_more !== 'boolean'
    || (data.offset != null && (typeof data.offset !== 'string' || data.offset.length > 512))) fail('扶摇资讯字段与官方契约不一致。');
  return { structuredContent: { data }, transport: 'rest', fallbackReason: FUYAO_REST_FALLBACK_REASON };
}

export async function verifyFuyaoNewsRest(config, options) {
  // One public, documented stock query confirms that the key has news access.
  // Its content is not added to a user's evidence or saved in connection state.
  const probe = await fetchFuyaoStockNews(config, { thscode: '300033.SZ', offset: 'first', size: 1 }, options);
  return { provider: 'fuyao', status: 'ok', tools: [FUYAO_NEWS_TOOL], readOnlyToolCount: 1,
    transport: 'rest', fallbackReason: FUYAO_REST_FALLBACK_REASON, source: '同花顺扶摇官方资讯 REST',
    observedAt: new Date().toISOString(), endpointOrigin: 'https://fuyao.aicubes.cn', verifiedRecordCount: probe.structuredContent.data.items.length,
    limitation: '已通过一次公开股票资讯查询验证读取权限。新闻按游标分页，未覆盖的历史范围需要继续查询；验证记录未写入复盘证据。' };
}
