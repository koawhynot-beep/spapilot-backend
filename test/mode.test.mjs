// Cosmetics is a second business under the same login. This runs the REAL
// ensureCosmeticsBusiness from server.js against real Postgres and checks that
// the first switch builds it from the clothing shops, copies the staff list
// once, and that switching again does not build a second one.
import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';

const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const a = src.indexOf('async function ensureCosmeticsBusiness(');
const b = src.indexOf('\n}\n', a);
if (a < 0 || b < 0) throw new Error('ensureCosmeticsBusiness not found');
const fnSrc = src.slice(a, b + 2);

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : '  — ' + detail}`);
  if (!ok) failures++;
};

const db = new PGlite();
await db.exec(`
  CREATE TABLE users (id SERIAL PRIMARY KEY);
  CREATE TABLE businesses (id SERIAL PRIMARY KEY, name TEXT, owner_id INT, kind TEXT NOT NULL DEFAULT 'clothing');
  CREATE TABLE shops (id SERIAL PRIMARY KEY, business_id INT, name TEXT, address TEXT, code TEXT);
  CREATE UNIQUE INDEX idx_shops_code ON shops(business_id, code) WHERE code IS NOT NULL;
  CREATE TABLE staff (id SERIAL PRIMARY KEY, business_id INT, shop_id INT, name TEXT, commission_rate NUMERIC DEFAULT 0, active BOOLEAN DEFAULT TRUE);
  INSERT INTO users DEFAULT VALUES;
  INSERT INTO businesses (name, owner_id) VALUES ('Mitra Samadi', 1);
  INSERT INTO shops (business_id, name, address, code) VALUES
    (1,'Rose Gold','', 'RG'), (1,'Goldust','', 'GD'), (1,'Office','', 'OF');
  INSERT INTO staff (business_id, shop_id, name, commission_rate) VALUES
    (1, 1, 'Sandra', 2), (1, NULL, 'Jiggy', 0);
  INSERT INTO staff (business_id, shop_id, name, active) VALUES (1, 2, 'Gone', FALSE);
`);

// ensureCosmeticsBusiness issues BEGIN/COMMIT on the client it is given.
const client = { query: (t, p) => db.query(t, p) };
const logger = { info() {}, warn() {}, error() {} };
const make = new Function('logger', `${fnSrc}; return ensureCosmeticsBusiness;`)(logger);
const clothing = (await db.query('SELECT * FROM businesses WHERE id=1')).rows[0];

console.log('\nReal Postgres · cosmetics business\n');
const first = await make(client, clothing, 1);
const shops = (await db.query('SELECT name, code FROM shops WHERE business_id=$1 ORDER BY code', [first.id])).rows;
check('is its own business, kind cosmetics', first.id !== 1 && first.kind === 'cosmetics', JSON.stringify(first));
check('mirrors the three shops and their keys', shops.map(s => `${s.code}:${s.name}`).join('|') === 'GD:Goldust|OF:Office|RG:Rose Gold', JSON.stringify(shops));

const staff = (await db.query('SELECT s.name, sh.code FROM staff s LEFT JOIN shops sh ON sh.id=s.shop_id WHERE s.business_id=$1 ORDER BY s.name', [first.id])).rows;
check('copies active staff, mapped to the cosmetics shop', staff.length === 2 && staff[1].name === 'Sandra' && staff[1].code === 'RG' && staff[0].code === null, JSON.stringify(staff));

const items = (await db.query('SELECT COUNT(*)::int AS n FROM shops WHERE business_id=1')).rows[0].n;
check('clothing shops untouched', items === 3, String(items));

const again = await make(client, clothing, 1);
const count = (await db.query(`SELECT COUNT(*)::int AS n FROM businesses WHERE kind='cosmetics'`)).rows[0].n;
check('switching again reuses it', again.id === first.id && count === 1, `count ${count}`);

console.log(failures ? `\n${failures} failed` : '\nAll passed');
process.exit(failures ? 1 : 0);
