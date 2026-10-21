import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import JSZip from 'jszip';
import { normalizeTradeRows, readTradeFile, TradeFileError, TRADE_FILE_LIMITS } from '../src/trade-file-reader.js';

const file = (text, name = '成交.csv', type = '') => new File([text], name, { type });
const trade = { symbol: '000001', name: '测试标的', time: '2026-09-07T09:45', side: 'buy', quantity: 100, price: 40, fee: 5 };

test('Chinese export headings and separate date/time normalize without losing leading zeros', () => {
  const [result] = normalizeTradeRows([{ 证券代码: '000001', 证券名称: '测试', 成交日期: '2026/9/7', 成交时间: '09:45:00', 买卖标志: '证券买入', 成交数量: '1,200', 成交价格: '￥40.50', 交易费用: '5.20', 资金账号: '0008', 币种: '人民币', 数量单位: '股', 资产类型: '股票' }]);
  assert.equal(result.symbol, '000001'); assert.equal(result.time, '2026-09-07T09:45');
  assert.equal(result.quantity, 1200); assert.equal(result.price, 40.5); assert.equal(result.fee, 5.2);
  assert.equal(result.side, 'buy'); assert.equal(result.accountId, '0008');
  assert.equal(result.currency, 'CNY'); assert.equal(result.quantityUnit, 'share'); assert.equal(result.assetType, 'stock');
});

test('unknown year, missing cost and account are never inferred', () => {
  const [result] = normalizeTradeRows([{ symbol: 'BTC-USDT', time: '09-07 10:00', side: '买入', quantity: '2', price: '' }]);
  assert.equal(result.time, null); assert.equal(result.price, null); assert.equal(result.fee, null);
  assert.equal(Object.hasOwn(result, 'accountId'), false); assert.equal(result.currency, null);
});

test('stable IDs remain unique even when source IDs contain generated suffixes', () => {
  const rows = [{ ...trade, id: 'T' }, { ...trade, id: 'T' }, { ...trade, id: 'T-2' }, trade, trade];
  const first = normalizeTradeRows(rows), second = normalizeTradeRows(rows);
  assert.deepEqual(first, second); assert.equal(new Set(first.map(row => row.id)).size, rows.length);
});

test('invalid and unrelated rows remain explicit incomplete candidates', () => {
  const results = normalizeTradeRows([trade, { unrelated: '不能丢失' }, null, '未知行']);
  assert.equal(results.length, 4); assert.equal(results[1].symbol, null); assert.equal(results[2].quantity, null);
});

test('timestamps reject impossible dates, epochs and zone shifts; compact date is explicit', () => {
  for (const time of ['2025-02-29T10:00', '2026-09-07T25:00', '2026-09-07', 1788774300, '2026-09-07T10:00Z']) assert.equal(normalizeTradeRows([{ ...trade, time }])[0].time, null);
  assert.equal(normalizeTradeRows([{ date: '20260907', time: '094500' }])[0].time, '2026-09-07T09:45');
});

test('ambiguous aliases and malformed numbers remain unknown', () => {
  const [result] = normalizeTradeRows([{ symbol: '000001', 股票代码: '000002', quantity: '1,20', price: '1e6', fee: '未知' }]);
  assert.equal(result.symbol, null); assert.equal(result.quantity, null); assert.equal(result.price, null); assert.equal(result.fee, null);
});

test('CSV supports quoted commas and mixed instruments without scope filtering', async () => {
  const text = '证券代码,证券名称,成交日期,成交时间,方向,成交数量,成交价\n000001,测试甲,2026-09-07,09:45,买入,"1,200",40\n000002,测试乙,2026-09-08,10:00,卖出,300,42';
  const result = await readTradeFile(file(text));
  assert.equal(result.trades.length, 2); assert.equal(result.trades[0].quantity, 1200); assert.equal(result.trades[1].symbol, '000002');
  assert.equal(result.text, text); assert.equal(result.trades[0].fee, null);
});

