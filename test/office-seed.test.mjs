// Seeding Office's opening stock, against REAL Postgres.
//
// This writes a shop's whole catalogue in one go, so the checks that matter
// are the ones that stop it doing that twice: it must not run into a shop
// that already has stock, because the counts are an opening balance and a
// redeploy would silently undo however much had been sold since.
import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';
import { createRequire } from 'module';

// Rooted at server.js, not at this file — the seeder's own require('./…')
// has to resolve the way it does in production.
const require = createRequire(new URL('../server.js', import.meta.url));
const OFFICE = require('./office-stock.js');
const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');

const db = new PGlite();
await db.exec(`
  CREATE TABLE businesses (id SERIAL PRIMARY KEY, name TEXT);
  CREATE TABLE shops (id SERIAL PRIMARY KEY, business_id INT, name TEXT, code TEXT);
  CREATE TABLE stock_items (
    id SERIAL PRIMARY KEY, shop_id INT REFERENCES shops(id) ON DELETE CASCADE,
    name TEXT, category TEXT, fabric TEXT, print TEXT, size TEXT, color TEXT,
    sku TEXT, brand TEXT, qty INT DEFAULT 0, threshold INT DEFAULT 0,
    supplier TEXT, notes TEXT, position INT DEFAULT 0, image_url TEXT,
    price NUMERIC(14,2) DEFAULT 0, cost NUMERIC(14,2) DEFAULT 0,
    last_sold_at TIMESTAMPTZ, updated_at TIMESTAMPTZ DEFAULT NOW()
  );
  INSERT INTO businesses (name) VALUES ('Boutique');
  INSERT INTO shops (business_id, name, code) VALUES
    (1,'Rose Gold','RG'), (1,'Atriq','AT'), (1,'Goldust','GD'), (1,'Office','OF');
`);

// A stand-in Rose Gold catalogue: every code Office needs, plus some it does
// not, plus one code Office lists that Rose Gold has never heard of.
const codes = Object.keys(OFFICE);
const catalogue = codes.filter(c => c !== 'SS-1002')   // held back on purpose
  .concat(['ZZ-9001', 'ZZ-9002']);                     // Rose Gold extras
