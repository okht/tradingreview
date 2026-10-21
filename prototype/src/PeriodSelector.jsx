import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import * as Dialog from '@radix-ui/react-dialog';
import { ArrowDown, ArrowUp, Check, ChevronDown, CircleAlert, Pencil, Plus, RotateCcw, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button, IconButton } from './ui.jsx';
import { focusDialogContent } from './dialog-focus.js';
import { CHART_PERIODS, CHART_PREFERENCES_KEY, CHART_PREFERENCES_EVENT, DEFAULT_CHART_FAVORITES, readChartPreferences, saveChartFavorites } from './chart-preferences.js';
import './period-selector.css';

const labelFor = id => CHART_PERIODS.find(period => period.id === id)?.label ?? id;

export default function PeriodSelector({ value, available = [], onChange }) {
  const [favorites, setFavorites] = useState(() => readChartPreferences().favorites);
  const [moreOpen, setMoreOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState([]);
  const [error, setError] = useState('');
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const moreRef = useRef(null);
  const panelRef = useRef(null);

  useEffect(() => {
    const refresh = event => {
      if (event.type === 'storage' && event.key !== CHART_PREFERENCES_KEY && event.key !== null) return;
      setFavorites(readChartPreferences().favorites);
    };
    window.addEventListener('storage', refresh);
    window.addEventListener(CHART_PREFERENCES_EVENT, refresh);
    return () => {
      window.removeEventListener('storage', refresh);
      window.removeEventListener(CHART_PREFERENCES_EVENT, refresh);
    };
  }, []);

  useLayoutEffect(() => {
    if (!moreOpen) return undefined;
    function placePanel() {
      const anchor = moreRef.current?.getBoundingClientRect();
      if (!anchor) return;
      const width = Math.min(288, window.innerWidth - 24);
      const height = panelRef.current?.offsetHeight || 246;
      setPosition({
        left: Math.max(12, Math.min(anchor.right - width, window.innerWidth - width - 12)),
        top: Math.max(12, anchor.bottom + height + 6 <= window.innerHeight - 12 ? anchor.bottom + 6 : anchor.top - height - 6),
      });
    }
    function closeOutside(event) {
      if (!panelRef.current?.contains(event.target) && !moreRef.current?.contains(event.target)) setMoreOpen(false);
    }
    placePanel();
    panelRef.current?.querySelector('button:not(:disabled)')?.focus();
    document.addEventListener('pointerdown', closeOutside);
    window.addEventListener('resize', placePanel);
    window.addEventListener('scroll', placePanel, true);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      window.removeEventListener('resize', placePanel);
      window.removeEventListener('scroll', placePanel, true);
    };
  }, [moreOpen]);

  function closeMore(restoreFocus = true) {
    setMoreOpen(false);
    if (restoreFocus) moreRef.current?.focus();
  }
  function select(id) {
    if (!available.includes(id)) return;
    onChange(id);
    if (moreOpen) closeMore();
  }
  function openEditor() {
    setDraft([...favorites]);
    setError('');
    setMoreOpen(false);
    setEditing(true);
  }
  function updateDraft(next) {
    setDraft(next);
    setError('');
  }
  function toggleFavorite(id) {
    if (draft.includes(id)) {
      if (draft.length === 1) { setError('至少保留一个常用周期'); return; }
      updateDraft(draft.filter(item => item !== id));
    } else if (available.includes(id)) updateDraft([...draft, id]);
  }
  function moveFavorite(index, offset) {
    const next = [...draft];
    const target = index + offset;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    updateDraft(next);
  }
  function restoreDefaults() {
    const next = DEFAULT_CHART_FAVORITES.filter(id => available.includes(id));
    if (!next.length) { setError('当前没有可用的默认周期，请先载入行情'); return; }
    updateDraft([...next]);
  }
  function save() {
    if (!draft.length) { setError('至少保留一个常用周期'); return; }
    if (draft.some(id => !favorites.includes(id) && !available.includes(id))) {
      setError('可用行情已变化，请移除暂无行情的新增周期后保存。');
      return;
    }
    if (!saveChartFavorites(draft, available)) {
      setError('未能确认保存到本机，请检查浏览器存储权限后重试。当前页面暂不应用此次修改。');
      return;
    }
    setFavorites([...draft]);
    setEditing(false);
    toast.success('常用周期已保存到本机');
  }
  function periodButton(period, className = '') {
    const enabled = available.includes(period.id);
    return <button key={period.id} type="button" className={`period-selector-option ${value === period.id ? 'is-selected' : ''} ${className}`} aria-pressed={value === period.id} disabled={!enabled} title={enabled ? `切换${period.label}` : `暂无${period.label}行情`} onClick={() => select(period.id)}>{period.label}</button>;
  }

  return <>
    <div className="period-selector" role="group" aria-label="K线周期">
      {favorites.map(id => periodButton({ id, label: labelFor(id) }))}
      {!favorites.includes(value) && CHART_PERIODS.some(period => period.id === value) && periodButton({ id: value, label: labelFor(value) }, 'period-selector-current')}
      <button ref={moreRef} type="button" className={`period-selector-more ${moreOpen ? 'is-open' : ''}`} aria-label="更多K线周期" aria-haspopup="dialog" aria-expanded={moreOpen} onClick={() => setMoreOpen(open => !open)}>更多<ChevronDown size={13}/></button>
    </div>
    {moreOpen && createPortal(<div ref={panelRef} className="period-selector-popover" style={position} role="dialog" aria-label="全部K线周期" onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeMore(); } }} onBlur={event => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget) && !moreRef.current?.contains(event.relatedTarget)) closeMore(false); }}>
      <div className="period-selector-popover-heading"><strong>K 线周期</strong><button type="button" className="period-selector-edit" onClick={openEditor}><Pencil size={13}/>编辑常用</button></div>
      <div className="period-selector-grid">{CHART_PERIODS.map(period => periodButton(period))}</div>
      <p>仅可选择已有行情的周期</p>
    </div>, document.body)}
    <Dialog.Root open={editing} onOpenChange={open => { setEditing(open); if (!open) setError(''); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="overlay"/>
        <Dialog.Content className="modal period-selector-editor" tabIndex={-1} onOpenAutoFocus={focusDialogContent} onCloseAutoFocus={event => { event.preventDefault(); moreRef.current?.focus(); }}>
          <div className="modal-head"><div><Dialog.Title>编辑常用周期</Dialog.Title><Dialog.Description>添加常用周期，按习惯调整排列顺序。保存后仅在当前浏览器生效。</Dialog.Description></div><Dialog.Close asChild><IconButton label="关闭周期编辑"><X size={18}/></IconButton></Dialog.Close></div>
          <div className="period-editor-heading"><h3>常用周期</h3><span>至少保留 1 项</span></div>
          <ol className="period-editor-list">{draft.map((id, index) => <li key={id}><span className="period-editor-order">{index + 1}</span><span className="period-editor-name">{labelFor(id)}{!available.includes(id) && <small>暂无行情</small>}</span><div className="period-editor-actions"><IconButton size="sm" label={`上移${labelFor(id)}`} disabled={index === 0} onClick={() => moveFavorite(index, -1)}><ArrowUp size={15}/></IconButton><IconButton size="sm" label={`下移${labelFor(id)}`} disabled={index === draft.length - 1} onClick={() => moveFavorite(index, 1)}><ArrowDown size={15}/></IconButton><IconButton size="sm" label={`移除${labelFor(id)}`} disabled={draft.length === 1} onClick={() => toggleFavorite(id)}><X size={14}/></IconButton></div></li>)}</ol>
          <div className="period-editor-heading"><h3>全部周期</h3><span>无行情的周期暂不可添加</span></div>
          <div className="period-selector-grid period-editor-options">{CHART_PERIODS.map(period => <button key={period.id} type="button" className={`period-selector-option ${draft.includes(period.id) ? 'is-favorite' : ''}`} aria-pressed={draft.includes(period.id)} disabled={(!draft.includes(period.id) && !available.includes(period.id)) || (draft.includes(period.id) && draft.length === 1)} title={!available.includes(period.id) && !draft.includes(period.id) ? `暂无${period.label}行情` : draft.includes(period.id) ? `移除${period.label}` : `添加${period.label}`} onClick={() => toggleFavorite(period.id)}>{draft.includes(period.id) ? <Check size={13}/> : <Plus size={13}/>} {period.label}</button>)}</div>
          <p className="period-editor-hint">恢复默认会更新此处的草稿，点击保存后才会应用。</p>
          {error && <p className="period-editor-error" role="alert"><CircleAlert size={14} aria-hidden="true"/><span>{error}</span></p>}
          <div className="modal-actions period-editor-footer"><Button variant="ghost" size="sm" onClick={restoreDefaults}><RotateCcw size={14}/>恢复默认</Button><div><Button variant="secondary" onClick={() => setEditing(false)}>取消</Button><Button onClick={save}><Check size={15}/>保存</Button></div></div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  </>;
}
