// Percentage discounts, against REAL Postgres.
//
// A discount changes what the shop actually took, so the danger is not the
// multiplication — it is a revenue query that was written before discounts
// existed and still totals the ticket price. That reads plausibly and never
// reconciles with the till, so the checks below go through the shipped SQL
// rather than through arithmetic written here.
import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';

const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');

const db = new PGlite();
await db.exec(`
  CREATE TABLE businesses (id SERIAL PRIMARY KEY, name TEXT);
  CREATE TABLE shops (id SERIAL PRIMARY KEY, business_id INT, name TEXT, code TEXT);
  CREATE TABLE stock_items (
    id SERIAL PRIMARY KEY, shop_id INT REFERENCES shops(id) ON DELETE CASCADE,
    name TEXT, sku TEXT, qty INT DEFAULT 0,
    price NUMERIC(14,2) DEFAULT 0, cost NUMERIC(14,2) DEFAULT 0
  );
  CREATE TABLE stock_movements (
    id SERIAL PRIMARY KEY, item_id INT REFERENCES stock_items(id) ON DELETE CASCADE,
    shop_id INT, type TEXT, qty_change INT, qty_after INT,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), note TEXT DEFAULT '',
    staff_name TEXT DEFAULT '', staff_id INT, reason TEXT DEFAULT '',
    unit_price NUMERIC(14,2), payment TEXT DEFAULT '', discount_pct NUMERIC(5,2) DEFAULT 0
  );
  INSERT INTO businesses (name) VALUES ('Boutique');
  INSERT INTO shops (business_id, name, code) VALUES (1,'Rose Gold','RG');
  INSERT INTO stock_items (shop_id, name, sku, qty, price, cost) VALUES
    (1,'INDIGO DRESS','IN-3011', 20, 1500000, 500000),
    (1,'BUBBLE KAFTAN','BU-3040', 20, 1350000, 400000);
`);

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : '  — ' + detail}`);
  if (!ok) failures++;
};

// ── The shipped normaliser ───────────────────────────────────────────────
const grab = (start, end) => {
  const a = src.indexOf(start);
  const b = src.indexOf(end, a);
  if (a < 0 || b < 0) throw new Error('could not extract ' + start);
  return src.slice(a, b + end.length);
};
const cleanDiscount = new Function(`${grab('const cleanDiscount =', '\n};')} return cleanDiscount;`)();

console.log('\nReal Postgres · percentage discounts\n');

console.log('  what counts as a percentage');
check('a plain number passes', cleanDiscount(15) === 15, String(cleanDiscount(15)));
check('a typed string passes', cleanDiscount('20') === 20, String(cleanDiscount('20')));
check('blank is no discount', cleanDiscount('') === 0, String(cleanDiscount('')));
check('nonsense is no discount', cleanDiscount('half') === 0, String(cleanDiscount('half')));
check('undefined is no discount', cleanDiscount(undefined) === 0, String(cleanDiscount(undefined)));
check('a negative is clamped to zero, not treated as a surcharge',
  cleanDiscount(-30) === 0, String(cleanDiscount(-30)));
check('over a hundred is clamped, so the shop never pays the customer',
  cleanDiscount(250) === 100, String(cleanDiscount(250)));
check('a fraction is rounded to whole percent', cleanDiscount(12.4) === 12, String(cleanDiscount(12.4)));
check('an array cannot be smuggled in', cleanDiscount(['15']) === 0, String(cleanDiscount(['15'])));

console.log('\n  only a sale is discounted');
check('the scan handler zeroes it for anything else',
  /const discountPct = type === 'sale' \? cleanDiscount\(req\.body\.discountPct\) : 0;/.test(src),
  'the guard is missing');

// ── The real SQL ─────────────────────────────────────────────────────────
const value = (decl, end) =>
  // eslint-disable-next-line no-eval
  eval(grab(decl, end).slice(decl.length).replace(/;$/, ''));
const SALE_PRICE_SQL = value('const SALE_PRICE_SQL =', ';');
const SALE_NET_SQL = value('const SALE_NET_SQL =', ';');
const NET_UNITS_SQL = value('const NET_UNITS_SQL =', ';');

console.log('\n  the net price is what was charged');
check('the net formula uses the discount', /discount_pct/.test(SALE_NET_SQL), SALE_NET_SQL);
check('and it is built from the ticket price', SALE_NET_SQL.includes('unit_price'), SALE_NET_SQL);

await db.query(`INSERT INTO stock_movements (item_id, shop_id, type, qty_change, qty_after, discount_pct, unit_price) VALUES
  (1,1,'sale', -1, 19,  0,    NULL),   -- full price 1,500,000
  (1,1,'sale', -2, 17, 20,    NULL),   -- 20% off -> 1,200,000 each
  (2,1,'sale', -1, 19, 15,    NULL),   -- 15% off 1,350,000 -> 1,147,500
  (1,1,'sale', -1, 16, 10, 1000000),   -- agreed 1,000,000 then 10% -> 900,000
  (1,1,'in',   10, 26,  0,    NULL)`);

const netOf = async (id) => Number((await db.query(
  `SELECT ${SALE_NET_SQL} AS net FROM stock_movements m
   JOIN stock_items si ON si.id = m.item_id WHERE m.id = $1`, [id])).rows[0].net);

check('no discount charges the ticket price', await netOf(1) === 1500000, String(await netOf(1)));
check('20% off 1,500,000 is 1,200,000', await netOf(2) === 1200000, String(await netOf(2)));
check('15% off 1,350,000 is 1,147,500', await netOf(3) === 1147500, String(await netOf(3)));
check('a discount applies to an agreed price, not to the shelf price',
  await netOf(4) === 900000, String(await netOf(4)));

console.log('\n  the totals');
const revenue = async () => Number((await db.query(
  `SELECT COALESCE(SUM(${NET_UNITS_SQL} * ${SALE_NET_SQL}),0)::numeric AS revenue
   FROM stock_movements m JOIN stock_items si ON si.id = m.item_id`)).rows[0].revenue);
// 1,500,000 + 2×1,200,000 + 1,147,500 + 900,000
const expected = 1500000 + 2 * 1200000 + 1147500 + 900000;
check(`revenue is ${expected.toLocaleString()}, net of every discount`,
  await revenue() === expected, String(await revenue()));

const ticket = Number((await db.query(
  `SELECT COALESCE(SUM(${NET_UNITS_SQL} * ${SALE_PRICE_SQL}),0)::numeric AS r
   FROM stock_movements m JOIN stock_items si ON si.id = m.item_id`)).rows[0].r);
check('and it is genuinely lower than the ticket total',
  await revenue() < ticket, `net ${await revenue()} vs ticket ${ticket}`);

// Every money figure in the file has to use the net, not the ticket price.
console.log('\n  no revenue query left on the ticket price');
const moneyLines = src.split('\n')
  .map((l, i) => ({ l, i: i + 1 }))
  .filter(x => /SUM\(/.test(x.l) && /SALE_PRICE_SQL/.test(x.l));
check('nothing sums the ticket price any more', moneyLines.length === 0,
  moneyLines.map(x => `line ${x.i}: ${x.l.trim().slice(0, 70)}`).join(' · '));
const netUses = (src.match(/SALE_NET_SQL/g) || []).length;
check('the net is used in several places', netUses >= 5, `${netUses} uses`);

console.log('\n  a stock-in is never discounted');
check('the delivery carries no discount',
  Number((await db.query(`SELECT discount_pct FROM stock_movements WHERE type='in'`)).rows[0].discount_pct) === 0,
  'a delivery was discounted');

console.log('\n  correcting it');
check('the correction endpoint accepts a percentage',
  /discountPct: z\.coerce\.number\(\)\.min\(0\)\.max\(100\)\.optional\(\)/.test(src), 'not in the schema');
check('it normalises through the same function',
  /cleanDiscount\(req\.body\.discountPct\)/.test(src), 'the correction path does not normalise');
check('it is written to the row', /discount_pct = \$8/.test(src), 'not in the UPDATE');
check('the audit log carries the before value',
  /discountPct: Number\(move\.discount_pct\) \|\| 0/.test(src), 'not in the audit entry');
// Leaving it out must not silently clear an existing discount.
const keep = (body, current) => (body.discountPct === undefined ? current : cleanDiscount(body.discountPct));
check('an edit that does not mention it leaves it alone', keep({}, 20) === 20, String(keep({}, 20)));
check('an edit can change it', keep({ discountPct: 5 }, 20) === 5, String(keep({ discountPct: 5 }, 20)));
check('an edit can remove it', keep({ discountPct: 0 }, 20) === 0, String(keep({ discountPct: 0 }, 20)));

console.log('\n  sales taken before discounts existed');
await db.query(`INSERT INTO stock_movements (item_id, shop_id, type, qty_change, qty_after)
                VALUES (1, 1, 'sale', -1, 15)`);
const { rows: old } = await db.query('SELECT discount_pct FROM stock_movements ORDER BY id DESC LIMIT 1');
check('default to no discount', Number(old[0].discount_pct) === 0, String(old[0].discount_pct));
check('the column defaults to zero rather than to null',
  /ADD COLUMN IF NOT EXISTS discount_pct NUMERIC\(5,2\) DEFAULT 0/.test(src), 'wrong default');

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
