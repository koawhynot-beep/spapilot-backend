// The shops' own sales books, against REAL Postgres.
//
// Each shop kept every sale by hand before the app existed. Those books now
// stand behind three screens — the stock list, Quick check and the best and
// worst sellers — because the question all three ask is "what sells", and
// two years of real trade answers it better than the few weeks the app has
// watched.
//
// Three screens, and no others. The till, the takings, the commission, the
// sales log and every export answer "what did we do today", and a book
// written by hand cannot support that claim. The last section here is what
// keeps the line in place: the only queries allowed to name the table are
// the ones belonging to those three screens.
import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';

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
  CREATE TABLE businesses (id SERIAL PRIMARY KEY);
  INSERT INTO businesses DEFAULT VALUES;
  CREATE TABLE shops (id SERIAL PRIMARY KEY, business_id INT, name TEXT, code TEXT);
  CREATE TABLE stock_items (
    id SERIAL PRIMARY KEY, shop_id INT, name TEXT, sku TEXT, fabric TEXT DEFAULT '',
    category TEXT DEFAULT '', size TEXT DEFAULT '',
    color TEXT DEFAULT '', qty INT DEFAULT 0, price NUMERIC(14,2) DEFAULT 0
  );
  CREATE TABLE imported_sales (
    id SERIAL PRIMARY KEY, shop_id INT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
    source TEXT NOT NULL, sku TEXT NOT NULL, name TEXT DEFAULT '', style TEXT DEFAULT '',
    fabric TEXT DEFAULT '', color TEXT DEFAULT '', size TEXT DEFAULT '',
    sold_on DATE NOT NULL, units INT NOT NULL, value NUMERIC(14,2) NOT NULL DEFAULT 0,
    cash NUMERIC(14,2) NOT NULL DEFAULT 0, card NUMERIC(14,2) NOT NULL DEFAULT 0,
    bank TEXT DEFAULT '', staff TEXT DEFAULT ''
  );
  INSERT INTO shops (business_id, name, code) VALUES (1,'Goldust','GD'), (1,'Atriq','AT');
`);
const one = async (sql, p) => (await db.query(sql, p)).rows[0];

console.log('\nReal Postgres · the shops\' own sales books\n');

// ── The books that ship ──────────────────────────────────────────────────
// eslint-disable-next-line no-eval
const BOOKS = eval(grab('const IMPORTED_BOOKS = [', '];').slice('const IMPORTED_BOOKS = '.length));
console.log('  the books as they ship');
check('every book names a shop and a file',
  BOOKS.length >= 1 && BOOKS.every(x => /^[A-Z]{2}$/.test(x.shop) && x.file.startsWith('./')),
  JSON.stringify(BOOKS));
check('no shop is listed twice', new Set(BOOKS.map(x => x.shop)).size === BOOKS.length,
  BOOKS.map(x => x.shop).join(','));

const seen = new Set();
for (const entry of BOOKS) {
  const book = (await import(new URL('../' + entry.file.replace('./', ''), import.meta.url))).default;
  const rows = book.rows;
  const pieces = rows.reduce((n, r) => n + r[7], 0);
  const value = rows.reduce((n, r) => n + r[8], 0);
  console.log(`  ${entry.shop}: ${rows.length} lines · ${pieces} pieces · ${value.toLocaleString('en-US')} IDR`);
  check(`${entry.shop}: every line has a code, a day and at least one piece`,
    rows.every(r => r[0] && /^\d{4}-\d{2}-\d{2}$/.test(r[6]) && r[7] > 0), 'a malformed line');
  check(`${entry.shop}: no line is worth less than nothing`, rows.every(r => r[8] >= 0), 'a negative sale');
  check(`${entry.shop}: cash and card never come to more than the line`,
    rows.every(r => r[9] + r[10] <= r[8]), 'a line claims more money than it took');
  check(`${entry.shop}: a bank is named only where a card was used`,
    rows.every(r => (r[11] ? r[10] > 0 : true)), 'a cash line names a machine');
  check(`${entry.shop}: alterations are not in it — they sell no garment`,
    !rows.some(r => r[0] === 'AL-2001'), 'the sewing service is counted as stock sold');
  const described = rows.filter(r => r[2] || r[3]).length;
  check(`${entry.shop}: the garments are described — ${Math.round((described / rows.length) * 100)}% carry a style or fabric`,
    described / rows.length > 0.8, `only ${described} of ${rows.length}`);
  // The name ends in a fingerprint of the lines, so a file that changes is a
  // book the loader has not seen and therefore reloads. Without it, adding a
  // column to the data file left the loaded copy silently one version behind.
  check(`${entry.shop}: its name follows its contents, and is its own`,
    / · [0-9a-f]{8}$/.test(book.source) && !seen.has(book.source), book.source);
  seen.add(book.source);
}

// ── The loader ───────────────────────────────────────────────────────────
const FIXTURE = {
  source: 'test book',
  rows: [
    ['ni-1005', 'NICOL DRESS BLACK', 'NICOL DRESS', 'RAYON KRINKLE', 'BLACK', 'O/S', '2025-03-04', 3, 2400000, 2400000, 0, ''],
    ['GI-2009', 'GIPSY DRESS', 'GIPSY DRESS', 'RAYON LINEN', 'OFF WHITE', 'O/S', '2026-02-10', 1, 1200000, 0, 1200000, 'BCA'],
  ],
};
const logs = [];
const logger = { info: (k, v) => logs.push([k, v]), warn: (k, v) => logs.push([k, v]), error: (k, v) => logs.push([k, v]) };
const pool = { query: (t, p) => db.query(t, p), connect: async () => ({ query: (t, p) => db.query(t, p), release() {} }) };
const seedOne = new Function('pool', 'logger', 'require', `
  ${grab('async function seedOneBook({ shop, file }) {', '\n}')}
  return seedOneBook;
