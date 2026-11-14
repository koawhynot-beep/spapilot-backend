// Accessories sold at the clothing till are in the shops' books. The real
// moveAccessorySales() runs against real Postgres: a line whose code the
// cosmetics business stocks moves to the cosmetics shop with the same key;
// clothing lines, and lines for codes cosmetics does not stock, stay put.
import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';

const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const a = src.indexOf('async function moveAccessorySales() {');
const b = src.indexOf('\n}\n', a);
if (a < 0 || b < 0) throw new Error('function not found');
const fn = src.slice(a, b + 3);

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : '  — ' + detail}`);
  if (!ok) failures++;
};

const db = new PGlite();
await db.exec(`
  CREATE TABLE businesses (id SERIAL PRIMARY KEY, name TEXT, kind TEXT NOT NULL DEFAULT 'clothing');
  CREATE TABLE shops (id SERIAL PRIMARY KEY, business_id INT, name TEXT, code TEXT);
  CREATE TABLE stock_items (id SERIAL PRIMARY KEY, shop_id INT, sku TEXT, qty INT DEFAULT 0);
  CREATE TABLE imported_sales (id SERIAL PRIMARY KEY, shop_id INT, sku TEXT, units INT);
  INSERT INTO businesses (name, kind) VALUES ('Clothes','clothing'), ('Cosmetics','cosmetics');
  INSERT INTO shops (business_id,name,code) VALUES (1,'Goldust','GD'),(1,'Rose Gold','RG'),(1,'Office','OF'),
                                                   (2,'Goldust','GD'),(2,'Rose Gold','RG'),(2,'Office','OF');
  INSERT INTO stock_items (shop_id, sku, qty) VALUES (6,'ba-2001',11),(6,'JE-2001',0),(3,'DR-1',5);
  INSERT INTO imported_sales (shop_id, sku, units) VALUES
    (1,'BA-2001',3),(2,'BA-2001',2),(1,'JE-2001',1),(1,'DR-1',4),(2,'XX-9',1),(4,'BA-2001',7);
`);
const pool = { query: (t, p) => db.query(t, p) };
const logger = { info() {}, warn() {}, error(...a) { console.log('ERR', a); } };
const run = new Function('pool', 'logger', `${fn}\nreturn moveAccessorySales;`)(pool, logger);

console.log('\nReal Postgres · accessory sales leave the clothing books\n');
await run();
const where = async (sku) => (await db.query(
  `SELECT s.business_id b, s.code c, i.units u FROM imported_sales i JOIN shops s ON s.id=i.shop_id WHERE UPPER(i.sku)=$1 ORDER BY i.id`, [sku])).rows;
const ba = await where('BA-2001');
check('a Goldust accessory line moves to Goldust cosmetics, a Rose Gold one to Rose Gold cosmetics',
  JSON.stringify(ba.map(r => [r.b, r.c, r.u])) === JSON.stringify([[2,'GD',3],[2,'RG',2],[2,'GD',7]]), JSON.stringify(ba));
check('another accessory moves too', JSON.stringify((await where('JE-2001')).map(r => [r.b, r.c])) === '[[2,"GD"]]', '');
check('clothing lines stay where they were', JSON.stringify((await where('DR-1')).map(r => [r.b, r.c])) === '[[1,"GD"]]', '');
check('a code cosmetics does not stock stays too', JSON.stringify((await where('XX-9')).map(r => [r.b, r.c])) === '[[1,"RG"]]', '');
const before = (await db.query(`SELECT COUNT(*)::int n, SUM(units)::int u FROM imported_sales`)).rows[0];
await run();
const after = (await db.query(`SELECT COUNT(*)::int n, SUM(units)::int u FROM imported_sales`)).rows[0];
check('nothing is lost and running it again changes nothing', before.n === 6 && after.n === 6 && after.u === before.u && after.u === 18, JSON.stringify(after));

console.log(failures ? `\n${failures} FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
