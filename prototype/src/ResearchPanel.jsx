import React, { useId, useMemo, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import * as Popover from '@radix-ui/react-popover';
import { ArrowDownUp, BookmarkPlus, Check, CheckCircle2, CircleAlert, Clock3, ChevronDown, ChevronLeft, ChevronRight, Ellipsis, FlaskConical, Layers3, LoaderCircle, Pencil, Play, SlidersHorizontal, Sparkles, Trash2, X } from 'lucide-react';
import { Button, IconButton, Tag } from './ui.jsx';
import { StyledSelect } from './SelectionControls.jsx';
import DateTimePicker from './DateTimePicker.jsx';
import MoneyInput from './MoneyInput.jsx';
import { validDateTime } from './date-time.js';
import { focusDialogContent } from './dialog-focus.js';
import { METHOD_TITLE_LIMIT, methodTitleError } from './method-actions.js';
import { usePagination } from './Pagination.jsx';
import { paginationItems } from './pagination.js';
import { validateAssumptions } from './research-state.js';
import './research.css';

const originDescriptions = { inferred: '根据成交节点与行情推导，仍需结合决策背景核对。', 'user-described': '根据用户提供的判断依据与交易计划整理。', improved: '结合已有交易规则与复盘分析，形成优化方案。' };
const number = (value, digits = 2) => typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('zh-CN', { maximumFractionDigits: digits }) : '—';
const percent = value => typeof value === 'number' && Number.isFinite(value) ? `${number(value)}%` : '—';
const signed = value => typeof value === 'number' && Number.isFinite(value) ? `${value > 0 ? '+' : ''}${number(value)}` : '—';
const list = value => Array.isArray(value) ? value : [];
const metrics = [
  { key: 'netPnl', label: '净收益 / 元', format: number },
  { key: 'returnPct', label: '收益率', format: percent, deltaUnit: ' 个百分点' },
  { key: 'maxDrawdownPct', label: '最大回撤', format: percent, deltaUnit: ' 个百分点', lower: true },
  { key: 'sharpe', label: '夏普比率', format: number },
  { key: 'fees', label: '手续费 / 元', format: number, lower: true },
  { key: 'tradeCount', label: '成交笔数', format: value => number(value, 0) },
];

function Notes({ items, title = '数据与验证说明' }) {
  const notes = [...new Set(list(items).filter(item => typeof item === 'string' && item))];
  if (!notes.length) return null;
  return <details className="rp-notes"><summary><ChevronDown size={14}/>{title}</summary><ul>{notes.map(item => <li key={item}>{item}</li>)}</ul></details>;
}

function MethodStatus({ saved }) {
  return <div className="rp-method-tags"><Tag className={saved ? 'rp-method-ready' : 'rp-method-pending'}>{saved ? <CheckCircle2 size={14} aria-hidden="true"/> : <Clock3 size={14} aria-hidden="true"/>}{saved ? '已保存' : '待保存'}</Tag></div>;
}

function MethodSummary({ method, detailed = false, saved = false }) {
  if (!method) return null;
  const rules = method.rules || {}, analysis = method.analysis;
  const derivedSummary = rules.kind ? [
    `${rules.lookback} 根 K 线的移动均线作为参照`,
    rules.kind === 'trend' ? `价格高于均线 ${number(rules.entryDeviationPct)}% 时入场，低于均线 ${number(rules.exitDeviationPct)}% 时离场` : `价格低于均线 ${number(rules.entryDeviationPct)}% 时入场，回升至均线上方 ${number(rules.exitDeviationPct)}% 时离场`,
    `初始资金的 ${number(rules.allocationPct)}% 作为单次投入上限，受可用现金约束`,
    ...(rules.stopLossPct != null ? [`止损阈值 ${number(rules.stopLossPct)}%`] : []),
    ...(rules.takeProfitPct != null ? [`止盈阈值 ${number(rules.takeProfitPct)}%`] : []),
    ...(rules.maxHoldBars != null ? [`最多持有 ${rules.maxHoldBars} 根 K 线`] : []),
  ] : [];
  return <article className="rp-method">
    {!detailed && <div className="rp-method-heading"><div className="rp-method-title-row"><h3>{method.title}</h3><MethodStatus saved={saved}/></div><Layers3 size={19} aria-hidden="true"/></div>}
    {detailed && <section className="rp-method-overview" aria-label="方法概况"><div className="rp-method-context"><p><span>规则来源</span>{originDescriptions[method.origin] || '来源待核对。'}</p></div><dl className="rp-rule-snapshot"><div><dt>参照均线</dt><dd>{number(method.rules?.lookback, 0)} <span>根 K 线</span></dd></div><div><dt>入场偏离</dt><dd>{percent(method.rules?.entryDeviationPct)}</dd></div><div><dt>单次投入上限</dt><dd>{percent(method.rules?.allocationPct)}</dd></div><div><dt>止损阈值</dt><dd>{method.rules?.stopLossPct == null ? '未设置' : percent(method.rules.stopLossPct)}</dd></div></dl></section>}
    <details className="rp-rule-details" open={detailed || undefined}><summary>交易规则<ChevronDown size={14}/></summary>{method.description && <p className="rp-description">{method.description}</p>}<p>{method.status === 'ready' ? '规则条件已明确。' : '当前规则仍为候选，需要结合决策背景和独立回测核对。'}</p><ul>{(list(method.rulesSummary).length ? method.rulesSummary : derivedSummary).map(rule => <li key={rule}>{rule}</li>)}</ul>{method.derivation?.from && <p>推导区间 {method.derivation.from.slice(0, 10)} 至 {method.derivation.to?.slice(0, 10) || '待确认'}{method.derivation.symbol ? ` / ${method.derivation.symbol}` : ''}</p>}</details>
    {analysis && <><dl className="rp-evidence-stats"><div><dt>相符交易</dt><dd>{list(analysis.supportedTradeIds).length}</dd></div><div><dt>反例</dt><dd>{list(analysis.counterexampleTradeIds).length}</dd></div><div><dt>无法判断</dt><dd>{list(analysis.unassessableTradeIds).length}</dd></div><div><dt>有信号未交易</dt><dd>{number(analysis.nonTradeSignalCount, 0)}</dd></div></dl><AnalysisDetails analysis={analysis} methodId={method.id}/><Notes title="推导依据与不足" items={[analysis.scope, ...list(analysis.limitations)]}/></>}
  </article>;
}

function AnalysisDetails({ analysis, methodId }) {
  const signals = list(analysis?.nonTradeSignals), pagination = usePagination(signals.length, methodId);
  return <details className="rp-analysis-details"><summary>查看对应成交与信号节点<ChevronDown size={14}/></summary><dl>{[['相符交易', analysis.supportedTradeIds], ['反例交易', analysis.counterexampleTradeIds], ['无法判断', analysis.unassessableTradeIds]].map(([label, ids]) => <div key={label}><dt>{label}</dt><dd>{list(ids).length ? ids.join('、') : '无'}</dd></div>)}</dl>{signals.length > 0 && <><h4>有信号未交易的节点</h4><div className="rp-table-wrap"><table><thead><tr><th>信号时间（北京时间）</th><th>方向</th><th>偏离均线</th></tr></thead><tbody>{signals.slice(pagination.start, pagination.end).map(signal => <tr key={`${signal.time}-${signal.side}`}><td>{new Date(signal.time).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).slice(0, 16)}</td><td>{signal.side === 'buy' ? '买入' : '卖出'}</td><td>{percent(signal.deviationPct)}</td></tr>)}</tbody></table></div><ResultsPagination pagination={pagination} total={signals.length} label="信号节点分页"/>{analysis.nonTradeSignalCount > signals.length && <p className="rp-caption">展示前 {signals.length} 个节点，共 {analysis.nonTradeSignalCount} 个。</p>}</>}</details>;
}

