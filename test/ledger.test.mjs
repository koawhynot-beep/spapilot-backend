// The shop's own sales book, against REAL Postgres.
//
// Two years of Gold Dust's handwritten ledger are loaded for one purpose:
// the best- and worst-seller lists. The owner was explicit that it must
// reach nothing else — not the till, not the takings, not commission, not a
// shelf count. That promise is kept structurally rather than carefully: the
// ledger lives in its own table, so a query would have to name it to see it.
// The last section here checks that only the rankings ever do.
import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';

const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');

const db = new PGlite();
await db.exec(`
  CREATE TABLE shops (id SERIAL PRIMARY KEY, business_id INT, name TEXT, code TEXT);
  CREATE TABLE stock_items (
    id SERIAL PRIMARY KEY, shop_id INT, name TEXT, sku TEXT, color TEXT DEFAULT '',
    size TEXT DEFAULT '', qty INT DEFAULT 0, price NUMERIC(14,2) DEFAULT 0
  );
  CREATE TABLE stock_movements (
    id SERIAL PRIMARY KEY, item_id INT, shop_id INT, type TEXT, qty_change INT,
    qty_after INT DEFAULT 0, occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    unit_price NUMERIC(14,2), discount_pct NUMERIC(5,2) DEFAULT 0, note TEXT DEFAULT ''
  );
  CREATE TABLE imported_sales (
    id SERIAL PRIMARY KEY, shop_id INT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
    source TEXT NOT NULL, sku TEXT NOT NULL, name TEXT DEFAULT '', color TEXT DEFAULT '',
    size TEXT DEFAULT '', sold_on DATE NOT NULL, units INT NOT NULL,
    value NUMERIC(14,2) NOT NULL DEFAULT 0,
    cash NUMERIC(14,2) NOT NULL DEFAULT 0, card NUMERIC(14,2) NOT NULL DEFAULT 0
  );
  INSERT INTO shops (business_id, name, code) VALUES (1,'Goldust','GD'), (1,'Atriq','AT');
  INSERT INTO stock_items (shop_id, name, sku, color, qty, price) VALUES
    (1,'NICOL DRESS BLACK','NI-1005','BLACK', 4, 895000),
    (1,'GIPSY DRESS BULU KUDA','GI-2009','BULU KUDA LINEN', 2, 1200000);
`);

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : '  — ' + detail}`);
  if (!ok) failures++;
};
const one = async (sql, p) => (await db.query(sql, p)).rows[0];
const grab = (decl, end) => {
  const a = src.indexOf(decl);
  const b = src.indexOf(end, a);
  if (a < 0 || b < 0) throw new Error('could not extract ' + decl);
  return src.slice(a, b + end.length);
};

console.log('\nReal Postgres · the shop\'s own sales book\n');

// ── The books that ship ──────────────────────────────────────────────────
// Every shop's book is held to the same standard, so a new one cannot be
// added to the list with a shape nobody checked.
// eslint-disable-next-line no-eval
const BOOKS = eval(grab('const IMPORTED_BOOKS = [', '];').slice('const IMPORTED_BOOKS = '.length));
console.log('  the books as they ship');
check('each book names a shop and a file', BOOKS.length >= 1
  && BOOKS.every(b => /^[A-Z]{2}$/.test(b.shop) && b.file.startsWith('./')), JSON.stringify(BOOKS));
check('no shop is loaded twice', new Set(BOOKS.map(b => b.shop)).size === BOOKS.length,
  BOOKS.map(b => b.shop).join(','));

const sources = new Set();
for (const b of BOOKS) {
  const book = (await import(new URL('../' + b.file.replace('./', ''), import.meta.url))).default;
  const rows = book.rows;
  const pieces = rows.reduce((n, r) => n + r[5], 0);
  const value = rows.reduce((n, r) => n + r[6], 0);
  console.log(`  ${b.shop}: ${rows.length} lines · ${pieces} pieces · ${value.toLocaleString('en-US')} IDR`);
  check(`${b.shop}: every line has a code, a day and at least one piece`,
    rows.every(r => r[0] && /^\d{4}-\d{2}-\d{2}$/.test(r[4]) && r[5] > 0),
    'a malformed line is in the file');
  check(`${b.shop}: every day falls inside the two years the book covers`,
    rows.every(r => r[4] >= '2025-01-01' && r[4] <= '2026-12-31'), 'a line is dated outside the book');
  check(`${b.shop}: no line is worth less than nothing`, rows.every(r => r[6] >= 0), 'a negative sale');
  check(`${b.shop}: cash and card never come to more than the line`,
    rows.every(r => r[7] + r[8] <= r[6]), 'a line claims more money than it took');
  check(`${b.shop}: alterations are not in it — they sell no garment`,
    !rows.some(r => r[0] === 'AL-2001'), 'the sewing service is counted as stock sold');
  check(`${b.shop}: the book is named, and named only once`,
    typeof book.source === 'string' && book.source.length > 0 && !sources.has(book.source),
    `source "${book.source}" is missing or shared with another book`);
  sources.add(book.source);
}

// ── The loader, run as it ships ──────────────────────────────────────────
const FIXTURE = {
  source: 'test ledger',
  rows: [
    ['ni-1005', 'NICOL DRESS BLACK', 'BLACK', 'O/S', '2025-03-04', 3, 2400000, 2400000, 0],
    ['GI-2009', 'GIPSY DRESS BULU KUDA', 'BULU KUDA LINEN', 'O/S', '2025-07-21', 1, 1200000, 0, 1200000],
    ['OLD-999', 'DISCONTINUED KAFTAN', 'RUSH', 'O/S', '2026-02-10', 5, 3000000, 0, 3000000],
  ],
};
const logs = [];
const logger = { info: (k, v) => logs.push([k, v]), warn: (k, v) => logs.push([k, v]), error: (k, v) => logs.push([k, v]) };
const pool = { connect: async () => ({ query: (t, p) => db.query(t, p), release() {} }) };
const seedOne = new Function('pool', 'logger', 'require', `
  ${grab('async function seedOneBook({ shop, file }) {', '\n}')}
  return seedOneBook;
