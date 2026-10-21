import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import * as Popover from '@radix-ui/react-popover';
import { Bookmark, CalendarDays, ChartCandlestick, Check, ChevronDown, CircleAlert, CircleX, Clock3, Ellipsis, FileText, History, Info, ListChecks, Menu, MessageSquareText, PanelLeftClose, PanelLeftOpen, Pencil, Plus, Search, Settings2, Trash2, Import, X } from 'lucide-react';
import { Toaster, toast } from 'sonner';
import { Button, IconButton, Tag } from './ui.jsx';
import { focusDialogContent } from './dialog-focus.js';
import { WORKSPACE_KEY, createConversation, createWorkspace, readWorkspace, validateWorkspace } from './agent-workspace-state.js';
import { experienceMode, experienceStorage } from './experience-mode.js';
import { modelIdentity } from './model-connection.js';
import useWorkspaceSync from './useWorkspaceSync.js';
import useSidebarLayout from './useSidebarLayout.js';
import AgentConversation from './AgentConversation.jsx';
import ProfileAvatar from './ProfileAvatar.jsx';
import DataSources from './DataSources.jsx';
import AsyncPanel from './AsyncPanel.jsx';
import Pagination, { usePagination } from './Pagination.jsx';
import TradeNavigator from './TradeNavigator.jsx';
import { StyledSelect } from './SelectionControls.jsx';
import DateTimePicker from './DateTimePicker.jsx';
import { MethodLibrary } from './ResearchPanel.jsx';
import { apiRequest } from './services/api.js';
import { saveMethodVersions } from './research-state.js';
import { createResearchRequestController } from './research-request-state.js';
import { currentTradePatch, scopeSelectionPatch } from './review-material-state.js';
import { CONVERSATION_TITLE_LIMIT, conversationTitleError, deleteConversation, renameConversation } from './conversation-actions.js';
import { deleteSavedMethod, renameSavedMethod } from './method-actions.js';
import { learningDraftFromMessage, learningDraftFromSaved, persistLearningDraft } from './learning-actions.js';
import useBackgroundPreparation from './useBackgroundPreparation.js';
import useBackgroundCompletion from './useBackgroundCompletion.js';
import BackgroundSuggestion, { PreparationStatus } from './BackgroundSuggestion.jsx';
import { preparationScopeKey, suggestionText } from './background-preparation-state.js';
import { evidenceAtDecision } from '../server/contracts.js';
import './style.css';
import './journey.css';
import './agent-workspace.css';

const loadPriceChart = () => import('./PriceChart.jsx');
const loadModelSettings = () => import('./ModelSettings.jsx');
const loadImportTrades = () => import('./ImportTradesDialog.jsx');
const fmt = value => value == null ? '待补充' : Number(value).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
const timeLabel = value => value?.replace('T', ' ').slice(5, 16) || '待补充';
const panels = [{ id: 'trades', title: '本笔交易', icon: ChartCandlestick }, { id: 'background', title: '决策背景', icon: MessageSquareText }, { id: 'evidence', title: '相关证据', icon: FileText }];

function Modal({ open, onClose, title, description, children, wide = false, className = '' }) {
  return <Dialog.Root open={open} onOpenChange={value => !value && onClose()}><Dialog.Portal><Dialog.Overlay className="overlay"/><Dialog.Content className={`modal aw-modal ${wide ? 'aw-modal-wide' : ''} ${className}`} tabIndex={-1} onOpenAutoFocus={focusDialogContent}><div className="modal-head"><div><Dialog.Title>{title}</Dialog.Title><Dialog.Description>{description}</Dialog.Description></div><Dialog.Close asChild><IconButton label="关闭弹窗"><X size={18}/></IconButton></Dialog.Close></div>{children}</Dialog.Content></Dialog.Portal></Dialog.Root>;
}
function Field({ label, children }) { return <label className="j-form-field"><span>{label}</span>{children}</label>; }

function HistoryEntry({ item, active, onSelect, onRename, onDelete }) {
  const [open, setOpen] = useState(false);
  const menu = useRef(null);
  const openingDialog = useRef(false);
  function action(callback) { openingDialog.current = true; setOpen(false); callback(item); }
  function navigate(event) {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const options = [...menu.current.querySelectorAll('[role="menuitem"]')];
    const index = options.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
    options[next]?.focus();
  }
  return <div className={`aw-history-entry ${active ? 'active' : ''}`}>
    <button type="button" className="aw-history-link" aria-current={active ? 'page' : undefined} onClick={onSelect}><MessageSquareText size={15} aria-hidden="true"/><span>{item.title}</span></button>
    <Popover.Root open={open} onOpenChange={value => { openingDialog.current = false; setOpen(value); }}>
      <Popover.Trigger asChild><button type="button" className="aw-history-more" aria-label={`更多操作：${item.title}`} aria-haspopup="menu"><Ellipsis size={17} aria-hidden="true"/></button></Popover.Trigger>
      <Popover.Portal><Popover.Content ref={menu} className="aw-history-menu" align="start" side="right" sideOffset={8} collisionPadding={12} role="menu" aria-label={`${item.title}的操作`} onKeyDown={navigate} onCloseAutoFocus={event => { if (openingDialog.current) event.preventDefault(); }}>
        <button type="button" role="menuitem" onClick={() => action(onRename)}><Pencil size={15} aria-hidden="true"/>重命名</button>
        <button type="button" role="menuitem" className="aw-history-delete" onClick={() => action(onDelete)}><Trash2 size={15} aria-hidden="true"/>删除</button>
      </Popover.Content></Popover.Portal>
    </Popover.Root>
  </div>;
}

