import Papa from 'papaparse';

export const TRADE_FILE_LIMITS = Object.freeze({ bytes: 20 * 1024 * 1024, text: 60000, pdfPages: 20, images: 4, imageBytes: 1024 * 1024, allImageBytes: 3 * 1024 * 1024 });

export class TradeFileError extends Error {
  constructor(code, message) { super(message); this.name = 'TradeFileError'; this.code = code; }
}
const fail = (code, message) => { throw new TradeFileError(code, message); };
const abort = signal => { if (signal?.aborted) throw new DOMException('已停止读取', 'AbortError'); };
const clean = value => value == null ? '' : String(value).trim();
const headerKey = value => clean(value).toLowerCase().replace(/[\s_\-()/（）:：]/g, '');
const ALIASES = {
  id: ['id', 'tradeid', 'executionid', 'fillid', '成交编号', '成交序号', '流水号', '交易编号', '成交合同号'],
  symbol: ['symbol', 'ticker', 'code', 'instrument', 'instrumentid', 'instid', '证券代码', '股票代码', '交易代码', '标的代码', '代码', '交易对'],
  name: ['name', 'securityname', 'instrumentname', '证券名称', '股票名称', '标的名称', '名称'],
  time: ['time', 'datetime', 'timestamp', 'tradetime', 'executiontime', 'filltime', '成交时间', '交易时间', '成交日期时间'],
  date: ['date', 'tradedate', '成交日期', '交易日期', '日期'],
  side: ['side', 'direction', 'buysell', '买卖标志', '买卖方向', '买卖', '方向', '交易方向', '操作', '业务名称', '成交类别'],
  quantity: ['quantity', 'qty', 'size', 'volume', 'shares', '数量', '成交数量', '成交股数', '成交量'],
  price: ['price', 'fillprice', 'executionprice', '成交价', '成交价格', '价格', '均价', '成交均价'],
  fee: ['fee', 'fees', 'totalfee', 'transactionfee', '费用', '总费用', '交易费用', '手续费', '成交费用'],
  accountId: ['accountid', 'account', 'accountname', '账户', '账号', '账户编号', '资金账号', '资金帐号', '证券账户'],
  currency: ['currency', 'ccy', 'quoteccy', '币种', '货币', '结算币种'],
  assetType: ['assettype', 'markettype', '资产类型', '产品类型', '证券类型'],
  quantityUnit: ['quantityunit', 'unit', '数量单位', '交易单位', '单位'],
  market: ['market', 'exchange', '市场', '交易市场', '交易所'],
  feeCurrency: ['feecurrency', 'feeccy', '费用币种', '手续费币种'],
  status: ['status', 'state', 'orderstatus', '状态', '交易状态', '成交状态', '委托状态', '订单状态'],
  positionSide: ['positionside', 'posside', '持仓方向', '仓位方向'],
  tradeMode: ['trademode', 'tdmode', 'marginmode', '交易模式', '保证金模式', '账户模式'],
  leverage: ['leverage', 'lever', '杠杆', '杠杆倍数'],
  margin: ['margin', 'ismargin', '融资', '融资融券', '是否融资', '是否杠杆交易'],
};
const fieldByHeader = new Map(Object.entries(ALIASES).flatMap(([field, aliases]) => aliases.map(alias => [headerKey(alias), field])));
const fieldFor = key => fieldByHeader.get(headerKey(key));
const amountCurrency = value => /€/.test(clean(value)) ? 'EUR' : /£/.test(clean(value)) ? 'GBP' : /￥|元/.test(clean(value)) ? 'CNY' : /[$¥]/.test(clean(value)) ? 'unknown' : null;
const filledStatus = value => ['filled', 'executed', '成交', '已成交', '全部成交', '完全成交'].includes(clean(value).toLowerCase());

function decimal(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = clean(value).replace(/[￥¥$€£]/g, '').replace(/(?:元|股|份)$/, '').trim();
  if (!/^[+-]?(?:\d+|\d{1,3}(?:[,，]\d{3})+)(?:\.\d+)?$/.test(text)) return null;
  const number = Number(text.replace(/[,，]/g, ''));
  return Number.isFinite(number) ? number : null;
}

