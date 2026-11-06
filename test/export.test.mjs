// The report the shop files, against REAL Postgres.
//
// This one gets printed and handed to an accountant, so it is checked by
// building the actual spreadsheet and reading the cells back out — not by
// looking at the SQL and hoping. What matters: the day's takings under each
// day, the period summarised at the top, every line's money in the column
// of the machine that took it, and the whole thing scoped to one shop.
import { PGlite } from '@electric-sql/pglite';
import ExcelJS from 'exceljs';
import fs from 'fs';
import { createRequire } from 'module';

// The handler requires exceljs the way the server does, so it needs a real
// CommonJS require rather than a promise-returning stand-in.
const requireCJS = createRequire(import.meta.url);

const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : '  — ' + detail}`);
  if (!ok) failures++;
};
const grab = (decl, end) => {
  const a = src.indexOf(decl);
  const b = src.indexOf(end, a);
  if (a < 0 || b < 0) throw new Error('could not extract ' + decl);
  return src.slice(a, b + end.length);
};

const db = new PGlite();
await db.exec(`
  CREATE TABLE shops (id SERIAL PRIMARY KEY, business_id INT, name TEXT, code TEXT);
  CREATE TABLE stock_items (
    id SERIAL PRIMARY KEY, shop_id INT, name TEXT, sku TEXT, category TEXT DEFAULT '',
    fabric TEXT DEFAULT '', color TEXT DEFAULT '', size TEXT DEFAULT '',
    qty INT DEFAULT 0, price NUMERIC(14,2) DEFAULT 0, cost NUMERIC(14,2) DEFAULT 0
  );
  CREATE TABLE stock_movements (
    id SERIAL PRIMARY KEY, item_id INT, shop_id INT, type TEXT, qty_change INT,
    qty_after INT DEFAULT 0, occurred_at TIMESTAMPTZ, unit_price NUMERIC(14,2),
    discount_pct NUMERIC(5,2) DEFAULT 0, payment TEXT DEFAULT '',
    cash_amount NUMERIC(14,2), bank TEXT DEFAULT '', staff_id INT,
    staff_name TEXT DEFAULT '', reason TEXT DEFAULT '', note TEXT DEFAULT ''
  );
  CREATE TABLE imported_sales (
    id SERIAL PRIMARY KEY, shop_id INT, source TEXT, sku TEXT, name TEXT DEFAULT '',
    style TEXT DEFAULT '', fabric TEXT DEFAULT '', color TEXT DEFAULT '', size TEXT DEFAULT '',
    sold_on DATE, units INT, value NUMERIC(14,2) DEFAULT 0,
    cash NUMERIC(14,2) DEFAULT 0, card NUMERIC(14,2) DEFAULT 0, bank TEXT DEFAULT ''
  );
  INSERT INTO shops (business_id, name, code) VALUES (1,'Rose Gold','RG'), (1,'Goldust','GD');
  INSERT INTO stock_items (shop_id, name, sku, color, size, qty, price) VALUES
    (1,'NICOL DRESS BLACK','NI-1005','BLACK','O/S', 4, 900000),
    (2,'GIPSY DRESS','GI-2009','OFF WHITE','O/S', 2, 1200000);

  -- Two days at Rose Gold in November 2026, paid four different ways.
  INSERT INTO stock_movements (item_id, shop_id, type, qty_change, occurred_at, unit_price, payment, bank, cash_amount, staff_name) VALUES
    (1,1,'sale',  -1,'2026-11-03T04:00:00Z', 900000, 'cash',  '',     NULL,   'Widya'),
    (1,1,'sale',  -2,'2026-11-03T06:00:00Z', 900000, 'card',  'BCA',  NULL,   'Widya'),
    (1,1,'sale',  -1,'2026-11-04T04:00:00Z', 900000, 'split', 'BNI',  400000, 'Listi'),
    (1,1,'sale',  -1,'2026-11-04T05:00:00Z', 900000, 'card',  '',     NULL,   'Listi'),
    (1,1,'return', 1,'2026-11-04T07:00:00Z', 900000, 'cash',  '',     NULL,   'Listi'),
    -- December is outside the report, and Goldust is another shop's report.
    (1,1,'sale',  -1,'2026-12-01T04:00:00Z', 900000, 'cash',  '',     NULL,   'Widya'),
    (2,2,'sale',  -1,'2026-11-03T04:00:00Z',1200000, 'cash',  '',     NULL,   'Erin');
  -- And a line out of the shop's own book, on the 3rd.
  INSERT INTO imported_sales (shop_id, source, sku, name, size, sold_on, units, value, cash, card, bank) VALUES
    (1,'book','OLD-1','OLD KAFTAN','O/S','2026-11-03', 2, 1000000, 0, 1000000, 'BNI');
