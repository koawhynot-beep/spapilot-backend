// Runs the REAL import handler's SQL against REAL Postgres, on rows taken
// verbatim from the shop's spreadsheet.
//
// The two things being checked are the ones that would be expensive to get
// wrong on 1,800 rows: the quantity that lands is SALDO AKHIR and nothing
// else, and running the import twice updates rather than duplicating.
import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';

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
    last_sold_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE UNIQUE INDEX idx_stock_shop_sku ON stock_items(shop_id, UPPER(sku)) WHERE COALESCE(sku,'') <> '';
  INSERT INTO businesses (name) VALUES ('Mitra Samadi');
  INSERT INTO shops (business_id, name, code) VALUES (1,'Rose Gold','RG'), (1,'Atriq','AT');
`);

// The rows the parser produces from the sheet, quantity already taken from
// saldo akhir.
const ROWS = [
  { sku: 'AG-1001', name: 'AGUSTINE DRESS LONG CHEETAH BLACK BEIGE O/S', style: 'AGUSTINE DRESS LONG', color: 'CHEETAH BLACK BEIGE', size: 'O/S', price: 950000, qty: 0 },
  { sku: 'AG-1048', name: 'AGUSTINE DRESS LONG LEOPARD BLACK BEIGE O/S', style: 'AGUSTINE DRESS LONG', color: 'LEOPARD BLACK BEIGE', size: 'O/S', price: 950000, qty: 1 },
  { sku: 'CH-1001', name: 'CHICAGO JUMPSUIT BLACK O/S', style: 'CHICAGO JUMPSUIT', color: 'BLACK', size: 'O/S', price: 895000, qty: 2 },
  { sku: 'IN-3011', name: 'INDIGO DRESS STONE O/S', style: 'INDIGO DRESS', color: 'STONE', size: 'O/S', price: 1500000, qty: 2 },
  { sku: 'AG-2024', name: 'AGUA SHIRT OFF WHITE S/M', style: 'AGUA SHIRT', color: 'OFF WHITE', size: 'S/M', price: 1600000, qty: 0 },
  { sku: 'PR-108 (5&6)', name: 'BAISE ROSE GOLD OVAL STACK RING 5 & 6', style: 'BAISE', color: 'ROSE GOLD OVAL STACK RING', size: '5 & 6', price: 2500000, qty: 0 },
];

// The handler's own upsert, run the way the server runs it.
async function importRows(shopId, rows) {
  const byCode = new Map();
  for (const r of rows) byCode.set(r.sku.toUpperCase(), r);
  const deduped = [...byCode.values()];

  const { rows: existing } = await db.query('SELECT id, sku FROM stock_items WHERE shop_id = $1', [shopId]);
  const idByCode = new Map(existing.map(e => [String(e.sku || '').toUpperCase(), e.id]));
  const { rows: posRows } = await db.query('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM stock_items WHERE shop_id = $1', [shopId]);
  let position = Number(posRows[0].p);

  let created = 0, updated = 0;
  for (const r of deduped) {
    const id = idByCode.get(r.sku.toUpperCase());
    const style = r.style || '';
    if (id) {
      await db.query(
        `UPDATE stock_items SET name=$1, category=$2, fabric=$3, color=$4, size=$5,
           price=$6, qty=$7, updated_at=NOW() WHERE id=$8`,
        [r.name, style, style, r.color, r.size, r.price, r.qty, id]
      );
      updated++;
    } else {
      await db.query(
        `INSERT INTO stock_items
           (shop_id, name, category, fabric, print, size, color, sku, brand,
            qty, threshold, supplier, notes, position, image_url, price, cost)
         VALUES ($1,$2,$3,$3,'',$4,$5,$6,'',$7,0,'','',$8,'',$9,0)`,
        [shopId, r.name, style, r.size, r.color, r.sku, r.qty, position++, r.price]
      );
      created++;
    }
  }
  return { created, updated, imported: deduped.length };
}

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : '  — ' + detail}`);
  if (!ok) failures++;
};
const one = async (sql, p) => (await db.query(sql, p)).rows[0];

console.log('Real Postgres · real import upsert, rows from the spreadsheet\n');

const first = await importRows(1, ROWS);
check('every row created on the first run', first.created === 6 && first.updated === 0,
  `${first.created} created, ${first.updated} updated`);

