// Two years of sales out of the hand-kept workbook, against REAL Postgres.
//
// The dangerous thing about loading history is that it looks like trade. If
// these entries moved stock the way a real sale does, every shop's count
// would drop by two years of selling that has already happened — and the
// figures would look plausible while being wrong by thousands of pieces.
// Most of what follows is checking that nothing moved.
import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';
import { createRequire } from 'module';

const require = createRequire(new URL('../server.js', import.meta.url));
const SHEET = require('./sales-history.js');
const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');

const db = new PGlite();
await db.exec(`
  CREATE TABLE businesses (id SERIAL PRIMARY KEY, name TEXT);
  CREATE TABLE shops (id SERIAL PRIMARY KEY, business_id INT, name TEXT, code TEXT);
  CREATE TABLE stock_items (
    id SERIAL PRIMARY KEY, shop_id INT REFERENCES shops(id) ON DELETE CASCADE,
    name TEXT, category TEXT DEFAULT '', fabric TEXT DEFAULT '', print TEXT DEFAULT '',
    size TEXT DEFAULT '', color TEXT DEFAULT '', sku TEXT, brand TEXT DEFAULT '',
    qty INT DEFAULT 0, threshold INT DEFAULT 0, supplier TEXT DEFAULT '',
    notes TEXT DEFAULT '', position INT DEFAULT 0, image_url TEXT DEFAULT '',
    price NUMERIC(14,2) DEFAULT 0, cost NUMERIC(14,2) DEFAULT 0,
    updated_at TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE TABLE stock_movements (
    id SERIAL PRIMARY KEY, item_id INT NOT NULL, shop_id INT NOT NULL, user_id INT,
    type TEXT NOT NULL, qty_change INT NOT NULL, qty_after INT NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    unit_price NUMERIC(14,2), discount_pct NUMERIC(5,2) DEFAULT 0,
    payment TEXT DEFAULT '', staff_id INT, staff_name TEXT DEFAULT '',
    reason TEXT DEFAULT '', note TEXT DEFAULT ''
  );
  INSERT INTO businesses (name) VALUES ('Boutique');
  INSERT INTO shops (business_id, name, code) VALUES
    (1,'Rose Gold','RG'), (1,'Atriq','AT'), (1,'Goldust','GD'), (1,'Office','OF');
`);

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : '  — ' + detail}`);
  if (!ok) failures++;
};
const one = async (sql, p) => (await db.query(sql, p)).rows[0];

console.log('\nReal Postgres · two years of sales from the sheet\n');

// ── The sheet itself ─────────────────────────────────────────────────────
console.log('  the data');
const pieces = SHEET.sales.reduce((n, s) => n + s[4], 0);
console.log(`  ${SHEET.items.length} products · ${SHEET.sales.length} month-entries · ${pieces} pieces`);
check('every code looks like a product code',
  SHEET.items.every(i => /^[A-Z]{2,4}-\d+$/.test(i.sku)), 'a malformed code is in the list');
check('every entry names one of the three shops',
  SHEET.sales.every(s => ['GD', 'RG', 'AT'].includes(s[1])),
  [...new Set(SHEET.sales.map(s => s[1]))].join(','));
check('every quantity is a positive whole number',
  SHEET.sales.every(s => Number.isInteger(s[4]) && s[4] > 0), 'a bad quantity is in the list');
check('every month is a real month, in 2025 or 2026',
  SHEET.sales.every(s => (s[2] === 2025 || s[2] === 2026) && s[3] >= 1 && s[3] <= 12),
  'a bad date is in the list');
check('every entry points at a product the file describes',
  SHEET.sales.every(s => SHEET.items.some(i => i.sku === s[0])), 'an entry has no product');
check('no product is listed twice',
  new Set(SHEET.items.map(i => i.sku)).size === SHEET.items.length, 'a duplicate code');
check('no shop, month and product is entered twice',
  new Set(SHEET.sales.map(s => s.slice(0, 4).join('|'))).size === SHEET.sales.length,
  'the same month is entered twice for one product');
check('the file says the day is not known, so nobody reads one into it',
  /never a day/.test(fs.readFileSync(new URL('../sales-history.js', import.meta.url), 'utf8')),
  'the file does not say where the dates came from');

// ── A shop with real stock, so the "nothing moved" check has teeth ───────
// Rose Gold carries a handful of the codes; Goldust carries none of them.
const rgSkus = [...new Set(SHEET.sales.filter(s => s[1] === 'RG').map(s => s[0]))].slice(0, 40);
for (const sku of rgSkus) {
  const d = SHEET.items.find(i => i.sku === sku);
  await db.query(
    `INSERT INTO stock_items (shop_id, name, category, fabric, size, color, sku, qty, price)
     VALUES (1, $1, $2, $3, $4, $5, $6, 7, 950000)`,
    [`${d.style} ${d.color}`.trim(), d.style, d.fabric, d.size, d.color, sku]
  );
}
const before = await one(`SELECT COUNT(*)::int AS n, COALESCE(SUM(qty),0)::int AS pieces FROM stock_items`);

// ── The shipped seeder, run as it ships ─────────────────────────────────
const grab = (decl, end) => {
  const a = src.indexOf(decl);
  const b = src.indexOf(end, a);
  if (a < 0 || b < 0) throw new Error('could not extract ' + decl);
  return src.slice(a, b + end.length);
};
const logs = [];
const logger = { info: (k, v) => logs.push([k, v]), warn: (k, v) => logs.push([k, v]), error: (k, v) => logs.push([k, v]) };
const pool = { connect: async () => ({ query: (t, p) => db.query(t, p), release() {} }) };
const seed = new Function('pool', 'logger', 'require', `
  ${grab('const SALES_IMPORT_NOTE =', ';')}
  ${grab('async function seedSalesHistory() {', '\n}')}
  return seedSalesHistory;