`)(pool, logger, () => FIXTURE);

console.log('\n  loading a book');
await seedOne({ shop: 'GD', file: './fixture.js' });
const held = await one(`SELECT COUNT(*)::int AS n, SUM(units)::int AS u FROM imported_sales`);
check('every line lands, in the shop whose book it is', held.n === 2 && held.u === 4, JSON.stringify(held));
check('codes are stored upper case, so the book and the shelf meet on them',
  (await one(`SELECT COUNT(*)::int AS n FROM imported_sales WHERE sku = 'NI-1005'`)).n === 1, 'case leaked in');
check('the style and the fabric come through, for cards the shelf cannot describe',
  (await one(`SELECT style, fabric FROM imported_sales WHERE sku = 'NI-1005'`)).fabric === 'RAYON KRINKLE',
  'the description is lost');
logs.length = 0;
await seedOne({ shop: 'GD', file: './fixture.js' });
check('a second run loads nothing again',
  (await one(`SELECT COUNT(*)::int AS n FROM imported_sales`)).n === 2, 'it doubled the book');

console.log('\n  a newer copy supersedes the old');
await db.query(`INSERT INTO imported_sales (shop_id, source, sku, sold_on, units)
                VALUES (1, 'last month''s copy', 'NI-1005', '2025-01-05', 9)`);
const sweep = new Function('pool', 'logger', 'require', 'seedOneBook', `
  ${grab('const IMPORTED_BOOKS = [', '];')}
  ${grab('async function seedImportedSales() {', '\n}')}
  return seedImportedSales;