function dateTime(value, date) {
  let text = clean(value), day = clean(date);
  if (!text && /\d[ T]\d{1,2}:\d{2}/.test(day)) text = day;
  // Numeric epochs and dates without an explicit year/time stay unknown.
  if (/^\d{8}$/.test(day)) day = `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6)}`;
  if (/^\d{6}$/.test(text)) text = `${text.slice(0, 2)}:${text.slice(2, 4)}:${text.slice(4)}`;
  if (day && /^\d{1,2}:\d{2}(?::\d{2})?$/.test(text)) text = `${day} ${text}`;
  text = text.replace(/[年/]/g, '-').replace(/月/g, '-').replace(/日/g, '').trim();
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})[T\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(text);
  if (!match) return null;
  const [, year, month, dayNumber, hour, minute, second = '00'] = match;
  const [y, m, d, h, min, s] = [year, month, dayNumber, hour, minute, second].map(Number);
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (y < 1 || m < 1 || m > 12 || d < 1 || d > days[m - 1] || h > 23 || min > 59 || s > 59) return null;
  return `${year}-${month.padStart(2, '0')}-${dayNumber.padStart(2, '0')}T${hour.padStart(2, '0')}:${minute}${s ? `:${second}` : ''}`;
}

function stableHash(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) { hash ^= text.charCodeAt(i); hash = Math.imul(hash, 16777619); }
  return (hash >>> 0).toString(36);
}

/** Rows are candidates, not validated executions. Unknown values remain null. */
export function normalizeTradeRows(rows) {
  if (!Array.isArray(rows)) return [];
  const ids = new Set();
  return rows.map(raw => {
    const fields = {};
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [key, value] of Object.entries(raw)) {
        const field = fieldFor(key);
        // Conflicting duplicate aliases stay unresolved rather than choosing a value.
        if (field) fields[field] = Object.hasOwn(fields, field) && clean(fields[field]) !== clean(value) ? null : value;
      }
    }
    const direction = clean(fields.side).toLowerCase();
    const candidate = {
      id: clean(fields.id) || `import-${stableHash(JSON.stringify(raw))}`,
      symbol: clean(fields.symbol).replace(/^="([\w.-]+)"$/, '$1').replace(/^'(?=\d)/, '') || null,
      name: clean(fields.name) || null,
      time: dateTime(fields.time, fields.date),
      side: ['buy', 'b', '买', '买入', '证券买入', '普通买入', '买入成交'].includes(direction) ? 'buy' : ['sell', 's', '卖', '卖出', '证券卖出', '普通卖出', '卖出成交'].includes(direction) ? 'sell' : null,
      quantity: decimal(fields.quantity), price: decimal(fields.price), fee: decimal(fields.fee),
      currency: null, assetType: null, quantityUnit: null,
    };
    for (const key of ['accountId', 'currency', 'assetType', 'quantityUnit', 'market', 'feeCurrency', 'status', 'positionSide', 'tradeMode']) if (Object.hasOwn(fields, key)) candidate[key] = clean(fields[key]) || null;
    if (Object.hasOwn(fields, 'leverage')) candidate.leverage = decimal(clean(fields.leverage).replace(/[x倍]$/i, ''));
    const margin = clean(fields.margin).toLowerCase(), mode = clean(fields.tradeMode).toLowerCase();
    if (Object.hasOwn(fields, 'margin')) candidate.margin = ['true', '1', 'yes', '是', '融资', '融资融券'].includes(margin) ? true : ['false', '0', 'no', '否'].includes(margin) ? false : null;
    if (!Object.hasOwn(candidate, 'margin') && ['cross', 'isolated', 'margin', '全仓', '逐仓', '融资'].includes(mode)) candidate.margin = true;
    const priceCurrency = amountCurrency(fields.price), feeCurrency = amountCurrency(fields.fee);
    const canonicalCurrency = value => ['cny', 'rmb', '人民币'].includes(String(value).toLowerCase()) ? 'CNY' : String(value).toUpperCase();
    if (candidate.currency && priceCurrency && priceCurrency !== 'unknown' && canonicalCurrency(candidate.currency) !== priceCurrency) candidate.currency = 'unknown';
    if (candidate.feeCurrency && feeCurrency && feeCurrency !== 'unknown' && canonicalCurrency(candidate.feeCurrency) !== feeCurrency) candidate.feeCurrency = 'unknown';
    if (!candidate.currency && priceCurrency) candidate.currency = priceCurrency;
    if (!candidate.feeCurrency && feeCurrency) candidate.feeCurrency = feeCurrency;
    if (candidate.currency && ['cny', 'rmb', '人民币'].includes(candidate.currency.toLowerCase())) candidate.currency = 'CNY';
    if (candidate.assetType && ['stock', 'equity', '股票'].includes(candidate.assetType.toLowerCase())) candidate.assetType = 'stock';
    if (candidate.quantityUnit && ['share', 'shares', '股'].includes(candidate.quantityUnit.toLowerCase())) candidate.quantityUnit = 'share';
    const baseId = candidate.id; let occurrence = 1;
    while (ids.has(candidate.id)) candidate.id = `${baseId}-${++occurrence}`;
    ids.add(candidate.id);
    return candidate;
  });
}

