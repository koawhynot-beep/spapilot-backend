const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const crypto = require('crypto');

let nodemailer = null;
try { nodemailer = require('nodemailer'); } catch {}

const app = express();

const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',')
  : ['http://localhost:3001', 'https://spapilot-app.onrender.com'];

app.use(cors({ origin: allowedOrigins, credentials: true }));
app.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET || 'spapilot-dev-secret-change-me';
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://spapilot-app.onrender.com';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

// ── Email ─────────────────────────────────────────────────
let mailer = null;
if (nodemailer && process.env.SMTP_HOST) {
  mailer = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

async function sendResetEmail(to, token) {
  const link = `${FRONTEND_URL}?reset_token=${token}`;
  if (!mailer) {
    console.log(`[DEV] Password reset for ${to}: ${link}`);
    return { devLink: link };
  }
  await mailer.sendMail({
    from: process.env.SMTP_FROM || 'SpaPilot <noreply@spapilot.app>',
    to,
    subject: 'Reset your SpaPilot password',
    html: `<p>Click to reset your SpaPilot password (expires in 1 hour):</p><p><a href="${link}">${link}</a></p>`,
    text: `Reset your SpaPilot password: ${link}`,
  });
  return {};
}

// ── Format rows (snake → camelCase) ──────────────────────
const DEFAULT_PERMISSIONS = {
  canViewSchedule: true,
  canRequestTimeOff: true,
  canSwapShifts: true,
  canRequestStock: true,
  canRequestNewProducts: false,
  canMarkViolations: false,
  canPostAnnouncements: false,
};

const formatUser = (u) => ({
  id: u.id,
  email: u.email,
  role: u.role,
  businessType: u.business_type,
  staffId: u.staff_id,
  createdAt: u.created_at,
  trialStartedAt: u.trial_started_at,
  trialEndsAt: u.trial_ends_at,
  subscriptionStatus: u.subscription_status || 'trial',
  businessId: u.business_id,
  onboardingRole: u.onboarding_role,
  tutorialCompleted: !!u.tutorial_completed,
});

const formatBusiness = (b) => ({
  id: b.id,
  name: b.name,
  type: b.type,
  ownerId: b.owner_id,
  code: b.code,
  staffCount: b.staff_count,
  createdAt: b.created_at,
});

const formatStaff = (s) => ({
  id: s.id,
  name: s.name,
  role: s.role,
  avatar: s.avatar,
  color: s.color,
  birthday: s.birthday,
  phone: s.phone,
  schedule: s.schedule || [],
  commissionRate: s.commission_rate,
  permissions: { ...DEFAULT_PERMISSIONS, ...(s.permissions || {}) },
});

const formatBooking = (b) => ({
  id: b.id,
  time: b.time,
  client: b.client,
  treatment: b.treatment,
  duration: b.duration,
  staffId: b.staff_id,
  notes: b.notes || '',
  status: b.status,
  price: b.price,
  date: b.date,
  allergies: b.allergies || '',
  clientPhone: b.client_phone || '',
});

const formatInventory = (i) => ({
  id: i.id,
  name: i.name,
  category: i.category,
  stock: i.stock,
  threshold: i.threshold,
  unit: i.unit,
  supplier: i.supplier,
  lastOrder: i.last_order,
});

const formatRequest = (r) => ({
  id: r.id,
  type: r.type,
  staffId: r.staff_id,
  date: r.date,
  reason: r.reason,
  swapWith: r.swap_with,
  swapDay: r.swap_day,
  productId: r.product_id,
  quantity: r.quantity,
  status: r.status,
  createdAt: r.created_at,
});

const formatAnnouncement = (a) => ({
  id: a.id,
  title: a.title,
  body: a.body,
  from: a.from,
  createdAt: a.created_at,
});

const formatViolation = (v) => ({
  id: v.id,
  staffId: v.staff_id,
  sopId: v.sop_id,
  note: v.note,
  createdAt: v.created_at,
});

const formatSop = (s) => ({
  id: s.id,
  title: s.title,
  body: s.body,
  description: s.body,
  category: s.category || 'General',
  createdAt: s.created_at,
});

// ── Auth middleware ───────────────────────────────────────
const auth = (req, res, next) => {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(header.replace('Bearer ', ''), JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
};

const makeToken = (user) => jwt.sign(
  { id: user.id, email: user.email, role: user.role, businessType: user.business_type, staffId: user.staff_id, businessId: user.business_id },
  JWT_SECRET,
  { expiresIn: '12h' }
);

function genBusinessCode() {
  return crypto.randomBytes(3).toString('hex').toUpperCase();
}

function trialInfo(u) {
  const now = new Date();
  const ends = u.trial_ends_at ? new Date(u.trial_ends_at) : null;
  const daysRemaining = ends ? Math.max(0, Math.ceil((ends - now) / (24 * 60 * 60 * 1000))) : 0;
  const expired = ends ? now > ends : true;
  const status = u.subscription_status || 'trial';
  return {
    subscriptionStatus: status,
    trialStartedAt: u.trial_started_at,
    trialEndsAt: u.trial_ends_at,
    daysRemaining,
    expired: expired && status !== 'active',
    isPaid: status === 'active',
  };
}

// ── DB init ───────────────────────────────────────────────
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id                   SERIAL PRIMARY KEY,
      email                TEXT UNIQUE NOT NULL,
      password_hash        TEXT NOT NULL,
      role                 TEXT,
      business_type        TEXT,
      staff_id             INTEGER,
      business_id          INTEGER,
      onboarding_role      TEXT,
      trial_started_at     TIMESTAMPTZ DEFAULT NOW(),
      trial_ends_at        TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '7 days'),
      subscription_status  TEXT DEFAULT 'trial',
      created_at           TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS businesses (
      id          SERIAL PRIMARY KEY,
      name        TEXT NOT NULL,
      type        TEXT NOT NULL,
      owner_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
      code        TEXT UNIQUE NOT NULL,
      staff_count INTEGER DEFAULT 0,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS password_resets (
      id         SERIAL PRIMARY KEY,
      user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
      token      TEXT UNIQUE NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      used       BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS staff (
      id              SERIAL PRIMARY KEY,
      name            TEXT NOT NULL,
      role            TEXT NOT NULL,
      avatar          TEXT,
      color           TEXT,
      birthday        TEXT,
      phone           TEXT,
      schedule        TEXT[],
      commission_rate INTEGER DEFAULT 30,
      permissions     JSONB DEFAULT '{"canViewSchedule":true,"canRequestTimeOff":true,"canSwapShifts":true,"canRequestStock":true,"canRequestNewProducts":false,"canMarkViolations":false,"canPostAnnouncements":false}'::jsonb
    );

    CREATE TABLE IF NOT EXISTS bookings (
      id           SERIAL PRIMARY KEY,
      time         TEXT NOT NULL,
      client       TEXT NOT NULL,
      treatment    TEXT NOT NULL,
      duration     INTEGER NOT NULL,
      staff_id     INTEGER REFERENCES staff(id) ON DELETE SET NULL,
      notes        TEXT DEFAULT '',
      status       TEXT DEFAULT 'confirmed',
      price        NUMERIC DEFAULT 0,
      date         DATE DEFAULT CURRENT_DATE,
      allergies    TEXT DEFAULT '',
      client_phone TEXT DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS inventory (
      id          SERIAL PRIMARY KEY,
      name        TEXT NOT NULL,
      category    TEXT,
      stock       INTEGER DEFAULT 0,
      threshold   INTEGER DEFAULT 5,
      unit        TEXT DEFAULT 'pcs',
      supplier    TEXT,
      last_order  TEXT
    );

    CREATE TABLE IF NOT EXISTS requests (
      id          SERIAL PRIMARY KEY,
      type        TEXT NOT NULL,
      staff_id    INTEGER REFERENCES staff(id) ON DELETE CASCADE,
      date        TEXT,
      reason      TEXT DEFAULT '',
      swap_with   INTEGER,
      swap_day    TEXT,
      product_id  INTEGER REFERENCES inventory(id) ON DELETE SET NULL,
      quantity    INTEGER DEFAULT 0,
      status      TEXT DEFAULT 'pending',
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS announcements (
      id          SERIAL PRIMARY KEY,
      title       TEXT,
      body        TEXT NOT NULL,
      "from"      TEXT DEFAULT 'Management',
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS sop (
      id          SERIAL PRIMARY KEY,
      title       TEXT NOT NULL,
      body        TEXT,
      category    TEXT DEFAULT 'General',
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS violations (
      id          SERIAL PRIMARY KEY,
      staff_id    INTEGER REFERENCES staff(id) ON DELETE CASCADE,
      sop_id      INTEGER REFERENCES sop(id) ON DELETE SET NULL,
      note        TEXT DEFAULT '',
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Add columns to existing tables idempotently
  const alters = [
    `ALTER TABLE bookings ADD COLUMN IF NOT EXISTS allergies TEXT DEFAULT ''`,
    `ALTER TABLE bookings ADD COLUMN IF NOT EXISTS client_phone TEXT DEFAULT ''`,
    `ALTER TABLE staff ADD COLUMN IF NOT EXISTS permissions JSONB DEFAULT '{"canViewSchedule":true,"canRequestTimeOff":true,"canSwapShifts":true,"canRequestStock":true,"canRequestNewProducts":false,"canMarkViolations":false,"canPostAnnouncements":false}'::jsonb`,
    `ALTER TABLE requests ADD COLUMN IF NOT EXISTS product_id INTEGER REFERENCES inventory(id) ON DELETE SET NULL`,
    `ALTER TABLE requests ADD COLUMN IF NOT EXISTS quantity INTEGER DEFAULT 0`,
    `ALTER TABLE sop ADD COLUMN IF NOT EXISTS category TEXT DEFAULT 'General'`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS business_id INTEGER`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_role TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS trial_started_at TIMESTAMPTZ DEFAULT NOW()`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '7 days')`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_status TEXT DEFAULT 'trial'`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS tutorial_completed BOOLEAN DEFAULT FALSE`,
    // Multi-tenancy: scope all data to a business
    `ALTER TABLE staff         ADD COLUMN IF NOT EXISTS business_id INTEGER REFERENCES businesses(id) ON DELETE CASCADE`,
    `ALTER TABLE bookings      ADD COLUMN IF NOT EXISTS business_id INTEGER REFERENCES businesses(id) ON DELETE CASCADE`,
    `ALTER TABLE inventory     ADD COLUMN IF NOT EXISTS business_id INTEGER REFERENCES businesses(id) ON DELETE CASCADE`,
    `ALTER TABLE requests      ADD COLUMN IF NOT EXISTS business_id INTEGER REFERENCES businesses(id) ON DELETE CASCADE`,
    `ALTER TABLE announcements ADD COLUMN IF NOT EXISTS business_id INTEGER REFERENCES businesses(id) ON DELETE CASCADE`,
    `ALTER TABLE sop           ADD COLUMN IF NOT EXISTS business_id INTEGER REFERENCES businesses(id) ON DELETE CASCADE`,
    `ALTER TABLE violations    ADD COLUMN IF NOT EXISTS business_id INTEGER REFERENCES businesses(id) ON DELETE CASCADE`,
  ];
  for (const q of alters) {
    try { await pool.query(q); } catch (e) { console.warn('alter skipped:', e.message); }
  }

  // ── Migrations table ─────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS migrations (
      name        TEXT PRIMARY KEY,
      applied_at  TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // ── One-time wipe: reset all data for fresh-start UX ─
  // This clears every legacy record (demo seed, leftover test data) so
  // every account — old or new — lands in a truly empty workspace and
  // adds their own bookings/products/team. Runs only once per DB.
  const wipeMarker = 'wipe_data_v2_fresh_start';
  const { rows: wipeRows } = await pool.query(
    `INSERT INTO migrations (name) VALUES ($1) ON CONFLICT DO NOTHING RETURNING name`,
    [wipeMarker]
  );
  if (wipeRows.length) {
    console.log('Running one-time data wipe migration:', wipeMarker);
    await pool.query('DELETE FROM violations');
    await pool.query('DELETE FROM requests');
    await pool.query('DELETE FROM bookings');
    await pool.query('DELETE FROM inventory');
    await pool.query('DELETE FROM sop');
    await pool.query('DELETE FROM announcements');
    await pool.query('DELETE FROM staff');
    // Clear any users.staff_id pointers that now reference deleted staff
    await pool.query('UPDATE users SET staff_id = NULL WHERE staff_id IS NOT NULL');
    // Reset tutorial flag so existing users see the new tutorial
    await pool.query('UPDATE users SET tutorial_completed = FALSE');
    console.log('Wipe complete');
  }

  // Drop any CHECK constraints on requests.type so stock_request is allowed
  try {
    const { rows: cs } = await pool.query(
      `SELECT constraint_name FROM information_schema.table_constraints
       WHERE table_name='requests' AND constraint_type='CHECK'`
    );
    for (const c of cs) {
      await pool.query(`ALTER TABLE requests DROP CONSTRAINT IF EXISTS "${c.constraint_name}"`);
    }
  } catch (e) { console.warn('constraint drop skipped:', e.message); }

  // Ensure demo@opus.app exists for testing — but no auto-seeded data.
  // Demo user goes through normal onboarding like any other user.
  const { rowCount: hasDemo } = await pool.query(
    "SELECT 1 FROM users WHERE email = 'demo@opus.app'"
  );
  if (!hasDemo) {
    const hash = await bcrypt.hash('demo1234', 10);
    await pool.query(
      `INSERT INTO users (email, password_hash) VALUES ($1, $2)`,
      ['demo@opus.app', hash]
    );
    console.log('Demo user created');
  }

  console.log('Database ready');
}

// ── Health ────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// ── Auth ──────────────────────────────────────────────────
app.post('/api/auth/signup', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be 6+ characters' });
    const exists = await pool.query('SELECT id FROM users WHERE email=$1', [email.toLowerCase()]);
    if (exists.rowCount) return res.status(400).json({ error: 'Email already registered' });
    const hash = await bcrypt.hash(password, 10);
    const trialEnd = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const { rows } = await pool.query(
      `INSERT INTO users (email, password_hash, trial_started_at, trial_ends_at, subscription_status)
       VALUES ($1, $2, NOW(), $3, 'trial') RETURNING *`,
      [email.toLowerCase(), hash, trialEnd]
    );
    res.status(201).json({ token: makeToken(rows[0]), user: formatUser(rows[0]), trial: trialInfo(rows[0]) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    const { rows } = await pool.query('SELECT * FROM users WHERE email=$1', [email.toLowerCase()]);
    if (!rows.length) return res.status(401).json({ error: 'Invalid email or password' });
    const valid = await bcrypt.compare(password, rows[0].password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid email or password' });
    res.json({ token: makeToken(rows[0]), user: formatUser(rows[0]), trial: trialInfo(rows[0]) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/auth/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });
    const { rows } = await pool.query('SELECT * FROM users WHERE email=$1', [email.toLowerCase()]);
    if (!rows.length) {
      return res.json({ message: 'If that email is registered, a reset link has been sent.' });
    }
    // Invalidate previous tokens
    await pool.query('UPDATE password_resets SET used=TRUE WHERE user_id=$1 AND used=FALSE', [rows[0].id]);
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    await pool.query(
      'INSERT INTO password_resets (user_id, token, expires_at) VALUES ($1,$2,$3)',
      [rows[0].id, token, expiresAt]
    );
    const result = await sendResetEmail(rows[0].email, token);
    res.json({
      message: 'If that email is registered, a reset link has been sent.',
      ...(result.devLink ? { devLink: result.devLink } : {}),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) return res.status(400).json({ error: 'Token and password required' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be 6+ characters' });
    const { rows } = await pool.query(
      'SELECT * FROM password_resets WHERE token=$1 AND used=FALSE AND expires_at > NOW()',
      [token]
    );
    if (!rows.length) return res.status(400).json({ error: 'Invalid or expired reset link. Request a new one.' });
    const hash = await bcrypt.hash(password, 10);
    await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, rows[0].user_id]);
    await pool.query('UPDATE password_resets SET used=TRUE WHERE id=$1', [rows[0].id]);
    res.json({ message: 'Password reset successful' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/auth/business', auth, async (req, res) => {
  try {
    const { businessType } = req.body;
    const { rows } = await pool.query(
      'UPDATE users SET business_type=$1 WHERE id=$2 RETURNING *',
      [businessType, req.user.id]
    );
    res.json({ token: makeToken(rows[0]), user: formatUser(rows[0]) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/auth/role', auth, async (req, res) => {
  try {
    const { role, staffId } = req.body;
    const { rows } = await pool.query(
      'UPDATE users SET role=$1, staff_id=$2 WHERE id=$3 RETURNING *',
      [role, staffId || null, req.user.id]
    );
    res.json({ token: makeToken(rows[0]), user: formatUser(rows[0]) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/auth/me', auth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE id=$1', [req.user.id]);
    if (!rows.length) return res.status(401).json({ error: 'User not found' });
    res.json(formatUser(rows[0]));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/auth/logout', auth, (req, res) => res.json({ ok: true }));

app.post('/api/auth/complete-tutorial', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'UPDATE users SET tutorial_completed = TRUE WHERE id = $1 RETURNING *',
      [req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    res.json({ user: formatUser(rows[0]) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Trial / Billing ───────────────────────────────────────
app.get('/api/auth/trial-status', auth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE id=$1', [req.user.id]);
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    res.json(trialInfo(rows[0]));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/billing/check-payment', auth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT subscription_status FROM users WHERE id=$1', [req.user.id]);
    res.json({ paid: rows[0]?.subscription_status === 'active' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Mock subscription activation. Replace with Stripe checkout webhook in production.
app.post('/api/billing/subscribe', auth, async (req, res) => {
  try {
    res.json({
      checkoutUrl: null,
      message: 'Stripe checkout not configured. Use POST /api/billing/mock-activate for testing.',
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/billing/mock-activate', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      "UPDATE users SET subscription_status='active' WHERE id=$1 RETURNING *",
      [req.user.id]
    );
    res.json({ ok: true, user: formatUser(rows[0]) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Businesses ────────────────────────────────────────────
app.post('/api/businesses', auth, async (req, res) => {
  try {
    const { name, type, staffCount } = req.body;
    if (!name || !type) return res.status(400).json({ error: 'name and type required' });
    let code = null;
    for (let i = 0; i < 8; i++) {
      const candidate = genBusinessCode();
      const { rowCount } = await pool.query('SELECT 1 FROM businesses WHERE code=$1', [candidate]);
      if (!rowCount) { code = candidate; break; }
    }
    if (!code) return res.status(500).json({ error: 'Could not generate unique business code' });
    const { rows } = await pool.query(
      `INSERT INTO businesses (name, type, owner_id, code, staff_count)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [name, type, req.user.id, code, staffCount || 0]
    );
    const { rows: urows } = await pool.query(
      `UPDATE users SET business_id=$1, business_type=$2, role='manager', onboarding_role='owner'
       WHERE id=$3 RETURNING *`,
      [rows[0].id, type, req.user.id]
    );
    res.status(201).json({
      business: formatBusiness(rows[0]),
      token: makeToken(urows[0]),
      user: formatUser(urows[0]),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/businesses/join', auth, async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'business code required' });
    const { rows } = await pool.query(
      'SELECT * FROM businesses WHERE code=$1',
      [code.trim().toUpperCase()]
    );
    if (!rows.length) return res.status(404).json({ error: 'Invalid business code' });
    const business = rows[0];
    const { rows: urows } = await pool.query(
      `UPDATE users SET business_id=$1, business_type=$2, role='staff', onboarding_role='staff'
       WHERE id=$3 RETURNING *`,
      [business.id, business.type, req.user.id]
    );
    await pool.query(
      'UPDATE businesses SET staff_count = staff_count + 1 WHERE id=$1',
      [business.id]
    );
    res.json({
      business: formatBusiness(business),
      token: makeToken(urows[0]),
      user: formatUser(urows[0]),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/businesses/me', auth, async (req, res) => {
  try {
    const { rows: urows } = await pool.query('SELECT business_id FROM users WHERE id=$1', [req.user.id]);
    if (!urows.length || !urows[0].business_id) return res.json(null);
    const { rows } = await pool.query('SELECT * FROM businesses WHERE id=$1', [urows[0].business_id]);
    res.json(rows.length ? formatBusiness(rows[0]) : null);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// User can switch between owner/staff later. Resets business association.
app.post('/api/auth/switch-onboarding', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE users SET business_id=NULL, business_type=NULL, role=NULL, onboarding_role=NULL
       WHERE id=$1 RETURNING *`,
      [req.user.id]
    );
    res.json({ token: makeToken(rows[0]), user: formatUser(rows[0]) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Multi-tenancy helper ──────────────────────────────────
// Every data endpoint scopes to the authed user's business. Users without
// a business_id (still in onboarding) get an empty result set / 403.
const needBusiness = (req, res) => {
  const bid = req.user.businessId;
  if (!bid) {
    res.status(403).json({ error: 'Complete onboarding first' });
    return null;
  }
  return bid;
};

// ── Staff ─────────────────────────────────────────────────
app.get('/api/staff', auth, async (req, res) => {
  try {
    const bid = req.user.businessId;
    if (!bid) return res.json([]);
    const { rows } = await pool.query('SELECT * FROM staff WHERE business_id = $1 ORDER BY id', [bid]);
    res.json(rows.map(formatStaff));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/staff', auth, async (req, res) => {
  try {
    const bid = needBusiness(req, res); if (!bid) return;
    const { name, role, avatar, color, birthday, phone, schedule, commissionRate, permissions } = req.body;
    if (!name || !role) return res.status(400).json({ error: 'name and role required' });
    const { rows } = await pool.query(
      'INSERT INTO staff (business_id, name, role, avatar, color, birthday, phone, schedule, commission_rate, permissions) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',
      [bid, name, role, avatar || name[0].toUpperCase(), color || '#a8c5a0', birthday || null, phone || null, schedule || [], commissionRate || 30, JSON.stringify({ ...DEFAULT_PERMISSIONS, ...(permissions || {}) })]
    );
    res.status(201).json(formatStaff(rows[0]));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/staff/:id', auth, async (req, res) => {
  try {
    const bid = needBusiness(req, res); if (!bid) return;
    const { name, role, avatar, color, birthday, phone, schedule, commissionRate, permissions } = req.body;
    const { rows } = await pool.query(
      'UPDATE staff SET name=$1, role=$2, avatar=$3, color=$4, birthday=$5, phone=$6, schedule=$7, commission_rate=$8, permissions=$9 WHERE id=$10 AND business_id=$11 RETURNING *',
      [name, role, avatar, color, birthday || null, phone || null, schedule || [], commissionRate || 30, JSON.stringify({ ...DEFAULT_PERMISSIONS, ...(permissions || {}) }), req.params.id, bid]
    );
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    res.json(formatStaff(rows[0]));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/staff/:id', auth, async (req, res) => {
  try {
    const bid = needBusiness(req, res); if (!bid) return;
    const { rows } = await pool.query('DELETE FROM staff WHERE id=$1 AND business_id=$2 RETURNING *', [req.params.id, bid]);
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    res.json(formatStaff(rows[0]));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Bookings ──────────────────────────────────────────────
app.get('/api/bookings', auth, async (req, res) => {
  try {
    const bid = req.user.businessId;
    if (!bid) return res.json([]);
    const { rows } = await pool.query('SELECT * FROM bookings WHERE business_id = $1 ORDER BY time', [bid]);
    res.json(rows.map(formatBooking));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/bookings', auth, async (req, res) => {
  try {
    const bid = needBusiness(req, res); if (!bid) return;
    const { time, client, treatment, duration, staffId, notes, status, price, allergies, clientPhone } = req.body;
    if (!time || !client || !treatment || !duration) return res.status(400).json({ error: 'time, client, treatment, duration required' });
    const { rows } = await pool.query(
      'INSERT INTO bookings (business_id, time, client, treatment, duration, staff_id, notes, status, price, allergies, client_phone) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *',
      [bid, time, client, treatment, duration, staffId || null, notes || '', status || 'confirmed', price || 0, allergies || '', clientPhone || '']
    );
    res.status(201).json(formatBooking(rows[0]));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/bookings/:id', auth, async (req, res) => {
  try {
    const bid = needBusiness(req, res); if (!bid) return;
    const { time, client, treatment, duration, staffId, notes, status, price, allergies, clientPhone } = req.body;
    const { rows } = await pool.query(
      'UPDATE bookings SET time=$1, client=$2, treatment=$3, duration=$4, staff_id=$5, notes=$6, status=$7, price=$8, allergies=$9, client_phone=$10 WHERE id=$11 AND business_id=$12 RETURNING *',
      [time, client, treatment, duration, staffId || null, notes || '', status || 'confirmed', price || 0, allergies || '', clientPhone || '', req.params.id, bid]
    );
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    res.json(formatBooking(rows[0]));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/bookings/:id', auth, async (req, res) => {
  try {
    const bid = needBusiness(req, res); if (!bid) return;
    const { rows } = await pool.query('DELETE FROM bookings WHERE id=$1 AND business_id=$2 RETURNING *', [req.params.id, bid]);
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    res.json(formatBooking(rows[0]));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Inventory ─────────────────────────────────────────────
app.get('/api/inventory', auth, async (req, res) => {
  try {
    const bid = req.user.businessId;
    if (!bid) return res.json([]);
    const { rows } = await pool.query('SELECT * FROM inventory WHERE business_id = $1 ORDER BY id', [bid]);
    res.json(rows.map(formatInventory));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/inventory', auth, async (req, res) => {
  try {
    const bid = needBusiness(req, res); if (!bid) return;
    const { name, category, stock, threshold, unit, supplier, lastOrder } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    const { rows } = await pool.query(
      'INSERT INTO inventory (business_id, name, category, stock, threshold, unit, supplier, last_order) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
      [bid, name, category || '', stock || 0, threshold || 5, unit || 'pcs', supplier || '', lastOrder || '']
    );
    res.status(201).json(formatInventory(rows[0]));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/inventory/:id', auth, async (req, res) => {
  try {
    const bid = needBusiness(req, res); if (!bid) return;
    const { name, category, stock, threshold, unit, supplier, lastOrder } = req.body;
    const { rows } = await pool.query(
      'UPDATE inventory SET name=$1, category=$2, stock=$3, threshold=$4, unit=$5, supplier=$6, last_order=$7 WHERE id=$8 AND business_id=$9 RETURNING *',
      [name, category, stock, threshold, unit, supplier, lastOrder || '', req.params.id, bid]
    );
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    res.json(formatInventory(rows[0]));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/inventory/:id/stock', auth, async (req, res) => {
  try {
    const bid = needBusiness(req, res); if (!bid) return;
    const { delta } = req.body;
    const { rows } = await pool.query(
      'UPDATE inventory SET stock = GREATEST(0, stock + $1) WHERE id=$2 AND business_id=$3 RETURNING *',
      [delta, req.params.id, bid]
    );
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    res.json(formatInventory(rows[0]));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/inventory/:id/order', auth, async (req, res) => {
  try {
    const bid = needBusiness(req, res); if (!bid) return;
    const today = new Date().toISOString().slice(0, 10);
    const { rows } = await pool.query(
      'UPDATE inventory SET last_order=$1 WHERE id=$2 AND business_id=$3 RETURNING *',
      [today, req.params.id, bid]
    );
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    res.json(formatInventory(rows[0]));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/inventory/:id', auth, async (req, res) => {
  try {
    const bid = needBusiness(req, res); if (!bid) return;
    const { rows } = await pool.query('DELETE FROM inventory WHERE id=$1 AND business_id=$2 RETURNING *', [req.params.id, bid]);
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    res.json(formatInventory(rows[0]));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Requests ──────────────────────────────────────────────
app.get('/api/requests', auth, async (req, res) => {
  try {
    const bid = req.user.businessId;
    if (!bid) return res.json([]);
    const { rows } = await pool.query('SELECT * FROM requests WHERE business_id = $1 ORDER BY created_at DESC', [bid]);
    res.json(rows.map(formatRequest));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/requests', auth, async (req, res) => {
  try {
    const bid = needBusiness(req, res); if (!bid) return;
    const { type, staffId, date, reason, swapWith, swapDay, productId, quantity } = req.body;
    if (!type || !staffId) return res.status(400).json({ error: 'type and staffId required' });
    const validTypes = ['sick', 'dayoff', 'swap', 'stock_request'];
    if (!validTypes.includes(type)) return res.status(400).json({ error: 'invalid type' });
    const { rows } = await pool.query(
      'INSERT INTO requests (business_id, type, staff_id, date, reason, swap_with, swap_day, product_id, quantity) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
      [bid, type, Number(staffId), date || null, reason || '', swapWith || null, swapDay || null, productId || null, quantity || 0]
    );
    res.status(201).json(formatRequest(rows[0]));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/requests/:id', auth, async (req, res) => {
  try {
    const bid = needBusiness(req, res); if (!bid) return;
    const { status, reassignToStaffId } = req.body;
    const { rows: reqRows } = await pool.query('SELECT * FROM requests WHERE id=$1 AND business_id=$2', [req.params.id, bid]);
    if (!reqRows.length) return res.status(404).json({ error: 'not found' });
    const request = reqRows[0];

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      if (status === 'approved' && request.type === 'sick' && reassignToStaffId) {
        await client.query(
          `UPDATE bookings SET staff_id=$1 WHERE staff_id=$2 AND date = $3::date`,
          [reassignToStaffId, request.staff_id, request.date]
        );
      }

      if (status === 'approved' && request.type === 'stock_request' && request.product_id) {
        await client.query(
          'UPDATE inventory SET stock = stock + $1 WHERE id=$2',
          [request.quantity || 0, request.product_id]
        );
      }

      const { rows } = await client.query(
        'UPDATE requests SET status=$1 WHERE id=$2 AND business_id=$3 RETURNING *',
        [status, req.params.id, bid]
      );

      await client.query('COMMIT');
      res.json(formatRequest(rows[0]));
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Announcements ─────────────────────────────────────────
app.get('/api/announcements', auth, async (req, res) => {
  try {
    const bid = req.user.businessId;
    if (!bid) return res.json([]);
    const { rows } = await pool.query('SELECT * FROM announcements WHERE business_id = $1 ORDER BY created_at DESC', [bid]);
    res.json(rows.map(formatAnnouncement));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/announcements', auth, async (req, res) => {
  try {
    const bid = needBusiness(req, res); if (!bid) return;
    const { title, body, from } = req.body;
    if (!body) return res.status(400).json({ error: 'body required' });
    const { rows } = await pool.query(
      'INSERT INTO announcements (business_id, title, body, "from") VALUES ($1,$2,$3,$4) RETURNING *',
      [bid, title || '', body, from || 'Management']
    );
    res.status(201).json(formatAnnouncement(rows[0]));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/announcements/:id', auth, async (req, res) => {
  try {
    const bid = needBusiness(req, res); if (!bid) return;
    const { rows } = await pool.query('DELETE FROM announcements WHERE id=$1 AND business_id=$2 RETURNING *', [req.params.id, bid]);
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    res.json(formatAnnouncement(rows[0]));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── SOP ───────────────────────────────────────────────────
app.get('/api/sop', auth, async (req, res) => {
  try {
    const bid = req.user.businessId;
    if (!bid) return res.json([]);
    const { rows } = await pool.query('SELECT * FROM sop WHERE business_id = $1 ORDER BY id', [bid]);
    res.json(rows.map(formatSop));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/sop', auth, async (req, res) => {
  try {
    const bid = needBusiness(req, res); if (!bid) return;
    const { title, body, category } = req.body;
    if (!title) return res.status(400).json({ error: 'title required' });
    const { rows } = await pool.query(
      'INSERT INTO sop (business_id, title, body, category) VALUES ($1,$2,$3,$4) RETURNING *',
      [bid, title, body || '', category || 'General']
    );
    res.status(201).json(formatSop(rows[0]));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Violations ────────────────────────────────────────────
app.get('/api/violations', auth, async (req, res) => {
  try {
    const bid = req.user.businessId;
    if (!bid) return res.json([]);
    const { rows } = await pool.query('SELECT * FROM violations WHERE business_id = $1 ORDER BY created_at DESC', [bid]);
    res.json(rows.map(formatViolation));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/violations', auth, async (req, res) => {
  try {
    const bid = needBusiness(req, res); if (!bid) return;
    const { staffId, sopId, note } = req.body;
    if (!staffId) return res.status(400).json({ error: 'staffId required' });
    const { rows } = await pool.query(
      'INSERT INTO violations (business_id, staff_id, sop_id, note) VALUES ($1,$2,$3,$4) RETURNING *',
      [bid, staffId, sopId || null, note || '']
    );
    res.status(201).json(formatViolation(rows[0]));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/violations/:id', auth, async (req, res) => {
  try {
    const bid = needBusiness(req, res); if (!bid) return;
    const { rows } = await pool.query('DELETE FROM violations WHERE id=$1 AND business_id=$2 RETURNING *', [req.params.id, bid]);
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    res.json(formatViolation(rows[0]));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Error handler ─────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Internal server error' });
});

// ── Start ─────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
initDB()
  .then(() => app.listen(PORT, () => console.log(`SpaPilot backend running on port ${PORT}`)))
  .catch(err => { console.error('DB init failed:', err); process.exit(1); });
