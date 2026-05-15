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

const JWT_SECRET = process.env.JWT_SECRET || 'stockpilot-dev-secret-change-me';
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://spapilot-app.onrender.com';
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

const formatUser = (u) => ({
  id: u.id,
  email: u.email,
  role: u.role,
  businessId: u.business_id,
  permissions: u.permissions || {},
  trialEndsAt: u.trial_ends_at,
  subscriptionStatus: u.subscription_status || 'trial',
  createdAt: u.created_at,
});

const formatShop = (s) => ({
  id: s.id,
  businessId: s.business_id,
  name: s.name,
  address: s.address || '',
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
  lastSoldAt: s.last_sold_at,
  createdAt: s.created_at,
  updatedAt: s.updated_at,
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

const trialInfo = (u) => {
  const now = new Date();
  const ends = u.trial_ends_at ? new Date(u.trial_ends_at) : null;
  const daysRemaining = ends ? Math.max(0, Math.ceil((ends - now) / (24 * 60 * 60 * 1000))) : 0;
  const expired = ends ? now > ends : true;
  const status = u.subscription_status || 'trial';
  return {
    subscriptionStatus: status,
    trialEndsAt: u.trial_ends_at,
    daysRemaining,
    expired: expired && status !== 'active',
    isPaid: status === 'active',
  };
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

    // Trial enforcement on mutations
    const isMutating = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method);
    const allowed = TRIAL_EXPIRED_ALLOWED.some(p => req.path.startsWith(p));
    if (isMutating && !allowed) {
      const { rows } = await pool.query(
        'SELECT subscription_status, trial_ends_at FROM users WHERE id=$1',
        [decoded.id]
      );
      if (rows.length) {
        const status = rows[0].subscription_status;
        const expired = rows[0].trial_ends_at && new Date(rows[0].trial_ends_at) < new Date();
        if (status !== 'active' && expired) {
          return res.status(402).json({ error: 'Your trial has ended. Subscribe to continue.', code: 'TRIAL_EXPIRED' });
        }
      }
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

const makeToken = (user) => jwt.sign(
  {
    id: user.id,
    email: user.email,
    role: user.role,
    businessId: user.business_id,
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
  // ── One-time migration: wipe old SpaPilot schema ─────────
  // If stock_items doesn't exist yet → first StockPilot deploy → nuke everything.
  // After first successful run, stock_items exists and this is skipped forever.
  // Detect old SpaPilot schema by presence of businesses.type column (StockPilot has no such column)
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
  `);

  // Add foreign key from users.business_id → businesses after both tables exist
  await pool.query(`
    DO $$ BEGIN
      ALTER TABLE users ADD CONSTRAINT users_business_id_fkey
        FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE SET NULL;
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  `);

  // Idempotent column adds for stock_items (so deploys before fabric/print/last_sold_at upgrade cleanly)
  await pool.query(`
    ALTER TABLE stock_items ADD COLUMN IF NOT EXISTS fabric       TEXT DEFAULT '';
    ALTER TABLE stock_items ADD COLUMN IF NOT EXISTS print        TEXT DEFAULT '';
    ALTER TABLE stock_items ADD COLUMN IF NOT EXISTS last_sold_at TIMESTAMPTZ;
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
  ];
  for (const q of indexes) {
    try { await pool.query(q); } catch (e) { logger.warn('index.skipped', { err: e.message }); }
  }

  // Cleanup expired blacklist tokens hourly
  setInterval(() => {
    pool.query('DELETE FROM token_blacklist WHERE expires_at < NOW()')
      .catch(err => logger.error('blacklist.cleanup.error', { err: err.message }));
  }, 60 * 60 * 1000);

  logger.info('db.ready');
}

// ── Health ────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', app: 'stockpilot' }));

// ── Auth: Signup as owner (creates business) ──────────────
app.post('/api/auth/signup', authLimiter, validate(signupSchema), async (req, res) => {
  const client = await pool.connect();
  try {
    const { email, password, businessName } = req.body;
    await client.query('BEGIN');
    const existing = await client.query('SELECT id FROM users WHERE email=$1', [email]);
    if (existing.rowCount) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Email already registered' });
    }
    const hash = await bcrypt.hash(password, 10);
    const trialEnd = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const userResult = await client.query(
      `INSERT INTO users (email, password_hash, role, trial_started_at, trial_ends_at, subscription_status)
       VALUES ($1,$2,'owner',NOW(),$3,'trial') RETURNING *`,
      [email, hash, trialEnd]
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
    res.json({ user: formatUser(rows[0]), business, trial: trialInfo(rows[0]) });
  } catch (err) {
    logger.error('me.error', { err: err.message });
    res.status(500).json({ error: 'Internal server error' });
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
app.delete('/api/auth/account', auth, validate(deleteAccountSchema), async (req, res) => {
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
app.get('/api/auth/export-data', auth, async (req, res) => {
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
    res.setHeader('Content-Disposition', `attachment; filename="stockpilot-data-${userId}-${Date.now()}.json"`);
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

app.post('/api/shops', auth, requireOwner, validate(shopSchema), async (req, res) => {
  try {
    if (!req.user.businessId) return res.status(400).json({ error: 'No business' });
    const { name, address } = req.body;
    const { rows } = await pool.query(
      `INSERT INTO shops (business_id, name, address) VALUES ($1, $2, $3) RETURNING *`,
      [req.user.businessId, name, address || '']
    );
    res.status(201).json(formatShop(rows[0]));
  } catch (err) {
    logger.error('shops.create.error', { err: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.put('/api/shops/:id', auth, requireOwner, validate(shopSchema), async (req, res) => {
  try {
    const { name, address } = req.body;
    const { rows } = await pool.query(
      `UPDATE shops SET name=$1, address=$2 WHERE id=$3 AND business_id=$4 RETURNING *`,
      [name, address || '', req.params.id, req.user.businessId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Shop not found' });
    res.json(formatShop(rows[0]));
  } catch (err) {
    logger.error('shops.update.error', { err: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/shops/:id', auth, requireOwner, async (req, res) => {
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
async function shopGuard(shopId, businessId) {
  const r = await pool.query('SELECT 1 FROM shops WHERE id=$1 AND business_id=$2', [shopId, businessId]);
  return r.rowCount > 0;
}

app.get('/api/shops/:shopId/stock', auth, async (req, res) => {
  try {
    if (!await shopGuard(req.params.shopId, req.user.businessId)) {
      return res.status(404).json({ error: 'Shop not found' });
    }
    const search = (req.query.search || '').trim().toLowerCase();
    const params = [req.params.shopId];
    let sql = 'SELECT * FROM stock_items WHERE shop_id=$1';
    if (search) {
      params.push(`%${search}%`);
      sql += ` AND (LOWER(name) LIKE $2 OR LOWER(category) LIKE $2 OR LOWER(fabric) LIKE $2 OR LOWER(print) LIKE $2 OR LOWER(color) LIKE $2 OR LOWER(size) LIKE $2 OR LOWER(sku) LIKE $2 OR LOWER(brand) LIKE $2)`;
    }
    sql += ' ORDER BY name LIMIT 1000';
    const { rows } = await pool.query(sql, params);
    res.json(rows.map(formatStock));
  } catch (err) {
    logger.error('stock.list.error', { err: err.message });
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

app.post('/api/shops/:shopId/stock', auth, validate(stockItemSchema), async (req, res) => {
  try {
    if (!await shopGuard(req.params.shopId, req.user.businessId)) {
      return res.status(404).json({ error: 'Shop not found' });
    }
    if (!await ensureStaffStockPerm(req, 'add')) {
      return res.status(403).json({ error: 'You do not have permission to add stock items' });
    }
    const b = req.body;
    const { rows } = await pool.query(
      `INSERT INTO stock_items (shop_id, name, category, fabric, print, size, color, sku, brand, qty, threshold, supplier, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [req.params.shopId, b.name, b.category, b.fabric, b.print, b.size, b.color, b.sku, b.brand, b.qty, b.threshold, b.supplier, b.notes]
    );
    res.status(201).json(formatStock(rows[0]));
  } catch (err) {
    logger.error('stock.create.error', { err: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.put('/api/stock/:id', auth, validate(stockItemSchema), async (req, res) => {
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
       SET name=$1, category=$2, fabric=$3, print=$4, size=$5, color=$6, sku=$7, brand=$8, qty=$9, threshold=$10, supplier=$11, notes=$12, updated_at=NOW()
       WHERE id=$13 RETURNING *`,
      [b.name, b.category, b.fabric, b.print, b.size, b.color, b.sku, b.brand, b.qty, b.threshold, b.supplier, b.notes, req.params.id]
    );
    res.json(formatStock(rows[0]));
  } catch (err) {
    logger.error('stock.update.error', { err: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Quick qty update (also auto-logs movement)
app.patch('/api/stock/:id/qty', auth, async (req, res) => {
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

app.delete('/api/stock/:id', auth, async (req, res) => {
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
app.post('/api/stock/:id/movements', auth, validate(movementSchema), async (req, res) => {
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

app.get('/api/stock/:id/movements', auth, async (req, res) => {
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

app.get('/api/shops/:shopId/movements', auth, async (req, res) => {
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

// ── Invite codes (owner only) ─────────────────────────────
app.post('/api/invites', auth, requireOwner, async (req, res) => {
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

app.get('/api/invites', auth, requireOwner, async (req, res) => {
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

app.delete('/api/invites/:id', auth, requireOwner, async (req, res) => {
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

app.put('/api/staff/:userId/permissions', auth, requireOwner, async (req, res) => {
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

app.delete('/api/staff/:userId', auth, requireOwner, async (req, res) => {
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
app.get('/api/announcements', auth, async (req, res) => {
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

app.post('/api/announcements', auth, async (req, res) => {
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

app.post('/api/billing/subscribe', auth, async (req, res) => {
  // TODO: integrate Stripe checkout
  res.json({
    checkoutUrl: null,
    message: 'Subscription temporarily unavailable. Coming soon — $10/month.',
  });
});

// Dev-only: mock-activate subscription (only available outside production)
app.post('/api/billing/mock-activate', auth, async (req, res) => {
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
  .then(() => app.listen(PORT, () => logger.info('server.started', { port: PORT, app: 'stockpilot' })))
  .catch(err => { logger.error('db.init.failed', { err: err.message, stack: err.stack }); process.exit(1); });
