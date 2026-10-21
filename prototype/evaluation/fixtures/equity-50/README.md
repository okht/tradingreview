# 50 组真实股票标的的合成评测资料

版本：equity-50-v1。固定 seed：20261022。来源核验日期：2026-10-22。

真实部分为 10 个 A 股股票代码及公司身份。全部价格、成交、费用、决策背景和事件均由生成器构造，不代表真实历史、实际用户行为或真实公司的新闻。

## 规模与覆盖

- 10 个真实标的 × 5 个情境，共 50 组。
- 每组 20、25、30、35 或 40 笔成交，总计 1500 笔；每组 5 轮完整持仓周期。
- 2025-03-03 至 2025-03-28，共 20 个交易日。
- 每组 1000 个 5 分钟离散价格点，聚合为 320 根 15 分钟 K 线；合计 50000 个观测点、16000 根 K 线。
- 上涨分批、下跌补仓/止损、震荡费用、突破后回落、先跌后反弹；兼顾原记录、现在回忆、理由未知、前/后/时间不详事件。
- 每组 8 个评测问题，合计 400 个。它们覆盖契约、时点、数值、动机、图表、经验沉淀、方法推广和安全边界。

## 如何使用

每个 EQ 文件夹的 bundle.json 可在产品的「导入交易 → 导入文件」导入。它只导入成交和行情；背景与事件由 context.json 提供给评测 runner，手工测试时可参照 decision-notes.csv 和 events.json 补充。单独导入 trades.csv 不会附带行情。candles-15m.csv 用于独立检查聚合，不是当前产品的独立行情导入格式。oracle.json 包含期望、禁区、独立现金账本及每轮盈亏。

manifest.json 提供所有路径、覆盖标签、SHA-256 和校验结果。context.json 可直接交给服务端 validateContext；oracle 的期望是评审依据，不能被塞进模型输入冒充用户证据。每组数据独立账户，批量导入需要分成独立复盘。

## K 线与费用口径

北京时间 09:30–11:30、13:00–15:00，每 5 分钟一个观测点，含每个时段的起止点。15 分钟窗口右闭：09:45 归 09:30–09:45；09:30 也归第一根；11:30、15:00 分别归上午、下午最后一根。窗口不跨午休。OHLC 仅为提供的离散观测的极值，不声称还原两个观测点之间的真实市场走势。未提供真实成交量。

成交价严格取对应合成时点，数量为 100 股整数倍，卖出仅动用前一交易日及更早买入的持仓，不做空，最后清仓。佣金采用测试假设 max(5 元, 金额×0.025%)，过户费金额×0.001%，卖出附加金额×0.05%，每笔合并后四舍五入到分。费率不代表任何券商实际收费。

标的价位基数仅用于制造低/中/高价覆盖，不是 2025 年实际报价。未模拟分红、除权、临时停牌、流动性、撮合和滑点。不能据此评估真实策略收益或交易可成交性。五轮合计仅报告净现金盈亏，不拼成单轮收益率或账户收益率。

## 复现和自检

在 prototype 根目录运行：

```
node scripts/generate-evaluation-dataset.mjs
```

生成器在落盘前验证当前产品的 JSON 导入、CSV 导入、契约、交易数量、日期时段、成交价格、费用、T+1 和持仓；独立聚合器逐根对比产品的 15 分钟 OHLC；对每一笔交易扰动未来价格，确认「当时可知」结果不受影响。固定数据与内容散列可用于同例前后评测。50 组均由同一生成器产生，不能当作 50 份独立真实市场样本。

## 官方身份与交易日历来源

- 600519.SH 贵州茅台：[上交所身份来源](https://www.sse.com.cn/assortment/stock/list/info/announcement/index.shtml?productId=600519)
- 601318.SH 中国平安：[上交所身份来源](https://www.sse.com.cn/disclosure/listedinfo/summaries/indexDetail.shtml?SEQ=334677897)
- 600036.SH 招商银行：[上交所身份来源](https://www.sse.com.cn/lawandrules/sselawsrules2025/trade/specific/margin/c/c_20260710_10825136.shtml)
- 601857.SH 中国石油：[上交所身份来源](https://star.sse.com.cn/assortment/stock/list/info/company/index.shtml?COMPANY_CODE=601857)
- 600030.SH 中信证券：[上交所身份来源](https://www.sse.com.cn/disclosure/listedinfo/regular/index.shtml?productId=600030)
- 600900.SH 长江电力：[上交所身份来源](https://www.sse.com.cn/assortment/stock/list/info/turnover/index.shtml?COMPANY_CODE=600900)
- 601668.SH 中国建筑：[上交所身份来源](https://www.sse.com.cn/disclosure/listedinfo/summaries/indexDetail.shtml?SEQ=334463995)
- 600887.SH 伊利股份：[上交所身份来源](https://www.sse.com.cn/disclosure/listedinfo/announcement/c/new/2024-08-30/600887_20240830_O9H6.pdf)
- 600276.SH 恒瑞医药：[上交所身份来源](https://www.sse.com.cn/disclosure/listedinfo/announcement/c/new/2022-09-24/600276_20220924_1_gIGXumJB.pdf)
- 600309.SH 万华化学：[上交所身份来源](https://www.sse.com.cn/assortment/stock/list/info/company/index.shtml?COMPANY_CODE=600309)
- [上交所 2025 年部分节假日休市安排](https://www.sse.com.cn/disclosure/announcement/general/c/c_20241223_10767108.shtml)。区间内无列示节假日，周末剔除。

这些来源只证明标的身份与交易所日历。构造事件中没有引用实际公司公告内容。