function CurrentTrade({ trade, conversation, onPatch }) {
  const [editing, setEditing] = useState(null);
  const [error, setError] = useState('');
  const change = (field, value) => { setEditing(previous => ({ ...previous, draft: { ...previous.draft, [field]: value } })); setError(''); };
  function save(event) {
    event.preventDefault();
    try { onPatch(currentTradePatch(conversation, trade.id, editing.draft, editing.original)); setEditing(null); toast.success('成交记录已更新'); }
    catch (failure) { setError(failure.message); }
  }
  return <div className="aw-current-trade">
    <div className="aw-current-trade-heading"><span>{trade.name}<small>{trade.symbol}</small></span><Button variant="ghost" size="sm" onClick={() => { setError(''); setEditing({ original: { ...trade }, draft: { ...trade } }); }}><Pencil size={13}/>修改</Button></div>
    <dl className="aw-trade-facts">
      <div><dt>成交时间</dt><dd>{trade.time.replace('T', ' ')}</dd></div><div><dt>方向</dt><dd className={trade.side === 'buy' ? 'buy-text' : 'sell-text'}>{trade.side === 'buy' ? '买入' : '卖出'}</dd></div><div><dt>成交价 / 元</dt><dd>{fmt(trade.price)}</dd></div>
      <div><dt>数量 / 股</dt><dd>{fmt(trade.quantity)}</dd></div><div><dt>费用 / 元</dt><dd>{fmt(trade.fee)}</dd></div><div><dt>记录来源</dt><dd>{conversation.origin || '用户提供'}</dd></div>
    </dl>
    <Modal open={Boolean(editing)} onClose={() => setEditing(null)} title="修改成交" description={`${trade.name}  ${trade.symbol}`}>
      {editing && <form className="aw-trade-edit" onSubmit={save}>
        <div className="aw-trade-edit-grid"><div className="j-form-field"><span>成交时间（北京时间）</span><DateTimePicker label="成交时间" value={editing.draft.time} onChange={value => change('time', value)}/></div><Field label="方向"><StyledSelect label="成交方向" value={editing.draft.side} onChange={value => change('side', value)} options={[{ value: 'buy', label: '买入' }, { value: 'sell', label: '卖出' }]}/></Field></div>
        <div className="aw-trade-edit-grid aw-trade-numbers"><Field label="成交价 / 元"><input inputMode="decimal" value={editing.draft.price ?? ''} onChange={event => change('price', event.target.value)} placeholder="待补充"/></Field><Field label="数量 / 股"><input inputMode="decimal" value={editing.draft.quantity ?? ''} onChange={event => change('quantity', event.target.value)}/></Field><Field label="费用 / 元"><input inputMode="decimal" value={editing.draft.fee ?? ''} onChange={event => change('fee', event.target.value)} placeholder="待补充"/></Field></div>
        {error && <p className="error-text aw-edit-error" role="alert"><CircleAlert size={14} aria-hidden="true"/><span>{error}</span></p>}
        <div className="modal-actions"><Button variant="ghost" onClick={() => setEditing(null)}>取消</Button><Button type="submit">保存修改</Button></div>
      </form>}
    </Modal>
  </div>;
}

