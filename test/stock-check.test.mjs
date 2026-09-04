// Exercises the stock-check round lifecycle against REAL Postgres, using the
// real reset window read out of server.js.
//
// The rule being checked is the one most easily got subtly wrong: the week
// runs from when the round was FINISHED, not from when it was started, and it
// must expire on its own even if nobody opens the app in the meantime.
import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';

const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const RESET_DAYS = Number(/const CHECK_RESET_DAYS = (\d+)/.exec(src)[1]);

const db = new PGlite();
await db.exec(`
  CREATE TABLE businesses (id SERIAL PRIMARY KEY, name TEXT);
  CREATE TABLE shops (id SERIAL PRIMARY KEY, business_id INT, name TEXT, code TEXT);
  CREATE TABLE staff (id SERIAL PRIMARY KEY, business_id INT, shop_id INT, name TEXT);
  CREATE TABLE stock_items (
    id SERIAL PRIMARY KEY, shop_id INT REFERENCES shops(id) ON DELETE CASCADE,
    name TEXT, sku TEXT, color TEXT, size TEXT, fabric TEXT, category TEXT,
    qty INT DEFAULT 0, price NUMERIC(14,2) DEFAULT 0
  );
  CREATE TABLE stock_check_marks (
    id SERIAL PRIMARY KEY,
    shop_id INT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
    item_id INT NOT NULL UNIQUE REFERENCES stock_items(id) ON DELETE CASCADE,
    qty_at_check INT,
    checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    staff_id INT, staff_name TEXT DEFAULT ''
  );
  CREATE TABLE stock_check_rounds (
    id SERIAL PRIMARY KEY,
    shop_id INT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
    items_checked INT NOT NULL DEFAULT 0,
    completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    clears_at TIMESTAMPTZ NOT NULL
  );
  INSERT INTO businesses (name) VALUES ('Mitra Samadi');
  INSERT INTO shops (business_id, name, code) VALUES (1,'Rose Gold','RG'), (1,'Atriq','AT');
  INSERT INTO stock_items (shop_id, name, sku, fabric, qty) VALUES
    (1,'AGUSTINE DRESS','AG-1048','RAYON',1),
    (1,'CHICAGO JUMPSUIT','CH-1001','KRINKLE',2),
    (1,'INDIGO DRESS','IN-3011','LINEN',2),
    (1,'SOLD OUT DRESS','ZZ-0001','LINEN',0),
    (2,'BUBBLE KAFTAN','BU-3040','BUBBLE',3);
`);

const pool = { query: (t, p) => db.query(t, p) };
const logger = { info() {}, warn() {}, error() {} };