`);

console.log('\nReal Postgres · the report the shop files\n');

// ── The shipped handler, run as it ships ────────────────────────────────
const pool = { query: (t, p) => db.query(t, p) };
const SHOP_TZ = /const SHOP_TZ = process\.env\.SHOP_TZ \|\| '([^']+)'/.exec(src)[1];
const pieces = [
  grab('const SALE_PRICE_SQL =', ';'),
  grab('const SALE_NET_SQL =', ';'),
  grab('const SALE_SELECT = `', '`;'),
  grab('const LEDGER_PRICE_SQL =', ';'),
  grab('const LEDGER_SELECT = `', '`;'),
  grab('const SALE_TYPES_SQL =', ';'),
  grab('const shapeSale = (r) => {', '\n};'),
  grab('const splitOf = (r) => {', '\n};'),
  grab('const REPORT_COLUMNS = [', '];'),
  grab('const MONTH_NAMES = [', '];'),
].join('\n');
const handler = new Function('pool', 'logger', 'require', 'SHOP_TZ', 'scopeShopIds', `
  ${pieces}
  return ${grab("app.get('/api/sales/export.xlsx', auth, requireAdmin, async (req, res) => {", '\n});')
    .replace("app.get('/api/sales/export.xlsx', auth, requireAdmin, ", '')
    .replace(/\);$/, '')};
