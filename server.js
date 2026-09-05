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
app.use(express.json({ limit: '8mb' }));   // a full catalogue import is a large body
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
// One manager code that opens the whole business, and one staff code per
// shop that opens that shop and nothing else. Codes live only in env vars —
// never stored in the database, never returned to the browser, never
// rendered anywhere in the UI.
//
//   ADMIN_CODE  (or ACCESS_CODE)   manager: every shop
//   SHOP_CODE_<XX>                 staff at the shop whose key is <XX>
//
// The <XX> half is read from the environment rather than listed here, so a
// shop added in the app needs no code change — set SHOP_CODE_ for its key and
// it works. The previous version hardcoded GD and AT, which meant a variable
// named for a shop that did not exist was silently ignored.
//
// STAFF_CODE is deliberately NOT honoured any more. It used to mean "the
// staff code", from when there was one shop, and it resolved to Gold Dust —
// so a code put there for a different shop opened Gold Dust instead. A
// mapping you cannot see is a mapping that will be wrong.
const ADMIN_CODE = (process.env.ADMIN_CODE || process.env.ACCESS_CODE || '').trim();

const SHOP_CODE_PREFIX = 'SHOP_CODE_';
const SHOP_CODES = Object.entries(process.env).reduce((acc, [name, secret]) => {
  if (!name.startsWith(SHOP_CODE_PREFIX)) return acc;
  const key = name.slice(SHOP_CODE_PREFIX.length).toUpperCase();
  const value = (secret || '').trim();
  if (/^[A-Z]{2}$/.test(key) && value) acc[key] = value;
  return acc;
}, {});

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
  // No manager code configured yet: the gate is open, so a fresh deployment
  // can never lock itself out.
  if (!ADMIN_CODE) return { role: 'admin', shopCode: null };
  if (!code) return null;
  // The manager code wins. If the same string were set for both, it grants
  // the higher level rather than silently downgrading whoever typed it.
  if (safeEqual(code, ADMIN_CODE)) return { role: 'admin', shopCode: null };
  for (const [shopCode, secret] of Object.entries(SHOP_CODES)) {
    if (safeEqual(code, secret)) return { role: 'staff', shopCode };
  }
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

    // A staff session is pinned to exactly one shop for the life of its
    // token. Resolved here from the two-letter key rather than from anything
    // the caller sends, so no route can be talked into another shop.
    req.scopeShopId = null;
    if (req.accessRole === 'staff') {
      if (!decoded.shopCode || !SHOP_CODES[decoded.shopCode]) {
        return res.status(401).json({ error: 'This staff code is no longer valid' });
      }
      const { rows } = await pool.query(
        'SELECT id FROM shops WHERE business_id=$1 AND code=$2',
        [decoded.businessId, decoded.shopCode]
      );
      if (!rows.length) {
        return res.status(403).json({ error: 'This staff code is not linked to a shop yet' });
      }
      req.scopeShopId = rows[0].id;
    }
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
// Which shops may this session read? The manager may name any of them, or
// none to mean all. Staff get their own shop whatever they ask for.
async function scopeShopIds(req) {
  if (req.accessRole === 'staff') return [req.scopeShopId];
  const asked = parseShopIds(req.query.shops);
  if (asked && asked.length) {
    const { rows } = await pool.query(
      'SELECT id FROM shops WHERE business_id=$1 AND id = ANY($2::int[])',
      [req.user.businessId, asked]
    );
    return rows.map(r => r.id);
  }
  return null;   // null = every shop in the business
}

const shopAllowed = (req, shopId) =>
  req.accessRole === 'admin' || Number(shopId) === Number(req.scopeShopId);

const denyShop = (res) =>
  res.status(403).json({ error: 'That code only works for its own shop' });

