// Which weekday sells and which garments, against REAL Postgres.
//
// The trap is the sheet history. Every one of those sales sits on the 15th,
// so if they were counted, each month's whole trade would land on whatever
// weekday the 15th fell on and the "best day" would be an accident of the
// calendar. The first check below is that they are left out.
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
    unit_price NUMERIC(14,2), discount_pct NUMERIC(5,2) DEFAULT 0,
    payment TEXT DEFAULT '', staff_id INT, staff_name TEXT DEFAULT '',
    reason TEXT DEFAULT '', note TEXT DEFAULT ''
  );
  INSERT INTO shops (business_id, name, code) VALUES (1,'Rose Gold','RG');
  INSERT INTO stock_items (shop_id, name, category, sku, qty, price) VALUES
    (1,'DRESS A','DRESS','D-1', 9, 1000000),
    (1,'TOP B','TOP','T-2', 9, 500000),
    (1,'SKIRT C','SKIRT','S-3', 9, 700000);
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
// eslint-disable-next-line no-unused-vars
const SALE_PRICE_SQL = value('const SALE_PRICE_SQL =', ';');
const SALE_NET_SQL = value('const SALE_NET_SQL =', ';');
const SALES_IMPORT_NOTE_V1 = value('const SALES_IMPORT_NOTE_V1 =', ';');
const SALES_IMPORT_NOTE = value('const SALES_IMPORT_NOTE =', ';');
const SALES_IMPORT_NOTE_V2 = value('const SALES_IMPORT_NOTE_V2 =', ';');
const SALES_IMPORT_NOTES = [SALES_IMPORT_NOTE_V1, SALES_IMPORT_NOTE_V2, SALES_IMPORT_NOTE];
const TZ = /const SHOP_TZ = process\.env\.SHOP_TZ \|\| '([^']+)'/.exec(src)[1];
const LOCAL_AT_SQL = `(m.occurred_at AT TIME ZONE '${TZ}')`;

console.log('\nReal Postgres · patterns\n');

// Real trade: three Thursdays selling 4 each, two Sundays selling 1 each,
// one Monday selling 2. Plus a return on a Thursday.
// 2026-09-03, 09-10, 09-17 are Thursdays; 09-06, 09-13 Sundays; 09-07 Monday.
const at = (d) => `${d}T04:00:00Z`;
await db.query(`INSERT INTO stock_movements (item_id, shop_id, type, qty_change, occurred_at, unit_price) VALUES
  (1,1,'sale',-4,'${at('2026-09-03')}',1000000),
  (1,1,'sale',-4,'${at('2026-09-10')}',1000000),
  (2,1,'sale',-5,'${at('2026-09-17')}',500000),
  (2,1,'return',1,'${at('2026-09-17')}',500000),
  (3,1,'sale',-1,'${at('2026-09-06')}',700000),
  (3,1,'sale',-1,'${at('2026-09-13')}',700000),
  (2,1,'sale',-2,'${at('2026-09-07')}',500000)`);
// Sheet history, from both imports: huge sales on a 15th (2026-09-15 is a Tuesday).
await db.query(`INSERT INTO stock_movements (item_id, shop_id, type, qty_change, occurred_at, unit_price, note) VALUES
  (3,1,'sale',-500,'${at('2026-09-15')}',700000,$1),
  (3,1,'sale',-500,'${at('2026-09-15')}',700000,$2)`, [SALES_IMPORT_NOTE, SALES_IMPORT_NOTE_V1]);

const weekdays = async () => (await db.query(
  `SELECT EXTRACT(ISODOW FROM ${LOCAL_AT_SQL})::int AS dow,
          COUNT(DISTINCT (${LOCAL_AT_SQL})::date)::int AS days,
          COALESCE(SUM(${NET_UNITS_SQL}),0)::int AS pieces
     FROM stock_movements m
     JOIN stock_items si ON si.id = m.item_id
    WHERE ${SALE_TYPES_SQL} AND COALESCE(m.note,'') <> ALL($1::text[])
    GROUP BY 1 ORDER BY 1`, [SALES_IMPORT_NOTES]
)).rows.map(r => ({ ...r, perDay: r.pieces / r.days })).sort((a, b) => b.perDay - a.perDay);

const days = await weekdays();
console.log('  weekdays');
check('the sheet history is left out — Tuesday does not appear at all',
  !days.some(d => d.dow === 2), days.map(d => d.dow).join(','));
check('Thursday is the best day', days[0].dow === 4, `dow ${days[0].dow}`);
check('Thursday nets the return: (4+4+5-1)/3 = 4 a day', days[0].perDay === 4, String(days[0].perDay));
check('Sunday is the worst day', days[days.length - 1].dow === 7, `dow ${days[days.length - 1].dow}`);
check('it counts trading days, not calendar days — three Thursdays', days[0].days === 3, String(days[0].days));
// A day with a big total but one occurrence must not beat a steady day.
await db.query(`INSERT INTO stock_movements (item_id, shop_id, type, qty_change, occurred_at, unit_price) VALUES
  (1,1,'sale',-5,'${at('2026-09-05')}',1000000)`);   // one Saturday, 5 pieces
