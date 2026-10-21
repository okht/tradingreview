import React, { useMemo, useState } from 'react';
import * as Select from '@radix-ui/react-select';
import * as Popover from '@radix-ui/react-popover';
import { Command } from 'cmdk';
import { Check, ChevronDown, ChevronUp, LoaderCircle, Plus, Search } from 'lucide-react';
import './selection-controls.css';

const normalized = value => value?.toLowerCase().replace(/[\s._-]/g, '') || '';
const numericName = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
function modelOrder(a, b) {
  const av = /^gpt-(\d+(?:\.\d+)?)/i.exec(a.id), bv = /^gpt-(\d+(?:\.\d+)?)/i.exec(b.id);
  if (av && bv) return Number(bv[1]) - Number(av[1]) || numericName.compare(a.id, b.id);
  if (av || bv) return av ? -1 : 1;
  return numericName.compare(b.id, a.id);
}
function ModelLabel({ item }) {
  const label = item.name || item.id;
  return <span className="sc-model-label"><span>{label}</span>{normalized(label) !== normalized(item.id) && <small>{item.id}</small>}</span>;
}

export function StyledSelect({ value, onChange, options, label, disabled = false, popupClassName = '' }) {
  const chosen = options.find(item => item.value === value);
  return <Select.Root value={value} onValueChange={onChange} disabled={disabled}>
    <Select.Trigger className="sc-trigger" aria-label={label}><span className="sc-choice">{chosen?.icon && <span className="sc-provider-mark" aria-hidden="true">{chosen.icon}</span>}<Select.Value/></span><Select.Icon><ChevronDown size={15}/></Select.Icon></Select.Trigger>
    <Select.Portal><Select.Content className={`sc-popup sc-select-popup ${popupClassName}`} position="popper" sideOffset={7} collisionPadding={16} align="start">
      <Select.ScrollUpButton className="sc-scroll"><ChevronUp size={14}/></Select.ScrollUpButton>
      <Select.Viewport className="sc-select-list">{options.map(item => <Select.Item key={item.value} value={item.value} className="sc-option" textValue={item.label}>{item.icon && <span className="sc-provider-mark" aria-hidden="true">{item.icon}</span>}<Select.ItemText>{item.label}</Select.ItemText><Select.ItemIndicator className="sc-check"><Check size={15}/></Select.ItemIndicator></Select.Item>)}</Select.Viewport>
      <Select.ScrollDownButton className="sc-scroll"><ChevronDown size={14}/></Select.ScrollDownButton>
    </Select.Content></Select.Portal>
  </Select.Root>;
}

export function ModelPicker({ value, onChange, models, disabled, loading, error, onRetry }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const choices = useMemo(() => [...new Map(models.filter(item => item?.id).map(item => [item.id, item])).values()].sort(modelOrder), [models]);
  const selected = choices.find(item => item.id === value);
  const filtered = choices.filter(item => normalized(`${item.id} ${item.name || ''}`).includes(normalized(query.trim())));
  const customId = query.trim();
  const custom = customId && !choices.some(item => item.id.toLowerCase() === customId.toLowerCase());
  function choose(id) { onChange(id); setOpen(false); }
  return <Popover.Root open={open && !disabled} onOpenChange={next => { setOpen(next); if (next) setQuery(''); }}>
    <Popover.Trigger asChild><button type="button" className="sc-trigger" disabled={disabled} aria-label="模型"><span className={`sc-current-model ${value ? '' : 'sc-placeholder'}`}>{selected?.name || value || '选择模型或输入 ID'}</span><ChevronDown size={15}/></button></Popover.Trigger>
    <Popover.Portal><Popover.Content className="sc-popup sc-model-popup" sideOffset={7} collisionPadding={16} align="start" aria-label="选择模型">
      <Command shouldFilter={false} loop label="模型目录"><div className="sc-search"><Search size={16}/><Command.Input value={query} onValueChange={setQuery} placeholder="搜索模型名称或输入 ID" aria-label="搜索模型名称或输入 ID" maxLength={150}/>{loading && <LoaderCircle className="sc-loading" size={15}/>}</div>
        <Command.List className="sc-model-list" aria-label="模型列表">
          {filtered.map(item => <Command.Item key={item.id} value={item.id} onSelect={() => choose(item.id)} className="sc-option sc-model-option"><ModelLabel item={item}/>{item.id === value && <Check className="sc-check" size={15}/>}</Command.Item>)}
          {custom && <Command.Item value={`custom:${customId}`} onSelect={() => choose(customId)} className="sc-option sc-custom"><Plus size={15}/><span>使用 <strong>{customId}</strong></span></Command.Item>}
          {!filtered.length && !custom && <div className="sc-empty" role="status">{loading ? '正在读取模型目录…' : error ? '暂时无法读取模型目录' : '输入模型 ID 后即可选择'}</div>}
        </Command.List>
        <div className="sc-footnote"><span>{error ? '可手动输入模型 ID' : '连接时验证模型是否可用'}</span>{error && <button type="button" onClick={onRetry}>重新加载</button>}</div>
      </Command>
    </Popover.Content></Popover.Portal>
  </Popover.Root>;
}