function tableRows(matrix, warnings, label = '表格') {
  const headerIndex = matrix.findIndex(row => {
    const fields = new Set(row.map(fieldFor).filter(Boolean));
    return fields.size >= 2 && ['symbol', 'side', 'quantity', 'price', 'time'].some(field => fields.has(field));
  });
  if (headerIndex < 0) return [];
  const headers = matrix[headerIndex].map(clean);
  const named = headers.filter(Boolean);
  if (new Set(named.map(headerKey)).size !== named.length) { warnings.push(`${label}含重复列名，已保留原文，需进一步识别。`); return []; }
  if (headerIndex) warnings.push(`${label}的表头前有 ${headerIndex} 行说明，已保留在原文中。`);
  return matrix.slice(headerIndex + 1).filter(row => row.some(value => clean(value))).map(row => {
    if (row.length > headers.length && row.slice(headers.length).some(value => clean(value))) warnings.push(`${label}有超出表头的内容，已保留原文，请核对。`);
    return Object.fromEntries(headers.map((header, index) => [header || `未命名列${index + 1}`, row[index] ?? '']));
  });
}

function delimitedRows(text, warnings) {
  const result = Papa.parse(text, { skipEmptyLines: 'greedy', dynamicTyping: false });
  const errors = result.errors.filter(error => error.code !== 'UndetectableDelimiter');
  if (errors.length) { warnings.push('文本中的表格分隔不完整，已保留原文，需进一步识别。'); return []; }
  return tableRows(result.data, warnings);
}

function jsonRows(value, warnings) {
  if (Array.isArray(value)) {
    if (value.every(row => Array.isArray(row))) return tableRows(value, warnings);
    return value;
  }
  if (!value || typeof value !== 'object') return [];
  for (const key of ['trades', 'executions', 'fills', 'records', 'data', 'items']) {
    if (Array.isArray(value[key])) {
      const metadata = Object.fromEntries(Object.entries(value).filter(([name]) => ['accountId', 'currency', 'assetType', 'quantityUnit', 'market', 'feeCurrency', 'positionSide', 'tradeMode', 'leverage', 'margin'].includes(fieldFor(name))));
      return value[key].map(row => row && typeof row === 'object' && !Array.isArray(row) ? { ...metadata, ...row } : row);
    }
    if (value[key] && typeof value[key] === 'object') { const rows = jsonRows(value[key], warnings); if (rows.length) return rows; }
  }
  return Object.keys(value).filter(key => fieldFor(key)).length >= 2 ? [value] : [];
}

function checkText(text) {
  if (text.length > TRADE_FILE_LIMITS.text) fail('TEXT_LIMIT', `文件文字共有 ${text.length.toLocaleString()} 个字符，超过单次 60,000 个字符。请按日期或账户拆分文件后重新导入。`);
  return text;
}

function decodeText(buffer, warnings) {
  const bytes = new Uint8Array(buffer);
  const encoding = bytes[0] === 255 && bytes[1] === 254 ? 'utf-16le' : bytes[0] === 254 && bytes[1] === 255 ? 'utf-16be' : 'utf-8';
  try { return new TextDecoder(encoding, { fatal: true }).decode(bytes).replace(/^\uFEFF/, ''); }
  catch {
    try { const text = new TextDecoder('gb18030', { fatal: true }).decode(bytes); warnings.push('已按 GB18030 编码读取，请核对证券名称。'); return text; }
    catch { fail('ENCODING', '无法识别文件的文字编码。请重新导出文件，或上传清晰截图。'); }
  }
}

