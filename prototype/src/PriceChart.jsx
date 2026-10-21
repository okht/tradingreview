import React, { useEffect, useMemo, useRef, useState } from 'react';
import { CandlestickSeries, ColorType, CrosshairMode, LineStyle, TickMarkType, createChart } from 'lightweight-charts';
import { CandlestickChart, CircleX, Clock3, FlaskConical, Minus, Plus, RotateCcw } from 'lucide-react';
import { chartColors, getAvailableIntervals, groupChartMarkers, selectChartData } from './market-data.js';
import { attachTradeBadgeMarkers } from './trade-badge-markers.js';
import { Button, IconButton, Tag } from './ui.jsx';
import PeriodSelector from './PeriodSelector.jsx';
import { CHART_PERIODS, readChartPreferences, rememberChartPeriod } from './chart-preferences.js';
import { toast } from 'sonner';
import { tokens } from '@okht/huikan-design-system/tokens';
import './price-chart.css';

function formatDay(time) {
  // Intraday chart timestamps are UTC seconds; display the fixture's UTC+8 zone.
  if (typeof time === 'number') return new Date((time + 8 * 3600) * 1000).toISOString().slice(0, 16).replace('T', ' ');
  if (typeof time === 'string') return time;
  if (time && typeof time === 'object') return `${time.year}-${String(time.month).padStart(2, '0')}-${String(time.day).padStart(2, '0')}`;
  return '';
}

function Attribution() {
  return <a className="price-chart-attribution" href="https://www.tradingview.com/" target="_blank" rel="noreferrer" title="TradingView Lightweight Charts™; Copyright (с) 2025 TradingView, Inc.">TradingView</a>;
}

