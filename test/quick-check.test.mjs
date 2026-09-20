// Quick check, against REAL Postgres: one line per garment, every size along
// it, ten years of sales beside it.
//
// The grouping is the thing that has to be right. Sizes of one dress carry
// unrelated codes, so garments are gathered by style + fabric + colour; the
// Baby Blue and the Black of the same pant must land on different lines,
// and the S/M and M/L of the Baby Blue on the same one.
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
  INSERT INTO stock_items (shop_id, name, category, fabric, color, size, sku, qty, price) VALUES
    (1,'WHITE PANT LINEN BABY BLUE S/M','WHITE PANT','LINEN','BABY BLUE','S/M','WP-1001', 2, 900000),
    (1,'WHITE PANT LINEN BABY BLUE M/L','WHITE PANT','LINEN','BABY BLUE','M/L','WP-1002', 1, 900000),
    (2,'WHITE PANT LINEN BABY BLUE S/M','WHITE PANT','LINEN','BABY BLUE','S/M','WP-1001', 3, 900000),
    (1,'WHITE PANT LINEN BLACK S/M',    'WHITE PANT','LINEN','BLACK',    'S/M','WP-1009', 9, 900000),
    (1,'KEPANG FRILL O/S','','','','O/S','KE-1001', 4, 300000),
    (1,'KEPANG FRILL S/M','','','','S/M','KE-1002', 0, 300000);
`);
const at = (d) => `${d}T04:00:00Z`;
await db.query(`INSERT INTO stock_movements (item_id, shop_id, type, qty_change, occurred_at) VALUES
  (1,1,'sale',-1,'${at('2025-03-15')}'),
  (3,2,'sale',-4,'${at('2026-02-15')}'),
  (2,1,'sale',-3,'${at('2025-06-15')}'),
  (2,1,'return',1,'${at('2025-07-15')}'),
  (4,1,'sale',-7,'${at('2026-01-15')}'),
  (6,1,'sale',-1,'${at('2019-01-15')}'),
  (6,1,'sale',-1,'${at('2011-01-15')}')`);   // fifteen years back: outside the window

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

const consts = grab('const QUICK_YEARS =', ';') + '\n' + grab('const SIZE_TAIL_SQL =', ';') + '\n' + grab('const GARMENT_KEY_SQL =', '`;');
const body = grab("app.get('/api/quick-check', auth, requireAdmin, async (req, res) => {", '\n});');
const make = (ids) => new Function('pool', 'logger', 'scopeShopIds', 'NET_UNITS_SQL', 'SALE_TYPES_SQL', 'SHOP_TZ', `
  ${consts}
  return ${body.replace(/^app\.get\([^,]+,\s*auth,\s*requireAdmin,\s*/, '(')}
`)({ query: (t, p) => db.query(t, p) }, { error: (k, v) => console.log(k, v) }, async () => ids, NET_UNITS_SQL, SALE_TYPES_SQL, SHOP_TZ);
const call = (ids) => new Promise((resolve) => {
  const res = { status(c) { this.code = c; return this; }, json(v) { resolve({ code: this.code || 200, ...v }); } };
  make(ids)({ query: {}, user: { businessId: 1 } }, res);
});

console.log('\nReal Postgres · quick check\n');
const thisYear = new Date().getFullYear();

const all = await call(null);
check('ten years of columns, ending this year',
  all.years.length === 10 && all.years[9] === thisYear && all.years[0] === thisYear - 9, all.years.join(','));
check('one line per garment, not per size — three garments from six rows',
  all.garments.length === 3, `${all.garments.length}: ${all.garments.map(g => g.name).join(' | ')}`);
const bb = all.garments.find(g => g.color === 'BABY BLUE');
const bk = all.garments.find(g => g.color === 'BLACK');
check('the Baby Blue pant and the Black pant are different lines', bb && bk && bb.key !== bk.key, 'merged');
check('every size along the Baby Blue line, in wearing order',
  bb.sizes.map(z => z.size).join(',') === 'S/M,M/L', bb.sizes.map(z => z.size).join(','));
check('stock per size adds both shops together: S/M 2+3, M/L 1',
  bb.sizes[0].qty === 5 && bb.sizes[1].qty === 1 && bb.stock === 6, JSON.stringify(bb.sizes));
check('all its codes are listed', bb.skus.join(',') === 'WP-1001,WP-1002', bb.skus.join(','));
const y = (g, year) => g.byYear[all.years.indexOf(year)];
check('sold per year: 2025 = 1 + 3 - 1 returned = 3', y(bb, 2025) === 3, String(y(bb, 2025)));
check('sold per year: 2026 = 4', y(bb, 2026) === 4, String(y(bb, 2026)));
check('a year with nothing is a zero, kept in place so the gap shows',
  y(bb, thisYear - 5) === 0 && bb.byYear.length === 10, bb.byYear.join(','));
check('the total is the sum of the ten years', bb.total === 7, String(bb.total));

const ke = all.garments.find(g => g.key.startsWith('N|'));
check('a garment with no style or colour still gathers by name-minus-size: O/S and S/M together',
  ke && ke.sizes.map(z => z.size).join(',') === 'S/M,O/S', ke ? ke.sizes.map(z => z.size).join(',') : 'missing');
check('a size at zero is kept on the line, not dropped', ke.sizes.find(z => z.size === 'S/M').qty === 0, 'dropped');
check('a sale fifteen years ago is outside the ten-year window', ke.total === 1, String(ke.total));

console.log('\n  one shop on screen');
const gd = await call([1]);
const bb1 = gd.garments.find(g => g.color === 'BABY BLUE');
check('stock is that shop’s: S/M 2, not 5', bb1.sizes[0].qty === 2, String(bb1.sizes[0].qty));
check('but sales are still every shop’s: 2026 = 4 was Rose Gold’s sale', y(bb1, 2026) === 4, String(y(bb1, 2026)));

console.log('\n  what the endpoint enforces');
check('it is admin-only',
  /app\.get\('\/api\/quick-check', auth, requireAdmin, async/.test(src), 'staff can reach it');
check('the sales query is NOT scoped by shop', !/stockScope/.test(body.slice(body.indexOf('What each garment sold'))), 'sales are scoped');
check('fabric first, then style, then colour — the way she reads the rail',
  /localeCompare\(b\.fabric/.test(body) && /a\.style\.localeCompare\(b\.style\)/.test(body), 'a different order');

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