function Comparison({ comparison, method }) {
  if (!comparison) return null;
  const paired = comparison.mode === 'method-pair';
  const intervalLabel = value => ({ '4H': '4 小时', '15m': '15 分钟', '1D': '日 K' })[value] || value;
  const computed = comparison.status === 'ok' && comparison.baseline?.metrics && comparison.alternative?.metrics;
  return <section className="rp-comparison" aria-label="历史对比结果"><div className="rp-section-heading"><div><h3><ArrowDownUp size={16}/>{paired ? '原版与改进版对比' : '历史对比'}</h3>{method && <p>{method.title}</p>}</div><Tag tone={computed ? 'gray' : 'amber'}>{!computed && <CircleAlert size={14} aria-hidden="true"/>}{computed ? list(comparison.warnings).some(item => /合成/.test(item)) ? '合成行情回放' : '历史回放' : '待补充条件'}</Tag></div>
    {!computed ? <p className="rp-description" role="status">{comparison.reason || '补齐资金和行情后，才能计算两种方案的差异。'}</p> : <>
      <div className="rp-table-wrap"><table className="rp-metrics-table"><thead><tr><th>指标</th><th>{paired ? '原方法回放' : '实际交易'}</th><th>{paired ? '改进方法回放' : '方法回放'}</th><th>差异</th></tr></thead><tbody>{metrics.map(metric => {
        const delta = comparison.delta?.[metric.key];
        const direction = metric.key === 'netPnl' || metric.key === 'returnPct' ? delta : metric.key === 'maxDrawdownPct' ? -delta : 0;
        return <tr key={metric.key}><th scope="row">{metric.label}</th><td>{metric.format(comparison.baseline.metrics[metric.key])}</td><td>{metric.format(comparison.alternative.metrics[metric.key])}</td><td className={direction > 0 ? 'rp-favorable' : direction < 0 ? 'rp-unfavorable' : ''}>{signed(delta)}{typeof delta === 'number' && metric.deltaUnit}</td></tr>;
      })}</tbody></table></div>
      <p className="rp-caption">{paired ? '两版使用相同起始资金、历史区间、行情、手续费、滑点与成交规则。差异 = 改进方法 − 原方法。' : '相同起始资金与历史区间。方法回放按设定计入手续费与滑点；实际交易使用记录中的成交价格和费用。'}</p>
    </>}
    {paired && comparison.interval && <p className="rp-caption">规则回放周期：{intervalLabel(comparison.interval)}。{comparison.reviewInterval && comparison.reviewInterval !== comparison.interval ? `复盘图使用 ${intervalLabel(comparison.reviewInterval)} 观察成交时点，规则回放统一使用 ${intervalLabel(comparison.interval)}。` : ''}</p>}
    <Notes items={comparison.warnings}/>
  </section>;
}

