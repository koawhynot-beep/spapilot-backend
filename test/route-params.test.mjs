// Guards a silent mismatch between a route's parameter name and the
// middleware that reads it.
//
// This one shipped: scopedItem read req.params.id, but the two stock-check
// routes name their parameter :itemId. Express only fills in the names the
// route declared, so req.params.id was undefined, the lookup matched nothing,
// and every tick on the Stock check screen answered "Item not found".
//
// It is invisible in review because both halves look right on their own, and
// invisible in testing unless you happen to exercise that particular route —
// the other eleven routes using the same middleware all say :id.
import fs from 'fs';

const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : '  — ' + detail}`);
  if (!ok) failures++;
};

console.log('Route parameters · every middleware reads a name its routes declare\n');

// Which req.params.* names each middleware reads.
const middlewareBody = (name) => {
  const a = src.indexOf(`const ${name} = async (req, res, next) => {`);
  if (a < 0) return null;
  const b = src.indexOf('\n};', a);
  return src.slice(a, b);
};

const paramsRead = (body) =>
  new Set([...body.matchAll(/req\.params\.([A-Za-z_$][\w$]*)/g)].map(m => m[1]));

// Every route registration, with its path and its middleware chain.
const ROUTE = /app\.(get|post|patch|put|delete)\(\s*'([^']+)'((?:[^)]|\n)*?)(?:async\s*)?\(req, res\)/g;
const routes = [];
for (const m of src.matchAll(ROUTE)) {
  routes.push({
    method: m[1].toUpperCase(),
    path: m[2],
    chain: m[3],
    params: [...m[2].matchAll(/:([A-Za-z_$][\w$]*)/g)].map(x => x[1]),
  });
}
console.log(`  ${routes.length} routes found\n`);
check('the route scan actually found routes', routes.length > 30, `only ${routes.length}`);

for (const mwName of ['scopedItem', 'scopedShop']) {
  const body = middlewareBody(mwName);
  if (!body) { check(`${mwName} exists`, false, 'not found in server.js'); continue; }
  const reads = paramsRead(body);
  const users = routes.filter(r => new RegExp(`\\b${mwName}\\b`).test(r.chain));
  console.log(`  ${mwName} reads {${[...reads].join(', ')}} and guards ${users.length} routes`);
  check(`  ${mwName} guards at least one route`, users.length > 0, 'nothing uses it');

  for (const r of users) {
    // At least one name the middleware reads must be declared by the route.
    const ok = r.params.some(p => reads.has(p));
    check(`    ${r.method} ${r.path}`, ok,
      `declares :${r.params.join(', :') || '(none)'} but ${mwName} reads ${[...reads].join('/')}`);
  }
}

// And the handlers that run after scopedItem should use the id it resolved,
// rather than reaching for a parameter name of their own.
console.log('\n  handlers use the id the middleware resolved');
check('scopedItem publishes the id it looked up', /req\.scopedItemId = /.test(src),
  'it does not hand the resolved id on');

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