function checkZipBudget(buffer, extension) {
  const data = new DataView(buffer);
  if (data.byteLength < 4 || data.getUint32(0, true) !== 0x04034b50) {
    if (extension === 'docx' && data.byteLength >= 8 && data.getUint32(0, true) === 0xe011cfd0) fail('ENCRYPTED', 'Word 文档已加密，请先解锁并另存一份后导入。');
    return;
  }
  let end = -1;
  for (let offset = data.byteLength - 22; offset >= Math.max(0, data.byteLength - 65557); offset--) {
    if (data.getUint32(offset, true) === 0x06054b50 && offset + 22 + data.getUint16(offset + 20, true) === data.byteLength) { end = offset; break; }
  }
  if (end < 0) fail('CORRUPT', '文件压缩目录不完整，文件可能损坏。请重新导出。');
  const entries = data.getUint16(end + 10, true), start = data.getUint32(end + 16, true);
  if (entries > 2000 || start === 0xffffffff) fail('ARCHIVE_LIMIT', '文档内部文件过多或使用超大压缩格式，请按日期拆分后重新导入。');
  let total = 0, offset = start;
  for (let index = 0; index < entries; index++) {
    if (offset + 46 > end || data.getUint32(offset, true) !== 0x02014b50) fail('CORRUPT', '文件压缩目录损坏，请重新导出。');
    if (data.getUint16(offset + 8, true) & 1) fail('ENCRYPTED', '文件已加密，请先解锁后导入。');
    total += data.getUint32(offset + 24, true);
    if (total > 40 * 1024 * 1024) fail('ARCHIVE_LIMIT', '文档解压后的内容超过 40 MB，请移除无关图片或按日期拆分后导入。');
    offset += 46 + data.getUint16(offset + 28, true) + data.getUint16(offset + 30, true) + data.getUint16(offset + 32, true);
  }
}

function htmlRows(text, warnings) {
  if (typeof document === 'undefined') fail('BROWSER_REQUIRED', '请在浏览器中读取此文件。');
  // Template content remains inert: no scripts, event handlers, or remote resources run.
  const template = document.createElement('template'); template.innerHTML = text;
  const root = template.content;
  root.querySelectorAll('script,style,noscript,iframe,object,embed').forEach(node => node.remove());
  const rows = [...root.querySelectorAll('table')].flatMap((table, index) => tableRows([...table.querySelectorAll('tr')].map(row => [...row.querySelectorAll('th,td')].map(cell => cell.textContent.trim())), warnings, `第 ${index + 1} 个表格`));
  // Keep line/cell boundaries for model reading, without ever rendering supplied markup.
  root.querySelectorAll('br').forEach(node => node.replaceWith('\n'));
  root.querySelectorAll('td,th').forEach(node => node.append('\t'));
  root.querySelectorAll('tr,p,div,li,h1,h2,h3').forEach(node => node.append('\n'));
  return { text: checkText(root.textContent.trim()), rows };
}