`)(pool, { error: (k, v) => console.log('ERROR', k, v) }, requireCJS, SHOP_TZ, async () => [1]);

// The handler streams into the response, so the response here is a sink
// that collects the bytes the way express would hand them on.
const callExport = (query) => new Promise((resolve, reject) => {
  const chunks = [];
  const res = {
    headers: {}, statusCode: 200,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    status(c) { this.statusCode = c; return this; },
    json(v) { resolve({ json: v, statusCode: this.statusCode }); },
    write(c) { chunks.push(Buffer.from(c)); return true; },
    once(ev, fn) { if (ev === 'error') this._err = fn; },
    on(ev, fn) { if (ev === 'error') this._err = fn; },
    emit() {},
    end() { resolve({ buffer: Buffer.concat(chunks), headers: this.headers, statusCode: this.statusCode }); },
    get headersSent() { return false; },
  };
  handler({ query, user: { businessId: 1 } }, res).catch(reject);
});

console.log('  what it refuses');
check('a report with no year is refused', (await callExport({})).json?.error === 'Pick a year', 'it made one anyway');
check('monthly with no month is refused',
  (await callExport({ year: '2026', period: 'month' })).json?.error === 'Pick a month', 'it made one anyway');

console.log('\n  a month at one shop');
const { buffer, headers } = await callExport({ year: '2026', period: 'month', month: '11' });
check('it comes back as a spreadsheet',
  /spreadsheetml/.test(headers['content-type'] || ''), headers['content-type']);
check('named for the shop and the month',
  /Rose-Gold-2026-11\.xlsx/.test(headers['content-disposition'] || ''), headers['content-disposition']);

const wb = new ExcelJS.Workbook();
await wb.xlsx.load(buffer);
const ws = wb.worksheets[0];
const cell = (r, c) => ws.getCell(r, c).value;
const col = (name) => ['TANGGAL', 'NO.', 'KODE BARANG', 'JENIS BARANG', 'UNIT', 'HARGA PER UNIT',
  'DISKON', 'TOTAL HARGA', 'CASH', 'BNI', 'BCA', 'PAYPALL', 'SPG'].indexOf(name) + 1;

check('it is titled with the shop', String(cell(1, 1)).includes('ROSE GOLD'), String(cell(1, 1)));
check('and the month', String(cell(3, 1)) === 'NOVEMBER 2026', String(cell(3, 1)));

// ── the summary at the top ──────────────────────────────
// Rose Gold in November: 1 + 2 + 1 + 1 − 1 returned = 4 pieces of its own,
// plus 2 out of the book = 6. Money: 900,000 cash + 1,800,000 BCA
// + (400,000 cash + 500,000 BNI) + 900,000 card with no machine
// − 900,000 refunded + 1,000,000 BNI from the book.
const labels = {};
for (let c = 1; c <= 13; c++) if (cell(5, c)) labels[String(cell(5, c))] = Number(cell(6, c) || 0);
check('the period is summarised at the top: 6 pieces', labels.POTONG === 6, JSON.stringify(labels));
check('takings add up', labels['TOTAL OMSET'] === 4600000, String(labels['TOTAL OMSET']));
check('cash nets the refund off: 900,000 + 400,000 − 900,000', labels.CASH === 400000, String(labels.CASH));
check('BNI holds the split half and the book line', labels.BNI === 1500000, String(labels.BNI));
check('BCA holds its own', labels.BCA === 1800000, String(labels.BCA));
check('a card with no machine is counted apart, not guessed into a bank',
  labels['KARTU TANPA BANK'] === 900000, String(labels['KARTU TANPA BANK']));
check('and the banks plus that row come to the card total',
  labels.BNI + labels.BCA + labels.PAYPALL + labels['KARTU TANPA BANK']
  === labels['TOTAL OMSET'] - labels.CASH,
  'the columns do not reconcile');

// ── the lines, and a total under each day ───────────────
const rowsOut = [];
for (let r = 10; r <= ws.rowCount; r++) {
  rowsOut.push({ r, tanggal: cell(r, col('TANGGAL')), jenis: String(cell(r, col('JENIS BARANG')) || '') });
}
const totalRows = rowsOut.filter(x => x.jenis.startsWith('TOTAL '));
check('each day is totalled under itself', totalRows.length === 2,
  totalRows.map(x => x.jenis).join(' | '));
check('and the days are the two that traded',
  totalRows.map(x => x.jenis).join(',') === 'TOTAL 2026-11-03,TOTAL 2026-11-04',
  totalRows.map(x => x.jenis).join(','));
const firstTotal = totalRows[0].r;
check("the first day's takings: 900,000 cash + 1,800,000 BCA + 1,000,000 book",
  Number(cell(firstTotal, col('TOTAL HARGA'))) === 3700000, String(cell(firstTotal, col('TOTAL HARGA'))));
check('with the cash and the banks in their own columns',
  Number(cell(firstTotal, col('CASH'))) === 900000
  && Number(cell(firstTotal, col('BCA'))) === 1800000
  && Number(cell(firstTotal, col('BNI'))) === 1000000,
  `${cell(firstTotal, col('CASH'))} / ${cell(firstTotal, col('BCA'))} / ${cell(firstTotal, col('BNI'))}`);

check('another shop is not in this report',
  !rowsOut.some(x => String(cell(x.r, col('KODE BARANG')) || '') === 'GI-2009'), "Goldust's sale is in it");
check('nor another month',
  !rowsOut.some(x => String(x.tanggal || '').startsWith('2026-12')), 'December is in it');
check('the book line is in it, under the garment the book names',
  rowsOut.some(x => String(cell(x.r, col('KODE BARANG')) || '') === 'OLD-1'), 'the book was left out');

console.log('\n  a whole year');
const { buffer: yearly } = await callExport({ year: '2026', period: 'year' });
const wb2 = new ExcelJS.Workbook();
await wb2.xlsx.load(yearly);
const ws2 = wb2.worksheets[0];
check('it is titled as the year', String(ws2.getCell(3, 1).value) === 'TAHUN 2026', String(ws2.getCell(3, 1).value));
check('and holds December as well as November',
  Number(ws2.getCell(6, 1).value) === 7, `${ws2.getCell(6, 1).value} pieces`);

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
