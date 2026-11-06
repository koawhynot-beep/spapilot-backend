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
  CREATE TABLE shops (id SERIAL PRIMARY KEY, business_id INT, name TEXT, code TEXT);
  CREATE TABLE stock_items (
    id SERIAL PRIMARY KEY, shop_id INT, name TEXT, sku TEXT, fabric TEXT DEFAULT '',
    color TEXT DEFAULT '', qty INT DEFAULT 0, price NUMERIC(14,2) DEFAULT 0
  );
  CREATE TABLE imported_sales (
    id SERIAL PRIMARY KEY, shop_id INT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
    source TEXT NOT NULL, sku TEXT NOT NULL, name TEXT DEFAULT '', style TEXT DEFAULT '',
    fabric TEXT DEFAULT '', color TEXT DEFAULT '', size TEXT DEFAULT '',
    sold_on DATE NOT NULL, units INT NOT NULL, value NUMERIC(14,2) NOT NULL DEFAULT 0,
    cash NUMERIC(14,2) NOT NULL DEFAULT 0, card NUMERIC(14,2) NOT NULL DEFAULT 0
  );
  INSERT INTO shops (business_id, name, code) VALUES (1,'Goldust','GD'), (1,'Atriq','AT');
`);
const one = async (sql, p) => (await db.query(sql, p)).rows[0];

console.log('\nReal Postgres · the shops\' own sales books\n');

// ── The books that ship ──────────────────────────────────────────────────
// eslint-disable-next-line no-eval
const BOOKS = eval(grab('const IMPORTED_BOOKS = [', '];').slice('const IMPORTED_BOOKS = '.length));
console.log('  no book is listed');
// The owner cleared the app to start from what the shops actually count and
// ring up, so the list is empty. The sweep below is what makes that stick:
// it keeps exactly the books named here, and with none named it empties the
// table on every boot. Listing one again is all it takes to load it.
check('no book is listed', BOOKS.length === 0, JSON.stringify(BOOKS));
check('and no data file is left to list', !/-history\.js/.test(src),
  'a loader still points at a spreadsheet');

// ── The loader ───────────────────────────────────────────────────────────
const FIXTURE = {
  source: 'test book',
  rows: [
    ['ni-1005', 'NICOL DRESS BLACK', 'NICOL DRESS', 'RAYON KRINKLE', 'BLACK', 'O/S', '2025-03-04', 3, 2400000, 2400000, 0],
    ['GI-2009', 'GIPSY DRESS', 'GIPSY DRESS', 'RAYON LINEN', 'OFF WHITE', 'O/S', '2026-02-10', 1, 1200000, 0, 1200000],
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

console.log('\n  the sweep keeps exactly the books that are listed');
const sweep = new Function('pool', 'logger', 'require', 'seedOneBook', `
  ${grab('const IMPORTED_BOOKS = [', '];')}
  ${grab('async function seedImportedSales() {', '\n}')}
  return seedImportedSales;
`)(pool, logger, () => FIXTURE, async () => {});
logs.length = 0;
await sweep();
check('with none listed, the table is emptied',
  (await one(`SELECT COUNT(*)::int AS n FROM imported_sales`)).n === 0,
  'rows survived a boot that lists no book');
check('and it says what it removed',
  logs.some(l => l[0] === 'ledger.superseded'), JSON.stringify(logs));

// ── Where the book may be read, and where it may not ─────────────────────
console.log('\n  three screens, and no others');
const BLOCKS = {
  'the table itself': grab("    -- What each shop sold before the app", 'card NUMERIC(14,2) NOT NULL DEFAULT 0\n    );'),
  'its indexes': grab('  await pool.query(`CREATE INDEX IF NOT EXISTS idx_imported_sales ', 'idx_imported_sales_on ON imported_sales(sold_on)`);'),
  'the loader': grab("// The shops' own sales books. Each is loaded once", '\n}'),
  'the clean slate': grab('async function startFresh() {', '\n}'),
  'one book at a time': grab('async function seedOneBook({ shop, file }) {', '\n}'),
  'the stock list': grab("app.get('/api/shops/:shopId/stock'", '\n});'),
  'Quick check': grab("app.get('/api/quick-check'", '\n});'),
  'best and worst': grab("app.get('/api/analytics/summary'", '\n});'),
};
let rest = src;
for (const b of Object.values(BLOCKS)) rest = rest.split(b).join('');
check('nothing outside the table, the loader and those three screens names it',
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

check('the loader is the only thing that writes to it',
  (src.match(/INSERT INTO imported_sales/g) || []).length === 1
  && !/UPDATE imported_sales/.test(src), 'something else writes to it');
check('one DELETE sweeps books that are no longer listed, the other is the clean slate',
  (src.match(/DELETE FROM imported_sales/g) || []).length === 2
  && /DELETE FROM imported_sales WHERE source <> ALL\(\$1::text\[\]\)/.test(src)
  && /DELETE FROM imported_sales WHERE shop_id IN/.test(src),
  'a delete could take a book that is still wanted');
check('it cannot move stock: the loader touches no other table',
  !/stock_items|stock_movements/.test(BLOCKS['one book at a time']), 'the loader reaches into the stock');
check('asking for one person\'s sales drops the book, which records no person',
  /if \(Number\.isInteger\(parseInt\(req\.query\.staffId, 10\)\)\) return \{ where: ' AND FALSE'/.test(src),
  'ledger rows would be credited to whoever was asked about');

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