async function spreadsheet(buffer, warnings) {
  const XLSX = await import('xlsx');
  const codes = await import('xlsx/dist/cpexcel.full.mjs');
  XLSX.set_cptable(codes);
  let book;
  try { book = XLSX.read(buffer, { type: 'array', cellNF: true, cellText: true }); }
  catch (error) {
    if (/password|encrypt/i.test(error.message)) fail('ENCRYPTED', '表格已加密，请先解锁并另存一份后导入。');
    fail('CORRUPT', '表格无法读取，文件可能损坏或扩展名与内容不匹配。请重新导出。');
  }
  let text = ''; const rows = [];
  for (const sheetName of book.SheetNames) {
    const sheet = book.Sheets[sheetName];
    if (!sheet['!ref']) continue;
    const range = XLSX.utils.decode_range(sheet['!ref']);
    if ((range.e.r - range.s.r + 1) * (range.e.c - range.s.c + 1) > 100000) fail('SHEET_LIMIT', `工作表「${sheetName}」范围过大，请删除空白格式区域或按日期拆分后导入。`);
    const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '', blankrows: true });
    // Keep displayed identifiers (including zero padding). A formatted Excel serial
    // supplies its year even when the display uses a short date; plain numbers do not.
    for (let r = range.s.r; r <= range.e.r; r++) for (let c = range.s.c; c <= range.e.c; c++) {
      const cell = sheet[XLSX.utils.encode_cell({ r, c })];
      if (cell?.t !== 'n' || !cell.z || !XLSX.SSF.is_date(cell.z)) continue;
      const parsed = XLSX.SSF.parse_date_code(cell.v, { date1904: Boolean(book.Workbook?.WBProps?.date1904) });
      if (!parsed) continue;
      const format = cell.z.replace(/"[^"]*"|\[[^\]]*\]/g, '').toLowerCase();
      const date = `${String(parsed.y).padStart(4, '0')}-${String(parsed.m).padStart(2, '0')}-${String(parsed.d).padStart(2, '0')}`;
      const time = `${String(parsed.H).padStart(2, '0')}:${String(parsed.M).padStart(2, '0')}:${String(Math.floor(parsed.S)).padStart(2, '0')}`;
      const hasDate = /[yd]/.test(format), hasTime = /[hs]/.test(format);
      if (hasDate || hasTime) matrix[r - range.s.r][c - range.s.c] = hasDate ? `${date}${hasTime ? ` ${time}` : ''}` : time;
    }
    text += `${text ? '\n\n' : ''}工作表：${sheetName}\n${Papa.unparse(matrix, { delimiter: '\t', newline: '\n' })}`;
    checkText(text);
    rows.push(...tableRows(matrix, warnings, `工作表「${sheetName}」`));
  }
  if (!text.trim()) fail('EMPTY', '表格中没有可读取的内容。');
  return { text, rows };
}

async function canvasImage(canvas, maxBytes, signal) {
  abort(signal);
  if (!canvas.width || !canvas.height) fail('CORRUPT', '图片没有可读取的尺寸。');
  const maxEdge = 2400; let factor = Math.min(1, maxEdge / Math.max(canvas.width, canvas.height));
  for (let pass = 0; pass < 4; pass++) {
    const output = document.createElement('canvas'); output.width = Math.max(1, Math.round(canvas.width * factor)); output.height = Math.max(1, Math.round(canvas.height * factor));
    const context = output.getContext('2d');
    if (!context) fail('IMAGE_RENDER', '浏览器暂时无法处理图片，请重新打开页面后再试。');
    context.fillStyle = '#fff'; context.fillRect(0, 0, output.width, output.height); context.drawImage(canvas, 0, 0, output.width, output.height);
    for (const quality of [0.9, 0.82, 0.74]) {
      abort(signal);
      const data = output.toDataURL('image/jpeg', quality).split(',')[1];
      if (data?.length <= maxBytes) return { data, mimeType: 'image/jpeg' };
    }
    if (Math.max(output.width, output.height) <= 1400) break;
    factor *= 0.8;
  }
  fail('IMAGE_LIMIT', '图片内容过密，压缩后仍超出识别上限。请裁剪交易区域或拆成几张清晰截图后导入。');
}

