import { prepareTradeCandidates } from './live-chat-state.js';

export const TRADE_CSV_TEMPLATE = 'id,symbol,name,time,side,quantity,price,fee\n';
const clean = value => typeof value === 'string' ? value.trim() : '';
const known = value => value != null && clean(String(value)) !== '' && !['unknown', '未知', '待确认', '待补充'].includes(String(value).toLowerCase());
const metadataFields = { currency: ['CNY', 'RMB', '人民币'], assetType: ['stock', 'equity', '股票'], quantityUnit: ['share', 'shares', '股'] };
const metadataLabels = { currency: '币种', assetType: '资产类型', quantityUnit: '数量单位' };

export function missingTradeFields(trade) {
  const missing = [];
  if (!clean(trade.name)) missing.push('标的名称');
  if (!clean(trade.symbol)) missing.push('标的代码');
  const date = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(trade.time) ? new Date(`${trade.time}Z`) : null;
  if (!date || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, trade.time.length) !== trade.time) missing.push('成交日期和时间');
  if (!['buy', 'sell'].includes(trade.side)) missing.push('买卖方向');
  if (!Number.isFinite(trade.quantity) || trade.quantity <= 0) missing.push('成交数量');
  return missing;
}
export function hasUnknownMarket(trade) { return Object.keys(metadataFields).some(key => Object.hasOwn(trade, key) && !known(trade[key])) || (trade.fee != null && Object.hasOwn(trade, 'feeCurrency') && !known(trade.feeCurrency)); }
export function confirmStockMetadata(trade) {
  const values = { currency: 'CNY', assetType: 'stock', quantityUnit: 'share', ...(trade.fee != null || Object.hasOwn(trade, 'feeCurrency') ? { feeCurrency: 'CNY' } : {}) };
  return { ...trade, ...Object.fromEntries(Object.entries(values).filter(([key]) => !known(trade[key]))) };
}
export function importIssues(trades) {
  const issues = [], ids = new Set(), symbols = new Set(), accounts = new Set();
  if (!trades.length) issues.push('请先读取交易记录。');
  if (trades.length > 500) issues.push('每次最多导入 500 笔成交。');
  const seen = new Set();
  trades.forEach((trade, i) => {
    const missing = missingTradeFields(trade);
    if (missing.length) issues.push(`第 ${i + 1} 笔待补充：${missing.join('、')}。`);
    if (trade.price !== null && (!Number.isFinite(trade.price) || trade.price <= 0)) issues.push(`第 ${i + 1} 笔的成交价无效，可以留空待补充。`);
    if (trade.fee !== null && (!Number.isFinite(trade.fee) || trade.fee < 0)) issues.push(`第 ${i + 1} 笔的费用无效，可以留空待补充。`);
    if (!trade.id?.trim()) issues.push(`第 ${i + 1} 笔的交易编号待补充。`);
    if (ids.has(trade.id)) issues.push(`第 ${i + 1} 笔的交易编号重复。`);
    ids.add(trade.id); if (trade.symbol) symbols.add(trade.symbol); if (trade.accountId) accounts.add(trade.accountId);
    if (/^(?:DEMO(?:[-\d]|$)|sample[-_])/i.test(trade.id || '') || /^(?:DEMO(?:[-\d]|$)|sample[-_])/i.test(trade.symbol || '')) issues.push(`第 ${i + 1} 笔使用了历史构造数据标识，请导入真实成交记录。`);
    const signature = JSON.stringify(['symbol', 'time', 'side', 'quantity', 'price', 'fee'].map(key => trade[key]));
    if (seen.has(signature)) issues.push(`第 ${i + 1} 笔与其他成交内容重复，请核对后删除重复记录。`);
    seen.add(signature);
    Object.entries(metadataFields).forEach(([key, supported]) => {
      if (!Object.hasOwn(trade, key)) return;
      if (!known(trade[key])) issues.push(`第 ${i + 1} 笔的${metadataLabels[key]}待确认。`);
      else if (!supported.some(value => value.toLowerCase() === String(trade[key]).toLowerCase())) issues.push(`第 ${i + 1} 笔的${metadataLabels[key]}为 ${trade[key]}，当前复盘暂不支持，记录已保留待核对。`);
    });
    if (known(trade.feeCurrency) && !metadataFields.currency.some(value => value.toLowerCase() === String(trade.feeCurrency).toLowerCase())) issues.push(`第 ${i + 1} 笔的费用币种为 ${trade.feeCurrency}，需单独核对。`);
    if (trade.fee != null && Object.hasOwn(trade, 'feeCurrency') && !known(trade.feeCurrency)) issues.push(`第 ${i + 1} 笔的费用币种待确认。`);
    if (/^(?:US|USA|NYSE|NASDAQ|HK|HKEX|SEHK|OKX|BINANCE|CRYPTO|美股|港股|加密货币)$/i.test(clean(trade.market))) issues.push(`第 ${i + 1} 笔的交易市场为 ${trade.market}，当前复盘暂不支持，记录已保留待核对。`);
    if ((trade.leverage != null && trade.leverage !== 1) || trade.margin === true || trade.positionSide === 'short') issues.push(`第 ${i + 1} 笔包含杠杆、保证金或空头信息，当前复盘暂不支持。`);
  });
  if (symbols.size > 1) issues.push('本次请保留一个标的，其他标的可以另建复盘。');
  if (accounts.size > 1 || (accounts.size && trades.some(trade => !clean(trade.accountId)))) issues.push('本次请保留一个明确的账户，其他账户可以另建复盘。');
  return issues;
}
export function editedTrade(draft) {
  return { ...draft, id: clean(draft.id), name: clean(draft.name), symbol: clean(draft.symbol), quantity: draft.quantity === '' || draft.quantity == null ? null : Number(draft.quantity), price: draft.price === '' || draft.price == null ? null : Number(draft.price), fee: draft.fee === '' || draft.fee == null ? null : Number(draft.fee) };
}

