// Runs the REAL delete statements from /api/admin/reset-stock against REAL
// Postgres, on a database seeded to look like the live one: two shops, staff
// with commission rates, products, movements, groups and audit entries.
//
// The thing being checked is not just "did the stock go" but "did anything
// else go with it" — a reset that quietly takes the shops or the staff list
// with it would be discovered only after someone tried to sell something.
import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';

const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const db = new PGlite();

// Pull the delete statements out of the shipped handler so the test cannot
// drift from the code.
const handler = (() => {
  const a = src.indexOf("app.post('/api/admin/reset-stock'");
  const b = src.indexOf('\n});', a);
  if (a < 0) throw new Error('reset handler not found');
  return src.slice(a, b);
})();
const deletes = [...handler.matchAll(/`(DELETE FROM [^`]+)`/g)].map(m => m[1].replace(/\s+/g, ' ').trim());
if (deletes.length < 4) throw new Error(`expected 4 DELETEs, found ${deletes.length}`);

await db.exec(`
  CREATE TABLE businesses (id SERIAL PRIMARY KEY, name TEXT);
  CREATE TABLE shops (id SERIAL PRIMARY KEY, business_id INT, name TEXT, address TEXT, code TEXT);
  CREATE TABLE staff (id SERIAL PRIMARY KEY, business_id INT, shop_id INT, name TEXT,
                      active BOOLEAN DEFAULT TRUE, commission_rate NUMERIC(6,3) DEFAULT 0);
  CREATE TABLE item_groups (id SERIAL PRIMARY KEY, shop_id INT, name TEXT);
  CREATE TABLE stock_items (
    id SERIAL PRIMARY KEY, shop_id INT REFERENCES shops(id) ON DELETE CASCADE,
    group_id INT REFERENCES item_groups(id) ON DELETE SET NULL,
    name TEXT, sku TEXT, color TEXT, size TEXT, category TEXT, fabric TEXT,
    price NUMERIC(14,2) DEFAULT 0, cost NUMERIC(14,2) DEFAULT 0, qty INT DEFAULT 0,
    threshold INT DEFAULT 5, last_sold_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE TABLE stock_movements (
    id SERIAL PRIMARY KEY, item_id INT REFERENCES stock_items(id) ON DELETE CASCADE,
    shop_id INT REFERENCES shops(id) ON DELETE CASCADE, user_id INT, type TEXT,
    qty_change INT, qty_after INT, occurred_at TIMESTAMPTZ DEFAULT NOW(),
    note TEXT DEFAULT '', reason TEXT DEFAULT '', staff_id INT, staff_name TEXT DEFAULT ''
  );
  CREATE TABLE audit_log (
    id SERIAL PRIMARY KEY, business_id INT, action TEXT, entity TEXT, entity_id INT,
    summary TEXT DEFAULT '', before_val JSONB, after_val JSONB,
    actor_role TEXT DEFAULT 'admin', staff_id INT, staff_name TEXT DEFAULT '',
    created_at TIMESTAMPTZ DEFAULT NOW()
  );

  INSERT INTO businesses (name) VALUES ('Mitra Samadi');
  INSERT INTO shops (business_id, name, address, code)
    VALUES (1, 'Gold Dust', '', 'GD'), (1, 'Atriq', '', 'AT');
  INSERT INTO staff (business_id, shop_id, name, commission_rate)
    VALUES (1, 1, 'budi', 5), (1, 2, 'Belina', 2.5);
  INSERT INTO item_groups (shop_id, name) VALUES (1, 'Kaftans'), (2, 'Tops');
`);

for (let i = 0; i < 40; i++) {
  await db.query(
    `INSERT INTO stock_items (shop_id, group_id, name, sku, color, size, price, cost, qty)
     VALUES ($1, $2, $3, $4, 'NATURAL', 'O/S', 750000, 300000, 5)`,
    [(i % 2) + 1, (i % 2) + 1, 'ITEM ' + i, 'SKU-' + i]
  );
}
for (let i = 0; i < 120; i++) {
  await db.query(
    `INSERT INTO stock_movements (item_id, shop_id, user_id, type, qty_change, qty_after, staff_id, staff_name)
     VALUES ($1, $2, 1, 'sale', -1, 4, $3, $4)`,
    [(i % 40) + 1, ((i % 40) % 2) + 1, ((i % 2) + 1), i % 2 ? 'Belina' : 'budi']
  );
}
await db.query(
  `INSERT INTO audit_log (business_id, action, entity, summary) VALUES (1,'create','stock_item','Added ITEM 0')`
);

const n = async (sql) => Number((await db.query(sql)).rows[0].n);
const snapshot = async () => ({
  items: await n('SELECT COUNT(*)::int AS n FROM stock_items'),
  movements: await n('SELECT COUNT(*)::int AS n FROM stock_movements'),
  groups: await n('SELECT COUNT(*)::int AS n FROM item_groups'),
  audit: await n('SELECT COUNT(*)::int AS n FROM audit_log'),
  shops: await n('SELECT COUNT(*)::int AS n FROM shops'),
  staff: await n('SELECT COUNT(*)::int AS n FROM staff'),
});

const before = await snapshot();
console.log('before:', JSON.stringify(before));

for (const sql of deletes) await db.query(sql, [1]);
await db.query(
  `INSERT INTO audit_log (business_id, action, entity, summary, actor_role)
   VALUES ($1,'reset','stock',$2,'admin')`,
  [1, `Cleared all stock: ${before.items} products, ${before.movements} movements, ${before.groups} groups.`]
);

const after = await snapshot();
console.log('after: ', JSON.stringify(after));

const checks = [
  ['every product gone', after.items === 0],
  ['every movement gone', after.movements === 0],
  ['every group gone', after.groups === 0],
  ['old audit entries gone', after.audit === 1],
  ['the reset itself is recorded', after.audit === 1],
  ['both shops kept', after.shops === 2 && before.shops === 2],
  ['staff kept', after.staff === 2 && before.staff === 2],
  ['commission rates kept', (await db.query('SELECT commission_rate FROM staff ORDER BY id')).rows
      .map(r => Number(r.commission_rate)).join(',') === '5,2.5'],
  ['shop keys kept', (await db.query('SELECT code FROM shops ORDER BY id')).rows
      .map(r => r.code).join(',') === 'GD,AT'],
  ['there was something to delete', before.items === 40 && before.movements === 120],
];

console.log('');
let failed = 0;
for (const [label, ok] of checks) {
  console.log(`${ok ? '✓' : '✗'} ${label}`);
  if (!ok) failed++;
}
const summary = (await db.query('SELECT summary FROM audit_log')).rows[0].summary;
console.log(`\naudit entry left behind: "${summary}"`);
console.log(failed === 0 ? '\nall checks passed' : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