`)(pool, logger, () => FIXTURE, async () => {});
logs.length = 0;
await sweep();
check('the superseded copy is swept out before anything is loaded',
  (await one(`SELECT COUNT(*)::int AS n FROM imported_sales WHERE source LIKE 'last month%'`)).n === 0,
  'two copies of one book would double every figure that reads it');
check('and it says what it removed',
  logs.some(l => l[0] === 'ledger.superseded'), JSON.stringify(logs));

// ── Where the book may be read, and where it may not ─────────────────────
console.log('\n  where the book may be read, and where it may not');
const BLOCKS = {
  'the table itself': grab("    -- What each shop sold before the app", 'card NUMERIC(14,2) NOT NULL DEFAULT 0\n    );'),
  'its bank column': grab('  await pool.query(`ALTER TABLE imported_sales ', ';'),
  'its staff column': grab('  // The books name the assistant who served', ';'),
  'its indexes': grab('  await pool.query(`CREATE INDEX IF NOT EXISTS idx_imported_sales ', 'idx_imported_sales_on ON imported_sales(sold_on)`);'),
  'the loader': grab("// The shops' own sales books. Each is loaded once", '\n}'),
  'the clean slate': grab('async function startFresh() {', '\n}'),
  'one book at a time': grab('async function seedOneBook({ shop, file }) {', '\n}'),
  'the stock list': grab("app.get('/api/shops/:shopId/stock'", '\n});'),
  'the sales log': grab("app.get('/api/sales/history', auth", '\n});'),
  'the day-by-day figures': grab("app.get('/api/sales/periods'", '\n});'),
  'per seller': grab("app.get('/api/sales/by-staff'", '\n});'),
  'the export': grab("app.get('/api/sales/history.csv'", '\n});'),
  'the sale-shaped view of it': grab('const LEDGER_SELECT = `', '`;'),
  'correcting a line': grab("// A line out of the shop's own book, corrected.", '\n}'),
  'deleting a line': grab("app.delete('/api/movements/:id'", '\n});'),
  'correcting a sale': grab("app.patch('/api/sales/:id'", '\n});'),
  'Quick check': grab("app.get('/api/quick-check'", '\n});'),
  'best and worst': grab("app.get('/api/analytics/summary'", '\n});'),
};
let rest = src;
for (const b of Object.values(BLOCKS)) rest = rest.split(b).join('');
check('nothing outside the table, the loader and the screens that report what sold names it',
  !rest.includes('imported_sales'),
  `${rest.split('imported_sales').length - 1} other mentions`);

// Inside the rankings page, only the three ranking queries may see it: the
// trend, the weekday averages and the shelf report are about what the app
// itself recorded.
const page = BLOCKS['best and worst'];
const sliceOf = (from, to) => page.slice(page.indexOf(from), to ? page.indexOf(to) : undefined);
check('the trend chart does not count the book',
  !/imported_sales/.test(sliceOf("to_char(date_trunc('month'", 'EXTRACT(ISODOW')), 'it does');
check('the weekday averages do not either — the book has no till to ring',
  !/imported_sales/.test(sliceOf('EXTRACT(ISODOW', 'SELECT sku, year')), 'they do');
check('nor the dead-stock and fast-moving report',
  !/imported_sales/.test(sliceOf('si.last_sold_at, si.created_at', 'const ranked =')), 'it does');
// The year picker is the exception, and belongs with the lists it drives.
check('the years offered cover both books, since the lists do',
  /SELECT EXTRACT\(YEAR FROM i\.sold_on\)::int/.test(sliceOf('Which years there is anything')),
  'a year in the book would not be offered');

// Today's till roll is the one sales screen the book stays out of: it
// answers "what happened today", and a book of past trade cannot.
check('the till roll counts only what the app rang up',
  !/imported_sales|LEDGER_SELECT/.test(grab("app.get('/api/sales/today'", '\n});')),
  'the book reached the till roll');
check('and so does the commission',
  !/imported_sales|LEDGER_SELECT/.test(grab('const COMMISSION_SQL = `', '`;')),
  'somebody would be paid commission on the book');
// The book writes down who served, and the sales log shows it — "which of
// us sold that?" is a question about two years of trade, not about today.
// What it must never carry is a staff id: an id is what commission, the
// per-seller figures and the till roll are paid and counted against, and
// the book is none of those. A name on a line is a record; an id is a claim.
check('a book line names who served',
  /COALESCE\(i\.staff, ''\)::text AS staff_name/.test(src), 'the name is dropped');
check('but it carries no staff id, so it can never be credited or paid',
  /AS staff_name, NULL::int AS staff_id/.test(src), 'it could be credited');

check('the loader is the only thing that adds to it',
  (src.match(/INSERT INTO imported_sales/g) || []).length === 1, 'something else adds rows');
// A correction is the one thing allowed to rewrite a line, and only one
// line at a time: an UPDATE without an id would rewrite a whole book.
check('a line is only ever rewritten one at a time, by the correction',
  (src.match(/UPDATE imported_sales/g) || []).length === 1
  && /UPDATE imported_sales[\s\S]{0,600}WHERE id = \$13/.test(src),
  'something rewrites the book wholesale');
// Three deletes, each of which must say exactly what it takes: the sweep
// that keeps the listed books, the clean slate, and one line at a time.
check('every delete of the book says exactly what it takes',
  (src.match(/DELETE FROM imported_sales/g) || []).length === 3
  && /DELETE FROM imported_sales WHERE source <> ALL\(\$1::text\[\]\)/.test(src)
  && /DELETE FROM imported_sales WHERE shop_id IN/.test(src)
  && /DELETE FROM imported_sales WHERE id = \$1/.test(src),
  'a delete could take more than it means to');