function AssumptionForm({ initialValues = {}, title = '计算设置', submitLabel = '运行历史对比', submitVariant = 'primary', busy, disabled, onSubmit, inline = false, selectionCount = 0 }) {
  const defaults = { feeBps: 3, slippageBps: 5, lotSize: 100 };
  const [draft, setDraft] = useState(() => Object.fromEntries(['initialCapital', 'feeBps', 'slippageBps', 'lotSize', 'from', 'to'].map(key => [key, initialValues[key] ?? defaults[key] ?? ''])));
  const [error, setError] = useState('');
  const change = (key, value) => { setDraft(previous => ({ ...previous, [key]: value })); setError(''); };
  async function submit(event) {
    event.preventDefault();
    try {
      if (['initialCapital', 'feeBps', 'slippageBps', 'lotSize'].some(key => String(draft[key]).trim() === '')) throw new Error('请补充起始资金、手续费、滑点与最小交易数量。');
      const input = { ...draft, ...Object.fromEntries(['initialCapital', 'feeBps', 'slippageBps', 'lotSize'].map(key => [key, Number(draft[key])])) };
      await onSubmit(validateAssumptions(input));
    } catch (failure) { setError(failure.message || '计算未完成，请稍后重试。'); }
  }
  const costFields = <div className="rp-input-grid rp-cost-fields"><label>手续费 / 万分之<input inputMode="decimal" aria-label="手续费万分之" value={draft.feeBps} onChange={event => change('feeBps', event.target.value)} placeholder="按实际费率填写"/></label><label>滑点 / 万分之<input inputMode="decimal" aria-label="滑点万分之" value={draft.slippageBps} onChange={event => change('slippageBps', event.target.value)} placeholder="填写回放成交偏差"/></label><label className="rp-lot-field">最小交易数量<input inputMode="numeric" aria-label="最小交易数量" value={draft.lotSize} onChange={event => change('lotSize', event.target.value)} placeholder="例如 A 股为 100 股"/></label></div>;
  const form = <form onSubmit={submit}>
    <div className="rp-input-grid rp-capital-field"><label>起始资金<span className="rp-input-unit"><MoneyInput aria-label="起始资金" value={draft.initialCapital} onChange={value => change('initialCapital', value)} disabled={busy} placeholder="输入金额"/><span>CNY</span></span></label></div>
    <div className="rp-input-grid rp-date-fields"><label>开始日期 <small>选填</small><DateTimePicker mode="date" label="回测开始日期" value={draft.from} onChange={value => change('from', value)} disabled={busy} max={validDateTime(draft.to, '00:00') ? draft.to : undefined}/></label><label>结束日期 <small>选填</small><DateTimePicker mode="date" label="回测结束日期" value={draft.to} onChange={value => change('to', value)} disabled={busy} min={validDateTime(draft.from, '00:00') ? draft.from : undefined}/></label></div>
    <p className="rp-caption">日期留空，使用完整行情区间。</p>
    {inline ? <details className="rp-cost-disclosure"><summary><span><SlidersHorizontal size={14}/>成交与成本</span><ChevronDown size={14}/></summary><p className="rp-cost-preview">手续费万分之 {draft.feeBps || '—'}<span>滑点万分之 {draft.slippageBps || '—'}</span></p>{costFields}</details> : <div className="rp-cost-expanded">{costFields}</div>}
    {error && <p className="rp-error" role="alert">{error}</p>}<div className="rp-form-actions">{inline && <span className="rp-run-summary">已选 <strong>{selectionCount}</strong> 个标的</span>}<Button type="submit" variant={submitVariant} size="sm" disabled={busy || disabled}>{busy ? <LoaderCircle size={14} className="rp-loading"/> : <Play size={13}/>} {submitLabel}</Button></div>
    <p className="rp-caption rp-assumption-footnote">每个标的独立使用这份资金与成本设置，结果仅用于历史验证。</p>
  </form>;
  return inline ? <section className="rp-assumptions rp-assumptions-inline"><h3>{title}</h3>{form}</section> : <details className="rp-assumptions" open={!initialValues.initialCapital || undefined}><summary>{title}<ChevronDown size={14}/></summary>{form}</details>;
}