const days2 = await weekdays();
check('one big Saturday (5) ranks above a steady Thursday (4 a day) — averages, so yes, and honestly so',
  days2[0].dow === 6 && days2[0].days === 1, `${days2[0].dow} over ${days2[0].days} day`);

console.log('\n  the garments');
const top = (await db.query(
  `SELECT UPPER(si.sku) AS sku, COALESCE(SUM(${NET_UNITS_SQL}),0)::int AS pieces
     FROM stock_movements m JOIN stock_items si ON si.id = m.item_id
    WHERE ${SALE_TYPES_SQL} GROUP BY 1
    HAVING COALESCE(SUM(${NET_UNITS_SQL}),0) > 0
    ORDER BY COALESCE(SUM(${NET_UNITS_SQL}),0) DESC LIMIT 10`)).rows;
check('the sheet history IS counted for the garment ranking — the day does not matter there',
  top[0].sku === 'S-3' && top[0].pieces === 1002, `${top[0].sku} ${top[0].pieces}`);
check('returns come off a garment’s total', top.find(x => x.sku === 'T-2').pieces === 6,
  String(top.find(x => x.sku === 'T-2').pieces));

console.log('\n  sold by year, for the stock row');
await db.query(`INSERT INTO stock_movements (item_id, shop_id, type, qty_change, occurred_at, unit_price) VALUES
  (1,1,'sale',-3,'${at('2023-05-01')}',1000000)`);
const byYear = (await db.query(
  `SELECT EXTRACT(YEAR FROM ${LOCAL_AT_SQL})::int AS year, COALESCE(SUM(${NET_UNITS_SQL}),0)::int AS sold
     FROM stock_movements m JOIN stock_items si ON si.id = m.item_id
    WHERE UPPER(si.sku) = 'D-1' AND ${SALE_TYPES_SQL} GROUP BY 1 ORDER BY 1 DESC`)).rows;
check('years with sales come back', byYear.map(y => y.year).join(',') === '2026,2023', byYear.map(y => y.year).join(','));
// The endpoint fills the gap years itself; check that the code does.
const ep = grab("app.get('/api/stock/sold-by-year'", '\n});');
check('the endpoint lists every year from the first sale to now, gaps included',
  /for \(let y = thisYear; y >= first; y--\)/.test(ep), 'the gap years are dropped');
check('but pads no further back than the first sale', /const first = rows\.length \? Math\.min/.test(ep), 'it pads to ten years of nothing');
check('and never further back than ten years', /thisYear - 9/.test(ep), 'no ten-year cap');
check('it is open to staff, scoped to their own shop',
  /app\.get\('\/api\/stock\/sold-by-year', auth, async/.test(src) && /scopeShopIds\(req\)/.test(ep),
  'it is admin-only or unscoped');
check('for the owner it counts every shop, not the one on screen',
  !/req\.query\.shopId/.test(ep) && /byShop: shopRows/.test(ep),
  'the garment is still judged by one shop');

console.log('\n  what the Best & worst endpoint enforces');
const pep = grab("app.get('/api/analytics/summary'", '\n});');
check('it is admin-only', /app\.get\('\/api\/analytics\/summary', auth, requireAdmin/.test(src), 'requireAdmin missing');
check('both sheet-import notes are excluded from the weekday query',
  /COALESCE\(m\.note,''\) <> ALL\(\$\$\{all\.length \+ 1\}::text\[\]\)/.test(pep) && /SALES_IMPORT_NOTES\]/.test(pep), 'the sheet sales are counted in the weekdays');
check('it refuses to name a best day on too little trade',
  /enoughDays: realDays >= 14/.test(pep), 'no minimum');
check('ranking is by pieces per trading day, not by total',
  /perDay: x\.days \? x\.pieces \/ x\.days : 0/.test(pep) && /sort\(\(a, b\) => b\.perDay - a\.perDay/.test(pep),
  'ranked by total');
check('the list length is the caller’s, twenty by default',
  /parseInt\(req\.query\.limit, 10\) \|\| 20/.test(pep), 'no limit parameter');
check('and it is capped, so a typo cannot ask for the whole catalogue',
  /Math\.min\(Math\.max\(parseInt\(req\.query\.limit, 10\) \|\| 20, 1\), 200\)/.test(pep), 'no cap');
check('best and worst both use it',
  /bestByUnits: ranked\.slice\(0, LIMIT\)/.test(pep) && /slice\(-LIMIT\)/.test(pep), 'a list ignores it');
check('the old separate patterns endpoint is gone', !src.includes("'/api/sales/patterns'"), 'still there');
// The four queries are destructured by position. The weekday query sits
// third in the array, so it must be third in the names — getting this wrong
// once put 8,140 stock rows on screen as "weekday.undefined".
const arr = pep.slice(pep.indexOf('await Promise.all(['), pep.indexOf(']);', pep.indexOf('await Promise.all([')));
const order = ['SELECT si.sku, MIN(si.name)', "to_char(date_trunc('month'", 'EXTRACT(ISODOW', 'si.last_sold_at, si.created_at']
  .map(k => arr.indexOf(k));
check('the queries run in the order the names expect: sellers, trend, weekdays, shelf',
  /const \[sellers, trend, dow, shelf\] = await Promise\.all/.test(pep)
  && order.every((v, i) => v >= 0 && (i === 0 || v > order[i - 1])),
  `positions ${order.join(',')}`);

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
