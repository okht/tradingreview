import { summarizeTrades } from '../src/domain.js';
import { buildEvidence, currentMarketBar, evidenceAtDecision, marketAtDecision, timestampMillis, validateContext } from './contracts.js';

const error = message => { const value = new Error(message); value.status = 400; throw value; };
const clone = value => JSON.parse(JSON.stringify(value));
const parameters = properties => ({ type: 'object', properties, additionalProperties: false });
const tradeIds = { type: 'array', items: { type: 'string' }, maxItems: 500, uniqueItems: true, description: '仅可选择本次复盘内的成交 id。省略则读取当前范围。' };
const decisionAt = { type: 'string', description: '可选截止时点，ISO 日期时间。无时区时解释为北京时间；不接受只有日期。' };

/** Pi-compatible read-only tools. No network, secrets, filesystem or globals. */
export function createReviewTools(input) {
  const context = validateContext(input);
  const syntheticInterval = context.marketData?.reviewInterval || '4H';
  const syntheticPeriod = syntheticInterval === '15m' ? '15 分钟' : '4 小时';
  const evidence = buildEvidence(context);
  const ids = new Set(context.trades.map(trade => trade.id));
  const times = new Map(context.trades.map(trade => [trade.id, timestampMillis(trade.time)]));
  function argumentsFor(args, allowed) {
    if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => !allowed.includes(key))) error('工具参数格式无效。');
    if (args.tradeIds !== undefined && (!Array.isArray(args.tradeIds) || args.tradeIds.length > 500 || new Set(args.tradeIds).size !== args.tradeIds.length || args.tradeIds.some(id => !ids.has(id)))) error('工具不能读取本次复盘范围之外的交易。');
    if (args.decisionAt !== undefined) timestampMillis(args.decisionAt);
    if (args.includeAfter !== undefined && typeof args.includeAfter !== 'boolean') error('includeAfter 必须为布尔值。');
    return args;
  }
  function selected(args) {
    return context.trades.filter(trade => (args.tradeIds === undefined || args.tradeIds.includes(trade.id)) && (args.decisionAt === undefined || timestampMillis(trade.time) <= timestampMillis(args.decisionAt)));
  }
  function tool(name, label, description, schema, read) {
    return { name, label, description, parameters: schema, async execute(_toolCallId, args = {}, signal) {
      if (signal?.aborted) throw signal.reason ?? new Error('请求已取消。');
      const data = clone(read(args));
      return { content: [{ type: 'text', text: JSON.stringify(data) }], details: data };
    } };
  }
  return [
    tool('read_trades', '读取成交', '读取用户已确认的本次复盘成交。空值为未知，不推断缺失成交，不执行交易。', parameters({ tradeIds, decisionAt }), args => {
      argumentsFor(args, ['tradeIds', 'decisionAt']);
      return { trades: selected(args), origin: context.origin, currency: 'CNY', quantityUnit: '股', timeZone: 'Asia/Shanghai', decisionAt: args.decisionAt ?? null };
    }),
    tool('read_evidence', '读取证据', '读取成交、用户背景、已提供事件与行情摘要；保留来源与时点标签。默认排除决策后证据。现在回忆与时点未知资料不能当作事前证明。本工具不联网获取资料。', parameters({ tradeIds, decisionAt, includeAfter: { type: 'boolean', default: false, description: '只有明确核对后续变化时设 true，事后资料仍标记 after。' } }), args => {
      argumentsFor(args, ['tradeIds', 'decisionAt', 'includeAfter']);
      const includeAfter = args.includeAfter === true;
      const all = evidence.filter(item => (args.tradeIds === undefined || args.tradeIds.includes(item.tradeId))
        // A recollection about a later decision can also leak its outcome.
        && (includeAfter || args.decisionAt === undefined || times.get(item.tradeId) <= timestampMillis(args.decisionAt)))
        .map(item => args.decisionAt === undefined ? { ...item } : evidenceAtDecision(item, args.decisionAt));
      return { evidence: all.filter(item => includeAfter || item.timeClass !== 'after'), decisionAt: args.decisionAt ?? null, includeAfter,
        marketDataAvailable: Boolean(context.marketData?.bars?.length || context.marketData?.pricePoints?.length), limitations: [context.marketData?.provider === 'synthetic' ? `行情全部为用户导入的合成测试观测；${syntheticPeriod} K 线按这些观测聚合，当前根仅使用截止时点以内的观测，不能作为真实市场事实。` : context.marketData ? '行情为工作区提交的历史日线；本次仅核验结构与时点。当前根截至决策时点的 OHLC 需要盘中记录，状态请读取 read_market.currentBar。' : '本工具只读取已有材料，当前未提供真实行情。', 'recollection 和 unknown 资料不能作为当时已知信息的证明。'] };
    }),
    tool('get_summary', '核算交易', '使用确定性代码核算人民币现货成交，支持一个或多个完整空仓至清仓周期的累计净盈亏与费用。多周期整体收益率返回 null，各周期收益率见 cycles。缺价格、费用或未清仓时净盈亏返回 null。', parameters({ tradeIds, decisionAt }), args => {
      argumentsFor(args, ['tradeIds', 'decisionAt']);
      const trades = selected(args);
      const missing = trades.flatMap(trade => ['price', 'fee'].filter(field => trade[field] === null).map(field => ({ tradeId: trade.id, field })));
      const summary = summarizeTrades(trades);
      if (missing.length || !trades.length) Object.assign(summary, { buyAmount: null, sellAmount: null, fees: null, netPnl: null, returnPct: null, position: null, isComplete: false });
      return { ...summary, missing, currency: 'CNY', decisionAt: args.decisionAt ?? null,
        calculationBasis: `逐笔成交金额与费用按分四舍五入；净盈亏为卖出额减买入额减全部费用；${summary.cycleCount > 1 ? `本组 ${summary.cycleCount} 个完整周期的净盈亏与费用已累计。各周期投入收益率分母为该周期累计买入额加买入费；周期间可能重复使用资金，未给定账户资金口径，整体收益率保留 null。` : '投入收益率分母为累计买入额加买入费。'}不年化，不含分红、拆股或汇率影响。` };
    }),
    ...(context.marketData ? [tool('read_market', '读取行情', context.marketData.provider === 'synthetic' ? `读取用户导入的合成测试行情。按 5 分钟观测聚合为${syntheticPeriod}窗口；before 仅含决策前已完整窗口，currentBar 仅含截至成交时点已知观测。完整当前根和后续根必须明确 includeAfter=true 才可见并标为事后。所有价格均为合成测试数据，不能表述成真实市场事实。` : '读取已提供的扶摇不复权日线。before 为决策前已完整的历史日线；currentBar 保留当根截至决策时点的状态。当前源只有历史日线，缺少盘中记录时 currentBar.status=unknown，不能声称当时没有 K 线。完整日线的最终 OHLC 不可充当盘中 OHLC/current。明确核对后续变化时才设 includeAfter=true。', {
      ...parameters({ tradeId: { type: 'string', description: '当前范围内的成交 ID，使用该成交时间作为固定截止点。' }, includeAfter: { type: 'boolean', default: false }, limit: { type: 'integer', minimum: 1, maximum: 120, default: 60, description: '每个分区最多返回的 K 线数；事前取最近数据，事后取最早数据，摘要仍说明完整已提供范围。' } }), required: ['tradeId'],
    }, args => {
      argumentsFor(args, ['tradeId', 'includeAfter', 'limit']);
      if (typeof args.tradeId !== 'string' || !ids.has(args.tradeId)) error('请选择当前复盘范围内的成交 ID。');
      const limit = args.limit ?? 60;
      if (!Number.isInteger(limit) || limit < 1 || limit > 120) error('行情读取上限须为 1 至 120。');
      const trade = context.trades.find(item => item.id === args.tradeId);
      const data = context.marketData;
      const partitions = marketAtDecision(data, trade.time);
      const includeAfter = args.includeAfter === true;
      const partition = timeClass => {
        const all = partitions[timeClass]; const enabled = timeClass === 'before' || includeAfter;
        const bars = enabled ? (timeClass === 'before' ? all.slice(-limit) : all.slice(0, limit)) : [];
        const source = enabled ? evidence.find(item => item.id === `market:${encodeURIComponent(trade.id)}:${timeClass}`) : undefined;
        return { timeClass, totalBars: all.length, returnedBars: bars.length, truncated: enabled && bars.length < all.length, evidence: source ?? null, bars };
      };
      return { symbol: data.symbol, source: data.source, provider: data.provider, ...(data.provider === 'synthetic' ? { synthetic: true, sourceInterval: data.interval } : {}), interval: data.provider === 'synthetic' ? syntheticInterval : data.interval, adjust: data.adjust, currency: data.currency, timeZone: data.timeZone,
        tradeId: trade.id, decisionAt: trade.time, observedAt: data.observedAt, availabilityPolicy: data.availabilityPolicy, includeAfter,
        currentBar: currentMarketBar(data, trade), currentBarEvidence: evidence.find(item => item.id === `market:${encodeURIComponent(trade.id)}:current`),
        before: partition('before'), after: partition('after'), limitations: data.provider === 'synthetic'
          ? [data.sourceVerification, syntheticInterval === '15m' ? '15 分钟按北京时间 09:30–11:30、13:00–15:00 分段，边界观测归刚结束的窗口；不跨午休。OHLC 仅代表离散合成观测。' : '4 小时采用北京时间 08:00–12:00 与 12:00–16:00 窗口，价格观测仅出现在声明的交易时段；这是合成测试口径。', '当前根先过滤晚于决策时点的观测，再计算 OHLC；不使用最终高低收盘值补造当时状态。', '5 分钟观测之间的价格未知，不插值，不推断遗漏交易日，不据此证明用户当时看到这些信息。']
          : [data.sourceVerification, '当时可知包含当根截至决策时点已形成的价格状态；当前真实源仅提供历史日线，无法还原该状态。须取得截止时点以内的原生盘中记录后重建 partial，后续变化与后续根保持隐藏。', '完整日线仍采用次日零点可用口径；不能将当日最终 OHLC 当作盘中状态，也不能把状态未知表述为当时没有 K 线。', '仅覆盖已提供日期；不推断缺失日线，不把日线拆为分钟线，不据此证明用户当时看到这些信息。', '不复权价格可能受除权除息影响；区间价格变化不等于投资总回报。'] };
    })] : []),
  ];
}
