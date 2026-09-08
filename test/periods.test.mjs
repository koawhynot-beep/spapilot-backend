// Drilling year → month → week → day, against REAL Postgres.
//
// The check that matters most is the timezone one. Bali runs eight hours
// ahead of UTC, so a sale at seven in the evening is already tomorrow by UTC.
// Group on that and every busy evening lands on the wrong day — quietly, and
// on every single day, which is exactly the kind of wrong that gets believed.
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
const value = (decl, end) =>
  // eslint-disable-next-line no-eval
  eval(grab(decl, end).slice(decl.length).replace(/;$/, ''));

const SALE_TYPES_SQL = value('const SALE_TYPES_SQL =', ';');
const NET_UNITS_SQL = value('const NET_UNITS_SQL =', ';');
// eslint-disable-next-line no-unused-vars
const SALE_PRICE_SQL = value('const SALE_PRICE_SQL =', ';');
const SALE_NET_SQL = value('const SALE_NET_SQL =', ';');
const WEEK_OF_MONTH_SQL = value('const WEEK_OF_MONTH_SQL =', ';');
const TZ = /const SHOP_TZ = process\.env\.SHOP_TZ \|\| '([^']+)'/.exec(src)[1];

console.log(`\nReal Postgres · drilling into the takings (${TZ})\n`);

