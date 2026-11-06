// The opening count, and the one name a garment goes by.
//
// Two things are checked here, both of which would be quietly wrong rather
// than loudly broken.
//
// First: the opening count is a starting figure, not a running one. It runs
// on every boot, so it must never touch a count the shop has since changed
// — a loader that resets the shelves each morning would be worse than no
// loader at all.
//
// Second: the book and the stock list were written by different hands over
// two years, so one says NICOLE DRESS and the other NICOL DRESS. The code
// is what they agree on, so the shelf's spelling wins wherever a code is
// stocked, and a code no shop carries keeps whatever the book called it.
import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';

const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const OPENING = (await import(new URL('../opening-stock.js', import.meta.url))).default;

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
    fabric TEXT DEFAULT '', print TEXT DEFAULT '', color TEXT DEFAULT '', size TEXT DEFAULT '',
    brand TEXT DEFAULT '', qty INT DEFAULT 0, threshold INT DEFAULT 0, supplier TEXT DEFAULT '',
    notes TEXT DEFAULT '', position INT DEFAULT 0, image_url TEXT DEFAULT '',
    price NUMERIC(14,2) DEFAULT 0, cost NUMERIC(14,2) DEFAULT 0
  );
  CREATE TABLE imported_sales (
    id SERIAL PRIMARY KEY, shop_id INT, source TEXT, sku TEXT, name TEXT DEFAULT '',
    style TEXT DEFAULT '', fabric TEXT DEFAULT '', color TEXT DEFAULT '', size TEXT DEFAULT '',
    sold_on DATE, units INT, value NUMERIC(14,2) DEFAULT 0,
    cash NUMERIC(14,2) DEFAULT 0, card NUMERIC(14,2) DEFAULT 0, bank TEXT DEFAULT ''
  );
  INSERT INTO shops (business_id, name, code) VALUES
    (1,'Office','OF'), (1,'Goldust','GD'), (1,'Rose Gold','RG');
`);
const one = async (sql, p) => (await db.query(sql, p)).rows[0];

console.log('\nReal Postgres · the opening count\n');

console.log('  the file as it ships');
console.log(`  ${OPENING.rows.length} codes · office ${OPENING.rows.reduce((n, r) => n + r[7], 0)}`
  + ` · goldust ${OPENING.rows.reduce((n, r) => n + r[8], 0)}`
  + ` · rose gold ${OPENING.rows.reduce((n, r) => n + r[9], 0)}`);
check('every row has a code and a name',
  OPENING.rows.every(r => r[0] && r[1]), 'a row has neither');
check('no code is listed twice',
  new Set(OPENING.rows.map(r => r[0])).size === OPENING.rows.length, 'a duplicate code');
check('no count is negative',
  OPENING.rows.every(r => r[7] >= 0 && r[8] >= 0 && r[9] >= 0), 'a negative count');
check('its name follows its contents, so a changed file is a new file',
  / · [0-9a-f]{8}$/.test(OPENING.source), OPENING.source);

// ── The shipped loader ───────────────────────────────────────────────────
const logs = [];
const logger = { warn: (k, v) => logs.push([k, v]), error: (k, v) => logs.push([k, v]), info: () => {} };
const pool = { connect: async () => ({ query: (t, p) => db.query(t, p), release() {} }) };
const FIXTURE = {
  source: 'test opening stock · abcd1234',
  rows: [
    ['NI-1005', 'NICOLE DRESS BLACK', 'NICOLE DRESS', 'RAYON KRINKLE', 'BLACK', 'O/S', 900000, 5, 3, 1],
    ['GI-2009', 'GIPSY DRESS OFF WHITE', 'GIPSY DRESS', 'RAYON LINEN', 'OFF WHITE', 'O/S', 1200000, 0, 2, 0],
  ],
};
const seed = new Function('pool', 'logger', 'require', `
  ${grab('async function seedOpeningStock() {', '\n}')}
  return seedOpeningStock;
