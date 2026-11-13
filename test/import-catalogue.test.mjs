// The REAL import handler, against real Postgres: a code another shop already
// stocks keeps that shop's spelling, so Quick check puts the sizes on one card
// instead of splitting them across "LADY DIANA DRESS" and "LADY DIANA'S DRESS".
// The sheet still decides how many, and the price.
import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';

const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const a = src.indexOf("app.post('/api/admin/import-stock'");
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
  CREATE TABLE stock_items (
    id SERIAL PRIMARY KEY, shop_id INT REFERENCES shops(id) ON DELETE CASCADE,
    name TEXT, category TEXT, fabric TEXT, print TEXT, size TEXT, color TEXT,
    sku TEXT, brand TEXT, qty INT DEFAULT 0, threshold INT DEFAULT 0,
    supplier TEXT, notes TEXT, position INT DEFAULT 0, image_url TEXT,
    price NUMERIC(14,2) DEFAULT 0, cost NUMERIC(14,2) DEFAULT 0, updated_at TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE UNIQUE INDEX idx_stock_shop_sku ON stock_items(shop_id, UPPER(sku)) WHERE COALESCE(sku,'') <> '';
  INSERT INTO shops (business_id, name, code) VALUES (1,'Goldust','GD'),(1,'Office','OF'),(2,'Other biz','OF');
  INSERT INTO stock_items (shop_id,name,category,fabric,color,size,sku,qty,price) VALUES
    (1,'LADY DIANA DRESS RED BROWN S','LADY DIANA DRESS','SATIN','RED BROWN','S','LA-1010',1,1200000),
    (3,'OTHER BIZ NAME','OTHER','X','X','S','LA-2000',9,1);
`);

const client = { query: (t, p) => db.query(t, p), release() {} };
const pool = { connect: async () => client };
const logger = { info() {}, warn() {}, error() {} };
let handler;
const app = { post: (_p, ...h) => { handler = h[h.length - 1]; } };
new Function('app', 'auth', 'requireAdmin', 'validate', 'importSchema', 'FABRICS', 'pool', 'logger', 'audit', route)(
  app, null, null, () => null, null, { 'NEW-1': 'LINEN' }, pool, logger, async () => {});

const call = async (rows) => {
  let out;
  const res = { status() { return this; }, json(o) { out = o; return this; } };
  await handler({ body: { shopId: 2, rows }, user: { businessId: 1 }, accessRole: 'admin' }, res);
  return out;
};
const office = async () => (await db.query(`SELECT * FROM stock_items WHERE shop_id=2 ORDER BY sku`)).rows;

console.log('\nReal Postgres · import keeps the catalogue\'s spelling\n');
await call([
  { sku: 'LA-1010', name: "LADY DIANA'S DRESS RED BROWN S", style: "LADY DIANA'S DRESS", fabric: '', color: 'RED  BROWN', size: 'S', price: 1200000, qty: 1 },
  { sku: 'LA-2000', name: 'WHATEVER', style: 'WHATEVER', fabric: '', color: 'Z', size: 'M', price: 5, qty: 2 },
  { sku: 'NEW-1', name: 'NEW DRESS RED M', style: 'NEW DRESS', fabric: '', color: 'RED', size: 'M', price: 700, qty: 4 },
]);
let rows = await office();
const by = (s) => rows.find(r => r.sku === s);
check('a code the catalogue knows takes its name, style, fabric and colour',
  by('LA-1010').name === 'LADY DIANA DRESS RED BROWN S' && by('LA-1010').category === 'LADY DIANA DRESS'
  && by('LA-1010').fabric === 'SATIN' && by('LA-1010').color === 'RED BROWN', JSON.stringify(by('LA-1010')));
check('the sheet still decides the quantity and the price', by('LA-1010').qty === 1 && Number(by('LA-1010').price) === 1200000, '');
check('another business\'s catalogue is never used', by('LA-2000').category === 'WHATEVER' && by('LA-2000').fabric === '', JSON.stringify(by('LA-2000')));
check('a new code is described by the sheet, fabric filled in from the master list',
  by('NEW-1').category === 'NEW DRESS' && by('NEW-1').fabric === 'LINEN', JSON.stringify(by('NEW-1')));

await call([{ sku: 'LA-1010', name: 'X', style: 'X', fabric: '', color: 'X', size: 'S', price: 1, qty: 7 }]);
rows = await office();
check('running it again updates, never duplicates', rows.length === 3 && by('LA-1010').qty === 7, JSON.stringify(rows.map(r => [r.sku, r.qty])));

console.log(failures ? `\n${failures} FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
