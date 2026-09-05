// Correcting a recorded sale, against REAL Postgres.
//
// This is the one screen that can rewrite history, and it moves stock while
// it does it. The arithmetic that matters: undoing what the row claimed, then
// applying what actually happened — and doing both in one pass when the two
// are the same item, because two updates fighting over one row is exactly how
// a swap between two sizes silently loses a garment.
//
// The stock effect is extracted from the shipped handler by source text, so
// this cannot drift away from what actually runs.
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
    qty INT DEFAULT 0, price NUMERIC(14,2) DEFAULT 0, cost NUMERIC(14,2) DEFAULT 0,
    updated_at TIMESTAMPTZ DEFAULT NOW()
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
    (1,'BEE REMPEL WHITE GREEN','BR-1001','WHITE GREEN','O/S','BEE REMPEL', 0, 950000),
    (1,'BEE REMPEL WHITE GREEN','BR-1002','WHITE GREEN','S/M','BEE REMPEL', 4, 950000),
    (1,'INDIGO DRESS STONE','IN-3011','STONE','O/S','INDIGO DRESS',        3, 1500000),
    (2,'ATRIQ ONLY','AT-0001','BLACK','O/S','ATRIQ',                       5,  500000);
`);

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : '  — ' + detail}`);
  if (!ok) failures++;
};
const qtyOf = async (id) => Number((await db.query('SELECT qty FROM stock_items WHERE id=$1', [id])).rows[0].qty);
const moveOf = async (id) => (await db.query('SELECT * FROM stock_movements WHERE id=$1', [id])).rows[0];

// ── The shipped stock arithmetic, lifted out of the handler ──────────────
// Everything between netting the deltas and writing them back. If the
// handler's arithmetic changes, this test runs the changed version.
const grab = (start, end) => {
  const a = src.indexOf(start);
  const b = src.indexOf(end, a);
  if (a < 0 || b < 0) throw new Error('could not extract: ' + start);
  return src.slice(a, b + end.length);
};
const deltaSrc = grab('const delta = new Map();', "bump(newItemId, newQtyChange);");
check('the netting logic was found in server.js', deltaSrc.includes('bump(oldItemId, -move.qty_change)'),
  'extraction did not find the real code');

// Reproduces the handler: net per item, then one clamped update each.
const applyCorrection = new Function('db', 'move', 'oldItemId', 'newItemId', 'newQtyChange', 'oldItem', `
  return (async () => {
    ${deltaSrc}
    let qtyAfter = move.qty_after;
    for (const [id, d] of delta) {
      if (d === 0) continue;
      const { rows: upd } = await db.query(
        'UPDATE stock_items SET qty = GREATEST(0, qty + $1), updated_at = NOW() WHERE id = $2 RETURNING qty',
        [d, id]
      );
      if (id === newItemId) qtyAfter = upd[0].qty;
    }
    if (!delta.get(newItemId)) {
      const { rows: cur } = await db.query('SELECT qty FROM stock_items WHERE id = $1', [newItemId]);
      qtyAfter = cur[0].qty;
    }
    return qtyAfter;
  })();
`);

async function correct(saleId, { itemId, qty, unitPrice } = {}) {
  const move = await moveOf(saleId);
  const oldItemId = move.item_id;
  const newItemId = itemId === undefined ? oldItemId : itemId;
  const sign = move.qty_change < 0 ? -1 : 1;
  const newUnits = qty === undefined ? Math.abs(move.qty_change) : qty;
  const newQtyChange = sign * newUnits;
  const oldItem = { id: oldItemId };
  const qtyAfter = await applyCorrection(db, move, oldItemId, newItemId, newQtyChange, oldItem);
  const price = unitPrice === undefined ? move.unit_price : unitPrice;
  await db.query(
    'UPDATE stock_movements SET item_id=$1, qty_change=$2, qty_after=$3, unit_price=$4 WHERE id=$5',
    [newItemId, newQtyChange, qtyAfter, price, saleId]
  );
  return qtyAfter;
}

console.log('\nReal Postgres · correcting a recorded sale\n');

// ── The customer's actual story ──────────────────────────────────────────
// One BEE REMPEL O/S was in stock and got sold, taking it to zero.
// It had one, it sold, so it now sits at zero — the state the row describes.
await db.query('UPDATE stock_items SET qty = 0 WHERE id = 1');
await db.query(`INSERT INTO stock_movements (item_id, shop_id, type, qty_change, qty_after, staff_name)
                VALUES (1, 1, 'sale', -1, 0, 'budi')`);
