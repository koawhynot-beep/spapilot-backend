// How the customer paid, against REAL Postgres.
//
// The rules worth pinning down are the ones that decide whether a till
// balance is trustworthy:
//   · only a sale carries a method — a delivery has no customer;
//   · the set is closed, so "card"/"Card"/"kartu" cannot become three
//     different payment methods by the end of the month;
//   · a sale taken before this existed reads as "not recorded", never as
//     cash, because guessing invents money that was never counted.
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
    qty INT DEFAULT 0, price NUMERIC(14,2) DEFAULT 0, cost NUMERIC(14,2) DEFAULT 0
  );
  CREATE TABLE stock_movements (
    id SERIAL PRIMARY KEY, item_id INT REFERENCES stock_items(id) ON DELETE CASCADE,
    shop_id INT, type TEXT, qty_change INT, qty_after INT,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), note TEXT DEFAULT '',
    staff_name TEXT DEFAULT '', staff_id INT, reason TEXT DEFAULT '',
    unit_price NUMERIC(14,2), payment TEXT DEFAULT ''
  );
  INSERT INTO businesses (name) VALUES ('Mitra Samadi');
  INSERT INTO shops (business_id, name, code) VALUES (1,'Rose Gold','RG');
  INSERT INTO stock_items (shop_id, name, sku, qty, price) VALUES
    (1,'INDIGO DRESS STONE','IN-3011', 10, 1500000);
`);

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : '  — ' + detail}`);
  if (!ok) failures++;
};

// ── The shipped normaliser, lifted out of the source ─────────────────────
const grab = (start, end) => {
  const a = src.indexOf(start);
  const b = src.indexOf(end, a);
  if (a < 0 || b < 0) throw new Error('could not extract ' + start);
  return src.slice(a, b + end.length);
};
const cleanPayment = new Function(
  `${grab('const PAYMENT_METHODS =', '\n};')} return cleanPayment;`
)();

console.log('\nReal Postgres · how the customer paid\n');

console.log('  the set is closed');
check('cash is accepted', cleanPayment('cash') === 'cash', cleanPayment('cash'));
check('card is accepted', cleanPayment('card') === 'card', cleanPayment('card'));
check('case and padding are normalised', cleanPayment('  Card ') === 'card', `"${cleanPayment('  Card ')}"`);
check('anything else becomes "not recorded"', cleanPayment('kartu') === '', `"${cleanPayment('kartu')}"`);
check('a blank stays blank', cleanPayment('') === '', `"${cleanPayment('')}"`);
check('null does not become the string "null"', cleanPayment(null) === '', `"${cleanPayment(null)}"`);
check('an object cannot be smuggled in', cleanPayment({ toString: () => 'cash' }) === '', 'an object was accepted');

// ── Only a sale is paid for ──────────────────────────────────────────────
console.log('\n  only a sale carries a method');
check('the scan handler blanks it for anything but a sale',
  /const payment = type === 'sale' \? cleanPayment\(req\.body\.payment\) : '';/.test(src),
  'the guard in the scan handler is not there');

const record = async (type, payment) => {
  const { rows } = await db.query(
    `INSERT INTO stock_movements (item_id, shop_id, type, qty_change, qty_after, payment)
     VALUES (1, 1, $1, -1, 9, $2) RETURNING payment`,
    [type, type === 'sale' ? cleanPayment(payment) : '']
  );
  return rows[0].payment;
};
check('a sale keeps cash', await record('sale', 'cash') === 'cash', 'lost');
check('a sale keeps card', await record('sale', 'card') === 'card', 'lost');
check('a stock-in is blanked even if a method is sent', await record('in', 'cash') === '', 'a delivery was marked paid');
check('a write-off is blanked too', await record('removal', 'card') === '', 'a write-off was marked paid');

// ── Old rows ─────────────────────────────────────────────────────────────
console.log('\n  sales taken before this existed');
await db.query(`INSERT INTO stock_movements (item_id, shop_id, type, qty_change, qty_after)
                VALUES (1, 1, 'sale', -1, 8)`);
