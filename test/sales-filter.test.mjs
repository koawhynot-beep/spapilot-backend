// Runs the REAL salesFilter and the REAL query strings from server.js against
// REAL Postgres (PGlite is Postgres compiled to WASM).
//
// The previous round's mock reimplemented the filter in JavaScript, so it
// proved the UI contract and never once executed the SQL the server actually
// builds — which is exactly where the bug was. This pulls the function out of
// server.js by source so the thing under test is the shipped code.
import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';

const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const grab = (startMarker, endMarker) => {
  const a = src.indexOf(startMarker);
  const b = src.indexOf(endMarker, a);
  if (a < 0 || b < 0) throw new Error('could not extract ' + startMarker);
  return src.slice(a, b + endMarker.length);
};

// eslint-disable-next-line no-eval
const salesFilter = eval('(' + grab('function salesFilter(', '\n}').replace('function salesFilter(', 'function (') + ')');
const SALE_TYPES_SQL = eval(grab('const SALE_TYPES_SQL =', ';').replace('const SALE_TYPES_SQL =', '').replace(/;$/, ''));
const NET_UNITS_SQL = eval(grab('const NET_UNITS_SQL =', ';').replace('const NET_UNITS_SQL =', '').replace(/;$/, ''));
const SALE_SELECT = eval(grab('const SALE_SELECT = `', '`;').replace('const SALE_SELECT =', '').replace(/;$/, ''));
const HISTORY_MONTHS = 24;

const db = new PGlite();
await db.exec(`
  CREATE TABLE businesses (id SERIAL PRIMARY KEY, name TEXT);
  CREATE TABLE shops (id SERIAL PRIMARY KEY, business_id INT, name TEXT, address TEXT);
  CREATE TABLE staff (id SERIAL PRIMARY KEY, business_id INT, shop_id INT, name TEXT,
                      active BOOLEAN DEFAULT TRUE, commission_rate NUMERIC(6,3) DEFAULT 0);
  CREATE TABLE stock_items (
    id SERIAL PRIMARY KEY, shop_id INT, name TEXT, category TEXT, fabric TEXT, print TEXT,
    size TEXT, color TEXT, sku TEXT, brand TEXT, qty INT DEFAULT 0, threshold INT DEFAULT 5,
    supplier TEXT, notes TEXT, position INT DEFAULT 0, image_url TEXT,
    price NUMERIC(14,2) DEFAULT 0, cost NUMERIC(14,2) DEFAULT 0,
    last_sold_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE TABLE stock_movements (
    id SERIAL PRIMARY KEY, item_id INT, shop_id INT, user_id INT, type TEXT,
    qty_change INT, qty_after INT, occurred_at TIMESTAMPTZ DEFAULT NOW(),
    note TEXT DEFAULT '', reason TEXT DEFAULT '', staff_id INT, staff_name TEXT DEFAULT ''
  );
  INSERT INTO businesses (name) VALUES ('Mitra Samadi');
  INSERT INTO shops (business_id, name, address) VALUES (1, 'Gold Dust', '');
  INSERT INTO staff (business_id, shop_id, name, commission_rate) VALUES (1, 1, 'budi', 5);
  INSERT INTO staff (business_id, shop_id, name, commission_rate) VALUES (1, 1, 'Belina', 2.5);
  INSERT INTO stock_items (shop_id, name, sku, color, size, category, fabric, price, cost, qty)
    VALUES (1, 'MAX TOP NATURAL O/S', 'MT-1001', 'NATURAL', 'O/S', 'MAX TOP', 'COTTON', 750000, 300000, 7),
           (1, 'BUBBLE KAFTAN APPLE S/M', 'BU-3040', 'APPLE', 'S/M', 'KAFTAN', 'BUBBLE', 1350000, 560000, 4);
`);

// A sale a day for 60 days, alternating item and staff, every 11th a return.
for (let i = 0; i < 60; i++) {
  const item = (i % 2) + 1;
  const staff = (i % 2) + 1;
  const isReturn = i % 11 === 0;
  await db.query(
    `INSERT INTO stock_movements (item_id, shop_id, user_id, type, qty_change, qty_after, occurred_at, staff_id, staff_name)
     VALUES ($1, 1, 1, $2, $3, 5, NOW() - ($4 || ' days')::interval, $5, $6)`,
    [item, isReturn ? 'return' : 'sale', isReturn ? 1 : -1, String(i), staff, staff === 1 ? 'budi' : 'Belina']
  );
}

const run = async (label, query) => {
  const fakeReq = { query, user: { businessId: 1 } };
  const { where, params } = salesFilter(fakeReq, 3);
  const all = [1, String(HISTORY_MONTHS), ...params];
  const windowSql = `sh.business_id = $1 AND ${SALE_TYPES_SQL}
    AND m.occurred_at >= NOW() - ($2 || ' months')::interval ${where}`;
  try {
    const rows = await db.query(
      `${SALE_SELECT} WHERE ${windowSql} ORDER BY m.occurred_at DESC, m.id DESC LIMIT 100 OFFSET 0`, all);
    const agg = await db.query(
      `SELECT COUNT(*)::int AS n,
              COALESCE(SUM(${NET_UNITS_SQL}),0)::int AS units,
              COALESCE(SUM(${NET_UNITS_SQL} * COALESCE(si.price,0)),0)::numeric AS revenue
       FROM stock_movements m
       JOIN stock_items si ON si.id = m.item_id
       JOIN shops sh ON sh.id = m.shop_id
       WHERE ${windowSql}`, all);
    const a = agg.rows[0];
    console.log(`✓ ${label.padEnd(34)} rows=${String(rows.rows.length).padStart(3)}  n=${String(a.n).padStart(3)}  units=${String(a.units).padStart(3)}  revenue=${a.revenue}`);
    return true;
  } catch (e) {
    console.log(`✗ ${label.padEnd(34)} ${e.message.split('\n')[0]}`);
    return false;
  }
};

const iso = (d) => d.toISOString().slice(0, 10);
const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return iso(d); };

console.log('Real Postgres · real salesFilter from server.js\n');
const results = [];
results.push(await run('no filters (Everything)', {}));
results.push(await run('from = 30 days ago', { from: daysAgo(30) }));
results.push(await run('from = 90 days ago', { from: daysAgo(90) }));
results.push(await run('from + to', { from: daysAgo(30), to: daysAgo(5) }));
results.push(await run('staffId = 1', { staffId: '1' }));
results.push(await run('from + staffId', { from: daysAgo(30), staffId: '2' }));
results.push(await run('free-text search', { q: 'KAFTAN' }));
results.push(await run('from + staff + search', { from: daysAgo(60), staffId: '1', q: 'MAX' }));
results.push(await run('colour filter', { color: 'APPLE' }));
results.push(await run('sku filter', { sku: 'MT-1001' }));

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