function ResultsPagination({ pagination, total, label }) {
  if (total <= 10) return null;
  return <nav className="hk-pagination" aria-label={label}><span className="hk-pagination-count">{pagination.start + 1}–{pagination.end} / {total} 项</span><div className="hk-pagination-pages"><button type="button" className="hk-page" aria-label="上一页" disabled={pagination.page === 1} onClick={() => pagination.onPageChange(pagination.page - 1)}><ChevronLeft size={16}/></button>{paginationItems(pagination.page, pagination.pageCount).map(item => typeof item === 'number' ? <button type="button" className="hk-page" key={item} aria-label={`第 ${item} 页`} aria-current={pagination.page === item ? 'page' : undefined} onClick={() => pagination.onPageChange(item)}>{item}</button> : <span className="hk-page-gap" key={item}>…</span>)}<button type="button" className="hk-page" aria-label="下一页" disabled={pagination.page === pagination.pageCount} onClick={() => pagination.onPageChange(pagination.page + 1)}><ChevronRight size={16}/></button></div></nav>;
}

function BatchResults({ batch }) {
  const [sort, setSort] = useState('returnPct');
  const rows = useMemo(() => [...list(batch?.results)].sort((a, b) => {
    if (a.status !== 'ok' || b.status !== 'ok') return a.status === b.status ? 0 : a.status === 'ok' ? -1 : 1;
    const av = a.metrics?.[sort], bv = b.metrics?.[sort];
    if (av == null || bv == null) return av == null && bv == null ? 0 : av == null ? 1 : -1;
    return sort === 'maxDrawdownPct' ? av - bv : bv - av;
  }), [batch?.results, sort]);
  const pagination = usePagination(rows.length, `${sort}:${rows.map(row => row.datasetId).join(',')}`);
  if (!batch) return null;
  const firstComputed = rows.find(row => row.status === 'ok' && row.metrics);
  const synthetic = rows.some(row => list(row.warnings).some(warning => /合成/.test(warning)));
  return <section className="rp-batch"><div className="rp-section-heading"><div><h3>回测结果<Tag>{rows.length} 项</Tag></h3></div><div className="rp-sort"><StyledSelect label="回测结果排序" value={sort} onChange={setSort} options={[{ value: 'returnPct', label: '收益率从高到低' }, { value: 'sharpe', label: '夏普比率从高到低' }, { value: 'maxDrawdownPct', label: '最大回撤从低到高' }]}/></div></div>
    {firstComputed && <div className="rp-result-overview"><div className="rp-result-lead"><span>当前排序首位 <strong>{firstComputed.symbol}</strong></span>{synthetic && <Tag><FlaskConical size={12}/>包含合成行情</Tag>}</div><dl><div><dt>收益率</dt><dd className={firstComputed.metrics.returnPct > 0 ? 'rp-favorable' : firstComputed.metrics.returnPct < 0 ? 'rp-unfavorable' : ''}>{percent(firstComputed.metrics.returnPct)}</dd></div><div><dt>最大回撤</dt><dd>{percent(firstComputed.metrics.maxDrawdownPct)}</dd></div><div><dt>夏普比率</dt><dd>{number(firstComputed.metrics.sharpe)}</dd></div></dl></div>}
    {!rows.length ? <p className="rp-description">{batch.reason || '当前没有可展示的回测结果。'}</p> : <div className="rp-table-wrap"><table className="rp-results-table"><thead><tr><th>标的</th><th>验证范围</th><th>收益率</th><th>最大回撤</th><th>夏普</th><th>成交</th><th>费用 / 元</th></tr></thead><tbody>{rows.slice(pagination.start, pagination.end).map((row, index) => <tr key={row.datasetId || `${row.symbol}-${index}`}><th scope="row">{row.symbol || '未命名'}{row.status !== 'ok' && <small>{row.reason || '条件不足'}</small>}</th><td><span className={row.evaluation?.independent ? 'rp-validation-independent' : 'rp-validation-derived'}>{row.evaluation?.label || (row.status === 'ok' ? '待确认' : '未计算')}</span></td><td>{percent(row.metrics?.returnPct)}</td><td>{percent(row.metrics?.maxDrawdownPct)}</td><td>{number(row.metrics?.sharpe)}</td><td>{number(row.metrics?.tradeCount, 0)}</td><td>{number(row.metrics?.fees)}</td></tr>)}</tbody></table></div>}
    <ResultsPagination pagination={pagination} total={rows.length} label="回测结果分页"/><Notes items={batch.warnings}/>
  </section>;
}

