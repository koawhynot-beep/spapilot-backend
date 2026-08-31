const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const winston = require('winston');
const compression = require('compression');
const { z } = require('zod');

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [new winston.transports.Console()],
});

const app = express();

// ── Environment validation ────────────────────────────────
if (!process.env.JWT_SECRET) {
  if (process.env.NODE_ENV === 'production') {
    console.error('FATAL: JWT_SECRET not set in production.');
    process.exit(1);
  }
  console.warn('WARNING: JWT_SECRET not set — using insecure default for dev only.');
}
if (!process.env.ALLOWED_ORIGINS && process.env.NODE_ENV === 'production') {
  console.error('FATAL: ALLOWED_ORIGINS not set in production.');
  process.exit(1);
}

const JWT_SECRET = process.env.JWT_SECRET || 'mitrasamadi-dev-secret-change-me';
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://spapilot-app.onrender.com';

const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim())
  : ['http://localhost:3001', 'https://spapilot-app.onrender.com'];

// ── Middleware ────────────────────────────────────────────
app.use(helmet());
app.use(compression());
app.use(cors({
  // Without this the browser hides the header and every CSV downloads
  // under a guessed name instead of the one the server chose.
  exposedHeaders: ['Content-Disposition'],
  origin: allowedOrigins,
  credentials: true,
}));
app.use(express.json({ limit: '1mb' }));
app.set('trust proxy', 1);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Try again in 15 minutes.' },
});

// ── Database ──────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

// ── Validation schemas ────────────────────────────────────

const accessSchema = z.object({
  code: z.string().max(128),
});
const shopSchema = z.object({
  name: z.string().trim().min(1).max(120),
  address: z.string().trim().max(500).optional().default(''),
  // Which shop key opens this location. Empty means none — the office.
  code: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, 'Use two letters, e.g. GD')
    .nullable().optional()
    .or(z.literal('').transform(() => null)),
});
const movementSchema = z.object({
  type: z.enum(['in', 'out', 'adjust']),
  qty: z.coerce.number().int().min(0),
  occurredAt: z.string().datetime().optional(),
  note: z.string().trim().max(500).optional().default(''),
});

const stockItemSchema = z.object({
  name: z.string().trim().min(1).max(200),
  category: z.string().trim().max(100).optional().default(''),
  fabric: z.string().trim().max(100).optional().default(''),
  print: z.string().trim().max(100).optional().default(''),
  size: z.string().trim().max(50).optional().default(''),
  color: z.string().trim().max(50).optional().default(''),
  sku: z.string().trim().max(100).optional().default(''),
  brand: z.string().trim().max(100).optional().default(''),
  qty: z.coerce.number().int().min(0).default(0),
  threshold: z.coerce.number().int().min(0).default(5),
  supplier: z.string().trim().max(200).optional().default(''),
  notes: z.string().trim().max(2000).optional().default(''),
  imageUrl: z.string().trim().max(2000).optional().default(''),
  price: z.coerce.number().min(0).max(1e12).optional().default(0),
  // What the shop paid. Kept beside the sell price so margin is knowable —
  // revenue on its own is not profit.
  cost: z.coerce.number().min(0).max(1e12).optional().default(0),
});

const validate = (schema) => (req, res, next) => {
  const result = schema.safeParse(req.body);
  if (!result.success) {
    const issue = result.error.issues[0];
    const field = issue.path.join('.') || 'input';
    let msg = issue.message;
    if (field === 'email' && issue.code === 'invalid_string') msg = 'Please enter a valid email address';
    else if (field === 'password' && issue.code === 'too_small') msg = 'Password must be at least 8 characters';
    else if (issue.code === 'too_small') msg = `${field}: must be at least ${issue.minimum} characters`;
    else if (issue.code === 'too_big') msg = `${field}: must be at most ${issue.maximum} characters`;
    return res.status(400).json({ error: msg });
  }
  req.body = result.data;
  next();
};

const formatUser = (u, access = null) => ({
  id: u.id,
  email: u.email,
  role: u.role,
  businessId: u.business_id,
  permissions: u.permissions || {},
  emailVerified: !!u.email_verified,
  trialEndsAt: u.trial_ends_at,
  subscriptionStatus: u.subscription_status || 'trial',
  createdAt: u.created_at,
  // What this session may reach. The browser uses it to decide which tabs to
  // draw; the server never trusts it, and enforces the same rule again.
  accessRole: access ? access.role : 'admin',
  isAdmin: (access ? access.role : 'admin') === 'admin',
});

const formatShop = (s) => ({
  id: s.id,
  businessId: s.business_id,
  name: s.name,
  address: s.address || '',
  code: s.code || null,
  createdAt: s.created_at,
});

const formatStock = (s) => ({
  id: s.id,
  shopId: s.shop_id,
  name: s.name,
  category: s.category || '',
  fabric: s.fabric || '',
  print: s.print || '',
  size: s.size || '',
  color: s.color || '',
  sku: s.sku || '',
  brand: s.brand || '',
  qty: s.qty,
  threshold: s.threshold,
  supplier: s.supplier || '',
  notes: s.notes || '',
  imageUrl: s.image_url || '',
  price: s.price !== null && s.price !== undefined ? Number(s.price) : 0,
  cost: s.cost !== null && s.cost !== undefined ? Number(s.cost) : 0,
  cost: s.cost !== null && s.cost !== undefined ? Number(s.cost) : 0,
  groupId: s.group_id ?? null,
  position: s.position ?? 0,
  lastSoldAt: s.last_sold_at,
  createdAt: s.created_at,
  updatedAt: s.updated_at,
});

const formatGroup = (g) => ({
  id: g.id,
  shopId: g.shop_id,
  name: g.name,
  position: g.position ?? 0,
  createdAt: g.created_at,
});

const formatMovement = (m) => ({
  id: m.id,
  itemId: m.item_id,
  shopId: m.shop_id,
  userId: m.user_id,
  type: m.type,
  qtyChange: m.qty_change,
  qtyAfter: m.qty_after,
  occurredAt: m.occurred_at,
  note: m.note || '',
  createdAt: m.created_at,
});

const formatInvite = (i) => ({
  id: i.id,
  code: i.code,
  expiresAt: i.expires_at,
  usedAt: i.used_at,
  createdAt: i.created_at,
});

// Private tool — everyone is treated as an active, never-expiring account.
const trialInfo = () => ({
  subscriptionStatus: 'active',
  trialEndsAt: null,
  daysRemaining: null,
  expired: false,
  isPaid: true,
});

// Shared site access code. When ACCESS_CODE env var is set, the front door
// requires it. If unset (e.g. before it's configured), the gate is disabled
// so we never lock ourselves out.
const ACCESS_CODE = (process.env.ACCESS_CODE || '').trim();
const accessOk = (code) => !ACCESS_CODE || (typeof code === 'string' && code.trim() === ACCESS_CODE);

// ── Access codes ──────────────────────────────────────────
// Two codes, two privilege levels. The admin code runs the business; the
// staff code works the till. Codes live only in env vars — never stored in
// the database, never returned to the browser, never rendered.
//
// ACCESS_CODE is still honoured as the admin code so the existing deployment
// keeps working without an env change.
const ADMIN_CODE = (process.env.ADMIN_CODE || process.env.ACCESS_CODE || '').trim();
const STAFF_CODE = (process.env.STAFF_CODE || '').trim();

// Compared with timingSafeEqual so a wrong code cannot be narrowed down by
// measuring how long the answer takes.
const safeEqual = (a, b) => {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
};

// Which door does this code open? Returns the level, never the code itself.
const resolveAccess = (raw) => {
  const code = typeof raw === 'string' ? raw.trim() : '';
  // No admin code configured yet: the gate is open, so we never lock
  // ourselves out of a fresh deployment.
  if (!ADMIN_CODE) return { role: 'admin' };
  if (!code) return null;
  // Admin wins. If the same string is set for both, it grants the higher
  // level rather than silently downgrading whoever typed it.
  if (safeEqual(code, ADMIN_CODE)) return { role: 'admin' };
  if (STAFF_CODE && safeEqual(code, STAFF_CODE)) return { role: 'staff' };
  return null;
};

// ── Auth middleware ───────────────────────────────────────
const TRIAL_EXPIRED_ALLOWED = ['/api/auth/', '/api/billing/', '/health'];

const auth = async (req, res, next) => {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ error: 'No token' });
  try {
    const decoded = jwt.verify(header.replace('Bearer ', ''), JWT_SECRET);
    if (decoded.jti) {
      const { rowCount } = await pool.query(
        'SELECT 1 FROM token_blacklist WHERE jti=$1',
        [decoded.jti]
      );
      if (rowCount) return res.status(401).json({ error: 'Token revoked' });
    }
    req.user = decoded;

    // A shop key is pinned to exactly one shop for the life of the token.
    // Resolved here, from the two-letter code in the token, so that no route
    // has to trust a shop id supplied by the caller.
    req.accessRole = decoded.accessRole === 'staff' ? 'staff' : 'admin';
    next();
  } catch (err) {
    res.status(401).json({ error: 'Invalid token' });
  }
};

// Everything a shop key must not see: business-wide figures, other shops'
// stock, reports, and anything that changes who can get in.
const requireAdmin = (req, res, next) => {
  if (req.accessRole !== 'admin') {
    return res.status(403).json({ error: 'That needs the admin code' });
  }
  next();
};

// Guard for routes that act on one named shop. A shop key may only ever name
// its own shop; the master code may name any of them.
// There is exactly one shop. Its id is looked up once and cached, so the
// per-shop routes can keep their URLs without a database round trip each time.
let THE_SHOP_ID = null;
async function theShopId() {
  if (THE_SHOP_ID) return THE_SHOP_ID;
  const { rows } = await pool.query('SELECT id FROM shops ORDER BY id ASC LIMIT 1');
  THE_SHOP_ID = rows.length ? rows[0].id : null;
  return THE_SHOP_ID;
}

const makeToken = (user, access = { role: 'admin' }) => jwt.sign(
  {
    id: user.id,
    email: user.email,
    role: user.role,
    businessId: user.business_id,
    accessRole: access.role,
    jti: crypto.randomBytes(16).toString('hex'),
  },
  JWT_SECRET,
  { expiresIn: '12h' }
);

