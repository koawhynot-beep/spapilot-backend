// Guards a bug class that has now shipped three times.
//
// SQL parameters are written into template literals as `$${n}` — a literal
// dollar followed by the interpolation. Drop one dollar and it becomes
// `${n}`, which produces `>= 3` or `ANY(2::int[])` instead of `>= $3` or
// `ANY($2::int[])`. Postgres answers with a type error and the endpoint 500s,
// and because the broken clause is only emitted when a filter is applied, the
// unfiltered path keeps working — so it survives a casual look at the screen.
//
// It has escaped review three times because the two forms differ by one
// character. This reads the shipped file and refuses to let it happen again.
import fs from 'fs';

const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const lines = src.split('\n');
const D = String.fromCharCode(36);

let failures = 0;
const bad = [];

// Every interpolation that sits directly against a SQL parameter position.
// A correct one is preceded by a literal dollar; a broken one is not.
const SUSPECT = new RegExp(
  '(.)' + '\\' + D + '\\{\\s*(?:params\\.length|shelfParams\\.length|push\\(|i\\b)',
  'g'
);

lines.forEach((line, idx) => {
  // Only template literals that look like SQL are interesting.
  if (!/\b(AND|WHERE|ANY|ILIKE|LIKE|VALUES|SET|OFFSET|LIMIT|=|>=|<=)\b/.test(line)) return;
  let m;
  SUSPECT.lastIndex = 0;
  while ((m = SUSPECT.exec(line)) !== null) {
    if (m[1] !== D) {
      bad.push({ line: idx + 1, text: line.trim() });
    }
  }
});

console.log('SQL placeholder check — every parameter must be written as ' + D + D + '{n}\n');

// Count the correct ones too, so a refactor that removes them all does not
// pass silently by having nothing left to check.
const correct = (src.match(new RegExp('\\' + D + '\\' + D + '\\{', 'g')) || []).length;
console.log(`  ${correct} correctly written placeholders found`);

if (correct < 20) {
  console.log(`✗ only ${correct} placeholders — the check has probably stopped matching anything`);
  failures++;
} else {
  console.log('✓ the check is still finding placeholders to verify');
}

if (bad.length) {
  console.log(`✗ ${bad.length} placeholder(s) missing their dollar:`);
  for (const b of bad) console.log(`    line ${b.line}: ${b.text.slice(0, 100)}`);
  failures++;
} else {
  console.log('✓ no placeholder is missing its dollar');
}

// And prove the check actually catches the mistake, rather than passing
// because the pattern never matches.
const planted = 'sql += ` AND m.shop_id = ANY(' + D + '{params.length}::int[])`;';
SUSPECT.lastIndex = 0;
const caught = [...planted.matchAll(SUSPECT)].some(m => m[1] !== D);
console.log(caught
  ? '✓ a deliberately broken line is detected'
  : '✗ a deliberately broken line slipped through — the check is not working');
if (!caught) failures++;

const plantedOk = 'sql += ` AND m.shop_id = ANY(' + D + D + '{params.length}::int[])`;';
SUSPECT.lastIndex = 0;
const falsePositive = [...plantedOk.matchAll(SUSPECT)].some(m => m[1] !== D);
console.log(!falsePositive
  ? '✓ a correct line is not flagged'
  : '✗ a correct line was flagged — the check is too eager');
if (falsePositive) failures++;

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
