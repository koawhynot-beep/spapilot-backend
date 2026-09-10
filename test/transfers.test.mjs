// Moving stock between shops, against REAL Postgres.
//
// The rule this whole feature exists for is that nothing moves until every
// line is ticked. Everything below is a way of trying to move stock without
// finishing the list — one box short, a line ticked twice, a garment that
// sold while the transfer sat waiting — and checking that none of them work.
import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';

const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');

const db = new PGlite();
await db.exec(`
  CREATE TABLE businesses (id SERIAL PRIMARY KEY, name TEXT);
  CREATE TABLE shops (id SERIAL PRIMARY KEY, business_id INT, name TEXT, code TEXT);
  CREATE TABLE stock_items (
    id SERIAL PRIMARY KEY, shop_id INT REFERENCES shops(id) ON DELETE CASCADE,
    name TEXT, category TEXT DEFAULT '', fabric TEXT DEFAULT '', print TEXT DEFAULT '',
    size TEXT DEFAULT '', color TEXT DEFAULT '', sku TEXT, brand TEXT DEFAULT '',
    qty INT DEFAULT 0, threshold INT DEFAULT 0, supplier TEXT DEFAULT '',
    notes TEXT DEFAULT '', position INT DEFAULT 0, image_url TEXT DEFAULT '',
    price NUMERIC(14,2) DEFAULT 0, cost NUMERIC(14,2) DEFAULT 0,
    updated_at TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE TABLE stock_movements (
    id SERIAL PRIMARY KEY, item_id INT, shop_id INT, user_id INT, type TEXT,
    qty_change INT, qty_after INT, occurred_at TIMESTAMPTZ DEFAULT NOW(), note TEXT DEFAULT ''
  );
  CREATE TABLE stock_transfers (
    id SERIAL PRIMARY KEY, business_id INT REFERENCES businesses(id) ON DELETE CASCADE,
    from_shop_id INT REFERENCES shops(id) ON DELETE CASCADE,
    to_shop_id INT REFERENCES shops(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending', note TEXT DEFAULT '',
    created_by TEXT DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resets_at TIMESTAMPTZ NOT NULL, completed_at TIMESTAMPTZ, completed_by TEXT DEFAULT ''
  );
  CREATE TABLE stock_transfer_lines (
    id SERIAL PRIMARY KEY,
    transfer_id INT REFERENCES stock_transfers(id) ON DELETE CASCADE,
    item_id INT REFERENCES stock_items(id) ON DELETE CASCADE,
    qty INT NOT NULL, checked_at TIMESTAMPTZ, checked_by TEXT DEFAULT ''
  );
  INSERT INTO businesses (name) VALUES ('Boutique');
  INSERT INTO shops (business_id, name, code) VALUES
    (1,'Office','OF'), (1,'Goldust','GD'), (1,'Rose Gold','RG');
  -- Office holds the stock. Goldust carries one of the two garments already.
  INSERT INTO stock_items (shop_id, name, sku, size, color, fabric, qty, price) VALUES
    (1,'DRESS MINI GREEN','DM-1','S','GREEN','LINEN', 10, 900000),
    (1,'DRESS LARGE BLUE','DL-2','L','BLUE','RAMIE',   4, 950000),
    (2,'DRESS MINI GREEN','DM-1','S','GREEN','LINEN',  1, 900000);
`);

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : '  — ' + detail}`);
  if (!ok) failures++;
};
const one = async (sql, p) => (await db.query(sql, p)).rows[0];

const grab = (decl, end) => {
  const a = src.indexOf(decl);
  const b = src.indexOf(end, a);
  if (a < 0 || b < 0) throw new Error('could not extract ' + decl);
  return src.slice(a, b + end.length);
};

// The shipped functions, run as they ship.
const logs = [];
const logger = { info: (k, v) => logs.push([k, v]), warn: (k, v) => logs.push([k, v]), error: (k, v) => logs.push([k, v]) };
const { resetStaleTransfers, completeTransfer, TRANSFER_RESET_HOURS } =
  new Function('logger', `
    ${grab('const TRANSFER_RESET_HOURS =', ';')}
    ${grab('async function resetStaleTransfers(client, businessId) {', '\n}')}
    ${grab('async function completeTransfer(client, req, transferId) {', '\n}')}
    return { resetStaleTransfers, completeTransfer, TRANSFER_RESET_HOURS };
  `)(logger);

const client = { query: (t, p) => db.query(t, p) };
const req = { user: { id: 1, businessId: 1 }, accessRole: 'admin' };

console.log('\nReal Postgres · stock transfers\n');

// ── Building the list ────────────────────────────────────────────────────
console.log('  the list is written down, nothing moves');
const { rows: [transfer] } = await db.query(
  `INSERT INTO stock_transfers (business_id, from_shop_id, to_shop_id, created_by, resets_at)
   VALUES (1, 1, 2, 'admin', NOW() + INTERVAL '48 hours') RETURNING id`);
await db.query(
  `INSERT INTO stock_transfer_lines (transfer_id, item_id, qty) VALUES ($1,1,3), ($1,2,2)`,
  [transfer.id]);

const officeGreen = () => one(`SELECT qty FROM stock_items WHERE id=1`);
const officeBlue = () => one(`SELECT qty FROM stock_items WHERE id=2`);
const goldGreen = () => one(`SELECT qty FROM stock_items WHERE shop_id=2 AND sku='DM-1'`);

check('the source shop still has everything while the transfer waits',
  Number((await officeGreen()).qty) === 10, String((await officeGreen()).qty));

// ── One box short ────────────────────────────────────────────────────────
console.log('\n  one box short');
await db.query(`UPDATE stock_transfer_lines SET checked_at = NOW() WHERE item_id = 1`);
const left = await one(
  `SELECT COUNT(*) FILTER (WHERE checked_at IS NULL)::int AS n FROM stock_transfer_lines WHERE transfer_id=$1`,
  [transfer.id]);
check('one line is still unticked, so completion is not even attempted', left.n === 1, String(left.n));
check('and the stock has not moved', Number((await officeGreen()).qty) === 10,
  String((await officeGreen()).qty));

// ── The 48-hour reset ────────────────────────────────────────────────────
console.log('\n  the reset');
check('the window is 48 hours', TRANSFER_RESET_HOURS === 48, String(TRANSFER_RESET_HOURS));
logs.length = 0;
await resetStaleTransfers(client, 1);
check('a transfer inside its window is left alone',
  Number((await one(`SELECT COUNT(*) FILTER (WHERE checked_at IS NOT NULL)::int AS n
                     FROM stock_transfer_lines WHERE transfer_id=$1`, [transfer.id])).n) === 1,
  'the ticks were cleared early');

await db.query(`UPDATE stock_transfers SET resets_at = NOW() - INTERVAL '1 minute' WHERE id=$1`, [transfer.id]);
await resetStaleTransfers(client, 1);
const afterReset = await one(
  `SELECT COUNT(*) FILTER (WHERE checked_at IS NOT NULL)::int AS ticked, COUNT(*)::int AS n
     FROM stock_transfer_lines WHERE transfer_id=$1`, [transfer.id]);
check('past the window the ticks are cleared', afterReset.ticked === 0, `${afterReset.ticked} left`);
check('but the transfer itself survives — only the checking is undone',
  afterReset.n === 2 && (await one(`SELECT status FROM stock_transfers WHERE id=$1`, [transfer.id])).status === 'pending',
  'the transfer was thrown away too');
check('and the window starts again rather than resetting on every read',
  new Date((await one(`SELECT resets_at FROM stock_transfers WHERE id=$1`, [transfer.id])).resets_at) > new Date(),
  'resets_at was left in the past');
check('it says what it cleared', logs.some(l => l[0] === 'transfer.checks_reset'), 'silent');
logs.length = 0;
await resetStaleTransfers(client, 1);
check('a second sweep straight after does nothing',
  !logs.some(l => l[0] === 'transfer.checks_reset'), 'it keeps clearing');

// ── The whole list ticked ────────────────────────────────────────────────
console.log('\n  every box ticked');
await db.query(`UPDATE stock_transfer_lines SET checked_at = NOW(), checked_by='staff' WHERE transfer_id=$1`,
  [transfer.id]);
const done = await completeTransfer(client, req, transfer.id);
check('it moves', done.moved === true, JSON.stringify(done));
check('the source is down by exactly what was on the list',
  Number((await officeGreen()).qty) === 7 && Number((await officeBlue()).qty) === 2,
  `${(await officeGreen()).qty} / ${(await officeBlue()).qty}`);
check('a garment the destination already carried is topped up, not duplicated',
  Number((await goldGreen()).qty) === 4, String((await goldGreen()).qty));
const gold = await one(`SELECT COUNT(*)::int AS n FROM stock_items WHERE shop_id=2`);
check('a garment the destination had never carried is created there', gold.n === 2, `${gold.n} rows`);
const madeBlue = await one(`SELECT qty, fabric, price, color FROM stock_items WHERE shop_id=2 AND sku='DL-2'`);
check('and it arrives described the same way, not as a bare row',
  Number(madeBlue.qty) === 2 && madeBlue.fabric === 'RAMIE' && madeBlue.color === 'BLUE'
  && Number(madeBlue.price) === 950000,
  JSON.stringify(madeBlue));

const moves = (await db.query(
  `SELECT type, shop_id, qty_change, qty_after FROM stock_movements ORDER BY id`)).rows;
check('both sides are written into the history',
  moves.filter(m => m.type === 'transfer-out').length === 2
  && moves.filter(m => m.type === 'transfer-in').length === 2,
  moves.map(m => m.type).join(','));
check('the history records where each side ended up',
  moves.every(m => m.qty_after >= 0), JSON.stringify(moves));
check('the transfer is marked done and stops appearing on the list',
  (await one(`SELECT status FROM stock_transfers WHERE id=$1`, [transfer.id])).status === 'done',
  'still pending');

console.log('\n  it cannot run twice');
const again = await completeTransfer(client, req, transfer.id);
check('completing a done transfer moves nothing', again.moved === false, JSON.stringify(again));
check('and the quantities are untouched', Number((await officeGreen()).qty) === 7,
  String((await officeGreen()).qty));

// ── Sold out from under it ───────────────────────────────────────────────
console.log('\n  sold while the transfer was waiting');
const { rows: [t2] } = await db.query(
  `INSERT INTO stock_transfers (business_id, from_shop_id, to_shop_id, created_by, resets_at)
   VALUES (1, 1, 2, 'admin', NOW() + INTERVAL '48 hours') RETURNING id`);
await db.query(`INSERT INTO stock_transfer_lines (transfer_id, item_id, qty, checked_at)
                VALUES ($1, 1, 5, NOW()), ($1, 2, 1, NOW())`, [t2.id]);
// Office had 7 green left; six sell over the weekend.
await db.query(`UPDATE stock_items SET qty = 1 WHERE id = 1`);
const blocked = await completeTransfer(client, req, t2.id);
check('a fully ticked list still refuses when the stock is not there',
  blocked.moved === false && blocked.short?.length === 1, JSON.stringify(blocked));
check('it names what is short and by how much',
  blocked.short[0].sku === 'DM-1' && blocked.short[0].wanted === 5 && blocked.short[0].have === 1,
  JSON.stringify(blocked.short));
check('and nothing at all moves — not even the line that could have been filled',
  Number((await officeBlue()).qty) === 2 && Number((await goldGreen()).qty) === 4,
  `blue ${(await officeBlue()).qty}, gold green ${(await goldGreen()).qty}`);
check('the transfer stays pending so it can be looked at',
  (await one(`SELECT status FROM stock_transfers WHERE id=$1`, [t2.id])).status === 'pending',
  'it was quietly closed');

// ── What the routes enforce ──────────────────────────────────────────────
console.log('\n  what the endpoints enforce');
check('only the admin can raise a transfer',
  /app\.post\('\/api\/transfers', auth, requireAdmin/.test(src), 'requireAdmin missing');
check('only the admin can call one off',
  /app\.delete\('\/api\/transfers\/:id', auth, requireAdmin/.test(src), 'requireAdmin missing');
check('everyone can see what is waiting to be checked',
  /app\.get\('\/api\/transfers', auth, async/.test(src), 'the list is admin-only');
check('everyone can tick a box',
  /app\.post\('\/api\/transfers\/:id\/lines\/:lineId', auth, checkTransferLine\)/.test(src),
  'ticking is admin-only');
check('a box can be un-ticked as well as ticked',
  /app\.delete\('\/api\/transfers\/:id\/lines\/:lineId', auth, checkTransferLine\)/.test(src),
  'no way to undo a tick');
check('completion is reached only from the tick that leaves none unchecked',
  /if \(remaining\.left === 0\) \{\s*\n\s*result = await completeTransfer/.test(src),
  'something else can complete a transfer');
check('a transfer to the shop it came from is refused',
  src.includes('Pick a different shop to send it to'), 'no guard');
check('a line is refused if the source does not have it',
  src.includes("reason: 'notAtSource'") && src.includes("reason: 'notEnough'"), 'no stock check');
check('the same garment added twice adds up rather than making two lines',
  /wanted\.set\(l\.itemId, \(wanted\.get\(l\.itemId\) \|\| 0\) \+ l\.qty\)/.test(src), 'duplicates possible');
// Scoped to the transfer code: `expiresIn` elsewhere is the JWT lifetime.
const transferSrc = src.slice(src.indexOf('// STOCK TRANSFERS'), src.indexOf('// STOCK CHECK'));
check('no countdown is ever sent to the browser',
  !/hoursLeft|hours_left|timeLeft|expiresIn|clearsAt/.test(transferSrc),
  'a countdown leaked into the API');
check('resets_at is never returned either, so no clock can be built from it',
  !/resetsAt|resets_at:/.test(transferSrc), 'the reset time is exposed');

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
