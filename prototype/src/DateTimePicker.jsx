import React, { useId, useRef, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { CalendarDays, ChevronDown, ChevronLeft, ChevronRight, Clock3 } from 'lucide-react';
import { Button } from './ui.jsx';
import { StyledSelect } from './SelectionControls.jsx';
import { validDate, calendarDays, dateWithinRange, pickerParts, pickerValue } from './date-time.js';
import './date-time-picker.css';

const pad = value => String(value).padStart(2, '0');
const dateKey = date => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

const hours = [{ value: 'unset', label: '小时' }, ...Array.from({ length: 24 }, (_, n) => ({ value: pad(n), label: `${pad(n)} 时` }))];
const minutes = [{ value: 'unset', label: '分钟' }, ...Array.from({ length: 60 }, (_, n) => ({ value: pad(n), label: `${pad(n)} 分` }))];
const months = Array.from({ length: 12 }, (_, n) => ({ value: String(n), label: `${n + 1} 月` }));

export default function DateTimePicker({ value = '', onChange, disabled = false, label = '发布时间', mode = 'datetime', allowDateOnly = false, min, max }) {
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState('');
  const [hour, setHour] = useState('');
  const [minute, setMinute] = useState('');
  const [includeTime, setIncludeTime] = useState(false);
  const [month, setMonth] = useState(() => new Date());
  const dateInput = useRef(null);
  const daysRef = useRef(null);
  const id = useId();
  const onlyDate = mode === 'date';
  const result = pickerValue({ original: value, date, hour, minute, includeTime, min, max });
  const display = pickerParts(value);
  const displayValue = value ? `${display.date}${display.hour ? ` ${display.hour}:${display.minute}` : ''}` : '';
  const year = month.getFullYear();
  const years = Array.from({ length: 101 }, (_, n) => ({ value: String(year - 80 + n), label: `${year - 80 + n} 年` }));
  const dateInvalid = Boolean(date) && !validDate(date);
  const outOfRange = validDate(date) && !dateWithinRange(date, min, max);
  function changeOpen(next) {
    if (next && !open) {
      const saved = pickerParts(value);
      setDate(saved.date); setHour(saved.hour); setMinute(saved.minute);
      setIncludeTime(!onlyDate && (!allowDateOnly || Boolean(saved.hour)));
      const initial = validDate(saved.date) ? saved.date : validDate(min) ? min : validDate(max) ? max : dateKey(new Date());
      setMonth(new Date(`${initial}T12:00:00`));
    }
    setOpen(next);
  }
  function moveMonth(amount) { setMonth(previous => new Date(previous.getFullYear(), previous.getMonth() + amount, 1)); }
  function navigateDays(event) {
    const offsets = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    if (!(event.key in offsets)) return;
    const buttons = [...daysRef.current.querySelectorAll('button')];
    const index = buttons.indexOf(event.target);
    if (index < 0) return;
    event.preventDefault();
    const target = buttons[Math.max(0, Math.min(buttons.length - 1, index + offsets[event.key]))];
    if (target && !target.disabled) target.focus();
  }
  function confirm() { if (result !== null) { onChange(result); setOpen(false); } }
  return <Popover.Root open={open && !disabled} onOpenChange={changeOpen}>
    <Popover.Trigger asChild><button type="button" className={`dt-trigger ${value ? 'has-value' : ''}`} disabled={disabled} aria-label={`${label}，${displayValue || '未填写'}`}><CalendarDays size={16}/><span>{displayValue || (onlyDate || allowDateOnly ? '选择日期' : '选择日期和时间')}</span><ChevronDown size={14}/></button></Popover.Trigger>
    <Popover.Portal><Popover.Content className="dt-popup" onClick={event => event.stopPropagation()} align="start" sideOffset={8} collisionPadding={16} aria-label={`选择${label}`} onOpenAutoFocus={event => { event.preventDefault(); dateInput.current?.focus(); }}>
      <div className="dt-heading"><strong>{label}</strong>{!onlyDate && <span>北京时间</span>}</div>
      <label className="dt-date-input" htmlFor={`${id}-date`}><CalendarDays size={15}/><input ref={dateInput} id={`${id}-date`} aria-label={label.endsWith('日期') ? label : label.replace(/时间$/, '日期')} aria-invalid={dateInvalid || outOfRange || undefined} aria-describedby={dateInvalid || outOfRange ? `${id}-error` : undefined} value={date} placeholder="年-月-日" maxLength={10} inputMode="numeric" onChange={event => { const next = event.target.value; setDate(next); if (validDate(next)) setMonth(new Date(`${next}T12:00:00`)); }} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); confirm(); } }}/></label>
      <div className="dt-month"><button type="button" aria-label="上个月" onClick={() => moveMonth(-1)}><ChevronLeft size={16}/></button><div className="dt-month-select"><StyledSelect popupClassName="dt-select-popup" label="选择年份" value={String(year)} onChange={next => setMonth(new Date(Number(next), month.getMonth(), 1))} options={years}/><StyledSelect popupClassName="dt-select-popup" label="选择月份" value={String(month.getMonth())} onChange={next => setMonth(new Date(year, Number(next), 1))} options={months}/></div><button type="button" aria-label="下个月" onClick={() => moveMonth(1)}><ChevronRight size={16}/></button></div>
      <div className="dt-weekdays" aria-hidden="true">{['一', '二', '三', '四', '五', '六', '日'].map(day => <span key={day}>{day}</span>)}</div>
      <div ref={daysRef} className="dt-days" onKeyDown={navigateDays} role="group" aria-label="选择日期">{calendarDays(year, month.getMonth()).map((day, index) => day ? <button key={day} type="button" aria-label={`${day} 日`} aria-pressed={date === day} disabled={!dateWithinRange(day, min, max)} className={date === day ? 'is-selected' : day === dateKey(new Date()) ? 'is-today' : ''} onClick={() => setDate(day)}>{Number(day.slice(-2))}</button> : <span key={`empty-${index}`}/>)}</div>
      {!onlyDate && <div className="dt-time-section"><div className="dt-time-heading"><span><Clock3 size={14}/>{allowDateOnly ? '具体时间' : '时间'}</span>{allowDateOnly && <label className="dt-time-toggle"><input type="checkbox" checked={includeTime} onChange={event => setIncludeTime(event.target.checked)}/>补充时分</label>}</div>{includeTime ? <div className="dt-time-selects"><StyledSelect popupClassName="dt-select-popup" label={`${label}小时`} value={hour || 'unset'} onChange={next => setHour(next === 'unset' ? '' : next)} options={hours}/><span>:</span><StyledSelect popupClassName="dt-select-popup" label={`${label}分钟`} value={minute || 'unset'} onChange={next => setMinute(next === 'unset' ? '' : next)} options={minutes}/></div> : <p className="dt-hint">仅记录日期，时间不详。</p>}</div>}
      {(dateInvalid || outOfRange) && <p className="dt-error" id={`${id}-error`} role="alert">{dateInvalid ? '请输入有效日期，如 2025-06-10。' : '请选择范围内的日期。'}</p>}
      <div className="dt-actions"><Button variant="ghost" size="sm" onClick={() => { onChange(''); setOpen(false); }}>清空</Button><Button size="sm" disabled={result === null} onClick={confirm}>确定</Button></div>
    </Popover.Content></Popover.Portal>
  </Popover.Root>;
}