const counts = await one(`SELECT COUNT(*)::int AS n, SUM(qty)::int AS pieces,
                                 COUNT(*) FILTER (WHERE qty > 0)::int AS in_stock
                          FROM stock_items WHERE shop_id = 1`);
check('all six products are in Rose Gold', counts.n === 6, `${counts.n} rows`);
check('pieces total 5 (1 + 2 + 2)', counts.pieces === 5, `${counts.pieces} pieces`);
check('three carry stock', counts.in_stock === 3, `${counts.in_stock} in stock`);

const ag2024 = await one(`SELECT qty FROM stock_items WHERE shop_id=1 AND sku='AG-2024'`);
check('AG-2024 lands 0 from saldo akhir, not 1 from the later count', ag2024.qty === 0, `qty ${ag2024.qty}`);

const ch = await one(`SELECT name, category, fabric, color, size, price, qty FROM stock_items WHERE shop_id=1 AND sku='CH-1001'`);
check('name, colour, size and price all land',
  ch.name === 'CHICAGO JUMPSUIT BLACK O/S' && ch.color === 'BLACK' && ch.size === 'O/S' && Number(ch.price) === 895000 && ch.qty === 2,
  JSON.stringify(ch));
check('style fills the grouping the Overview reads by',
  ch.category === 'CHICAGO JUMPSUIT' && ch.fabric === 'CHICAGO JUMPSUIT', `${ch.category} / ${ch.fabric}`);

const ring = await one(`SELECT sku, size FROM stock_items WHERE shop_id=1 AND sku='PR-108 (5&6)'`);
check('a code with spaces and brackets survives', ring && ring.size === '5 & 6', JSON.stringify(ring));

// Nothing landed in the other shop.
const atriq = await one('SELECT COUNT(*)::int AS n FROM stock_items WHERE shop_id = 2');
check('Atriq is untouched', atriq.n === 0, `${atriq.n} rows at Atriq`);

// The second run — the one that matters.
console.log('\n  running it again');
const updatedRows = ROWS.map(r => r.sku === 'CH-1001' ? { ...r, qty: 7 } : r);
const second = await importRows(1, updatedRows);
check('nothing is created twice', second.created === 0 && second.updated === 6,
  `${second.created} created, ${second.updated} updated`);

const after = await one('SELECT COUNT(*)::int AS n FROM stock_items WHERE shop_id = 1');
check('still six products, not twelve', after.n === 6, `${after.n} rows`);
const ch2 = await one(`SELECT qty FROM stock_items WHERE shop_id=1 AND sku='CH-1001'`);
check('a changed quantity is picked up', ch2.qty === 7, `qty ${ch2.qty}`);

// A repeated code within one sheet collapses rather than colliding.
console.log('\n  a code repeated inside the sheet');
const dupes = [
  { sku: 'DUP-1', name: 'FIRST', style: 'S', color: 'RED', size: 'S', price: 100000, qty: 1 },
  { sku: 'dup-1', name: 'SECOND, SAME CODE', style: 'S', color: 'BLUE', size: 'M', price: 100000, qty: 4 },
];
const d = await importRows(1, dupes);
check('the repeat collapses to one item', d.imported === 1, `${d.imported} imported`);
const dupRow = await one(`SELECT name, qty FROM stock_items WHERE shop_id=1 AND UPPER(sku)='DUP-1'`);
check('the last of the repeats wins', dupRow.name === 'SECOND, SAME CODE' && dupRow.qty === 4, JSON.stringify(dupRow));

// And the index actually prevents a duplicate slipping in another way.
console.log('\n  the code is unique within a shop');
let blocked = false;
try {
  await db.query(`INSERT INTO stock_items (shop_id, name, sku, qty) VALUES (1,'SNEAKY','ch-1001',1)`);
} catch { blocked = true; }
check('a second row with the same code is refused', blocked, 'the insert was allowed');
await db.query(`INSERT INTO stock_items (shop_id, name, sku, qty) VALUES (2,'SAME CODE, OTHER SHOP','CH-1001',1)`);
const other = await one(`SELECT COUNT(*)::int AS n FROM stock_items WHERE shop_id=2 AND sku='CH-1001'`);
check('but the same code is fine in the other shop', other.n === 1, `${other.n} rows`);

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
