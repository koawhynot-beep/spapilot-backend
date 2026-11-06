// The clean slate, against REAL Postgres.
//
// The app had been filled four times from copies of the shops' books and
// corrected by hand on top of that, until nobody could say which figure came
// from where. The owner's decision was to clear everything and let the app
// record only what it is told from now on, and to close Atriq with it.
//
// This is the most dangerous code in the project: it deletes every record at
// boot. Two things must hold absolutely. It must clear everything it claims
// to — a half-cleared app is worse than a full one — and it must never run
// twice, because the second time would land on a month of real trading.
import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';

const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : '  — ' + detail}`);
  if (!ok) failures++;
};
const grab = (decl, end) => {
  const a = src.indexOf(decl);
  const b = src.indexOf(end, a);
  if (a < 0 || b < 0) throw new Error('could not extract ' + decl);
  return src.slice(a, b + end.length);
};

const db = new PGlite();
await db.exec(`
  CREATE TABLE businesses (id SERIAL PRIMARY KEY, name TEXT);
  CREATE TABLE shops (id SERIAL PRIMARY KEY, business_id INT, name TEXT, code TEXT);
  CREATE TABLE stock_items (id SERIAL PRIMARY KEY, shop_id INT, name TEXT, sku TEXT, qty INT DEFAULT 0);
  CREATE TABLE stock_movements (id SERIAL PRIMARY KEY, item_id INT, shop_id INT, type TEXT, qty_change INT);
  CREATE TABLE item_groups (id SERIAL PRIMARY KEY, shop_id INT, name TEXT);
  CREATE TABLE imported_sales (id SERIAL PRIMARY KEY, shop_id INT, source TEXT, sku TEXT,
    sold_on DATE, units INT, staff TEXT DEFAULT '');
  CREATE TABLE stock_check_marks (id SERIAL PRIMARY KEY, shop_id INT, item_id INT);
  CREATE TABLE stock_check_rounds (id SERIAL PRIMARY KEY, shop_id INT, started_at TIMESTAMPTZ DEFAULT NOW());
  CREATE TABLE stock_transfers (id SERIAL PRIMARY KEY, business_id INT, status TEXT);
  CREATE TABLE stock_transfer_lines (id SERIAL PRIMARY KEY, transfer_id INT, sku TEXT);
  CREATE TABLE staff (id SERIAL PRIMARY KEY, business_id INT, name TEXT);
  CREATE TABLE audit_log (
    id SERIAL PRIMARY KEY, business_id INT, action TEXT, entity TEXT, summary TEXT,
    before_val TEXT, actor_role TEXT, created_at TIMESTAMPTZ DEFAULT NOW()
  );

  INSERT INTO businesses (name) VALUES ('Mitra Samadi');
  INSERT INTO shops (business_id, name, code) VALUES
    (1,'Rose Gold','RG'), (1,'Goldust','GD'), (1,'Office','OF'), (1,'Atriq','AT');
  INSERT INTO staff (business_id, name) VALUES (1,'Widya'), (1,'Listi');
  INSERT INTO stock_items (shop_id, name, sku, qty) VALUES
    (1,'NICOL DRESS','NI-1005',4), (2,'GIPSY DRESS','GI-2009',2), (4,'FREY SINGLET','FR-3025',7);
  INSERT INTO stock_movements (item_id, shop_id, type, qty_change) VALUES
    (1,1,'sale',-1), (2,2,'sale',-2), (3,4,'sale',-1);
  INSERT INTO item_groups (shop_id, name) VALUES (1,'Window'), (4,'Back rail');
  INSERT INTO imported_sales (shop_id, source, sku, sold_on, units) VALUES
    (1,'a book','NI-1005','2025-03-04',3), (4,'a book','FR-3025','2026-02-02',5);
  INSERT INTO stock_check_marks (shop_id, item_id) VALUES (1,1), (4,3);
  INSERT INTO stock_check_rounds (shop_id) VALUES (1), (4);
  INSERT INTO stock_transfers (business_id, status) VALUES (1,'sent');
  INSERT INTO stock_transfer_lines (transfer_id, sku) VALUES (1,'NI-1005');
  INSERT INTO audit_log (business_id, action, entity, summary) VALUES (1,'edit','item','a price was changed');