`)(pool, logger, () => FIXTURE);

console.log('\n  the first boot');
await seed();
const loaded = logs.find(l => l[0] === 'stock.opening.loaded');
check('it says what it put on the shelves', Boolean(loaded) && loaded[1].items === 6,
  loaded ? JSON.stringify(loaded[1]) : 'silent');
check('every code lands in every shop', (await one(`SELECT COUNT(*)::int AS n FROM stock_items`)).n === 6,
  `${(await one(`SELECT COUNT(*)::int AS n FROM stock_items`)).n}`);
check('each shop gets its own count',
  (await one(`SELECT qty FROM stock_items si JOIN shops sh ON sh.id = si.shop_id
               WHERE sh.code = 'GD' AND si.sku = 'NI-1005'`)).qty === 3,
  'the wrong column was read');
check('a code counted at zero is still on the list',
  (await one(`SELECT qty FROM stock_items si JOIN shops sh ON sh.id = si.shop_id
               WHERE sh.code = 'OF' AND si.sku = 'GI-2009'`)).qty === 0, 'it was skipped');
check('and it carries its price, fabric and colour',
  (await one(`SELECT price, fabric, color FROM stock_items WHERE sku = 'NI-1005' LIMIT 1`)).fabric === 'RAYON KRINKLE',
  'the description was lost');

console.log('\n  every boot after, once the shop is counting for itself');
await db.query(`UPDATE stock_items SET qty = 99 WHERE sku = 'NI-1005'`);
await db.query(`DELETE FROM stock_items WHERE sku = 'GI-2009' AND shop_id = 2`);
logs.length = 0;
await seed();
check('a count the shop has changed is left exactly alone',
  (await one(`SELECT MIN(qty)::int AS q FROM stock_items WHERE sku = 'NI-1005'`)).q === 99,
  'the loader reset the shelves');
check('but a code the shop no longer has is put back, at its opening count',
  (await one(`SELECT qty FROM stock_items WHERE sku = 'GI-2009' AND shop_id = 2`)).qty === 2,
  'it stayed missing');
check('nothing is duplicated',
  (await one(`SELECT COUNT(*)::int AS n FROM stock_items`)).n === 6, 'rows were doubled');

// ── One garment, one name ────────────────────────────────────────────────
console.log('\n  the history calls a garment what the shelf calls it');
await db.query(`INSERT INTO imported_sales (shop_id, source, sku, name, style, fabric, color, size, sold_on, units, value)
                VALUES (2,'book','NI-1005','NICOL DRESS BLACK','NICOL DRESS','KRINKLE','BLACK','O/S','2026-03-01',1,900000),
                       (2,'book','GONE-9','OLD KAFTAN','OLD KAFTAN','RAMIE','RUSH','O/S','2026-03-02',1,500000)`);

// The shipped view of a book line, with only the business id filled in.
const ledgerSql = grab('const LEDGER_SELECT = `', '`;')
  .replace('const LEDGER_SELECT = `', '')
  .replace(/`;$/, '')
  .replace(/\$\{LEDGER_PRICE_SQL\}/g, 'ROUND(i.value / NULLIF(i.units, 0))');
const seenRows = (await db.query(`${ledgerSql} WHERE sh.business_id = $1 ORDER BY i.id`, [1])).rows;
const byCode = Object.fromEntries(seenRows.map(r => [r.sku, r]));

check('a code the shop stocks takes the shelf\'s spelling',
  byCode['NI-1005'].item_name === 'NICOLE DRESS BLACK', byCode['NI-1005'].item_name);
check('and the shelf\'s fabric with it',
  byCode['NI-1005'].fabric === 'RAYON KRINKLE', byCode['NI-1005'].fabric);
check('the code itself is never rewritten', byCode['NI-1005'].sku === 'NI-1005', byCode['NI-1005'].sku);
check('a code no shop carries keeps the name the book gave it',
  byCode['GONE-9'].item_name === 'OLD KAFTAN' && byCode['GONE-9'].fabric === 'RAMIE',
  `${byCode['GONE-9'].item_name} / ${byCode['GONE-9'].fabric}`);

// The shelf is read across shops, because a shop sells garments another
// shop holds — but its own shelf is preferred when both have the code.
await db.query(`UPDATE stock_items SET name = 'NICOLE DRESS BLACK (GOLDUST)' WHERE sku = 'NI-1005' AND shop_id = 2`);
const again = (await db.query(`${ledgerSql} WHERE sh.business_id = $1 AND i.sku = 'NI-1005'`, [1])).rows[0];
check('and the selling shop\'s own shelf is the one that decides',
  again.item_name === 'NICOLE DRESS BLACK (GOLDUST)', again.item_name);

console.log('\n  what the code guarantees');
const fn = grab('async function seedOpeningStock() {', '\n}');
check('the loader only ever inserts', !/UPDATE stock_items|DELETE FROM stock_items/.test(fn),
  'it rewrites what is on the shelves');
check('and skips a code the shop already holds', /already\.has\(sku\)/.test(fn), 'it would double up');
check('a code is matched to the shelf by code, never by name',
  /UPPER\(si\.sku\) = i\.sku/.test(src), 'names are matched to names');

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
