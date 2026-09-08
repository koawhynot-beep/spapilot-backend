// Takings per seller, against REAL Postgres.
//
// "Totalan penjualan per nama yang jualan" — what each person sold. The
// checks that matter are that returns come off, that discounts come off, and
// that a sale with no name recorded is still counted somewhere: a page of
// totals that quietly disagrees with the sales list is worse than no page.
import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';

const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');

const db = new PGlite();
await db.exec(`
  CREATE TABLE shops (id SERIAL PRIMARY KEY, business_id INT, name TEXT, code TEXT);
  CREATE TABLE stock_items (
    id SERIAL PRIMARY KEY, shop_id INT, name TEXT, sku TEXT,
    qty INT DEFAULT 0, price NUMERIC(14,2) DEFAULT 0, cost NUMERIC(14,2) DEFAULT 0
  );
  CREATE TABLE stock_movements (
    id SERIAL PRIMARY KEY, item_id INT, shop_id INT, type TEXT,
    qty_change INT, qty_after INT, occurred_at TIMESTAMPTZ DEFAULT NOW(),
    unit_price NUMERIC(14,2), discount_pct NUMERIC(5,2) DEFAULT 0,
    payment TEXT DEFAULT '', staff_id INT, staff_name TEXT DEFAULT '', reason TEXT DEFAULT ''
  );
  INSERT INTO shops (business_id, name, code) VALUES (1,'Rose Gold','RG');
  INSERT INTO stock_items (shop_id, name, sku, qty, price) VALUES (1,'DRESS','D-1', 999, 1000000);
`);

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : '  — ' + detail}`);
  if (!ok) failures++;
};

const grab = (decl, end) => {
  const a = src.indexOf(decl);
  const b = src.indexOf(end, a);
  return src.slice(a, b + end.length);
};
// eslint-disable-next-line no-eval
const value = (decl, end) => eval(grab(decl, end).slice(decl.length).replace(/;$/, ''));

const SALE_TYPES_SQL = value('const SALE_TYPES_SQL =', ';');
const NET_UNITS_SQL = value('const NET_UNITS_SQL =', ';');
// eslint-disable-next-line no-unused-vars
const SALE_PRICE_SQL = value('const SALE_PRICE_SQL =', ';');
const SALE_NET_SQL = value('const SALE_NET_SQL =', ';');

console.log('\nReal Postgres · takings per seller\n');

// Wayan: two at full price, one returned.       2,000,000 - 1,000,000
// Komang: one at 20% off.                       800,000
// Nobody: one sale with the name left blank.    1,000,000
await db.query(`INSERT INTO stock_movements (item_id, shop_id, type, qty_change, qty_after, unit_price, discount_pct, staff_id, staff_name) VALUES
  (1,1,'sale',  -2,0, 1000000, 0,  7,'Wayan'),
  (1,1,'return',  1,0, 1000000, 0,  7,'Wayan'),
  (1,1,'sale',  -1,0, 1000000, 20, 8,'Komang'),
  (1,1,'sale',  -1,0, 1000000, 0,  NULL,'')`);

const byStaff = async () => (await db.query(
  `SELECT COALESCE(NULLIF(m.staff_name,''), '') AS name,
          MIN(m.staff_id) AS staff_id,
          COUNT(*)::int AS entries,
          COALESCE(SUM(${NET_UNITS_SQL}),0)::int AS units,
          COALESCE(SUM(${NET_UNITS_SQL} * ${SALE_NET_SQL}),0)::numeric AS revenue
     FROM stock_movements m
     JOIN stock_items si ON si.id = m.item_id
     JOIN shops sh ON sh.id = m.shop_id
    WHERE sh.business_id = $1 AND ${SALE_TYPES_SQL}
    GROUP BY 1
    ORDER BY (COALESCE(NULLIF(m.staff_name,''), '') = '') ASC,
             COALESCE(SUM(${NET_UNITS_SQL} * ${SALE_NET_SQL}),0) DESC,
             1 ASC`, [1]
)).rows.map(r => ({ ...r, revenue: Number(r.revenue) }));

const rows = await byStaff();
const by = (n) => rows.find(r => r.name === n);

check('one row per name, biggest first, the unnamed row last',
  rows.map(r => r.name || '(blank)').join(',') === 'Wayan,Komang,(blank)',
  rows.map(r => r.name || '(blank)').join(','));
check('the unnamed row sorts last even when it out-earns a person',
  rows[rows.length - 1].name === '', rows.map(r => r.name).join(','));
check('a return comes off the seller who made it',
  by('Wayan').units === 1 && by('Wayan').revenue === 1000000,
  `${by('Wayan').units} pieces / ${by('Wayan').revenue}`);
check('the return still shows as an entry, so the count matches the log',
  by('Wayan').entries === 2, String(by('Wayan').entries));
check('a discount comes off the total, so nobody is flattered by it',
  by('Komang').revenue === 800000, String(by('Komang').revenue));
check('a sale with no name is kept, under a blank name',
  by('').units === 1 && by('').revenue === 1000000,
  JSON.stringify(by('')));

const sum = rows.reduce((n, r) => n + r.revenue, 0);
const { rows: [whole] } = await db.query(
  `SELECT COALESCE(SUM(${NET_UNITS_SQL} * ${SALE_NET_SQL}),0)::numeric AS revenue
     FROM stock_movements m JOIN stock_items si ON si.id = m.item_id
    WHERE ${SALE_TYPES_SQL}`);
check('the rows add up to the whole period, with nothing lost',
  sum === Number(whole.revenue), `${sum} vs ${whole.revenue}`);

// ── What the endpoint enforces ───────────────────────────────────────────
console.log('\n  the endpoint');
check('it exists', src.includes(`app.get('/api/sales/by-staff'`), 'no route');
check('it is admin-only — one person’s takings are not another’s business',
  /app\.get\('\/api\/sales\/by-staff', auth, requireAdmin/.test(src), 'requireAdmin missing');
check('it respects the period and shop filters on screen',
  /by-staff[\s\S]{0,600}salesFilter\(req, 3\)/.test(src), 'salesFilter not applied');
check('revenue is net of discounts, not the ticket price',
  /by-staff[\s\S]{0,900}SALE_NET_SQL/.test(src), 'it sums the undiscounted price');
check('the ordering is written out, not left to a column number',
  !/ORDER BY 5 DESC/.test(src), 'ORDER BY 5 breaks the moment a column is added');

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