check('it cannot move stock: the loader touches no other table',
  !/stock_items|stock_movements/.test(BLOCKS['one book at a time']), 'the loader reaches into the stock');
check('asking for one person\'s sales drops the book, which records no person',
  /if \(Number\.isInteger\(parseInt\(req\.query\.staffId, 10\)\)\) return \{ where: ' AND FALSE'/.test(src),
  'ledger rows would be credited to whoever was asked about');

// ── Correcting a line ────────────────────────────────────────────────────
// The owner corrects a book line the same way as a sale the app recorded:
// from the counter they are both just "that sale, which is wrong". A book
// line moves no stock, so this is a plain edit of the record.
console.log('\n  correcting a line out of the book');
await db.exec(`
  CREATE TABLE audit_log (
    id SERIAL PRIMARY KEY, business_id INT, action TEXT, entity TEXT, entity_id INT,
    summary TEXT, before_val TEXT, after_val TEXT, actor_role TEXT,
    staff_id INT, staff_name TEXT
  );
  INSERT INTO stock_items (shop_id, name, sku, fabric, color, qty, price)
    VALUES (1, 'NICOL DRESS BLACK M/L', 'NI-1006', 'RAYON KRINKLE', 'BLACK', 3, 900000);
`);
await db.query(`INSERT INTO imported_sales (shop_id, source, sku, name, style, fabric, color, size, sold_on, units, value, cash, card, bank)
                VALUES (1, 'test book', 'NI-1005', 'NICOL DRESS BLACK X/S', 'NICOL DRESS', 'RAYON KRINKLE', 'BLACK', 'X/S', '2026-03-04', 1, 900000, 0, 900000, 'BNI')`);
const lineId = (await one(`SELECT id FROM imported_sales WHERE sku = 'NI-1005' ORDER BY id DESC LIMIT 1`)).id;

const correct = new Function('pool', 'logger', 'shopAllowed', 'denyShop', 'audit',
                             'cleanPayment', 'cleanMoney', 'cleanBank', `
  ${grab('async function correctBookLine(req, res, client, lineId) {', '\n}')}
  return correctBookLine;
`)(pool, logger, () => true, (res) => res.status(403).json({ error: 'no' }),
   async () => {}, (v) => v, (v) => Math.max(0, Math.round(Number(v) || 0)),
   (v) => String(v || '').toUpperCase());

const client = { query: (t, p2) => db.query(t, p2) };
const call = (body) => new Promise((resolve) => {
  const res = { status(c) { this.code = c; return this; },
                json(v) { resolve({ code: this.code || 200, ...v }); } };
  correct({ body, user: { businessId: 1 }, params: {} }, res, client, lineId);
});

// The staff rang up the wrong size: it should have been the M/L on the shelf.
const swapped = await call({ itemId: (await one(`SELECT id FROM stock_items WHERE sku = 'NI-1006'`)).id });
check('the correction comes back as the row the screen sent',
  swapped.ok === true && swapped.id === -lineId && swapped.fromBook === true, JSON.stringify(swapped));
const after = await one(`SELECT * FROM imported_sales WHERE id = $1`, [lineId]);
check('the line now names the garment that was really sold',
  after.sku === 'NI-1006' && after.name === 'NICOL DRESS BLACK M/L', `${after.sku} ${after.name}`);
check('and takes the shelf\'s fabric and colour with it',
  after.fabric === 'RAYON KRINKLE' && after.color === 'BLACK', `${after.fabric} ${after.color}`);
check('the money is untouched by a swap', Number(after.value) === 900000, String(after.value));

await call({ qty: 3, unitPrice: 800000, payment: 'split', cashAmount: 1000000, bank: 'BCA' });
const edited = await one(`SELECT * FROM imported_sales WHERE id = $1`, [lineId]);
check('three at 800,000 is 2,400,000', Number(edited.value) === 2400000 && edited.units === 3,
  `${edited.units} × ${edited.value}`);
check('part cash, part card, and the card half is the remainder',
  Number(edited.cash) === 1000000 && Number(edited.card) === 1400000,
  `${edited.cash} / ${edited.card}`);
check('with the machine recorded', edited.bank === 'BCA', edited.bank);

await call({ payment: 'cash' });
const cashOnly = await one(`SELECT * FROM imported_sales WHERE id = $1`, [lineId]);
check('switching to cash moves the whole line into the drawer and drops the bank',
  Number(cashOnly.cash) === 2400000 && Number(cashOnly.card) === 0 && cashOnly.bank === '',
  `${cashOnly.cash} / ${cashOnly.card} / "${cashOnly.bank}"`);

const missing = await call({ qty: 1 });
void missing;
check('a line that is not there cannot be corrected',
  (await (async () => {
    const r = await new Promise((resolve) => {
      const res = { status(c) { this.code = c; return this; }, json(v) { resolve({ code: this.code || 200, ...v }); } };
      correct({ body: {}, user: { businessId: 1 }, params: {} }, res, client, 999999);
    });
    return r.code;
  })()) === 404, 'it accepted a correction to nothing');

console.log('\n  and what the code promises about it');
check('the log numbers book lines negative so the two can be told apart',
  /\(-i\.id\) AS id/.test(src), 'a book line could be mistaken for a movement');
check('a correction to a negative id goes to the book, not the movements',
  /if \(saleId < 0\) return await correctBookLine/.test(src), 'it would look for a movement');
check('and so does a deletion',
  /if \(moveId < 0\) {/.test(src) && /DELETE FROM imported_sales WHERE id = \$1/.test(src),
  'deleting a book line would fail');
check('correcting one touches no stock',
  !/stock_items SET|stock_movements/.test(grab('async function correctBookLine(req, res, client, lineId) {', '\n}')),
  'it moves stock');

// ── A filter asks the shelf, not the book ────────────────────────────────
// The books were written against the catalogue of their day: the same code
// is "RAYON LINEN / BULU KUDA LINEN" in the book and "BULU KUDA RAYON LINEN
// / NATURAL" on today's shelf. Filtering the book by its own words threw
// away two years of a garment's history the moment a fabric was picked, and
// the best-seller list showed it at one piece — the one sale the app itself
// had rung up.
console.log('\n  a filter asks the shelf, not the book');
// eslint-disable-next-line no-eval
const SHELF_FACET = eval('(' + grab('const SHELF_FACET = (col) =>', '`;').replace('const SHELF_FACET = ', '').replace(/;$/, '') + ')');

await db.query(`INSERT INTO stock_items (shop_id, name, sku, fabric, color, size, qty, price)
                VALUES (1, 'FLOWY DRESS LONG NATURAL O/S', 'FL-1032', 'BULU KUDA RAYON LINEN', 'NATURAL', 'O/S', 2, 980000)`);
await db.query(`INSERT INTO imported_sales (shop_id, source, sku, name, style, fabric, color, size, sold_on, units, value)
                VALUES (1, 'test book', 'FL-1032', 'FLOWY DRESS LONG BULU KUDA LINEN O/S', 'FLOWY DRESS LONG',
                        'RAYON LINEN', 'BULU KUDA LINEN', 'O/S', '2025-01-17', 1, 980000),
                       (1, 'test book', 'GONE-7', 'OLD KAFTAN', 'OLD KAFTAN', 'RAMIE', 'RUSH', 'O/S', '2025-02-02', 1, 500000)`);

const matching = async (col, val) => (await db.query(
  `SELECT COUNT(*)::int AS n
     FROM imported_sales i JOIN shops sh ON sh.id = i.shop_id
    WHERE sh.business_id = 1 AND i.sku IN ('FL-1032','GONE-7') AND ${SHELF_FACET(col)}, i.${col === 'category' ? 'style' : col}) = $1`,
  [val])).rows[0].n;

check('a book line is found by what the shelf calls the fabric',
  (await matching('fabric', 'BULU KUDA RAYON LINEN')) === 1, 'the book\'s own word was used');
check('and not by the word the book used, which is two catalogues old',
  (await matching('fabric', 'RAYON LINEN')) === 0, 'the stale word still matches');
check('a code no shop carries keeps the book\'s word, so it stays findable',
  (await matching('fabric', 'RAMIE')) === 1, 'the line fell out of every filter');
check('the same for colour',
  (await matching('color', 'NATURAL')) === 1, 'colour still reads the book');

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