test('TSV and plain text are accepted without requiring a CSV extension', async () => {
  const text = 'symbol\tname\ttime\tside\tquantity\tprice\n000001\t测试\t2026-09-07 09:45\tbuy\t100\t40';
  assert.equal((await readTradeFile(file(text, '成交.tsv'))).trades[0].symbol, '000001');
  const prose = '9 月 7 日买了一些股票，还需要补充年份和数量。';
  assert.equal((await readTradeFile(file(prose, '交易说明.txt'))).text, prose);
});

test('UTF-16 text reads via BOM without demanding UTF-8', async () => {
  const text = 'symbol,side\n000001,buy';
  const bytes = Buffer.concat([Buffer.from([255, 254]), Buffer.from(text, 'utf16le')]);
  const result = await readTradeFile(file(bytes)); assert.equal(result.trades[0].symbol, '000001');
});

test('JSON preserves envelope account and market metadata', async () => {
  const content = { accountId: 'A', currency: 'USD', assetType: 'stock', quantityUnit: 'share', trades: [trade, { ...trade, symbol: 'AAPL', accountId: 'B' }] };
  const result = await readTradeFile(file(JSON.stringify(content), 'export.json'));
  assert.equal(result.trades.length, 2); assert.equal(result.trades[0].currency, 'USD'); assert.equal(result.trades[0].accountId, 'A'); assert.equal(result.trades[1].accountId, 'B');
});

test('JSON malformed content has a clear corrupt-file error', async () => {
  await assert.rejects(readTradeFile(file('{"trades": [', 'broken.json')), error => error instanceof TradeFileError && error.code === 'CORRUPT');
});

test('malformed CSV remains available to AI rather than silently dropping records', async () => {
  const text = 'symbol,side\n000001,"buy';
  const result = await readTradeFile(file(text)); assert.equal(result.text, text); assert.equal(result.trades.length, 0); assert.ok(result.warnings.length);
});

test('duplicate headings do not overwrite source values', async () => {
  const text = 'symbol,side,side\n000001,buy,sell';
  const result = await readTradeFile(file(text)); assert.equal(result.text, text); assert.equal(result.trades.length, 0); assert.match(result.warnings.join(''), /重复列名/);
});

test('XLSX preserves zero-padded identifiers, real Excel date and every sheet', async () => {
  const sheet = XLSX.utils.aoa_to_sheet([['证券代码', '证券名称', '成交日期', '成交时间', '方向', '数量', '价格'], [1, '测试', 46272, 0.40625, '买入', 100, 40]]);
  sheet.A2.z = '000000'; sheet.C2.z = 'm/d/yy'; sheet.D2.z = 'hh:mm';
  const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, sheet, '账户甲'); XLSX.utils.book_append_sheet(book, sheet, '账户乙');
  const data = XLSX.write(book, { type: 'array', bookType: 'xlsx' });
  const result = await readTradeFile(file(data, 'export.xlsx'));
  assert.equal(result.trades.length, 2); assert.equal(result.trades[0].symbol, '000001');
  assert.match(result.trades[0].time, /^2026-\d{2}-\d{2}T09:45$/); assert.match(result.text, /账户甲/); assert.match(result.text, /账户乙/);
});

test('legacy XLS is supported and text limits never truncate the output', async () => {
  const sheet = XLSX.utils.json_to_sheet([trade]); const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, sheet, '成交');
  const result = await readTradeFile(file(XLSX.write(book, { type: 'array', bookType: 'biff8' }), 'export.xls'));
  assert.equal(result.trades[0].symbol, '000001');
  await assert.rejects(readTradeFile(file('a'.repeat(60001), 'long.txt')), error => error.code === 'TEXT_LIMIT');
});