export default function ResearchPanel({ research, savedMethods = [], onAction, busy = false, compact = false }) {
  const methods = list(research?.methods), [selectedId, setSelectedId] = useState(''), [error, setError] = useState(''), [pending, setPending] = useState(false);
  const selected = methods.find(method => method.id === selectedId) || methods.at(-1);
  const selectedSaved = Boolean(selected && list(savedMethods).some(method => method.id === selected.id));
  const comparedMethod = methods.find(method => method.id === research?.comparison?.alternative?.methodId);
  const working = busy || pending;
  async function act(action, assumptions) {
    setError(''); setPending(true);
    try { return await onAction({ action, ...(selected ? { methodId: selected.id } : {}) }, assumptions); }
    catch (failure) { setError(failure.message || '操作未完成，请稍后重试。'); }
    finally { setPending(false); }
  }
  return <section className={`rp-panel ${compact ? 'rp-compact' : ''}`} aria-label="交易方法研究" aria-busy={working}><div className="rp-section-heading"><h2><FlaskConical size={17}/>交易方法</h2>{working && <span className="rp-working"><LoaderCircle size={14} className="rp-loading"/>正在处理</span>}</div>
    {!methods.length ? <div className="rp-empty"><p>从成交节点与行情中提炼可复用的规则。</p><Button size="sm" variant="feature" disabled={working} onClick={() => act('infer')}><Sparkles size={14}/>提炼交易模式</Button></div> : <>
      {methods.length > 1 && <div className="rp-method-picker"><StyledSelect label="查看候选交易方法" value={selected.id} onChange={setSelectedId} options={methods.map(method => ({ value: method.id, label: method.title }))}/></div>}
      <MethodSummary method={selected} saved={selectedSaved}/><div className="rp-method-actions"><Button variant="feature" size="sm" disabled={working} onClick={() => act('improve')}><Sparkles size={14}/>{selected.origin === 'improved' ? '继续改进' : '生成改进方案'}</Button>{!selectedSaved && <Button variant="ghost" size="sm" disabled={working} onClick={() => act(selected.origin === 'improved' ? 'save_improved' : 'save_original')}><BookmarkPlus size={14}/>{selected.origin === 'improved' ? '采用并保存两版' : '保存当前方法'}</Button>}</div>
      <Comparison comparison={research?.comparison} method={comparedMethod || selected}/><AssumptionForm key={JSON.stringify(research?.assumptions || {})} initialValues={research?.assumptions} busy={working} onSubmit={assumptions => act('compare', assumptions)}/>
    </>}
    {error && <p className="rp-error" role="alert">{error}</p>}<Notes items={research?.limitations}/><BatchResults batch={research?.batch}/>
  </section>;
}

