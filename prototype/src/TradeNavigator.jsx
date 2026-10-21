import React, { useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { Command } from 'cmdk';
import { Check, ChevronDown, ChevronLeft, ChevronRight, Search } from 'lucide-react';
import './trade-navigator.css';

const number = value => value == null ? '待补充' : Number(value).toLocaleString('zh-CN', { maximumFractionDigits: 4 });
const dateTime = value => typeof value === 'string' ? value.replace('T', ' ').slice(0, 16) : '时间待补充';
const direction = trade => trade?.side === 'buy' ? '买入' : trade?.side === 'sell' ? '卖出' : '方向待补充';
const normalize = value => value.toLowerCase().replace(/[\s/：:年月日-]/g, '');

export default function TradeNavigator({ trades = [], value, onChange }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const index = Math.max(0, trades.findIndex(item => item.id === value));
  const current = trades[index];
  const terms = query.trim().split(/\s+/).filter(Boolean).map(normalize);
  const filtered = trades.filter(item => terms.every(term => normalize(`${dateTime(item.time)} ${direction(item)} ${item.name || ''} ${item.symbol || ''}`).includes(term)));
  function changeOpen(next) { setOpen(next); setQuery(''); }
  function choose(id) { onChange(id); changeOpen(false); }

  return <div className="tn-navigation" role="group" aria-label="选择关键交易">
    <span className="tn-label">当前交易</span>
    <Popover.Root open={open && !!current} onOpenChange={changeOpen}>
      <Popover.Trigger asChild><button type="button" className="tn-trigger" disabled={!current} aria-label={current ? `选择交易，当前 ${dateTime(current.time)} ${direction(current)}` : '暂无交易'}>
        {current ? <><span className="tn-time">{dateTime(current.time)}</span><span className={current.side === 'buy' ? 'buy-text' : 'sell-text'}>{direction(current)}</span></> : <span>暂无交易</span>}<ChevronDown size={15}/>
      </button></Popover.Trigger>
      <Popover.Portal><Popover.Content className="tn-popup" align="start" sideOffset={7} collisionPadding={16} aria-label="选择交易">
        <Command shouldFilter={false} loop defaultValue={current?.id} label="交易目录">
          <div className="tn-search"><Search size={16}/><Command.Input value={query} onValueChange={setQuery} placeholder="搜索日期或买卖方向" aria-label="搜索日期或买卖方向" maxLength={80}/></div>
          <Command.List className="tn-list" aria-label="交易列表">
            {filtered.map(item => <Command.Item key={item.id} value={item.id} onSelect={() => choose(item.id)} className="tn-option" aria-label={`${dateTime(item.time)} ${direction(item)}，数量 ${number(item.quantity)}，成交价 ${number(item.price)}${item.id === current?.id ? '，当前交易' : ''}`}>
              <span className="tn-option-content"><span className="tn-option-main"><span>{dateTime(item.time)}</span><span className={item.side === 'buy' ? 'buy-text' : 'sell-text'}>{direction(item)}</span></span><span className="tn-option-detail"><span>数量 {number(item.quantity)}</span><span>成交价 {number(item.price)}</span></span></span>
              {item.id === current?.id && <Check size={16} className="tn-check" aria-hidden="true"/>}
            </Command.Item>)}
            {!filtered.length && <div className="tn-empty" role="status">没有匹配的交易</div>}
          </Command.List>
        </Command>
      </Popover.Content></Popover.Portal>
    </Popover.Root>
    <div className="tn-stepper"><span className="tn-position" aria-live="polite" aria-atomic="true">{current ? index + 1 : 0} / {trades.length}</span><button type="button" className="tn-arrow" aria-label="上一笔交易" disabled={!current || index === 0} onClick={() => choose(trades[index - 1].id)}><ChevronLeft size={17}/></button><button type="button" className="tn-arrow" aria-label="下一笔交易" disabled={!current || index >= trades.length - 1} onClick={() => choose(trades[index + 1].id)}><ChevronRight size={17}/></button></div>
  </div>;
}