function Materials({ conversation, conversations, onPatch, pane, setPane, focus, setFocus, reference, preparation, onConnect }) {
  const pagination = usePagination(conversation.trades.length, conversation.id);
  const scopeTable = useRef(null);
  const [scopeDraft, setScopeDraft] = useState(null);
  const [scopeError, setScopeError] = useState('');
  const contextId = useId();
  function changeScopePage(page) { pagination.onPageChange(page); requestAnimationFrame(() => scopeTable.current?.scrollIntoView({ block: 'start' })); }
  const selected = useMemo(() => conversation.trades.filter(trade => conversation.selectedIds.includes(trade.id)), [conversation.trades, conversation.selectedIds]);
  const trade = selected.find(item => item.id === focus) || selected[0];
  const [futureId, setFutureId] = useState(null);
  const future = futureId === trade?.id;
  const note = conversation.contexts[trade?.id] || { reason: '', plan: '', source: '现在回忆', unknown: false, noPlan: false };
  const completion = useBackgroundCompletion({ conversation, trade, conversations, preparation, onPatch });
  const acceptSuggestion = field => { try { return completion.accept(field); } catch (error) { toast.error(error.message); return false; } };
  const referencedMessage = reference?.messageId ? conversation.messages.find(message => message.id === reference.messageId) : null;
  const evidence = referencedMessage ? referencedMessage.evidence || [] : [...new Map([...conversation.evidence, ...conversation.messages.filter(message => message.contextRevision === conversation.contextRevision).flatMap(message => message.evidence || [])].map(item => [item.id, item])).values()];
  const currentEvidence = referencedMessage ? evidence : evidence.filter(item => !item.tradeId || item.tradeId === trade?.id).map(item => evidenceAtDecision(item, conversation.trades.find(value => value.id === item.tradeId)?.time || trade?.time));
  const dataPatch = values => onPatch({ ...values, contextRevision: conversation.contextRevision + 1 });
  function selectTrade(id) { setFocus(id); setFutureId(null); }
  function changeNote(values) { dataPatch({ contexts: { ...conversation.contexts, [trade.id]: { ...note, ...values, recordedAt: new Date().toISOString() } } }); }
  function openScope() { setScopeError(''); pagination.resetPage(); setScopeDraft({ ids: [...conversation.selectedIds], originalIds: [...conversation.selectedIds] }); }
  function toggleTrade(id) {
    setScopeDraft(previous => ({ ...previous, ids: previous.ids.includes(id) ? previous.ids.filter(item => item !== id) : [...previous.ids, id] })); setScopeError('');
  }
  function applyScope() {
    try {
      const patch = scopeSelectionPatch(conversation, scopeDraft.ids, scopeDraft.originalIds);
      const changed = patch.selectedIds.length !== conversation.selectedIds.length || patch.selectedIds.some(id => !conversation.selectedIds.includes(id));
      if (changed) { onPatch(patch); if (!patch.selectedIds.includes(trade?.id)) selectTrade(patch.selectedIds[0]); }
      setScopeDraft(null);
    } catch (error) { setScopeError(error.message); }
  }
  return <section className="aw-materials" aria-label="本次复盘材料">
    <div className="aw-material-summary"><strong>{conversation.trades[0]?.name}</strong><span><CalendarDays size={13}/>{selected[0]?.time.slice(0, 10)} — {selected.at(-1)?.time.slice(0, 10)}</span><Tag>{selected.length} 笔成交</Tag><button type="button" className="aw-scope-trigger" onClick={openScope}><Settings2 size={13}/>调整范围</button><button type="button" className="aw-material-toggle" aria-expanded={Boolean(pane)} aria-controls="aw-material-body" onClick={() => setPane(pane ? '' : 'background')}>{pane ? '收起材料' : '查看交易与材料'}<ChevronDown size={14} className={pane ? 'aw-rotate' : ''}/></button></div>
    <PreparationStatus preparation={preparation} onConnect={onConnect} onOpen={() => setPane('background')}/>
    <Modal open={Boolean(scopeDraft)} onClose={() => setScopeDraft(null)} title="调整复盘范围" description="选择本次需要复盘的成交。" wide className="aw-scope-modal">
      {scopeDraft && <div className="aw-scope-dialog">
        <div className="aw-scope-summary"><span>已选择 <strong>{scopeDraft.ids.length}</strong> / {conversation.trades.length} 笔</span><Button variant="ghost" size="sm" onClick={() => { setScopeDraft(previous => ({ ...previous, ids: conversation.trades.map(item => item.id) })); setScopeError(''); }}>选择全部</Button></div>
        <div ref={scopeTable} className="aw-table-wrap"><table><thead><tr><th>选择</th><th>时间</th><th>方向</th><th>价格 / 元</th><th>数量 / 股</th><th>费用 / 元</th></tr></thead><tbody>{conversation.trades.slice(pagination.start, pagination.end).map(item => <tr key={item.id}><td><label className="aw-row-check"><input type="checkbox" aria-label={`纳入 ${timeLabel(item.time)} 的交易`} checked={scopeDraft.ids.includes(item.id)} onChange={() => toggleTrade(item.id)}/></label></td><td>{timeLabel(item.time)}</td><td className={item.side === 'buy' ? 'buy-text' : 'sell-text'}>{item.side === 'buy' ? '买入' : '卖出'}</td><td>{fmt(item.price)}</td><td>{fmt(item.quantity)}</td><td>{fmt(item.fee)}</td></tr>)}</tbody></table></div>
        <Pagination {...pagination} total={conversation.trades.length} label="复盘范围分页" onPageChange={changeScopePage}/>
        {scopeError && <p role="alert" className="error-text aw-edit-error"><CircleAlert size={14} aria-hidden="true"/><span>{scopeError}</span></p>}
        <div className="modal-actions"><Button variant="ghost" onClick={() => setScopeDraft(null)}>取消</Button><Button onClick={applyScope} disabled={!scopeDraft.ids.length}>应用范围</Button></div>
      </div>}
    </Modal>
    {pane && <section id="aw-material-body" className="aw-material-body" aria-label="交易与复盘材料">
      <TradeNavigator trades={selected} value={trade?.id} onChange={selectTrade}/>
      <div className="j-stack aw-context-chart">
        <div className="aw-chart-view"><div className="j-toggle" role="group" aria-label="行情时间视角"><button aria-pressed={!future} onClick={() => setFutureId(null)}>当时可知</button><button aria-pressed={future} onClick={() => setFutureId(trade?.id)}>查看后续</button></div><span className="j-hint">{future ? '包含后续行情' : `截至 ${timeLabel(trade?.time)}`}</span></div>
        {trade && <AsyncPanel loader={loadPriceChart} label="行情视图" trades={selected} mode="import" marketData={conversation.marketData} cutoff={trade.time} showFuture={future}/>}
      </div>
      <div className="aw-material-tabs" role="tablist" aria-label="复盘材料类型" onKeyDown={event => { if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); const index = panels.findIndex(item => item.id === pane); const next = event.key === 'Home' ? 0 : event.key === 'End' ? panels.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + panels.length) % panels.length; setPane(panels[next].id); document.getElementById(`aw-material-tab-${panels[next].id}`)?.focus(); }}>
        {panels.map(({ id, title, icon: Icon }) => <button key={id} type="button" id={`aw-material-tab-${id}`} role="tab" aria-selected={pane === id} aria-controls="aw-material-panel" tabIndex={pane === id ? 0 : -1} onClick={() => setPane(id)}><Icon size={15}/>{title}</button>)}
      </div>
      <div id="aw-material-panel" className="aw-material-panel" role="tabpanel" aria-labelledby={`aw-material-tab-${pane}`}>
      {referencedMessage && <p className="aw-reference-note">下方为这条回答使用的证据快照，上方图表对应当前复盘。<button onClick={() => setPane('')}>收起并返回回答</button></p>}
      {pane === 'trades' && trade && <CurrentTrade key={trade.id} trade={trade} conversation={conversation} onPatch={onPatch}/>}
      {pane === 'background' && trade && <div className="aw-background j-stack">
        <div className="aw-background-source"><Field label="信息来源"><StyledSelect label="信息来源" value={note.source} onChange={value => changeNote({ source: value })} options={[{ value: '现在回忆', label: '现在回忆' }, { value: '当时记录', label: '当时记录' }]}/></Field></div>
        {note.source === '当时记录' && <p className="aw-preparation-missing">{!note.publishedAt || /^\d{4}-\d{2}-\d{2}$/.test(note.publishedAt) ? '原记录时间待核实，当前无法确认这段背景在决策前已存在。' : '用户标记为当时记录，原件与记录时间仍需核实。'}</p>}
        {preparation?.missing.length > 0 && <details className="aw-preparation-missing"><summary>仍需补充的材料</summary><ul>{preparation.missing.map((text, index) => <li key={index}>{text}</li>)}</ul></details>}
        <div className="aw-context-field" role="group" aria-labelledby={`${contextId}-reason`}>
          <div className="aw-context-field-head"><span id={`${contextId}-reason`}>当时为什么这样做</span><label className="aw-context-choice"><input type="checkbox" checked={Boolean(note.unknown)} aria-label="当时的理由记不清了" onChange={event => changeNote({ unknown: event.target.checked })}/>记不清了</label></div>
          {!note.unknown && <BackgroundSuggestion aria-labelledby={`${contextId}-reason`} rows={3} value={note.reason || ''} onChange={event => changeNote({ reason: event.target.value })} placeholder="写下你还记得的判断依据" suggestion={suggestionText(note, completion.candidate('reason'), 'reason')} basis={completion.candidate('reason')?.basis} onAccept={() => acceptSuggestion('reason')} onDismiss={() => completion.dismiss('reason')}/>}
        </div>
        <div className="aw-context-field" role="group" aria-labelledby={`${contextId}-plan`}>
          <div className="aw-context-field-head"><span id={`${contextId}-plan`}>原先的计划</span><label className="aw-context-choice"><input type="checkbox" checked={Boolean(note.noPlan)} onChange={event => changeNote({ noPlan: event.target.checked })}/>当时没有计划</label></div>
          {!note.noPlan && <BackgroundSuggestion aria-labelledby={`${contextId}-plan`} rows={2} value={note.plan || ''} onChange={event => changeNote({ plan: event.target.value })} placeholder="继续买入或退出的条件" suggestion={suggestionText(note, completion.candidate('plan'), 'plan')} basis={completion.candidate('plan')?.basis} onAccept={() => acceptSuggestion('plan')} onDismiss={() => completion.dismiss('plan')}/>}
        </div>
      </div>}
      {pane === 'evidence' && <div className="aw-evidence-list">
        <div className="aw-evidence-toolbar"><span>{currentEvidence.length ? `${currentEvidence.length} 份材料` : '暂无相关证据'}</span>{!referencedMessage && <DataSources mode="evidence" trades={selected} selectedTradeId={trade?.id} evidence={conversation.evidence} onEvidence={event => dataPatch({ evidence: [...conversation.evidence, event] })}/>}</div>
        {currentEvidence.map(item => <article key={item.id} data-evidence={item.id} className={reference?.evidenceId === item.id ? 'aw-evidence-highlight' : ''}><div className="aw-panel-heading"><h3>{item.title || '相关材料'}</h3><Tag tone={['before', 'after', 'recollection'].includes(item.timeClass) ? 'gray' : 'amber'}>{['before', 'after'].includes(item.timeClass) ? <Clock3 size={14} aria-hidden="true"/> : item.timeClass === 'recollection' ? <History size={14} aria-hidden="true"/> : <CircleAlert size={14} aria-hidden="true"/>}{{ before: '决策前', after: '决策后', recollection: '现在回忆', unknown: '时间待核对' }[item.timeClass] || '待核对'}</Tag></div><p>{item.text}</p><small>{item.source || '来源待补充'}{item.publishedAt ? ` / ${item.publishedAt}` : ''}</small>{/^https?:\/\//.test(item.url || '') && <a href={item.url} target="_blank" rel="noopener noreferrer">查看原文</a>}</article>)}
      </div>}
      </div>
    </section>}
  </section>;
}

export default function AgentWorkspace() {
  const mode = experienceMode();
  const [storage] = useState(() => experienceStorage(window.localStorage, mode));
  const [boot] = useState(() => { try { return { state: readWorkspace(storage), error: '' }; } catch (error) { return { state: createWorkspace(), error: error.message }; } });
  const [state, setState] = useState(boot.state);
  const latestState = useRef(state); latestState.current = state;
  const [loadError, setLoadError] = useState(boot.error);
  const [view, setView] = useState('chat');
  const [modal, setModal] = useState('');
  const [settingsTab, setSettingsTab] = useState('model');
  const [modelOverlay, setModelOverlay] = useState(false);
  const closeModelSettings = () => { setModelOverlay(false); if (modal === 'settings') setModal(''); };
  const [sidebar, setSidebar] = useState(false);
  const { width: sidebarWidth, collapsed, toggleCollapsed, separatorProps, isResizing } = useSidebarLayout();
  const [search, setSearch] = useState('');
  const [pane, setPane] = useState('');
  const [focus, setFocus] = useState(null);
  const [reference, setReference] = useState(null);
  const [saved, setSaved] = useState(true);
  const [editing, setEditing] = useState(null);
  const [rename, setRename] = useState('');
  const [conversationTarget, setConversationTarget] = useState(null);
  const [conversationError, setConversationError] = useState('');
  const [researchBusy, setResearchBusy] = useState(false);
  const researchRequest = useRef(null);
  if (!researchRequest.current) researchRequest.current = createResearchRequestController({ readState: () => latestState.current, request: (body, signal) => apiRequest('/api/research', { body, signal }), onBusyChange: setResearchBusy });
  useEffect(() => { researchRequest.current.refresh(); }, [state]);
  useEffect(() => () => researchRequest.current.cancel({ notify: false }), []);
  const [agentBusy, setAgentBusy] = useState(false);
  const importTarget = useRef(null);
  const active = state.conversations.find(item => item.id === state.activeId) || state.conversations[0];
  const preparation = useBackgroundPreparation({ conversation: active, model: state.model,
    readCurrent: () => { const current = latestState.current; return { conversation: current.conversations.find(item => item.id === current.activeId) || current.conversations[0], model: current.model, busy: agentBusy }; },
    commit: (id, scope, values) => {
      if (loadError) throw new Error('请先备份原工作区，再保存准备材料。');
      const current = latestState.current, target = current.conversations.find(item => item.id === id);
      if (!target || current.activeId !== id || preparationScopeKey(target, current.model) !== scope) return null;
      const next = validateWorkspace({ ...current, conversations: current.conversations.map(item => item.id === id ? { ...item, ...values, updatedAt: new Date().toISOString() } : item) });
      storage.setItem(WORKSPACE_KEY, JSON.stringify(next)); latestState.current = next; setState(next);
      return next.conversations.find(item => item.id === id);
    },
  });
  const settingsTrades = active.trades.filter(trade => active.selectedIds.includes(trade.id));
  function openModelSettings() { setSettingsTab('model'); setModal('settings'); }
  function saveMethod(method) {
    const previous = latestState.current;
    const methods = saveMethodVersions(previous.methods || [], Array.isArray(method) ? method : [method]);
    const next = validateWorkspace({ ...previous, methods });
    storage.setItem(WORKSPACE_KEY, JSON.stringify(next));
    latestState.current = next;
    setState(current => ({ ...current, methods }));
    toast.success('交易方法已保存');
  }
  function updateSavedMethod(action, id, title) {
    if (loadError) throw new Error('请先备份原工作区，再修改交易方法。');
    const previous = latestState.current;
    const next = action === 'rename' ? renameSavedMethod(previous, id, title) : deleteSavedMethod(previous, id);
    storage.setItem(WORKSPACE_KEY, JSON.stringify(next));
    latestState.current = next; setState(next);
    toast.success(action === 'rename' ? '交易方法已重命名' : '交易方法已删除');
  }
  async function performResearch(intent, assumptions, datasetIds) {
    try {
      return await researchRequest.current.run({ intent, assumptions, datasetIds }, (result, targetId) => {
        if (result.savedMethods.length) saveMethod(result.savedMethods);
        patchConversation({ research: result.research }, targetId);
      });
    } catch (error) { toast.error(error.message); throw error; }
  }
  const sync = useWorkspaceSync(state, restored => { researchRequest.current.cancel(); setState(restored); setView('chat'); setPane(''); }, { paused: !!loadError });
  useEffect(() => { if (loadError) { setSaved(false); return; } try { storage.setItem(WORKSPACE_KEY, JSON.stringify(validateWorkspace(state))); setSaved(true); } catch { setSaved(false); } }, [state, loadError, storage]);
  useEffect(() => { setPane(''); setFocus(null); setReference(null); }, [active?.id]);
  function patchConversation(values, id = active.id) {
    const previous = latestState.current, target = previous.conversations.find(item => item.id === id);
    const next = { ...previous, conversations: previous.conversations.map(item => item.id === id ? { ...item, ...values, updatedAt: new Date().toISOString() } : item) };
    latestState.current = next; setState(next);
    if (target && !target.trades.length && values.trades?.length) preparation.queue(id);
  }
  function openConversationAction(kind, item) { setConversationTarget({ id: item.id, title: item.title }); setRename(item.title); setConversationError(''); setModal(kind); }
  function applyConversationAction(event) {
    event?.preventDefault();
    try {
      if (loadError) throw new Error('请先备份原工作区，再修改历史复盘。');
      const previous = latestState.current;
      const next = modal === 'rename' ? renameConversation(previous, conversationTarget.id, rename) : deleteConversation(previous, conversationTarget.id);
      storage.setItem(WORKSPACE_KEY, JSON.stringify(next));
      latestState.current = next; setState(next); setModal('');
      if (modal === 'delete-conversation' && previous.activeId === conversationTarget.id) { setView('chat'); setPane(''); setFocus(null); setReference(null); }
      toast.success(modal === 'rename' ? '复盘已重命名' : '复盘已删除');
    } catch (error) { setConversationError(error.message || '保存失败，请检查浏览器存储空间。'); }
  }
  function newReview() {
    if (active && !active.messages.length && !active.trades.length && !active.draft.trim() && !active.pendingTrades) { setView('chat'); setSidebar(false); return; }
    if (state.conversations.length >= 30) { toast.error('当前工作区最多保存 30 次复盘。已有记录已保留。'); return; }
    researchRequest.current.cancel();
    const next = createConversation(); setState(previous => ({ ...previous, activeId: next.id, conversations: [next, ...previous.conversations] })); setView('chat'); setSidebar(false);
  }
  function openImport() { importTarget.current = active.id; setModal('import'); }
  function acceptTrades(trades, origin, marketData = null) {
    const previous = latestState.current;
    const target = previous.conversations.find(item => item.id === importTarget.current);
    if (!target) throw new Error('这次复盘已变化，请重新打开导入窗口。');
    try {
      let next;
      if (target.trades.length) {
        if (previous.conversations.length >= 30) throw new Error('当前工作区已达到 30 次复盘，已有记录已保留。');
        const added = { ...createConversation(), title: `${trades[0]?.name || '交易'}复盘`, trades, selectedIds: trades.map(item => item.id), origin, marketData };
        next = { ...previous, activeId: added.id, conversations: [added, ...previous.conversations] };
      } else next = { ...previous, activeId: target.id, conversations: previous.conversations.map(item => item.id === target.id ? { ...item, title: `${trades[0]?.name || '交易'}复盘`, trades, selectedIds: trades.map(item => item.id), origin, marketData, pendingTrades: null, contextRevision: item.contextRevision + 1, updatedAt: new Date().toISOString() } : item) };
      if (loadError) throw new Error('请先备份原工作区，再导入新的交易。');
      const clean = validateWorkspace(next); storage.setItem(WORKSPACE_KEY, JSON.stringify(clean)); latestState.current = clean; setState(clean);
      preparation.queue(clean.activeId);
      setModal(''); setView('chat'); toast.success(`已添加 ${trades.length} 笔交易`);
    } catch (error) { throw new Error(error.message || '导入保存失败，已有记录已保留。'); }
  }
  function saveLearning() {
    try {
      if (loadError) throw new Error('请先备份原工作区，再保存检查项。');
      const next = persistLearningDraft(latestState.current, editing, storage);
      latestState.current = next; setState(next); setEditing(null); toast.success('检查项已保存');
    } catch (error) { toast.error(error.message || '保存失败，请检查浏览器存储空间。'); }
  }
  function openLearning(messageId, conversationId) {
    try { setEditing(learningDraftFromMessage(latestState.current, conversationId, messageId)); }
    catch (error) { toast.error(error.message); }
  }
  function openSavedLearning(id) {
    try { setEditing(learningDraftFromSaved(latestState.current, id)); }
    catch (error) { toast.error(error.message); }
  }
  function selectPane(value) {
    const returnId = !value ? reference?.messageId : null;
    setReference(null); setPane(value);
    if (returnId) requestAnimationFrame(() => { [...document.querySelectorAll('[data-message-id]')].find(item => item.dataset.messageId === returnId)?.scrollIntoView({ block: 'start' }); });
  }
  function openEvidence(value) {
    setReference(value); setPane('evidence'); if (value?.tradeId) setFocus(value.tradeId);
    requestAnimationFrame(() => { const target = [...document.querySelectorAll('[data-evidence]')].find(item => item.dataset.evidence === value?.evidenceId); (target || document.querySelector('.aw-materials'))?.scrollIntoView({ block: 'start' }); });
  }
  function recoverLocal() {
    try {
      const raw = storage.getItem(WORKSPACE_KEY);
      if (raw) {
        storage.setItem(`${WORKSPACE_KEY}.backup.${Date.now()}`, raw);
        const url = URL.createObjectURL(new Blob([raw], { type: 'application/json' }));
        const link = document.createElement('a'); link.href = url; link.download = 'TradingReview-原工作区备份.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
      setLoadError('');
    } catch { toast.error('备份失败，原记录仍保留，请检查浏览器存储空间。'); }
  }
  const history = state.conversations.filter(item => item.title.toLowerCase().includes(search.toLowerCase()));
  const hasConversation = view === 'chat' && (active.trades.length > 0 || active.messages.length > 0);
  return <div className={`aw-app ${collapsed ? 'aw-app-collapsed' : ''} ${isResizing ? 'aw-app-resizing' : ''}`} style={{ '--sidebar-width': `${sidebarWidth}px` }}>
    {sidebar && <button className="aw-sidebar-shade" aria-label="收起侧边栏" onClick={() => setSidebar(false)}/>}
    <aside id="aw-workspace-sidebar" className={`aw-sidebar ${sidebar ? 'aw-sidebar-open' : ''} ${collapsed ? 'aw-sidebar-collapsed' : ''}`} aria-label="工作区">
      <div className="aw-sidebar-heading"><ProfileAvatar/><IconButton className="aw-desktop-toggle" label={collapsed ? '展开侧边栏' : '收起侧边栏'} aria-expanded={!collapsed} aria-controls="aw-workspace-sidebar" onClick={toggleCollapsed}>{collapsed ? <PanelLeftOpen size={18}/> : <PanelLeftClose size={18}/>}</IconButton><IconButton className="aw-mobile-close" label="收起侧边栏" onClick={() => setSidebar(false)}><PanelLeftClose size={18}/></IconButton></div>
      <IconButton className="aw-new" label="新建复盘" onClick={newReview}><span className="aw-new-content"><Plus size={18}/><span className="aw-new-label">新建复盘</span></span></IconButton>
      <IconButton className={`aw-nav ${view === 'checks' ? 'active' : ''}`} label="检查项" onClick={() => { setView('checks'); setSidebar(false); }}><ListChecks size={17}/><span className="aw-nav-label">检查项</span>{state.savedItems.length > 0 && <span className="aw-nav-count">{state.savedItems.length}</span>}</IconButton>
      <IconButton className={`aw-nav ${view === 'methods' ? 'active' : ''}`} label="交易方法" onClick={() => { setView('methods'); setSidebar(false); }}><ChartCandlestick size={17}/><span className="aw-nav-label">交易方法</span>{!!state.methods?.length && <span className="aw-nav-count">{state.methods.length}</span>}</IconButton>
      <div className="aw-history-head"><span>历史复盘</span><span>{state.conversations.filter(item => item.messages.length || item.trades.length).length || ''}</span></div>
      {state.conversations.length > 5 && <label className="aw-search"><Search size={14}/><input value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索复盘" aria-label="搜索复盘"/></label>}
      <nav className="aw-history" aria-label="历史复盘">{history.map(item => <HistoryEntry key={item.id} item={item} active={view === 'chat' && item.id === active.id} onSelect={() => { if (item.id !== active.id) researchRequest.current.cancel(); setState(previous => ({ ...previous, activeId: item.id })); setView('chat'); setSidebar(false); }} onRename={item => openConversationAction('rename', item)} onDelete={item => openConversationAction('delete-conversation', item)}/>)}{!history.length && <p className="j-hint">没有匹配的复盘</p>}</nav>
      <div className="aw-side-bottom"><IconButton className="aw-nav" label="设置" onClick={() => setModal('settings')}><Settings2 size={17}/><span className="aw-nav-label">设置</span></IconButton></div>
    </aside>
    {!collapsed && <div id="aw-sidebar-resizer" className="aw-sidebar-resizer" {...separatorProps}/>}
    <main className="aw-main">
      <div className="aw-experience-bar" aria-label="体验版本">
        <span>{mode === 'quick' ? '快速体验 · 已载入模拟案例，可查看复盘、编辑检查项和回测；新 AI 对话需连接模型。' : '完整版 · 连接自己的模型，导入交易开始复盘。'}</span>
        <a href={mode === 'quick' ? '/' : '/quick'}>{mode === 'quick' ? '打开完整版' : '快速体验'}<span aria-hidden="true"> ↗</span></a>
      </div>
      <div className={`aw-context-bar ${hasConversation ? '' : 'aw-context-bar-empty'}`}>
        <IconButton className="aw-mobile-menu" label="展开侧边栏" aria-expanded={sidebar} aria-controls="aw-workspace-sidebar" onClick={() => setSidebar(true)}><Menu size={19}/></IconButton>
        {hasConversation && <><div className="aw-context-title"><h1>{active.title}</h1><IconButton size="sm" label="重命名复盘" onClick={() => openConversationAction('rename', active)}><Pencil size={14}/></IconButton></div>{active.trades.length > 0 && <Button variant="action-red" size="sm" onClick={openImport}><Import size={14}/>导入交易</Button>}</>}
      </div>
      {!saved && <div role="alert" className="aw-sync aw-sync-error"><CircleX size={16} aria-hidden="true"/><span>本机保存失败</span></div>}
      {loadError && <div className="aw-sync aw-sync-error" role="alert"><CircleX size={16} aria-hidden="true"/><span>本机历史记录未通过校验，原内容已保留。{loadError}</span><Button size="sm" variant="secondary" onClick={recoverLocal}>备份原记录并继续</Button></div>}
      {(sync.pendingRemote || sync.error) && <div className="aw-sync" role="status"><Info size={16} aria-hidden="true"/>{sync.pendingRemote ? <><span>服务端已有工作区，请选择要继续使用的记录。</span><div className="aw-sync-actions"><Button size="sm" variant="feature" className="aw-restore" onClick={sync.restoreRemote}>恢复服务端记录</Button><Button size="sm" variant="secondary" onClick={sync.keepLocal}>使用本机记录</Button></div></> : <><span>{sync.error}</span><Button size="sm" variant="secondary" onClick={sync.retry}>重试同步</Button></>}</div>}
      {view === 'chat' ? <AgentConversation key={active.id} conversation={active} model={state.model} onPatch={values => patchConversation(values, active.id)} onConnect={openModelSettings} onImport={openImport} onSaveLearning={(_, messageId) => openLearning(messageId, active.id)} onEvidence={openEvidence} onSaveMethod={saveMethod} methods={state.methods || []} datasets={state.conversations} onResearch={performResearch} researchBusy={researchBusy} preparationBusy={["queued", "running"].includes(preparation.phase)} onBusyChange={setAgentBusy} onStopPreparation={() => preparation.cancel()}>
        {active.trades.length > 0 && <Materials key={active.id} conversation={active} conversations={state.conversations} onPatch={values => patchConversation(values, active.id)} pane={pane} setPane={selectPane} focus={focus} setFocus={setFocus} reference={reference} preparation={preparation} onConnect={openModelSettings}/>}
      </AgentConversation> : view === 'methods' ? <MethodLibrary methods={state.methods || []} conversations={state.conversations} research={active.research} onAction={performResearch} busy={researchBusy} onRenameMethod={(id, title) => updateSavedMethod('rename', id, title)} onDeleteMethod={id => updateSavedMethod('delete', id)}/> : <section className="aw-library">{state.savedItems.length ? <><div className="aw-library-intro"><h2>留给下一次决策</h2><p>在复盘对话中保存的检查项，可以随时修改。</p></div><div className="aw-check-grid">{state.savedItems.map(item => <button className="aw-check-card" key={item.id} onClick={() => openSavedLearning(item.id)}><Bookmark size={18}/><h3>{item.title}</h3><p>{item.action}</p><small>{item.trigger}</small><span>查看与编辑<Pencil size={12}/></span></button>)}</div></> : <div className="aw-library-empty"><span><Bookmark size={27}/></span><h2>还没有检查项</h2><p>复盘中的经验，可以整理成下一次决策前的提醒。</p><Button variant="secondary" onClick={() => setView('chat')}>开始复盘</Button></div>}</section>}
    </main>
    <Modal open={modal === 'import'} onClose={() => setModal('')} title="导入交易" description={active.trades.length ? '将为这批交易新建复盘，当前对话会保留。' : '确认交易记录后，在对话中继续复盘。'} wide><AsyncPanel loader={loadImportTrades} label="导入交易" model={state.model} onConnect={() => setModelOverlay(true)} onAccept={acceptTrades} onClose={() => setModal('')}/></Modal>
    <Modal open={modal === 'settings' || modelOverlay} onClose={closeModelSettings} title={modelOverlay ? '模型设置' : '设置'} description={modelOverlay ? '管理用于复盘的 AI 模型。' : '管理 AI 模型与数据连接。'}>
      {!modelOverlay && <div className="aw-settings-tabs" role="tablist" aria-label="设置分类" onKeyDown={event => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); const next = event.key === 'Home' ? 'model' : event.key === 'End' ? 'data' : settingsTab === 'model' ? 'data' : 'model'; setSettingsTab(next); document.getElementById(`aw-settings-${next}`)?.focus(); } }}>
        {[['model', 'AI 模型'], ['data', '数据连接']].map(([value, title]) => <button key={value} id={`aw-settings-${value}`} type="button" role="tab" aria-selected={settingsTab === value} aria-controls="aw-settings-panel" tabIndex={settingsTab === value ? 0 : -1} onClick={() => setSettingsTab(value)}>{title}</button>)}
      </div>}
      <div id="aw-settings-panel" role={modelOverlay ? undefined : 'tabpanel'} aria-labelledby={modelOverlay ? undefined : `aw-settings-${settingsTab}`}>
        {modelOverlay || settingsTab === 'model' ? <AsyncPanel loader={loadModelSettings} label="模型设置" model={state.model} onClose={closeModelSettings} onDisconnected={() => { setState(previous => previous.model?.auth === 'oauth' ? { ...previous, model: null } : previous); toast.success('本机 ChatGPT 授权已移除'); }} onConnected={model => { setState(previous => ({ ...previous, model, conversations: previous.conversations.map(item => modelIdentity(previous.model) === modelIdentity(model) ? item : { ...item, contextRevision: item.contextRevision + 1 }) })); closeModelSettings(); toast.success('模型已连接'); }}/>
          : <div className="j-stack"><p className="j-hint">{settingsTrades.length ? `当前复盘：${active.title}` : '导入交易后，可为本次复盘读取对应行情。'}</p><DataSources mode="connections" trades={settingsTrades} marketData={active.marketData} onMarketData={marketData => patchConversation({ marketData, contextRevision: active.contextRevision + 1 }, active.id)}/></div>}
      </div>
    </Modal>
    <Modal open={modal === 'rename'} onClose={() => setModal('')} title="重命名复盘" description="给这次复盘一个方便查找的名称。" className="aw-conversation-modal"><form className="j-stack" onSubmit={applyConversationAction}><Field label="名称"><input maxLength={CONVERSATION_TITLE_LIMIT} value={rename} onChange={event => { setRename(event.target.value); setConversationError(''); }} aria-invalid={Boolean(conversationError)} aria-describedby={conversationError ? 'aw-conversation-error' : undefined}/></Field>{conversationError && <p id="aw-conversation-error" role="alert" className="error-text aw-edit-error">{conversationError}</p>}<div className="modal-actions"><Button variant="secondary" onClick={() => setModal('')}>取消</Button><Button type="submit" disabled={Boolean(conversationTitleError(rename))}>保存</Button></div></form></Modal>
    <Modal open={modal === 'delete-conversation'} onClose={() => setModal('')} title="删除复盘" description={`确定删除「${conversationTarget?.title || ''}」？`} className="aw-conversation-modal"><p className="aw-delete-description">这次复盘的对话、交易和材料将被删除。已保存的交易方法和检查项会保留。</p>{conversationError && <p role="alert" className="error-text aw-edit-error">{conversationError}</p>}<div className="modal-actions"><Button variant="secondary" onClick={() => setModal('')}>取消</Button><Button variant="danger" className="aw-delete-confirm" onClick={applyConversationAction}>删除复盘</Button></div></Modal>
    <Modal open={!!editing} onClose={() => setEditing(null)} title="保存检查项" description="调整为下次决策前能实际执行的一条提醒。">{editing && <div className="j-stack">{[['title', '名称'], ['trigger', '什么时候使用'], ['action', '具体检查什么'], ['exception', '例外与边界（选填）']].map(([key, label]) => <Field key={key} label={label}><textarea rows={key === 'title' ? 1 : 2} maxLength={2000} value={editing[key] || ''} onChange={event => setEditing({ ...editing, [key]: event.target.value })}/></Field>)}<Button disabled={!editing.title?.trim() || !editing.trigger?.trim() || !editing.action?.trim()} onClick={saveLearning}><Check size={16}/>保存检查项</Button></div>}</Modal>
    <Toaster position="bottom-right" richColors/>
  </div>;
}
