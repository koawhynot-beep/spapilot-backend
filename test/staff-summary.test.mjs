// The Staff tab's figures, run for real: what each person sold across the
// app's own sales AND the shop's book, what returns take back, what 2% comes
// to — and that a name in the book which is not on the staff list still
// counts toward the totals while earning nothing.
import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';

const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const grab = (decl, end) => {
  const a = src.indexOf(decl);
  const b = src.indexOf(end, a);
  if (a < 0 || b < 0) throw new Error('could not extract ' + decl);
  return src.slice(a, b + end.length);
};
const consts = [
  grab('const SALE_TYPES_SQL =', ';\n'),
  grab('const SALE_PRICE_SQL =', ';\n'),
  grab('const SALE_NET_SQL =', ';\n'),
  grab('const SALE_SELECT = `', '`;\n'),
  grab('const LEDGER_PRICE_SQL =', ';\n'),
  grab('const LEDGER_SELECT = `', '`;\n'),
  grab('const HISTORY_MONTHS =', ';\n'),
].join('\n');
const fn = grab('async function staffSummaryRows(req) {', '\n}\n');

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : '  — ' + detail}`);
  if (!ok) failures++;
};

const db = new PGlite();
await db.exec(`
  CREATE TABLE shops (id SERIAL PRIMARY KEY, business_id INT, name TEXT, code TEXT);
  CREATE TABLE stock_items (id SERIAL PRIMARY KEY, shop_id INT, name TEXT, sku TEXT, color TEXT DEFAULT '', size TEXT DEFAULT '',
    category TEXT DEFAULT '', fabric TEXT DEFAULT '', qty INT DEFAULT 0, price NUMERIC(14,2) DEFAULT 0, cost NUMERIC(14,2) DEFAULT 0);
  CREATE TABLE stock_movements (id SERIAL PRIMARY KEY, item_id INT, shop_id INT, type TEXT, qty_change INT, qty_after INT,
    occurred_at TIMESTAMPTZ DEFAULT NOW(), unit_price NUMERIC(14,2), discount_pct NUMERIC(5,2) DEFAULT 0,
    payment TEXT DEFAULT '', cash_amount NUMERIC(14,2), bank TEXT DEFAULT '', staff_id INT, staff_name TEXT DEFAULT '', reason TEXT DEFAULT '', note TEXT DEFAULT '');
  CREATE TABLE imported_sales (id SERIAL PRIMARY KEY, shop_id INT, source TEXT, sku TEXT, name TEXT DEFAULT '', style TEXT DEFAULT '',
    fabric TEXT DEFAULT '', color TEXT DEFAULT '', size TEXT DEFAULT '', sold_on DATE, units INT, value NUMERIC(14,2) DEFAULT 0,
    cash NUMERIC(14,2) DEFAULT 0, card NUMERIC(14,2) DEFAULT 0, bank TEXT DEFAULT '', staff TEXT DEFAULT '');
  CREATE TABLE staff (id SERIAL PRIMARY KEY, business_id INT, shop_id INT, name TEXT, active BOOLEAN DEFAULT TRUE, commission_rate NUMERIC(6,3) DEFAULT 0);
  INSERT INTO shops (business_id, name, code) VALUES (1,'Rose Gold','RG');
  INSERT INTO stock_items (shop_id, name, sku, price) VALUES (1,'DRESS','D-1',1000000);
  INSERT INTO staff (business_id, shop_id, name, commission_rate, active) VALUES
    (1,1,'Wayan',2,TRUE), (1,1,'Sandra',0,TRUE), (1,1,'Idle',2,TRUE), (1,1,'Gone',2,FALSE), (1,1,'Leftover',2,FALSE);
  -- Wayan: 2 sold, 1 returned in the app.  Komang is not on the list.
  INSERT INTO stock_movements (item_id, shop_id, type, qty_change, qty_after, unit_price, staff_id, staff_name) VALUES
    (1,1,'sale',-2,0,1000000,1,'Wayan'), (1,1,'return',1,0,1000000,1,'Wayan'),
    (1,1,'sale',-1,0,1000000,NULL,''),
    (1,1,'sale',-1,0,1000000,NULL,'Gone');
  -- The book spells names its own way and records no ids.
  INSERT INTO imported_sales (shop_id, source, sku, sold_on, units, value, staff) VALUES
    (1,'book','D-1', CURRENT_DATE - 5, 2, 1600000, ' WAYAN '),
    (1,'book','D-1', CURRENT_DATE - 4, 1, 500000, 'sandra'),
    (1,'book','D-1', CURRENT_DATE - 3, 1, 900000, 'Komang'),
    (1,'book','D-1', CURRENT_DATE - 2, 1, 700000, '');
