import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectSyntheticChartData } from '../src/synthetic-market.js';
import { summarizeTrades } from '../src/domain.js';
import { validateContext } from '../server/contracts.js';

const output = resolve(dirname(fileURLToPath(import.meta.url)), '../../outputs/完整模拟交易与K线-20261021');
const round = value => Math.round(value * 100) / 100;
let seed = 20261021;
function random() { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return (seed + 1) / 4294967297; }
function normal() { return Math.sqrt(-2 * Math.log(random())) * Math.cos(2 * Math.PI * random()); }
const dayList = [];
for (let time = Date.parse('2025-06-03T00:00:00Z'); time <= Date.parse('2025-09-30T00:00:00Z'); time += 86400000) {
  if (![0, 6].includes(new Date(time).getUTCDay())) dayList.push(new Date(time).toISOString().slice(0, 10));
}
const slots = [];
for (const [start, end] of [[570, 690], [780, 900]]) for (let minute = start; minute <= end; minute += 5) slots.push(`${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`);
const regimes = [0.003, -0.004, 0.0003, 0.004, -0.0035, 0.0015, -0.001];
const pricePoints = []; let previous = 42.8;
for (let index = 0; index < dayList.length; index++) {
  const drift = regimes[Math.min(regimes.length - 1, Math.floor(index / 13))];
  const anchor = previous, gap = Math.max(-0.025, Math.min(0.025, normal() * 0.005));
  let current = previous * (1 + gap), momentum = 0;
  for (let j = 0; j < slots.length; j++) {
    momentum = 0.28 * momentum + normal() * 0.0016;
    current *= 1 + drift / slots.length + momentum + Math.sin(j / 7 + index) * 0.0001;
    current = Math.max(anchor * 0.91, Math.min(anchor * 1.09, current));
    pricePoints.push({ time: Date.parse(`${dayList[index]}T${slots[j]}:00+08:00`) / 1000, price: round(current) });
  }
  previous = current;
}
const marketData = { provider: 'synthetic', synthetic: true, status: 'ok', source: '用户导入的合成行情', symbol: 'SIM086', interval: '5m', adjust: 'none', currency: 'CNY', timeZone: 'Asia/Shanghai', from: dayList[0], to: dayList.at(-1), pricePoints };
const legs = [['buy', 500], ['buy', 300], ['sell', 200], ['buy', 200], ['sell', 300], ['buy', 200], ['sell', 700]];
const offsets = [0, 1, 3, 5, 7, 9, 11];
const tradeSlots = ['09:45', '14:10', '10:35', '13:25', '14:45', '10:15', '14:30'];
const cycleNames = ['上涨中的分批建仓', '回撤中补仓后止损', '震荡中的反复进出', '突破后的加仓与减仓', '下跌反弹中的再入场', '恢复阶段的分批退出'];
const reasons = ['按计划先买入一部分，保留资金。', '价格变化后继续买入，记录是否满足原定条件。', '先卖出一部分，降低持仓。', '重新买入，核对判断变化和触发条件。', '再次卖出一部分，检查执行是否一致。', '卖出后又买回，复盘交易频率和成本。', '卖出全部剩余持仓，结束本轮。'];
const trades = [], notes = [];
for (let cycle = 0; cycle < 6; cycle++) for (let leg = 0; leg < legs.length; leg++) {
  const day = dayList[5 + cycle * 13 + offsets[leg]], time = `${day}T${tradeSlots[(leg + cycle) % tradeSlots.length]}`;
  const point = pricePoints.find(item => item.time === Date.parse(`${time}:00+08:00`) / 1000);
  const [side, quantity] = legs[leg], amount = round(quantity * point.price);
  const fee = round(Math.max(5, amount * 0.00025) + amount * 0.00001 + (side === 'sell' ? amount * 0.0005 : 0));
  const trade = { id: `SYN-${String(trades.length + 1).padStart(3, '0')}`, symbol: 'SIM086', name: '澄川科技（模拟）', time, side, quantity, price: point.price, fee,
    accountId: 'SYNTHETIC-CNY-01', currency: 'CNY', feeCurrency: 'CNY', assetType: 'stock', quantityUnit: 'share', market: '模拟人民币股票', margin: false, leverage: 1, positionSide: 'long' };
  trades.push(trade); notes.push({ id: trade.id, cycle: cycle + 1, scenario: cycleNames[cycle], time, reason: reasons[leg], provenance: '为测试构造的决策线索，未自动写入用户回忆' });
}
const bundle = { format: 'huikan-review-bundle', version: 1, description: '完全合成的人民币股票交易和行情，固定随机种子，可复现；不对应真实公司或真实成交。', trades, marketData };
const context = validateContext({ trades, contexts: {}, origin: '合成测试资料包', marketData });
const fourHour = selectSyntheticChartData({ trades, marketData: context.marketData, interval: '4H' });
const daily = selectSyntheticChartData({ trades, marketData: context.marketData, interval: '1D' });
const summary = summarizeTrades(trades);
const aggregateNetPnl = round(summary.sellAmount - summary.buyAmount - summary.fees);
const cycles = cycleNames.map((name, index) => ({ cycle: index + 1, name, ...summarizeTrades(trades.slice(index * 7, index * 7 + 7)) }));
const csv = rows => { const columns = Object.keys(rows[0]); const cell = value => `"${String(value ?? '').replaceAll('"', '""')}"`; return '\uFEFF' + [columns.join(','), ...rows.map(row => columns.map(key => cell(row[key])).join(','))].join('\r\n'); };
await mkdir(output, { recursive: true });
const fixtureDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../public/fixtures');
await mkdir(fixtureDirectory, { recursive: true });
await writeFile(resolve(fixtureDirectory, 'complete-synthetic-review.json'), JSON.stringify(bundle));
await writeFile(resolve(output, '01-完整复盘资料包-42笔交易含K线.json'), JSON.stringify(bundle));
await writeFile(resolve(output, '02-成交记录-42笔.csv'), csv(trades));
await writeFile(resolve(output, '03-K线-4小时.csv'), csv(fourHour.candles.map(({ startAt, endAt, open, high, low, close }) => ({ startAt, endAt, open, high, low, close }))));
await writeFile(resolve(output, '04-K线-日线.csv'), csv(daily.candles.map(({ time, open, high, low, close }) => ({ time, open, high, low, close }))));
await writeFile(resolve(output, '05-价格观测-5分钟.csv'), csv(pricePoints.map(point => ({ time: `${new Date((point.time + 28800) * 1000).toISOString().slice(0, 19)}+08:00`, price: point.price }))));
await writeFile(resolve(output, '06-决策背景线索.csv'), csv(notes));
const manifest = { days: dayList.length, from: dayList[0], to: dayList.at(-1), trades: trades.length, buys: trades.filter(t => t.side === 'buy').length, sells: trades.filter(t => t.side === 'sell').length, fourHourCandles: fourHour.candles.length, pricePoints: pricePoints.length, summary, aggregateNetPnl, cycles: cycles.map(({ cycle, name, netPnl, fees }) => ({ cycle, name, netPnl, fees })) };
await writeFile(resolve(output, '校验摘要.json'), JSON.stringify(manifest, null, 2));
const readme = `# 完整模拟交易与 K 线\n\n全部为合成数据，不对应真实公司、市场报价或用户成交。\n\n## 直接使用\n\n在回看中打开「导入交易 → 导入文件」，选择「01-完整复盘资料包-42笔交易含K线.json」。确认导入后，交易与行情会一起保存。单独导入成交 CSV 不会附带行情。资料包包含 6 个独立持仓周期，复盘时可按其中一轮的交易勾选范围；完整周期收益率按单轮计算，下面另列全期间净现金盈亏合计。\n\n## 数据范围\n\n- ${dayList[0]} 至 ${dayList.at(-1)}，${dayList.length} 个交易日。\n- 42 笔成交：24 笔买入、18 笔卖出，6 轮完整建仓至清仓。\n- ${fourHour.candles.length} 根 4 小时窗口 K 线，${daily.candles.length} 根日线。\n- ${pricePoints.length} 个 5 分钟合成价格观测点，用于还原决策时刻的未收盘状态。\n- 包含上涨、回撤、震荡、突破和恢复阶段。交易有盈利和亏损，费用随金额和方向变化。\n\n## 一致性与口径\n\n行情先按固定随机种子生成，成交价取对应时间的价格观测点。所有成交均在模拟交易时段内，卖出数量不超过当时持仓，同日买入不能同日卖出，最后持仓为零。价格路径独立生成，未用稀疏成交反推 K 线。\n\n采用北京时间 09:30–11:30、13:00–15:00；没有午休、夜间和周末行情。4 小时为 08:00–12:00、12:00–16:00 两个固定时钟窗口，仅汇总各自包含的交易时段。这是资料包的聚合口径，不宣称是券商官方 240 分钟周期。5 分钟文件记录离散价格点，不声称覆盖每个 5 分钟区间内的全部极值。\n\n「当时可知」仅使用截至成交时刻的价格点，保留当根已形成状态并隐藏之后的变化；「查看后续」展示完整窗口。\n\n费用为测试假设：佣金 max(5元, 成交额×0.025%)，过户费成交额×0.001%，卖出额外 0.05%；逐笔四舍五入到分。这是合成费用，不能作为任何券商实际费率。\n\n总买入 ${summary.buyAmount.toFixed(2)} 元，总卖出 ${summary.sellAmount.toFixed(2)} 元，费用 ${summary.fees.toFixed(2)} 元，净盈亏 ${aggregateNetPnl.toFixed(2)} 元。\n\n${cycles.map(c => `- 第 ${c.cycle} 轮 ${c.name}：净盈亏 ${c.netPnl.toFixed(2)} 元`).join('\n')}\n\n「决策背景线索」只用于人工复盘练习，未自动填成用户当时的真实想法。生成器：prototype/scripts/generate-synthetic-review.mjs。\n`;
await writeFile(resolve(output, '使用说明.md'), readme);
console.log(JSON.stringify({ output, ...manifest }, null, 2));