export function importGroups(trades) {
  const groups = new Map();
  trades.forEach((trade, index) => {
    const key = JSON.stringify([clean(trade.accountId), clean(trade.symbol) || clean(trade.name)]);
    if (!groups.has(key)) groups.set(key, { key, name: clean(trade.name) || clean(trade.symbol) || '待确认标的', account: clean(trade.accountId), indices: [], trades: [] });
    const group = groups.get(key); group.indices.push(index); group.trades.push(trade);
  });
  return [...groups.values()];
}

// IDs are included in refinement requests. Keep unmatched records and any row
// that the user has edited; model output cannot silently erase either.
export function mergeImportCandidates(previous, incoming, editedIds = []) {
  const locked = new Set(editedIds), used = new Set();
  const merged = previous.map(trade => {
    const index = incoming.findIndex((candidate, at) => !used.has(at) && candidate.id === trade.id);
    const replacement = incoming[index]; if (index >= 0) used.add(index);
    return locked.has(trade.id) || !replacement ? trade : { ...trade, ...replacement };
  });
  return [...merged, ...incoming.filter((_, index) => !used.has(index))];
}

export function identifyImportCandidates(trades) {
  return trades.map((trade, index) => {
    if (clean(trade.id)) return trade;
    let hash = 2166136261;
    const text = JSON.stringify(trade);
    for (let i = 0; i < text.length; i++) { hash ^= text.charCodeAt(i); hash = Math.imul(hash, 16777619); }
    return { ...trade, id: `import-row-${(hash >>> 0).toString(36)}-${index + 1}` };
  });
}

export function acceptedImportTrades(trades) {
  return trades.map(trade => {
    const result = { ...trade };
    for (const field of ['accountId', 'market', 'leverage', 'margin', 'positionSide']) if (result[field] == null || result[field] === '') delete result[field];
    if (result.fee == null && !known(result.feeCurrency)) delete result.feeCurrency;
    for (const [field, supported] of Object.entries(metadataFields)) if (known(result[field]) && supported.some(value => value.toLowerCase() === String(result[field]).toLowerCase())) result[field] = supported[0];
    if (known(result.feeCurrency) && metadataFields.currency.some(value => value.toLowerCase() === String(result.feeCurrency).toLowerCase())) result.feeCurrency = 'CNY';
    return result;
  });
}

export function tradesToCsv(trades) {
  const keys = ['id', 'symbol', 'name', 'time', 'side', 'quantity', 'price', 'fee', 'accountId', 'currency', 'feeCurrency', 'assetType', 'quantityUnit', 'market', 'leverage', 'margin', 'positionSide'];
  const cell = value => {
    let text = value == null ? '' : String(value);
    if (/^[\s\uFEFF]*[=+@\-]/.test(text) || /^[\t\r\n]/.test(text)) text = `'${text}`;
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return `${keys.join(',')}\r\n${trades.map(trade => keys.map(key => cell(trade[key])).join(',')).join('\r\n')}\r\n`;
}
export function accountCandidates(result) {
  if (result?.currency !== 'CNY' || result?.quantityUnit !== 'share' || result?.assetType !== 'stock') throw new Error('账户接口需返回人民币股票成交，数量单位为股。');
  if (!Array.isArray(result.trades) || !result.trades.length) throw new Error('接口没有返回可核对的成交。');
  if (result.trades.some(trade => !trade || ['id', 'name', 'symbol', 'time', 'side', 'quantity', 'price', 'fee'].some(field => !Object.hasOwn(trade, field)) || typeof trade.id !== 'string' || !trade.id.trim())) throw new Error('接口成交字段不完整，请检查标准 JSON 格式。');
  return prepareTradeCandidates(result).map((trade, index) => ({ ...trade, currency: 'CNY', assetType: 'stock', quantityUnit: 'share', ...(result.trades[index].accountId ? { accountId: result.trades[index].accountId } : {}) }));
}