check('the shop timezone is an Indonesian one, not UTC',
  /^Asia\//.test(TZ), TZ);

// ── The evening that UTC would move ──────────────────────────────────────
// 2026-03-10 19:30 in Bali (UTC+8) is 11:30 UTC the same day.
// 2026-03-10 23:30 in Bali is 15:30 UTC — still the 10th.
// 2026-03-11 01:00 in Bali is 2026-03-10 17:00 UTC — a different day in UTC.
await db.query(`INSERT INTO stock_movements (item_id, shop_id, type, qty_change, qty_after, occurred_at) VALUES
  (1,1,'sale',-1,0,'2026-03-10T11:30:00Z'),
  (1,1,'sale',-1,0,'2026-03-10T15:30:00Z'),
  (1,1,'sale',-1,0,'2026-03-10T17:00:00Z')`);

const localDays = async () => (await db.query(
  `SELECT EXTRACT(DAY FROM (occurred_at AT TIME ZONE $1))::int AS d, COUNT(*)::int AS n
     FROM stock_movements GROUP BY 1 ORDER BY 1`, [TZ]
)).rows;
const utcDays = async () => (await db.query(
  `SELECT EXTRACT(DAY FROM (occurred_at AT TIME ZONE 'UTC'))::int AS d, COUNT(*)::int AS n
     FROM stock_movements GROUP BY 1 ORDER BY 1`
)).rows;

const local = await localDays();
const utc = await utcDays();
check('two sales on the 10th and one just after midnight on the 11th, locally',
  JSON.stringify(local) === JSON.stringify([{ d: 10, n: 2 }, { d: 11, n: 1 }]),
  JSON.stringify(local));
check('and UTC would have put all three on the 10th — which is the bug',
  JSON.stringify(utc) === JSON.stringify([{ d: 10, n: 3 }]), JSON.stringify(utc));

// ── The buckets ──────────────────────────────────────────────────────────
await db.exec('DELETE FROM stock_movements');
// Spread across two years, three months, and several weeks of March 2026.
// Times are chosen mid-afternoon Bali so the timezone cannot blur the day.
const at = (iso) => `${iso}T04:00:00Z`;          // noon in Bali
await db.query(`INSERT INTO stock_movements (item_id, shop_id, type, qty_change, qty_after, occurred_at, unit_price) VALUES
  (1,1,'sale',-1,0,'${at('2025-11-05')}', 500000),
  (1,1,'sale',-2,0,'${at('2026-01-20')}', 500000),
  (1,1,'sale',-1,0,'${at('2026-03-03')}', 1000000),
  (1,1,'sale',-1,0,'${at('2026-03-06')}', 1000000),
  (1,1,'sale',-3,0,'${at('2026-03-09')}', 1000000),
  (1,1,'sale',-1,0,'${at('2026-03-17')}', 1000000),
  (1,1,'sale',-1,0,'${at('2026-03-29')}', 1000000),
  (1,1,'return', 1,0,'${at('2026-03-09')}', 1000000)`);

const periods = async (level, { year, month, week } = {}) => {
  const all = [1, TZ];
  const add = (v) => { all.push(v); return all.length; };
  let scope = '';
  if (year) scope += ` AND EXTRACT(YEAR FROM local_at) = $${add(year)}`;
  if (level === 'week' || level === 'day') scope += ` AND EXTRACT(MONTH FROM local_at) = $${add(month)}`;
  if (level === 'day') scope += ` AND ${WEEK_OF_MONTH_SQL} = $${add(week)}`;
  const bucket = {
    year: 'EXTRACT(YEAR FROM local_at)::int',
    month: 'EXTRACT(MONTH FROM local_at)::int',
    week: WEEK_OF_MONTH_SQL,
    day: 'EXTRACT(DAY FROM local_at)::int',
  }[level];
  const { rows } = await db.query(
    `SELECT ${bucket} AS key, COUNT(*)::int AS entries,
            COALESCE(SUM(net_units),0)::int AS units,
            COALESCE(SUM(net_units * net_price),0)::numeric AS revenue
       FROM (SELECT (m.occurred_at AT TIME ZONE $2) AS local_at,
                    ${NET_UNITS_SQL} AS net_units,
                    ${SALE_NET_SQL} AS net_price
               FROM stock_movements m
               JOIN stock_items si ON si.id = m.item_id
               JOIN shops sh ON sh.id = m.shop_id
              WHERE sh.business_id = $1 AND ${SALE_TYPES_SQL}) t
      WHERE TRUE ${scope}
      GROUP BY 1 ORDER BY 1 DESC`, all);
  return rows.map(r => ({ key: Number(r.key), entries: r.entries, units: r.units, revenue: Number(r.revenue) }));
};

console.log('\n  year');
const years = await periods('year');
check('both years appear, newest first',
  years.map(y => y.key).join(',') === '2026,2025', years.map(y => y.key).join(','));
check('2025 holds the one sale', years.find(y => y.key === 2025).units === 1,
  String(years.find(y => y.key === 2025).units));

console.log('\n  month within 2026');
const months = await periods('month', { year: 2026 });
check('January and March, newest first',
  months.map(m => m.key).join(',') === '3,1', months.map(m => m.key).join(','));
const march = months.find(m => m.key === 3);
check('March nets the return off: 1+1+3+1+1 sold, 1 returned = 6',
  march.units === 6, String(march.units));
check('March revenue is 6,000,000', march.revenue === 6000000, String(march.revenue));

console.log('\n  week within March 2026');
const weeks = await periods('week', { year: 2026, month: 3 });
// Weeks are seven-day blocks: 1-7, 8-14, 15-21, 22-28, 29 onwards. So the
// 3rd and 6th are week 1, the 9th is week 2, the 17th week 3, the 29th week 5.
check('weeks 1, 2, 3 and 5 have trade',
  weeks.map(w => w.key).sort().join(',') === '1,2,3,5', weeks.map(w => w.key).join(','));
const w1 = weeks.find(w => w.key === 1);
check('the 3rd and 6th fall in week 1', w1.entries === 2, `${w1.entries} entries`);
const w2 = weeks.find(w => w.key === 2);
check('the 9th falls in week 2, with its sale and its return', w2.entries === 2, `${w2.entries} entries`);
check('week 2 nets the return: 3 sold, 1 back = 2', w2.units === 2, String(w2.units));
check('the 29th lands in week 5, not week 4',
  weeks.some(w => w.key === 5) && !weeks.some(w => w.key === 4), weeks.map(w => w.key).join(','));

console.log('\n  day within a week');
const days1 = await periods('day', { year: 2026, month: 3, week: 1 });
check('week 1 holds the 3rd and the 6th',
  days1.map(d => d.key).sort((a, b) => a - b).join(',') === '3,6', days1.map(d => d.key).join(','));
const days2 = await periods('day', { year: 2026, month: 3, week: 2 });
check('week 2 holds only the 9th', days2.length === 1 && days2[0].key === 9,
  JSON.stringify(days2.map(d => d.key)));
check('the 9th shows the sale and the return together', days2[0].entries === 2,
  String(days2[0].entries));
check('and nets to 2', days2[0].units === 2, String(days2[0].units));
check('a week only ever shows its own seven days',
  days2.every(d => d.key >= 8 && d.key <= 14), JSON.stringify(days2.map(d => d.key)));

// ── The guards ───────────────────────────────────────────────────────────
console.log('\n  what the endpoint enforces');
check('it is admin-only',
  /app\.get\('\/api\/sales\/periods', auth, requireAdmin/.test(src), 'requireAdmin missing');
check('a month cannot be asked for without a year', src.includes('Pick a year first'), 'no guard');
check('a week cannot be asked for without a month', src.includes('Pick a month first'), 'no guard');
check('a day cannot be asked for without a week', src.includes('Pick a week first'), 'no guard');
check('the level is a closed set, not whatever was sent',
  /\['year', 'month', 'week', 'day'\]\.includes\(req\.query\.level\)/.test(src), 'level not validated');
check('weeks are counted inside the month, so a drill-down cannot escape it',
  /EXTRACT\(DAY FROM local_at\) - 1\) \/ 7\) \+ 1/.test(WEEK_OF_MONTH_SQL), WEEK_OF_MONTH_SQL);
check('the 31st cannot make a sixth week', WEEK_OF_MONTH_SQL.includes('LEAST(5'), WEEK_OF_MONTH_SQL);

// A 31-day month: the 29th, 30th and 31st must all be week 5.
await db.exec('DELETE FROM stock_movements');
await db.query(`INSERT INTO stock_movements (item_id, shop_id, type, qty_change, qty_after, occurred_at) VALUES
  (1,1,'sale',-1,0,'${at('2026-01-29')}'),
  (1,1,'sale',-1,0,'${at('2026-01-30')}'),
  (1,1,'sale',-1,0,'${at('2026-01-31')}')`);
const janWeeks = await periods('week', { year: 2026, month: 1 });
check('the last three days of a 31-day month share week 5',
  janWeeks.length === 1 && janWeeks[0].key === 5 && janWeeks[0].entries === 3,
  JSON.stringify(janWeeks));

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
