#!/usr/bin/env node
/**
 * scripts/wipe-all.js
 *
 * DESTRUCTIVE: Deletes every row in every Spapilot table.
 *
 * Usage (locally, against a remote DB):
 *   DATABASE_URL="postgres://user:pass@host:5432/db" node scripts/wipe-all.js --i-know-what-im-doing
 *
 * Usage (on Render via shell):
 *   1. Open the backend service in Render.
 *   2. Click "Shell".
 *   3. Run: node scripts/wipe-all.js --i-know-what-im-doing
 *
 * The script REQUIRES the --i-know-what-im-doing flag so you can't run it
 * accidentally. It also prints the row counts before/after so you can verify.
 *
 * Tables wiped (TRUNCATE ... RESTART IDENTITY CASCADE so sequences reset to 1):
 *   - users, businesses, staff, bookings, inventory, requests,
 *     announcements, sop, violations, services, password_resets,
 *     token_blacklist
 */

const { Pool } = require('pg');

const TABLES = [
  // Order doesn't matter with CASCADE, but listing leaf-first is clearer.
  'token_blacklist',
  'password_resets',
  'violations',
  'announcements',
  'sop',
  'services',
  'requests',
  'inventory',
  'bookings',
  'staff',
  'businesses',
  'users',
];

if (!process.argv.includes('--i-know-what-im-doing')) {
  console.error('Refusing to run without --i-know-what-im-doing flag.');
  console.error('Usage: node scripts/wipe-all.js --i-know-what-im-doing');
  process.exit(1);
}

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Aborting.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

async function countAll() {
  const out = {};
  for (const t of TABLES) {
    try {
      const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM ${t}`);
      out[t] = rows[0].n;
    } catch (e) {
      out[t] = `error: ${e.message}`;
    }
  }
  return out;
}

(async () => {
  try {
    console.log('--- Before ---');
    console.log(await countAll());

    // Single TRUNCATE statement — CASCADE handles FKs, RESTART IDENTITY resets PKs.
    const sql = `TRUNCATE TABLE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`;
    console.log('Running:', sql);
    await pool.query(sql);

    console.log('--- After ---');
    console.log(await countAll());
    console.log('Done. All data wiped.');
    process.exit(0);
  } catch (e) {
    console.error('Wipe failed:', e.message);
    console.error(e.stack);
    process.exit(1);
  }
})();