function MethodActions({ method, disabled, onRename, onDelete }) {
  const [menuOpen, setMenuOpen] = useState(false), [action, setAction] = useState(''), [title, setTitle] = useState(method.title), [error, setError] = useState(''), [pending, setPending] = useState(false);
  const menu = useRef(null), trigger = useRef(null), openingDialog = useRef(false);
  const id = useId();
  const canRename = typeof onRename === 'function', canDelete = typeof onDelete === 'function';
  if (!canRename && !canDelete) return null;
  function openAction(kind) { openingDialog.current = true; setMenuOpen(false); setTitle(method.title); setError(''); setAction(kind); }
  function closeAction() { if (!pending) setAction(''); }
  function navigateMenu(event) {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const options = [...menu.current.querySelectorAll('[role="menuitem"]')];
    const index = options.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
    options[next]?.focus();
  }
  async function submit(event) {
    event.preventDefault();
    if (pending || disabled) return;
    const validation = action === 'rename' ? methodTitleError(title) : '';
    if (validation) { setError(validation); return; }
    setPending(true); setError('');
    try { if (action === 'rename') await onRename(method.id, title.trim()); else await onDelete(method.id); setAction(''); }
    catch (failure) { setError(failure.message || '修改未保存，请重试。'); }
    finally { setPending(false); }
  }
  return <>
    <Popover.Root open={menuOpen} onOpenChange={value => { openingDialog.current = false; setMenuOpen(value); }}>
      <Popover.Trigger asChild><button ref={trigger} type="button" className="icon-button rp-method-more" aria-label={`更多操作：${method.title}`} aria-haspopup="menu" disabled={disabled || pending}><Ellipsis size={19} aria-hidden="true"/></button></Popover.Trigger>
      <Popover.Portal><Popover.Content ref={menu} className="rp-method-menu" sideOffset={7} align="end" collisionPadding={12} role="menu" aria-label="交易方法操作" onKeyDown={navigateMenu} onCloseAutoFocus={event => { if (openingDialog.current) event.preventDefault(); }}>
        {canRename && <button type="button" role="menuitem" onClick={() => openAction('rename')}><Pencil size={15} aria-hidden="true"/>重命名</button>}
        {canDelete && <button type="button" role="menuitem" className="rp-method-delete" onClick={() => openAction('delete')}><Trash2 size={15} aria-hidden="true"/>删除</button>}
      </Popover.Content></Popover.Portal>
    </Popover.Root>
    <Dialog.Root open={Boolean(action)} onOpenChange={value => { if (!value) closeAction(); }}><Dialog.Portal><Dialog.Overlay className="overlay"/><Dialog.Content className="modal rp-method-modal" tabIndex={-1} onOpenAutoFocus={focusDialogContent} onCloseAutoFocus={event => { event.preventDefault(); trigger.current?.focus({ preventScroll: true }); }}>
      <div className="modal-head"><div><Dialog.Title>{action === 'rename' ? '重命名交易方法' : '删除交易方法'}</Dialog.Title><Dialog.Description>{action === 'rename' ? '给这套交易方法一个方便识别的名称。' : `确定删除「${method.title}」？`}</Dialog.Description></div><Dialog.Close asChild><IconButton label="关闭弹窗" disabled={pending}><X size={18}/></IconButton></Dialog.Close></div>
      <form onSubmit={submit}>
        {action === 'rename' ? <label className="j-form-field"><span>方法名称</span><input value={title} maxLength={METHOD_TITLE_LIMIT} disabled={pending} onChange={event => { setTitle(event.target.value); setError(''); }} aria-invalid={Boolean(error && methodTitleError(title))} aria-describedby={error ? `${id}-error` : undefined}/></label> : <p className="rp-delete-description">该方法将从方法库中移除，相关复盘对话和历史记录会保留。</p>}
        {error && <p id={`${id}-error`} className="rp-error" role="alert"><CircleAlert size={14} aria-hidden="true"/><span>{error}</span></p>}
        <div className="modal-actions"><Button variant="secondary" disabled={pending} onClick={closeAction}>取消</Button><Button type="submit" className={action === 'delete' ? 'rp-delete-confirm' : ''} disabled={pending || disabled || (action === 'rename' && Boolean(methodTitleError(title)))}>{pending ? action === 'rename' ? '正在保存…' : '正在删除…' : action === 'rename' ? '保存名称' : '删除方法'}</Button></div>
      </form>
    </Dialog.Content></Dialog.Portal></Dialog.Root>
  </>;
}