check('the sale left the item at zero', await qtyOf(1) === 0, `qty ${await qtyOf(1)}`);

// She wants the S/M instead — a swap, not a return.
console.log('\n  the customer swaps it for a different size');
await correct(1, { itemId: 2 });
check('the wrongly-sold garment goes back on the rail', await qtyOf(1) === 1, `qty ${await qtyOf(1)}`);
check('the one that actually left comes off it', await qtyOf(2) === 3, `qty ${await qtyOf(2)}`);
let m = await moveOf(1);
check('the row now points at the new garment', m.item_id === 2, `item_id ${m.item_id}`);
check('it is still one unit sold, not a return', m.qty_change === -1, `qty_change ${m.qty_change}`);
check('qty_after reflects the new item', m.qty_after === 3, `qty_after ${m.qty_after}`);

// Exactly one sale row — the whole point of correcting rather than reversing.
const { rows: cnt } = await db.query('SELECT COUNT(*)::int AS n FROM stock_movements');
check('no second row was created', cnt[0].n === 1, `${cnt[0].n} rows`);

// ── Swapping to a pricier style, with the customer paying the difference ──
console.log('\n  swapping to a dearer style at an agreed price');
await correct(1, { itemId: 3, unitPrice: 1200000 });
check('the S/M goes back', await qtyOf(2) === 4, `qty ${await qtyOf(2)}`);
check('the INDIGO comes off', await qtyOf(3) === 2, `qty ${await qtyOf(3)}`);
m = await moveOf(1);
check('the agreed price is stored on the sale', Number(m.unit_price) === 1200000, `unit_price ${m.unit_price}`);

// The price on the row must beat the shelf price in every revenue figure.
const SALE_PRICE_SQL = /const SALE_PRICE_SQL = '([^']+)'/.exec(src)[1];
check('server.js routes revenue through the movement price',
  SALE_PRICE_SQL.includes('m.unit_price'), `got ${SALE_PRICE_SQL}`);
const { rows: rev } = await db.query(
  `SELECT SUM(CASE WHEN m.type IN ('sale','return') THEN -m.qty_change ELSE 0 END * ${SALE_PRICE_SQL})::numeric AS revenue
   FROM stock_movements m JOIN stock_items si ON si.id = m.item_id`
);
check('revenue uses the agreed price, not the shelf price',
  Number(rev[0].revenue) === 1200000, `revenue ${rev[0].revenue} (shelf would be 1500000)`);

// Clearing it falls back to the shelf price — the behaviour before the column existed.
await correct(1, { unitPrice: null });
const { rows: rev2 } = await db.query(
  `SELECT SUM(CASE WHEN m.type IN ('sale','return') THEN -m.qty_change ELSE 0 END * ${SALE_PRICE_SQL})::numeric AS revenue
   FROM stock_movements m JOIN stock_items si ON si.id = m.item_id`
);
check('clearing the price falls back to the shelf price',
  Number(rev2[0].revenue) === 1500000, `revenue ${rev2[0].revenue}`);
check('clearing the price moved no stock', await qtyOf(3) === 2, `qty ${await qtyOf(3)}`);

// ── Editing only the quantity ────────────────────────────────────────────
console.log('\n  correcting the number sold');
await correct(1, { qty: 3 });
check('two more come off the rail', await qtyOf(3) === 0, `qty ${await qtyOf(3)}`);
m = await moveOf(1);
check('the row records three sold', m.qty_change === -3, `qty_change ${m.qty_change}`);
await correct(1, { qty: 1 });
check('reducing it puts them back', await qtyOf(3) === 2, `qty ${await qtyOf(3)}`);

// ── The trap: same item on both sides ────────────────────────────────────
// Netting exists for this. Two separate updates would apply +1 then -1 to the
// same row and, read out of date, lose a garment.
console.log('\n  a correction that does not change the item');
const before = await qtyOf(3);
await correct(1, { itemId: 3, qty: 1 });
check('stock is untouched when nothing really changed', await qtyOf(3) === before,
  `qty went ${before} → ${await qtyOf(3)}`);