`)(pool, logger, require);

console.log('\n  the first run');
await seed();
const done = logs.find(l => l[0] === 'sales.seed.done');
check('it says what it did', Boolean(done), 'silent');

const moves = await one(
  `SELECT COUNT(*)::int AS n, COALESCE(SUM(-qty_change),0)::int AS pieces FROM stock_movements`);
check(`all ${SHEET.sales.length} entries land`, moves.n === SHEET.sales.length, `${moves.n}`);
check(`all ${pieces} pieces land`, moves.pieces === pieces, `${moves.pieces}`);
check('nothing was skipped', done && done[1].skippedPieces === 0,
  done ? String(done[1].skippedPieces) : '?');

console.log('\n  nothing moved');
const after = await one(`SELECT COUNT(*)::int AS n, COALESCE(SUM(qty),0)::int AS pieces FROM stock_items`);
check('not one piece came off the shelves',
  after.pieces === before.pieces, `${before.pieces} → ${after.pieces}`);
check('the shops that already stocked a garment kept their own count',
  Number((await one(`SELECT qty FROM stock_items WHERE shop_id=1 AND sku=$1`, [rgSkus[0]])).qty) === 7,
  'a count was changed');
check('a garment a shop sold but no longer lists is added, at zero',
  after.n > before.n
  && Number((await one(`SELECT COALESCE(SUM(qty),0)::int AS q FROM stock_items WHERE shop_id = 3`)).q) === 0,
  'the new rows did not come in at zero');
check('and it is described, not left as a bare code',
  Boolean((await one(`SELECT fabric, color FROM stock_items WHERE shop_id=3 LIMIT 1`)).color),
  'the new rows carry no detail');

console.log('\n  what the entries say');
const sample = await one(
  `SELECT type, note, occurred_at, unit_price FROM stock_movements ORDER BY id LIMIT 1`);
check('they are sales', sample.type === 'sale', sample.type);
check('each one says it came from the sheet and has no day of its own',
  /sales sheet/.test(sample.note) && /no day/.test(sample.note), sample.note);
const days = await db.query(
  `SELECT DISTINCT EXTRACT(DAY FROM (occurred_at AT TIME ZONE 'Asia/Makassar'))::int AS d
     FROM stock_movements`);
check('every entry sits on the 15th of its month, locally',
  days.rows.length === 1 && days.rows[0].d === 15,
  days.rows.map(r => r.d).join(','));
const priced = await one(
  `SELECT COUNT(*) FILTER (WHERE unit_price > 0)::int AS n FROM stock_movements`);
check('sales of a garment with a known price are valued at it', priced.n > 0, '0 priced');

const years = await db.query(
  `SELECT EXTRACT(YEAR FROM (occurred_at AT TIME ZONE 'Asia/Makassar'))::int AS y,
          SUM(-qty_change)::int AS pieces FROM stock_movements GROUP BY 1 ORDER BY 1`);
const byYear = Object.fromEntries(years.rows.map(r => [r.y, r.pieces]));
const wantYear = {};
for (const s of SHEET.sales) wantYear[s[2]] = (wantYear[s[2]] || 0) + s[4];
check('the years add up to what the sheet says',
  Object.keys(wantYear).every(y => byYear[y] === wantYear[y])
  && Object.keys(byYear).length === Object.keys(wantYear).length,
  `${JSON.stringify(byYear)} vs ${JSON.stringify(wantYear)}`);

const shops = await db.query(
  `SELECT sh.code, SUM(-m.qty_change)::int AS pieces
     FROM stock_movements m JOIN shops sh ON sh.id = m.shop_id GROUP BY 1 ORDER BY 1`);
const byShop = Object.fromEntries(shops.rows.map(r => [r.code, r.pieces]));
const wantShop = {};
for (const s of SHEET.sales) wantShop[s[1]] = (wantShop[s[1]] || 0) + s[4];
// Compared key by key: two objects holding the same figures in a different
// order are the same answer.
const same = (a, b) => {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  return keys.every(k => a[k] === b[k]);
};
check('and so do the shops', same(byShop, wantShop),
  `${JSON.stringify(byShop)} vs ${JSON.stringify(wantShop)}`);

console.log('\n  the running balance');
const negative = await one(`SELECT COUNT(*)::int AS n FROM stock_movements WHERE qty_after < 0`);
check('no entry claims a shop went below zero', negative.n === 0, `${negative.n} do`);
// The last sale of a garment must leave the count that is actually there.
const tail = await one(
  `SELECT m.qty_after, si.qty FROM stock_movements m
     JOIN stock_items si ON si.id = m.item_id
    WHERE si.shop_id = 1 AND si.sku = $1
    ORDER BY m.occurred_at DESC, m.id DESC LIMIT 1`, [rgSkus[0]]);
check('the last entry for a garment lands on the count it has today',
  Number(tail.qty_after) === Number(tail.qty), `${tail.qty_after} vs ${tail.qty}`);

console.log('\n  running it again');
logs.length = 0;
await seed();
const twice = await one(`SELECT COUNT(*)::int AS n FROM stock_movements`);
check('a second run adds nothing', twice.n === SHEET.sales.length, `${twice.n}`);
check('and it does not say it did anything',
  !logs.some(l => l[0] === 'sales.seed.done'), 'it ran again');

console.log('\n  what the code guarantees');
check('the guard is the note, so the marker cannot be edited loosely',
  /WHERE note = \$1 LIMIT 1/.test(src), 'no guard');
check('no UPDATE of stock_items qty anywhere in the seeder',
  !/UPDATE stock_items[\s\S]{0,200}SET qty/.test(grab('async function seedSalesHistory() {', '\n}')),
  'the seeder changes a quantity');

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