export default function PriceChart({ trades, mode, marketData, cutoff, showFuture = true }) {
  const containerRef = useRef(null);
  const chartRef = useRef(null);
  const [selectedPeriod, setSelectedPeriod] = useState(() => readChartPreferences().selected);
  const [hoverDay, setHoverDay] = useState(null);
  const [chartError, setChartError] = useState(false);
  const available = getAvailableIntervals({ trades, mode, marketData });
  const isSynthetic = marketData?.provider === 'synthetic' && marketData.synthetic === true;
  const isReal = Boolean(marketData?.status === 'ok' && getAvailableIntervals({ trades, mode: 'import', marketData }).length);
  const interval = available.includes(selectedPeriod) ? selectedPeriod : available[0] || '1D';
  const periodLabel = CHART_PERIODS.find(period => period.id === interval)?.label || '日 K';
  const isIntraday = ['15m', '4H'].includes(interval);
  const data = useMemo(() => selectChartData({ trades, mode, marketData, cutoff, showFuture, interval }), [trades, mode, marketData, cutoff, showFuture, interval]);
  // Looking up the hover date in current data prevents a stale future candle
  // from appearing in the legend while the selected decision changes.
  const focused = data.candles.find((candle) => candle.time === hoverDay) ?? data.candles.at(-1);
  const focusedRange = focused?.isPartial
    ? `截至 ${focused.asOf?.replace('T', ' ').slice(0, 16)}（北京时间，未收盘）`
    : isIntraday && focused?.startAt
    ? `${focused.startAt.slice(0, 16).replace('T', ' ')} 至 ${focused.endAt.slice(11, 16)}（北京时间）`
    : focused?.sourceFrom ? `${focused.sourceFrom} 至 ${focused.sourceTo}` : focused?.time;
  const focusedDateLabel = focused?.isPartial
    ? `截至 ${focused.asOf?.replace('T', ' ').slice(5, 16)}`
    : isIntraday && focused?.startAt
    ? `${focused.startAt.slice(5, 16).replace('T', ' ')} — ${focused.endAt.slice(11, 16)}`
    : focused?.sourceFrom ? `${focused.sourceFrom.slice(5)} — ${focused.sourceTo.slice(5)}` : focused?.time;

  function changePeriod(value) {
    if (!available.includes(value)) return;
    setHoverDay(null);
    setSelectedPeriod(value);
    if (!rememberChartPeriod(value)) toast.error('本次已切换，未能保存周期偏好');
  }

  useEffect(() => {
    setChartError(false);
    if (!containerRef.current || !data.candles.length) return undefined;
    let chart;
    let markerPlugin;
    let crosshairHandler;
    try {
      chart = createChart(containerRef.current, {
        autoSize: true,
        layout: { background: { type: ColorType.Solid, color: tokens.surface }, textColor: tokens['ink-tertiary'], fontFamily: tokens['font-family'], fontSize: 12, attributionLogo: true },
        grid: { vertLines: { color: tokens['chart-grid'] }, horzLines: { color: tokens['chart-grid'] } },
        rightPriceScale: { borderColor: tokens['chart-axis'], scaleMargins: { top: 0.16, bottom: 0.2 } },
        leftPriceScale: { visible: false },
        timeScale: { borderColor: tokens['chart-axis'], timeVisible: isIntraday, secondsVisible: false, rightOffset: 1.5, minBarSpacing: 8, tickMarkFormatter: (time, type) => isIntraday && [TickMarkType.Time, TickMarkType.TimeWithSeconds].includes(type) ? formatDay(time).slice(11) : formatDay(time).slice(5, 10) },
        crosshair: { mode: CrosshairMode.Normal, vertLine: { color: tokens['ink-tertiary'], style: LineStyle.Dashed, labelBackgroundColor: tokens.ink }, horzLine: { color: tokens['ink-tertiary'], style: LineStyle.Dashed, labelBackgroundColor: tokens.ink } },
        localization: { locale: 'zh-CN', dateFormat: 'yyyy-MM-dd', timeFormatter: formatDay, priceFormatter: (price) => price.toFixed(2) },
        handleScroll: { mouseWheel: false, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
        handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: { time: true, price: true } },
      });
      const series = chart.addSeries(CandlestickSeries, {
        upColor: chartColors.up,
        downColor: chartColors.down,
        borderUpColor: chartColors.up,
        borderDownColor: chartColors.down,
        wickUpColor: chartColors.up,
        wickDownColor: chartColors.down,
        priceLineVisible: false,
        lastValueVisible: true,
        priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
      });
      series.setData(data.candles);
      // Markers are annotations: keep their pixel size out of price autoscaling.
      // The existing scaleMargins provide room for the filled B/S badges.
      markerPlugin = attachTradeBadgeMarkers(series, groupChartMarkers(data.markers), data.candles);
      crosshairHandler = (event) => {
        const candle = event.seriesData.get(series);
        setHoverDay(candle && event.time ? typeof event.time === 'number' ? event.time : formatDay(event.time) : null);
      };
      chart.subscribeCrosshairMove(crosshairHandler);
      fitView(chart);
      chartRef.current = chart;
    } catch {
      setChartError(true);
      chart?.remove();
      chartRef.current = null;
      return undefined;
    }
    return () => {
      if (crosshairHandler) chart.unsubscribeCrosshairMove(crosshairHandler);
      markerPlugin?.detach();
      chart.remove();
      if (chartRef.current === chart) chartRef.current = null;
    };
  }, [data]);

  function fitView(chart) {
    if (data.candles.length < 8) {
      chart.timeScale().setVisibleLogicalRange({ from: data.candles.length - 9, to: data.candles.length + 1 });
    } else chart.timeScale().fitContent();
  }

  function resetView() {
    chartRef.current?.priceScale('right').applyOptions({ autoScale: true });
    if (chartRef.current) fitView(chartRef.current);
    setHoverDay(null);
  }

  function zoom(factor) {
    const scale = chartRef.current?.timeScale();
    const range = scale?.getVisibleLogicalRange();
    if (!range) return;
    const middle = (range.from + range.to) / 2;
    const halfSpan = Math.max(1.5, (range.to - range.from) * factor / 2);
    scale.setVisibleLogicalRange({ from: middle - halfSpan, to: middle + halfSpan });
  }

  if (mode !== 'sample' && !isReal) {
    return <section className="price-chart price-chart-empty" aria-label="行情尚未接入">
      <div className="price-chart-toolbar"><PeriodSelector value={interval} available={available} onChange={changePeriod}/><Tag className="price-chart-status"><Clock3 size={14} aria-hidden="true"/>行情待接入</Tag></div>
      <div className="price-chart-empty-state"><CandlestickChart size={31} strokeWidth={1.3}/><strong>这段交易还没有对应的 K 线</strong><p>成交记录未包含完整行情。<br/>接入对应行情后，即可查看 K 线与成交位置。</p></div>
    </section>;
  }

  return <section className="price-chart" aria-label={`${isSynthetic ? '合成' : isReal ? '历史' : '构造'}${periodLabel.replace(' ', '')}行情图`}>
    <div className="price-chart-toolbar">
      <div className="price-chart-context"><PeriodSelector value={interval} available={available} onChange={changePeriod}/>{isSynthetic ? <Tag tone="gray" title="用户导入的合成行情，由 5 分钟价格观测点聚合">合成行情</Tag> : isReal ? <Tag tone="gray" title={`${marketData.source}，获取于 ${marketData.observedAt}`}>扶摇 / 未复权</Tag> : <Tag tone="gray" className="price-chart-sample-badge" title="构造行情，仅用于演示"><FlaskConical size={12} strokeWidth={1.6} aria-hidden="true"/>示例数据</Tag>}</div>
      <div className="price-chart-controls">
        <span className="price-chart-unit" title="价格单位：人民币元">¥ CNY</span>
        <IconButton label="缩小K线图" size="sm" title="缩小" disabled={!focused || chartError} onClick={() => zoom(1.35)}><Minus size={14}/></IconButton>
        <IconButton label="放大K线图" size="sm" title="放大" disabled={!focused || chartError} onClick={() => zoom(0.75)}><Plus size={14}/></IconButton>
        <Button variant="secondary" size="sm" aria-label="复位K线视图" disabled={!focused || chartError} onClick={resetView}><RotateCcw size={14}/>复位</Button>
      </div>
    </div>
    {focused && <div className="price-chart-ohlc" aria-label={`${focusedRange} 开高低收`}>
      <span className="price-chart-date" title={focusedRange}>{focusedDateLabel}</span>
      {[['开', 'open'], ['高', 'high'], ['低', 'low'], [focused.isPartial ? '现' : '收', 'close']].map(([label, field]) => <span className="price-chart-ohlc-field" key={field}>{label}<strong className={`price-chart-value ${focused.close >= focused.open ? 'is-up' : 'is-down'}`}>{focused[field].toFixed(2)}</strong></span>)}
      {focused.isPartial && <Tag tone="gray"><Clock3 size={14} aria-hidden="true"/>未收盘</Tag>}
    </div>}
    {focused ? <div className="price-chart-plot">
      <div ref={containerRef} className="price-chart-canvas" role="img" aria-label={`${isSynthetic ? '合成' : isReal ? '历史' : '构造'}${periodLabel}，共 ${data.candles.length} 根K线；红涨绿跌，B 为买入，S 为卖出。${data.candles.at(-1).isPartial ? '最后一根为截至当时的未收盘状态。' : ''}支持拖动与缩放。`} data-interval={interval} data-candle-count={data.candles.length} data-last-visible-day={data.candles.at(-1).sourceTo || data.candles.at(-1).time} data-partial-as-of={data.candles.at(-1).isPartial ? data.candles.at(-1).asOf : undefined}/>
      {chartError && <div role="alert" className="price-chart-empty-state price-chart-error"><CircleX size={16} aria-hidden="true"/><strong>图表暂时无法加载</strong><span>成交记录仍可查看，请刷新页面重试。</span></div>}
    </div> : <div className="price-chart-empty-state price-chart-empty-range"><CandlestickChart size={28} strokeWidth={1.3}/><strong>当前时间点暂无可还原的行情</strong><span>需要截至当时的原始价格记录。</span></div>}
    {data.currentBar?.status === 'unknown' && <div className="chart-period-coverage" role="status"><strong className="chart-coverage-state"><Clock3 size={14} aria-hidden="true"/>当前这根 K 线的盘中状态待补充</strong><span>现有数据只有完整日线，无法还原 {data.currentBar.asOf?.replace('T', ' ').slice(5, 16)} 的开、高、低、现价。</span></div>}
    {!isIntraday && focused?.sourceTo && <div className="chart-period-coverage" role="status">{periodLabel}由{isSynthetic ? '合成价格记录聚合' : '已有日线合成'}<span>截至 {focused.sourceTo}，仅含已有数据</span></div>}
    <div className="price-chart-footer">
      <div className="price-chart-key">
        <span className="price-chart-trade-legend"><span className="price-chart-trade-letter is-up">B</span>买入</span>
        <span className="price-chart-trade-legend"><span className="price-chart-trade-letter is-down">S</span>卖出</span>
        <span className="price-chart-gesture">滚轮缩放，拖动查看</span>
        {isIntraday && <span title={interval === '15m' ? '北京时间。15分钟窗口按09:30–11:30、13:00–15:00分别聚合，边界观测归刚结束的窗口，不跨午休。OHLC仅代表合成观测。' : '北京时间。构造窗口按08:00–12:00、12:00–16:00划分，仅模拟上午和下午交易时段，不代表券商官方4小时口径。'}>UTC+8</span>}
      </div>
      <Attribution/>
    </div>
  </section>;
}
