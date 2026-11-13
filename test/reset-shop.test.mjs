// Clearing ONE shop, run for real: Office is emptied — stock, movements,
// groups, its sales book, transfers that touch it — while Goldust, the staff
// list and everything else stay exactly as they were.
import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';

const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const a = src.indexOf("app.post('/api/admin/reset-shop-stock'");
const b = src.indexOf('\n});\n', a);
if (a < 0 || b < 0) throw new Error('route not found');
const route = src.slice(a, b + 5);

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : '  — ' + detail}`);
  if (!ok) failures++;
};

const db = new PGlite();
await db.exec(`
  CREATE TABLE shops (id SERIAL PRIMARY KEY, business_id INT, name TEXT, code TEXT);
  CREATE TABLE stock_items (id SERIAL PRIMARY KEY, shop_id INT REFERENCES shops(id) ON DELETE CASCADE, name TEXT, sku TEXT, qty INT DEFAULT 0);
  CREATE TABLE stock_movements (id SERIAL PRIMARY KEY, item_id INT REFERENCES stock_items(id) ON DELETE CASCADE, shop_id INT, type TEXT);
  CREATE TABLE item_groups (id SERIAL PRIMARY KEY, shop_id INT, name TEXT);
  CREATE TABLE imported_sales (id SERIAL PRIMARY KEY, shop_id INT, sku TEXT);
  CREATE TABLE stock_check_marks (id SERIAL PRIMARY KEY, shop_id INT, item_id INT UNIQUE REFERENCES stock_items(id) ON DELETE CASCADE);
  CREATE TABLE stock_check_rounds (id SERIAL PRIMARY KEY, shop_id INT);
  CREATE TABLE stock_transfers (id SERIAL PRIMARY KEY, business_id INT, from_shop_id INT, to_shop_id INT);
  CREATE TABLE stock_transfer_lines (id SERIAL PRIMARY KEY, transfer_id INT REFERENCES stock_transfers(id) ON DELETE CASCADE, item_id INT REFERENCES stock_items(id) ON DELETE CASCADE, qty INT);
  CREATE TABLE audit_log (id SERIAL PRIMARY KEY, business_id INT, action TEXT, entity TEXT, summary TEXT, before_val TEXT, actor_role TEXT);
  CREATE TABLE staff (id SERIAL PRIMARY KEY, name TEXT);
  INSERT INTO shops (business_id,name,code) VALUES (1,'Goldust','GD'),(1,'Office','OF'),(2,'Office','OF');
  INSERT INTO stock_items (shop_id,name,sku,qty) VALUES (1,'A','S-1',3),(2,'A','S-1',5),(2,'B','S-2',1),(3,'A','S-1',9);
  INSERT INTO stock_movements (item_id,shop_id,type) VALUES (1,1,'sale'),(2,2,'in'),(3,2,'in');
  INSERT INTO item_groups (shop_id,name) VALUES (1,'g'),(2,'g');
  INSERT INTO imported_sales (shop_id,sku) VALUES (1,'S-1'),(2,'S-1');
  INSERT INTO stock_check_marks (shop_id,item_id) VALUES (2,2);
  INSERT INTO stock_check_rounds (shop_id) VALUES (1),(2);
  INSERT INTO stock_transfers (business_id,from_shop_id,to_shop_id) VALUES (1,1,2),(1,1,1);
  INSERT INTO stock_transfer_lines (transfer_id,item_id,qty) VALUES (1,1,1),(2,1,1);
  INSERT INTO staff (name) VALUES ('Wayan');
`);

const client = { query: (t, p) => db.query(t, p), release() {} };
const pool = { connect: async () => client };
const logger = { info() {}, warn() {}, error() {} };
let handler;
const app = { post: (_p, ...h) => { handler = h[h.length - 1]; } };
new Function('app', 'auth', 'requireAdmin', 'RESET_PHRASE', 'pool', 'logger', route)(app, null, null, 'DELETE ALL STOCK', pool, logger);

const call = async (body, businessId = 1) => {
  let status = 200, out;
  const res = { status(c) { status = c; return this; }, json(o) { out = o; return this; } };
  await handler({ body, user: { businessId }, accessRole: 'admin' }, res);
  return { status, out };
};
const n = async (sql) => Number((await db.query(sql)).rows[0].n);

console.log('\nReal Postgres · clear one shop\n');
check('refuses without the confirmation phrase', (await call({ shopId: 2, confirm: 'no' })).status === 400, '');
check('refuses another business\'s shop', (await call({ shopId: 3, confirm: 'DELETE ALL STOCK' })).status === 404, '');
check('nothing was touched by the refusals', await n(`SELECT COUNT(*)::int n FROM stock_items`) === 4, '');

const r = await call({ shopId: 2, confirm: 'DELETE ALL STOCK' });
check('reports what it removed', r.out && r.out.removed.items === 2 && r.out.removed.sales === 1 && r.out.removed.movements === 2, JSON.stringify(r.out));
check('the shop is empty: stock, movements, groups, book, marks, rounds',
  await n(`SELECT (SELECT COUNT(*) FROM stock_items WHERE shop_id=2)+(SELECT COUNT(*) FROM stock_movements WHERE shop_id=2)+(SELECT COUNT(*) FROM item_groups WHERE shop_id=2)+(SELECT COUNT(*) FROM imported_sales WHERE shop_id=2)+(SELECT COUNT(*) FROM stock_check_marks WHERE shop_id=2)+(SELECT COUNT(*) FROM stock_check_rounds WHERE shop_id=2) AS n`) === 0, '');
check('a transfer that touched it is gone, one that did not stays',
  await n(`SELECT COUNT(*)::int n FROM stock_transfers`) === 1, '');
check('Goldust is untouched',
  await n(`SELECT COUNT(*)::int n FROM stock_items WHERE shop_id=1`) === 1
  && await n(`SELECT COUNT(*)::int n FROM stock_movements WHERE shop_id=1`) === 1
  && await n(`SELECT COUNT(*)::int n FROM imported_sales WHERE shop_id=1`) === 1, '');
check('the other business\'s Office is untouched', await n(`SELECT COUNT(*)::int n FROM stock_items WHERE shop_id=3`) === 1, '');
check('staff are kept and the clear is recorded',
  await n(`SELECT COUNT(*)::int n FROM staff`) === 1 && await n(`SELECT COUNT(*)::int n FROM audit_log`) === 1, '');

console.log(failures ? `\n${failures} FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
