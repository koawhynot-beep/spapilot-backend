// How the customer paid, against REAL Postgres.
//
// The rules worth pinning down are the ones that decide whether a till
// balance is trustworthy:
//   · only a sale carries a method — a delivery has no customer;
//   · the set is closed, so "card"/"Card"/"kartu" cannot become three
//     different payment methods by the end of the month;
//   · a sale taken before this existed reads as "not recorded", never as
//     cash, because guessing invents money that was never counted;
//   · a customer paying partly in cash and partly on the card is split
//     across the pieces they bought, and the two halves add back up to the
//     sale exactly — a drawer short by a rounding error is a drawer somebody
//     spends an evening recounting.
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
    unit_price NUMERIC(14,2), payment TEXT DEFAULT '', discount_pct NUMERIC(5,2) DEFAULT 0,
    cash_amount NUMERIC(14,2)
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
check('part cash, part card is accepted', cleanPayment('split') === 'split', cleanPayment('split'));
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
check('the CSV writes the value',
  /r\.staffName, r\.payment, cash, r\.value - cash, r\.reason/.test(src), 'not in the CSV row');
check('with a column each for the drawer and the machine',
  /'In cash \(IDR\)', 'On card \(IDR\)'/.test(src),
  'the CSV cannot be reconciled against a till');

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

// ── Part cash, part card ─────────────────────────────────────────────────
// One customer, one basket, two ways of paying. The cash half is stored and
// the card half never is, because two numbers that must add up to a third
// are two numbers that can disagree.
console.log('\n  part cash, part card');
const money = new Function(`${grab('const cleanMoney =', '\n};')} return cleanMoney;`)();
const value = new Function(`${grab('const lineValue =', ';\n')} return lineValue;`)();
check('a typed amount is whole rupiah', money('450000.4') === 450000, String(money('450000.4')));
check('a negative cash part is impossible', money(-5000) === 0, String(money(-5000)));
check('nonsense is nothing, not NaN', money('abc') === 0, String(money('abc')));
check('a line is worth its charged price times its pieces',
  value(1500000, 10, -3) === 4050000, String(value(1500000, 10, -3)));

console.log('\n  what the handlers promise');
check('the scan handler refuses a split with no amount',
  /payment === 'split' && req\.body\.cashRemaining === undefined/.test(src)
  && /A part-cash sale needs the cash amount/.test(src), 'a split can be recorded with no cash');
check('it never books more cash than the line is worth',
  /Math\.min\(cashRemaining, lineValue\(item\.price, discountPct, change\)\)/.test(src),
  'the cash is taken at face value');
check('and it tells the screen how much this line used, so the next takes the rest',
  /cashApplied: cashAmount \\| 0/.test(src), 'the screen cannot count the cash down');
check('changing the method away from split clears the cash half',
  /const cashAmount = payment !== 'split' \? null/.test(src), 'a card sale can keep a cash figure');

// The allocation itself, run the way the counter runs it: one customer,
// three pieces at 1,500,000, handing over 2,000,000 in cash and putting the
// rest on the card.
console.log('\n  the cash spread across the pieces');
const allocate = (lines, cash) => lines.map((v) => {
  const take = Math.min(cash, v);
  cash -= take;
  return take;
});
const parts = allocate([1500000, 1500000, 1500000], 2000000);
check('the cash fills the pieces in the order they are rung up',
  JSON.stringify(parts) === JSON.stringify([1500000, 500000, 0]), JSON.stringify(parts));
check('and comes to exactly what the customer handed over',
  parts.reduce((n, x) => n + x, 0) === 2000000, String(parts.reduce((n, x) => n + x, 0)));

// ── The drawer and the machine ───────────────────────────────────────────
console.log('\n  the question this is recorded for, once splits exist');
await db.exec(`DELETE FROM stock_movements`);
await db.query(`INSERT INTO stock_movements (item_id, shop_id, type, qty_change, qty_after, payment, unit_price, cash_amount) VALUES
  (1,1,'sale',   -1, 9, 'split',  1500000,  500000),
  (1,1,'sale',   -1, 8, 'split',  1500000, 9999999),
  (1,1,'sale',   -1, 7, 'cash',   1000000,    NULL),
  (1,1,'sale',   -1, 6, 'card',   1000000,    NULL),
  (1,1,'sale',   -1, 5, '',       1000000,    NULL),
  (1,1,'return',  1, 6, 'split',  1500000,  500000)`);

// The shipped constants are template strings quoting one another, so they
// are stitched back together here exactly the way the server composes them
// and the real SQL is what runs.
const PRICE = /const SALE_PRICE_SQL = '([^']+)'/.exec(src)[1];
const NET = `ROUND(${PRICE} * (1 - COALESCE(m.discount_pct, 0) / 100.0))`;
const VALUE = `((-m.qty_change) * ${NET})`;
const fill = (name) => {
  const raw = new RegExp('const ' + name + ' = `([\\s\\S]*?)`;').exec(src)[1];
  const CASH = raw.includes('CASH_TAKEN_SQL') ? fill('CASH_TAKEN_SQL') : '';
  return raw
    .split('${SALE_NET_SQL}').join(NET)
    .split('${SALE_VALUE_SQL}').join(VALUE)
    .split('${CASH_TAKEN_SQL}').join(CASH)
    .split('${SALE_PRICE_SQL}').join(PRICE);
};
const [till] = (await db.query(
  `SELECT COALESCE(SUM(${fill('CASH_TAKEN_SQL')}),0)::numeric AS cash,
          COALESCE(SUM(${fill('CARD_TAKEN_SQL')}),0)::numeric AS card,
          COALESCE(SUM(${VALUE}),0)::numeric AS taken
     FROM stock_movements m JOIN stock_items si ON si.id = m.item_id
    WHERE m.type IN ('sale','return')`
)).rows;
// 500,000 of the first split + all 1,500,000 of the second, capped at what
// the line is worth + the 1,000,000 cash sale − the 500,000 refunded.
check('the drawer holds the cash halves and nothing else',
  Number(till.cash) === 2500000, String(till.cash));
// 1,000,000 left of the first split + nothing of the capped one + the
// 1,000,000 card sale − the 1,000,000 card half of the refund.
check('the machine holds the rest of each split and the card sales',
  Number(till.card) === 1000000, String(till.card));
check('a stored cash figure larger than its line cannot invent money',
  Number(till.cash) + Number(till.card) === Number(till.taken) - 1000000,
  `${till.cash} + ${till.card} vs ${till.taken}`);
check('the sale with no method is in the takings but in neither half',
  Number(till.taken) - Number(till.cash) - Number(till.card) === 1000000,
  String(Number(till.taken) - Number(till.cash) - Number(till.card)));

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
