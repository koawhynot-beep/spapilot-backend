// Runs the REAL shop migration from server.js against REAL Postgres, from
// several starting states — including the one the live database is actually
// in — and checks both the code→shop mapping and that renaming Gold Dust
// keeps the row that carries all the history.
import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';

const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');

// Pull the migration body out of initDB so the test cannot drift from it.
const migration = (() => {
  const a = src.indexOf('  const { rows: bizRow } = await pool.query');
  const b = src.indexOf('  // ── Audit log ─', a);
  if (a < 0 || b < 0) throw new Error('migration not found');
  return src.slice(a, b);
})();

const SCHEMA = `
  CREATE TABLE businesses (id SERIAL PRIMARY KEY, name TEXT);
  CREATE TABLE shops (id SERIAL PRIMARY KEY, business_id INT, name TEXT, address TEXT, code TEXT);
  CREATE TABLE stock_items (id SERIAL PRIMARY KEY, shop_id INT, name TEXT, sku TEXT, qty INT DEFAULT 0);
  CREATE TABLE stock_movements (id SERIAL PRIMARY KEY, item_id INT, shop_id INT, type TEXT, qty_change INT);
  CREATE UNIQUE INDEX idx_shops_code ON shops(business_id, code) WHERE code IS NOT NULL;
  INSERT INTO businesses (name) VALUES ('Mitra Samadi');
`;

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : '  — ' + detail}`);
  if (!ok) failures++;
};

async function scenario(label, seed, expect) {
  const db = new PGlite();
  await db.exec(SCHEMA);
  if (seed) await db.exec(seed);

  const pool = { query: (t, p) => db.query(t, p) };
  const logger = { info() {}, warn() {}, error() {} };
  const run = new Function('pool', 'logger', `return (async () => {\n${migration}\n})();`);
  await run(pool, logger);

  const { rows } = await db.query('SELECT id, name, code FROM shops ORDER BY code');
  const got = rows.map(r => `${r.code}:${r.name}`).join(' | ');
  console.log(`\n  ${label}`);
  check('    shops end up correct', got === expect.shops, `got "${got}", wanted "${expect.shops}"`);

  if (expect.keepsIdOf) {
    const { rows: rg } = await db.query(`SELECT id FROM shops WHERE code='RG'`);
    check('    Rose Gold keeps the original row id',
      rg[0] && rg[0].id === expect.keepsIdOf, `got id ${rg[0] && rg[0].id}, wanted ${expect.keepsIdOf}`);
    const { rows: orphan } = await db.query(
      `SELECT COUNT(*)::int AS n FROM stock_items si
       LEFT JOIN shops sh ON sh.id = si.shop_id WHERE sh.id IS NULL`);
    check('    no stock orphaned by the rename', orphan[0].n === 0, `${orphan[0].n} orphaned rows`);
  }
  await db.close();
}

console.log('Real Postgres · real shop migration from server.js');

// The state the live database is in right now.
await scenario('live shape: Gold Dust (GD) + Atriq (AT), with stock',
  `INSERT INTO shops (business_id, name, address, code) VALUES (1,'Gold Dust','','GD'),(1,'Atriq','','AT');
   INSERT INTO stock_items (shop_id, name, sku, qty) VALUES (1,'MAX TOP','MT-1001',5),(2,'KAFTAN','BU-3040',3);
   INSERT INTO stock_movements (item_id, shop_id, type, qty_change) VALUES (1,1,'sale',-1),(2,2,'sale',-1);`,
  { shops: 'AT:Atriq | RG:Rose Gold', keepsIdOf: 1 });

// A single unkeyed shop, as it was before shop keys existed.
await scenario('single unkeyed shop named Gold Dust',
  `INSERT INTO shops (business_id, name, address) VALUES (1,'Gold Dust','');
   INSERT INTO stock_items (shop_id, name, sku, qty) VALUES (1,'MAX TOP','MT-1001',5);`,
  { shops: 'AT:Atriq | RG:Rose Gold', keepsIdOf: 1 });

// Nothing at all — a fresh database.
await scenario('empty database', null, { shops: 'AT:Atriq | RG:Rose Gold' });

// Already correct: the migration must be a no-op, not create duplicates.
await scenario('already Rose Gold + Atriq (re-running the migration)',
  `INSERT INTO shops (business_id, name, address, code) VALUES (1,'Rose Gold','','RG'),(1,'Atriq','','AT');`,
  { shops: 'AT:Atriq | RG:Rose Gold', keepsIdOf: 1 });

// A shop the manager renamed by hand must not be clobbered back.
await scenario('a third shop exists and is left alone',
  `INSERT INTO shops (business_id, name, address, code)
     VALUES (1,'Gold Dust','','GD'),(1,'Atriq','','AT'),(1,'Attrick','','KK');`,
  { shops: 'AT:Atriq | KK:Attrick | RG:Rose Gold', keepsIdOf: 1 });

// ── Code → shop mapping ───────────────────────────────────
console.log('\n  code → shop mapping (SHOP_CODE_* scanning)');
const readCodes = (env) => {
  const PREFIX = 'SHOP_CODE_';
  return Object.entries(env).reduce((acc, [name, secret]) => {
    if (!name.startsWith(PREFIX)) return acc;
    const key = name.slice(PREFIX.length).toUpperCase();
    const value = (secret || '').trim();
    if (/^[A-Z]{2}$/.test(key) && value) acc[key] = value;
    return acc;
  }, {});
};
const mapped = readCodes({
  SHOP_CODE_RG: 'rose-secret',
  SHOP_CODE_AT: 'atriq-secret',
  SHOP_CODE_GD: 'stale-secret',
  STAFF_CODE: 'legacy-secret',
  SHOP_CODE_TOOLONG: 'ignored',
  SHOP_CODE_AT_BLANK: '',
});
check('    RG and AT both map', mapped.RG === 'rose-secret' && mapped.AT === 'atriq-secret', JSON.stringify(mapped));
check('    STAFF_CODE no longer maps to anything', !Object.values(mapped).includes('legacy-secret'), 'legacy fallback still present');
check('    a stale SHOP_CODE_GD is picked up so it can be reported', mapped.GD === 'stale-secret', 'not seen');
check('    malformed keys ignored', !('TOOLONG' in mapped) && !('AT_BLANK' in mapped), JSON.stringify(Object.keys(mapped)));

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