const { rows: old } = await db.query('SELECT payment FROM stock_movements ORDER BY id DESC LIMIT 1');
check('read back as not recorded, not as cash', old[0].payment === '', `got "${old[0].payment}"`);
check('the column defaults to empty rather than to a method',
  /ADD COLUMN IF NOT EXISTS payment TEXT DEFAULT ''/.test(src), 'the default is not empty');

// ── It reaches the screen and the export ─────────────────────────────────
console.log('\n  it comes back out again');
check('the sale query selects it', /COALESCE\(m\.payment,''\) AS payment/.test(src), 'not in SALE_SELECT');
check('the shape the screens read exposes it', /payment: r\.payment \|\| '',/.test(src), 'not in shapeSale');
check('the CSV has a column for it', /'Paid by'/.test(src), 'not in the CSV header');
check('the CSV writes the value', /r\.staffName, r\.payment, r\.reason/.test(src), 'not in the CSV row');

// ── Correcting a sale can correct the method ─────────────────────────────
console.log('\n  correcting it');
check('the correction endpoint accepts a method',
  /payment: z\.string\(\)\.trim\(\)\.max\(20\)\.optional\(\)/.test(src), 'not in the edit schema');
check('the correction normalises it the same way',
  /cleanPayment\(req\.body\.payment\)/.test(src) && /const payment = req\.body\.payment === undefined/.test(src),
  'the correction path does not normalise');
check('it is written to the row', /payment = \$7/.test(src), 'not in the UPDATE');
check('the audit log records the change', /payment: move\.payment \|\| ''/.test(src), 'not in the audit before-value');

// Leaving it out of a correction must not wipe what is already there.
await db.query(`UPDATE stock_movements SET payment = 'card' WHERE id = 1`);
const keep = (body, current) => (body.payment === undefined ? (current || '') : cleanPayment(body.payment));
check('an edit that does not mention payment leaves it alone', keep({}, 'card') === 'card', keep({}, 'card'));
check('an edit can change it', keep({ payment: 'cash' }, 'card') === 'cash', keep({ payment: 'cash' }, 'card'));
check('an edit can clear it', keep({ payment: '' }, 'card') === '', `"${keep({ payment: '' }, 'card')}"`);

// ── The takings split ────────────────────────────────────────────────────
// Not a screen yet, but the data has to be able to answer it.
console.log('\n  the question this is recorded for');
await db.exec(`DELETE FROM stock_movements`);
await db.query(`INSERT INTO stock_movements (item_id, shop_id, type, qty_change, qty_after, payment, unit_price) VALUES
  (1,1,'sale',   -1, 9, 'cash', 1000000),
  (1,1,'sale',   -2, 7, 'card', 1500000),
  (1,1,'sale',   -1, 6, '',     1000000),
  (1,1,'return',  1, 7, 'cash', 1000000),
  (1,1,'in',     10,17, '',     NULL)`);
const { rows: split } = await db.query(
  `SELECT COALESCE(NULLIF(m.payment,''),'(not recorded)') AS method,
          SUM(CASE WHEN m.type IN ('sale','return') THEN -m.qty_change ELSE 0 END)::int AS units,
          SUM(CASE WHEN m.type IN ('sale','return') THEN -m.qty_change ELSE 0 END
              * COALESCE(m.unit_price, si.price, 0))::numeric AS taken
     FROM stock_movements m JOIN stock_items si ON si.id = m.item_id
    WHERE m.type IN ('sale','return')
    GROUP BY 1 ORDER BY 1`
);
const by = Object.fromEntries(split.map(r => [r.method, r]));
check('cash nets the refund off', Number(by.cash.units) === 0 && Number(by.cash.taken) === 0,
  `${by.cash.units} units / ${by.cash.taken}`);
check('card is counted on its own', Number(by.card.units) === 2 && Number(by.card.taken) === 3000000,
  `${by.card.units} units / ${by.card.taken}`);
check('unrecorded sales are visible rather than folded into cash',
  Number(by['(not recorded)'].units) === 1, `${by['(not recorded)']?.units}`);
check('the delivery is not in the takings at all', !('(not recorded)' in by) || split.length === 3,
  `${split.length} groups`);

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
