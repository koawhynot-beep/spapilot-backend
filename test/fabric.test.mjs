// The fabric block must hold the material, not the style.
//
// The owner reported this in as many words: the "all fabrics" list was
// showing style names. It matters more than it sounds — fabric is the first
// thing the shop browses by, so a wrong value there is not a cosmetic slip,
// it is the top level of the whole catalogue being the wrong axis.
import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';
import { createRequire } from 'module';

const require = createRequire(new URL('../server.js', import.meta.url));
const FABRICS = require('./fabrics.js');
const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');

const db = new PGlite();
await db.exec(`
  CREATE TABLE shops (id SERIAL PRIMARY KEY, business_id INT, name TEXT, code TEXT);
  CREATE TABLE stock_items (
    id SERIAL PRIMARY KEY, shop_id INT, name TEXT, category TEXT, fabric TEXT,
    print TEXT DEFAULT '', size TEXT, color TEXT, sku TEXT, brand TEXT DEFAULT '',
    qty INT DEFAULT 0, threshold INT DEFAULT 0, supplier TEXT DEFAULT '',
    notes TEXT DEFAULT '', position INT DEFAULT 0, image_url TEXT DEFAULT '',
    price NUMERIC(14,2) DEFAULT 0, cost NUMERIC(14,2) DEFAULT 0,
    updated_at TIMESTAMPTZ DEFAULT NOW()
  );
  INSERT INTO shops (business_id, name, code) VALUES (1,'Rose Gold','RG');
`);

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : '  — ' + detail}`);
  if (!ok) failures++;
};
const one = async (sql, p) => (await db.query(sql, p)).rows[0];

console.log('\nReal Postgres · the fabric block\n');

console.log('  the map');
check('every value is a material name, never a style',
  !Object.values(FABRICS).some(v => /DRESS|PANT|SKIRT|TOP|BLOUSE|SHIRT|KIMONO/.test(v)),
  Object.values(FABRICS).filter(v => /DRESS|PANT/.test(v)).slice(0, 3).join(' · '));
check('every key looks like a product code',
  Object.keys(FABRICS).every(k => /^[A-Z]{2,4}-\d+$/.test(k)), 'a malformed code is in the map');
check('the typed "CATTON LCY" was corrected',
  !Object.values(FABRICS).includes('CATTON LCY') && Object.values(FABRICS).includes('COTTON LCY'),
  'the misspelling would stand as its own fabric');
check('the #REF! rows were left out',
  !Object.values(FABRICS).some(v => v.includes('#REF')), 'a broken formula is in the map');
const real = Object.values(FABRICS).filter(Boolean);
check('most codes carry a material', real.length > Object.keys(FABRICS).length * 0.7,
  `${real.length} of ${Object.keys(FABRICS).length}`);
console.log(`  ${Object.keys(FABRICS).length} codes, ${new Set(real).size} distinct materials`);

// ── The backfill, run as shipped ─────────────────────────────────────────
const a = src.indexOf('async function backfillFabrics() {');
const b = src.indexOf('\n}\n', a);
const body = src.slice(a, b + 3);
const logs = [];
const logger = { info: (k, v) => logs.push([k, v]), warn: (k, v) => logs.push([k, v]), error: (k, v) => logs.push([k, v]) };
const pool = { query: (t, p) => db.query(t, p) };
const backfill = new Function('pool', 'logger', 'require', `${body} return backfillFabrics;`)(pool, logger, require);

// A code the sheet gives a real material for.
const withFabric = Object.keys(FABRICS).find(k => FABRICS[k]);
// A code the sheet leaves blank.
const noFabric = Object.keys(FABRICS).find(k => !FABRICS[k]);

const add = (sku, category, fabric) => db.query(
  `INSERT INTO stock_items (shop_id, name, category, fabric, sku) VALUES (1,$1,$2,$3,$4)`,
  [`ITEM ${sku}`, category, fabric, sku]);

await add(withFabric, 'AGUSTINE DRESS LONG', 'AGUSTINE DRESS LONG');  // the bug
await add(noFabric, 'ALIYAH DRESS', 'ALIYAH DRESS');                  // the bug, blank source
await add('ZZ-9001', 'SOMETHING', '');                                // blank, unknown code
await add('ZZ-9002', 'SOMETHING', 'HAND DYED SILK');                  // somebody's own edit

console.log('\n  the backfill');
await backfill();
check('a style name in the fabric block is replaced by the material',
  (await one('SELECT fabric FROM stock_items WHERE sku=$1', [withFabric])).fabric === FABRICS[withFabric],
  (await one('SELECT fabric FROM stock_items WHERE sku=$1', [withFabric])).fabric);
check('the style is left in the category, where it belongs',
  (await one('SELECT category FROM stock_items WHERE sku=$1', [withFabric])).category === 'AGUSTINE DRESS LONG',
  'the category was overwritten too');
check('a code the sheet leaves blank ends up blank, not holding a style',
  (await one('SELECT fabric FROM stock_items WHERE sku=$1', [noFabric])).fabric === '',
  (await one('SELECT fabric FROM stock_items WHERE sku=$1', [noFabric])).fabric);
check('a hand-typed fabric is not overwritten',
  (await one(`SELECT fabric FROM stock_items WHERE sku='ZZ-9002'`)).fabric === 'HAND DYED SILK',
  'a boot undid somebody’s edit');
check('a code the master sheet does not list is left alone',
  (await one(`SELECT fabric FROM stock_items WHERE sku='ZZ-9001'`)).fabric === '', 'invented a fabric');
check('it says how much it changed', logs.some(l => l[0] === 'fabric.backfill.done'), 'silent');

console.log('\n  running it again');
logs.length = 0;
await backfill();
check('a second boot changes nothing', !logs.some(l => l[0] === 'fabric.backfill.done'),
  'it keeps rewriting the same rows');

// ── The importer ─────────────────────────────────────────────────────────
console.log('\n  the importer');
check('style no longer fills the fabric column',
  !/VALUES \(\$1,\$2,\$3,\$3,''/.test(src), 'the insert still doubles $3 into fabric');
check('the update writes style and fabric separately',
  /\[r\.name, style, fabric, r\.color/.test(src), 'the update still writes style twice');
check('a sheet without a fabric column falls back to the master map',
  /FABRICS\[r\.sku\.toUpperCase\(\)\]/.test(src), 'no fallback');
check('the import row accepts a fabric of its own',
  /fabric: z\.string\(\)\.trim\(\)\.max\(100\)/.test(src), 'schema has no fabric');

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
