// The server starts.
//
// Every other test in here reads server.js as text and runs pieces of it.
// That catches a great deal and missed the simplest thing of all: a const
// declared above the const it was built from. The file parsed, every test
// passed, and the deploy died at boot with "Cannot access 'SHOP_TZ' before
// initialization" — a whole class of mistake that only shows when the
// module is actually loaded.
//
// So this loads it, in a real node process, the way Render does.
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

const dir = path.dirname(fileURLToPath(new URL('../server.js', import.meta.url)));

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : '  — ' + detail}`);
  if (!ok) failures++;
};

console.log('\nThe server starts\n');

const run = () => new Promise((resolve) => {
  // No database: db.init fails, says so, and the process carries on — which
  // is what we want, because the thing under test is everything that runs
  // before and after that, not Postgres.
  const child = spawn(process.execPath, ['-e', "require('./server.js')"], {
    cwd: dir,
    env: { ...process.env, PORT: '0', DATABASE_URL: '', NODE_ENV: 'test' },
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  // Long enough for the module to load and the listener to come up; the
  // failure this guards against happens in the first few milliseconds.
  const done = setTimeout(() => { child.kill(); }, 8000);
  child.on('exit', (code) => { clearTimeout(done); resolve({ code, out }); });
});

const { out } = await run();

check('it loads without a reference error',
  !/ReferenceError/.test(out), (out.match(/ReferenceError[^\n]*/) || [''])[0]);
check('and without any other error thrown while loading',
  !/TypeError|SyntaxError|RangeError/.test(out),
  (out.match(/(TypeError|SyntaxError|RangeError)[^\n]*/) || [''])[0]);
// Without a database the process reports it and exits 1 by design, and
// Render retries. What matters here is that it got that far: reaching
// db.init means the whole module body ran, which is precisely where a
// const-before-const error lives.
check('the whole file runs — it gets as far as opening the database',
  /db\.init\.failed/.test(out), out.slice(-300));
check('and nothing blew up before that',
  out.indexOf('db.init.failed') >= 0
  && !/ReferenceError|TypeError|SyntaxError/.test(out.slice(0, Math.max(0, out.indexOf('db.init.failed')))),
  'something threw on the way');

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