async function imageFile(file, signal) {
  let bitmap;
  try { bitmap = await createImageBitmap(file); }
  catch { fail('CORRUPT', '图片无法读取，文件可能损坏。请重新保存为 PNG、JPEG 或 WebP 后导入。'); }
  try {
    if (bitmap.width * bitmap.height > 60000000) fail('IMAGE_DIMENSIONS', '图片分辨率过高，请裁剪交易区域后重新导入。');
    const factor = Math.min(1, 2400 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas'); canvas.width = Math.round(bitmap.width * factor); canvas.height = Math.round(bitmap.height * factor);
    const context = canvas.getContext('2d'); if (!context) fail('IMAGE_RENDER', '浏览器暂时无法处理图片，请重试。');
    context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return await canvasImage(canvas, TRADE_FILE_LIMITS.imageBytes, signal);
  } finally { bitmap.close(); }
}

async function pdfFile(buffer, signal, onProgress) {
  const pdfjs = await import('pdfjs-dist/build/pdf.mjs');
  const { default: worker } = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
  pdfjs.GlobalWorkerOptions.workerSrc = worker;
  const task = pdfjs.getDocument({ data: new Uint8Array(buffer), isEvalSupported: false, useSystemFonts: true });
  const stop = () => { void task.destroy(); }; signal?.addEventListener('abort', stop, { once: true });
  try {
    const pdf = await task.promise;
    if (pdf.numPages > TRADE_FILE_LIMITS.pdfPages) fail('PDF_PAGES', `PDF 共 ${pdf.numPages} 页，单次最多读取 20 页。请按页拆分后导入。`);
    let text = ''; const imagePages = [];
    const imageOps = new Set([pdfjs.OPS.paintImageXObject, pdfjs.OPS.paintInlineImageXObject, pdfjs.OPS.paintImageMaskXObject, pdfjs.OPS.paintImageXObjectRepeat]);
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      abort(signal); onProgress(`正在读取 PDF 第 ${pageNumber} / ${pdf.numPages} 页…`);
      const page = await pdf.getPage(pageNumber), content = await page.getTextContent();
      const pageText = content.items.map(item => `${item.str || ''}${item.hasEOL ? '\n' : ' '}`).join('').trim();
      text += `${text ? '\n\n' : ''}第 ${pageNumber} 页\n${pageText}`; checkText(text);
      const operators = await page.getOperatorList();
      if (!pageText || operators.fnArray.some(op => imageOps.has(op))) imagePages.push(pageNumber);
      page.cleanup();
    }
    if (imagePages.length > TRADE_FILE_LIMITS.images) fail('PDF_IMAGE_PAGES', `PDF 中有 ${imagePages.length} 页包含扫描或图片内容，单次最多识别 4 页。请将这些页面拆分后导入。`);
    const images = [];
    const imageLimit = Math.min(TRADE_FILE_LIMITS.imageBytes, Math.floor(TRADE_FILE_LIMITS.allImageBytes / Math.max(1, imagePages.length)));
    for (const pageNumber of imagePages) {
      abort(signal); onProgress(`正在处理 PDF 第 ${pageNumber} 页的图片…`);
      const page = await pdf.getPage(pageNumber), initial = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: Math.min(2.5, 2400 / Math.max(initial.width, initial.height)) });
      const canvas = document.createElement('canvas'); canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
      const render = page.render({ canvasContext: canvas.getContext('2d'), viewport });
      const cancel = () => render.cancel(); signal?.addEventListener('abort', cancel, { once: true });
      try { await render.promise; } finally { signal?.removeEventListener('abort', cancel); }
      images.push(await canvasImage(canvas, imageLimit, signal)); page.cleanup();
    }
    return { text, images };
  } catch (error) {
    abort(signal);
    if (error instanceof TradeFileError) throw error;
    if (error.name === 'PasswordException') fail('ENCRYPTED', 'PDF 已加密，请先解锁并另存一份后导入。');
    if (/worker|dynamically imported|fetch|network/i.test(error.message || '')) fail('PDF_RUNTIME', 'PDF 读取组件暂时无法加载。请检查连接并刷新页面后重试，或直接上传交易截图。');
    fail('CORRUPT', 'PDF 无法完整读取，文件可能损坏。请重新导出 PDF 或上传交易截图。');
  } finally { signal?.removeEventListener('abort', stop); await task.destroy(); }
}