`);
const one = async (sql, p) => (await db.query(sql, p)).rows[0];
const n = async (table) => Number((await one(`SELECT COUNT(*)::int AS n FROM ${table}`)).n);

console.log('\nReal Postgres · the clean slate\n');

const logs = [];
const logger = { info: (k, v) => logs.push([k, v]), warn: (k, v) => logs.push([k, v]), error: (k, v) => logs.push([k, v]) };
const pool = { connect: async () => ({ query: (t, p) => db.query(t, p), release() {} }) };
const startFresh = new Function('pool', 'logger', `
  ${grab("const FRESH_START = '", ';')}
  ${grab('async function startFresh() {', '\n}')}
  return startFresh;
`)(pool, logger);

console.log('  the first boot');
await startFresh();
const err = logs.find(l => l[0] === 'admin.fresh_start.error');
check('it finishes without error', !err, err ? JSON.stringify(err[1]) : '');
for (const table of ['stock_items', 'stock_movements', 'item_groups', 'imported_sales',
                     'stock_check_marks', 'stock_check_rounds', 'stock_transfers',
                     'stock_transfer_lines']) {
  check(`${table} is empty`, (await n(table)) === 0, `${await n(table)} rows left`);
}
check('Atriq is closed', (await n(`shops WHERE code = 'AT'`)) === 0, 'it is still open');
check('the other three shops are kept — they hold the keys staff sign in with',
  (await n('shops')) === 3, `${await n('shops')} shops`);
check('and the staff are kept', (await n('staff')) === 2, `${await n('staff')} staff`);

console.log('\n  what it leaves behind');
const entry = await one(`SELECT * FROM audit_log`);
check('exactly one audit entry: the record of the clearing itself',
  (await n('audit_log')) === 1 && entry.action === 'reset', JSON.stringify(entry && entry.action));
check('it says what went, so "where did everything go" has an answer',
  /3 products/.test(entry.summary) && /3 movements/.test(entry.summary)
  && /2 imported lines/.test(entry.summary) && /Atriq closed/.test(entry.summary),
  entry.summary);
check('and the log says so too', logs.some(l => l[0] === 'admin.fresh_start'), JSON.stringify(logs));

console.log('\n  every boot after');
// This is the one that matters. A month from now the shop will have real
// stock and real takings in here, and this function still runs at boot.
await db.exec(`
  INSERT INTO stock_items (shop_id, name, sku, qty) VALUES (1,'A MONTH OF REAL WORK','RE-0001',12);
  INSERT INTO stock_movements (item_id, shop_id, type, qty_change) VALUES (99,1,'sale',-3);
`);
logs.length = 0;
await startFresh();
check('it does not run again', (await n('stock_items')) === 1 && (await n('stock_movements')) === 1,
  'a month of real trading was deleted by a second run');
check('and says nothing, because it did nothing', logs.length === 0, JSON.stringify(logs));

console.log('\n  what the code guarantees');
const fn = grab('async function startFresh() {', '\n}');
check('the guard is read before anything is deleted',
  fn.indexOf('if (done.length) return;') < fn.indexOf('DELETE'), 'it deletes first and checks after');
check('it is one transaction, so there is no half-cleared app',
  /BEGIN/.test(fn) && /COMMIT/.test(fn) && /ROLLBACK/.test(fn), 'it is not atomic');
check('every delete is scoped to this business',
  fn.split('DELETE FROM').slice(1).every(d => /business_id = \$1|shop_id IN \$\{shops\}|transfer_id IN/.test(d.slice(0, 200))),
  'an unscoped delete would clear another business too');
check('it never touches the staff or the business itself',
  !/DELETE FROM staff|DELETE FROM businesses|DELETE FROM users/.test(fn), 'it deletes people');
check('it runs at boot', /await startFresh\(\);/.test(src), 'it is never called');
check('the shop list no longer recreates Atriq',
  !/\['AT', 'Atriq'\]/.test(src), 'the next boot would bring it back');

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
