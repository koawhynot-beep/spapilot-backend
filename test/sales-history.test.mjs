// Taking the workbook's sales history back out, against REAL Postgres.
//
// Three rounds of monthly figures were loaded from the hand-kept sheet and
// the owner has asked for all of it to go. The dangerous thing about a
// delete that runs on every boot is reach: one marker misspelt and it finds
// nothing, one condition too loose and it takes real sales with it. So this
// puts every kind of entry in the book — all three sheet markers, a sale
// rung up by hand, a return, a delivery, a note-less sale — runs the shipped
// function, and counts what is left.
import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';

const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');

const db = new PGlite();
await db.exec(`
  CREATE TABLE shops (id SERIAL PRIMARY KEY, business_id INT, name TEXT, code TEXT);
  CREATE TABLE stock_items (
    id SERIAL PRIMARY KEY, shop_id INT REFERENCES shops(id) ON DELETE CASCADE,
    name TEXT, sku TEXT, qty INT DEFAULT 0, price NUMERIC(14,2) DEFAULT 0,
    updated_at TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE TABLE stock_movements (
    id SERIAL PRIMARY KEY, item_id INT NOT NULL, shop_id INT NOT NULL, user_id INT,
    type TEXT NOT NULL, qty_change INT NOT NULL, qty_after INT NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    unit_price NUMERIC(14,2), discount_pct NUMERIC(5,2) DEFAULT 0,
    payment TEXT DEFAULT '', staff_id INT, staff_name TEXT DEFAULT '',
    reason TEXT DEFAULT '', note TEXT DEFAULT ''
  );
  INSERT INTO shops (business_id, name, code) VALUES
    (1,'Rose Gold','RG'), (1,'Atriq','AT'), (1,'Goldust','GD'), (1,'Office','OF');
  INSERT INTO stock_items (shop_id, name, sku, qty, price) VALUES
    (1, 'FREY SINGLET S/M', 'FS-1001', 7, 950000),
    (2, 'FREY SINGLET S/M', 'FS-1001', 3, 950000),
    (3, 'BULU KUDA LINEN M/L', 'BK-2002', 0, 1200000);
`);

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : '  — ' + detail}`);
  if (!ok) failures++;
};
const one = async (sql, p) => (await db.query(sql, p)).rows[0];

console.log('\nReal Postgres · the sheet history comes back out\n');

// ── The markers, as shipped ──────────────────────────────────────────────
const grab = (decl, end) => {
  const a = src.indexOf(decl);
  const b = src.indexOf(end, a);
  if (a < 0 || b < 0) throw new Error('could not extract ' + decl);
  return src.slice(a, b + end.length);
};
// eslint-disable-next-line no-eval
const NOTES = eval(grab('const SALES_IMPORT_NOTES = [', '];').slice('const SALES_IMPORT_NOTES = '.length));

console.log('  the markers');
check('all three rounds are named', NOTES.length === 3, `${NOTES.length}`);
check('the first round reads as it was written',
  NOTES[0] === 'from the 2025-2026 sales sheet (month only, no day recorded)', NOTES[0]);
check('the second round reads as it was written',
  NOTES[1] === 'from the 2025-2026 sales sheet, 2nd import (month only, no day recorded)', NOTES[1]);
check('the third round reads as it was written',
  NOTES[2] === 'from the 2025-2026 sales sheet, 3rd import (month only, no day recorded)', NOTES[2]);

// ── The book before it runs ──────────────────────────────────────────────
// Sheet entries from every round, on more than one shop and item, and
// beside them everything a real day leaves behind.
await db.query(
  `INSERT INTO stock_movements (item_id, shop_id, type, qty_change, qty_after, occurred_at, unit_price, note) VALUES
     (1, 1, 'sale', -1, 12, '2025-03-15T04:00:00Z', 950000, $1),
     (1, 1, 'sale', -2, 10, '2025-04-15T04:00:00Z', 950000, $2),
     (2, 2, 'sale', -3,  6, '2025-05-15T04:00:00Z', 950000, $3),
     (3, 3, 'sale', -4,  0, '2026-08-15T04:00:00Z', 1200000, $3),
     (1, 1, 'sale', -1,  9, '2026-09-18T06:30:00Z', 950000, 'rung up by hand'),
     (1, 1, 'sale', -1,  8, '2026-09-19T03:10:00Z', 950000, ''),
     (1, 1, 'sale', -1,  7, '2026-09-19T05:00:00Z', 950000, NULL),
     (1, 1, 'return', 1,  8, '2026-09-20T02:00:00Z', 950000, 'wrong size'),
     (1, 1, 'in',    5, 13, '2026-09-20T04:00:00Z', NULL, 'from the supplier'),
     (2, 2, 'sale', -1,  2, '2026-09-21T07:00:00Z', 950000, 'from the 2025-2026 sales sheet')`,
  NOTES);
const SHEET = 4;
const before = await one(`SELECT COUNT(*)::int AS n FROM stock_movements`);
const stockBefore = (await db.query(`SELECT id, qty FROM stock_items ORDER BY id`)).rows;

// ── The shipped function, run as it ships ────────────────────────────────
const logs = [];
const logger = { info: (k, v) => logs.push([k, v]), warn: (k, v) => logs.push([k, v]), error: (k, v) => logs.push([k, v]) };
const pool = { query: (t, p) => db.query(t, p) };
const remove = new Function('pool', 'logger', `
  ${grab('const SALES_IMPORT_NOTES = [', '];')}
  ${grab('async function removeSheetSalesHistory() {', '\n}')}
  return removeSheetSalesHistory;