const makeToken = (user, access = { role: 'admin', shopCode: null }) => jwt.sign(
  {
    id: user.id,
    email: user.email,
    role: user.role,
    businessId: user.business_id,
    accessRole: access.role,
    shopCode: access.shopCode || null,
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
    -- What this particular sale actually went at. Null means "whatever the
    -- item costs now", which is how every movement behaved before this
    -- column existed, so old rows keep reading exactly as they did. It is
    -- set when a sale is corrected to a price that is not the shelf price —
    -- a swap where the customer paid a difference, or a discount.
    ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS unit_price NUMERIC(14,2);

    -- How the customer paid. Empty means nobody recorded it, which is what
    -- every sale taken before this column existed will read as -- there is no
    -- honest way to guess, and defaulting them all to cash would invent a
    -- till balance that never happened.
    ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS payment TEXT DEFAULT '';
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
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_stock_shop_sku ON stock_items(shop_id, UPPER(sku)) WHERE COALESCE(sku,'') <> ''`,
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

  // ── Shops ───────────────────────────────────────────────
  // The business runs two shops, each with its own staff code. The two-letter
  // key is what ties a shop to its SHOP_CODE_* env var; a shop with no key
  // has no staff door and is reachable only by the manager code.
  //
  // NOTE: an earlier version of this migration folded every shop into one.
  // It has been removed rather than disabled — left in place it would delete
  // Atriq and merge its stock into Gold Dust on the next deploy.
  await pool.query(`ALTER TABLE shops ADD COLUMN IF NOT EXISTS code TEXT`);
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_shops_code
     ON shops(business_id, code) WHERE code IS NOT NULL`
  );

  const { rows: bizRow } = await pool.query('SELECT id FROM businesses ORDER BY id ASC LIMIT 1');
  if (bizRow.length) {
    const businessId = bizRow[0].id;
    const { rows: existing } = await pool.query(
      'SELECT id, name, code FROM shops WHERE business_id=$1 ORDER BY id ASC', [businessId]
    );

    // The shops the business actually runs. Rose Gold replaces what an
    // earlier migration created as "Gold Dust" — that name came from this
    // code assuming a single shop, not from the business.
    const WANTED = [['RG', 'Rose Gold'], ['AT', 'Atriq'], ['GD', 'Goldust']];

    // Rename before keying, so the row that already carries all the history
    // becomes Rose Gold rather than a fresh empty shop being made alongside
    // it.
    //
    // Matched on the name alone. It used to also match the key 'GD', which
    // cannot stand now that GD is Goldust's own key — the next boot after
    // Goldust was created would have found it, renamed it to Rose Gold and
    // handed it Rose Gold's key.
    //
    // The name is the safe discriminator because the two spellings differ:
    // "Gold Dust" is the old single-shop name this corrects, and "Goldust"
    // has no d before the "ust", so it cannot match. A shop that still has
    // the old name keeps being renamed whether or not it was keyed, which
    // matters — that row carries all the history, and a deployment where it
    // was already keyed GD must still end up as Rose Gold rather than having
    // a fresh empty Rose Gold created alongside it.
    const goldDust = existing.find(x => /gold *dust/i.test(x.name));
    if (goldDust && !existing.some(x => x.code === 'RG')) {
      await pool.query('UPDATE shops SET name=$1, code=$2 WHERE id=$3',
        ['Rose Gold', 'RG', goldDust.id]);
      logger.warn('migration.shop_renamed', { from: goldDust.name, to: 'Rose Gold', id: goldDust.id });
      goldDust.name = 'Rose Gold';
      goldDust.code = 'RG';
    }

    for (const [code, name] of WANTED) {
      if (existing.some(x => x.code === code)) continue;
      // Adopt a shop already under this name that simply has no key yet.
      const match = existing.find(
        x => !x.code && x.name.trim().toLowerCase() === name.toLowerCase()
      );
      if (match) {
        await pool.query('UPDATE shops SET code=$1 WHERE id=$2', [code, match.id]);
        match.code = code;
        continue;
      }
      // Otherwise adopt a lone unkeyed shop under any name — that is the
      // single-shop deployment being upgraded, and its id must survive or
      // every movement logged against it is orphaned.
      const lone = existing.length === 1 && !existing[0].code ? existing[0] : null;
      if (lone) {
        await pool.query('UPDATE shops SET code=$1, name=$2 WHERE id=$3', [code, name, lone.id]);
        lone.code = code;
        lone.name = name;
        continue;
      }
      const { rows: made } = await pool.query(
        'INSERT INTO shops (business_id, name, address, code) VALUES ($1,$2,$3,$4) RETURNING id, name, code',
        [businessId, name, '', code]
      );
      existing.push(made[0]);
      logger.info('migration.shop_created', { name, code });
    }
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

  // ── Stock check ─────────────────────────────────────────
  // A walk round the rail, ticked off item by item. One mark per item, so a
  // second tick updates rather than duplicating; the round records when the
  // list was last finished and when those marks fall away.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS stock_check_marks (
      id           SERIAL PRIMARY KEY,
      shop_id      INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
      item_id      INTEGER NOT NULL UNIQUE REFERENCES stock_items(id) ON DELETE CASCADE,
      qty_at_check INTEGER,
      checked_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      staff_id     INTEGER REFERENCES staff(id) ON DELETE SET NULL,
      staff_name   TEXT DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS stock_check_rounds (
      id            SERIAL PRIMARY KEY,
      shop_id       INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
      items_checked INTEGER NOT NULL DEFAULT 0,
      completed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      clears_at     TIMESTAMPTZ NOT NULL
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_check_marks_shop ON stock_check_marks(shop_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_check_rounds_shop ON stock_check_rounds(shop_id, completed_at DESC)`);

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
    // Carry the session's access level and shop through a page reload, so a
    // staff code does not come back as the manager.
    const access = { role: req.accessRole, shopCode: req.user.shopCode || null };
    const shop = req.scopeShopId
      ? (await pool.query('SELECT id, name, code FROM shops WHERE id=$1', [req.scopeShopId])).rows[0]
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


// Routes addressed as /api/shops/:shopId/... The shop must belong to this
// business, and a staff session may only ever name its own.
const scopedShop = async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT id FROM shops WHERE id=$1 AND business_id=$2',
      [req.params.shopId, req.user.businessId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Shop not found' });
    if (!shopAllowed(req, req.params.shopId)) return denyShop(res);
    next();
  } catch (err) {
    logger.error('scopedShop.error', { err: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Routes addressed by stock item id. The shop is not in the URL, so it has to
// be read from the row before we can tell whether this key may touch it.
const scopedItem = async (req, res, next) => {
  try {
    // The routes do not agree on what the parameter is called — most use
    // :id, the stock-check pair use :itemId — and reading only one of them
    // meant this looked up `undefined` and answered "Item not found" for
    // every tick on the Stock check screen. Take whichever the route
    // supplied, and hand the resolved id on so no handler has to guess.
    const itemId = req.params.id ?? req.params.itemId;
    const { rows } = await pool.query(
      `SELECT si.id, si.shop_id FROM stock_items si
       JOIN shops sh ON sh.id = si.shop_id
       WHERE si.id=$1 AND sh.business_id=$2`,
      [itemId, req.user.businessId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Item not found' });
    if (!shopAllowed(req, rows[0].shop_id)) return denyShop(res);
    req.scopedItemId = rows[0].id;
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
      `INSERT INTO stock_movements (item_id, shop_id, user_id, type, qty_change, qty_after, occurred_at, note, payment)
       VALUES ($1,$2,$3,'sale',$4,$5,NOW(),$6,$7)`,
      [item.id, item.shop_id, req.user.id, change, newQty,
       manual ? 'manual sale' : 'barcode sale', cleanPayment(req.body.payment)]
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
// The ways a customer can pay. A closed set, because this ends up in the
// takings: a free-text field would give you "card", "Card", "kartu" and
// "debit" as four different payment methods by the end of the month.
const PAYMENT_METHODS = ['cash', 'card'];
const cleanPayment = (v) => {
  // Only an actual string. JSON can carry ["cash"], and String() would
  // flatten that to "cash" — harmless here, but a normaliser that quietly
  // accepts the wrong shape is one that stops normalising later.
  if (typeof v !== 'string') return '';
  const t = v.trim().toLowerCase();
  return PAYMENT_METHODS.includes(t) ? t : '';
};

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
    // Only a sale is paid for. A stock-in or a write-off has no customer, and
    // storing a method against one would put it in the takings breakdown.
    const payment = type === 'sale' ? cleanPayment(req.body.payment) : '';
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
         (item_id, shop_id, user_id, type, qty_change, qty_after, occurred_at, note, reason, staff_id, staff_name, payment)
       VALUES ($1,$2,$3,$4,$5,$6,NOW(),$7,$8,$9,$10,$11)`,
      [
        item.id, item.shop_id, req.user.id, type, change, newQty,
        note || (Number.isInteger(itemId) ? 'manual' : 'barcode'),
        reason, staff.id, staff.name, payment,
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
    if (req.query.entity) { params.push(req.query.entity); where += ` AND entity = $${params.length}`; }
    if (req.query.action) { params.push(req.query.action); where += ` AND action = $${params.length}`; }

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
// The money a sold piece was worth. The price stored on the movement wins;
// otherwise the item's current price, which is what every figure used before
// per-sale prices existed. Every revenue figure has to go through this, or a
// corrected sale reads one way on the History list and another in the totals.
const SALE_PRICE_SQL = 'COALESCE(m.unit_price, si.price, 0)';

const SALE_SELECT = `
  SELECT m.id, m.type, m.qty_change, m.occurred_at, m.reason, m.note,
         COALESCE(NULLIF(m.staff_name,''), '(not recorded)') AS staff_name,
         m.staff_id, si.sku, si.name AS item_name, si.color, si.size, si.category,
         si.fabric, ${SALE_PRICE_SQL} AS price, COALESCE(si.cost,0) AS cost,
         m.unit_price AS unit_price, m.item_id, m.qty_change AS raw_qty_change,
         COALESCE(m.payment,'') AS payment,
         m.shop_id, sh.name AS shop_name
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
    // The item this row points at, and whether the price above was agreed on
    // the sale or just read off the shelf — the correction screen needs both.
    itemId: r.item_id,
    unitPrice: r.unit_price === null || r.unit_price === undefined ? null : Number(r.unit_price),
    value: units * price,
    margin: units * (price - Number(r.cost)),
    staffId: r.staff_id,
    staffName: r.staff_name,
    reason: r.reason || '',
    payment: r.payment || '',
    shopId: r.shop_id,
    shopName: r.shop_name || '',
  };
};

// Today's till roll. Staff can see this — they need it to balance the drawer
// at close, and they watched every one of these prices go by anyway.
app.get('/api/sales/today', auth, async (req, res) => {
  try {
    const hours = Math.min(Math.max(parseInt(req.query.hours, 10) || 24, 1), 72);
    const params = [req.user.businessId, String(hours)];
    const shopIds = await scopeShopIds(req);
    let scope = '';
    if (shopIds) {
      params.push(shopIds);
      scope = ` AND m.shop_id = ANY($${params.length}::int[])`;
    }
    const { rows } = await pool.query(
      `${SALE_SELECT}
       WHERE sh.business_id = $1 AND ${SALE_TYPES_SQL}
         AND m.occurred_at >= NOW() - ($2 || ' hours')::interval${scope}
       ORDER BY m.occurred_at DESC, m.id DESC`,
      params
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

// Every sales-shaped query goes through here, and the shop restriction is
// applied inside it rather than by each caller. Adding it at six call sites
// would mean one of them eventually forgets, and a forgotten scope silently
// mixes Atriq's takings into Gold Dust's report — the kind of wrong number
// nobody notices until it is used to pay someone.
async function salesFilter(req, startParamIndex) {
  const params = [];
  let where = '';
  const push = (v) => { params.push(v); return startParamIndex + params.length - 1; };

  const shopIds = await scopeShopIds(req);
  if (shopIds) where += ` AND m.shop_id = ANY($${push(shopIds)}::int[])`;

  if (req.query.from) where += ` AND m.occurred_at >= $${push(new Date(req.query.from))}`;
  if (req.query.to) {
    // An end date means the end of that day, not midnight at its start.
    const to = new Date(req.query.to);
    to.setUTCHours(23, 59, 59, 999);
    where += ` AND m.occurred_at <= $${push(to)}`;
  }
  const staffId = parseInt(req.query.staffId, 10);
  if (Number.isInteger(staffId)) where += ` AND m.staff_id = $${push(staffId)}`;
  if (req.query.color) where += ` AND si.color ILIKE $${push(req.query.color)}`;
  if (req.query.sku) where += ` AND si.sku ILIKE $${push(req.query.sku)}`;
  const q = String(req.query.q || '').trim();
  if (q) {
    const i = push('%' + q + '%');
    where += ` AND (si.sku ILIKE $${i} OR si.name ILIKE $${i} OR si.color ILIKE $${i} OR m.staff_name ILIKE $${i})`;
  }
  return { where, params, shopIds };
}

app.get('/api/sales/history', auth, async (req, res) => {
  try {
    const { where, params } = await salesFilter(req, 3);
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
              COALESCE(SUM(${NET_UNITS_SQL} * ${SALE_PRICE_SQL}),0)::numeric AS revenue
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

// ── Correcting a recorded sale ───────────────────────
// A customer who swaps a garment for a different style has not returned
// anything and has not bought a second thing: the sale that was recorded was
// simply of the wrong garment. Reversing and re-entering it would leave two
// misleading rows in the history and pay commission twice, so the row is
// corrected in place.
//
// Style, colour and size are not fields on the movement — they belong to the
// stock item — so changing them means pointing the sale at a different item,
// and the stock has to follow: the garment that was wrongly sold goes back on
// the rail, and the one that actually left comes off it.
//
// Every correction is written to the audit log with the before and after,
// because a screen that can quietly rewrite last month's takings needs to
// leave a trail.
const saleEditSchema = z.object({
  itemId: z.coerce.number().int().positive().optional(),
  qty: z.coerce.number().int().min(1).max(999).optional(),
  // null clears it, putting the row back on the item's shelf price.
  unitPrice: z.coerce.number().min(0).max(1e12).nullable().optional(),
  note: z.string().trim().max(500).optional(),
  // When it actually happened. A sale rung up on the way home belongs to the
  // afternoon it was made, not to the moment somebody got round to typing it.
  occurredAt: z.coerce.date().optional(),
  // Who is making the correction, so the audit trail names a person and not
  // just "staff".
  staffId: z.coerce.number().int().positive().nullable().optional(),
  // '' clears it back to "not recorded".
  payment: z.string().trim().max(20).optional(),
});

// How far back a sale's time may be moved. A week covers "we forgot to ring
// it up before the weekend" without leaving last quarter's takings open to
// being rewritten.
const EDIT_WINDOW_DAYS = 7;

app.patch('/api/sales/:id', auth, validate(saleEditSchema), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const saleId = parseInt(req.params.id, 10);
    if (!Number.isInteger(saleId)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Bad sale id' });
    }

    const { rows: mv } = await client.query(
      `SELECT m.*, sh.business_id
         FROM stock_movements m
         JOIN shops sh ON sh.id = m.shop_id
        WHERE m.id = $1 AND sh.business_id = $2
        FOR UPDATE OF m`,
      [saleId, req.user.businessId]
    );
    if (!mv.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'That record no longer exists' });
    }
    const move = mv[0];
    if (!shopAllowed(req, move.shop_id)) {
      await client.query('ROLLBACK');
      return denyShop(res);
    }
    // Only the rows History actually shows. Stock-in and write-offs are a
    // different correction with different arithmetic, and quietly accepting
    // them here would corrupt stock in a way nobody would notice.
    if (move.type !== 'sale' && move.type !== 'return') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Only a sale or a return can be corrected here' });
    }

    const oldItemId = move.item_id;
    const newItemId = req.body.itemId === undefined ? oldItemId : Number(req.body.itemId);

    // The direction is fixed by the row's type: correcting a sale can never
    // turn it into a return. That is a different event and needs its own row.
    const sign = move.qty_change < 0 ? -1 : 1;
    const oldUnits = Math.abs(move.qty_change);
    const newUnits = req.body.qty === undefined ? oldUnits : Number(req.body.qty);
    const newQtyChange = sign * newUnits;

    // A sale belongs to the shop it happened in; it cannot be moved to a
    // garment sitting in the other shop.
    const { rows: items } = await client.query(
      `SELECT id, shop_id, name, sku, qty, COALESCE(price,0) AS price
         FROM stock_items WHERE id = ANY($1::int[]) FOR UPDATE`,
      [[...new Set([oldItemId, newItemId])]]
    );
    const byId = new Map(items.map(i => [i.id, i]));
    const oldItem = byId.get(oldItemId);
    const newItem = byId.get(newItemId);
    if (!newItem) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'That item no longer exists' });
    }
    if (newItem.shop_id !== move.shop_id) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'That item belongs to a different shop' });
    }

    // Net the stock effect per item, so swapping between two sizes of the
    // same garment — or editing only the quantity — is one arithmetic pass
    // rather than two updates fighting over the same row.
    const delta = new Map();
    const bump = (id, n) => delta.set(id, (delta.get(id) || 0) + n);
    if (oldItem) bump(oldItemId, -move.qty_change);   // undo what was recorded
    bump(newItemId, newQtyChange);                    // apply what really happened

    let qtyAfter = move.qty_after;
    for (const [id, d] of delta) {
      if (d === 0) continue;
      const { rows: upd } = await client.query(
        'UPDATE stock_items SET qty = GREATEST(0, qty + $1), updated_at = NOW() WHERE id = $2 RETURNING qty',
        [d, id]
      );
      if (id === newItemId) qtyAfter = upd[0].qty;
    }
    if (!delta.get(newItemId)) {
      const { rows: cur } = await client.query('SELECT qty FROM stock_items WHERE id = $1', [newItemId]);
      qtyAfter = cur[0].qty;
    }

    const unitPrice = req.body.unitPrice === undefined ? move.unit_price : req.body.unitPrice;
    const note = req.body.note === undefined ? move.note : req.body.note;
    // A return is a refund, so it carries a method too; anything else does not.
    const payment = req.body.payment === undefined
      ? (move.payment || '')
      : cleanPayment(req.body.payment);

    // The time it happened. Bounded in both directions: nothing in the future,
    // because a sale cannot have happened yet, and nothing older than the
    // window, because that is the point at which correcting a record stops
    // being a correction.
    let occurredAt = move.occurred_at;
    if (req.body.occurredAt !== undefined) {
      const when = new Date(req.body.occurredAt);
      if (Number.isNaN(when.getTime())) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'That is not a date' });
      }
      const now = Date.now();
      // A minute of slack: a tablet whose clock is a few seconds fast should
      // not have "now" rejected as the future.
      if (when.getTime() > now + 60000) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'A sale cannot be dated in the future' });
      }
      if (when.getTime() < now - EDIT_WINDOW_DAYS * 86400000) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: `The time can only be set within the last ${EDIT_WINDOW_DAYS} days`,
        });
      }
      occurredAt = when;
    }

    const { rows: saved } = await client.query(
      `UPDATE stock_movements
          SET item_id = $1, qty_change = $2, qty_after = $3, unit_price = $4,
              note = $5, occurred_at = $6, payment = $7
        WHERE id = $8
        RETURNING id`,
      [newItemId, newQtyChange, qtyAfter, unitPrice, note, occurredAt, payment, saleId]
    );
    await client.query('COMMIT');

    const describe = (it, units, price) =>
      `${units} × ${it ? it.name : 'deleted item'}${it ? ' (' + it.sku + ')' : ''} @ ${price}`;
    await audit(req, {
      action: 'sale.corrected',
      entity: 'movement',
      entityId: saleId,
      summary: describe(oldItem, oldUnits, move.unit_price === null ? 'shelf price' : move.unit_price)
        + '  →  ' + describe(newItem, newUnits, unitPrice === null || unitPrice === undefined ? 'shelf price' : unitPrice),
      before: {
        itemId: oldItemId, qtyChange: move.qty_change,
        unitPrice: move.unit_price, note: move.note,
        occurredAt: move.occurred_at, payment: move.payment || '',
      },
      after: { itemId: newItemId, qtyChange: newQtyChange, unitPrice, note, occurredAt, payment },
      // Names the person who made the correction, not just the role. On the
      // shop floor "staff" is several people sharing one code.
      staff: await resolveStaff(req.body.staffId, req.user.businessId),
    });

    // Hand back the corrected row in the same shape the list uses, so the
    // screen can drop it straight in without a refetch.
    const { rows: fresh } = await pool.query(
      `${SALE_SELECT} WHERE m.id = $1`, [saved[0].id]
    );
    res.json(shapeSale(fresh[0]));
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    logger.error('sales.correct.error', { err: err.message });
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});


// Deleting a recorded movement.
//
// Correcting a row covers "it was the wrong garment". This covers "it never
// happened at all" â rung up twice, or scanned by accident. The stock effect
// is undone and the row goes, so the history reads as though the mistake was
// never made.
//
// Nothing is soft-deleted. A sale that stays in the table behind a flag would
// have to be excluded from six different revenue queries, and the first one
// anybody forgets pays commission on a sale that did not happen. The audit
// log keeps the record instead: it stores what the row said before it went,
// which is the part worth keeping.
app.delete('/api/movements/:id', auth, requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const moveId = parseInt(req.params.id, 10);
    if (!Number.isInteger(moveId)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Bad record id' });
    }

    const { rows: mv } = await client.query(
      `SELECT m.*, si.name AS item_name, si.sku
         FROM stock_movements m
         JOIN stock_items si ON si.id = m.item_id
         JOIN shops sh ON sh.id = m.shop_id
        WHERE m.id = $1 AND sh.business_id = $2
        FOR UPDATE OF m`,
      [moveId, req.user.businessId]
    );
    if (!mv.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'That record no longer exists' });
    }
    const move = mv[0];
    if (!shopAllowed(req, move.shop_id)) {
      await client.query('ROLLBACK');
      return denyShop(res);
    }

    // Undo whatever the row did to the stock. A sale recorded -1, so removing
    // it puts one back; a stock-in recorded +1, so removing it takes one off.
    const { rows: upd } = await client.query(
      'UPDATE stock_items SET qty = GREATEST(0, qty - $1), updated_at = NOW() WHERE id = $2 RETURNING qty',
      [move.qty_change, move.item_id]
    );

    await client.query('DELETE FROM stock_movements WHERE id = $1', [moveId]);
    await client.query('COMMIT');

    await audit(req, {
      action: 'movement.deleted',
      entity: 'movement',
      entityId: moveId,
      summary: `${move.type} ${move.qty_change > 0 ? '+' : ''}${move.qty_change} × `
        + `${move.item_name} (${move.sku}) on `
        + `${new Date(move.occurred_at).toISOString().slice(0, 10)} deleted`,
      before: {
        type: move.type, itemId: move.item_id, shopId: move.shop_id,
        qtyChange: move.qty_change, unitPrice: move.unit_price,
        occurredAt: move.occurred_at, staffName: move.staff_name,
        note: move.note, reason: move.reason,
      },
      after: null,
    });

    res.json({ ok: true, deletedId: moveId, itemId: move.item_id, qty: upd.length ? upd[0].qty : null });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    logger.error('movement.delete.error', { err: err.message });
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// ── Stock in and out ─────────────────────────────────
// The other half of the movement log. Sales answer "what did we take"; this
// answers "where did the stock go" â deliveries in, and write-offs out with
// the reason they left. Same filters as the sales history so the two screens
// behave alike, and the same window.
const STOCK_MOVE_TYPES_SQL =
  "m.type IN ('in', 'removal', 'transfer-in', 'transfer-out')";

const MOVE_SELECT = `
  SELECT m.id, m.type, m.qty_change, m.qty_after, m.occurred_at, m.reason, m.note,
         COALESCE(NULLIF(m.staff_name,''), '(not recorded)') AS staff_name,
         m.staff_id, si.sku, si.name AS item_name, si.color, si.size, si.category,
         si.fabric, COALESCE(si.price,0) AS price, m.item_id,
         m.shop_id, sh.name AS shop_name
  FROM stock_movements m
  JOIN stock_items si ON si.id = m.item_id
  JOIN shops sh ON sh.id = m.shop_id
`;

const shapeMove = (r) => ({
  id: r.id,
  type: r.type,
  occurredAt: r.occurred_at,
  sku: r.sku,
  itemName: r.item_name,
  color: r.color || '',
  size: r.size || '',
  category: r.category || '',
  fabric: r.fabric || '',
  // Positive means it came in, negative means it left. Kept signed so the
  // screen does not have to know which types mean which direction.
  units: r.qty_change,
  qtyAfter: r.qty_after,
  price: Number(r.price),
  value: Math.abs(r.qty_change) * Number(r.price),
  itemId: r.item_id,
  staffId: r.staff_id,
  staffName: r.staff_name,
  reason: r.reason || '',
  note: r.note || '',
  shopId: r.shop_id,
  shopName: r.shop_name || '',
});

app.get('/api/movements', auth, async (req, res) => {
  try {
    const { where, params } = await salesFilter(req, 3);
    const all = [req.user.businessId, String(HISTORY_MONTHS), ...params];

    // 'in', 'out', or everything when unset.
    const dir = String(req.query.dir || '').trim();
    let typeSql = STOCK_MOVE_TYPES_SQL;
    if (dir === 'in') typeSql = "m.type IN ('in', 'transfer-in')";
    else if (dir === 'out') typeSql = "m.type IN ('removal', 'transfer-out')";

    const windowSql = `sh.business_id = $1 AND ${typeSql}
      AND m.occurred_at >= NOW() - ($2 || ' months')::interval ${where}`;

    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 1000);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    const { rows } = await pool.query(
      `${MOVE_SELECT} WHERE ${windowSql} ORDER BY m.occurred_at DESC, m.id DESC LIMIT ${limit} OFFSET ${offset}`,
      all
    );
    const { rows: agg } = await pool.query(
      `SELECT COUNT(*)::int AS n,
              COALESCE(SUM(CASE WHEN m.qty_change > 0 THEN m.qty_change ELSE 0 END),0)::int AS in_units,
              COALESCE(SUM(CASE WHEN m.qty_change < 0 THEN -m.qty_change ELSE 0 END),0)::int AS out_units
       FROM stock_movements m
       JOIN stock_items si ON si.id = m.item_id
       JOIN shops sh ON sh.id = m.shop_id
       WHERE ${windowSql}`,
      all
    );
    res.json({
      total: agg[0].n, limit, offset, windowMonths: HISTORY_MONTHS,
      totals: { in: agg[0].in_units, out: agg[0].out_units },
      items: rows.map(shapeMove),
    });
  } catch (err) {
    logger.error('movements.list.error', { err: err.message });
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
    const { where, params } = await salesFilter(req, 3);
    const all = [req.user.businessId, String(HISTORY_MONTHS), ...params];
    const { rows } = await pool.query(
      `${SALE_SELECT}
       WHERE sh.business_id = $1 AND ${SALE_TYPES_SQL}
         AND m.occurred_at >= NOW() - ($2 || ' months')::interval ${where}
       ORDER BY m.occurred_at DESC, m.id DESC LIMIT 20000`,
      all
    );
    const body = csvDoc(
      ['Date', 'Time', 'Shop', 'Type', 'SKU', 'Item', 'Colour', 'Size', 'Units', 'Price (IDR)', 'Value (IDR)', 'Staff', 'Paid by', 'Reason'],
      rows.map(shapeSale).map(r => {
        const d = new Date(r.occurredAt);
        return [d.toISOString().slice(0, 10), d.toISOString().slice(11, 19), r.shopName,
                r.type, r.sku, r.itemName, r.color, r.size, r.units, r.price, r.value,
                r.staffName, r.payment, r.reason];
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
    const { where, params } = await salesFilter(req, 3);
    const all = [req.user.businessId, String(HISTORY_MONTHS), ...params];
    const windowSql = `sh.business_id = $1 AND ${SALE_TYPES_SQL}
      AND m.occurred_at >= NOW() - ($2 || ' months')::interval ${where}`;

    // The shelf query below reads stock_items rather than movements, so it
    // cannot reuse the movement-shaped clause salesFilter builds.
    const shelfParams = [req.user.businessId, String(HISTORY_MONTHS)];
    let shelfScope = '';
    {
      const ids = await scopeShopIds(req);
      if (ids) {
        shelfParams.push(ids);
        shelfScope = ` AND si.shop_id = ANY($${shelfParams.length}::int[])`;
      }
    }

    const [sellers, trend, shelf] = await Promise.all([
      // Ranked by units and by value, because the fastest-moving garment and
      // the most profitable one are rarely the same garment.
      pool.query(
        `SELECT si.sku, MIN(si.name) AS name, MIN(si.color) AS color,
                COALESCE(SUM(${NET_UNITS_SQL}),0)::int AS units,
                COALESCE(SUM(${NET_UNITS_SQL} * ${SALE_PRICE_SQL}),0)::numeric AS revenue
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
                COALESCE(SUM(${NET_UNITS_SQL} * ${SALE_PRICE_SQL}),0)::numeric AS revenue
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
         WHERE sh.business_id = $1${shelfScope}`,
        shelfParams
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
         COALESCE(SUM(CASE WHEN m.type='sale'   THEN -m.qty_change * ${SALE_PRICE_SQL} ELSE 0 END),0)::numeric AS gross,
         COALESCE(SUM(CASE WHEN m.type='return' THEN  m.qty_change * ${SALE_PRICE_SQL} ELSE 0 END),0)::numeric AS returned
  FROM stock_movements m
  JOIN stock_items si ON si.id = m.item_id
  JOIN shops sh ON sh.id = m.shop_id
`;

async function commissionRows(req) {
  const { where, params } = await salesFilter(req, 3);
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
    const params = [req.user.businessId];
    const ids = await scopeShopIds(req);
    let scope = '';
    if (ids) {
      params.push(ids);
      scope = ` AND si.shop_id = ANY($${params.length}::int[])`;
    }
    const { rows } = await pool.query(
      `SELECT si.*, sh.name AS shop_name FROM stock_items si JOIN shops sh ON sh.id = si.shop_id
       WHERE sh.business_id = $1${scope} ORDER BY sh.name, si.fabric, si.color, si.name`,
      params
    );
    const body = csvDoc(
      ['Shop', 'SKU', 'Item', 'Category', 'Fabric', 'Colour', 'Size', 'Qty', 'Low-stock at', 'Cost (IDR)', 'Price (IDR)', 'Supplier', 'Last sold'],
      rows.map(r => [r.shop_name, r.sku, r.name, r.category, r.fabric, r.color, r.size, r.qty, r.threshold,
        Number(r.cost || 0), Number(r.price || 0), r.supplier,
        r.last_sold_at ? new Date(r.last_sold_at).toISOString().slice(0, 10) : ''])
    );
    sendCsv(res, `stock-${new Date().toISOString().slice(0, 10)}.csv`, body);
  } catch (err) {
    logger.error('stock.csv.error', { err: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Shop keys ─────────────────────────────────────────────
// Which env var opens which shop, and — the part that matters — which
// configured codes open nothing at all. A code set for a shop key that no
// shop uses is silently ignored, which is exactly how a code meant for one
// shop ended up opening another. This makes that visible instead of leaving
// it to be discovered by someone trying to sell something.
//
// Secrets are never returned. Only whether one is set.
app.get('/api/admin/shop-keys', auth, requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, name, code FROM shops WHERE business_id=$1 ORDER BY name',
      [req.user.businessId]
    );
    const used = new Set(rows.map(r => r.code).filter(Boolean));
    res.json({
      managerCodeConfigured: Boolean(ADMIN_CODE),
      shops: rows.map(r => ({
        id: r.id,
        name: r.name,
        key: r.code || null,
        envVar: r.code ? SHOP_CODE_PREFIX + r.code : null,
        // No key means no staff door — the manager code still reaches it.
        codeConfigured: Boolean(r.code && SHOP_CODES[r.code]),
      })),
      // Configured codes whose two letters match no shop. These do nothing.
      orphanedCodes: Object.keys(SHOP_CODES)
        .filter(k => !used.has(k))
        .map(k => SHOP_CODE_PREFIX + k)
        .sort(),
    });
  } catch (err) {
    logger.error('admin.shopkeys.error', { err: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

const shopEditSchema = z.object({
  name: z.string().trim().min(1).max(120),
  code: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, 'Use two letters, e.g. RG')
    .nullable().optional()
    .or(z.literal('').transform(() => null)),
});

// Renaming a shop and setting its key are manager jobs, and doing them here
// rather than in a migration means the next shop does not need a code change.
app.put('/api/admin/shops/:id', auth, requireAdmin, validate(shopEditSchema), async (req, res) => {
  try {
    const { name, code } = req.body;
    const { rows: before } = await pool.query(
      'SELECT id, name, code FROM shops WHERE id=$1 AND business_id=$2',
      [req.params.id, req.user.businessId]
    );
    if (!before.length) return res.status(404).json({ error: 'Shop not found' });

    const { rows } = await pool.query(
      'UPDATE shops SET name=$1, code=$2 WHERE id=$3 AND business_id=$4 RETURNING *',
      [name, code || null, req.params.id, req.user.businessId]
    );
    const changed = [];
    if (before[0].name !== rows[0].name) changed.push(`name ${before[0].name} to ${rows[0].name}`);
    if ((before[0].code || '') !== (rows[0].code || '')) {
      changed.push(`key ${before[0].code || 'none'} to ${rows[0].code || 'none'}`);
    }
    if (changed.length) {
      await audit(req, { action: 'update', entity: 'shop', entityId: rows[0].id,
        summary: 'Shop ' + changed.join(', '), before: formatShop(before[0]), after: formatShop(rows[0]) });
    }
    res.json(formatShop(rows[0]));
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Another shop already uses that key' });
    logger.error('admin.shopedit.error', { err: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/admin/shops', auth, requireAdmin, validate(shopEditSchema), async (req, res) => {
  try {
    if (!req.user.businessId) return res.status(400).json({ error: 'No business' });
    const { name, code } = req.body;
    const { rows } = await pool.query(
      'INSERT INTO shops (business_id, name, address, code) VALUES ($1,$2,$3,$4) RETURNING *',
      [req.user.businessId, name, '', code || null]
    );
    await audit(req, { action: 'create', entity: 'shop', entityId: rows[0].id,
      summary: `Added shop ${rows[0].name}${rows[0].code ? ' (' + rows[0].code + ')' : ''}`,
      after: formatShop(rows[0]) });
    res.status(201).json(formatShop(rows[0]));
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Another shop already uses that key' });
    logger.error('admin.shopcreate.error', { err: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ═══════════════════════════════════════════════════════════
// STOCK CHECK
// ═══════════════════════════════════════════════════════════
// A walk round the rail with a list: every item the system believes is in
// stock, ticked off once someone has laid eyes on it. Items at zero are not
// listed — there is nothing to go and look at.
//
// The round resets a week after it is finished rather than a week after it
// is started, so finishing early does not shorten the next one.
const CHECK_RESET_DAYS = 7;

// Clears the marks once the completed round has aged out. Called at the top
// of every read so the list is never stale, whether or not anyone has been
// near the app since the week elapsed.
async function expireStockCheck(client, shopId) {
  const { rows } = await client.query(
    `SELECT id, completed_at, clears_at FROM stock_check_rounds
     WHERE shop_id = $1 ORDER BY completed_at DESC LIMIT 1`,
    [shopId]
  );
  const round = rows[0];
  if (!round || new Date(round.clears_at) > new Date()) return round || null;

  await client.query('DELETE FROM stock_check_marks WHERE shop_id = $1', [shopId]);
  logger.info('stockcheck.round_expired', { shopId, roundId: round.id });
  return null;
}

// Everything on the rail, with whether it has been seen this round.
app.get('/api/stock-check', auth, async (req, res) => {
  const client = await pool.connect();
  try {
    const ids = await scopeShopIds(req);
    const params = [req.user.businessId];
    let scope = '';
    if (ids) {
      params.push(ids);
      scope = ` AND si.shop_id = ANY($${params.length}::int[])`;
    }

    // A round belongs to one shop, so expiry is per shop.
    const { rows: shopRows } = await client.query(
      ids
        ? 'SELECT id FROM shops WHERE business_id = $1 AND id = ANY($2::int[])'
        : 'SELECT id FROM shops WHERE business_id = $1',
      ids ? [req.user.businessId, ids] : [req.user.businessId]
    );
    let openRound = null;
    for (const s of shopRows) {
      const round = await expireStockCheck(client, s.id);
      if (round && (!openRound || new Date(round.clears_at) < new Date(openRound.clears_at))) {
        openRound = round;
      }
    }

    const { rows } = await client.query(
      `SELECT si.id, si.sku, si.name, si.color, si.size, si.fabric, si.category,
              si.qty, COALESCE(si.price,0) AS price, si.shop_id, sh.name AS shop_name,
              m.checked_at, m.staff_name AS checked_by, m.qty_at_check
       FROM stock_items si
       JOIN shops sh ON sh.id = si.shop_id
       LEFT JOIN stock_check_marks m ON m.item_id = si.id
       WHERE sh.business_id = $1 AND si.qty > 0${scope}
       ORDER BY si.fabric, si.color, si.name, si.size`,
      params
    );

    const items = rows.map(r => ({
      id: r.id,
      sku: r.sku,
      name: r.name,
      color: r.color || '',
      size: r.size || '',
      fabric: r.fabric || '',
      category: r.category || '',
      qty: r.qty,
      price: Number(r.price),
      shopId: r.shop_id,
      shopName: r.shop_name,
      checked: Boolean(r.checked_at),
      checkedAt: r.checked_at,
      checkedBy: r.checked_by || '',
      // What the count was when it was ticked. If the shelf has moved since,
      // the tick is still true of the moment it was made — but the person
      // reading the list should be able to see that it moved.
      qtyAtCheck: r.qty_at_check,
      movedSinceCheck: r.checked_at != null && r.qty_at_check != null && r.qty_at_check !== r.qty,
    }));

    const checked = items.filter(x => x.checked).length;
    res.json({
      items,
      total: items.length,
      checked,
      remaining: items.length - checked,
      resetDays: CHECK_RESET_DAYS,
      // Set only once a round is finished and waiting to clear.
      completedAt: openRound ? openRound.completed_at : null,
      clearsAt: openRound ? openRound.clears_at : null,
    });
  } catch (err) {
    logger.error('stockcheck.list.error', { err: err.message });
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// Records a round as finished the moment the last item is ticked, so the week
// is counted from completion rather than from whenever someone next looks.
async function closeRoundIfComplete(client, shopId) {
  const { rows } = await client.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(m.item_id)::int AS checked
     FROM stock_items si
     LEFT JOIN stock_check_marks m ON m.item_id = si.id
     WHERE si.shop_id = $1 AND si.qty > 0`,
    [shopId]
  );
  const { total, checked } = rows[0];
  if (!total || checked < total) return null;

  const { rows: made } = await client.query(
    `INSERT INTO stock_check_rounds (shop_id, items_checked, clears_at)
     VALUES ($1, $2, NOW() + ($3 || ' days')::interval)
     RETURNING id, completed_at, clears_at`,
    [shopId, checked, String(CHECK_RESET_DAYS)]
  );
  logger.info('stockcheck.round_completed', { shopId, items: checked });
  return made[0];
}

// Starting over before the week is up — for when a count went wrong and the
// whole walk needs doing again.
app.post('/api/stock-check/reset', auth, async (req, res) => {
  try {
    const ids = await scopeShopIds(req);
    const params = [req.user.businessId];
    let scope = '';
    if (ids) {
      params.push(ids);
      scope = ` AND id = ANY($${params.length}::int[])`;
    }
    const { rows: shops } = await pool.query(
      `SELECT id FROM shops WHERE business_id = $1${scope}`, params
    );
    for (const s of shops) {
      await pool.query('DELETE FROM stock_check_marks WHERE shop_id = $1', [s.id]);
      await pool.query('DELETE FROM stock_check_rounds WHERE shop_id = $1 AND clears_at > NOW()', [s.id]);
    }
    res.json({ ok: true });
  } catch (err) {
    logger.error('stockcheck.reset.error', { err: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/stock-check/:itemId', auth, scopedItem, async (req, res) => {
  const client = await pool.connect();
  try {
    const staff = await resolveStaff(req.body.staffId, req.user.businessId);
    const { rows: item } = await client.query(
      'SELECT id, shop_id, qty FROM stock_items WHERE id = $1', [req.scopedItemId]
    );
    if (!item.length) return res.status(404).json({ error: 'Item not found' });
    if (item[0].qty <= 0) {
      return res.status(409).json({ error: 'That item is not in stock' });
    }

    await client.query(
      `INSERT INTO stock_check_marks (shop_id, item_id, qty_at_check, staff_id, staff_name)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (item_id) DO UPDATE
         SET checked_at = NOW(), qty_at_check = EXCLUDED.qty_at_check,
             staff_id = EXCLUDED.staff_id, staff_name = EXCLUDED.staff_name`,
      [item[0].shop_id, item[0].id, item[0].qty, staff.id, staff.name]
    );

    const round = await closeRoundIfComplete(client, item[0].shop_id);
    res.json({ ok: true, checked: true, roundCompleted: Boolean(round), round: round || null });
  } catch (err) {
    logger.error('stockcheck.mark.error', { err: err.message });
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

app.delete('/api/stock-check/:itemId', auth, scopedItem, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'DELETE FROM stock_check_marks WHERE item_id = $1 RETURNING shop_id', [req.scopedItemId]
    );
    // Unticking reopens the round: a finished round that is no longer
    // finished should not still be counting down to its reset.
    if (rows.length) {
      await pool.query(
        `DELETE FROM stock_check_rounds
         WHERE shop_id = $1 AND clears_at > NOW()`,
        [rows[0].shop_id]
      );
    }
    res.json({ ok: true, checked: false });
  } catch (err) {
    logger.error('stockcheck.unmark.error', { err: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ═══════════════════════════════════════════════════════════
// IMPORT STOCK
// ═══════════════════════════════════════════════════════════
// Loads a catalogue from the shop's own spreadsheet. Keyed on the code, so
// running it twice updates rather than duplicating — which matters, because
// the first run of an import of this size is rarely the last.
//
// Quantity comes from SALDO AKHIR alone. The sheet also carries SALDO AWAL,
// BRG MASUK and BRG KELUAR, and the identity
//     saldo awal + brg masuk − brg keluar = saldo akhir
// holds, so the closing figure is the only one that needs reading.
const importRowSchema = z.object({
  sku: z.string().trim().min(1).max(100),
  name: z.string().trim().min(1).max(200),
  style: z.string().trim().max(100).optional().default(''),
  color: z.string().trim().max(50).optional().default(''),
  size: z.string().trim().max(50).optional().default(''),
  price: z.coerce.number().min(0).max(1e12).optional().default(0),
  qty: z.coerce.number().int().min(0).max(1e6),
});
const importSchema = z.object({
  shopId: z.coerce.number().int().positive(),
  rows: z.array(importRowSchema).min(1).max(20000),
});

app.post('/api/admin/import-stock', auth, requireAdmin, validate(importSchema), async (req, res) => {
  const client = await pool.connect();
  try {
    const { shopId, rows } = req.body;

    const { rows: shop } = await client.query(
      'SELECT id, name FROM shops WHERE id = $1 AND business_id = $2',
      [shopId, req.user.businessId]
    );
    if (!shop.length) return res.status(404).json({ error: 'Shop not found' });

    // Last row wins on a repeated code, so a sheet with an accidental
    // duplicate lands one item rather than two fighting over the same code.
    const byCode = new Map();
    for (const r of rows) byCode.set(r.sku.toUpperCase(), r);
    const deduped = [...byCode.values()];

    await client.query('BEGIN');

    const { rows: existing } = await client.query(
      'SELECT id, sku FROM stock_items WHERE shop_id = $1', [shopId]
    );
    const idByCode = new Map(existing.map(e => [String(e.sku || '').toUpperCase(), e.id]));

    const { rows: posRows } = await client.query(
      'SELECT COALESCE(MAX(position), -1) + 1 AS p FROM stock_items WHERE shop_id = $1', [shopId]
    );
    let position = posRows[0].p;

    let created = 0, updated = 0;
    for (const r of deduped) {
      const id = idByCode.get(r.sku.toUpperCase());
      // The sheet has no fabric column of its own. STYLE is the grouping the
      // shop actually reads by — "all the Agustine dresses" — so it fills
      // both the category and the fabric block the Overview and Stock check
      // screens group on.
      const style = r.style || '';
      if (id) {
        await client.query(
          `UPDATE stock_items
             SET name=$1, category=$2, fabric=$3, color=$4, size=$5,
                 price=$6, qty=$7, updated_at=NOW()
           WHERE id=$8`,
          [r.name, style, style, r.color, r.size, r.price, r.qty, id]
        );
        updated++;
      } else {
        await client.query(
          `INSERT INTO stock_items
             (shop_id, name, category, fabric, print, size, color, sku, brand,
              qty, threshold, supplier, notes, position, image_url, price, cost)
           VALUES ($1,$2,$3,$3,'',$4,$5,$6,'',$7,0,'','',$8,'',$9,0)`,
          [shopId, r.name, style, r.size, r.color, r.sku, r.qty, position++, r.price]
        );
        created++;
      }
    }

    const inStock = deduped.filter(r => r.qty > 0).length;
    const pieces = deduped.reduce((n, r) => n + r.qty, 0);

    await client.query('COMMIT');

    await audit(req, {
      action: 'import', entity: 'stock_item',
      summary: `Imported ${deduped.length} products into ${shop[0].name}: `
        + `${created} new, ${updated} updated, ${pieces} pieces in stock`,
      after: { shop: shop[0].name, rows: deduped.length, created, updated, inStock, pieces },
    });
    logger.warn('stock.imported', { shopId, rows: deduped.length, created, updated, pieces });

    res.json({
      ok: true,
      shop: shop[0].name,
      received: rows.length,
      imported: deduped.length,
      duplicateCodes: rows.length - deduped.length,
      created,
      updated,
      inStock,
      pieces,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('stock.import.error', { err: err.message });
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// ═══════════════════════════════════════════════════════════
// RESET STOCK DATA
// ═══════════════════════════════════════════════════════════
// Clears every product, every movement and every grouping, leaving the shops
// and the staff list standing. Meant for the point where trial data has to
// go before the real catalogue is loaded.
//
// This is not undoable and there is no soft-delete behind it, so it is gated
// three ways: the manager code, an exact confirmation phrase in the body, and
// a backup the browser downloads before it will call this at all.
const RESET_PHRASE = 'DELETE ALL STOCK';

// What is actually there, so the confirmation screen states real numbers
// rather than asking someone to destroy an unknown quantity.
app.get('/api/admin/data-counts', auth, requireAdmin, async (req, res) => {
  try {
    const businessId = req.user.businessId;
    const one = async (sql) => Number((await pool.query(sql, [businessId])).rows[0].n);
    res.json({
      items: await one(
        `SELECT COUNT(*)::int AS n FROM stock_items si
         JOIN shops sh ON sh.id = si.shop_id WHERE sh.business_id = $1`),
      movements: await one(
        `SELECT COUNT(*)::int AS n FROM stock_movements m
         JOIN shops sh ON sh.id = m.shop_id WHERE sh.business_id = $1`),
      groups: await one(
        `SELECT COUNT(*)::int AS n FROM item_groups g
         JOIN shops sh ON sh.id = g.shop_id WHERE sh.business_id = $1`),
      // Kept by the reset — shown so it is clear what survives.
      shops: await one(`SELECT COUNT(*)::int AS n FROM shops WHERE business_id = $1`),
      staff: await one(`SELECT COUNT(*)::int AS n FROM staff WHERE business_id = $1 AND active = TRUE`),
    });
  } catch (err) {
    logger.error('admin.counts.error', { err: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/admin/reset-stock', auth, requireAdmin, async (req, res) => {
  if (String(req.body && req.body.confirm) !== RESET_PHRASE) {
    return res.status(400).json({ error: `Type "${RESET_PHRASE}" to confirm` });
  }
  const client = await pool.connect();
  try {
    const businessId = req.user.businessId;
    await client.query('BEGIN');

    // Count before deleting, so the audit entry left behind can say how much
    // went. Afterwards there is nothing left to count.
    const count = async (sql) => Number((await client.query(sql, [businessId])).rows[0].n);
    const before = {
      items: await count(
        `SELECT COUNT(*)::int AS n FROM stock_items si
         JOIN shops sh ON sh.id = si.shop_id WHERE sh.business_id = $1`),
      movements: await count(
        `SELECT COUNT(*)::int AS n FROM stock_movements m
         JOIN shops sh ON sh.id = m.shop_id WHERE sh.business_id = $1`),
      groups: await count(
        `SELECT COUNT(*)::int AS n FROM item_groups g
         JOIN shops sh ON sh.id = g.shop_id WHERE sh.business_id = $1`),
    };

    // Movements first. They cascade from stock_items anyway, but deleting
    // them explicitly keeps the order obvious and the counts honest.
    await client.query(
      `DELETE FROM stock_movements WHERE shop_id IN (SELECT id FROM shops WHERE business_id = $1)`,
      [businessId]
    );
    await client.query(
      `DELETE FROM stock_items WHERE shop_id IN (SELECT id FROM shops WHERE business_id = $1)`,
      [businessId]
    );
    await client.query(
      `DELETE FROM item_groups WHERE shop_id IN (SELECT id FROM shops WHERE business_id = $1)`,
      [businessId]
    );

    // The old audit entries all point at items that no longer exist, so they
    // are cleared too — but the reset itself is recorded, because "where did
    // everything go" must always have an answer.
    await client.query(`DELETE FROM audit_log WHERE business_id = $1`, [businessId]);
    await client.query(
      `INSERT INTO audit_log (business_id, action, entity, summary, before_val, actor_role)
       VALUES ($1, 'reset', 'stock', $2, $3, $4)`,
      [businessId,
       `Cleared all stock: ${before.items} products, ${before.movements} movements, ${before.groups} groups. Shops and staff kept.`,
       JSON.stringify(before), req.accessRole]
    );

    await client.query('COMMIT');
    logger.warn('admin.reset_stock', { businessId, ...before });
    res.json({ ok: true, removed: before });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('admin.reset.error', { err: err.message });
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

const PORT = process.env.PORT || 3000;
initDB()
  .then(() => app.listen(PORT, () => logger.info('server.started', { port: PORT, app: 'mitrasamadi' })))
  .catch(err => { logger.error('db.init.failed', { err: err.message, stack: err.stack }); process.exit(1); });
