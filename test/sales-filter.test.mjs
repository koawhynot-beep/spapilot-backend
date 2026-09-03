// Runs the REAL scoping and filter functions from server.js against REAL
// Postgres (PGlite is Postgres compiled to WASM).
//
// Two things this guards, both of which have already gone wrong once:
//
//   1. Placeholder construction. A round of edits dropped the $ from every
//      "$${push(...)}", so the SQL read "m.occurred_at >= 3" and Postgres
//      answered "operator does not exist: timestamp with time zone >=
//      integer". A mock that reimplements the filter in JavaScript cannot
//      catch that, because it never runs the SQL the server builds.
//
//   2. Shop leakage. With two shops, a query that forgets its scope quietly
//      mixes Atriq's takings into Gold Dust's report. That is a wrong number
//      nobody notices until it is used to pay someone.
import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';

const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');

const grab = (startMarker, endMarker) => {
  const a = src.indexOf(startMarker);
  const b = src.indexOf(endMarker, a);
  if (a < 0 || b < 0) throw new Error('could not extract ' + startMarker);
  return src.slice(a, b + endMarker.length);
};
const value = (decl, end) =>
  // eslint-disable-next-line no-eval
  eval(grab(decl, end).slice(decl.length).replace(/;$/, ''));

const SALE_TYPES_SQL = value('const SALE_TYPES_SQL =', ';');
const NET_UNITS_SQL = value('const NET_UNITS_SQL =', ';');
const SALE_SELECT = value('const SALE_SELECT =', '`;');
const HISTORY_MONTHS = 24;

const db = new PGlite();
// The functions under test call pool.query; give them the real database.
const pool = { query: (text, params) => db.query(text, params) };

// Build the real functions in a scope where their dependencies exist, so the
// code being tested is the code that ships.
const build = new Function('pool', `
  ${grab('const parseShopIds = (v) => {', '\n};')}
  ${grab('async function scopeShopIds(req) {', '\n}')}
  ${grab('async function salesFilter(req, startParamIndex) {', '\n}')}
  return { salesFilter, scopeShopIds, parseShopIds };
`);
const { salesFilter } = build(pool);

await db.exec(`
  CREATE TABLE businesses (id SERIAL PRIMARY KEY, name TEXT);
  CREATE TABLE shops (id SERIAL PRIMARY KEY, business_id INT, name TEXT, address TEXT, code TEXT);
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
  INSERT INTO shops (business_id, name, address, code) VALUES (1, 'Gold Dust', '', 'GD');
  INSERT INTO shops (business_id, name, address, code) VALUES (1, 'Atriq', '', 'AT');
  INSERT INTO staff (business_id, shop_id, name, commission_rate) VALUES (1, 1, 'budi', 5);
  INSERT INTO staff (business_id, shop_id, name, commission_rate) VALUES (1, 2, 'Belina', 2.5);
  INSERT INTO stock_items (shop_id, name, sku, color, size, category, fabric, price, cost, qty)
    VALUES (1, 'MAX TOP NATURAL O/S', 'MT-1001', 'NATURAL', 'O/S', 'MAX TOP', 'COTTON', 750000, 300000, 7),
           (2, 'BUBBLE KAFTAN APPLE S/M', 'BU-3040', 'APPLE', 'S/M', 'KAFTAN', 'BUBBLE', 1350000, 560000, 4);
`);

// 40 sales at Gold Dust, 20 at Atriq, every 11th a return.
for (let i = 0; i < 60; i++) {
  const atriq = i >= 40;
  const isReturn = i % 11 === 0;
  await db.query(
    `INSERT INTO stock_movements (item_id, shop_id, user_id, type, qty_change, qty_after, occurred_at, staff_id, staff_name)
     VALUES ($1, $2, 1, $3, $4, 5, NOW() - ($5 || ' days')::interval, $6, $7)`,
    [atriq ? 2 : 1, atriq ? 2 : 1, isReturn ? 'return' : 'sale', isReturn ? 1 : -1,
     String(i % 45), atriq ? 2 : 1, atriq ? 'Belina' : 'budi']
  );
}

