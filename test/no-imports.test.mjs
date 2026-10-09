// No sales come from a spreadsheet. Ever.
//
// Three times now, a copy of the shops' handwritten books was loaded so the
// rankings would have some history behind them, and three times the copy
// turned out to be wrong in a way nobody could see from inside the app —
// missing fabrics, stale figures, the wrong shop. The owner's decision is
// that the app counts what it watched happen and nothing else.
//
// That decision is worth a test rather than a memory, because the way back
// in is easy and would look like a kindness: a data file, a loader, a UNION
// in one query. This fails the build if any of that returns.
import fs from 'fs';

const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const dir = fs.readdirSync(new URL('../', import.meta.url));

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : '  — ' + detail}`);
  if (!ok) failures++;
};

console.log('\nNo sales come from a spreadsheet\n');

console.log('  nothing is left to load');
const books = dir.filter(f => /-history\.js$/.test(f));
check('no ledger data file sits in the backend', books.length === 0, books.join(', '));
check('nothing requires one', !/-history\.js/.test(src), 'a loader still points at a data file');
check('no loader remains', !/seedImportedSales|seedOneBook|IMPORTED_BOOKS/.test(src), 'the loader is still there');

console.log('\n  nothing is left to read');
// The table is dropped on boot rather than left standing and empty: an
// empty table is an invitation, and the rows would be back within a month.
check('the table is dropped at boot', /DROP TABLE IF EXISTS imported_sales;/.test(src), 'it is not dropped');
check('and nothing else mentions it',
  (src.match(/imported_sales/g) || []).length === 1, 'something still reads or writes it');

console.log('\n  the rankings count movements, and only movements');
const pep = src.slice(src.indexOf("app.get('/api/analytics/summary'"), src.indexOf('\n});', src.indexOf("app.get('/api/analytics/summary'")));
check('the seller lists read stock_movements', /FROM stock_movements m/.test(pep), 'they read something else');
check('with no second source stitched in', !/UNION/.test(pep), 'a UNION brings another book in');
check('the fabric still comes through, from the shelf',
  /MIN\(NULLIF\(si\.fabric,''\)\)/.test(pep), 'the rankings lost the fabric');

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
