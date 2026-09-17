// One garment in all its sizes, against REAL Postgres.
//
// The thing that has to be right is the grouping. The S/M and the M/L of one
// pant carry unrelated codes, so the only way to put them on one card is by
// what the garment is — style, fabric, colour — and that match must be tight
// enough that the Baby Blue pant does not pull in the Black one.
import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';

const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');

const db = new PGlite();
await db.exec(`
  CREATE TABLE shops (id SERIAL PRIMARY KEY, business_id INT, name TEXT, code TEXT);
  CREATE TABLE stock_items (
    id SERIAL PRIMARY KEY, shop_id INT, name TEXT, category TEXT DEFAULT '',
    fabric TEXT DEFAULT '', color TEXT DEFAULT '', size TEXT DEFAULT '', sku TEXT,
    qty INT DEFAULT 0, price NUMERIC(14,2) DEFAULT 0, cost NUMERIC(14,2) DEFAULT 0
  );
  CREATE TABLE stock_movements (
    id SERIAL PRIMARY KEY, item_id INT, shop_id INT, type TEXT,
    qty_change INT, qty_after INT DEFAULT 0, occurred_at TIMESTAMPTZ,
    unit_price NUMERIC(14,2), discount_pct NUMERIC(5,2) DEFAULT 0, note TEXT DEFAULT ''
  );
  INSERT INTO shops (business_id, name, code) VALUES (1,'Goldust','GD'), (1,'Rose Gold','RG');
  -- The pant in two sizes, at two shops. And the same pant in Black, which
  -- must stay out. And a one-size top with no style or colour recorded.
  INSERT INTO stock_items (shop_id, name, category, fabric, color, size, sku, qty) VALUES
    (1,'WHITE PANT LINEN BABY BLUE S/M','WHITE PANT','LINEN','BABY BLUE','S/M','WP-1001', 2),
    (1,'WHITE PANT LINEN BABY BLUE M/L','WHITE PANT','LINEN','BABY BLUE','M/L','WP-1002', 1),
    (2,'WHITE PANT LINEN BABY BLUE S/M','WHITE PANT','LINEN','BABY BLUE','S/M','WP-1001', 3),
    (1,'WHITE PANT LINEN BLACK S/M',    'WHITE PANT','LINEN','BLACK',    'S/M','WP-1009', 9),
    (1,'KEPANG FRILL O/S','','','','O/S','KE-1001', 4),
    (1,'KEPANG FRILL S/M','','','','S/M','KE-1002', 1);
`);

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
// eslint-disable-next-line no-eval
const value = (decl, end) => eval(grab(decl, end).slice(decl.length).replace(/;$/, ''));
const SALE_TYPES_SQL = value('const SALE_TYPES_SQL =', ';');
const NET_UNITS_SQL = value('const NET_UNITS_SQL =', ';');
const SHOP_TZ = /const SHOP_TZ = process\.env\.SHOP_TZ \|\| '([^']+)'/.exec(src)[1];

// The shipped handler, driven like Express would.
const body = grab("app.get('/api/stock/sizes', auth, async (req, res) => {", '\n});');
const handler = new Function('pool', 'logger', 'scopeShopIds', 'NET_UNITS_SQL', 'SALE_TYPES_SQL', 'SHOP_TZ', `
  const app = { get: (path, ...fns) => fns[fns.length - 1] };
  const auth = null;
  return ${body.replace(/^app\.get\([^,]+,\s*auth,\s*/, '(')}
`)({ query: (t, p) => db.query(t, p) }, { error: () => {} }, async () => null, NET_UNITS_SQL, SALE_TYPES_SQL, SHOP_TZ);

const call = (sku) => new Promise((resolve) => {
  const res = { status(c) { this.code = c; return this; }, json(v) { resolve({ code: this.code || 200, ...v }); } };
  handler({ query: { sku }, user: { businessId: 1 } }, res);
});

const at = (d) => `${d}T04:00:00Z`;
await db.query(`INSERT INTO stock_movements (item_id, shop_id, type, qty_change, occurred_at) VALUES
  (1,1,'sale',-1,'${at('2025-03-15')}'),
  (3,2,'sale',-4,'${at('2026-02-15')}'),
  (3,2,'sale',-1,'${at('2026-04-15')}'),
  (2,1,'sale',-3,'${at('2025-06-15')}'),
  (2,1,'sale',-2,'${at('2026-01-15')}'),
  (4,1,'sale',-7,'${at('2026-01-15')}'),
  (6,1,'sale',-1,'${at('2024-01-15')}')`);

console.log('\nReal Postgres · one garment, all its sizes\n');

const r = await call('WP-1002');   // opened from the M/L
check('opening the M/L lists every size of the pant', r.sizes.map(z => z.size).join(',') === 'S/M,M/L',
  r.sizes.map(z => z.size).join(','));
check('the sizes are in wearing order, S/M before M/L', r.sizes[0].size === 'S/M', r.sizes[0].size);
check('the Black pant is not pulled in', !r.sizes.some(z => z.skus.includes('WP-1009')), 'it is');
const sm = r.sizes.find(z => z.size === 'S/M');
const ml = r.sizes.find(z => z.size === 'M/L');
check('years run from the first sale of any size to now', r.years[0] === 2025 && r.years[r.years.length - 1] === new Date().getFullYear(),
  r.years.join(','));
check('S/M: 1 in 2025 and 5 in 2026 — both shops added together',
  sm.byYear[0] === 1 && sm.byYear[1] === 5, sm.byYear.join(','));
check('M/L: 3 in 2025 and 2 in 2026', ml.byYear[0] === 3 && ml.byYear[1] === 2, ml.byYear.join(','));
check('the totals are the sum across the years', sm.total === 6 && ml.total === 5, `${sm.total} ${ml.total}`);
check('stock now is what is on the rail across shops: S/M 2+3, M/L 1', sm.stock === 5 && ml.stock === 1,
  `${sm.stock} ${ml.stock}`);
check('each size lists the codes behind it, so the S/M is one code in two shops',
  sm.skus.join(',') === 'WP-1001' && ml.skus.join(',') === 'WP-1002', `${sm.skus} | ${ml.skus}`);

const same = await call('WP-1001');  // opened from the S/M
check('opening the S/M gives the same card',
  JSON.stringify(same.sizes.map(z => [z.size, z.total, z.stock])) === JSON.stringify(r.sizes.map(z => [z.size, z.total, z.stock])),
  'the card depends on which size was opened');

console.log('\n  a garment with no style or colour recorded');
const k = await call('KE-1001');
check('falls back to the name with the size stripped, and still finds both sizes',
  k.sizes.map(z => z.size).join(',') === 'S/M,O/S', k.sizes.map(z => z.size).join(','));
check('one-size and S/M are told apart', k.sizes.find(z => z.size === 'O/S').stock === 4, JSON.stringify(k.sizes));

console.log('\n  what the endpoint enforces');
check('it is open to staff, scoped to their shop',
  /app\.get\('\/api\/stock\/sizes', auth, async/.test(src) && /scopeShopIds\(req\)/.test(body), 'admin-only or unscoped');
check('an unknown code is a 404, not an empty card', (await call('NOPE-1')).code === 404, 'no 404');
check('the fallback match strips a size off the end in SQL too',
  /REGEXP_REPLACE\(si\.name/.test(body), 'no SQL fallback');

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