const GOLD_DUST = 1, ATRIQ = 2;
let failures = 0;

async function run(label, req, expect) {
  const { where, params } = await salesFilter(req, 3);
  const all = [1, String(HISTORY_MONTHS), ...params];
  const windowSql = `sh.business_id = $1 AND ${SALE_TYPES_SQL}
    AND m.occurred_at >= NOW() - ($2 || ' months')::interval ${where}`;
  try {
    const rows = await db.query(
      `${SALE_SELECT} WHERE ${windowSql} ORDER BY m.occurred_at DESC, m.id DESC LIMIT 500`, all);
    const agg = await db.query(
      `SELECT COUNT(*)::int AS n,
              COALESCE(SUM(${NET_UNITS_SQL}),0)::int AS units,
              COALESCE(SUM(${NET_UNITS_SQL} * COALESCE(si.price,0)),0)::numeric AS revenue
       FROM stock_movements m
       JOIN stock_items si ON si.id = m.item_id
       JOIN shops sh ON sh.id = m.shop_id
       WHERE ${windowSql}`, all);

    const shopsSeen = [...new Set(rows.rows.map(r => r.shop_id))].sort();
    const n = agg.rows[0].n;
    let problem = null;
    if (expect.shops && String(shopsSeen) !== String(expect.shops)) {
      problem = `saw shops [${shopsSeen}], expected [${expect.shops}]`;
    }
    if (!problem && expect.n !== undefined && n !== expect.n) {
      problem = `n=${n}, expected ${expect.n}`;
    }
    if (problem) { failures++; console.log(`✗ ${label.padEnd(40)} ${problem}`); }
    else console.log(`✓ ${label.padEnd(40)} n=${String(n).padStart(3)}  shops=[${shopsSeen}]`);
  } catch (e) {
    failures++;
    console.log(`✗ ${label.padEnd(40)} ${e.message.split('\n')[0]}`);
  }
}

const iso = (d) => d.toISOString().slice(0, 10);
const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return iso(d); };
const manager = (query = {}) => ({ accessRole: 'admin', query, user: { businessId: 1 } });
const staffAt = (shopId, query = {}) =>
  ({ accessRole: 'staff', scopeShopId: shopId, query, user: { businessId: 1 } });

console.log('Real Postgres · real salesFilter and scopeShopIds from server.js\n');

console.log('  manager — sees whichever shops are asked for');
await run('no filters (every shop)', manager(), { shops: [GOLD_DUST, ATRIQ], n: 60 });
await run('shops=1 (Gold Dust only)', manager({ shops: '1' }), { shops: [GOLD_DUST], n: 40 });
await run('shops=2 (Atriq only)', manager({ shops: '2' }), { shops: [ATRIQ], n: 20 });
await run('shops=1,2 (both, explicitly)', manager({ shops: '1,2' }), { shops: [GOLD_DUST, ATRIQ], n: 60 });
await run('from = 30 days ago', manager({ from: daysAgo(30) }), { shops: [GOLD_DUST, ATRIQ] });
await run('from + staff + search', manager({ from: daysAgo(60), staffId: '1', q: 'MAX' }), { shops: [GOLD_DUST] });

console.log('\n  staff — pinned to their own shop, whatever they ask for');
await run('Gold Dust staff', staffAt(GOLD_DUST), { shops: [GOLD_DUST], n: 40 });
await run('Atriq staff', staffAt(ATRIQ), { shops: [ATRIQ], n: 20 });
// The important ones: a staff session must not be able to widen its own scope.
await run('Atriq staff asking for shops=1', staffAt(ATRIQ, { shops: '1' }), { shops: [ATRIQ], n: 20 });
await run('Atriq staff asking for shops=1,2', staffAt(ATRIQ, { shops: '1,2' }), { shops: [ATRIQ], n: 20 });
await run('Atriq staff asking for shops=all', staffAt(ATRIQ, { shops: 'all' }), { shops: [ATRIQ], n: 20 });
await run('Gold Dust staff, dated + search', staffAt(GOLD_DUST, { from: daysAgo(30), q: 'MAX' }), { shops: [GOLD_DUST] });

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