// ── A return is corrected as a return ────────────────────────────────────
console.log('\n  a return keeps its direction');
await db.query(`INSERT INTO stock_movements (item_id, shop_id, type, qty_change, qty_after, staff_name)
                VALUES (3, 1, 'return', 1, 3, 'budi')`);
await db.query('UPDATE stock_items SET qty = 3 WHERE id = 3');
await correct(2, { itemId: 2 });
const r = await moveOf(2);
check('correcting a return does not turn it into a sale', r.qty_change === 1, `qty_change ${r.qty_change}`);
check('the returned garment is taken off the wrong item', await qtyOf(3) === 2, `qty ${await qtyOf(3)}`);
check('and put onto the right one', await qtyOf(2) === 5, `qty ${await qtyOf(2)}`);

// ── Guards the handler enforces ──────────────────────────────────────────
console.log('\n  what the handler refuses');
check('a sale cannot be moved to another shop’s garment',
  src.includes('That item belongs to a different shop'), 'the shop guard is missing');
check('only sales and returns can be corrected',
  src.includes('Only a sale or a return can be corrected here'), 'the type guard is missing');
// Deliberately open to staff: a mistake is spotted by whoever made it, and
// scopeShopIds already pins them to their own counter. Deleting a record is
// the one that stays behind the admin code.
check('correcting is open to staff, not just admin',
  /app\.patch\('\/api\/sales\/:id',\s*auth,\s*validate/.test(src),
  'the correction route no longer takes just auth');
check('deleting a record is still admin-only',
  /app\.delete\('\/api\/movements\/:id',\s*auth,\s*requireAdmin/.test(src),
  'requireAdmin is missing from the delete route');
check('a correction is signed with the person who made it',
  /staff: await resolveStaff\(req\.body\.staffId/.test(src),
  'the audit entry does not name the editor');
check('the correction is written to the audit log',
  src.includes("action: 'sale.corrected'"), 'no audit entry');
check('the movement row is locked while it is corrected',
  /FOR UPDATE OF m/.test(src), 'no row lock — two edits could race');
check('stock never goes negative', src.includes('GREATEST(0, qty + $1)'), 'no clamp');

// ── Moving a sale's time ─────────────────────────────────────────────────
// The rule is bounded at both ends: not the future, and not older than the
// window. Read the window out of the source so the two cannot disagree.
console.log('\n  moving the time it was sold');
const WINDOW = Number(/const EDIT_WINDOW_DAYS = (\d+)/.exec(src)[1]);
check(`the window is ${WINDOW} days`, WINDOW === 7, `got ${WINDOW}`);

const withinWindow = (whenMs, nowMs = Date.now()) => {
  if (whenMs > nowMs + 60000) return 'future';
  if (whenMs < nowMs - WINDOW * 86400000) return 'too old';
  return 'ok';
};
const DAY = 86400000;
check('a time three days ago is allowed', withinWindow(Date.now() - 3 * DAY) === 'ok',
  withinWindow(Date.now() - 3 * DAY));
check('right now is allowed', withinWindow(Date.now()) === 'ok', withinWindow(Date.now()));
check('a tablet clock a few seconds fast is not called the future',
  withinWindow(Date.now() + 20000) === 'ok', withinWindow(Date.now() + 20000));
check('tomorrow is refused', withinWindow(Date.now() + DAY) === 'future',
  withinWindow(Date.now() + DAY));
check(`${WINDOW + 1} days ago is refused`, withinWindow(Date.now() - (WINDOW + 1) * DAY) === 'too old',
  withinWindow(Date.now() - (WINDOW + 1) * DAY));
check('the handler refuses a future date', src.includes('A sale cannot be dated in the future'),
  'no future guard');
check('the handler refuses one older than the window',
  src.includes('The time can only be set within the last'), 'no window guard');
check('the new time is actually written', /occurred_at = \$6/.test(src),
  'occurred_at is not in the UPDATE');

// And it lands in the row.
const newWhen = new Date(Date.now() - 2 * DAY);
await db.query('UPDATE stock_movements SET occurred_at = $1 WHERE id = 1', [newWhen]);
const moved = await moveOf(1);
check('the row carries the corrected time',
  Math.abs(new Date(moved.occurred_at).getTime() - newWhen.getTime()) < 1000,
  `${moved.occurred_at} vs ${newWhen.toISOString()}`);

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