`)(pool, logger);

console.log('\n  the first run');
await remove();
const done = logs.find(l => l[0] === 'sales.sheet.removed');
check('it says what it did', Boolean(done), 'silent');
check(`and that it took out exactly the ${SHEET} sheet entries`, done && done[1].entries === SHEET,
  done ? String(done[1].entries) : '?');
const left = await one(`SELECT COUNT(*)::int AS n FROM stock_movements WHERE note = ANY($1::text[])`, [NOTES]);
check('not one sheet entry is left, from any round, any shop', left.n === 0, `${left.n} left`);

const after = await one(`SELECT COUNT(*)::int AS n FROM stock_movements`);
check('everything else is still there', after.n === before.n - SHEET, `${before.n} -> ${after.n}`);
const kinds = (await db.query(
  `SELECT COALESCE(note,'<null>') AS note, type, qty_change FROM stock_movements ORDER BY id`)).rows;
check('the sale rung up by hand', kinds.some(k => k.note === 'rung up by hand'), 'gone');
check('the sale with an empty note', kinds.some(k => k.note === '' && k.type === 'sale'), 'gone');
check('the sale with no note at all', kinds.some(k => k.note === '<null>'), 'gone');
check('the return', kinds.some(k => k.type === 'return'), 'gone');
check('the delivery', kinds.some(k => k.type === 'in'), 'gone');
check('a note that merely STARTS like the marker is not the marker',
  kinds.some(k => k.note === 'from the 2025-2026 sales sheet'), 'a looser match took it');

const stockAfter = (await db.query(`SELECT id, qty FROM stock_items ORDER BY id`)).rows;
check('no count on any shelf changed by a single piece',
  JSON.stringify(stockAfter) === JSON.stringify(stockBefore), JSON.stringify(stockAfter));
check('no item was created or removed either', stockAfter.length === stockBefore.length, `${stockAfter.length}`);

// ── Every boot after ─────────────────────────────────────────────────────
console.log('\n  the second run');
logs.length = 0;
await remove();
const twice = await one(`SELECT COUNT(*)::int AS n FROM stock_movements`);
check('a second run removes nothing more', twice.n === after.n, `${twice.n}`);
check('and says nothing, because there was nothing to say',
  logs.length === 0, JSON.stringify(logs));

// ── What the code guarantees ─────────────────────────────────────────────
console.log('\n  what the code guarantees');
const fn = grab('async function removeSheetSalesHistory() {', '\n}');
check('it runs at boot', /await removeSheetSalesHistory\(\);/.test(src), 'never called');
check('the loader is gone — nothing can bring the history back',
  !/seedSalesHistory|sales-history\.js/.test(src), 'the old seeder is still in the file');
check('the one DELETE matches the marker whole, not a prefix or a pattern',
  (fn.match(/DELETE FROM/g) || []).length === 1
  && /DELETE FROM stock_movements WHERE note = ANY\(\$1::text\[\]\)`, \[SALES_IMPORT_NOTES\]/.test(fn)
  && !/LIKE|ILIKE|~/.test(fn),
  'a broader delete');
check('it writes nothing: no INSERT, no UPDATE', !/INSERT|UPDATE/.test(fn), 'it writes');

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