`)(pool, logger, () => FIXTURE);
const seed = () => seedOne({ shop: 'GD', file: './fixture.js' });
check('the loader walks every book in the list',
  /for \(const book of IMPORTED_BOOKS\) {\s*await seedOneBook\(book\);/.test(src),
  'a book in the list would never be loaded');

console.log('\n  the first run');
await seed();
const done = logs.find(l => l[0] === 'ledger.seed.done');
check('it says what it loaded', Boolean(done) && done[1].lines === 3 && done[1].pieces === 9,
  JSON.stringify(done));
const held = await one(`SELECT COUNT(*)::int AS n, SUM(units)::int AS u, SUM(value)::numeric AS v FROM imported_sales`);
check('every line lands', held.n === 3 && held.u === 9, JSON.stringify(held));
check('it goes to Gold Dust, not to whichever shop came first',
  (await one(`SELECT COUNT(*)::int AS n FROM imported_sales WHERE shop_id = 1`)).n === 3, 'wrong shop');
check('codes are stored upper case, so the book and the shelf match on them',
  (await one(`SELECT COUNT(*)::int AS n FROM imported_sales WHERE sku = 'NI-1005'`)).n === 1, 'case leaked in');

console.log('\n  the second run');
logs.length = 0;
await seed();
check('a second run loads nothing again',
  (await one(`SELECT COUNT(*)::int AS n FROM imported_sales`)).n === 3, 'it doubled the book');
check('and says nothing', !logs.some(l => l[0] === 'ledger.seed.done'), 'it ran again');

// ── The rankings read both books ─────────────────────────────────────────
// Real trade in the app: 2 Nicol sold, 1 returned; 4 Gipsy sold.
await db.query(`INSERT INTO stock_movements (item_id, shop_id, type, qty_change, occurred_at, unit_price) VALUES
  (1,1,'sale',  -2,'2026-09-20T04:00:00Z', 895000),
  (1,1,'return', 1,'2026-09-21T04:00:00Z', 895000),
  (2,1,'sale',  -4,'2026-09-22T04:00:00Z',1200000)`);

const NET_UNITS = /const NET_UNITS_SQL = "([^"]+)"/.exec(src)[1];
const PRICE = /const SALE_PRICE_SQL = '([^']+)'/.exec(src)[1];
const NET = `ROUND(${PRICE} * (1 - COALESCE(m.discount_pct, 0) / 100.0))`;
// The shipped ranking SQL, with only the runtime pieces filled in.
const rankSql = (ledgerWhere) => grab('`WITH counted AS (', 'ORDER BY units DESC`')
  .replace(/^`|`$/g, '')
  .split('${NET_UNITS_SQL}').join(NET_UNITS)
  .split('${SALE_NET_SQL}').join(NET)
  .split('${windowSql}').join(`sh.business_id = $1 AND m.type IN ('sale','return')`)
  .split('${ledger.where}').join(ledgerWhere);

console.log('\n  the lists count both books');
const ranked = (await db.query(rankSql(''), [1])).rows;
const by = Object.fromEntries(ranked.map(r => [r.sku, r]));
check('a garment sold both ways adds up: 3 in the book + 2 sold − 1 returned = 4',
  by['NI-1005'].units === 4, JSON.stringify(by['NI-1005']));
check('and its money adds up too: 2,400,000 + 895,000',
  Number(by['NI-1005'].revenue) === 3295000, String(by['NI-1005'].revenue));
check('a code the shop no longer stocks still ranks, on the book alone',
  by['OLD-999'] && by['OLD-999'].units === 5, JSON.stringify(by['OLD-999']));
check('and takes its name from the book, since no shelf has one',
  by['OLD-999'].name === 'DISCONTINUED KAFTAN', by['OLD-999'].name);
check('a garment still on the shelf keeps the shelf\'s name, not the book\'s',
  by['GI-2009'].name === 'GIPSY DRESS BULU KUDA', by['GI-2009'].name);
check('the list is ordered by pieces, most first',
  ranked.every((r, i) => i === 0 || ranked[i - 1].units >= r.units),
  ranked.map(r => `${r.sku}:${r.units}`).join(', '));
check('and the leader is one of the two on five pieces',
  ranked[0].units === 5, `${ranked[0].sku}:${ranked[0].units}`);

console.log('\n  narrowing to one year');
const y2025 = (await db.query(rankSql(' AND EXTRACT(YEAR FROM i.sold_on) = 2025'), [1])).rows;
const b25 = Object.fromEntries(y2025.map(r => [r.sku, r]));
check('the book obeys the year asked for', !b25['OLD-999'], 'a 2026 line answered a 2025 question');
check('2025 shows the book\'s three Nicols', b25['NI-1005'].units === 3 + 1, JSON.stringify(b25['NI-1005']));

// ── What the code guarantees ─────────────────────────────────────────────
console.log('\n  the promise: the rankings and nothing else');
const blocks = [
  grab('    -- The shop\'s own sales book, from before the app', 'card NUMERIC(14,2) NOT NULL DEFAULT 0\n    );'),
  grab('  await pool.query(`CREATE INDEX IF NOT EXISTS idx_imported_sales ', ';'),
  grab('  await pool.query(`CREATE INDEX IF NOT EXISTS idx_imported_sales_on ', ';'),
  grab("// The shops' own sales books, as they were kept by hand", '\n}'),
  grab('async function seedOneBook({ shop, file }) {', '\n}'),
  grab("app.get('/api/analytics/summary'", '\n});'),
];
let rest = src;
for (const b of blocks) rest = rest.split(b).join('');
check('outside the table, the loader and the rankings, nothing names the ledger at all',
  !rest.includes('imported_sales'),
  'something else reads it: ' + (rest.split('imported_sales').length - 1) + ' other mentions');
check('the loader is the only thing that writes to it',
  (src.match(/INSERT INTO imported_sales/g) || []).length === 1
  && !/UPDATE imported_sales|DELETE FROM imported_sales/.test(src), 'something else writes to it');
check('it cannot move stock: the loader touches no other table',
  !/stock_items|stock_movements/.test(grab('async function seedImportedSales() {', '\n}')),
  'the loader reaches into the stock');
check('asking for one person\'s sales drops the book, which records no person',
  /if \(Number\.isInteger\(parseInt\(req\.query\.staffId, 10\)\)\) return \{ where: ' AND FALSE'/.test(src),
  'ledger rows would be credited to whoever was asked about');

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
