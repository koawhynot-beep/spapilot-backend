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
const { Resend } = require('resend');

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
const APP_URL = process.env.APP_URL || FRONTEND_URL;
const EMAIL_FROM = process.env.EMAIL_FROM || 'Mitra Samadi <onboarding@resend.dev>';
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
if (!resend) {
  logger.warn('email.disabled', { reason: 'RESEND_API_KEY not set; emails will be logged only' });
}

async function sendEmail({ to, subject, html, text }) {
  if (!resend) {
    logger.info('email.skipped', { to, subject, text: text?.slice(0, 200) });
    return { skipped: true };
  }
  try {
    const result = await resend.emails.send({ from: EMAIL_FROM, to, subject, html, text });
    logger.info('email.sent', { to, subject, id: result?.data?.id });
    return result;
  } catch (err) {
    logger.error('email.send.error', { err: err.message, to, subject });
    throw err;
  }
}
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim())
  : ['http://localhost:3001', 'https://spapilot-app.onrender.com'];

// ── Middleware ────────────────────────────────────────────
app.use(helmet());
app.use(compression());
app.use(cors({ origin: allowedOrigins, credentials: true }));
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
const emailSchema = z.string().trim().toLowerCase().email().max(254);
const passwordSchema = z.string().min(8).max(128);

const signupSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  businessName: z.string().trim().min(1).max(120),
  accessCode: z.string().max(128).optional().default(''),
});
const accessSchema = z.object({
  code: z.string().max(128),
});
const signupWithCodeSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  code: z.string().trim().min(4).max(32),
});
const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(128),
});
const deleteAccountSchema = z.object({
  password: z.string().min(1).max(128),
  confirmation: z.literal('DELETE'),
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

const transferSchema = z.object({
  sku: z.string().trim().min(1).max(100),
  fromShopId: z.coerce.number().int().positive(),
  toShopId: z.coerce.number().int().positive(),
  qty: z.coerce.number().int().positive(),
  occurredAt: z.string().datetime().optional(),
  note: z.string().trim().max(500).optional().default(''),
  staffId: z.coerce.number().int().positive().optional(),
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

// ── Format helpers ────────────────────────────────────────
const DEFAULT_STAFF_PERMS = {
  canViewStock: true,
  canEditStock: false,
  canAddItems: false,
  canDeleteItems: false,
  canViewAllShops: true,
  canSendAnnouncements: false,
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

// ── Shop keys ─────────────────────────────────────────────
// The master code above opens everything. Each shop also gets a key of its
// own, which opens that shop and nothing else. Codes live only in env vars —
// they are never stored in the database and never sent to the browser.
const SHOP_CODES = Object.entries({
  AT: (process.env.SHOP_CODE_AT || '').trim(),
  GD: (process.env.SHOP_CODE_GD || '').trim(),
  RG: (process.env.SHOP_CODE_RG || '').trim(),
}).reduce((acc, [shopCode, secret]) => {
  if (secret) acc[shopCode] = secret;
  return acc;
}, {});

// Which door does this code open? Returns the access level, never the code.
// Compared with timingSafeEqual so a wrong code cannot be narrowed down by
// measuring how long the answer takes.
const safeEqual = (a, b) => {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
};

const resolveAccess = (raw) => {
  const code = typeof raw === 'string' ? raw.trim() : '';
  if (!code) return ACCESS_CODE ? null : { role: 'admin', shopCode: null };
  // The master code wins: if someone reuses it as a shop key, they still get
  // the full account rather than being silently downgraded.
  if (accessOk(code)) return { role: 'admin', shopCode: null };
  for (const [shopCode, secret] of Object.entries(SHOP_CODES)) {
    if (safeEqual(code, secret)) return { role: 'shop', shopCode };
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
    req.accessRole = decoded.accessRole === 'shop' ? 'shop' : 'admin';
    req.scopeShopId = null;
    if (req.accessRole === 'shop') {
      // The key must still name a live shop. If the shop was renamed away or
      // deleted, the key opens nothing rather than opening everything.
      if (!decoded.shopCode || !SHOP_CODES[decoded.shopCode]) {
        return res.status(401).json({ error: 'This shop key is no longer valid' });
      }
      const { rows } = await pool.query(
        'SELECT id FROM shops WHERE business_id=$1 AND code=$2',
        [decoded.businessId, decoded.shopCode]
      );
      if (!rows.length) {
        return res.status(403).json({ error: 'This shop key is not linked to a shop yet' });
      }
      req.scopeShopId = rows[0].id;
    }
    next();
  } catch (err) {
    res.status(401).json({ error: 'Invalid token' });
  }
};

const requireOwner = (req, res, next) => {
  if (req.user.role !== 'owner') {
    return res.status(403).json({ error: 'Owner access required' });
  }
  next();
};

// Everything a shop key must not see: business-wide figures, other shops'
// stock, reports, and anything that changes who can get in.
const requireAdmin = (req, res, next) => {
  if (req.accessRole !== 'admin') {
    return res.status(403).json({ error: 'Only the master code can do that' });
  }
  next();
};

// Guard for routes that act on one named shop. A shop key may only ever name
// its own shop; the master code may name any of them.
const shopAllowed = (req, shopId) =>
  req.accessRole === 'admin' || Number(shopId) === Number(req.scopeShopId);

const denyShop = (res) =>
  res.status(403).json({ error: 'This code only works for its own shop' });

const makeToken = (user, access = { role: 'admin', shopCode: null }) => jwt.sign(
  {
    id: user.id,
    email: user.email,
    role: user.role,
    businessId: user.business_id,
    accessRole: access.role,
    shopCode: access.shopCode,
    jti: crypto.randomBytes(16).toString('hex'),
  },
  JWT_SECRET,
  { expiresIn: '12h' }
);

const genCode = () => {
  // 6-char alphanumeric, uppercase, no ambiguous chars (no 0/O/I/1)
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[crypto.randomInt(0, chars.length)];
  }
  return code;
};

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

    CREATE TABLE IF NOT EXISTS invite_codes (
      id           SERIAL PRIMARY KEY,
      business_id  INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      code         TEXT UNIQUE NOT NULL,
      created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
      expires_at   TIMESTAMPTZ NOT NULL,
      used_at      TIMESTAMPTZ,
      used_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at   TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS announcements (
      id           SERIAL PRIMARY KEY,
      business_id  INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      author_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
      body         TEXT NOT NULL,
      created_at   TIMESTAMPTZ DEFAULT NOW()
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

    CREATE TABLE IF NOT EXISTS email_verification_tokens (
      token        TEXT PRIMARY KEY,
      user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at   TIMESTAMPTZ NOT NULL,
      used_at      TIMESTAMPTZ,
      created_at   TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      token        TEXT PRIMARY KEY,
      user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at   TIMESTAMPTZ NOT NULL,
      used_at      TIMESTAMPTZ,
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

  // Two-letter key that ties a shop to its own access code (AT / GD / RG).
  // Null means the location has no shop key of its own — the office, which
  // only the master code can reach.
  await pool.query(`ALTER TABLE shops ADD COLUMN IF NOT EXISTS code TEXT`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_shops_code ON shops(business_id, code) WHERE code IS NOT NULL`);

  // Stock in transit. A transfer leaves the sending shop immediately — the
  // pieces are physically in a bag — but does NOT land on the receiving
  // shop's shelf until someone there counts them and approves. Until then it
  // belongs to neither shelf, which is why it needs a row of its own rather
  // than a pair of movements.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS transfers (
      id                  SERIAL PRIMARY KEY,
      business_id         INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      from_shop_id        INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
      to_shop_id          INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
      sku                 TEXT NOT NULL,
      item_name           TEXT DEFAULT '',
      qty                 INTEGER NOT NULL,
      status              TEXT NOT NULL DEFAULT 'pending',
      note                TEXT DEFAULT '',
      sent_by_staff_id    INTEGER REFERENCES staff(id) ON DELETE SET NULL,
      sent_by_staff_name  TEXT DEFAULT '',
      decided_by_staff_id INTEGER REFERENCES staff(id) ON DELETE SET NULL,
      decided_by_staff_name TEXT DEFAULT '',
      decided_at          TIMESTAMPTZ,
      decision_note       TEXT DEFAULT '',
      received_qty        INTEGER,
      occurred_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

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
    ALTER TABLE email_verification_tokens ADD COLUMN IF NOT EXISTS code TEXT;
    ALTER TABLE email_verification_tokens ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE password_reset_tokens ADD COLUMN IF NOT EXISTS code TEXT;
    ALTER TABLE password_reset_tokens ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0;
  `);

  // Indexes
  const indexes = [
    `CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)`,
    `CREATE INDEX IF NOT EXISTS idx_users_business_id ON users(business_id)`,
    `CREATE INDEX IF NOT EXISTS idx_businesses_owner_id ON businesses(owner_id)`,
    `CREATE INDEX IF NOT EXISTS idx_shops_business_id ON shops(business_id)`,
    `CREATE INDEX IF NOT EXISTS idx_stock_shop_id ON stock_items(shop_id)`,
    `CREATE INDEX IF NOT EXISTS idx_stock_name ON stock_items(name)`,
    `CREATE INDEX IF NOT EXISTS idx_invite_business_id ON invite_codes(business_id)`,
    `CREATE INDEX IF NOT EXISTS idx_invite_code ON invite_codes(code)`,
    `CREATE INDEX IF NOT EXISTS idx_invite_expires ON invite_codes(expires_at)`,
    `CREATE INDEX IF NOT EXISTS idx_announcements_business_id ON announcements(business_id)`,
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
    `CREATE INDEX IF NOT EXISTS idx_verify_user ON email_verification_tokens(user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_verify_expires ON email_verification_tokens(expires_at)`,
    `CREATE INDEX IF NOT EXISTS idx_reset_user ON password_reset_tokens(user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_reset_expires ON password_reset_tokens(expires_at)`,
  ];
  for (const q of indexes) {
    try { await pool.query(q); } catch (e) { logger.warn('index.skipped', { err: e.message }); }
  }

  // Cleanup expired blacklist + verification + reset tokens hourly
  setInterval(() => {
    pool.query('DELETE FROM token_blacklist WHERE expires_at < NOW()')
      .catch(err => logger.error('blacklist.cleanup.error', { err: err.message }));
    pool.query('DELETE FROM email_verification_tokens WHERE expires_at < NOW()')
      .catch(err => logger.error('verify.cleanup.error', { err: err.message }));
    pool.query('DELETE FROM password_reset_tokens WHERE expires_at < NOW()')
      .catch(err => logger.error('reset.cleanup.error', { err: err.message }));
  }, 60 * 60 * 1000);

  logger.info('db.ready');
}

// ── Health ────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', app: 'mitrasamadi' }));

// ── Auth: check the shared site access code (front-door gate) ──
app.post('/api/auth/verify-access', authLimiter, validate(accessSchema), (req, res) => {
  res.json({ ok: accessOk(req.body.code) });
});

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

// ── Auth: code-only login → master account, or one shop ──
// One field, one code. Which code you type decides what you can reach: the
// master code opens the whole business, a shop key opens only that shop.
app.post('/api/auth/access-login', authLimiter, validate(accessSchema), async (req, res) => {
  const access = resolveAccess(req.body.code);
  if (!access) {
    return res.status(403).json({ error: 'Invalid access code' });
  }
  const client = await pool.connect();
  try {
    const { masterUser, biz } = await ensureMasterAccount(client);

    let scopeShop = null;
    if (access.role === 'shop') {
      const { rows } = await client.query(
        'SELECT id, name, code FROM shops WHERE business_id=$1 AND code=$2',
        [biz.id, access.shopCode]
      );
      if (!rows.length) {
        return res.status(403).json({ error: 'This shop key is not linked to a shop yet' });
      }
      scopeShop = rows[0];
    }

    res.json({
      token: makeToken(masterUser, access),
      user: formatUser(masterUser, access),
      business: { id: biz.id, name: biz.name },
      scope: scopeShop ? { shopId: scopeShop.id, shopName: scopeShop.name, shopCode: scopeShop.code } : null,
    });
  } catch (err) {
    logger.error('access-login.error', { err: err.message });
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// ── Auth: Signup as owner (creates business) ──────────────
app.post('/api/auth/signup', authLimiter, validate(signupSchema), async (req, res) => {
  const client = await pool.connect();
  try {
    const { email, password, businessName, accessCode } = req.body;
    if (!accessOk(accessCode)) {
      return res.status(403).json({ error: 'Invalid access code' });
    }
    await client.query('BEGIN');
    const existing = await client.query('SELECT id FROM users WHERE email=$1', [email]);
    if (existing.rowCount) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Email already registered' });
    }
    const hash = await bcrypt.hash(password, 10);
    const userResult = await client.query(
      `INSERT INTO users (email, password_hash, role, trial_started_at, trial_ends_at, subscription_status)
       VALUES ($1,$2,'owner',NOW(),NULL,'active') RETURNING *`,
      [email, hash]
    );
    const user = userResult.rows[0];
    const bizResult = await client.query(
      `INSERT INTO businesses (name, owner_id) VALUES ($1, $2) RETURNING *`,
      [businessName, user.id]
    );
    const business = bizResult.rows[0];
    const finalUser = (await client.query(
      `UPDATE users SET business_id=$1 WHERE id=$2 RETURNING *`,
      [business.id, user.id]
    )).rows[0];
    await client.query('COMMIT');
    logger.info('user.signup.owner', { userId: finalUser.id, email });
    // Fire-and-forget verification email (does not block response)
    issueVerificationEmail(finalUser.id, finalUser.email).catch(err =>
      logger.error('signup.verify-email.error', { err: err.message, userId: finalUser.id })
    );
    res.status(201).json({
      token: makeToken(finalUser),
      user: formatUser(finalUser),
      business: { id: business.id, name: business.name },
      trial: trialInfo(finalUser),
    });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('signup.error', { err: err.message, stack: err.stack });
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// ── Auth: Signup as staff via invite code ─────────────────
app.post('/api/auth/signup-with-code', authLimiter, validate(signupWithCodeSchema), async (req, res) => {
  const client = await pool.connect();
  try {
    const { email, password, code } = req.body;
    await client.query('BEGIN');
    // Validate invite
    const inviteResult = await client.query(
      `SELECT * FROM invite_codes
       WHERE UPPER(code)=UPPER($1) AND used_at IS NULL AND expires_at > NOW()`,
      [code]
    );
    if (!inviteResult.rowCount) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Invalid or expired invite code' });
    }
    const invite = inviteResult.rows[0];
    // Check email not taken
    const existing = await client.query('SELECT id FROM users WHERE email=$1', [email]);
    if (existing.rowCount) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Email already registered' });
    }
    // Create staff user
    const hash = await bcrypt.hash(password, 10);
    const userResult = await client.query(
      `INSERT INTO users (email, password_hash, role, business_id, permissions, subscription_status)
       VALUES ($1, $2, 'staff', $3, $4, 'active') RETURNING *`,
      [email, hash, invite.business_id, JSON.stringify(DEFAULT_STAFF_PERMS)]
    );
    const user = userResult.rows[0];
    // Mark invite used
    await client.query(
      `UPDATE invite_codes SET used_at=NOW(), used_by=$1 WHERE id=$2`,
      [user.id, invite.id]
    );
    // Get business for response
    const bizResult = await client.query('SELECT * FROM businesses WHERE id=$1', [invite.business_id]);
    await client.query('COMMIT');
    logger.info('user.signup.staff', { userId: user.id, businessId: invite.business_id, email });
    issueVerificationEmail(user.id, user.email).catch(err =>
      logger.error('signup-code.verify-email.error', { err: err.message, userId: user.id })
    );
    res.status(201).json({
      token: makeToken(user),
      user: formatUser(user),
      business: bizResult.rows[0] ? { id: bizResult.rows[0].id, name: bizResult.rows[0].name } : null,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('signup-code.error', { err: err.message, stack: err.stack });
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// ── Auth: Login ───────────────────────────────────────────
const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MINUTES = 15;

app.post('/api/auth/login', authLimiter, validate(loginSchema), async (req, res) => {
  try {
    const { email, password } = req.body;
    const { rows } = await pool.query('SELECT * FROM users WHERE email=$1', [email]);
    if (!rows.length) {
      await bcrypt.compare(password, '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalid');
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    const user = rows[0];
    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      return res.status(423).json({ error: 'Account temporarily locked. Try again later.' });
    }
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      const attempts = (user.failed_login_attempts || 0) + 1;
      const shouldLock = attempts >= MAX_FAILED_LOGINS;
      const lockedUntil = shouldLock ? new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000) : null;
      await pool.query(
        'UPDATE users SET failed_login_attempts=$1, locked_until=$2 WHERE id=$3',
        [shouldLock ? 0 : attempts, lockedUntil, user.id]
      );
      if (shouldLock) {
        return res.status(423).json({ error: 'Too many failed attempts. Account locked for 15 minutes.' });
      }
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    if (user.failed_login_attempts > 0 || user.locked_until) {
      await pool.query('UPDATE users SET failed_login_attempts=0, locked_until=NULL WHERE id=$1', [user.id]);
    }
    let business = null;
    if (user.business_id) {
      const b = await pool.query('SELECT * FROM businesses WHERE id=$1', [user.business_id]);
      if (b.rows[0]) business = { id: b.rows[0].id, name: b.rows[0].name };
    }
    res.json({
      token: makeToken(user),
      user: formatUser(user),
      business,
      trial: trialInfo(user),
    });
  } catch (err) {
    logger.error('login.error', { err: err.message });
    res.status(500).json({ error: 'Internal server error' });
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
    // Carry the session's access level through a page reload, so a shop key
    // does not come back as the master account.
    const access = { role: req.accessRole, shopCode: req.user.shopCode || null };
    let scope = null;
    if (req.accessRole === 'shop' && req.scopeShopId) {
      const s = await pool.query('SELECT id, name, code FROM shops WHERE id=$1', [req.scopeShopId]);
      if (s.rows[0]) scope = { shopId: s.rows[0].id, shopName: s.rows[0].name, shopCode: s.rows[0].code };
    }
    res.json({ user: formatUser(rows[0], access), business, scope, trial: trialInfo(rows[0]) });
  } catch (err) {
    logger.error('me.error', { err: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Auth: Email verification & password reset (6-digit codes) ──
const forgotSchema = z.object({
  email: emailSchema,
});
const resetWithCodeSchema = z.object({
  email: emailSchema,
  code: z.string().trim().regex(/^\d{6}$/, 'Code must be 6 digits'),
  password: passwordSchema,
});
const verifyCodeSchema = z.object({
  code: z.string().trim().regex(/^\d{6}$/, 'Code must be 6 digits'),
});

const gen6Digit = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');

function codeEmailHtml({ heading, intro, code, ttlMinutes }) {
  return `<!doctype html>
<html><body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; background:#f5f7fa; padding:24px;">
<div style="max-width:480px; margin:0 auto; background:white; border-radius:14px; padding:32px; box-shadow:0 1px 3px rgba(0,0,0,0.06);">
  <h1 style="color:#1e3a5f; font-size:24px; margin:0 0 12px;">${heading}</h1>
  <p style="font-size:15px; color:#444; line-height:1.5; margin:0 0 24px;">${intro}</p>
  <div style="background:#f5f7fa; border:2px solid #e0e4eb; border-radius:12px; padding:24px; text-align:center; margin-bottom:24px;">
    <div style="font-size:13px; color:#666; text-transform:uppercase; letter-spacing:1px; margin-bottom:10px;">Your code</div>
    <div style="font-size:42px; font-weight:700; color:#1e3a5f; letter-spacing:10px; font-family: 'SF Mono', Menlo, monospace;">${code}</div>
  </div>
  <p style="font-size:13px; color:#666; line-height:1.5; margin:0;">This code expires in ${ttlMinutes} minutes. If you didn't request it, you can ignore this email.</p>
</div>
</body></html>`;
}

async function issueVerificationEmail(userId, email) {
  // Invalidate previous pending codes for this user
  await pool.query(
    `UPDATE email_verification_tokens SET used_at=NOW() WHERE user_id=$1 AND used_at IS NULL`,
    [userId]
  );
  const code = gen6Digit();
  const token = crypto.randomBytes(16).toString('hex'); // satisfies PK uniqueness
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 min
  await pool.query(
    `INSERT INTO email_verification_tokens (token, code, user_id, expires_at) VALUES ($1,$2,$3,$4)`,
    [token, code, userId, expiresAt]
  );
  await sendEmail({
    to: email,
    subject: `${code} is your Mitra Samadi verification code`,
    html: codeEmailHtml({
      heading: 'Verify your email',
      intro: 'Welcome to Mitra Samadi! Enter this code in the app to confirm your email address.',
      code,
      ttlMinutes: 15,
    }),
    text: `Your Mitra Samadi verification code: ${code}\n\nExpires in 15 minutes.`,
  });
  return code;
}

// Resend verification code (authed)
app.post('/api/auth/send-verification', auth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id, email, email_verified FROM users WHERE id=$1', [req.user.id]);
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    if (rows[0].email_verified) return res.json({ ok: true, alreadyVerified: true });
    await issueVerificationEmail(rows[0].id, rows[0].email);
    res.json({ ok: true });
  } catch (err) {
    logger.error('verify.send.error', { err: err.message });
    res.status(500).json({ error: 'Could not send verification email' });
  }
});

// Verify code (authed — uses the current user's pending code)
app.post('/api/auth/verify-code', auth, validate(verifyCodeSchema), async (req, res) => {
  const client = await pool.connect();
  try {
    const code = req.body.code;
    const { rows: userRows } = await client.query('SELECT email_verified FROM users WHERE id=$1', [req.user.id]);
    if (!userRows.length) return res.status(404).json({ error: 'User not found' });
    if (userRows[0].email_verified) return res.json({ ok: true, alreadyVerified: true });

    const { rows } = await client.query(
      `SELECT * FROM email_verification_tokens
       WHERE user_id=$1 AND used_at IS NULL
       ORDER BY created_at DESC LIMIT 1`,
      [req.user.id]
    );
    if (!rows.length) return res.status(400).json({ error: 'No active code. Tap Resend.' });
    const t = rows[0];
    if (new Date(t.expires_at) < new Date()) {
      return res.status(400).json({ error: 'Code expired. Tap Resend for a new one.' });
    }
    if ((t.attempts || 0) >= 5) {
      return res.status(429).json({ error: 'Too many wrong attempts. Tap Resend for a new code.' });
    }
    if (t.code !== code) {
      await client.query(`UPDATE email_verification_tokens SET attempts=attempts+1 WHERE token=$1`, [t.token]);
      return res.status(400).json({ error: 'Wrong code. Try again.' });
    }
    await client.query('BEGIN');
    await client.query(`UPDATE users SET email_verified=TRUE WHERE id=$1`, [req.user.id]);
    await client.query(`UPDATE email_verification_tokens SET used_at=NOW() WHERE token=$1`, [t.token]);
    await client.query('COMMIT');
    logger.info('verify.success', { userId: req.user.id });
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('verify.code.error', { err: err.message });
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// Forgot password — emails a 6-digit reset code. Always returns 200.
app.post('/api/auth/forgot-password', authLimiter, validate(forgotSchema), async (req, res) => {
  try {
    const { email } = req.body;
    const { rows } = await pool.query('SELECT id, email FROM users WHERE email=$1', [email]);
    if (rows.length) {
      const user = rows[0];
      // Invalidate previous codes
      await pool.query(
        `UPDATE password_reset_tokens SET used_at=NOW() WHERE user_id=$1 AND used_at IS NULL`,
        [user.id]
      );
      const code = gen6Digit();
      const token = crypto.randomBytes(16).toString('hex');
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 min
      await pool.query(
        `INSERT INTO password_reset_tokens (token, code, user_id, expires_at) VALUES ($1,$2,$3,$4)`,
        [token, code, user.id, expiresAt]
      );
      try {
        await sendEmail({
          to: user.email,
          subject: `${code} is your Mitra Samadi reset code`,
          html: codeEmailHtml({
            heading: 'Reset your password',
            intro: 'Enter this code in the app to set a new password.',
            code,
            ttlMinutes: 15,
          }),
          text: `Your Mitra Samadi password reset code: ${code}\n\nExpires in 15 minutes. If you didn't request this, ignore this email.`,
        });
      } catch (err) {
        logger.error('forgot.send.error', { err: err.message, userId: user.id });
      }
      logger.info('forgot.issued', { userId: user.id });
    } else {
      logger.info('forgot.unknown-email', { email });
    }
    res.json({ ok: true });
  } catch (err) {
    logger.error('forgot.error', { err: err.message });
    res.json({ ok: true });
  }
});

// Reset password using the 6-digit code that was emailed
app.post('/api/auth/reset-password', authLimiter, validate(resetWithCodeSchema), async (req, res) => {
  const client = await pool.connect();
  try {
    const { email, code, password } = req.body;
    const userR = await client.query('SELECT id FROM users WHERE email=$1', [email]);
    if (!userR.rows.length) return res.status(400).json({ error: 'Wrong code or email' });
    const userId = userR.rows[0].id;
    const { rows } = await client.query(
      `SELECT * FROM password_reset_tokens
       WHERE user_id=$1 AND used_at IS NULL
       ORDER BY created_at DESC LIMIT 1`,
      [userId]
    );
    if (!rows.length) return res.status(400).json({ error: 'No active reset code. Request a new one.' });
    const t = rows[0];
    if (new Date(t.expires_at) < new Date()) {
      return res.status(400).json({ error: 'Code expired. Request a new one.' });
    }
    if ((t.attempts || 0) >= 5) {
      return res.status(429).json({ error: 'Too many wrong attempts. Request a new code.' });
    }
    if (t.code !== code) {
      await client.query(`UPDATE password_reset_tokens SET attempts=attempts+1 WHERE token=$1`, [t.token]);
      return res.status(400).json({ error: 'Wrong code or email' });
    }
    const hash = await bcrypt.hash(password, 10);
    await client.query('BEGIN');
    await client.query(
      `UPDATE users SET password_hash=$1, failed_login_attempts=0, locked_until=NULL WHERE id=$2`,
      [hash, userId]
    );
    await client.query(`UPDATE password_reset_tokens SET used_at=NOW() WHERE token=$1`, [t.token]);
    await client.query(
      `UPDATE password_reset_tokens SET used_at=NOW() WHERE user_id=$1 AND used_at IS NULL`,
      [userId]
    );
    await client.query('COMMIT');
    logger.info('reset.success', { userId });
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('reset.error', { err: err.message });
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// ── Auth: Logout ──────────────────────────────────────────
app.post('/api/auth/logout', auth, async (req, res) => {
  try {
    if (req.user.jti && req.user.exp) {
      const expiresAt = new Date(req.user.exp * 1000);
      await pool.query(
        `INSERT INTO token_blacklist (jti, user_id, expires_at) VALUES ($1,$2,$3) ON CONFLICT (jti) DO NOTHING`,
        [req.user.jti, req.user.id, expiresAt]
      );
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Auth: Delete account (GDPR) ───────────────────────────
app.delete('/api/auth/account', auth, requireAdmin, validate(deleteAccountSchema), async (req, res) => {
  try {
    const { password } = req.body;
    const { rows } = await pool.query('SELECT id, password_hash, role, business_id FROM users WHERE id=$1', [req.user.id]);
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    const valid = await bcrypt.compare(password, rows[0].password_hash);
    if (!valid) return res.status(401).json({ error: 'Incorrect password' });

    // Owner deletion cascades to business → shops → stock → staff users? No, staff users not deleted.
    // Cleaner: if owner, delete business (cascades stock/invites). Set staff users.business_id = NULL.
    if (rows[0].role === 'owner' && rows[0].business_id) {
      await pool.query('UPDATE users SET business_id=NULL WHERE business_id=$1 AND id != $2', [rows[0].business_id, rows[0].id]);
      await pool.query('DELETE FROM businesses WHERE id=$1', [rows[0].business_id]);
    }
    await pool.query('DELETE FROM users WHERE id=$1', [req.user.id]);
    logger.info('account.deleted', { userId: req.user.id });
    res.json({ ok: true });
  } catch (err) {
    logger.error('delete.error', { err: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Auth: Export data (GDPR) ──────────────────────────────
app.get('/api/auth/export-data', auth, requireAdmin, async (req, res) => {
  try {
    const userId = req.user.id;
    const businessId = req.user.businessId;
    const [user, business, shops, stock, invites] = await Promise.all([
      pool.query('SELECT id, email, role, business_id, trial_started_at, trial_ends_at, subscription_status, created_at FROM users WHERE id=$1', [userId]),
      businessId ? pool.query('SELECT * FROM businesses WHERE id=$1', [businessId]) : { rows: [] },
      businessId ? pool.query('SELECT * FROM shops WHERE business_id=$1', [businessId]) : { rows: [] },
      businessId ? pool.query('SELECT s.* FROM stock_items s JOIN shops sh ON sh.id=s.shop_id WHERE sh.business_id=$1', [businessId]) : { rows: [] },
      businessId ? pool.query('SELECT * FROM invite_codes WHERE business_id=$1', [businessId]) : { rows: [] },
    ]);
    res.setHeader('Content-Disposition', `attachment; filename="mitra-samadi-data-${userId}-${Date.now()}.json"`);
    res.json({
      exportedAt: new Date().toISOString(),
      user: user.rows[0] || null,
      business: business.rows[0] || null,
      shops: shops.rows,
      stockItems: stock.rows,
      inviteCodes: invites.rows,
    });
  } catch (err) {
    logger.error('export.error', { err: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});


// Routes addressed as /api/shops/:shopId/... — a shop key may only name its own.
const scopedShop = (req, res, next) => {
  if (!shopAllowed(req, req.params.shopId)) return denyShop(res);
  next();
};

// Routes addressed by stock item id. The shop is not in the URL, so it has to
// be read from the row before we can tell whether this key may touch it.
const scopedItem = async (req, res, next) => {
  if (req.accessRole === 'admin') return next();
  try {
    const { rows } = await pool.query('SELECT shop_id FROM stock_items WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Item not found' });
    if (Number(rows[0].shop_id) !== Number(req.scopeShopId)) return denyShop(res);
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

app.post('/api/shops', auth, requireAdmin, requireOwner, validate(shopSchema), async (req, res) => {
  try {
    if (!req.user.businessId) return res.status(400).json({ error: 'No business' });
    const { name, address, code } = req.body;
    const { rows } = await pool.query(
      `INSERT INTO shops (business_id, name, address, code) VALUES ($1, $2, $3, $4) RETURNING *`,
      [req.user.businessId, name, address || '', code || null]
    );
    res.status(201).json(formatShop(rows[0]));
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Another shop already uses that key' });
    logger.error('shops.create.error', { err: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.put('/api/shops/:id', auth, requireAdmin, requireOwner, validate(shopSchema), async (req, res) => {
  try {
    const { name, address, code } = req.body;
    const { rows } = await pool.query(
      `UPDATE shops SET name=$1, address=$2, code=$3 WHERE id=$4 AND business_id=$5 RETURNING *`,
      [name, address || '', code || null, req.params.id, req.user.businessId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Shop not found' });
    res.json(formatShop(rows[0]));
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Another shop already uses that key' });
    logger.error('shops.update.error', { err: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/shops/:id', auth, requireAdmin, requireOwner, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `DELETE FROM shops WHERE id=$1 AND business_id=$2 RETURNING id`,
      [req.params.id, req.user.businessId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Shop not found' });
    res.json({ ok: true });
  } catch (err) {
    logger.error('shops.delete.error', { err: err.message });
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
      return res.status(200).json(formatStaff(rows[0]));
    }
    const { rows } = await pool.query(
      'INSERT INTO staff (business_id, shop_id, name, commission_rate) VALUES ($1,$2,$3,$4) RETURNING *',
      [req.user.businessId, shopId || null, name, rate || 0]
    );
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
    const { rowCount } = await pool.query(
      'UPDATE staff SET active=FALSE WHERE id=$1 AND business_id=$2',
      [req.params.id, req.user.businessId]
    );
    if (!rowCount) return res.status(404).json({ error: 'Staff member not found' });
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
const SALE_TYPES_SQL = "m.type IN ('sale', 'out') AND m.qty_change < 0";

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

// Best sellers across the business, for a calendar year or a rolling window.
// A "sale" is a barcode/manual sell (type 'sale') or a logged sell-out ('out').
// Trend compares the chosen window against the one immediately before it.
app.get('/api/business/best-sellers', auth, requireAdmin, async (req, res) => {
  try {
    const businessId = req.user.businessId;
    if (!businessId) return res.status(400).json({ error: 'No business associated with user' });

    const groupBy = BEST_SELLER_KEYS[req.query.groupBy] ? req.query.groupBy : 'sku';
    const { key: keyExpr, label: labelExpr } = BEST_SELLER_KEYS[groupBy];
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 10));
    const shopIds = parseShopIds(req.query.shops);

    // Either a calendar year ("what sold in 2025") or a rolling window of days.
    let start, end, prevStart, windowLabel;
    if (req.query.year) {
      const yr = yearRange(req.query.year);
      if (yr.year === 'all') {
        start = new Date(Date.UTC(2000, 0, 1));
        end = new Date(Date.UTC(2100, 0, 1));
        prevStart = start;               // nothing earlier to compare against
      } else {
        start = yr.start;
        end = yr.end;
        prevStart = new Date(Date.UTC(yr.year - 1, 0, 1));
      }
      windowLabel = { year: yr.year };
    } else {
      const days = Math.min(3650, Math.max(1, parseInt(req.query.days, 10) || 365));
      end = new Date();
      start = new Date(end.getTime() - days * 86400000);
      prevStart = new Date(end.getTime() - days * 2 * 86400000);
      windowLabel = { days };
    }

    const params = [businessId, start, prevStart, limit, end];
    let scope = '';
    if (shopIds) {
      params.push(shopIds);
      scope = ` AND s.id = ANY($${params.length}::int[])`;
    }

    const sql = `
      WITH sales AS (
        SELECT si.sku, si.name, si.category, si.fabric, si.color, si.size,
               COALESCE(si.price, 0) AS price,
               s.name AS shop_name,
               COALESCE(m.staff_name, '') AS staff_name,
               m.occurred_at, -m.qty_change AS units
        FROM stock_movements m
        JOIN stock_items si ON si.id = m.item_id
        JOIN shops s ON s.id = si.shop_id
        WHERE s.business_id = $1
          AND ${SALE_TYPES_SQL}
          AND m.occurred_at >= $3
          AND m.occurred_at <  $5
          ${scope}
      ),
      current AS (
        SELECT ${keyExpr} AS group_key,
               ${labelExpr}     AS label,
               MIN(sa.name)     AS name,
               MIN(sa.sku)      AS sku,
               MIN(sa.category) AS style,
               MIN(sa.fabric)   AS fabric,
               MIN(sa.color)    AS color,
               MIN(sa.size)     AS size,
               SUM(sa.units)::int AS units,
               SUM(sa.units * sa.price)::float8 AS revenue
        FROM sales sa
        WHERE sa.occurred_at >= $2 AND ${keyExpr} IS NOT NULL
        GROUP BY ${keyExpr}
      ),
      previous AS (
        SELECT ${keyExpr} AS group_key, SUM(sa.units)::int AS units
        FROM sales sa
        WHERE sa.occurred_at < $2 AND ${keyExpr} IS NOT NULL
        GROUP BY ${keyExpr}
      )
      SELECT c.*, COALESCE(p.units, 0) AS prev_units
      FROM current c
      LEFT JOIN previous p ON p.group_key = c.group_key
      ORDER BY c.units DESC, c.revenue DESC
      LIMIT $4
    `;
    const { rows } = await pool.query(sql, params);

    res.json({
      ...windowLabel,
      groupBy,
      items: rows.map(r => {
        const units = Number(r.units) || 0;
        const prev = Number(r.prev_units) || 0;
        return {
          key: r.group_key,
          label: r.label || '—',
          sku: r.sku || '',
          name: r.name || '',
          style: r.style || '',
          fabric: r.fabric || '',
          color: r.color || '',
          size: r.size || '',
          units,
          revenue: Number(r.revenue) || 0,
          prevUnits: prev,
          // null when there is nothing to compare against yet.
          trend: prev === 0 ? (units > 0 ? null : 0) : (units - prev) / prev,
        };
      }),
    });
  } catch (err) {
    logger.error('business.bestsellers.error', { err: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

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

// The most recent sales, newest first — "what sold, when, and where".
app.get('/api/business/recent-sales', auth, requireAdmin, async (req, res) => {
  try {
    const businessId = req.user.businessId;
    if (!businessId) return res.status(400).json({ error: 'No business associated with user' });

    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
    const { start, end } = yearRange(req.query.year || 'all');
    const shopIds = parseShopIds(req.query.shops);

    const params = [businessId];
    let where = `WHERE s.business_id = $1 AND ${SALE_TYPES_SQL}`;
    if (start) {
      params.push(start, end);
      where += ` AND m.occurred_at >= $${params.length - 1} AND m.occurred_at < $${params.length}`;
    }
    if (shopIds) {
      params.push(shopIds);
      where += ` AND s.id = ANY($${params.length}::int[])`;
    }
    params.push(limit);

    const { rows } = await pool.query(
      `SELECT m.id, m.occurred_at, m.note, -m.qty_change AS units,
              si.name, si.sku, si.category, si.fabric, si.color, si.size,
              COALESCE(si.price, 0)::float8 AS price,
              s.name AS shop_name
       FROM stock_movements m
       JOIN stock_items si ON si.id = m.item_id
       JOIN shops s ON s.id = si.shop_id
       ${where}
       ORDER BY m.occurred_at DESC, m.id DESC
       LIMIT $${params.length}`,
      params
    );

    res.json(rows.map(r => ({
      id: r.id,
      occurredAt: r.occurred_at,
      units: Number(r.units) || 0,
      name: r.name,
      sku: r.sku || '',
      style: r.category || '',
      fabric: r.fabric || '',
      color: r.color || '',
      size: r.size || '',
      price: Number(r.price) || 0,
      shopName: r.shop_name,
      note: r.note || '',
    })));
  } catch (err) {
    logger.error('business.recentsales.error', { err: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Recent stock activity across every shop — powers the Overview activity feed.
app.get('/api/business/activity', auth, requireAdmin, async (req, res) => {
  try {
    const businessId = req.user.businessId;
    if (!businessId) return res.status(400).json({ error: 'No business associated with user' });
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 15));

    const { rows } = await pool.query(
      `SELECT m.id, m.type, m.qty_change, m.qty_after, m.occurred_at, m.note,
              si.name AS item_name, si.sku, s.name AS shop_name
       FROM stock_movements m
       JOIN stock_items si ON si.id = m.item_id
       JOIN shops s ON s.id = si.shop_id
       WHERE s.business_id = $1
       ORDER BY m.occurred_at DESC
       LIMIT $2`,
      [businessId, limit]
    );

    res.json(rows.map(r => ({
      id: r.id,
      type: r.type,
      qtyChange: r.qty_change,
      qtyAfter: r.qty_after,
      occurredAt: r.occurred_at,
      note: r.note || '',
      itemName: r.item_name,
      sku: r.sku || '',
      shopName: r.shop_name,
    })));
  } catch (err) {
    logger.error('business.activity.error', { err: err.message });
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
      else if (r.type === 'sale' || r.type === 'out') months[key].sold += units;
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

// What each person sold, and what they are owed for it.
// Commission is computed from the rate on the staff row at report time rather
// than stored per sale — if a rate changes, the whole report moves with it,
// which is what "what do I owe Belina this month" actually means.
app.get('/api/business/staff-performance', auth, requireAdmin, async (req, res) => {
  try {
    const businessId = req.user.businessId;
    if (!businessId) return res.status(400).json({ error: 'No business associated with user' });

    const { start, end, year } = yearRange(req.query.year || String(new Date().getFullYear()));
    const month = parseInt(req.query.month, 10);   // 1-12, optional
    const shopIds = parseShopIds(req.query.shops);

    const params = [businessId];
    let where = `WHERE s.business_id = $1 AND ${SALE_TYPES_SQL}`;
    if (start) {
      params.push(start, end);
      where += ` AND m.occurred_at >= $${params.length - 1} AND m.occurred_at < $${params.length}`;
    }
    if (month >= 1 && month <= 12) {
      params.push(month);
      where += ` AND EXTRACT(MONTH FROM m.occurred_at) = $${params.length}`;
    }
    if (shopIds) {
      params.push(shopIds);
      where += ` AND s.id = ANY($${params.length}::int[])`;
    }

    const { rows } = await pool.query(
      `SELECT COALESCE(NULLIF(m.staff_name,''), '(not recorded)') AS name,
              MIN(m.staff_id) AS staff_id,
              SUM(-m.qty_change)::int AS units,
              SUM(-m.qty_change * COALESCE(si.price,0))::numeric AS revenue
       FROM stock_movements m
       JOIN stock_items si ON si.id = m.item_id
       JOIN shops s ON s.id = si.shop_id
       ${where}
       GROUP BY 1
       ORDER BY revenue DESC`,
      params
    );

    const { rows: staffRows } = await pool.query(
      'SELECT id, name, commission_rate FROM staff WHERE business_id=$1',
      [businessId]
    );
    const rateById = new Map(staffRows.map(r => [r.id, Number(r.commission_rate) || 0]));
    const rateByName = new Map(staffRows.map(r => [r.name.toLowerCase(), Number(r.commission_rate) || 0]));

    const items = rows.map(r => {
      const revenue = Number(r.revenue) || 0;
      const rate = r.staff_id != null && rateById.has(r.staff_id)
        ? rateById.get(r.staff_id)
        : (rateByName.get(String(r.name).toLowerCase()) || 0);
      return {
        staffId: r.staff_id,
        name: r.name,
        units: r.units || 0,
        revenue,
        rate,
        commission: Math.round(revenue * rate) / 100,
      };
    });

    res.json({
      year,
      month: month >= 1 && month <= 12 ? month : null,
      items,
      totals: {
        units: items.reduce((n, i) => n + i.units, 0),
        revenue: items.reduce((n, i) => n + i.revenue, 0),
        commission: items.reduce((n, i) => n + i.commission, 0),
      },
    });
  } catch (err) {
    logger.error('business.staffperf.error', { err: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Everything that happened, across every shop, for the last three years.
// One row per movement — sales, stock in, stock out, both legs of a transfer —
// each carrying who did it, how many pieces, and what they were worth.
const HISTORY_TYPES = ['sale', 'out', 'in', 'adjust', 'transfer-in', 'transfer-out'];
const HISTORY_YEARS = 3;

app.get('/api/business/history', auth, requireAdmin, async (req, res) => {
  try {
    const businessId = req.user.businessId;
    if (!businessId) return res.status(400).json({ error: 'No business associated with user' });

    // Three years back from the start of the current year, so "3 years" means
    // three whole calendar years and not a rolling window that drops January.
    const floor = new Date(Date.UTC(new Date().getUTCFullYear() - (HISTORY_YEARS - 1), 0, 1));

    const params = [businessId, floor];
    let where = 'WHERE sh.business_id = $1 AND m.occurred_at >= $2';

    const shopIds = parseShopIds(req.query.shops);
    if (shopIds) {
      params.push(shopIds);
      where += ` AND m.shop_id = ANY($${params.length}::int[])`;
    }
    const type = String(req.query.type || '').trim();
    if (HISTORY_TYPES.includes(type)) {
      params.push(type);
      where += ` AND m.type = $${params.length}`;
    }
    const staffId = parseInt(req.query.staffId, 10);
    if (Number.isInteger(staffId)) {
      params.push(staffId);
      where += ` AND m.staff_id = $${params.length}`;
    }
    const year = parseInt(req.query.year, 10);
    if (Number.isInteger(year)) {
      params.push(year);
      where += ` AND EXTRACT(YEAR FROM m.occurred_at) = $${params.length}`;
    }
    const month = parseInt(req.query.month, 10);
    if (month >= 1 && month <= 12) {
      params.push(month);
      where += ` AND EXTRACT(MONTH FROM m.occurred_at) = $${params.length}`;
    }
    const q = String(req.query.q || '').trim();
    if (q) {
      params.push(`%${q}%`);
      where += ` AND (si.sku ILIKE $${params.length} OR si.name ILIKE $${params.length} OR m.staff_name ILIKE $${params.length})`;
    }

    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    const base = `
      FROM stock_movements m
      JOIN stock_items si ON si.id = m.item_id
      JOIN shops sh ON sh.id = m.shop_id
      ${where}
    `;

    const { rows } = await pool.query(
      `SELECT m.id, m.type, m.qty_change, m.qty_after, m.occurred_at, m.note, m.reason,
              COALESCE(NULLIF(m.staff_name,''), '(not recorded)') AS staff_name,
              m.staff_id, si.sku, si.name AS item_name, si.color, si.size,
              COALESCE(si.price,0) AS price, sh.id AS shop_id, sh.name AS shop_name
       ${base}
       ORDER BY m.occurred_at DESC, m.id DESC
       LIMIT ${limit} OFFSET ${offset}`,
      params
    );

    const { rows: countRows } = await pool.query(`SELECT COUNT(*)::int AS n ${base}`, params);

    res.json({
      total: countRows[0].n,
      limit,
      offset,
      sinceYear: floor.getUTCFullYear(),
      items: rows.map(r => ({
        id: r.id,
        type: r.type,
        qtyChange: r.qty_change,
        qtyAfter: r.qty_after,
        // Only pieces leaving as a sale carry a value; a transfer moves the
        // same garment between shelves and is not money changing hands.
        value: (r.type === 'sale' || r.type === 'out')
          ? Math.abs(r.qty_change) * Number(r.price)
          : 0,
        occurredAt: r.occurred_at,
        note: r.note || '',
        reason: r.reason || '',
        staffId: r.staff_id,
        staffName: r.staff_name,
        sku: r.sku,
        itemName: r.item_name,
        color: r.color || '',
        size: r.size || '',
        price: Number(r.price),
        shopId: r.shop_id,
        shopName: r.shop_name,
      })),
    });
  } catch (err) {
    logger.error('business.history.error', { err: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// One shop's full movement ledger — every date stock arrived and left.
// This is the back-office view, deliberately away from the scanning screens.
app.get('/api/shops/:shopId/ledger', auth, requireAdmin, async (req, res) => {
  try {
    if (!await shopGuard(req.params.shopId, req.user.businessId)) {
      return res.status(404).json({ error: 'Shop not found' });
    }
    const limit = Math.min(1000, Math.max(1, parseInt(req.query.limit, 10) || 300));
    const { start, end } = yearRange(req.query.year || 'all');
    const direction = req.query.direction; // 'in' | 'out' | undefined

    const params = [req.params.shopId];
    let where = 'WHERE m.shop_id = $1';
    if (start) {
      params.push(start, end);
      where += ` AND m.occurred_at >= $${params.length - 1} AND m.occurred_at < $${params.length}`;
    }
    if (direction === 'in') where += ' AND m.qty_change > 0';
    if (direction === 'out') where += ' AND m.qty_change < 0';
    if (req.query.type) {
      params.push(req.query.type);
      where += ` AND m.type = $${params.length}`;
    }
    if (req.query.staffId) {
      params.push(parseInt(req.query.staffId, 10) || 0);
      where += ` AND m.staff_id = $${params.length}`;
    }
    params.push(limit);

    const { rows } = await pool.query(
      `SELECT m.id, m.type, m.qty_change, m.qty_after, m.occurred_at, m.note,
              COALESCE(m.reason,'') AS reason, COALESCE(m.staff_name,'') AS staff_name,
              si.name AS item_name, si.sku, si.fabric, si.color, si.size
       FROM stock_movements m
       JOIN stock_items si ON si.id = m.item_id
       ${where}
       ORDER BY m.occurred_at DESC, m.id DESC
       LIMIT $${params.length}`,
      params
    );

    res.json(rows.map(r => ({
      id: r.id,
      type: r.type,
      qtyChange: r.qty_change,
      qtyAfter: r.qty_after,
      occurredAt: r.occurred_at,
      note: r.note || '',
      reason: r.reason,
      staffName: r.staff_name,
      itemName: r.item_name,
      sku: r.sku || '',
      fabric: r.fabric || '',
      color: r.color || '',
      size: r.size || '',
    })));
  } catch (err) {
    logger.error('shop.ledger.error', { err: err.message });
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
      `INSERT INTO stock_items (shop_id, name, category, fabric, print, size, color, sku, brand, qty, threshold, supplier, notes, position, image_url, price)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
      [req.params.shopId, b.name, b.category, b.fabric, b.print, b.size, b.color, b.sku, b.brand, b.qty, b.threshold, b.supplier, b.notes, newPos, b.imageUrl, b.price]
    );
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
    const { rows } = await pool.query(
      `UPDATE stock_items
       SET name=$1, category=$2, fabric=$3, print=$4, size=$5, color=$6, sku=$7, brand=$8, qty=$9, threshold=$10, supplier=$11, notes=$12, image_url=$13, price=$14, updated_at=NOW()
       WHERE id=$15 RETURNING *`,
      [b.name, b.category, b.fabric, b.print, b.size, b.color, b.sku, b.brand, b.qty, b.threshold, b.supplier, b.notes, b.imageUrl, b.price, req.params.id]
    );
    res.json(formatStock(rows[0]));
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
  sell: { type: 'sale',         dir: -1, label: 'Sold' },
  in:   { type: 'in',           dir: +1, label: 'Stocked in' },
  out:  { type: 'removal',      dir: -1, label: 'Removed' },
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

    // last_sold_at tracks actual selling only — a reject leaving the shop is
    // not the last time this garment sold.
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
    await pool.query(`DELETE FROM stock_items WHERE id=$1`, [req.params.id]);
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

const formatTransfer = (t) => ({
  id: t.id,
  fromShopId: t.from_shop_id,
  fromShopName: t.from_shop_name || '',
  toShopId: t.to_shop_id,
  toShopName: t.to_shop_name || '',
  sku: t.sku,
  itemName: t.item_name || '',
  qty: t.qty,
  status: t.status,
  note: t.note || '',
  sentBy: t.sent_by_staff_name || '',
  decidedBy: t.decided_by_staff_name || '',
  decidedAt: t.decided_at,
  decisionNote: t.decision_note || '',
  receivedQty: t.received_qty,
  occurredAt: t.occurred_at,
  createdAt: t.created_at,
});

const TRANSFER_SELECT = `
  SELECT t.*, fs.name AS from_shop_name, ts.name AS to_shop_name
  FROM transfers t
  JOIN shops fs ON fs.id = t.from_shop_id
  JOIN shops ts ON ts.id = t.to_shop_id
`;

// Transfers this session is allowed to see. A shop key sees only what it sent
// and what is coming to it; the master code sees all of them.
app.get('/api/transfers', auth, async (req, res) => {
  try {
    const params = [req.user.businessId];
    let where = 'WHERE t.business_id = $1';

    if (req.accessRole === 'shop') {
      params.push(req.scopeShopId);
      where += ` AND (t.from_shop_id = $${params.length} OR t.to_shop_id = $${params.length})`;
    }
    const status = String(req.query.status || '').trim();
    if (['pending', 'approved', 'rejected'].includes(status)) {
      params.push(status);
      where += ` AND t.status = $${params.length}`;
    }
    // 'in' = waiting on us to count it, 'out' = we sent it.
    const direction = String(req.query.direction || '').trim();
    if (direction === 'in' || direction === 'out') {
      const col = direction === 'in' ? 't.to_shop_id' : 't.from_shop_id';
      const shopId = req.accessRole === 'shop'
        ? req.scopeShopId
        : parseInt(req.query.shopId, 10);
      if (Number.isInteger(shopId)) {
        params.push(shopId);
        where += ` AND ${col} = $${params.length}`;
      }
    }

    const limit = Math.min(parseInt(req.query.limit, 10) || 200, 500);
    const { rows } = await pool.query(
      `${TRANSFER_SELECT} ${where}
       ORDER BY CASE WHEN t.status='pending' THEN 0 ELSE 1 END, t.occurred_at DESC, t.id DESC
       LIMIT ${limit}`,
      params
    );
    res.json(rows.map(formatTransfer));
  } catch (err) {
    logger.error('transfers.list.error', { err: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Count it in. Only now does the receiving shop's stock move — and only by
// the quantity actually counted, which may be short of what was sent.
app.post('/api/transfers/:id/approve', auth, async (req, res) => {
  const client = await pool.connect();
  try {
    const staff = await resolveStaff(req.body.staffId, req.user.businessId);
    await client.query('BEGIN');

    const { rows } = await client.query(
      'SELECT * FROM transfers WHERE id=$1 AND business_id=$2 FOR UPDATE',
      [req.params.id, req.user.businessId]
    );
    if (!rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Transfer not found' });
    }
    const t = rows[0];
    // Only the shop the stock is going TO may accept it. The office cannot
    // sign for its own delivery.
    if (!shopAllowed(req, t.to_shop_id)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Only the receiving shop can approve this transfer' });
    }
    if (t.status !== 'pending') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `This transfer was already ${t.status}` });
    }

    // Short deliveries are the normal case worth recording: five sent, four
    // arrived. Whatever is missing stays missing rather than being invented.
    const askedQty = req.body.receivedQty;
    const receivedQty = askedQty === undefined || askedQty === null || askedQty === ''
      ? t.qty
      : parseInt(askedQty, 10);
    if (!Number.isInteger(receivedQty) || receivedQty < 0 || receivedQty > t.qty) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Received quantity must be between 0 and ${t.qty}` });
    }

    // Find or create the destination row.
    const { rows: toRows } = await client.query(
      'SELECT * FROM stock_items WHERE shop_id=$1 AND sku=$2 FOR UPDATE',
      [t.to_shop_id, t.sku]
    );
    let dstItem = toRows[0];
    if (!dstItem) {
      const { rows: src } = await client.query(
        'SELECT * FROM stock_items WHERE shop_id=$1 AND sku=$2 LIMIT 1',
        [t.from_shop_id, t.sku]
      );
      const proto = src[0] || {};
      const { rows: posRows } = await client.query(
        'SELECT COALESCE(MAX(position), -1) + 1 AS p FROM stock_items WHERE shop_id=$1',
        [t.to_shop_id]
      );
      const { rows: created } = await client.query(
        `INSERT INTO stock_items (shop_id, name, category, fabric, print, size, color, sku, brand, qty, threshold, supplier, notes, position, image_url, price)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,0,$10,$11,$12,$13,$14,$15) RETURNING *`,
        [t.to_shop_id, proto.name || t.item_name, proto.category || '', proto.fabric || '', proto.print || '',
         proto.size || '', proto.color || '', t.sku, proto.brand || '', proto.threshold || 0,
         proto.supplier || '', '', posRows[0].p, proto.image_url || '', proto.price || 0]
      );
      dstItem = created[0];
    }

    const newQty = dstItem.qty + receivedQty;
    if (receivedQty > 0) {
      await client.query(
        'UPDATE stock_items SET qty=$1, updated_at=NOW() WHERE id=$2',
        [newQty, dstItem.id]
      );
      await client.query(
        `INSERT INTO stock_movements (item_id, shop_id, user_id, type, qty_change, qty_after, occurred_at, note, staff_id, staff_name)
         VALUES ($1,$2,$3,'transfer-in',$4,$5,NOW(),$6,$7,$8)`,
        [dstItem.id, t.to_shop_id, req.user.id, receivedQty, newQty,
         `Transfer received${receivedQty < t.qty ? ` (${receivedQty} of ${t.qty})` : ''}`,
         staff.id, staff.name]
      );
    }

    const { rows: updated } = await client.query(
      `UPDATE transfers SET status='approved', received_qty=$1, decided_by_staff_id=$2,
         decided_by_staff_name=$3, decided_at=NOW(), decision_note=$4
       WHERE id=$5 RETURNING *`,
      [receivedQty, staff.id, staff.name, String(req.body.note || '').slice(0, 500), t.id]
    );

    await client.query('COMMIT');
    res.json({ transfer: formatTransfer(updated[0]), newQty });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('transfer.approve.error', { err: err.message });
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// Refuse the delivery. The stock goes back onto the sending shop's shelf,
// because it never left the business — it just never arrived.
app.post('/api/transfers/:id/reject', auth, async (req, res) => {
  const client = await pool.connect();
  try {
    const staff = await resolveStaff(req.body.staffId, req.user.businessId);
    await client.query('BEGIN');

    const { rows } = await client.query(
      'SELECT * FROM transfers WHERE id=$1 AND business_id=$2 FOR UPDATE',
      [req.params.id, req.user.businessId]
    );
    if (!rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Transfer not found' });
    }
    const t = rows[0];
    if (!shopAllowed(req, t.to_shop_id)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Only the receiving shop can reject this transfer' });
    }
    if (t.status !== 'pending') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `This transfer was already ${t.status}` });
    }

    const { rows: srcRows } = await client.query(
      'SELECT * FROM stock_items WHERE shop_id=$1 AND sku=$2 FOR UPDATE',
      [t.from_shop_id, t.sku]
    );
    if (srcRows.length) {
      const src = srcRows[0];
      const back = src.qty + t.qty;
      await client.query('UPDATE stock_items SET qty=$1, updated_at=NOW() WHERE id=$2', [back, src.id]);
      await client.query(
        `INSERT INTO stock_movements (item_id, shop_id, user_id, type, qty_change, qty_after, occurred_at, note, staff_id, staff_name)
         VALUES ($1,$2,$3,'transfer-in',$4,$5,NOW(),$6,$7,$8)`,
        [src.id, t.from_shop_id, req.user.id, t.qty, back, 'Transfer rejected — returned', staff.id, staff.name]
      );
    }

    const { rows: updated } = await client.query(
      `UPDATE transfers SET status='rejected', received_qty=0, decided_by_staff_id=$1,
         decided_by_staff_name=$2, decided_at=NOW(), decision_note=$3
       WHERE id=$4 RETURNING *`,
      [staff.id, staff.name, String(req.body.note || '').slice(0, 500), t.id]
    );

    await client.query('COMMIT');
    res.json({ transfer: formatTransfer(updated[0]) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('transfer.reject.error', { err: err.message });
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// Send stock from one shop to another (typically Office → shop).
// This only starts the transfer: the pieces leave the sending shelf, and wait
// as "in transit" until someone at the receiving shop counts them and
// approves. See POST /api/transfers/:id/approve.
app.post('/api/transfers', auth, validate(transferSchema), async (req, res) => {
  const { sku, fromShopId, toShopId, qty, occurredAt, note, staffId } = req.body;
  const staff = await resolveStaff(staffId, req.user.businessId);
  if (fromShopId === toShopId) return res.status(400).json({ error: 'Source and destination must differ' });
  // A shop key may send stock out of its own shop, nowhere else.
  if (!shopAllowed(req, fromShopId)) return denyShop(res);

  const client = await pool.connect();
  try {
    // Both shops must belong to the caller's business
    const { rows: shopRows } = await client.query(
      'SELECT id, name FROM shops WHERE business_id=$1 AND id = ANY($2)',
      [req.user.businessId, [fromShopId, toShopId]]
    );
    if (shopRows.length < 2) return res.status(404).json({ error: 'One or both shops not found' });
    if (!await ensureStaffStockPerm(req, 'edit')) {
      return res.status(403).json({ error: 'You do not have permission to record transfers' });
    }
    const fromShop = shopRows.find(s => s.id === Number(fromShopId));
    const toShop   = shopRows.find(s => s.id === Number(toShopId));

    await client.query('BEGIN');

    // Lock the source row for update
    const { rows: fromRows } = await client.query(
      'SELECT * FROM stock_items WHERE shop_id=$1 AND sku=$2 FOR UPDATE',
      [fromShopId, sku]
    );
    if (!fromRows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: `SKU ${sku} not found in ${fromShop.name}` });
    }
    const srcItem = fromRows[0];
    if (srcItem.qty < qty) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Not enough stock in ${fromShop.name} (have ${srcItem.qty}, need ${qty})` });
    }

    const occurred = occurredAt ? new Date(occurredAt) : new Date();
    const newSrcQty = srcItem.qty - qty;
    const noteFrom = note || `Transfer to ${toShop.name}`;

    // The pieces leave the sending shelf now — they are physically in a bag.
    // They do NOT arrive on the receiving shelf yet: someone there has to
    // count them first. Between the two, the stock is in transit and belongs
    // to neither shop, which is what the pending transfer row represents.
    await client.query(
      'UPDATE stock_items SET qty=$1, updated_at=NOW() WHERE id=$2',
      [newSrcQty, srcItem.id]
    );

    // Log the outbound leg. This MUST NOT be 'out': 'out' is counted as a
    // sale, so office → shop transfers would show up as the office selling.
    await client.query(
      `INSERT INTO stock_movements (item_id, shop_id, user_id, type, qty_change, qty_after, occurred_at, note, staff_id, staff_name)
       VALUES ($1,$2,$3,'transfer-out',$4,$5,$6,$7,$8,$9)`,
      [srcItem.id, fromShopId, req.user.id, -qty, newSrcQty, occurred, noteFrom, staff.id, staff.name]
    );

    const { rows: tRows } = await client.query(
      `INSERT INTO transfers
         (business_id, from_shop_id, to_shop_id, sku, item_name, qty, status, note,
          sent_by_staff_id, sent_by_staff_name, occurred_at)
       VALUES ($1,$2,$3,$4,$5,$6,'pending',$7,$8,$9,$10) RETURNING *`,
      [req.user.businessId, fromShopId, toShopId, sku, srcItem.name, qty,
       note || '', staff.id, staff.name, occurred]
    );

    await client.query('COMMIT');

    res.status(201).json({
      transfer: formatTransfer({ ...tRows[0], from_shop_name: fromShop.name, to_shop_name: toShop.name }),
      from: { shopId: fromShopId, shopName: fromShop.name, sku, newQty: newSrcQty },
      to:   { shopId: toShopId,   shopName: toShop.name,   sku, pending: true },
      qty,
      occurredAt: occurred.toISOString(),
      note,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('transfer.error', { err: err.message });
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

app.get('/api/shops/:shopId/movements', auth, scopedShop, async (req, res) => {
  try {
    if (!await shopGuard(req.params.shopId, req.user.businessId)) {
      return res.status(404).json({ error: 'Shop not found' });
    }
    const { rows } = await pool.query(
      `SELECT m.*, s.name AS item_name FROM stock_movements m
       JOIN stock_items s ON s.id=m.item_id
       WHERE m.shop_id=$1 ORDER BY m.occurred_at DESC LIMIT 200`,
      [req.params.shopId]
    );
    res.json(rows.map(r => ({ ...formatMovement(r), itemName: r.item_name })));
  } catch (err) {
    logger.error('movement.shoplist.error', { err: err.message });
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

// ── Invite codes (owner only) ─────────────────────────────
app.post('/api/invites', auth, requireAdmin, requireOwner, async (req, res) => {
  try {
    if (!req.user.businessId) return res.status(400).json({ error: 'No business' });
    // Generate unique code (retry up to 5 times)
    let code = null;
    for (let i = 0; i < 5; i++) {
      const candidate = genCode();
      const r = await pool.query('SELECT 1 FROM invite_codes WHERE code=$1', [candidate]);
      if (!r.rowCount) { code = candidate; break; }
    }
    if (!code) return res.status(500).json({ error: 'Could not generate unique code, try again' });
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const { rows } = await pool.query(
      `INSERT INTO invite_codes (business_id, code, created_by, expires_at)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [req.user.businessId, code, req.user.id, expiresAt]
    );
    logger.info('invite.created', { businessId: req.user.businessId, code });
    res.status(201).json(formatInvite(rows[0]));
  } catch (err) {
    logger.error('invite.create.error', { err: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/invites', auth, requireAdmin, requireOwner, async (req, res) => {
  try {
    if (!req.user.businessId) return res.json([]);
    const { rows } = await pool.query(
      `SELECT * FROM invite_codes WHERE business_id=$1 ORDER BY created_at DESC LIMIT 100`,
      [req.user.businessId]
    );
    res.json(rows.map(formatInvite));
  } catch (err) {
    logger.error('invite.list.error', { err: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/invites/:id', auth, requireAdmin, requireOwner, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `DELETE FROM invite_codes WHERE id=$1 AND business_id=$2 RETURNING id`,
      [req.params.id, req.user.businessId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Invite not found' });
    res.json({ ok: true });
  } catch (err) {
    logger.error('invite.delete.error', { err: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Staff (owner manages staff in their business) ─────────
app.get('/api/staff', auth, async (req, res) => {
  try {
    if (!req.user.businessId) return res.json([]);
    const { rows } = await pool.query(
      `SELECT id, email, role, permissions, created_at FROM users WHERE business_id=$1 ORDER BY created_at`,
      [req.user.businessId]
    );
    res.json(rows.map(u => ({
      id: u.id,
      email: u.email,
      role: u.role,
      permissions: u.permissions || {},
      createdAt: u.created_at,
    })));
  } catch (err) {
    logger.error('staff.list.error', { err: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.put('/api/staff/:userId/permissions', auth, requireAdmin, requireOwner, async (req, res) => {
  try {
    const permsBody = req.body && typeof req.body === 'object' ? req.body : {};
    const allowedKeys = Object.keys(DEFAULT_STAFF_PERMS);
    const cleanPerms = {};
    for (const k of allowedKeys) cleanPerms[k] = !!permsBody[k];
    const { rows } = await pool.query(
      `UPDATE users SET permissions=$1 WHERE id=$2 AND business_id=$3 AND role='staff' RETURNING id, email, role, permissions`,
      [JSON.stringify(cleanPerms), req.params.userId, req.user.businessId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Staff not found' });
    res.json({
      id: rows[0].id,
      email: rows[0].email,
      role: rows[0].role,
      permissions: rows[0].permissions,
    });
  } catch (err) {
    logger.error('staff.perms.error', { err: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/staff/:userId', auth, requireAdmin, requireOwner, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `DELETE FROM users WHERE id=$1 AND business_id=$2 AND role='staff' RETURNING id`,
      [req.params.userId, req.user.businessId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Staff not found' });
    res.json({ ok: true });
  } catch (err) {
    logger.error('staff.delete.error', { err: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Announcements ─────────────────────────────────────────
app.get('/api/announcements', auth, requireAdmin, async (req, res) => {
  try {
    if (!req.user.businessId) return res.json([]);
    const { rows } = await pool.query(
      `SELECT a.*, u.email AS author_email
       FROM announcements a LEFT JOIN users u ON u.id=a.author_id
       WHERE a.business_id=$1 ORDER BY a.created_at DESC LIMIT 100`,
      [req.user.businessId]
    );
    res.json(rows.map(a => ({
      id: a.id,
      body: a.body,
      authorEmail: a.author_email,
      createdAt: a.created_at,
    })));
  } catch (err) {
    logger.error('announce.list.error', { err: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/announcements', auth, requireAdmin, async (req, res) => {
  try {
    if (!req.user.businessId) return res.status(400).json({ error: 'No business' });
    const body = (req.body?.body || '').trim();
    if (!body || body.length > 2000) return res.status(400).json({ error: 'Message must be 1–2000 characters' });
    // Permission: owner OR canSendAnnouncements
    if (req.user.role !== 'owner') {
      const { rows: ur } = await pool.query('SELECT permissions FROM users WHERE id=$1', [req.user.id]);
      const perms = ur[0]?.permissions || {};
      if (!perms.canSendAnnouncements) {
        return res.status(403).json({ error: 'You do not have permission to send announcements' });
      }
    }
    const { rows } = await pool.query(
      `INSERT INTO announcements (business_id, author_id, body) VALUES ($1,$2,$3) RETURNING *`,
      [req.user.businessId, req.user.id, body]
    );
    res.status(201).json({
      id: rows[0].id,
      body: rows[0].body,
      authorEmail: req.user.email,
      createdAt: rows[0].created_at,
    });
  } catch (err) {
    logger.error('announce.create.error', { err: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Billing (stub for Stripe later) ───────────────────────
app.get('/api/billing/status', auth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT subscription_status, trial_ends_at FROM users WHERE id=$1', [req.user.id]);
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    res.json(trialInfo(rows[0]));
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/billing/subscribe', auth, requireAdmin, async (req, res) => {
  // TODO: integrate Stripe checkout
  res.json({
    checkoutUrl: null,
    message: 'Subscription temporarily unavailable. Coming soon — $10/month.',
  });
});

// Dev-only: mock-activate subscription (only available outside production)
app.post('/api/billing/mock-activate', auth, requireAdmin, async (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(404).json({ error: 'Not found' });
  }
  try {
    const { rows } = await pool.query(
      "UPDATE users SET subscription_status='active' WHERE id=$1 RETURNING *",
      [req.user.id]
    );
    res.json({ ok: true, user: formatUser(rows[0]) });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Error handler ─────────────────────────────────────────
app.use((err, req, res, next) => {
  logger.error('unhandled', { path: req.path, method: req.method, err: err.message, stack: err.stack });
  res.status(500).json({ error: 'Internal server error' });
});

// ── Start ─────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
initDB()
  .then(() => app.listen(PORT, () => logger.info('server.started', { port: PORT, app: 'mitrasamadi' })))
  .catch(err => { logger.error('db.init.failed', { err: err.message, stack: err.stack }); process.exit(1); });