for (const sku of catalogue) {
  await db.query(
    `INSERT INTO stock_items (shop_id, name, category, fabric, size, color, sku, qty, price, last_sold_at)
     VALUES (1, $1, 'CAT', 'FAB', 'O/S', 'COLOUR', $2, 5, 950000, NOW())`,
    [`ITEM ${sku}`, sku]
  );
}

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : '  — ' + detail}`);
  if (!ok) failures++;
};
const one = async (sql, p) => (await db.query(sql, p)).rows[0];

// ── The shipped seeder, run as-is ────────────────────────────────────────
const a = src.indexOf('async function seedOfficeStock() {');
const b = src.indexOf('\n}\n', a);
const body = src.slice(a, b + 3);
const logs = [];
const logger = { info: (k, v) => logs.push([k, v]), warn: (k, v) => logs.push([k, v]), error: (k, v) => logs.push([k, v]) };
const pool = { connect: async () => ({ query: (t, p) => db.query(t, p), release() {} }) };
const seed = new Function('pool', 'logger', 'require', `${body} return seedOfficeStock;`)(pool, logger, require);

console.log('\nReal Postgres · seeding Office\n');

check('the seeder was found in server.js', /office\.seed\.done/.test(body), 'extraction missed it');

console.log('  the first run');
await seed();
const after = await one('SELECT COUNT(*)::int AS n, SUM(qty)::int AS pieces FROM stock_items WHERE shop_id = 4');
check('Office gets the whole catalogue', after.n === catalogue.length, `${after.n} of ${catalogue.length}`);

// Every code that exists in both should carry its sheet quantity.
const wrong = [];
for (const sku of codes) {
  const row = await one('SELECT qty FROM stock_items WHERE shop_id=4 AND sku=$1', [sku]);
  if (!row) continue;                       // the deliberately-missing one
  if (Number(row.qty) !== OFFICE[sku]) wrong.push(`${sku}: ${row.qty} not ${OFFICE[sku]}`);
}
check('every code lands on its sheet quantity', wrong.length === 0, wrong.slice(0, 5).join(' · '));

const expectedPieces = codes.filter(c => c !== 'SS-1002').reduce((n, c) => n + OFFICE[c], 0);
check(`the pieces add up to ${expectedPieces}`, Number(after.pieces) === expectedPieces,
  `${after.pieces} pieces`);

const spares = await one(`SELECT qty FROM stock_items WHERE shop_id=4 AND sku='ZZ-9001'`);
check('a garment Office does not stock seeds at zero', Number(spares.qty) === 0, `qty ${spares.qty}`);

const lastSold = await one('SELECT COUNT(*)::int AS n FROM stock_items WHERE shop_id=4 AND last_sold_at IS NOT NULL');
check('Rose Gold’s selling dates are not copied across', lastSold.n === 0, `${lastSold.n} carried over`);

const roseGold = await one('SELECT COUNT(*)::int AS n, SUM(qty)::int AS pieces FROM stock_items WHERE shop_id = 1');
check('Rose Gold is untouched', roseGold.n === catalogue.length && Number(roseGold.pieces) === catalogue.length * 5,
  `${roseGold.n} items / ${roseGold.pieces} pieces`);

const done = logs.find(l => l[0] === 'office.seed.done');
check('the code Rose Gold has never listed is reported, not silently dropped',
  done && done[1].missing === 'SS-1002', done ? done[1].missing : 'no log line');

// ── The guard ────────────────────────────────────────────────────────────
console.log('\n  running it again after some selling');
await db.query(`UPDATE stock_items SET qty = 0 WHERE shop_id = 4 AND sku = 'CH-1001'`);
await db.query(`UPDATE stock_items SET qty = 1 WHERE shop_id = 4 AND sku = 'SA-1002'`);
const before = await one('SELECT COUNT(*)::int AS n, SUM(qty)::int AS pieces FROM stock_items WHERE shop_id = 4');
await seed();
const unchanged = await one('SELECT COUNT(*)::int AS n, SUM(qty)::int AS pieces FROM stock_items WHERE shop_id = 4');
check('nothing is duplicated', unchanged.n === before.n, `${before.n} → ${unchanged.n}`);
check('a sold-out garment is not refilled', Number((await one(`SELECT qty FROM stock_items WHERE shop_id=4 AND sku='CH-1001'`)).qty) === 0,
  'the opening balance was written back over real trading');
check('the quantities are left exactly as they were',
  Number(unchanged.pieces) === Number(before.pieces), `${before.pieces} → ${unchanged.pieces}`);

// ── Nothing to copy from ─────────────────────────────────────────────────
console.log('\n  when there is no catalogue to copy');
await db.exec('DELETE FROM stock_items');
logs.length = 0;
await seed();
const empty = await one('SELECT COUNT(*)::int AS n FROM stock_items WHERE shop_id = 4');
check('it does nothing rather than creating a shop full of nothing', empty.n === 0, `${empty.n} rows`);
check('and says why', logs.some(l => l[0] === 'office.seed.skipped'), 'no explanation logged');

// ── The data itself ──────────────────────────────────────────────────────
console.log('\n  the sheet data');
check('every quantity is a positive whole number',
  Object.values(OFFICE).every(v => Number.isInteger(v) && v > 0), 'a bad quantity is in the list');
check('every code looks like a product code',
  Object.keys(OFFICE).every(k => /^[A-Z]{2,4}-\d+$/.test(k)), 'a malformed code is in the list');
check('the #REF! rows were left out',
  !['AG-2009', 'AG-2013', 'AG-2018', 'AG-2021'].some(c => c in OFFICE),
  'a broken-formula row was imported');
console.log(`  ${Object.keys(OFFICE).length} codes, ${Object.values(OFFICE).reduce((a, b) => a + b, 0)} pieces`);

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