test('empty, binary unsupported, oversize, and cancelled files have distinct outcomes', async () => {
  await assert.rejects(readTradeFile(file('')), error => error.code === 'EMPTY');
  await assert.rejects(readTradeFile(file(new Uint8Array([77, 90, 0, 0]), 'application.exe')), error => error.code === 'UNSUPPORTED');
  await assert.rejects(readTradeFile({ size: TRADE_FILE_LIMITS.bytes + 1, arrayBuffer() { throw new Error('must not read'); } }), error => error.code === 'FILE_LIMIT');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(readTradeFile(file('text'), { signal: controller.signal }), error => error.name === 'AbortError');
});

test('currency symbols and independent fee currency cannot disappear during number parsing', async () => {
  const content = [{ ...trade, price: '$40', fee: '€3', positionSide: 'short', tradeMode: 'cross', leverage: '3' }];
  const result = await readTradeFile(file(JSON.stringify(content), 'foreign.json'));
  assert.equal(result.trades[0].price, 40); assert.equal(result.trades[0].currency, 'unknown'); assert.equal(result.trades[0].feeCurrency, 'EUR');
  assert.equal(result.trades[0].positionSide, 'short'); assert.equal(result.trades[0].tradeMode, 'cross'); assert.equal(result.trades[0].leverage, 3); assert.equal(result.trades[0].margin, true);
  assert.match(result.warnings.join(''), /币种/);
});

test('unfilled orders are retained as source text for AI verification', async () => {
  const text = JSON.stringify([{ ...trade, status: 'cancelled' }, { ...trade, status: 'filled' }]);
  const result = await readTradeFile(file(text, 'orders.json'));
  assert.equal(result.trades.length, 0); assert.equal(result.text, text); assert.match(result.warnings.join(''), /未确认成交/);
});

test('DOCX reads plain text without rendering supplied markup', async () => {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>2026-09-07 09:45 买入测试标的 100 股，40 元。</w:t></w:r></w:p></w:body></w:document>');
  const result = await readTradeFile(file(await zip.generateAsync({ type: 'uint8array' }), 'trades.docx'));
  assert.match(result.text, /买入测试标的 100 股/); assert.match(result.warnings.join(''), /内嵌/);
});

test('compressed document expansion budget blocks an oversized archive before parsing', async () => {
  const zip = new JSZip(); zip.file('word/document.xml', 'text');
  const bytes = await zip.generateAsync({ type: 'uint8array' });
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < bytes.length - 46; i++) if (view.getUint32(i, true) === 0x02014b50) { view.setUint32(i + 24, 50 * 1024 * 1024, true); break; }
  await assert.rejects(readTradeFile(file(bytes, 'bomb.docx')), error => error.code === 'ARCHIVE_LIMIT');
});

test('exact legacy eight-column CSV keeps established compatibility; other formats require market confirmation', async () => {
  const csv = 'id,symbol,name,time,side,quantity,price,fee\nT1,000001,测试,2026-09-07T09:45,buy,100,40,5';
  const result = await readTradeFile(file(csv));
  assert.equal(Object.hasOwn(result.trades[0], 'currency'), false);
  assert.equal(normalizeTradeRows([trade])[0].currency, null);
});

test('review bundle preserves large market history separately from extraction text', async () => {
  const marketData = { symbol: '000001', bars: Array.from({ length: 6000 }, (_, index) => ({ time: 1700000000 + index * 300, open: 40, high: 41, low: 39, close: 40.5 })) };
  const content = { format: 'huikan-review-bundle', version: 1, currency: 'CNY', assetType: 'stock', quantityUnit: 'share', trades: [trade], marketData };
  const result = await readTradeFile(file(JSON.stringify(content), 'review.json'));
  assert.equal(result.marketData.bars.length, 6000); assert.deepEqual(result.marketData, marketData);
  assert.ok(result.text.length < 1000); assert.equal(result.text.includes('1700000000'), false); assert.equal(result.trades[0].currency, 'CNY');
});

test('review bundle version and structure are checked before keeping market data', async () => {
  const content = { format: 'huikan-review-bundle', version: 2, trades: [trade], marketData: {} };
  await assert.rejects(readTradeFile(file(JSON.stringify(content), 'review.json')), error => error.code === 'BUNDLE_FORMAT');
});
