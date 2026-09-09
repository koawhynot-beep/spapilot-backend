// Slicing the takings by date, against REAL Postgres.
//
// Two things are being checked. The first is the timezone: Bali runs eight
// hours ahead of UTC, so a sale at seven in the evening is already tomorrow
// by UTC. Group on that and every busy evening lands on the wrong day —
// quietly, and on every single day, which is the kind of wrong that gets
// believed.
//
// The second is that year, month, week and day are four independent filters
// rather than four steps. A day on its own has to mean that date in every
// month, or "how does the 12th usually go" cannot be asked at all.
import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';

const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');

const db = new PGlite();
await db.exec(`
  CREATE TABLE businesses (id SERIAL PRIMARY KEY, name TEXT);
  CREATE TABLE shops (id SERIAL PRIMARY KEY, business_id INT, name TEXT, code TEXT);
  CREATE TABLE stock_items (
    id SERIAL PRIMARY KEY, shop_id INT, name TEXT, sku TEXT,
    qty INT DEFAULT 0, price NUMERIC(14,2) DEFAULT 0, cost NUMERIC(14,2) DEFAULT 0
  );
  CREATE TABLE stock_movements (
    id SERIAL PRIMARY KEY, item_id INT, shop_id INT, type TEXT,
    qty_change INT, qty_after INT, occurred_at TIMESTAMPTZ,
    unit_price NUMERIC(14,2), discount_pct NUMERIC(5,2) DEFAULT 0,
    payment TEXT DEFAULT '', staff_id INT, staff_name TEXT DEFAULT '', reason TEXT DEFAULT ''
  );
  INSERT INTO businesses (name) VALUES ('Boutique');
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
const TZ = /const SHOP_TZ = process\.env\.SHOP_TZ \|\| '([^']+)'/.exec(src)[1];

// The shipped period expressions, built in a scope where SHOP_TZ exists, so
// what is tested is what runs.
const { LOCAL_AT_SQL, WEEK_OF_SQL, PERIOD_PARTS } = new Function('SHOP_TZ', `
  ${grab('const LOCAL_AT_SQL =', ';')}
  ${grab('const WEEK_OF_MONTH_SQL =', ';')}
  ${grab('const WEEK_OF_SQL =', ';')}
  ${grab('const PERIOD_PARTS = [', '\n];')}
  return { LOCAL_AT_SQL, WEEK_OF_SQL, PERIOD_PARTS };
`)(TZ);

console.log(`\nReal Postgres · the takings sliced by date (${TZ})\n`);

check('the shop timezone is an Indonesian one, not UTC', /^Asia\//.test(TZ), TZ);

// ── The evening that UTC would move ──────────────────────────────────────
// 2026-03-11 01:00 in Bali is 2026-03-10 17:00 UTC — a different day.
await db.query(`INSERT INTO stock_movements (item_id, shop_id, type, qty_change, qty_after, occurred_at) VALUES
  (1,1,'sale',-1,0,'2026-03-10T11:30:00Z'),
  (1,1,'sale',-1,0,'2026-03-10T15:30:00Z'),
  (1,1,'sale',-1,0,'2026-03-10T17:00:00Z')`);

const dayCounts = async (expr) => (await db.query(
  `SELECT ${expr} AS d, COUNT(*)::int AS n FROM stock_movements m GROUP BY 1 ORDER BY 1`
)).rows.map(r => ({ d: Number(r.d), n: r.n }));

const localDays = await dayCounts(`EXTRACT(DAY FROM ${LOCAL_AT_SQL})`);
const utcDays = await dayCounts(`EXTRACT(DAY FROM (m.occurred_at AT TIME ZONE 'UTC'))`);
check('two sales on the 10th and one just after midnight on the 11th, locally',
  JSON.stringify(localDays) === JSON.stringify([{ d: 10, n: 2 }, { d: 11, n: 1 }]),
  JSON.stringify(localDays));
check('and UTC would have put all three on the 10th — which is the bug',
  JSON.stringify(utcDays) === JSON.stringify([{ d: 10, n: 3 }]), JSON.stringify(utcDays));

// ── The data the slicing is tested against ───────────────────────────────
await db.exec('DELETE FROM stock_movements');
const at = (iso) => `${iso}T04:00:00Z`;          // noon in Bali
await db.query(`INSERT INTO stock_movements (item_id, shop_id, type, qty_change, qty_after, occurred_at, unit_price) VALUES
  (1,1,'sale',-1,0,'${at('2025-11-05')}', 500000),
  (1,1,'sale',-1,0,'${at('2025-03-06')}', 700000),
  (1,1,'sale',-2,0,'${at('2026-01-20')}', 500000),
  (1,1,'sale',-1,0,'${at('2026-03-03')}', 1000000),
  (1,1,'sale',-1,0,'${at('2026-03-06')}', 1000000),
  (1,1,'sale',-3,0,'${at('2026-03-09')}', 1000000),
  (1,1,'sale',-1,0,'${at('2026-03-17')}', 1000000),
  (1,1,'sale',-1,0,'${at('2026-03-29')}', 1000000),
  (1,1,'return', 1,0,'${at('2026-03-09')}', 1000000)`);

// The shipped filter, applied exactly as salesFilter applies it.
const scope = (sel) => {
  const params = [];
  let where = '';
  for (const [name, valid, expr] of PERIOD_PARTS) {
    const v = sel[name];
    if (!Number.isInteger(v) || !valid(v)) continue;
    params.push(v);
    where += ` AND ${expr} = $${params.length}`;
  }
  return { where, params };
};

const totals = async (sel) => {
  const { where, params } = scope(sel);
  const { rows: [r] } = await db.query(
    `SELECT COUNT(*)::int AS entries,
            COALESCE(SUM(${NET_UNITS_SQL}),0)::int AS units,
            COALESCE(SUM(${NET_UNITS_SQL} * ${SALE_NET_SQL}),0)::numeric AS revenue
       FROM stock_movements m
       JOIN stock_items si ON si.id = m.item_id
      WHERE ${SALE_TYPES_SQL} ${where}`, params);
  return { entries: r.entries, units: r.units, revenue: Number(r.revenue) };
};

const bucket = {
  year: `EXTRACT(YEAR FROM ${LOCAL_AT_SQL})::int`,
  month: `EXTRACT(MONTH FROM ${LOCAL_AT_SQL})::int`,
  week: WEEK_OF_SQL,
  day: `EXTRACT(DAY FROM ${LOCAL_AT_SQL})::int`,
};
// A facet leaves its own part out — the point of the whole design.
const facet = async (level, sel) => {
  const { where, params } = scope({ ...sel, [level]: undefined });
  const { rows } = await db.query(
    `SELECT ${bucket[level]} AS key, COUNT(*)::int AS entries
       FROM stock_movements m
       JOIN stock_items si ON si.id = m.item_id
      WHERE ${SALE_TYPES_SQL} ${where} GROUP BY 1 ORDER BY 1`, params);
  return rows.map(r => Number(r.key));
};

console.log('\n  each part on its own');
check('a year alone', (await totals({ year: 2025 })).entries === 2,
  String((await totals({ year: 2025 })).entries));
// Both Marches: 2025-03-06, and six entries in March 2026 counting the
// return, which is an entry like any other.
check('a month alone means that month in every year — both Marches',
  (await totals({ month: 3 })).entries === 7, String((await totals({ month: 3 })).entries));
check('a day alone means that date in every month — two 6ths',
  (await totals({ day: 6 })).entries === 2, String((await totals({ day: 6 })).entries));
check('a week alone', (await totals({ week: 1 })).entries === 4,
  String((await totals({ week: 1 })).entries));

console.log('\n  parts combined, in any mixture');
check('a day and a year, with no month between them',
  (await totals({ year: 2026, day: 6 })).entries === 1,
  String((await totals({ year: 2026, day: 6 })).entries));
check('a month and a day, with no year',
  (await totals({ month: 3, day: 6 })).entries === 2,
  String((await totals({ month: 3, day: 6 })).entries));
check('all four together',
  (await totals({ year: 2026, month: 3, week: 1, day: 6 })).entries === 1,
  String((await totals({ year: 2026, month: 3, week: 1, day: 6 })).entries));
check('a combination nothing falls into comes back empty rather than wrong',
  (await totals({ year: 2025, month: 1, day: 1 })).entries === 0, 'it found something');

console.log('\n  the arithmetic');
const march26 = await totals({ year: 2026, month: 3 });
check('March 2026 nets the return off: 1+1+3+1+1 sold, 1 back = 6',
  march26.units === 6, String(march26.units));
check('and comes to 6,000,000', march26.revenue === 6000000, String(march26.revenue));

console.log('\n  the weeks');
check('the 9th falls in week 2, not week 1',
  (await facet('week', { year: 2026, month: 3, day: 9 })).join(',') === '2',
  (await facet('week', { year: 2026, month: 3, day: 9 })).join(','));
check('the 29th lands in week 5, not week 4',
  (await facet('week', { year: 2026, month: 3, day: 29 })).join(',') === '5',
  (await facet('week', { year: 2026, month: 3, day: 29 })).join(','));
await db.query(`INSERT INTO stock_movements (item_id, shop_id, type, qty_change, qty_after, occurred_at) VALUES
  (1,1,'sale',-1,0,'${at('2026-01-30')}'), (1,1,'sale',-1,0,'${at('2026-01-31')}')`);
const janWeeks = await facet('week', { year: 2026, month: 1 });
check('the last three days of a 31-day month share week 5, never a sixth',
  janWeeks.includes(5) && !janWeeks.some(w => w > 5), janWeeks.join(','));

console.log('\n  the lists stay reachable');
// This is what makes the picker usable: choosing March must not leave March
// as the only month on offer, or the only way out is to clear everything.
const monthsWithMarchOn = await facet('month', { year: 2026, month: 3 });
check('picking a month still lists every other month',
  monthsWithMarchOn.length > 1 && monthsWithMarchOn.includes(1) && monthsWithMarchOn.includes(3),
  monthsWithMarchOn.join(','));
const yearsWithMarchOn = await facet('year', { month: 3 });
check('the years shown are still narrowed by the other choices',
  yearsWithMarchOn.join(',') === '2025,2026', yearsWithMarchOn.join(','));

// ── The guards ───────────────────────────────────────────────────────────
console.log('\n  what the endpoint enforces');
check('it is admin-only',
  /app\.get\('\/api\/sales\/periods', auth, requireAdmin/.test(src), 'requireAdmin missing');
check('nothing has to be picked before anything else any more',
  !src.includes('Pick a year first') && !src.includes('Pick a month first'),
  'a step-by-step guard survived');
check('each part is range-checked, so a query cannot ask for month 99',
  PERIOD_PARTS.every(([, valid]) => !valid(99) && !valid(0)), 'a part accepts nonsense');
check('a day of 31 is allowed and 32 is not',
  PERIOD_PARTS.find(p => p[0] === 'day')[1](31) && !PERIOD_PARTS.find(p => p[0] === 'day')[1](32),
  'the day range is wrong');
check('a facet leaves its own part out',
  /salesFilter\(req, 2, level\)/.test(src), 'the facet counts apply their own filter');
check('the sales list underneath is filtered the same way, through salesFilter',
  /for \(const \[name, valid, expr\] of PERIOD_PARTS\)/.test(src),
  'the period filter is not part of salesFilter');

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
