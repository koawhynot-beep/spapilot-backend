// Deleting a movement, and the stock in/out log, against REAL Postgres.
//
// Deleting is the dangerous one: it changes stock and destroys a row, and the
// direction of the correction is the opposite of the row's own sign. Get that
// backwards and deleting a mistaken sale takes a second garment off the rail
// instead of putting one back — which looks plausible on screen and is only
// caught at the next stock check.
import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';

const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');

const db = new PGlite();
await db.exec(`
  CREATE TABLE businesses (id SERIAL PRIMARY KEY, name TEXT);
  CREATE TABLE shops (id SERIAL PRIMARY KEY, business_id INT, name TEXT, code TEXT);
  CREATE TABLE stock_items (
    id SERIAL PRIMARY KEY, shop_id INT REFERENCES shops(id) ON DELETE CASCADE,
    name TEXT, sku TEXT, color TEXT, size TEXT, fabric TEXT, category TEXT,
    qty INT DEFAULT 0, price NUMERIC(14,2) DEFAULT 0, updated_at TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE TABLE stock_movements (
    id SERIAL PRIMARY KEY, item_id INT REFERENCES stock_items(id) ON DELETE CASCADE,
    shop_id INT, type TEXT, qty_change INT, qty_after INT,
    occurred_at TIMESTAMPTZ DEFAULT NOW(), note TEXT DEFAULT '',
    staff_name TEXT DEFAULT '', staff_id INT, reason TEXT DEFAULT '',
    unit_price NUMERIC(14,2)
  );
  INSERT INTO businesses (name) VALUES ('Mitra Samadi');
  INSERT INTO shops (business_id, name, code) VALUES (1,'Rose Gold','RG'), (1,'Atriq','AT');
  INSERT INTO stock_items (shop_id, name, sku, color, size, fabric, qty, price) VALUES
    (1,'BEE REMPEL WHITE GREEN','BR-1001','WHITE GREEN','O/S','BEE REMPEL', 3, 950000),
    (1,'INDIGO DRESS STONE','IN-3011','STONE','O/S','INDIGO DRESS',        5, 1500000),
    (2,'ATRIQ ONLY','AT-0001','BLACK','O/S','ATRIQ',                       5,  500000);
`);

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : '  — ' + detail}`);
  if (!ok) failures++;
};
const qtyOf = async (id) => Number((await db.query('SELECT qty FROM stock_items WHERE id=$1', [id])).rows[0].qty);
const countMoves = async () => Number((await db.query('SELECT COUNT(*)::int AS n FROM stock_movements')).rows[0].n);

// The shipped undo, lifted out of the handler so this cannot drift from it.
const UNDO = /UPDATE stock_items SET qty = GREATEST\(0, qty - \$1\), updated_at = NOW\(\) WHERE id = \$2 RETURNING qty/;
check('the delete handler undoes by subtracting qty_change', UNDO.test(src),
  'the undo statement in server.js is not the one this test exercises');

async function deleteMovement(id) {
  const { rows } = await db.query('SELECT * FROM stock_movements WHERE id=$1', [id]);
  if (!rows.length) return null;
  const move = rows[0];
  await db.query(
    'UPDATE stock_items SET qty = GREATEST(0, qty - $1), updated_at = NOW() WHERE id = $2 RETURNING qty',
    [move.qty_change, move.item_id]
  );
  await db.query('DELETE FROM stock_movements WHERE id = $1', [id]);
  return move;
}

console.log('\nReal Postgres · deleting a movement, and the stock in/out log\n');

// ── A sale rung up by mistake ────────────────────────────────────────────
console.log('  a sale rung up by mistake');
await db.query('UPDATE stock_items SET qty = 2 WHERE id = 1');   // 3 was sold down to 2
await db.query(`INSERT INTO stock_movements (item_id, shop_id, type, qty_change, qty_after, staff_name)
                VALUES (1, 1, 'sale', -1, 2, 'budi')`);
await deleteMovement(1);
check('the garment goes back on the rail', await qtyOf(1) === 3, `qty ${await qtyOf(1)}`);
check('the row is gone from the history', await countMoves() === 0, `${await countMoves()} rows left`);

// ── A stock-in entered twice ─────────────────────────────────────────────
console.log('\n  a delivery entered twice');
await db.query('UPDATE stock_items SET qty = 13 WHERE id = 1');
await db.query(`INSERT INTO stock_movements (item_id, shop_id, type, qty_change, qty_after, staff_name)
                VALUES (1, 1, 'in', 10, 13, 'budi')`);
await deleteMovement(2);
check('deleting a stock-in takes the pieces back off', await qtyOf(1) === 3, `qty ${await qtyOf(1)}`);

// ── A write-off that never happened ──────────────────────────────────────
console.log('\n  a write-off that never happened');
await db.query('UPDATE stock_items SET qty = 1 WHERE id = 1');
await db.query(`INSERT INTO stock_movements (item_id, shop_id, type, qty_change, qty_after, reason, staff_name)
                VALUES (1, 1, 'removal', -2, 1, 'Damaged', 'budi')`);
await deleteMovement(3);
check('deleting a write-off puts the pieces back', await qtyOf(1) === 3, `qty ${await qtyOf(1)}`);

// ── A return that was recorded in error ──────────────────────────────────
console.log('\n  a return recorded in error');
await db.query('UPDATE stock_items SET qty = 4 WHERE id = 1');
await db.query(`INSERT INTO stock_movements (item_id, shop_id, type, qty_change, qty_after, staff_name)
                VALUES (1, 1, 'return', 1, 4, 'budi')`);
await deleteMovement(4);
check('deleting a return takes the piece back off', await qtyOf(1) === 3, `qty ${await qtyOf(1)}`);

// Stock must never be driven below zero by an undo.
console.log('\n  the clamp');
await db.query('UPDATE stock_items SET qty = 0 WHERE id = 2');
await db.query(`INSERT INTO stock_movements (item_id, shop_id, type, qty_change, qty_after, staff_name)
                VALUES (2, 1, 'in', 5, 0, 'budi')`);
await deleteMovement(5);
check('undoing never drives stock negative', await qtyOf(2) === 0, `qty ${await qtyOf(2)}`);
await db.query('UPDATE stock_items SET qty = 5 WHERE id = 2');

// ── What the handler refuses ─────────────────────────────────────────────
console.log('\n  what the delete handler enforces');
check('deleting is admin-only',
  /app\.delete\('\/api\/movements\/:id',\s*auth,\s*requireAdmin/.test(src), 'requireAdmin is missing');
check('the row is locked while it is deleted', /FOR UPDATE OF m/.test(src), 'no row lock');
check('the shop scope is enforced', src.includes('movement.delete.error') && /shopAllowed\(req, move\.shop_id\)/.test(src),
  'no shop check');
check('what was deleted is written to the audit log',
  src.includes("action: 'movement.deleted'"), 'no audit entry');
check('the deleted row is kept in the audit log, not just its id',
  /before: \{\s*\n\s*type: move\.type/.test(src), 'the before-value does not carry the row');
check('nothing is soft-deleted', !/is_deleted|deleted_at/.test(src),
  'a soft-delete column would have to be excluded from every revenue query');

// ── The stock in/out log ─────────────────────────────────────────────────
// The types each direction covers, read out of the shipped source so a new
// movement type cannot quietly go missing from the screen.
console.log('\n  the stock in/out log');
const dirIn = /if \(dir === 'in'\) typeSql = "([^"]+)"/.exec(src)[1];
const dirOut = /else if \(dir === 'out'\) typeSql = "([^"]+)"/.exec(src)[1];
const both = /const STOCK_MOVE_TYPES_SQL =\s*\n?\s*"([^"]+)"/.exec(src)[1];

check('the log excludes sales and returns',
  !/'sale'/.test(both) && !/'return'/.test(both), `it selects ${both}`);
check('inbound covers stock-in and transfers in', dirIn.includes("'in'") && dirIn.includes("'transfer-in'"), dirIn);
check('outbound covers write-offs and transfers out', dirOut.includes("'removal'") && dirOut.includes("'transfer-out'"), dirOut);

await db.query(`INSERT INTO stock_movements (item_id, shop_id, type, qty_change, qty_after, reason, staff_name) VALUES
  (1, 1, 'in',      10, 13, '',        'budi'),
  (1, 1, 'removal', -2, 11, 'Damaged', 'budi'),
  (1, 1, 'sale',    -1, 10, '',        'budi'),
  (1, 1, 'return',   1, 11, '',        'budi'),
  (3, 2, 'in',       4,  9, '',        'sari')`);

const runLog = async (typeSql, shopIds) => {
  const params = [1];
  let scope = '';
  if (shopIds) { params.push(shopIds); scope = ` AND m.shop_id = ANY($${params.length}::int[])`; }
  const { rows } = await db.query(
    `SELECT m.id, m.type, m.qty_change, m.shop_id
     FROM stock_movements m
     JOIN stock_items si ON si.id = m.item_id
     JOIN shops sh ON sh.id = m.shop_id
     WHERE sh.business_id = $1 AND ${typeSql}${scope}
     ORDER BY m.id`, params);
  return rows;
};

const all = await runLog(both, null);
check('the log shows the delivery and the write-off, not the sale or the return',
  all.length === 3 && all.every(r => r.type === 'in' || r.type === 'removal'),
  all.map(r => r.type).join(', '));

const ins = await runLog(dirIn, null);
check('filtering to inbound shows only what came in',
  ins.length === 2 && ins.every(r => r.qty_change > 0), ins.map(r => `${r.type}:${r.qty_change}`).join(', '));

const outs = await runLog(dirOut, null);
check('filtering to outbound shows only what left',
  outs.length === 1 && outs[0].qty_change < 0, outs.map(r => `${r.type}:${r.qty_change}`).join(', '));

const rg = await runLog(both, [1]);
check('the shop filter is applied', rg.every(r => r.shop_id === 1) && rg.length === 2,
  rg.map(r => `shop${r.shop_id}`).join(', '));

// The totals the screen shows.
const { rows: tot } = await db.query(
  `SELECT COALESCE(SUM(CASE WHEN m.qty_change > 0 THEN m.qty_change ELSE 0 END),0)::int AS in_units,
          COALESCE(SUM(CASE WHEN m.qty_change < 0 THEN -m.qty_change ELSE 0 END),0)::int AS out_units
   FROM stock_movements m
   JOIN stock_items si ON si.id = m.item_id
   JOIN shops sh ON sh.id = m.shop_id
   WHERE sh.business_id = $1 AND ${both}`, [1]);
check('in and out are totalled separately, not netted',
  tot[0].in_units === 14 && tot[0].out_units === 2,
  `in ${tot[0].in_units} (want 14), out ${tot[0].out_units} (want 2)`);

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