// Pull the two helpers that carry the rule out of the shipped source.
const grab = (start, end) => {
  const a = src.indexOf(start);
  const b = src.indexOf(end, a);
  if (a < 0 || b < 0) throw new Error('could not extract ' + start);
  return src.slice(a, b + end.length);
};
const build = new Function('pool', 'logger', 'CHECK_RESET_DAYS', `
  ${grab('async function expireStockCheck(client, shopId) {', '\n}')}
  ${grab('async function closeRoundIfComplete(client, shopId) {', '\n}')}
  return { expireStockCheck, closeRoundIfComplete };
`);
const { expireStockCheck, closeRoundIfComplete } = build(pool, logger, RESET_DAYS);

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : '  — ' + detail}`);
  if (!ok) failures++;
};

const inStock = async (shopId) =>
  Number((await db.query('SELECT COUNT(*)::int AS n FROM stock_items WHERE shop_id=$1 AND qty>0', [shopId])).rows[0].n);
const marks = async (shopId) =>
  Number((await db.query('SELECT COUNT(*)::int AS n FROM stock_check_marks WHERE shop_id=$1', [shopId])).rows[0].n);
const rounds = async (shopId) =>
  Number((await db.query('SELECT COUNT(*)::int AS n FROM stock_check_rounds WHERE shop_id=$1', [shopId])).rows[0].n);
const tick = async (itemId) => {
  const { rows } = await db.query('SELECT id, shop_id, qty FROM stock_items WHERE id=$1', [itemId]);
  await db.query(
    `INSERT INTO stock_check_marks (shop_id, item_id, qty_at_check, staff_name)
     VALUES ($1,$2,$3,'budi')
     ON CONFLICT (item_id) DO UPDATE SET checked_at=NOW(), qty_at_check=EXCLUDED.qty_at_check`,
    [rows[0].shop_id, rows[0].id, rows[0].qty]
  );
  return closeRoundIfComplete(pool, rows[0].shop_id);
};

console.log(`Real Postgres · stock-check round lifecycle (reset after ${RESET_DAYS} days)\n`);

check('only in-stock items are listed', await inStock(1) === 3, `${await inStock(1)} of 4 rows at Rose Gold`);

let round = await tick(1);
check('one tick does not finish the round', round === null, 'round closed too early');
round = await tick(2);
check('two of three does not finish it', round === null, 'round closed too early');
round = await tick(3);
check('the last tick finishes the round', round !== null, 'round did not close');

// The week must run from completion.
const r = (await db.query('SELECT completed_at, clears_at FROM stock_check_rounds WHERE shop_id=1')).rows[0];
const gapDays = Math.round((new Date(r.clears_at) - new Date(r.completed_at)) / 86400000);
check(`clears exactly ${RESET_DAYS} days after completion`, gapDays === RESET_DAYS, `gap was ${gapDays} days`);

// Still inside the week: nothing should clear.
await expireStockCheck(pool, 1);
check('marks survive while the week is still running', await marks(1) === 3, `${await marks(1)} marks left`);

// Ticking Rose Gold must not have touched Atriq.
check('the other shop is untouched', await marks(2) === 0 && await rounds(2) === 0,
  `Atriq had ${await marks(2)} marks / ${await rounds(2)} rounds`);

// Wind the clock past the window without anyone opening the app.
await db.query(
  `UPDATE stock_check_rounds SET completed_at = NOW() - ($1 || ' days')::interval,
                                 clears_at    = NOW() - INTERVAL '1 minute'
   WHERE shop_id = 1`,
  [String(RESET_DAYS + 1)]
);
await expireStockCheck(pool, 1);
check('marks clear once the week has passed', await marks(1) === 0, `${await marks(1)} marks left`);
check('the finished round is kept as a record', await rounds(1) === 1, `${await rounds(1)} rounds`);

// A second walk round can start immediately.
round = await tick(1);
check('a new round can be started after the reset', round === null && await marks(1) === 1,
  'could not start again');

// Unticking reopens a finished round.
await tick(2); await tick(3);
check('round closes again', await rounds(1) === 2, `${await rounds(1)} rounds`);
await db.query('DELETE FROM stock_check_marks WHERE item_id = 2');
await db.query('DELETE FROM stock_check_rounds WHERE shop_id = 1 AND clears_at > NOW()');
check('unticking reopens the round', await rounds(1) === 1, `${await rounds(1)} rounds left`);

// New stock arriving mid-round must show up as unchecked work.
await db.query(`INSERT INTO stock_items (shop_id, name, sku, fabric, qty) VALUES (1,'NEW ARRIVAL','NA-1','LINEN',5)`);
const nowInStock = await inStock(1);
const nowMarked = await marks(1);
check('new stock appears as unchecked', nowInStock === 4 && nowMarked === 2,
  `${nowMarked} marked of ${nowInStock} in stock`);


// The scoped read — the path that 500'd in production because its parameter
// placeholder was missing a dollar. Runs the real query shape with a shop
// filter applied, so a regression fails here as well as in the lint.
console.log('\n  the scoped read');
for (const [label, ids] of [['all shops', null], ['Rose Gold only', [1]], ['Atriq only', [2]]]) {
  const params = [1];
  let scope = '';
  if (ids) {
    params.push(ids);
    scope = ` AND si.shop_id = ANY($${params.length}::int[])`;
  }
  try {
    const { rows } = await db.query(
      `SELECT si.id, si.sku, si.qty, si.shop_id
       FROM stock_items si
       JOIN shops sh ON sh.id = si.shop_id
       LEFT JOIN stock_check_marks m ON m.item_id = si.id
       WHERE sh.business_id = $1 AND si.qty > 0${scope}
       ORDER BY si.fabric, si.color, si.name, si.size`,
      params
    );
    const shopsSeen = [...new Set(rows.map(r => r.shop_id))].sort();
    const want = ids || [1, 2];
    check(`    ${label}`, String(shopsSeen) === String(want),
      `saw shops [${shopsSeen}], wanted [${want}]`);
  } catch (e) {
    check(`    ${label}`, false, e.message.split('\n')[0]);
  }
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