`);

const pool = { query: (t, p) => db.query(t, p) };
const salesFilter = async () => ({ where: '', params: [] });
const ledgerFilter = async () => ({ where: '', params: [] });
const run = new Function('pool', 'salesFilter', 'ledgerFilter', `${consts}\n${fn}\nreturn staffSummaryRows;`)(pool, salesFilter, ledgerFilter);
const { items, unnamed } = await run({ user: { businessId: 1 }, query: {} });
const by = (n) => items.find(r => r.name === n);

console.log('\nReal Postgres · staff summary\n');
check('app sales and the book are added together for one person, names matched ignoring case and spaces',
  by('Wayan').soldUnits === 4 && by('Wayan').returnedUnits === 1 && by('Wayan').net === 2 * 1000000 + 1600000 - 1000000,
  JSON.stringify(by('Wayan')));
check('2% of what they sold, returns taken off', by('Wayan').commission === 52000, String(by('Wayan').commission));
check('Sandra sells but earns nothing', by('Sandra').net === 500000 && by('Sandra').commission === 0, JSON.stringify(by('Sandra')));
check('staff who sold nothing are still listed', !!by('Idle') && by('Idle').net === 0, 'missing');
check('a leaver with sales is listed, one without is not', !!by('Gone') && !by('Leftover'), items.map(r => r.name).join());
check('a name only in the book is shown but earns nothing',
  by('Komang') && by('Komang').listed === false && by('Komang').commission === 0 && by('Komang').net === 900000, JSON.stringify(by('Komang')));
check('sales with no name are kept apart, not given to anyone',
  unnamed && unnamed.net === 1700000, JSON.stringify(unnamed));
check('ranked by what they sold, biggest first',
  items.every((r, i) => i === 0 || items[i - 1].net >= r.net), items.map(r => r.net).join());

const whole = Number((await db.query(`
  SELECT (SELECT COALESCE(SUM(-qty_change * unit_price),0) FROM stock_movements WHERE type IN ('sale','return')) +
         (SELECT COALESCE(SUM(value),0) FROM imported_sales) AS n`)).rows[0].n);
const total = items.reduce((n, r) => n + r.net, 0) + unnamed.net;
check('the rows add up to everything sold, with nothing lost', total === whole, `${total} vs ${whole}`);

// ── Clicking a person: their rows, the same ones the total counts ─────────
console.log("\n  one person's sales");
const sql = new Function(`${consts}\nreturn { SALE_SELECT, LEDGER_SELECT, SALE_TYPES_SQL };`)();
const KEY = `CASE WHEN x.staff_name IN ('', '(not recorded)') THEN '' ELSE LOWER(TRIM(x.staff_name)) END`;
const rowsOf = async (who) => (await db.query(
  `SELECT x.* FROM (
     ${sql.SALE_SELECT} WHERE sh.business_id = 1 AND ${sql.SALE_TYPES_SQL}
     UNION ALL
     ${sql.LEDGER_SELECT} WHERE sh.business_id = 1
   ) x WHERE ${KEY} = $1`, [who])).rows;
const wayan = await rowsOf('wayan');
check('the rows listed for a person are the ones in their total, app and book together',
  wayan.length === 3 && wayan.filter(r => r.from_book).length === 1, String(wayan.length));
check('the same name written another way finds the same rows',
  (await rowsOf('sandra')).length === 1, 'sandra');
check('the route filters on exactly that expression',
  src.includes("WHEN x.staff_name IN ('', '(not recorded)') THEN ''") && src.includes('LOWER(TRIM(x.staff_name))'),
  'route expression differs');

console.log(failures ? `\n${failures} FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