export function MethodLibrary({ methods = [], conversations = [], research, onAction, onRenameMethod, onDeleteMethod, busy = false }) {
  const [selectedId, setSelectedId] = useState(''), [datasetIds, setDatasetIds] = useState([]), [localResearch, setLocalResearch] = useState(null), [pending, setPending] = useState(false), [error, setError] = useState(''), [section, setSection] = useState('backtest');
  const selected = methods.find(method => method.id === selectedId) || methods[0];
  const compatible = conversations.filter(item => item.marketData?.status === 'ok' && item.marketData.currency === 'CNY' && item.marketData.adjust === 'none' && (list(item.marketData.bars).length > 0 || list(item.marketData.pricePoints).length > 0));
  const chosen = datasetIds.filter(id => compatible.some(item => item.id === id));
  const persisted = [research, ...conversations.map(item => item.research)].filter(item => item?.batch?.results?.some(result => result.methodId === selected?.id)).sort((a, b) => (a.updatedAt || '').localeCompare(b.updatedAt || '')).at(-1);
  const local = localResearch?.methodId === selected?.id ? localResearch.research : null;
  const currentResearch = persisted && (!local || (persisted.updatedAt || '') >= (local.updatedAt || '')) ? persisted : local;
  const sharedAssumptions = currentResearch?.assumptions || research?.assumptions || conversations.map(item => item.research).filter(item => item?.assumptions?.initialCapital).sort((a, b) => (a.updatedAt || '').localeCompare(b.updatedAt || '')).at(-1)?.assumptions;
  const pagination = usePagination(compatible.length, compatible.map(item => item.id).join(','));
  const working = busy || pending;
  async function act(action, assumptions) {
    setError(''); setPending(true);
    try {
      const result = await onAction({ action, ...(selected ? { methodId: selected.id } : {}) }, assumptions, chosen);
      const resultResearch = result?.research || result;
      if (resultResearch?.batch || resultResearch?.comparison) setLocalResearch({ methodId: selected?.id, research: resultResearch });
    } catch (failure) { setError(failure.message || '操作未完成，请稍后重试。'); }
    finally { setPending(false); }
  }
  return <div className="rp-library">
    {!methods.length ? <section className="rp-library-empty"><Layers3 size={30}/><h2>还没有保存的交易方法</h2><p>在复盘对话中说「把它保存成交易方法」，即可在这里继续验证。</p></section> : <>
      <header className="rp-library-heading"><div className="rp-library-identity"><span className="rp-method-symbol" aria-hidden="true"><Layers3 size={22}/></span><div className="rp-library-title"><div className="rp-library-selector"><StyledSelect label="选择已保存交易方法" disabled={working} value={selected.id} onChange={value => { setSelectedId(value); setError(''); }} options={methods.map(method => ({ value: method.id, label: method.title }))}/></div></div><MethodActions key={selected.id} method={selected} disabled={working} onRename={onRenameMethod} onDelete={onDeleteMethod}/></div></header>
      <div className="rp-workbench"><div className="rp-workbench-main"><nav className="rp-library-tabs" aria-label="方法内容"><button type="button" aria-current={section === 'backtest' ? 'page' : undefined} onClick={() => setSection('backtest')}>回测验证</button><button type="button" aria-current={section === 'details' ? 'page' : undefined} onClick={() => setSection('details')}>方法详情</button></nav>
        {section === 'details' ? <section className="rp-method-detail-view" aria-label="方法详情"><MethodSummary key={selected.id} method={selected} detailed saved/></section> : <>
          <section className="rp-datasets"><div className="rp-section-heading"><div><h2>选择回测标的<span className="rp-inline-count">{compatible.length}</span></h2><p>使用已有行情，独立检验这套规则。</p></div><button type="button" className="rp-text-button" disabled={working || !compatible.length} onClick={() => setDatasetIds(chosen.length === compatible.length ? [] : compatible.map(item => item.id))}>{chosen.length === compatible.length && compatible.length ? '取消全选' : '选择全部'}</button></div>
            {!compatible.length ? <div className="rp-data-empty"><FlaskConical size={24}/><p>还没有可回测的行情</p><span>先在复盘中导入行情，或连接数据来源后获取。</span></div> : <><div className="rp-table-wrap"><table className="rp-dataset-table"><thead><tr><th><span className="rp-sr-only">选择</span></th><th>标的 / 数据来源</th><th>行情区间</th></tr></thead><tbody>{compatible.slice(pagination.start, pagination.end).map(item => <tr key={item.id} className={chosen.includes(item.id) ? 'rp-row-selected' : ''}><td><label className="rp-checkbox"><input type="checkbox" aria-label={`选择 ${item.marketData.symbol} ${item.title || ''} 的行情`} checked={chosen.includes(item.id)} disabled={working} onChange={() => setDatasetIds(previous => previous.includes(item.id) ? previous.filter(id => id !== item.id) : [...previous, item.id])}/><Check size={11} aria-hidden="true"/></label></td><th scope="row"><span>{item.trades?.[0]?.name || item.title || item.marketData.symbol}</span><small>{item.marketData.symbol}<span className="rp-source-label">{item.marketData.synthetic ? '合成行情' : item.marketData.source || '导入行情'}</span></small></th><td><span className="rp-date-range">{item.marketData.from}<span>至 {item.marketData.to}</span></span></td></tr>)}</tbody></table></div><ResultsPagination pagination={pagination} total={compatible.length} label="回测数据分页"/><p className="rp-caption">仅显示本工作区已有的兼容行情。</p></>}
          </section>
          <BatchResults batch={currentResearch?.batch}/>{!currentResearch?.batch && <div className="rp-await-results"><Clock3 size={16} aria-hidden="true"/><div><h3>等待回测结果</h3><p>选择标的并运行后，在这里对比收益、回撤与交易成本。</p></div></div>}
        </>}
      </div><aside className="rp-workbench-settings"><AssumptionForm key={`${selected.id}:${JSON.stringify(sharedAssumptions || {})}`} title="回测设置" initialValues={sharedAssumptions} submitLabel="运行批量回测" submitVariant="action-red" busy={working} disabled={!chosen.length} onSubmit={assumptions => { setSection('backtest'); return act('batch', assumptions); }} inline selectionCount={chosen.length}/>{error && <p className="rp-error" role="alert">{error}</p>}</aside></div>
    </>}
  </div>;
}