export async function readTradeFile(file, { signal, onProgress = () => {} } = {}) {
  abort(signal);
  if (!file || typeof file.arrayBuffer !== 'function') fail('NO_FILE', '请选择要导入的交易文件。');
  if (!file.size) fail('EMPTY', '文件为空，请选择含有交易记录的文件。');
  if (file.size > TRADE_FILE_LIMITS.bytes) fail('FILE_LIMIT', '文件超过 20 MB，请按日期或账户拆分后导入。');
  const fileName = file.name || '交易文件', extension = fileName.split('.').pop().toLowerCase();
  onProgress('正在读取文件…');
  const warnings = []; let text = '', images = [], rows = [], marketData;
  if (['png', 'jpg', 'jpeg', 'webp'].includes(extension) || /^image\/(png|jpeg|webp)$/.test(file.type)) {
    images = [await imageFile(file, signal)];
  } else {
    const buffer = await file.arrayBuffer(); abort(signal);
    if (['xlsx', 'xlsm', 'xlsb', 'ods', 'docx'].includes(extension)) checkZipBudget(buffer, extension);
    if (extension === 'pdf' || file.type === 'application/pdf') ({ text, images } = await pdfFile(buffer, signal, onProgress));
    else if (['xlsx', 'xls', 'xlsm', 'xlsb', 'ods'].includes(extension)) ({ text, rows } = await spreadsheet(buffer, warnings));
    else if (extension === 'docx') {
      onProgress('正在读取 Word 文档…');
      const loaded = await import('mammoth/mammoth.browser.js'); const mammoth = loaded.default || loaded;
      try { const result = await mammoth.extractRawText({ arrayBuffer: buffer }); text = checkText(result.value); }
      catch (error) { if (error instanceof TradeFileError) throw error; fail('CORRUPT', 'Word 文档无法读取，可能已加密或损坏。请解锁后重新导出 DOCX 或 PDF。'); }
      warnings.push('已读取 Word 中的文字；文档内嵌的交易截图请另行上传。');
    } else {
      const bytes = new Uint8Array(buffer);
      const isUtf16 = (bytes[0] === 255 && bytes[1] === 254) || (bytes[0] === 254 && bytes[1] === 255);
      if (!isUtf16 && bytes.subarray(0, 4096).some(byte => byte === 0)) fail('UNSUPPORTED', '暂时无法读取这个文件格式。可上传原始表格、PDF、Word 文档或交易截图。');
      text = decodeText(buffer, warnings);
      if (/^[\s\uFEFF]*[\[{]/.test(text) || extension === 'json') {
        let value; try { value = JSON.parse(text); } catch { fail('CORRUPT', 'JSON 文件内容不完整或格式损坏，请重新导出。'); }
        if (value?.format === 'huikan-review-bundle') {
          if (value.version !== 1 || !Array.isArray(value.trades) || !value.marketData || typeof value.marketData !== 'object' || Array.isArray(value.marketData)) fail('BUNDLE_FORMAT', '复盘资料包格式无效，请使用 version 1，并提供 trades 数组和 marketData 对象。');
          marketData = value.marketData;
          // Market points are validated by the review backend and never become an
          // AI extraction prompt. The text budget applies to the execution source.
          text = `复盘资料：${fileName}\n${JSON.stringify({ ...Object.fromEntries(Object.entries(value).filter(([key]) => ['accountId', 'currency', 'assetType', 'quantityUnit', 'market'].includes(key))), trades: value.trades })}`;
        }
        checkText(text);
        rows = jsonRows(value, warnings);
      } else if (/^\s*(?:<!doctype\s+html|<html|<table)/i.test(text) || ['html', 'htm'].includes(extension)) ({ text, rows } = htmlRows(text, warnings));
      else { checkText(text); rows = delimitedRows(text, warnings); }
    }
  }
  abort(signal);
  if (!text.trim() && !images.length) fail('EMPTY', '文件中没有可读取的文字或交易图片。');
  let trades = normalizeTradeRows(rows);
  // The original product's exact eight-column CSV is an established CNY/share
  // contract. Other source formats keep unknown market metadata explicit.
  const legacyFields = ['id', 'symbol', 'name', 'time', 'side', 'quantity', 'price', 'fee'];
  if (extension === 'csv' && rows.length && rows.every(row => row && Object.keys(row).length === 8 && legacyFields.every(key => Object.hasOwn(row, key)))) {
    for (const trade of trades) for (const key of ['currency', 'assetType', 'quantityUnit']) if (trade[key] == null) delete trade[key];
  }
  if (trades.some(trade => trade.currency === 'unknown' || trade.feeCurrency === 'unknown')) warnings.push('金额含未明确的货币符号，请核对价格和费用的币种。');
  if (trades.some(trade => trade.feeCurrency && trade.currency && trade.feeCurrency !== trade.currency)) warnings.push('交易费用与成交价格的币种不同，请分别核对。');
  if (trades.some(trade => trade.status && !filledStatus(trade.status)) || (/委托|订单/.test(fileName) && !/成交/.test(fileName) && !trades.every(trade => filledStatus(trade.status)))) {
    warnings.push('文件包含委托、订单或未确认成交的状态，已保留全部原文，需要核对实际成交后再导入。'); trades = [];
  }
  return { fileName, text, images, trades, warnings: [...new Set(warnings)], ...(marketData ? { marketData } : {}) };
}