// ── DB init ───────────────────────────────────────────────
async function initDB() {
  // ── Operator-triggered full wipe ─────────────────────────
  // Set WIPE_DB_ON_BOOT=true on Render to nuke all data on next deploy.
  // REMOVE THE ENV VAR AFTERWARD so future deploys don't re-wipe.
  if (process.env.WIPE_DB_ON_BOOT === 'true') {
    logger.warn('db.wipe.requested: WIPE_DB_ON_BOOT=true — dropping all tables');
    await pool.query('DROP SCHEMA public CASCADE');
    await pool.query('CREATE SCHEMA public');
    await pool.query('GRANT ALL ON SCHEMA public TO PUBLIC');
    try { await pool.query('GRANT ALL ON SCHEMA public TO postgres'); } catch (_) {}
    logger.warn('db.wipe.requested: done. REMOVE WIPE_DB_ON_BOOT env var now to prevent re-wipe.');
  }

  // ── One-time migration: wipe old SpaPilot schema ─────────
  // If stock_items doesn't exist yet → first Mitra Samadi deploy → nuke everything.
  // After first successful run, stock_items exists and this is skipped forever.
  // Detect old SpaPilot schema by presence of businesses.type column (Mitra Samadi has no such column)
  const { rows: schemaCheck } = await pool.query(`
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='businesses' AND column_name='type'
  `);
  if (schemaCheck.length) {
    logger.info('db.migration.wipe: legacy SpaPilot schema detected (businesses.type) — wiping and rebuilding');
    await pool.query('DROP SCHEMA public CASCADE');
    await pool.query('CREATE SCHEMA public');
    await pool.query('GRANT ALL ON SCHEMA public TO PUBLIC');
    // best-effort: postgres role may not exist on all hosts
    try { await pool.query('GRANT ALL ON SCHEMA public TO postgres'); } catch (_) {}
    logger.info('db.migration.wipe: done');
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id                   SERIAL PRIMARY KEY,
      email                TEXT UNIQUE NOT NULL,
      password_hash        TEXT NOT NULL,
      role                 TEXT NOT NULL DEFAULT 'owner',
      business_id          INTEGER,
      permissions          JSONB DEFAULT '{}'::jsonb,
      failed_login_attempts INTEGER DEFAULT 0,
      locked_until         TIMESTAMPTZ,
      trial_started_at     TIMESTAMPTZ DEFAULT NOW(),
      trial_ends_at        TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '7 days'),
      subscription_status  TEXT DEFAULT 'trial',
      created_at           TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS businesses (
      id          SERIAL PRIMARY KEY,
      name        TEXT NOT NULL,
      owner_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS shops (
      id           SERIAL PRIMARY KEY,
      business_id  INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      name         TEXT NOT NULL,
      address      TEXT DEFAULT '',
      created_at   TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS stock_items (
      id            SERIAL PRIMARY KEY,
      shop_id       INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
      name          TEXT NOT NULL,
      category      TEXT DEFAULT '',
      fabric        TEXT DEFAULT '',
      print         TEXT DEFAULT '',
      size          TEXT DEFAULT '',
      color         TEXT DEFAULT '',
      sku           TEXT DEFAULT '',
      brand         TEXT DEFAULT '',
      qty           INTEGER DEFAULT 0,
      threshold     INTEGER DEFAULT 5,
      supplier      TEXT DEFAULT '',
      notes         TEXT DEFAULT '',
      last_sold_at  TIMESTAMPTZ,
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      updated_at    TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS token_blacklist (
      jti          TEXT PRIMARY KEY,
      user_id      INTEGER REFERENCES users(id) ON DELETE CASCADE,
      expires_at   TIMESTAMPTZ NOT NULL,
      created_at   TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS stock_movements (
      id           SERIAL PRIMARY KEY,
      item_id      INTEGER NOT NULL REFERENCES stock_items(id) ON DELETE CASCADE,
      shop_id      INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
      user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
      type         TEXT NOT NULL,
      qty_change   INTEGER NOT NULL,
      qty_after    INTEGER NOT NULL,
      occurred_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      note         TEXT DEFAULT '',
      created_at   TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS item_groups (
      id           SERIAL PRIMARY KEY,
      shop_id      INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
      name         TEXT NOT NULL,
      position     INTEGER NOT NULL DEFAULT 0,
      created_at   TIMESTAMPTZ DEFAULT NOW()
    );

  `);

  // Detect first-time addition of email_verified so we can grandfather existing users in
  const { rows: emailColCheck } = await pool.query(`
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='users' AND column_name='email_verified'
  `);
  const isFirstEmailVerifiedMigration = !emailColCheck.length;
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT FALSE`);
  if (isFirstEmailVerifiedMigration) {
    const { rowCount } = await pool.query(`UPDATE users SET email_verified=TRUE`);
    logger.info('migration.email_verified.grandfathered', { rows: rowCount });
  }

  // Add foreign key from users.business_id → businesses after both tables exist
  await pool.query(`
    DO $$ BEGIN
      ALTER TABLE users ADD CONSTRAINT users_business_id_fkey
        FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE SET NULL;
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  `);

  // Shop staff. Deliberately NOT users: there is one shared login, and asking
  // shop floor staff to hold passwords would be a different product. This is
  // "who is standing at the till right now", picked from a list, so every
  // scan carries a name — which is what makes a missing garment traceable.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS staff (
      id           SERIAL PRIMARY KEY,
      business_id  INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      shop_id      INTEGER REFERENCES shops(id) ON DELETE SET NULL,
      name         TEXT NOT NULL,
      active       BOOLEAN NOT NULL DEFAULT TRUE,
      created_at   TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  // Percent of the sale value this person earns. Kept on the staff row rather
  // than on each sale, because the rate is a standing arrangement.
  await pool.query(`ALTER TABLE staff ADD COLUMN IF NOT EXISTS commission_rate NUMERIC(6,3) NOT NULL DEFAULT 0`);

  // staff_name is a snapshot, not just the join: if someone leaves and is
  // removed from the list, the history of what they scanned must survive.
  await pool.query(`
    ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS staff_id   INTEGER REFERENCES staff(id) ON DELETE SET NULL;
    ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS staff_name TEXT DEFAULT '';
    ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS reason     TEXT DEFAULT '';
  `);

  // Reclassify transfers logged before the type split. They were written as
  // 'out'/'in', and 'out' counts as a sale, so any office → shop transfer was
  // inflating that shop's sales. Matched on the note the transfer endpoint
  // writes, which is the only marker those rows carry.
  const { rowCount: fixedOut } = await pool.query(
    `UPDATE stock_movements SET type='transfer-out'
     WHERE type='out' AND qty_change < 0 AND note LIKE 'Transfer to %'`
  );
  const { rowCount: fixedIn } = await pool.query(
    `UPDATE stock_movements SET type='transfer-in'
     WHERE type='in' AND qty_change > 0 AND note LIKE 'Transfer from %'`
  );
  if (fixedOut || fixedIn) {
    logger.info('migration.transfer_types.reclassified', { out: fixedOut, in: fixedIn });
  }

  // Idempotent column adds for stock_items (so deploys before fabric/print/last_sold_at upgrade cleanly)
  await pool.query(`
    ALTER TABLE stock_items ADD COLUMN IF NOT EXISTS fabric       TEXT DEFAULT '';
    ALTER TABLE stock_items ADD COLUMN IF NOT EXISTS print        TEXT DEFAULT '';
    ALTER TABLE stock_items ADD COLUMN IF NOT EXISTS last_sold_at TIMESTAMPTZ;
    ALTER TABLE stock_items ADD COLUMN IF NOT EXISTS group_id     INTEGER REFERENCES item_groups(id) ON DELETE SET NULL;
    ALTER TABLE stock_items ADD COLUMN IF NOT EXISTS position     INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE stock_items ADD COLUMN IF NOT EXISTS image_url    TEXT DEFAULT '';
    ALTER TABLE stock_items ADD COLUMN IF NOT EXISTS price        NUMERIC(14,2) DEFAULT 0;
    ALTER TABLE stock_items ADD COLUMN IF NOT EXISTS cost NUMERIC(14,2) DEFAULT 0;
  `);

  // Indexes
  const indexes = [
    `CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)`,
    `CREATE INDEX IF NOT EXISTS idx_users_business_id ON users(business_id)`,
    `CREATE INDEX IF NOT EXISTS idx_businesses_owner_id ON businesses(owner_id)`,
    `CREATE INDEX IF NOT EXISTS idx_shops_business_id ON shops(business_id)`,
    `CREATE INDEX IF NOT EXISTS idx_stock_shop_id ON stock_items(shop_id)`,
    `CREATE INDEX IF NOT EXISTS idx_stock_name ON stock_items(name)`,
    `CREATE INDEX IF NOT EXISTS idx_blacklist_expires ON token_blacklist(expires_at)`,
    `CREATE INDEX IF NOT EXISTS idx_movements_item_id ON stock_movements(item_id)`,
    `CREATE INDEX IF NOT EXISTS idx_movements_shop_id ON stock_movements(shop_id)`,
    `CREATE INDEX IF NOT EXISTS idx_movements_occurred ON stock_movements(occurred_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_movements_staff ON stock_movements(staff_id)`,
    `CREATE INDEX IF NOT EXISTS idx_movements_type ON stock_movements(type)`,
    `CREATE INDEX IF NOT EXISTS idx_staff_business ON staff(business_id)`,
    `CREATE INDEX IF NOT EXISTS idx_groups_shop_id ON item_groups(shop_id)`,
    `CREATE INDEX IF NOT EXISTS idx_stock_group_id ON stock_items(group_id)`,
    `CREATE INDEX IF NOT EXISTS idx_stock_position ON stock_items(shop_id, position)`,
  ];
  for (const q of indexes) {
    try { await pool.query(q); } catch (e) { logger.warn('index.skipped', { err: e.message }); }
  }

  // Drop the tables the account model left behind. They hold no data this
  // app can reach, and leaving them invites someone to wire them back up.
  await pool.query(`
    DROP TABLE IF EXISTS transfers;
    DROP TABLE IF EXISTS invite_codes;
    DROP TABLE IF EXISTS announcements;
    DROP TABLE IF EXISTS email_verification_tokens;
    DROP TABLE IF EXISTS password_reset_tokens;
  `);
  await pool.query(`ALTER TABLE shops DROP COLUMN IF EXISTS code`);

  // ── One shop ────────────────────────────────────────────
  // The business runs from a single shop. Whatever else is in the table gets
  // folded into it: stock is moved across, then the extra rows go. Doing this
  // in the migration rather than by hand means no orphaned stock and no
  // second location quietly reappearing in a report.
  const { rows: allShops } = await pool.query('SELECT id, name FROM shops ORDER BY id ASC');
  if (!allShops.length) {
    await pool.query(
      `INSERT INTO shops (business_id, name, address)
       SELECT id, 'Gold Dust', '' FROM businesses ORDER BY id ASC LIMIT 1`
    );
  } else if (allShops.length > 1) {
    const keep = allShops.find(x => /gold\s*dust/i.test(x.name)) || allShops[0];
    const drop = allShops.filter(x => x.id !== keep.id).map(x => x.id);
    // Merge duplicate SKUs into the surviving row, then move the rest.
    await pool.query(
      `UPDATE stock_items k SET qty = k.qty + agg.qty
         FROM (SELECT sku, SUM(qty) AS qty FROM stock_items
               WHERE shop_id = ANY($1::int[]) GROUP BY sku) agg
        WHERE k.shop_id = $2 AND k.sku = agg.sku`,
      [drop, keep.id]
    );
    await pool.query(
      `DELETE FROM stock_items WHERE shop_id = ANY($1::int[])
         AND sku IN (SELECT sku FROM stock_items WHERE shop_id = $2)`,
      [drop, keep.id]
    );
    await pool.query('UPDATE stock_items SET shop_id=$1 WHERE shop_id = ANY($2::int[])', [keep.id, drop]);
    await pool.query('UPDATE stock_movements SET shop_id=$1 WHERE shop_id = ANY($2::int[])', [keep.id, drop]);
    await pool.query('UPDATE staff SET shop_id=$1 WHERE shop_id = ANY($2::int[])', [keep.id, drop]);
    await pool.query('DELETE FROM shops WHERE id = ANY($1::int[])', [drop]);
    if (!/gold\s*dust/i.test(keep.name)) {
      await pool.query('UPDATE shops SET name=$1 WHERE id=$2', ['Gold Dust', keep.id]);
    }
    logger.warn('migration.single_shop', { kept: keep.id, merged: drop.length });
  }

  // ── Audit log ───────────────────────────────────────────
  // Stock movements say what happened to the stock. This says what happened
  // to the records: a price edited, an item deleted, a staff rate changed.
  // Those are the changes worth being able to point at later.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id          SERIAL PRIMARY KEY,
      business_id INTEGER REFERENCES businesses(id) ON DELETE CASCADE,
      action      TEXT NOT NULL,
      entity      TEXT NOT NULL,
      entity_id   INTEGER,
      summary     TEXT NOT NULL DEFAULT '',
      before_val  JSONB,
      after_val   JSONB,
      actor_role  TEXT NOT NULL DEFAULT 'admin',
      staff_id    INTEGER REFERENCES staff(id) ON DELETE SET NULL,
      staff_name  TEXT DEFAULT '',
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC)`);

  // Cleanup expired blacklist tokens hourly
  setInterval(() => {
    pool.query('DELETE FROM token_blacklist WHERE expires_at < NOW()')
      .catch(err => logger.error('blacklist.cleanup.error', { err: err.message }));
  }, 60 * 60 * 1000);

  logger.info('db.ready');
}

// ── Health ────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', app: 'mitrasamadi' }));

// Single shared "master" account model. There is ONE dataset. Entering the
// correct code logs you into it — no email, no signup, no separate accounts.
// Everyone with the code controls the same business.
async function ensureMasterAccount(client) {
  let masterUser = (await client.query(
    `SELECT * FROM users WHERE role='owner' ORDER BY id ASC LIMIT 1`
  )).rows[0];
  if (!masterUser) {
    const randomPw = crypto.randomBytes(24).toString('hex');
    const hash = await bcrypt.hash(randomPw, 10);
    masterUser = (await client.query(
      `INSERT INTO users (email, password_hash, role, email_verified, subscription_status, trial_ends_at)
       VALUES ($1,$2,'owner',TRUE,'active',NULL) RETURNING *`,
      ['master@mitrasamadi.local', hash]
    )).rows[0];
  }
  let biz = (await client.query(
    `SELECT * FROM businesses ORDER BY id ASC LIMIT 1`
  )).rows[0];
  if (!biz) {
    biz = (await client.query(
      `INSERT INTO businesses (name, owner_id) VALUES ($1,$2) RETURNING *`,
      ['Mitra Samadi', masterUser.id]
    )).rows[0];
  }
  if (masterUser.business_id !== biz.id) {
    masterUser = (await client.query(
      `UPDATE users SET business_id=$1 WHERE id=$2 RETURNING *`,
      [biz.id, masterUser.id]
    )).rows[0];
  }
  return { masterUser, biz };
}

// ── Auth: code-only login ─────────────────────────────────
// One field, one code. The admin code runs the business; the staff code
// works the till.
app.post('/api/auth/access-login', authLimiter, validate(accessSchema), async (req, res) => {
  const access = resolveAccess(req.body.code);
  if (!access) {
    return res.status(403).json({ error: 'Invalid access code' });
  }
  const client = await pool.connect();
  try {
    const { masterUser, biz } = await ensureMasterAccount(client);

    const { rows: shopRows } = await client.query(
      'SELECT id, name FROM shops WHERE business_id=$1 ORDER BY id ASC LIMIT 1',
      [biz.id]
    );

    res.json({
      token: makeToken(masterUser, access),
      user: formatUser(masterUser, access),
      business: { id: biz.id, name: biz.name },
      shop: shopRows[0] || null,
    });
  } catch (err) {
    logger.error('access-login.error', { err: err.message });
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// ── Auth: Me ──────────────────────────────────────────────
app.get('/api/auth/me', auth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE id=$1', [req.user.id]);
    if (!rows.length) return res.status(401).json({ error: 'User not found' });
    let business = null;
    if (rows[0].business_id) {
      const b = await pool.query('SELECT * FROM businesses WHERE id=$1', [rows[0].business_id]);
      if (b.rows[0]) business = { id: b.rows[0].id, name: b.rows[0].name };
    }
    // Carry the session's access level through a page reload, so the staff
    // code does not come back with admin tabs.
    const access = { role: req.accessRole };
    const shopId = await theShopId();
    const shop = shopId
      ? (await pool.query('SELECT id, name FROM shops WHERE id=$1', [shopId])).rows[0]
      : null;
    res.json({ user: formatUser(rows[0], access), business, shop: shop || null, trial: trialInfo(rows[0]) });
  } catch (err) {
    logger.error('me.error', { err: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Auth: Export data (GDPR) ──────────────────────────────
app.get('/api/auth/export-data', auth, requireAdmin, async (req, res) => {
  try {
    const userId = req.user.id;
    const businessId = req.user.businessId;
    const [user, business, shops, stock, movements, staffRows, audit] = await Promise.all([
      pool.query('SELECT id, email, role, business_id, trial_started_at, trial_ends_at, subscription_status, created_at FROM users WHERE id=$1', [userId]),
      businessId ? pool.query('SELECT * FROM businesses WHERE id=$1', [businessId]) : { rows: [] },
      businessId ? pool.query('SELECT * FROM shops WHERE business_id=$1', [businessId]) : { rows: [] },
      businessId ? pool.query('SELECT s.* FROM stock_items s JOIN shops sh ON sh.id=s.shop_id WHERE sh.business_id=$1', [businessId]) : { rows: [] },
      businessId ? pool.query('SELECT m.* FROM stock_movements m JOIN shops sh ON sh.id=m.shop_id WHERE sh.business_id=$1 ORDER BY m.occurred_at', [businessId]) : { rows: [] },
      businessId ? pool.query('SELECT * FROM staff WHERE business_id=$1', [businessId]) : { rows: [] },
      businessId ? pool.query('SELECT * FROM audit_log WHERE business_id=$1 ORDER BY created_at', [businessId]) : { rows: [] },
    ]);
    res.setHeader('Content-Disposition', `attachment; filename="mitra-samadi-data-${userId}-${Date.now()}.json"`);
    res.json({
      exportedAt: new Date().toISOString(),
      user: user.rows[0] || null,
      business: business.rows[0] || null,
      shops: shops.rows,
      stockItems: stock.rows,
      // A backup without the movement log is not a backup: the stock levels
      // can be rebuilt from the movements, but not the other way round.
      movements: movements.rows,
      staff: staffRows.rows,
      auditLog: audit.rows,
    });
  } catch (err) {
    logger.error('export.error', { err: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});


// Routes addressed as /api/shops/:shopId/... — a shop key may only name its own.
// Any route naming a shop other than the one is a stale bookmark or a probe,
// and gets the same answer either way.
const scopedShop = async (req, res, next) => {
  const id = await theShopId();
  if (!id || Number(req.params.shopId) !== Number(id)) {
    return res.status(404).json({ error: 'Shop not found' });
  }
  next();
};

// Routes addressed by stock item id. The shop is not in the URL, so it has to
// be read from the row before we can tell whether this key may touch it.
const scopedItem = async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT shop_id FROM stock_items WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Item not found' });
    const id = await theShopId();
    if (Number(rows[0].shop_id) !== Number(id)) {
      return res.status(404).json({ error: 'Item not found' });
    }
    next();
  } catch (err) {
    logger.error('scopedItem.error', { err: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
};

// ── Shops ─────────────────────────────────────────────────
app.get('/api/shops', auth, async (req, res) => {
  try {
    if (!req.user.businessId) return res.json([]);
    const { rows } = await pool.query(
      'SELECT * FROM shops WHERE business_id=$1 ORDER BY name',
      [req.user.businessId]
    );
    res.json(rows.map(formatShop));
  } catch (err) {
    logger.error('shops.list.error', { err: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Stock items (per shop) ────────────────────────────────
// Verify shop belongs to user's business
// ── Staff ─────────────────────────────────────────────────
// Not user accounts: one shared login stays, and this is simply "who is
// standing at the till". Everything a person scans carries their name, which
// is what turns the movement log into an answer to "who handled this?".
const staffSchema = z.object({
  name: z.string().trim().min(1).max(80),
  shopId: z.number().int().positive().nullable().optional(),
  commissionRate: z.coerce.number().min(0).max(100).optional(),
});

const formatStaff = (s) => ({
  id: s.id,
  name: s.name,
  shopId: s.shop_id,
  active: s.active,
  commissionRate: s.commission_rate !== undefined && s.commission_rate !== null ? Number(s.commission_rate) : 0,
});

// Turns whatever the client sent into a { id, name } pair to stamp on a
// movement. An unknown or missing staff id records nothing rather than
// guessing — a blank name is honest, a wrong one is not.
async function resolveStaff(staffId, businessId) {
  const id = parseInt(staffId, 10);
  if (!Number.isInteger(id)) return { id: null, name: '' };
  const { rows } = await pool.query(
    'SELECT id, name FROM staff WHERE id=$1 AND business_id=$2',
    [id, businessId]
  );
  return rows.length ? { id: rows[0].id, name: rows[0].name } : { id: null, name: '' };
}

app.get('/api/staff', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM staff WHERE business_id=$1 AND active=TRUE ORDER BY name',
      [req.user.businessId]
    );
    res.json(rows.map(formatStaff));
  } catch (err) {
    logger.error('staff.list.error', { err: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/staff', auth, requireAdmin, validate(staffSchema), async (req, res) => {
  try {
    const { name, shopId, commissionRate } = req.body;
    const rate = commissionRate === undefined ? null : Number(commissionRate);
    // Reactivate rather than duplicate when a name comes back.
    const { rows: existing } = await pool.query(
      'SELECT * FROM staff WHERE business_id=$1 AND LOWER(name)=LOWER($2)',
      [req.user.businessId, name]
    );
    if (existing.length) {
      const { rows } = await pool.query(
        `UPDATE staff SET active=TRUE, shop_id=$1,
           commission_rate = COALESCE($2, commission_rate)
         WHERE id=$3 RETURNING *`,
        [shopId || null, rate, existing[0].id]
      );
      const wasRate = Number(existing[0].commission_rate) || 0;
      const nowRate = Number(rows[0].commission_rate) || 0;
      if (wasRate !== nowRate) {
        await audit(req, { action: 'update', entity: 'staff', entityId: rows[0].id,
          summary: rows[0].name + ' commission rate ' + wasRate + '% to ' + nowRate + '%',
          before: formatStaff(existing[0]), after: formatStaff(rows[0]) });
      } else if (!existing[0].active) {
        await audit(req, { action: 'update', entity: 'staff', entityId: rows[0].id,
          summary: rows[0].name + ' put back on the staff list' });
      }
      return res.status(200).json(formatStaff(rows[0]));
    }
    const { rows } = await pool.query(
      'INSERT INTO staff (business_id, shop_id, name, commission_rate) VALUES ($1,$2,$3,$4) RETURNING *',
      [req.user.businessId, shopId || null, name, rate || 0]
    );
    await audit(req, { action: 'create', entity: 'staff', entityId: rows[0].id,
      summary: 'Added ' + rows[0].name + ' at ' + (Number(rows[0].commission_rate) || 0) + '% commission',
      after: formatStaff(rows[0]) });
    res.status(201).json(formatStaff(rows[0]));
  } catch (err) {
    logger.error('staff.create.error', { err: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Soft delete: the movements this person scanned keep their name, so removing
// someone from the list never erases the history of what they handled.
app.delete('/api/staff/:id', auth, requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'UPDATE staff SET active=FALSE WHERE id=$1 AND business_id=$2 RETURNING *',
      [req.params.id, req.user.businessId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Staff member not found' });
    await audit(req, { action: 'delete', entity: 'staff', entityId: rows[0].id,
      summary: 'Removed ' + rows[0].name + ' from the staff list', before: formatStaff(rows[0]) });
    res.json({ ok: true });
  } catch (err) {
    logger.error('staff.delete.error', { err: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

async function shopGuard(shopId, businessId) {
  const r = await pool.query('SELECT 1 FROM shops WHERE id=$1 AND business_id=$2', [shopId, businessId]);
  return r.rowCount > 0;
}

// "shops=1,3" → [1,3]. Absent or unparseable → null, meaning "every shop".
// Used by the overview and sales endpoints so the owner can look at one shop,
// a couple of shops, or the whole business.
const parseShopIds = (v) => {
  if (v == null || v === '' || v === 'all') return null;
  const ids = String(v)
    .split(',')
    .map(s => parseInt(s.trim(), 10))
    .filter(n => Number.isInteger(n));
  return ids.length ? ids : null;
};

// Sales are counted for one calendar year, or for everything ever.
// Returns [start, end) as Dates, or nulls when the whole history is wanted.
const yearRange = (v) => {
  if (!v || v === 'all') return { start: null, end: null, year: 'all' };
  const y = parseInt(v, 10);
  if (!Number.isInteger(y) || y < 2000 || y > 2100) {
    const now = new Date().getFullYear();
    return { start: new Date(Date.UTC(now, 0, 1)), end: new Date(Date.UTC(now + 1, 0, 1)), year: now };
  }
  return { start: new Date(Date.UTC(y, 0, 1)), end: new Date(Date.UTC(y + 1, 0, 1)), year: y };
};

// Movement types, and what each one means for the sales figures:
//
//   sale          sold to a customer (scanned or entered by hand)  → a sale
//   out           legacy manual "Sold" log entry                   → a sale
//   in            stock arriving (from the factory or by hand)     → not a sale
//   transfer-out  left this shop, bound for another shop           → not a sale
//   transfer-in   arrived here from another shop                   → not a sale
//   removal       left the shop but was NOT sold — damaged,
//                 returned, reject, lost                           → not a sale
//   adjust        a stock count correction                         → not a sale
//
// Only the first two may ever be counted as sales. Everything else moves
// garments around without money changing hands, and folding those into the
// sales figures would quietly wreck every report on this page.
// A sale is a sale. Stock written off as damaged, lost or sampled leaves the
// shop but earns nothing, and used to be counted here — which inflated both
// revenue and the commission calculated from it.
const SALE_TYPES_SQL = "m.type IN ('sale', 'return')";

// Units that count toward revenue. A sale is negative qty_change so it flips
// positive; a return is positive qty_change so it flips negative and cancels
// the sale it reverses.
const NET_UNITS_SQL = "CASE WHEN m.type IN ('sale','return') THEN -m.qty_change ELSE 0 END";

app.get('/api/shops/:shopId/stock', auth, scopedShop, async (req, res) => {
  try {
    if (!await shopGuard(req.params.shopId, req.user.businessId)) {
      return res.status(404).json({ error: 'Shop not found' });
    }
    const search = (req.query.search || '').trim().toLowerCase();
    const groupParam = req.query.group; // 'all' | id | 'none'
    const params = [req.params.shopId];
    let sql = 'SELECT * FROM stock_items WHERE shop_id=$1 AND COALESCE(sku, \'\') <> \'\'';
    if (search) {
      params.push(`%${search}%`);
      sql += ` AND (LOWER(name) LIKE $${params.length} OR LOWER(category) LIKE $${params.length} OR LOWER(fabric) LIKE $${params.length} OR LOWER(print) LIKE $${params.length} OR LOWER(color) LIKE $${params.length} OR LOWER(size) LIKE $${params.length} OR LOWER(sku) LIKE $${params.length} OR LOWER(brand) LIKE $${params.length})`;
    }
    if (groupParam === 'none') {
      sql += ' AND group_id IS NULL';
    } else if (groupParam && groupParam !== 'all' && !Number.isNaN(Number(groupParam))) {
      params.push(Number(groupParam));
      sql += ` AND group_id=$${params.length}`;
    }
    if (req.query.fabric) {
      params.push(req.query.fabric);
      sql += ` AND fabric = $${params.length}`;
    }
    if (req.query.color) {
      params.push(req.query.color);
      sql += ` AND color = $${params.length}`;
    }
    if (req.query.size) {
      params.push(req.query.size);
      sql += ` AND size = $${params.length}`;
    }
    if (req.query.style) {
      params.push(req.query.style);
      sql += ` AND category = $${params.length}`;
    }
    // Default browse order is fabric → colour → style (how the owner reads her
    // stock). 'custom' preserves the manual drag-to-reorder positions.
    // Blank fabrics/colours sort to the bottom (see the overview endpoint).
    const ORDERS = {
      'fabric-color': "NULLIF(fabric,'') ASC NULLS LAST, NULLIF(color,'') ASC NULLS LAST, category ASC, size ASC",
      'color':        "NULLIF(color,'') ASC NULLS LAST, category ASC, NULLIF(fabric,'') ASC NULLS LAST, size ASC",
      'style':        "category ASC, NULLIF(color,'') ASC NULLS LAST, size ASC",
      'name':         "name ASC",
      'custom':       "position ASC, name ASC",
      'qty-asc':      "qty ASC, name ASC",
      'qty-desc':     "qty DESC, name ASC",
    };
    const orderBy = ORDERS[req.query.sort] || ORDERS['fabric-color'];
    sql += ` ORDER BY ${orderBy} LIMIT 5000`;
    const { rows } = await pool.query(sql, params);
    res.json(rows.map(formatStock));
  } catch (err) {
    logger.error('stock.list.error', { err: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Aggregated stock across all shops in the business — one row per SKU with
// per-shop qty and a grand total. Powers the master overview page.
app.get('/api/business/stock-overview', auth, requireAdmin, async (req, res) => {
  try {
    const businessId = req.user.businessId;
    if (!businessId) return res.status(400).json({ error: 'No business associated with user' });

    const params = [businessId];
    let where = "WHERE s.business_id = $1 AND COALESCE(si.sku, '') <> ''";

    // Optional scope: one shop, a few shops, or (default) all of them.
    const shopIds = parseShopIds(req.query.shops);
    if (shopIds) {
      params.push(shopIds);
      where += ` AND s.id = ANY($${params.length}::int[])`;
    }

    const search = (req.query.search || '').trim().toLowerCase();
    if (search) {
      params.push(`%${search}%`);
      const p = `$${params.length}`;
      where += ` AND (LOWER(si.name) LIKE ${p} OR LOWER(si.sku) LIKE ${p} OR LOWER(si.fabric) LIKE ${p} OR LOWER(si.color) LIKE ${p} OR LOWER(si.category) LIKE ${p} OR LOWER(si.size) LIKE ${p})`;
    }
    if (req.query.fabric) { params.push(req.query.fabric); where += ` AND si.fabric = $${params.length}`; }
    if (req.query.color)  { params.push(req.query.color);  where += ` AND si.color  = $${params.length}`; }
    if (req.query.size)   { params.push(req.query.size);   where += ` AND si.size   = $${params.length}`; }
    if (req.query.style)  { params.push(req.query.style);  where += ` AND si.category = $${params.length}`; }

    // Default browse order is fabric → colour → style, which is how the shop
    // owner reads her stock. Other orders are opt-in.
    // NULLIF(...,'') + NULLS LAST keeps blank fabrics/colours (bags, journals,
    // jewellery) at the bottom instead of crowding the top of the list.
    const ORDERS = {
      'fabric-color': "NULLIF(MIN(si.fabric),'') ASC NULLS LAST, NULLIF(MIN(si.color),'') ASC NULLS LAST, MIN(si.category) ASC, MIN(si.size) ASC",
      'color':        "NULLIF(MIN(si.color),'') ASC NULLS LAST, MIN(si.category) ASC, NULLIF(MIN(si.fabric),'') ASC NULLS LAST, MIN(si.size) ASC",
      'style':        "MIN(si.category) ASC, NULLIF(MIN(si.color),'') ASC NULLS LAST, MIN(si.size) ASC",
      'name':         'MIN(si.name) ASC',
      'total-desc':   'SUM(si.qty) DESC, MIN(si.name) ASC',
      'total-asc':    'SUM(si.qty) ASC, MIN(si.name) ASC',
    };
    const orderBy = ORDERS[req.query.sort] || ORDERS['fabric-color'];

    const sql = `
      SELECT
        si.sku,
        MIN(si.name)     AS name,
        MIN(si.category) AS style,
        MIN(si.fabric)   AS fabric,
        MIN(si.color)    AS color,
        MIN(si.size)     AS size,
        MIN(si.price)::float8 AS price,
        MIN(si.threshold)::int AS threshold,
        json_object_agg(s.name, si.qty) AS by_shop,
        SUM(si.qty)::int AS total
      FROM stock_items si
      JOIN shops s ON s.id = si.shop_id
      ${where}
      GROUP BY si.sku
      ORDER BY ${orderBy}
      LIMIT 5000
    `;
    const { rows } = await pool.query(sql, params);

    // Columns follow the chosen scope, so the totals and the table agree.
    const { rows: shopRows } = shopIds
      ? await pool.query(
          'SELECT id, name FROM shops WHERE business_id=$1 AND id = ANY($2::int[]) ORDER BY id',
          [businessId, shopIds]
        )
      : await pool.query('SELECT id, name FROM shops WHERE business_id=$1 ORDER BY id', [businessId]);

    res.json({
      shops: shopRows.map(r => r.name),
      shopList: shopRows.map(r => ({ id: r.id, name: r.name })),
      items: rows.map(r => ({
        sku: r.sku,
        name: r.name,
        style: r.style,
        fabric: r.fabric,
        color: r.color,
        size: r.size,
        price: Number(r.price) || 0,
        threshold: Number(r.threshold) || 0,
        byShop: r.by_shop || {},
        total: r.total,
      })),
    });
  } catch (err) {
    logger.error('stock.overview.error', { err: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// What sells best — grouped by whichever dimension the owner asks for.
// She wants to slice the same sales data by product, fabric, colour, style
// and shop, so the only thing that varies is the GROUP BY key.
const BEST_SELLER_KEYS = {
  sku:    { key: "NULLIF(sa.sku,'')", label: 'MIN(sa.name)' },
  fabric: { key: "NULLIF(sa.fabric,'')",   label: "MIN(NULLIF(sa.fabric,''))" },
  color:  { key: "NULLIF(sa.color,'')",    label: "MIN(NULLIF(sa.color,''))" },
  style:  { key: "NULLIF(sa.category,'')", label: "MIN(NULLIF(sa.category,''))" },
  shop:   { key: 'sa.shop_name', label: 'MIN(sa.shop_name)' },
  staff:  { key: "NULLIF(sa.staff_name,'')", label: "MIN(NULLIF(sa.staff_name,''))" },
};

// How many of each SKU sold, per shop, in one year. Keyed by SKU so the
// overview can hang a "sold" line under the matching stock row.
app.get('/api/business/sold-overview', auth, requireAdmin, async (req, res) => {
  try {
    const businessId = req.user.businessId;
    if (!businessId) return res.status(400).json({ error: 'No business associated with user' });

    const { start, end, year } = yearRange(req.query.year || String(new Date().getFullYear()));
    const shopIds = parseShopIds(req.query.shops);

    const params = [businessId];
    let where = `WHERE s.business_id = $1 AND ${SALE_TYPES_SQL} AND COALESCE(si.sku, '') <> ''`;
    if (start) {
      params.push(start, end);
      where += ` AND m.occurred_at >= $${params.length - 1} AND m.occurred_at < $${params.length}`;
    }
    if (shopIds) {
      params.push(shopIds);
      where += ` AND s.id = ANY($${params.length}::int[])`;
    }

    const { rows } = await pool.query(
      `SELECT si.sku, s.name AS shop_name, SUM(-m.qty_change)::int AS units
       FROM stock_movements m
       JOIN stock_items si ON si.id = m.item_id
       JOIN shops s ON s.id = si.shop_id
       ${where}
       GROUP BY si.sku, s.name`,
      params
    );

    const items = {};
    let grand = 0;
    for (const r of rows) {
      const units = Number(r.units) || 0;
      if (!items[r.sku]) items[r.sku] = { byShop: {}, total: 0 };
      items[r.sku].byShop[r.shop_name] = (items[r.sku].byShop[r.shop_name] || 0) + units;
      items[r.sku].total += units;
      grand += units;
    }
    res.json({ year, total: grand, items });
  } catch (err) {
    logger.error('business.soldoverview.error', { err: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Which years actually have sales in them — populates the year dropdown.
app.get('/api/business/sales-years', auth, requireAdmin, async (req, res) => {
  try {
    const businessId = req.user.businessId;
    if (!businessId) return res.status(400).json({ error: 'No business associated with user' });
    const { rows } = await pool.query(
      `SELECT DISTINCT EXTRACT(YEAR FROM m.occurred_at)::int AS year
       FROM stock_movements m
       JOIN stock_items si ON si.id = m.item_id
       JOIN shops s ON s.id = si.shop_id
       WHERE s.business_id = $1 AND ${SALE_TYPES_SQL}
       ORDER BY year DESC`,
      [businessId]
    );
    const years = rows.map(r => r.year);
    // The current year always appears, even before the first sale of it.
    const thisYear = new Date().getFullYear();
    if (!years.includes(thisYear)) years.unshift(thisYear);
    res.json({ years });
  } catch (err) {
    logger.error('business.salesyears.error', { err: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Everything that happened to one product in one year: every date it came in,
// every date it went out, who handled it, and a month-by-month roll-up.
// This is the "click the item and see August: 6 in, 4 sold" view.
app.get('/api/business/sku-history', auth, requireAdmin, async (req, res) => {
  try {
    const businessId = req.user.businessId;
    if (!businessId) return res.status(400).json({ error: 'No business associated with user' });
    const sku = String(req.query.sku || '').trim();
    if (!sku) return res.status(400).json({ error: 'No sku provided' });

    const { start, end, year } = yearRange(req.query.year || String(new Date().getFullYear()));
    const shopIds = parseShopIds(req.query.shops);

    const params = [businessId, sku];
    let where = 'WHERE s.business_id = $1 AND si.sku = $2';
    if (start) {
      params.push(start, end);
      where += ` AND m.occurred_at >= $${params.length - 1} AND m.occurred_at < $${params.length}`;
    }
    if (shopIds) {
      params.push(shopIds);
      where += ` AND s.id = ANY($${params.length}::int[])`;
    }

    const { rows } = await pool.query(
      `SELECT m.id, m.type, m.qty_change, m.qty_after, m.occurred_at, m.note,
              COALESCE(m.reason, '') AS reason, COALESCE(m.staff_name, '') AS staff_name,
              s.name AS shop_name, si.name AS item_name
       FROM stock_movements m
       JOIN stock_items si ON si.id = m.item_id
       JOIN shops s ON s.id = si.shop_id
       ${where}
       ORDER BY m.occurred_at DESC, m.id DESC
       LIMIT 2000`,
      params
    );

    // Roll up by month so a year reads at a glance before the detail.
    const months = {};
    for (const r of rows) {
      const key = new Date(r.occurred_at).toISOString().slice(0, 7); // YYYY-MM
      if (!months[key]) months[key] = { month: key, in: 0, sold: 0, removed: 0, transferred: 0 };
      const units = Math.abs(r.qty_change);
      if (r.type === 'in') months[key].in += units;
      else if (r.type === 'sale' || r.type === 'return') months[key].sold += units;
      else if (r.type === 'removal') months[key].removed += units;
      else if (r.type === 'transfer-in' || r.type === 'transfer-out') months[key].transferred += units;
    }

    // Which years have anything at all, so the year picker only offers real ones.
    const { rows: yearRows } = await pool.query(
      `SELECT DISTINCT EXTRACT(YEAR FROM m.occurred_at)::int AS year
       FROM stock_movements m
       JOIN stock_items si ON si.id = m.item_id
       JOIN shops s ON s.id = si.shop_id
       WHERE s.business_id = $1 AND si.sku = $2
       ORDER BY year DESC`,
      [businessId, sku]
    );

    res.json({
      sku,
      year,
      years: yearRows.map(r => r.year),
      months: Object.values(months).sort((a, b) => b.month.localeCompare(a.month)),
      movements: rows.map(r => ({
        id: r.id,
        type: r.type,
        qtyChange: r.qty_change,
        qtyAfter: r.qty_after,
        occurredAt: r.occurred_at,
        note: r.note || '',
        reason: r.reason,
        staffName: r.staff_name,
        shopName: r.shop_name,
        itemName: r.item_name,
      })),
    });
  } catch (err) {
    logger.error('business.skuhistory.error', { err: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Business-wide facet values — union of distinct fabric/color/size across all shops.
app.get('/api/business/facets', auth, requireAdmin, async (req, res) => {
  try {
    const businessId = req.user.businessId;
    if (!businessId) return res.status(400).json({ error: 'No business associated with user' });
    const { rows } = await pool.query(
      `SELECT
         COALESCE(ARRAY(
           SELECT DISTINCT fabric FROM stock_items si JOIN shops s ON s.id=si.shop_id
           WHERE s.business_id=$1 AND fabric <> '' ORDER BY fabric
         ), '{}') AS fabrics,
         COALESCE(ARRAY(
           SELECT DISTINCT color  FROM stock_items si JOIN shops s ON s.id=si.shop_id
           WHERE s.business_id=$1 AND color  <> '' ORDER BY color
         ), '{}') AS colors,
         COALESCE(ARRAY(
           SELECT DISTINCT size   FROM stock_items si JOIN shops s ON s.id=si.shop_id
           WHERE s.business_id=$1 AND size   <> '' ORDER BY size
         ), '{}') AS sizes,
         COALESCE(ARRAY(
           SELECT DISTINCT category FROM stock_items si JOIN shops s ON s.id=si.shop_id
           WHERE s.business_id=$1 AND category <> '' ORDER BY category
         ), '{}') AS styles`,
      [businessId]
    );
    const r = rows[0] || { fabrics: [], colors: [], sizes: [], styles: [] };
    res.json({ fabrics: r.fabrics, colors: r.colors, sizes: r.sizes, styles: r.styles });
  } catch (err) {
    logger.error('business.facets.error', { err: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Distinct fabric/color/size for filter dropdowns.
// Returns arrays sorted alphabetically, filtering out empty strings.
app.get('/api/shops/:shopId/facets', auth, scopedShop, async (req, res) => {
  try {
    if (!await shopGuard(req.params.shopId, req.user.businessId)) {
      return res.status(404).json({ error: 'Shop not found' });
    }
    const { rows } = await pool.query(
      `SELECT
         COALESCE(ARRAY(SELECT DISTINCT fabric FROM stock_items WHERE shop_id=$1 AND fabric <> '' ORDER BY fabric), '{}') AS fabrics,
         COALESCE(ARRAY(SELECT DISTINCT color  FROM stock_items WHERE shop_id=$1 AND color  <> '' ORDER BY color),  '{}') AS colors,
         COALESCE(ARRAY(SELECT DISTINCT size   FROM stock_items WHERE shop_id=$1 AND size   <> '' ORDER BY size),   '{}') AS sizes,
         COALESCE(ARRAY(SELECT DISTINCT category FROM stock_items WHERE shop_id=$1 AND category <> '' ORDER BY category), '{}') AS styles`,
      [req.params.shopId]
    );
    const r = rows[0] || { fabrics: [], colors: [], sizes: [], styles: [] };
    res.json({ fabrics: r.fabrics, colors: r.colors, sizes: r.sizes, styles: r.styles });
  } catch (err) {
    logger.error('stock.facets.error', { err: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Check user has permission to mutate stock
function canMutateStock(req) {
  if (req.user.role === 'owner') return true;
  // Staff perms loaded via separate query
  return null; // means we need to load
}

async function ensureStaffStockPerm(req, action) {
  if (req.user.role === 'owner') return true;
  const { rows } = await pool.query('SELECT permissions FROM users WHERE id=$1', [req.user.id]);
  if (!rows.length) return false;
  const perms = rows[0].permissions || {};
  if (action === 'edit') return !!perms.canEditStock;
  if (action === 'add') return !!perms.canAddItems;
  if (action === 'delete') return !!perms.canDeleteItems;
  return false;
}

app.post('/api/shops/:shopId/stock', auth, scopedShop, validate(stockItemSchema), async (req, res) => {
  try {
    if (!await shopGuard(req.params.shopId, req.user.businessId)) {
      return res.status(404).json({ error: 'Shop not found' });
    }
    if (!await ensureStaffStockPerm(req, 'add')) {
      return res.status(403).json({ error: 'You do not have permission to add stock items' });
    }
    const b = req.body;
    const { rows: posRows } = await pool.query(
      `SELECT COALESCE(MAX(position), -1) + 1 AS p FROM stock_items WHERE shop_id=$1`,
      [req.params.shopId]
    );
    const newPos = posRows[0].p;
    const { rows } = await pool.query(
      `INSERT INTO stock_items (shop_id, name, category, fabric, print, size, color, sku, brand, qty, threshold, supplier, notes, position, image_url, price, cost)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
      [req.params.shopId, b.name, b.category, b.fabric, b.print, b.size, b.color, b.sku, b.brand, b.qty, b.threshold, b.supplier, b.notes, newPos, b.imageUrl, b.price, b.cost]
    );
    await audit(req, { action: 'create', entity: 'stock_item', entityId: rows[0].id,
      summary: 'Added ' + rows[0].name + ' (' + (rows[0].sku || 'no code') + ')', after: formatStock(rows[0]) });
    res.status(201).json(formatStock(rows[0]));
  } catch (err) {
    logger.error('stock.create.error', { err: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.put('/api/stock/:id', auth, scopedItem, validate(stockItemSchema), async (req, res) => {
  try {
    // Verify item belongs to a shop in user's business
    const { rows: own } = await pool.query(
      `SELECT s.id FROM stock_items s JOIN shops sh ON sh.id=s.shop_id WHERE s.id=$1 AND sh.business_id=$2`,
      [req.params.id, req.user.businessId]
    );
    if (!own.length) return res.status(404).json({ error: 'Item not found' });
    if (!await ensureStaffStockPerm(req, 'edit')) {
      return res.status(403).json({ error: 'You do not have permission to edit stock' });
    }
    const b = req.body;
    const { rows: prevRows } = await pool.query('SELECT * FROM stock_items WHERE id=$1', [req.params.id]);
    const { rows } = await pool.query(
      `UPDATE stock_items
       SET name=$1, category=$2, fabric=$3, print=$4, size=$5, color=$6, sku=$7, brand=$8, qty=$9, threshold=$10, supplier=$11, notes=$12, image_url=$13, price=$14, cost=$15, updated_at=NOW()
       WHERE id=$16 RETURNING *`,
      [b.name, b.category, b.fabric, b.print, b.size, b.color, b.sku, b.brand, b.qty, b.threshold, b.supplier, b.notes, b.imageUrl, b.price, b.cost, req.params.id]
    );
    const prev = prevRows[0] ? formatStock(prevRows[0]) : null;
    const next = formatStock(rows[0]);
    // Record only the fields that actually moved. An audit line saying
    // nothing changed is noise that buries the lines that matter.
    const changed = prev
      ? Object.keys(next).filter(k => k !== 'updatedAt' && String(prev[k]) !== String(next[k]))
      : [];
    if (changed.length) {
      await audit(req, { action: 'update', entity: 'stock_item', entityId: rows[0].id,
        summary: 'Edited ' + next.name + ': ' + changed.join(', '), before: prev, after: next });
    }
    res.json(next);
  } catch (err) {
    logger.error('stock.update.error', { err: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Quick qty update (also auto-logs movement)
app.patch('/api/stock/:id/qty', auth, scopedItem, async (req, res) => {
  const client = await pool.connect();
  try {
    const { qty } = req.body;
    if (typeof qty !== 'number' || qty < 0) return res.status(400).json({ error: 'qty must be a non-negative number' });
    const { rows: own } = await client.query(
      `SELECT s.id, s.qty, s.shop_id FROM stock_items s JOIN shops sh ON sh.id=s.shop_id WHERE s.id=$1 AND sh.business_id=$2`,
      [req.params.id, req.user.businessId]
    );
    if (!own.length) return res.status(404).json({ error: 'Item not found' });
    if (!await ensureStaffStockPerm(req, 'edit')) {
      return res.status(403).json({ error: 'You do not have permission to edit stock' });
    }
    const current = own[0].qty;
    const qtyChange = qty - current;
    const decreased = qty < current;
    await client.query('BEGIN');
    const { rows } = await client.query(
      decreased
        ? `UPDATE stock_items SET qty=$1, last_sold_at=NOW(), updated_at=NOW() WHERE id=$2 RETURNING *`
        : `UPDATE stock_items SET qty=$1, updated_at=NOW() WHERE id=$2 RETURNING *`,
      [qty, req.params.id]
    );
    if (qtyChange !== 0) {
      const mvType = qtyChange > 0 ? 'in' : 'out';
      await client.query(
        `INSERT INTO stock_movements (item_id, shop_id, user_id, type, qty_change, qty_after, occurred_at, note)
         VALUES ($1,$2,$3,$4,$5,$6,NOW(),'quick adjust')`,
        [req.params.id, own[0].shop_id, req.user.id, mvType, qtyChange, qty]
      );
    }
    await client.query('COMMIT');
    res.json(formatStock(rows[0]));
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('stock.qty.error', { err: err.message });
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// ── Barcode / scan-to-sell ────────────────────────────────
// A scanner types the code and presses Enter. Given a shop + code, find the
// matching item, drop its quantity by 1, and record it as a SALE (so it feeds
// the "sold" figures — distinct from transfers/adjustments).
app.post('/api/shops/:shopId/sell', auth, scopedShop, async (req, res) => {
  const client = await pool.connect();
  try {
    if (!await shopGuard(req.params.shopId, req.user.businessId)) {
      return res.status(404).json({ error: 'Shop not found' });
    }
    const code = String(req.body.code || '').trim();
    const itemId = parseInt(req.body.itemId, 10);
    const qtySold = Math.max(1, Math.min(999, parseInt(req.body.qty, 10) || 1));
    const manual = !!req.body.manual;
    if (!code && !Number.isInteger(itemId)) {
      return res.status(400).json({ error: 'No item or barcode provided' });
    }

    // A scan sends the code; the manual "type it in" flow sends the id of the
    // item the user picked out of the search results.
    const { rows: found } = Number.isInteger(itemId)
      ? await client.query('SELECT * FROM stock_items WHERE id=$1 AND shop_id=$2', [itemId, req.params.shopId])
      // Match on SKU first (that's what the barcode encodes); fall back to name.
      : await client.query(
          `SELECT * FROM stock_items
           WHERE shop_id=$1 AND (LOWER(sku)=LOWER($2) OR LOWER(name)=LOWER($2))
           ORDER BY (LOWER(sku)=LOWER($2)) DESC
           LIMIT 1`,
          [req.params.shopId, code]
        );
    if (!found.length) {
      return res.status(404).json({
        error: Number.isInteger(itemId)
          ? 'That item is not in this shop'
          : `No item with code "${code}" in this shop`,
      });
    }
    const item = found[0];
    if (item.qty <= 0) {
      return res.status(409).json({ error: `"${item.name}" is already out of stock`, item: formatStock(item) });
    }
    const newQty = Math.max(0, item.qty - qtySold);
    const change = newQty - item.qty; // negative

    await client.query('BEGIN');
    const { rows: upd } = await client.query(
      `UPDATE stock_items SET qty=$1, last_sold_at=NOW(), updated_at=NOW() WHERE id=$2 RETURNING *`,
      [newQty, item.id]
    );
    await client.query(
      `INSERT INTO stock_movements (item_id, shop_id, user_id, type, qty_change, qty_after, occurred_at, note)
       VALUES ($1,$2,$3,'sale',$4,$5,NOW(),$6)`,
      [item.id, item.shop_id, req.user.id, change, newQty, manual ? 'manual sale' : 'barcode sale']
    );
    await client.query('COMMIT');
    // -change, not qtySold: asking for 5 when 3 are left sells the 3 there are.
    res.json({ ok: true, item: formatStock(upd[0]), soldQty: -change });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('stock.sell.error', { err: err.message });
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// ── Scan: one endpoint, four things a garment can do ──────
// Sell, arrive from the factory, leave without being sold, or move to another
// shop. Staff scan the same box every time and only the mode changes, so
// there is one thing to learn instead of four.
const SCAN_MODES = {
  sell:   { type: 'sale',    dir: -1, label: 'Sold' },
  in:     { type: 'in',      dir: +1, label: 'Stocked in' },
  out:    { type: 'removal', dir: -1, label: 'Removed' },
  return: { type: 'return',  dir: +1, label: 'Returned' },
};

app.post('/api/shops/:shopId/scan', auth, scopedShop, async (req, res) => {
  const client = await pool.connect();
  try {
    if (!await shopGuard(req.params.shopId, req.user.businessId)) {
      return res.status(404).json({ error: 'Shop not found' });
    }
    const mode = SCAN_MODES[req.body.mode] ? req.body.mode : 'sell';
    const { type, dir, label } = SCAN_MODES[mode];
    const code = String(req.body.code || '').trim();
    const itemId = parseInt(req.body.itemId, 10);
    const qty = Math.max(1, Math.min(999, parseInt(req.body.qty, 10) || 1));
    const reason = String(req.body.reason || '').trim().slice(0, 80);
    const note = String(req.body.note || '').trim().slice(0, 500);
    if (!code && !Number.isInteger(itemId)) {
      return res.status(400).json({ error: 'No item or barcode provided' });
    }

    const staff = await resolveStaff(req.body.staffId, req.user.businessId);

    // Read the row inside the transaction and lock it. Scanning is bursty —
    // several pieces of the same style go across the counter in seconds — and
    // reading the quantity outside a lock lets two scans both see "5 left" and
    // both write 4, quietly losing a sale.
    await client.query('BEGIN');
    const { rows: found } = Number.isInteger(itemId)
      ? await client.query('SELECT * FROM stock_items WHERE id=$1 AND shop_id=$2 FOR UPDATE', [itemId, req.params.shopId])
      : await client.query(
          `SELECT * FROM stock_items
           WHERE shop_id=$1 AND (LOWER(sku)=LOWER($2) OR LOWER(name)=LOWER($2))
           ORDER BY (LOWER(sku)=LOWER($2)) DESC
           LIMIT 1
           FOR UPDATE`,
          [req.params.shopId, code]
        );
    if (!found.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        error: Number.isInteger(itemId)
          ? 'That item is not in this shop'
          : `No item with code "${code}" in this shop`,
      });
    }
    const item = found[0];

    // Only outward movements can run out of stock; stocking in cannot.
    if (dir < 0 && item.qty <= 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `"${item.name}" is already at zero`, item: formatStock(item) });
    }
    const newQty = dir > 0 ? item.qty + qty : Math.max(0, item.qty - qty);
    const change = newQty - item.qty;

    // last_sold_at tracks actual selling only: not a reject leaving the shop,
    // and not a return coming back — a returned garment did not just sell,
    // and letting it refresh this would hide slow stock from the dead-stock
    // report.
    const sql = type === 'sale'
      ? `UPDATE stock_items SET qty=$1, last_sold_at=NOW(), updated_at=NOW() WHERE id=$2 RETURNING *`
      : `UPDATE stock_items SET qty=$1, updated_at=NOW() WHERE id=$2 RETURNING *`;
    const { rows: upd } = await client.query(sql, [newQty, item.id]);
    await client.query(
      `INSERT INTO stock_movements
         (item_id, shop_id, user_id, type, qty_change, qty_after, occurred_at, note, reason, staff_id, staff_name)
       VALUES ($1,$2,$3,$4,$5,$6,NOW(),$7,$8,$9,$10)`,
      [
        item.id, item.shop_id, req.user.id, type, change, newQty,
        note || (Number.isInteger(itemId) ? 'manual' : 'barcode'),
        reason, staff.id, staff.name,
      ]
    );
    await client.query('COMMIT');
    res.json({
      ok: true,
      mode,
      label,
      item: formatStock(upd[0]),
      qtyChanged: Math.abs(change),
      staffName: staff.name,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('stock.scan.error', { err: err.message });
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

app.delete('/api/stock/:id', auth, scopedItem, async (req, res) => {
  try {
    const { rows: own } = await pool.query(
      `SELECT s.id FROM stock_items s JOIN shops sh ON sh.id=s.shop_id WHERE s.id=$1 AND sh.business_id=$2`,
      [req.params.id, req.user.businessId]
    );
    if (!own.length) return res.status(404).json({ error: 'Item not found' });
    if (!await ensureStaffStockPerm(req, 'delete')) {
      return res.status(403).json({ error: 'You do not have permission to delete items' });
    }
    const { rows: doomed } = await pool.query('SELECT * FROM stock_items WHERE id=$1', [req.params.id]);
    await pool.query(`DELETE FROM stock_items WHERE id=$1`, [req.params.id]);
    if (doomed[0]) {
      await audit(req, { action: 'delete', entity: 'stock_item', entityId: doomed[0].id,
        summary: 'Deleted ' + doomed[0].name + ' (' + (doomed[0].sku || 'no code') + '), qty was ' + doomed[0].qty,
        before: formatStock(doomed[0]) });
    }
    res.json({ ok: true });
  } catch (err) {
    logger.error('stock.delete.error', { err: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Stock movements (history of in/out events) ────────────
app.post('/api/stock/:id/movements', auth, scopedItem, validate(movementSchema), async (req, res) => {
  const client = await pool.connect();
  try {
    const { type, qty, occurredAt, note } = req.body;
    const { rows: own } = await client.query(
      `SELECT s.id, s.qty, s.shop_id FROM stock_items s JOIN shops sh ON sh.id=s.shop_id WHERE s.id=$1 AND sh.business_id=$2`,
      [req.params.id, req.user.businessId]
    );
    if (!own.length) return res.status(404).json({ error: 'Item not found' });
    if (!await ensureStaffStockPerm(req, 'edit')) {
      return res.status(403).json({ error: 'You do not have permission to log movements' });
    }
    const currentQty = own[0].qty;
    let newQty, qtyChange;
    if (type === 'in') { newQty = currentQty + qty; qtyChange = qty; }
    else if (type === 'out') { newQty = Math.max(0, currentQty - qty); qtyChange = -(currentQty - newQty); }
    else { newQty = qty; qtyChange = qty - currentQty; }
    const occurred = occurredAt ? new Date(occurredAt) : new Date();
    await client.query('BEGIN');
    const mv = await client.query(
      `INSERT INTO stock_movements (item_id, shop_id, user_id, type, qty_change, qty_after, occurred_at, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [req.params.id, own[0].shop_id, req.user.id, type, qtyChange, newQty, occurred, note]
    );
    const updateSql = type === 'out'
      ? `UPDATE stock_items SET qty=$1, last_sold_at=$2, updated_at=NOW() WHERE id=$3 RETURNING *`
      : `UPDATE stock_items SET qty=$1, updated_at=NOW() WHERE id=$2 RETURNING *`;
    const updateParams = type === 'out' ? [newQty, occurred, req.params.id] : [newQty, req.params.id];
    const { rows: itemRows } = await client.query(updateSql, updateParams);
    await client.query('COMMIT');
    res.status(201).json({ item: formatStock(itemRows[0]), movement: formatMovement(mv.rows[0]) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('movement.create.error', { err: err.message });
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

app.get('/api/stock/:id/movements', auth, scopedItem, async (req, res) => {
  try {
    const { rows: own } = await pool.query(
      `SELECT s.id FROM stock_items s JOIN shops sh ON sh.id=s.shop_id WHERE s.id=$1 AND sh.business_id=$2`,
      [req.params.id, req.user.businessId]
    );
    if (!own.length) return res.status(404).json({ error: 'Item not found' });
    const { rows } = await pool.query(
      `SELECT * FROM stock_movements WHERE item_id=$1 ORDER BY occurred_at DESC LIMIT 100`,
      [req.params.id]
    );
    res.json(rows.map(formatMovement));
  } catch (err) {
    logger.error('movement.list.error', { err: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Item groups (per shop) ────────────────────────────────
const groupSchema = z.object({
  name: z.string().trim().min(1).max(80),
});

app.get('/api/shops/:shopId/groups', auth, scopedShop, async (req, res) => {
  try {
    if (!await shopGuard(req.params.shopId, req.user.businessId)) {
      return res.status(404).json({ error: 'Shop not found' });
    }
    const { rows } = await pool.query(
      `SELECT * FROM item_groups WHERE shop_id=$1 ORDER BY position ASC, created_at ASC`,
      [req.params.shopId]
    );
    res.json(rows.map(formatGroup));
  } catch (err) {
    logger.error('group.list.error', { err: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/shops/:shopId/groups', auth, scopedShop, validate(groupSchema), async (req, res) => {
  try {
    if (!await shopGuard(req.params.shopId, req.user.businessId)) {
      return res.status(404).json({ error: 'Shop not found' });
    }
    if (!await ensureStaffStockPerm(req, 'add')) {
      return res.status(403).json({ error: 'You do not have permission to add groups' });
    }
    const { rows: posRows } = await pool.query(
      `SELECT COALESCE(MAX(position), -1) + 1 AS p FROM item_groups WHERE shop_id=$1`,
      [req.params.shopId]
    );
    const { rows } = await pool.query(
      `INSERT INTO item_groups (shop_id, name, position) VALUES ($1,$2,$3) RETURNING *`,
      [req.params.shopId, req.body.name, posRows[0].p]
    );
    res.status(201).json(formatGroup(rows[0]));
  } catch (err) {
    logger.error('group.create.error', { err: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/groups/:id', auth, requireAdmin, async (req, res) => {
  try {
    const { rows: own } = await pool.query(
      `SELECT g.id FROM item_groups g JOIN shops sh ON sh.id=g.shop_id WHERE g.id=$1 AND sh.business_id=$2`,
      [req.params.id, req.user.businessId]
    );
    if (!own.length) return res.status(404).json({ error: 'Group not found' });
    if (!await ensureStaffStockPerm(req, 'delete')) {
      return res.status(403).json({ error: 'You do not have permission to delete groups' });
    }
    await pool.query(`DELETE FROM item_groups WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    logger.error('group.delete.error', { err: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Assign item to group (or remove with groupId=null)
app.patch('/api/stock/:id/group', auth, scopedItem, async (req, res) => {
  try {
    const groupId = req.body?.groupId;
    const validGroupId = groupId === null || groupId === undefined || (Number.isInteger(groupId) && groupId > 0);
    if (!validGroupId) return res.status(400).json({ error: 'groupId must be a positive integer or null' });

    const { rows: own } = await pool.query(
      `SELECT s.id, s.shop_id FROM stock_items s JOIN shops sh ON sh.id=s.shop_id WHERE s.id=$1 AND sh.business_id=$2`,
      [req.params.id, req.user.businessId]
    );
    if (!own.length) return res.status(404).json({ error: 'Item not found' });
    if (!await ensureStaffStockPerm(req, 'edit')) {
      return res.status(403).json({ error: 'You do not have permission to edit stock' });
    }
    if (groupId) {
      const { rows: g } = await pool.query(
        `SELECT 1 FROM item_groups WHERE id=$1 AND shop_id=$2`,
        [groupId, own[0].shop_id]
      );
      if (!g.length) return res.status(404).json({ error: 'Group not found in this shop' });
    }
    const { rows } = await pool.query(
      `UPDATE stock_items SET group_id=$1, updated_at=NOW() WHERE id=$2 RETURNING *`,
      [groupId || null, req.params.id]
    );
    res.json(formatStock(rows[0]));
  } catch (err) {
    logger.error('stock.group.error', { err: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Reorder items — body: { orderedIds: number[] }
// Reassigns the positions among those items to match the new order, preserving the slot set.
app.patch('/api/shops/:shopId/stock/reorder', auth, scopedShop, async (req, res) => {
  const client = await pool.connect();
  try {
    const orderedIds = Array.isArray(req.body?.orderedIds) ? req.body.orderedIds : null;
    if (!orderedIds || !orderedIds.every(n => Number.isInteger(n) && n > 0)) {
      return res.status(400).json({ error: 'orderedIds must be an array of positive integers' });
    }
    if (!await shopGuard(req.params.shopId, req.user.businessId)) {
      return res.status(404).json({ error: 'Shop not found' });
    }
    if (!await ensureStaffStockPerm(req, 'edit')) {
      return res.status(403).json({ error: 'You do not have permission to reorder stock' });
    }
    const { rows: existing } = await client.query(
      `SELECT id, position FROM stock_items WHERE id = ANY($1::int[]) AND shop_id=$2`,
      [orderedIds, req.params.shopId]
    );
    if (existing.length !== orderedIds.length) {
      return res.status(400).json({ error: 'Some items not found in this shop' });
    }
    const slots = existing.map(r => r.position).sort((a, b) => a - b);
    await client.query('BEGIN');
    for (let i = 0; i < orderedIds.length; i++) {
      await client.query(`UPDATE stock_items SET position=$1 WHERE id=$2`, [slots[i], orderedIds[i]]);
    }
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('stock.reorder.error', { err: err.message });
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// ── Error handler ─────────────────────────────────────────
app.use((err, req, res, next) => {
  logger.error('unhandled', { path: req.path, method: req.method, err: err.message, stack: err.stack });
  res.status(500).json({ error: 'Internal server error' });
});

// ── Start ─────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════
// AUDIT LOG
// ═══════════════════════════════════════════════════════════
// Stock movements record what happened to the garments. This records what
// happened to the books: a price edited, an item deleted, a commission rate
// changed. Those leave no trace in the movement log, and they are exactly
// the changes someone would want to point at months later.
async function audit(req, { action, entity, entityId, summary, before, after, staff }) {
  try {
    await pool.query(
      `INSERT INTO audit_log (business_id, action, entity, entity_id, summary,
                              before_val, after_val, actor_role, staff_id, staff_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [req.user.businessId, action, entity, entityId || null, summary || '',
       before ? JSON.stringify(before) : null,
       after ? JSON.stringify(after) : null,
       req.accessRole, (staff && staff.id) || null, (staff && staff.name) || '']
    );
  } catch (err) {
    // Never fail the user's action because the audit write failed — but make
    // the gap loud, because a silent hole in an audit trail is worse than no
    // audit trail at all.
    logger.error('audit.write.failed', { err: err.message, action, entity, entityId });
  }
}

app.get('/api/audit', auth, requireAdmin, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const params = [req.user.businessId];
    let where = 'WHERE business_id = $1';
    if (req.query.entity) { params.push(req.query.entity); where += ` AND entity = ${params.length}`; }
    if (req.query.action) { params.push(req.query.action); where += ` AND action = ${params.length}`; }

    const { rows } = await pool.query(
      `SELECT * FROM audit_log ${where} ORDER BY created_at DESC, id DESC LIMIT ${limit} OFFSET ${offset}`,
      params
    );
    const { rows: c } = await pool.query(`SELECT COUNT(*)::int AS n FROM audit_log ${where}`, params);
    res.json({
      total: c[0].n, limit, offset,
      items: rows.map(r => ({
        id: r.id, action: r.action, entity: r.entity, entityId: r.entity_id,
        summary: r.summary, before: r.before_val, after: r.after_val,
        actorRole: r.actor_role, staffName: r.staff_name || '', createdAt: r.created_at,
      })),
    });
  } catch (err) {
    logger.error('audit.list.error', { err: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ═══════════════════════════════════════════════════════════
// SALES
// ═══════════════════════════════════════════════════════════
// The price a garment sold at is read from the item at report time. That is
// only right while prices are stable: the movement log does not store the
// price struck on the day, so changing an item's price rewrites its sales
// history. Worth knowing before anyone reconciles these against a drawer.
const SALE_SELECT = `
  SELECT m.id, m.type, m.qty_change, m.occurred_at, m.reason, m.note,
         COALESCE(NULLIF(m.staff_name,''), '(not recorded)') AS staff_name,
         m.staff_id, si.sku, si.name AS item_name, si.color, si.size, si.category,
         si.fabric, COALESCE(si.price,0) AS price, COALESCE(si.cost,0) AS cost
  FROM stock_movements m
  JOIN stock_items si ON si.id = m.item_id
  JOIN shops sh ON sh.id = m.shop_id
`;

const shapeSale = (r) => {
  const units = -r.qty_change;                 // sale: +n · return: -n
  const price = Number(r.price);
  return {
    id: r.id,
    type: r.type,
    occurredAt: r.occurred_at,
    sku: r.sku,
    itemName: r.item_name,
    color: r.color || '',
    size: r.size || '',
    category: r.category || '',
    fabric: r.fabric || '',
    units,
    price,
    value: units * price,
    margin: units * (price - Number(r.cost)),
    staffId: r.staff_id,
    staffName: r.staff_name,
    reason: r.reason || '',
  };
};

// Today's till roll. Staff can see this — they need it to balance the drawer
// at close, and they watched every one of these prices go by anyway.
app.get('/api/sales/today', auth, async (req, res) => {
  try {
    const hours = Math.min(Math.max(parseInt(req.query.hours, 10) || 24, 1), 72);
    const { rows } = await pool.query(
      `${SALE_SELECT}
       WHERE sh.business_id = $1 AND ${SALE_TYPES_SQL}
         AND m.occurred_at >= NOW() - ($2 || ' hours')::interval
       ORDER BY m.occurred_at DESC, m.id DESC`,
      [req.user.businessId, String(hours)]
    );
    const items = rows.map(shapeSale);
    res.json({
      hours,
      items,
      totals: {
        units: items.reduce((n, i) => n + i.units, 0),
        revenue: items.reduce((n, i) => n + i.value, 0),
        margin: items.reduce((n, i) => n + i.margin, 0),
        transactions: items.length,
      },
    });
  } catch (err) {
    logger.error('sales.today.error', { err: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Two years rolling. Anything older is outside the window the business reads
// and is left in the table rather than served.
const HISTORY_MONTHS = 24;

function salesFilter(req, startParamIndex) {
  const params = [];
  let where = '';
  const push = (v) => { params.push(v); return startParamIndex + params.length - 1; };

  if (req.query.from) where += ` AND m.occurred_at >= ${push(new Date(req.query.from))}`;
  if (req.query.to) {
    // An end date means the end of that day, not midnight at its start.
    const to = new Date(req.query.to);
    to.setUTCHours(23, 59, 59, 999);
    where += ` AND m.occurred_at <= ${push(to)}`;
  }
  const staffId = parseInt(req.query.staffId, 10);
  if (Number.isInteger(staffId)) where += ` AND m.staff_id = ${push(staffId)}`;
  if (req.query.color) where += ` AND si.color ILIKE ${push(req.query.color)}`;
  if (req.query.sku) where += ` AND si.sku ILIKE ${push(req.query.sku)}`;
  const q = String(req.query.q || '').trim();
  if (q) {
    const i = push('%' + q + '%');
    where += ` AND (si.sku ILIKE ${i} OR si.name ILIKE ${i} OR si.color ILIKE ${i} OR m.staff_name ILIKE ${i})`;
  }
  return { where, params };
}

app.get('/api/sales/history', auth, requireAdmin, async (req, res) => {
  try {
    const { where, params } = salesFilter(req, 3);
    const all = [req.user.businessId, String(HISTORY_MONTHS), ...params];
    const windowSql = `sh.business_id = $1 AND ${SALE_TYPES_SQL}
      AND m.occurred_at >= NOW() - ($2 || ' months')::interval ${where}`;

    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 1000);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    const { rows } = await pool.query(
      `${SALE_SELECT} WHERE ${windowSql} ORDER BY m.occurred_at DESC, m.id DESC LIMIT ${limit} OFFSET ${offset}`,
      all
    );
    const { rows: agg } = await pool.query(
      `SELECT COUNT(*)::int AS n,
              COALESCE(SUM(${NET_UNITS_SQL}),0)::int AS units,
              COALESCE(SUM(${NET_UNITS_SQL} * COALESCE(si.price,0)),0)::numeric AS revenue
       FROM stock_movements m
       JOIN stock_items si ON si.id = m.item_id
       JOIN shops sh ON sh.id = m.shop_id
       WHERE ${windowSql}`,
      all
    );
    res.json({
      total: agg[0].n, limit, offset, windowMonths: HISTORY_MONTHS,
      totals: { units: agg[0].units, revenue: Number(agg[0].revenue) },
      items: rows.map(shapeSale),
    });
  } catch (err) {
    logger.error('sales.history.error', { err: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── CSV ───────────────────────────────────────────────────
// A leading =, +, - or @ makes Excel treat a cell as a formula, so any value
// starting with one is prefixed with a quote. Without this, an item named
// "=cmd" is a live formula in whoever opens the file.
const csvCell = (v) => {
  let t = v === null || v === undefined ? '' : String(v);
  // A leading =, +, - or @ makes Excel treat a cell as a formula, so an
  // item named "=cmd|..." would execute in whoever opens the file. But a
  // plain negative number also starts with - and is NOT a formula:
  // escaping those turned every return into text that would not sum,
  // which defeats the point of exporting for analysis.
  const isPlainNumber = t !== '' && Number.isFinite(Number(t));
  if (!isPlainNumber && /^[=+@\t\r-]/.test(t)) t = "'" + t;
  return '"' + t.replace(/"/g, '""') + '"';
};
const csvDoc = (header, rows) =>
  [header.map(csvCell).join(','), ...rows.map(r => r.map(csvCell).join(','))].join('\r\n');

const sendCsv = (res, name, body) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  // Byte-order mark so Excel opens it as UTF-8 instead of mangling accents.
  res.send('﻿' + body);
};

app.get('/api/sales/history.csv', auth, requireAdmin, async (req, res) => {
  try {
    const { where, params } = salesFilter(req, 3);
    const all = [req.user.businessId, String(HISTORY_MONTHS), ...params];
    const { rows } = await pool.query(
      `${SALE_SELECT}
       WHERE sh.business_id = $1 AND ${SALE_TYPES_SQL}
         AND m.occurred_at >= NOW() - ($2 || ' months')::interval ${where}
       ORDER BY m.occurred_at DESC, m.id DESC LIMIT 20000`,
      all
    );
    const body = csvDoc(
      ['Date', 'Time', 'Type', 'SKU', 'Item', 'Colour', 'Size', 'Units', 'Price (IDR)', 'Value (IDR)', 'Staff', 'Reason'],
      rows.map(shapeSale).map(r => {
        const d = new Date(r.occurredAt);
        return [d.toISOString().slice(0, 10), d.toISOString().slice(11, 19),
                r.type, r.sku, r.itemName, r.color, r.size, r.units, r.price, r.value, r.staffName, r.reason];
      })
    );
    sendCsv(res, `sales-${new Date().toISOString().slice(0, 10)}.csv`, body);
  } catch (err) {
    logger.error('sales.csv.error', { err: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ═══════════════════════════════════════════════════════════
// ANALYTICS
// ═══════════════════════════════════════════════════════════
// Best and worst sellers, monthly trend, turnover and dead stock in one call,
// because they are read together on one screen and four round trips to say
// one thing is three too many.
app.get('/api/analytics/summary', auth, requireAdmin, async (req, res) => {
  try {
    const { where, params } = salesFilter(req, 3);
    const all = [req.user.businessId, String(HISTORY_MONTHS), ...params];
    const windowSql = `sh.business_id = $1 AND ${SALE_TYPES_SQL}
      AND m.occurred_at >= NOW() - ($2 || ' months')::interval ${where}`;

    const [sellers, trend, shelf] = await Promise.all([
      // Ranked by units and by value, because the fastest-moving garment and
      // the most profitable one are rarely the same garment.
      pool.query(
        `SELECT si.sku, MIN(si.name) AS name, MIN(si.color) AS color,
                COALESCE(SUM(${NET_UNITS_SQL}),0)::int AS units,
                COALESCE(SUM(${NET_UNITS_SQL} * COALESCE(si.price,0)),0)::numeric AS revenue
         FROM stock_movements m
         JOIN stock_items si ON si.id = m.item_id
         JOIN shops sh ON sh.id = m.shop_id
         WHERE ${windowSql} AND COALESCE(si.sku,'') <> ''
         GROUP BY si.sku HAVING SUM(${NET_UNITS_SQL}) <> 0
         ORDER BY units DESC`,
        all
      ),
      pool.query(
        `SELECT to_char(date_trunc('month', m.occurred_at), 'YYYY-MM') AS month,
                COALESCE(SUM(${NET_UNITS_SQL}),0)::int AS units,
                COALESCE(SUM(${NET_UNITS_SQL} * COALESCE(si.price,0)),0)::numeric AS revenue
         FROM stock_movements m
         JOIN stock_items si ON si.id = m.item_id
         JOIN shops sh ON sh.id = m.shop_id
         WHERE ${windowSql}
         GROUP BY 1 ORDER BY 1`,
        all
      ),
      // Everything on the shelf with when it last sold. Stock that has NEVER
      // sold is the point of the dead-stock report, so a null last_sold_at
      // has to survive — hence the left join onto sales rather than an inner.
      pool.query(
        `SELECT si.id, si.sku, si.name, si.color, si.size, si.qty, si.threshold,
                COALESCE(si.price,0) AS price, si.last_sold_at, si.created_at,
                COALESCE(sold.units, 0)::int AS units_sold
         FROM stock_items si
         JOIN shops sh ON sh.id = si.shop_id
         LEFT JOIN (
           SELECT m.item_id, SUM(${NET_UNITS_SQL}) AS units
           FROM stock_movements m
           WHERE m.type IN ('sale','return')
             AND m.occurred_at >= NOW() - ($2 || ' months')::interval
           GROUP BY m.item_id
         ) sold ON sold.item_id = si.id
         WHERE sh.business_id = $1`,
        [req.user.businessId, String(HISTORY_MONTHS)]
      ),
    ]);

    const ranked = sellers.rows.map(r => ({
      sku: r.sku, name: r.name, color: r.color || '',
      units: r.units, revenue: Number(r.revenue),
    }));
    const byRevenue = [...ranked].sort((a, b) => b.revenue - a.revenue);

    const DAY = 86400000;
    const now = Date.now();
    const stock = shelf.rows.map(r => {
      // Days on the shelf, floored at one: a garment added today must not
      // divide by zero and report an infinite sales rate.
      const age = Math.max(1, (now - new Date(r.created_at).getTime()) / DAY);
      const daysSinceSold = r.last_sold_at
        ? Math.floor((now - new Date(r.last_sold_at).getTime()) / DAY)
        : null;
      return {
        id: r.id, sku: r.sku, name: r.name, color: r.color || '', size: r.size || '',
        qty: r.qty, threshold: r.threshold, price: Number(r.price),
        unitsSold: r.units_sold,
        daysSinceSold,
        velocity: Math.round((r.units_sold / age) * 30 * 100) / 100,   // pieces per 30 days
        lowStock: r.qty <= r.threshold,
      };
    });

    const DEAD_DAYS = Math.min(Math.max(parseInt(req.query.deadDays, 10) || 90, 7), 730);
    const neverSold = 1e9;
    const deadStock = stock
      .filter(x => x.qty > 0 && (x.daysSinceSold === null || x.daysSinceSold >= DEAD_DAYS))
      .sort((a, b) =>
        (b.daysSinceSold === null ? neverSold : b.daysSinceSold) -
        (a.daysSinceSold === null ? neverSold : a.daysSinceSold));

    res.json({
      windowMonths: HISTORY_MONTHS,
      deadAfterDays: DEAD_DAYS,
      bestByUnits: ranked.slice(0, 15),
      worstByUnits: ranked.filter(x => x.units > 0).slice(-15).reverse(),
      bestByRevenue: byRevenue.slice(0, 15),
      trend: trend.rows.map(r => ({ month: r.month, units: r.units, revenue: Number(r.revenue) })),
      fastMoving: [...stock].sort((a, b) => b.velocity - a.velocity).slice(0, 15),
      deadStock: deadStock.slice(0, 100),
      deadStockCount: deadStock.length,
      deadStockValue: deadStock.reduce((n, x) => n + x.qty * x.price, 0),
      lowStock: stock.filter(x => x.lowStock).sort((a, b) => a.qty - b.qty),
    });
  } catch (err) {
    logger.error('analytics.summary.error', { err: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Commission ────────────────────────────────────────────
// Decided rather than left configurable, because a shop this size needs one
// rule everyone understands:
//   · a percentage of what the person sold, not a flat fee per garment —
//     prices run from a few hundred thousand to over a million rupiah, and
//     per-unit would pay the same for either;
//   · the rate lives on the staff row, so it can differ per person, and one
//     shared rate is simply the case where they all match;
//   · returns are deducted. Without that, ringing up a sale, taking the
//     commission and refunding it next week is free money.
// Write-offs (damaged, lost, sample) are NOT deducted: no commission was
// earned on them, so there is nothing to claw back.
const COMMISSION_SQL = `
  SELECT COALESCE(NULLIF(m.staff_name,''), '(not recorded)') AS name,
         MIN(m.staff_id) AS staff_id,
         COALESCE(SUM(CASE WHEN m.type='sale'   THEN -m.qty_change ELSE 0 END),0)::int AS sold_units,
         COALESCE(SUM(CASE WHEN m.type='return' THEN  m.qty_change ELSE 0 END),0)::int AS returned_units,
         COALESCE(SUM(CASE WHEN m.type='sale'   THEN -m.qty_change * COALESCE(si.price,0) ELSE 0 END),0)::numeric AS gross,
         COALESCE(SUM(CASE WHEN m.type='return' THEN  m.qty_change * COALESCE(si.price,0) ELSE 0 END),0)::numeric AS returned
  FROM stock_movements m
  JOIN stock_items si ON si.id = m.item_id
  JOIN shops sh ON sh.id = m.shop_id
`;

async function commissionRows(req) {
  const { where, params } = salesFilter(req, 3);
  const all = [req.user.businessId, String(HISTORY_MONTHS), ...params];
  const { rows } = await pool.query(
    `${COMMISSION_SQL}
     WHERE sh.business_id = $1 AND ${SALE_TYPES_SQL}
       AND m.occurred_at >= NOW() - ($2 || ' months')::interval ${where}
     GROUP BY 1`,
    all
  );
  const { rows: staffRows } = await pool.query(
    'SELECT id, name, commission_rate FROM staff WHERE business_id=$1', [req.user.businessId]
  );
  const rateById = new Map(staffRows.map(r => [r.id, Number(r.commission_rate) || 0]));
  const rateByName = new Map(staffRows.map(r => [r.name.toLowerCase(), Number(r.commission_rate) || 0]));

  return rows.map(r => {
    const gross = Number(r.gross);
    const returned = Number(r.returned);
    const net = gross - returned;
    const rate = r.staff_id != null && rateById.has(r.staff_id)
      ? rateById.get(r.staff_id)
      : (rateByName.get(String(r.name).toLowerCase()) || 0);
    return {
      staffId: r.staff_id, name: r.name, rate,
      soldUnits: r.sold_units, returnedUnits: r.returned_units,
      netUnits: r.sold_units - r.returned_units,
      gross, returned, net,
      commission: Math.round(net * rate) / 100,
    };
  }).sort((a, b) => b.net - a.net);
}

app.get('/api/commission', auth, requireAdmin, async (req, res) => {
  try {
    const items = await commissionRows(req);
    res.json({
      items,
      totals: {
        soldUnits: items.reduce((n, i) => n + i.soldUnits, 0),
        returnedUnits: items.reduce((n, i) => n + i.returnedUnits, 0),
        gross: items.reduce((n, i) => n + i.gross, 0),
        returned: items.reduce((n, i) => n + i.returned, 0),
        net: items.reduce((n, i) => n + i.net, 0),
        commission: items.reduce((n, i) => n + i.commission, 0),
      },
    });
  } catch (err) {
    logger.error('commission.error', { err: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/commission.csv', auth, requireAdmin, async (req, res) => {
  try {
    const items = await commissionRows(req);
    const body = csvDoc(
      ['Staff', 'Sold (units)', 'Returned (units)', 'Gross (IDR)', 'Returned (IDR)', 'Net (IDR)', 'Rate (%)', 'Commission (IDR)'],
      items.map(r => [r.name, r.soldUnits, r.returnedUnits, r.gross, r.returned, r.net, r.rate, r.commission])
    );
    sendCsv(res, `commission-${new Date().toISOString().slice(0, 10)}.csv`, body);
  } catch (err) {
    logger.error('commission.csv.error', { err: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/stock.csv', auth, requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT si.* FROM stock_items si JOIN shops sh ON sh.id = si.shop_id
       WHERE sh.business_id = $1 ORDER BY si.fabric, si.color, si.name`,
      [req.user.businessId]
    );
    const body = csvDoc(
      ['SKU', 'Item', 'Category', 'Fabric', 'Colour', 'Size', 'Qty', 'Low-stock at', 'Cost (IDR)', 'Price (IDR)', 'Supplier', 'Last sold'],
      rows.map(r => [r.sku, r.name, r.category, r.fabric, r.color, r.size, r.qty, r.threshold,
        Number(r.cost || 0), Number(r.price || 0), r.supplier,
        r.last_sold_at ? new Date(r.last_sold_at).toISOString().slice(0, 10) : ''])
    );
    sendCsv(res, `stock-${new Date().toISOString().slice(0, 10)}.csv`, body);
  } catch (err) {
    logger.error('stock.csv.error', { err: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

const PORT = process.env.PORT || 3000;
initDB()
  .then(() => app.listen(PORT, () => logger.info('server.started', { port: PORT, app: 'mitrasamadi' })))
  .catch(err => { logger.error('db.init.failed', { err: err.message, stack: err.stack }); process.exit(1); });
