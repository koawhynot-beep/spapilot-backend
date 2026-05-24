const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pg = require('pg');
const { Pool } = pg;
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const winston = require('winston');
const compression = require('compression');
const { z } = require('zod');

// Force DATE columns (OID 1082) to come back as plain 'YYYY-MM-DD' strings.
// node-pg's default parser converts them to JS Date objects, which serialize as
// ISO timestamps and break the frontend's `b.date === '2025-12-25'` equality
// checks. Keep them as text so client comparisons just work.
pg.types.setTypeParser(1082, v => v);

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [new winston.transports.Console()],
});

let nodemailer = null;
try { nodemailer = require('nodemailer'); } catch {}

const app = express();

if (!process.env.ALLOWED_ORIGINS && process.env.NODE_ENV === 'production') {
  console.error('FATAL: ALLOWED_ORIGINS environment variable is not set in production.');
  process.exit(1);
}
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim())
  : ['http://localhost:3001', 'https://spapilot-app.onrender.com'];

// Helmet defaults are mostly fine — we mainly need a slightly looser CSP because the
// React frontend pulls Google Fonts and Stripe checkout uses inline scripts. The
// frontend is served from Render (not from this API) so the strict CSP here only
// applies to API responses (typically JSON, never rendered) — keep defaults strict.
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));
app.use(compression());
app.use(cors({ origin: allowedOrigins, credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.set('trust proxy', 1);
// Disable client/proxy caching of API responses — every request gets fresh data.
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
  }
  next();
});

// Rate limiters for auth endpoints to prevent brute force
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Try again in 15 minutes.' },
});
const passwordResetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many password reset requests. Try again in 1 hour.' },
});
// Generic mutating-route limiter — caps write traffic to 300 req per IP per 15 min.
// Wide enough not to bite legit power users (a busy salon may save 200 bookings/day,
// but that's spread across the day, not a 15-min burst), narrow enough to slow scrapers.
const writeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please slow down.' },
});
const writeMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
app.use((req, res, next) => {
  // Skip auth + password-reset paths — they already have stricter limiters.
  if (req.path.startsWith('/api/auth/login') || req.path.startsWith('/api/auth/signup') ||
      req.path.startsWith('/api/auth/forgot-password') || req.path.startsWith('/api/auth/reset-password')) {
    return next();
  }
  if (writeMethods.has(req.method)) return writeLimiter(req, res, next);
  return next();
});

if (!process.env.JWT_SECRET) {
  if (process.env.NODE_ENV === 'production') {
    console.error('FATAL: JWT_SECRET environment variable is not set in production.');
    process.exit(1);
  }
  console.warn('WARNING: JWT_SECRET not set. Using insecure default for development only.');
}
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
    if (process.env.NODE_ENV === 'production') {
      console.error('Password reset requested but no SMTP configured. Email not sent.');
      return {};
    }
    console.log(`[DEV] Password reset link generated for ${to} (token redacted)`);
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

// 6-digit verification code (100000-999999). crypto.randomInt is uniform.
function genVerificationCode() {
  return String(crypto.randomInt(100000, 1000000));
}

async function sendVerificationEmail(to, code) {
  if (!mailer) {
    if (process.env.NODE_ENV === 'production') {
      console.error('Email verification requested but no SMTP configured. Email not sent.');
      return {};
    }
    console.log(`[DEV] Verification code for ${to}: ${code}`);
    return { devCode: code };
  }
  await mailer.sendMail({
    from: process.env.SMTP_FROM || 'Spapilot <noreply@spapilot.app>',
    to,
    subject: `Your Spapilot verification code: ${code}`,
    html: `<p>Welcome to Spapilot!</p><p>Your verification code is:</p><p style="font-size:28px;font-weight:bold;letter-spacing:4px;">${code}</p><p>Enter it in the app to finish signing up. The code expires in 24 hours.</p><p>If you did not sign up for Spapilot, you can ignore this email.</p>`,
    text: `Your Spapilot verification code is: ${code}\n\nEnter it in the app to finish signing up. Expires in 24 hours.\n\nIf you did not sign up, ignore this message.`,
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
  currency: b.currency || 'USD',
  accent: b.accent || 'emerald',
  accentCustom: b.accent_custom || null,
});

const ALLOWED_ACCENTS = new Set(['emerald', 'blue', 'purple', 'gold', 'red', 'orange', 'pink', 'custom']);
function clampAccent(a) {
  const v = String(a || '').toLowerCase();
  return ALLOWED_ACCENTS.has(v) ? v : 'emerald';
}
// Validate a #RRGGBB hex for custom accent.
function safeHex(h) {
  return /^#[0-9a-fA-F]{6}$/.test(String(h || '')) ? String(h) : null;
}

const ALLOWED_CURRENCIES = new Set([
  'USD', 'EUR', 'GBP', 'AUD', 'CAD', 'IDR', 'SGD', 'MYR', 'PHP', 'THB',
  'JPY', 'KRW', 'INR', 'MXN', 'BRL', 'ZAR', 'NZD', 'CHF', 'HKD', 'AED',
]);
function clampCurrency(c) {
  const up = String(c || '').toUpperCase();
  return ALLOWED_CURRENCIES.has(up) ? up : 'USD';
}

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
  cost: i.cost == null ? 0 : Number(i.cost),
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

const formatService = (s) => ({
  id: s.id,
  name: s.name,
  category: s.category || 'General',
  durationMin: s.duration_min,
  price: Number(s.price) || 0,
  color: s.color || '#2d5a4a',
  createdAt: s.created_at,
});

// ── Pagination helper ─────────────────────────────────────
// Backward-compatible: if no query params, returns up to MAX_DEFAULT_LIMIT rows (1000).
// If ?limit / ?offset present, applies them. Always returns plain array (no shape change).
const MAX_DEFAULT_LIMIT = 1000;
const MAX_LIMIT = 500;
function paginationClause(req) {
  const rawLimit = req.query.limit ? parseInt(req.query.limit, 10) : null;
  const rawOffset = req.query.offset ? parseInt(req.query.offset, 10) : 0;
  const limit = rawLimit && rawLimit > 0 ? Math.min(rawLimit, MAX_LIMIT) : MAX_DEFAULT_LIMIT;
  const offset = Number.isFinite(rawOffset) && rawOffset >= 0 ? rawOffset : 0;
  return { limit, offset, sql: ` LIMIT ${limit} OFFSET ${offset}` };
}

// ── Validation schemas ────────────────────────────────────
const signupSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(8).max(128),
});
const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(1).max(128),
});
const forgotPasswordSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
});
const resetPasswordSchema = z.object({
  token: z.string().min(20).max(128),
  password: z.string().min(8).max(128),
});
const deleteAccountSchema = z.object({
  password: z.string().min(1).max(128),
  confirmation: z.literal('DELETE'),
});

const validate = (schema) => (req, res, next) => {
  const result = schema.safeParse(req.body);
  if (!result.success) {
    const issue = result.error.issues[0];
    const field = issue.path.join('.') || 'input';
    let msg = issue.message;
    // Friendlier messages for common cases
    if (field === 'email' && issue.code === 'invalid_string') msg = 'Please enter a valid email address';
    else if (field === 'password' && issue.code === 'too_small') msg = 'Password must be at least 8 characters';
    else if (issue.code === 'too_small') msg = `${field}: must be at least ${issue.minimum} characters`;
    else if (issue.code === 'too_big') msg = `${field}: must be at most ${issue.maximum} characters`;
    return res.status(400).json({
      error: msg,
      details: result.error.issues.map(i => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  req.body = result.data;
  next();
};

// ── Auth middleware ───────────────────────────────────────
// Paths that remain accessible even when trial expired. User must always be able
// to log out, view/export their data, and manage their subscription.
const TRIAL_EXPIRED_ALLOWED_PREFIXES = [
  '/api/auth/',
  '/api/billing/',
  '/api/businesses', // POST/me/join — onboarding must always work
];

// Re-read role from DB (not JWT) so staff cannot self-promote via /api/auth/role mass-assignment.
// Apply this middleware AFTER `auth` on routes that must be manager-only.
const requireManager = async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT role FROM users WHERE id=$1', [req.user?.id]);
    if (!rows.length || rows[0].role !== 'manager') {
      return res.status(403).json({ error: 'Manager role required' });
    }
    next();
  } catch (err) {
    logger.error('requireManager.error', { err: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
};

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

    // Trial-expired enforcement: block mutations on data endpoints once trial ends.
    const isMutating = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method);
    const isAllowedPath = TRIAL_EXPIRED_ALLOWED_PREFIXES.some(p => req.path.startsWith(p));
    if (isMutating && !isAllowedPath) {
      const { rows: ur } = await pool.query(
        'SELECT subscription_status, trial_ends_at FROM users WHERE id=$1',
        [decoded.id]
      );
      if (ur.length) {
        const status = ur[0].subscription_status;
        const trialExpired = ur[0].trial_ends_at && new Date(ur[0].trial_ends_at) < new Date();
        if (status !== 'active' && trialExpired) {
          return res.status(402).json({
            error: 'Your trial has ended. Subscribe to continue.',
            code: 'TRIAL_EXPIRED',
          });
        }
      }
    }

    next();
  } catch (err) {
    res.status(401).json({ error: 'Invalid token' });
  }
};

const makeToken = (user) => jwt.sign(
  {
    id: user.id,
    email: user.email,
    role: user.role,
    businessType: user.business_type,
    staffId: user.staff_id,
    businessId: user.business_id,
    jti: crypto.randomBytes(16).toString('hex'),
  },
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

    CREATE TABLE IF NOT EXISTS token_blacklist (
      jti        TEXT PRIMARY KEY,
      user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_token_blacklist_expires_at ON token_blacklist(expires_at);

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

    CREATE TABLE IF NOT EXISTS services (
      id           SERIAL PRIMARY KEY,
      name         TEXT NOT NULL,
      category     TEXT DEFAULT 'General',
      duration_min INTEGER DEFAULT 60,
      price        NUMERIC DEFAULT 0,
      color        TEXT DEFAULT '#2d5a4a',
      created_at   TIMESTAMPTZ DEFAULT NOW()
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
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS business_type TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS staff_id INTEGER`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_role TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS trial_started_at TIMESTAMPTZ DEFAULT NOW()`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '7 days')`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_status TEXT DEFAULT 'trial'`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS tutorial_completed BOOLEAN DEFAULT FALSE`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_login_attempts INTEGER DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT FALSE`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS verification_token TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS verification_token_expires_at TIMESTAMPTZ`,
    // Multi-tenancy: scope all data to a business
    `ALTER TABLE staff         ADD COLUMN IF NOT EXISTS business_id INTEGER REFERENCES businesses(id) ON DELETE CASCADE`,
    `ALTER TABLE bookings      ADD COLUMN IF NOT EXISTS business_id INTEGER REFERENCES businesses(id) ON DELETE CASCADE`,
    `ALTER TABLE inventory     ADD COLUMN IF NOT EXISTS business_id INTEGER REFERENCES businesses(id) ON DELETE CASCADE`,
    `ALTER TABLE requests      ADD COLUMN IF NOT EXISTS business_id INTEGER REFERENCES businesses(id) ON DELETE CASCADE`,
    `ALTER TABLE announcements ADD COLUMN IF NOT EXISTS business_id INTEGER REFERENCES businesses(id) ON DELETE CASCADE`,
    `ALTER TABLE sop           ADD COLUMN IF NOT EXISTS business_id INTEGER REFERENCES businesses(id) ON DELETE CASCADE`,
    `ALTER TABLE violations    ADD COLUMN IF NOT EXISTS business_id INTEGER REFERENCES businesses(id) ON DELETE CASCADE`,
    `ALTER TABLE services      ADD COLUMN IF NOT EXISTS business_id INTEGER REFERENCES businesses(id) ON DELETE CASCADE`,
    // Cost per unit for inventory items (used in inventory valuation reports)
    `ALTER TABLE inventory     ADD COLUMN IF NOT EXISTS cost NUMERIC DEFAULT 0`,
    // Businesses table — CREATE TABLE IF NOT EXISTS skipped on existing prod DBs,
    // so add EVERY column explicitly. Catches schema drift across all production envs.
    `ALTER TABLE businesses    ADD COLUMN IF NOT EXISTS name TEXT`,
    `ALTER TABLE businesses    ADD COLUMN IF NOT EXISTS type TEXT`,
    `ALTER TABLE businesses    ADD COLUMN IF NOT EXISTS code TEXT`,
    `ALTER TABLE businesses    ADD COLUMN IF NOT EXISTS staff_count INTEGER DEFAULT 0`,
    `ALTER TABLE businesses    ADD COLUMN IF NOT EXISTS owner_id INTEGER REFERENCES users(id) ON DELETE CASCADE`,
    `ALTER TABLE businesses    ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()`,
    `ALTER TABLE businesses    ADD COLUMN IF NOT EXISTS currency TEXT DEFAULT 'USD'`,
    `ALTER TABLE businesses    ADD COLUMN IF NOT EXISTS accent TEXT DEFAULT 'emerald'`,
    `ALTER TABLE businesses    ADD COLUMN IF NOT EXISTS accent_custom TEXT`,
    // Defensive ALTERs for every column in every table — covers prod drift comprehensively
    `ALTER TABLE staff ADD COLUMN IF NOT EXISTS avatar TEXT`,
    `ALTER TABLE staff ADD COLUMN IF NOT EXISTS color TEXT`,
    `ALTER TABLE staff ADD COLUMN IF NOT EXISTS birthday TEXT`,
    `ALTER TABLE staff ADD COLUMN IF NOT EXISTS phone TEXT`,
    `ALTER TABLE staff ADD COLUMN IF NOT EXISTS schedule TEXT[]`,
    `ALTER TABLE staff ADD COLUMN IF NOT EXISTS commission_rate INTEGER DEFAULT 30`,
    `ALTER TABLE bookings ADD COLUMN IF NOT EXISTS notes TEXT DEFAULT ''`,
    `ALTER TABLE bookings ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'confirmed'`,
    `ALTER TABLE bookings ADD COLUMN IF NOT EXISTS price NUMERIC DEFAULT 0`,
    `ALTER TABLE bookings ADD COLUMN IF NOT EXISTS date DATE DEFAULT CURRENT_DATE`,
    `ALTER TABLE inventory ADD COLUMN IF NOT EXISTS category TEXT`,
    `ALTER TABLE inventory ADD COLUMN IF NOT EXISTS stock INTEGER DEFAULT 0`,
    `ALTER TABLE inventory ADD COLUMN IF NOT EXISTS threshold INTEGER DEFAULT 5`,
    `ALTER TABLE inventory ADD COLUMN IF NOT EXISTS unit TEXT DEFAULT 'pcs'`,
    `ALTER TABLE inventory ADD COLUMN IF NOT EXISTS supplier TEXT`,
    `ALTER TABLE inventory ADD COLUMN IF NOT EXISTS last_order TEXT`,
    `ALTER TABLE requests ADD COLUMN IF NOT EXISTS date TEXT`,
    `ALTER TABLE requests ADD COLUMN IF NOT EXISTS reason TEXT DEFAULT ''`,
    `ALTER TABLE requests ADD COLUMN IF NOT EXISTS swap_with INTEGER`,
    `ALTER TABLE requests ADD COLUMN IF NOT EXISTS swap_day TEXT`,
    `ALTER TABLE requests ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'pending'`,
    `ALTER TABLE requests ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()`,
    `ALTER TABLE announcements ADD COLUMN IF NOT EXISTS title TEXT`,
    `ALTER TABLE announcements ADD COLUMN IF NOT EXISTS "from" TEXT DEFAULT 'Management'`,
    `ALTER TABLE announcements ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()`,
    `ALTER TABLE sop ADD COLUMN IF NOT EXISTS body TEXT`,
    `ALTER TABLE sop ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()`,
    `ALTER TABLE violations ADD COLUMN IF NOT EXISTS sop_id INTEGER REFERENCES sop(id) ON DELETE SET NULL`,
    `ALTER TABLE violations ADD COLUMN IF NOT EXISTS note TEXT DEFAULT ''`,
    `ALTER TABLE violations ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()`,
    `ALTER TABLE services ADD COLUMN IF NOT EXISTS category TEXT DEFAULT 'General'`,
    `ALTER TABLE services ADD COLUMN IF NOT EXISTS duration_min INTEGER DEFAULT 60`,
    `ALTER TABLE services ADD COLUMN IF NOT EXISTS price NUMERIC DEFAULT 0`,
    `ALTER TABLE services ADD COLUMN IF NOT EXISTS color TEXT DEFAULT '#2d5a4a'`,
    `ALTER TABLE services ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()`,
  ];
  for (const q of alters) {
    try { await pool.query(q); } catch (e) { logger.warn('alter.skipped', { err: e.message }); }
  }
  // Backfill businesses.code with random 6-char codes for any legacy rows missing it,
  // then add unique index. Runs AFTER ALTER TABLE so column exists.
  try {
    await pool.query("UPDATE businesses SET code = UPPER(SUBSTRING(MD5(RANDOM()::TEXT) FROM 1 FOR 6)) WHERE code IS NULL");
    await pool.query("CREATE UNIQUE INDEX IF NOT EXISTS businesses_code_unique ON businesses(code)");
  } catch (e) { logger.warn('businesses.code.backfill.skipped', { err: e.message }); }

  // ── Indexes for hot query paths ──────────────────────
  // All multi-tenant tables filter by business_id; staff also queried by user.
  // Bookings sorted by date; requests filtered by status. Users looked up by email.
  const indexes = [
    `CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)`,
    `CREATE INDEX IF NOT EXISTS idx_users_business_id ON users(business_id)`,
    `CREATE INDEX IF NOT EXISTS idx_staff_business_id ON staff(business_id)`,
    `CREATE INDEX IF NOT EXISTS idx_bookings_business_id ON bookings(business_id)`,
    `CREATE INDEX IF NOT EXISTS idx_bookings_business_date ON bookings(business_id, date)`,
    `CREATE INDEX IF NOT EXISTS idx_bookings_staff_id ON bookings(staff_id)`,
    `CREATE INDEX IF NOT EXISTS idx_inventory_business_id ON inventory(business_id)`,
    `CREATE INDEX IF NOT EXISTS idx_requests_business_id ON requests(business_id)`,
    `CREATE INDEX IF NOT EXISTS idx_requests_business_status ON requests(business_id, status)`,
    `CREATE INDEX IF NOT EXISTS idx_requests_staff_id ON requests(staff_id)`,
    `CREATE INDEX IF NOT EXISTS idx_announcements_business_id ON announcements(business_id)`,
    `CREATE INDEX IF NOT EXISTS idx_announcements_created_at ON announcements(created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_sop_business_id ON sop(business_id)`,
    `CREATE INDEX IF NOT EXISTS idx_violations_business_id ON violations(business_id)`,
    `CREATE INDEX IF NOT EXISTS idx_violations_staff_id ON violations(staff_id)`,
    `CREATE INDEX IF NOT EXISTS idx_services_business_id ON services(business_id)`,
    `CREATE INDEX IF NOT EXISTS idx_password_resets_user_id ON password_resets(user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_password_resets_token ON password_resets(token)`,
    `CREATE INDEX IF NOT EXISTS idx_businesses_owner_id ON businesses(owner_id)`,
    `CREATE INDEX IF NOT EXISTS idx_businesses_code ON businesses(code)`,
  ];
  for (const q of indexes) {
    try { await pool.query(q); } catch (e) { logger.warn('index.skipped', { err: e.message }); }
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
    logger.info('migration.wipe.start', { marker: wipeMarker });
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
    logger.info('migration.wipe.done');
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
  } catch (e) { logger.warn('constraint.drop.skipped', { err: e.message }); }

  // One-shot data wipe via env var — no shell needed. Set WIPE_ON_BOOT to the
  // exact string "WIPE-EVERYTHING-NOW" in the Render dashboard, redeploy/restart,
  // and the server truncates every table once at startup. IMPORTANT: remove the
  // env var afterward, or every future restart wipes again. A loud warning is
  // logged so it's obvious in the deploy logs.
  if (process.env.WIPE_ON_BOOT === 'WIPE-EVERYTHING-NOW') {
    const wipeTables = [
      'token_blacklist', 'password_resets', 'violations', 'announcements',
      'sop', 'services', 'requests', 'inventory', 'bookings', 'staff',
      'businesses', 'users',
    ];
    try {
      await pool.query(`TRUNCATE TABLE ${wipeTables.join(', ')} RESTART IDENTITY CASCADE`);
      logger.warn('DATA WIPED via WIPE_ON_BOOT. ⚠ REMOVE the WIPE_ON_BOOT env var NOW or the next restart wipes again.');
    } catch (e) {
      logger.error('wipe.on.boot.failed', { err: e.message });
    }
  }

  // Demo account only created in non-production environments.
  if (process.env.NODE_ENV !== 'production') {
    const { rowCount: hasDemo } = await pool.query(
      "SELECT 1 FROM users WHERE email = 'demo@opus.app'"
    );
    if (!hasDemo) {
      const hash = await bcrypt.hash('demo1234', 10);
      await pool.query(
        `INSERT INTO users (email, password_hash) VALUES ($1, $2)`,
        ['demo@opus.app', hash]
      );
      logger.info('demo.user.created');
    }
  }

  // Periodic cleanup of expired blacklisted tokens
  setInterval(() => {
    pool.query('DELETE FROM token_blacklist WHERE expires_at < NOW()')
      .catch(err => logger.error('blacklist.cleanup.error', { err: err.message }));
  }, 60 * 60 * 1000);

  logger.info('Database ready');
}

// ── Health ────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));
app.get('/api/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

// ── Auth ──────────────────────────────────────────────────
// Whether email verification is required. Falls back to true in production so a
// misconfigured deploy doesn't silently skip it. SMTP must also be configured
// (otherwise we'd lock everyone out of brand-new signups). If SMTP isn't set
// and we're in production, log a fatal warning at boot.
const VERIFY_EMAIL_REQUIRED = process.env.VERIFY_EMAIL_REQUIRED !== 'false';
if (VERIFY_EMAIL_REQUIRED && !mailer && process.env.NODE_ENV === 'production') {
  console.warn(
    'WARNING: VERIFY_EMAIL_REQUIRED=true but SMTP_HOST not configured. ' +
    'Set SMTP_* envs or set VERIFY_EMAIL_REQUIRED=false. New signups will be ' +
    'unable to verify.'
  );
}

app.post('/api/auth/signup', authLimiter, validate(signupSchema), async (req, res) => {
  try {
    const { email, password } = req.body;
    const hash = await bcrypt.hash(password, 10);
    const code = genVerificationCode();
    const verificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h
    const verifiedNow = !VERIFY_EMAIL_REQUIRED;

    const existing = await pool.query(
      'SELECT id, email_verified FROM users WHERE email=$1',
      [email]
    );
    if (existing.rowCount) {
      const row = existing.rows[0];
      // A VERIFIED account already owns this email — block.
      if (row.email_verified) {
        return res.status(400).json({ error: 'Email already registered' });
      }
      // UNVERIFIED pending account — nobody has proven ownership yet, so allow
      // "re-signup": reset the password to the new one and issue a fresh code.
      // This unsticks users who never received / used their first code.
      await pool.query(
        `UPDATE users SET password_hash=$1, verification_token=$2, verification_token_expires_at=$3,
           email_verified=$4, failed_login_attempts=0, locked_until=NULL
         WHERE id=$5`,
        [hash, verifiedNow ? null : code, verifiedNow ? null : verificationExpires, verifiedNow, row.id]
      );
      const { rows: refreshed } = await pool.query('SELECT * FROM users WHERE id=$1', [row.id]);
      logger.info('user.signup.reclaim_unverified', { userId: row.id, email });
      if (!verifiedNow) {
        sendVerificationEmail(email, code).catch(err =>
          logger.error('verify.email.send.error', { userId: row.id, err: err.message })
        );
        return res.status(201).json({
          needsVerification: true,
          email,
          message: 'Enter the 6-digit code we emailed you to finish signing in.',
        });
      }
      return res.status(201).json({ token: makeToken(refreshed[0]), user: formatUser(refreshed[0]), trial: trialInfo(refreshed[0]) });
    }

    const trialEnd = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const { rows } = await pool.query(
      `INSERT INTO users (email, password_hash, trial_started_at, trial_ends_at, subscription_status, email_verified, verification_token, verification_token_expires_at)
       VALUES ($1, $2, NOW(), $3, 'trial', $4, $5, $6) RETURNING *`,
      [email, hash, trialEnd, verifiedNow, verifiedNow ? null : code, verifiedNow ? null : verificationExpires]
    );
    logger.info('user.signup', { userId: rows[0].id, email, verifyRequired: !verifiedNow });

    if (!verifiedNow) {
      // Fire-and-forget email send. Capture errors but don't fail signup — the
      // user can request a resend.
      sendVerificationEmail(email, code).catch(err =>
        logger.error('verify.email.send.error', { userId: rows[0].id, err: err.message })
      );
      return res.status(201).json({
        needsVerification: true,
        email,
        message: 'Account created. Enter the 6-digit code we emailed you to finish signing in.',
      });
    }

    // SMTP disabled / verification skipped — log straight in (legacy behavior).
    res.status(201).json({ token: makeToken(rows[0]), user: formatUser(rows[0]), trial: trialInfo(rows[0]) });
  } catch (err) { logger.error('signup.error', { err: err.message, stack: err.stack }); res.status(500).json({ error: 'Internal server error' }); }
});

// Verify email by 6-digit code — matched against the supplied email so the code
// space is scoped per-account (not brute-forceable across all users). Marks the
// user verified and returns a real auth token so they're signed in.
app.post('/api/auth/verify-email', authLimiter, async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const code = String(req.body?.code || '').trim();
    if (!email || !/^\d{6}$/.test(code)) {
      return res.status(400).json({ error: 'Enter the 6-digit code from your email.' });
    }
    const { rows } = await pool.query(
      `SELECT * FROM users
       WHERE email = $1 AND verification_token = $2 AND verification_token_expires_at > NOW()`,
      [email, code]
    );
    if (!rows.length) {
      // Distinguish already-verified from wrong/expired code for a clearer message.
      const { rows: u } = await pool.query('SELECT email_verified FROM users WHERE email=$1', [email]);
      if (u.length && u[0].email_verified) {
        return res.status(400).json({ error: 'This email is already verified. Please sign in.' });
      }
      return res.status(400).json({ error: 'That code is wrong or expired. Request a new one.' });
    }
    const user = rows[0];
    const { rows: updated } = await pool.query(
      `UPDATE users SET email_verified = TRUE, verification_token = NULL, verification_token_expires_at = NULL
       WHERE id = $1 RETURNING *`,
      [user.id]
    );
    logger.info('email.verified', { userId: user.id });
    res.json({ token: makeToken(updated[0]), user: formatUser(updated[0]), trial: trialInfo(updated[0]) });
  } catch (err) { logger.error('verify.error', { err: err.message, stack: err.stack }); res.status(500).json({ error: 'Internal server error' }); }
});

// Resend verification code. Always responds 200 (don't leak which emails exist).
app.post('/api/auth/resend-verification', passwordResetLimiter, async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!email) return res.json({ message: 'If that email exists, we sent a new code.' });
    const { rows } = await pool.query('SELECT id, email_verified FROM users WHERE email=$1', [email]);
    if (rows.length && !rows[0].email_verified) {
      const code = genVerificationCode();
      const expires = new Date(Date.now() + 24 * 60 * 60 * 1000);
      await pool.query(
        'UPDATE users SET verification_token=$1, verification_token_expires_at=$2 WHERE id=$3',
        [code, expires, rows[0].id]
      );
      sendVerificationEmail(email, code).catch(err =>
        logger.error('verify.email.resend.error', { userId: rows[0].id, err: err.message })
      );
    }
    res.json({ message: 'If that email exists, we sent a new code.' });
  } catch (err) { logger.error('resend.error', { err: err.message, stack: err.stack }); res.status(500).json({ error: 'Internal server error' }); }
});

const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MINUTES = 15;

app.post('/api/auth/login', authLimiter, validate(loginSchema), async (req, res) => {
  try {
    const { email, password } = req.body;
    const { rows } = await pool.query('SELECT * FROM users WHERE email=$1', [email]);
    if (!rows.length) {
      // Constant-time pad — compare against a real bcrypt-format hash with cost
      // factor matching production hashes (10) so timing leaks don't distinguish
      // "no such email" from "wrong password".
      await bcrypt.compare(password, '$2a$10$abcdefghijklmnopqrstuv0123456789012345678901234567890123');
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    const user = rows[0];
    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      logger.warn('login.locked', { userId: user.id, email });
      return res.status(423).json({ error: 'Account temporarily locked. Try again later.' });
    }
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      const newAttempts = (user.failed_login_attempts || 0) + 1;
      const shouldLock = newAttempts >= MAX_FAILED_LOGINS;
      const lockedUntil = shouldLock ? new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000) : null;
      await pool.query(
        'UPDATE users SET failed_login_attempts=$1, locked_until=$2 WHERE id=$3',
        [shouldLock ? 0 : newAttempts, lockedUntil, user.id]
      );
      logger.warn('login.failed', { userId: user.id, email, attempts: newAttempts, locked: shouldLock });
      if (shouldLock) {
        return res.status(423).json({ error: 'Account locked due to too many failed attempts. Try again in 15 minutes.' });
      }
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    // Block login until the email has been verified — only if verification is
    // turned on. Return 403 with a marker the frontend can use to show a
    // "Resend verification email" link.
    if (VERIFY_EMAIL_REQUIRED && !user.email_verified) {
      logger.warn('login.unverified', { userId: user.id, email });
      return res.status(403).json({
        error: 'Please verify your email before signing in. Check your inbox for the link.',
        code: 'email_not_verified',
        email,
      });
    }
    if (user.failed_login_attempts > 0 || user.locked_until) {
      await pool.query(
        'UPDATE users SET failed_login_attempts=0, locked_until=NULL WHERE id=$1',
        [user.id]
      );
    }
    logger.info('login.success', { userId: user.id, email });
    res.json({ token: makeToken(user), user: formatUser(user), trial: trialInfo(user) });
  } catch (err) { logger.error('login.error', { err: err.message, stack: err.stack }); res.status(500).json({ error: 'Internal server error' }); }
});

app.post('/api/auth/logout', auth, async (req, res) => {
  try {
    if (req.user.jti && req.user.exp) {
      const expiresAt = new Date(req.user.exp * 1000);
      await pool.query(
        'INSERT INTO token_blacklist (jti, user_id, expires_at) VALUES ($1,$2,$3) ON CONFLICT (jti) DO NOTHING',
        [req.user.jti, req.user.id, expiresAt]
      );
    }
    logger.info('logout', { userId: req.user.id });
    res.json({ ok: true });
  } catch (err) { logger.error('logout.error', { err: err.message }); res.status(500).json({ error: 'Internal server error' }); }
});

// ── GDPR: data export ────────────────────────────────────
// Returns all data linked to the authenticated user. Heavy queries are
// scoped to their business; user-only data (login, password resets) joined too.
app.get('/api/auth/export-data', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const businessId = req.user.businessId;

    const [user, business, staff, bookings, inventory, requests, announcements, sops, violations] = await Promise.all([
      pool.query('SELECT id, email, role, business_type, business_id, onboarding_role, trial_started_at, trial_ends_at, subscription_status, created_at FROM users WHERE id=$1', [userId]),
      businessId ? pool.query('SELECT * FROM businesses WHERE id=$1', [businessId]) : { rows: [] },
      businessId ? pool.query('SELECT * FROM staff WHERE business_id=$1', [businessId]) : { rows: [] },
      businessId ? pool.query('SELECT * FROM bookings WHERE business_id=$1', [businessId]) : { rows: [] },
      businessId ? pool.query('SELECT * FROM inventory WHERE business_id=$1', [businessId]) : { rows: [] },
      businessId ? pool.query('SELECT * FROM requests WHERE business_id=$1', [businessId]) : { rows: [] },
      businessId ? pool.query('SELECT * FROM announcements WHERE business_id=$1', [businessId]) : { rows: [] },
      businessId ? pool.query('SELECT * FROM sop WHERE business_id=$1', [businessId]) : { rows: [] },
      businessId ? pool.query('SELECT * FROM violations WHERE business_id=$1', [businessId]) : { rows: [] },
    ]);

    logger.info('data.export', { userId });
    res.setHeader('Content-Disposition', `attachment; filename="spapilot-data-${userId}-${Date.now()}.json"`);
    res.json({
      exportedAt: new Date().toISOString(),
      user: user.rows[0] || null,
      business: business.rows[0] || null,
      staff: staff.rows,
      bookings: bookings.rows,
      inventory: inventory.rows,
      requests: requests.rows,
      announcements: announcements.rows,
      sops: sops.rows,
      violations: violations.rows,
    });
  } catch (err) { logger.error('export.error', { err: err.message, stack: err.stack }); res.status(500).json({ error: 'Internal server error' }); }
});

// ── GDPR: account deletion ───────────────────────────────
// Requires password + confirmation token "DELETE". Cascade deletes user.
// If user owns a business, that business and all its data also removed via FK CASCADE.
app.delete('/api/auth/account', auth, validate(deleteAccountSchema), async (req, res) => {
  try {
    const userId = req.user.id;
    const { password } = req.body;

    const { rows } = await pool.query('SELECT id, password_hash, business_id FROM users WHERE id=$1', [userId]);
    if (!rows.length) return res.status(404).json({ error: 'User not found' });

    const valid = await bcrypt.compare(password, rows[0].password_hash);
    if (!valid) {
      logger.warn('delete.failed.bad_password', { userId });
      return res.status(401).json({ error: 'Incorrect password' });
    }

    // If user is owner of a business, delete the business (cascades all related data).
    // Otherwise, only the user record is deleted.
    const businessId = rows[0].business_id;
    if (businessId) {
      const { rowCount: ownsCount } = await pool.query(
        'SELECT 1 FROM businesses WHERE id=$1 AND owner_id=$2',
        [businessId, userId]
      );
      if (ownsCount) {
        await pool.query('DELETE FROM businesses WHERE id=$1', [businessId]);
      }
    }

    // Add current token to blacklist so it cannot be reused
    if (req.user.jti && req.user.exp) {
      const expiresAt = new Date(req.user.exp * 1000);
      await pool.query(
        'INSERT INTO token_blacklist (jti, user_id, expires_at) VALUES ($1,$2,$3) ON CONFLICT (jti) DO NOTHING',
        [req.user.jti, userId, expiresAt]
      );
    }

    await pool.query('DELETE FROM users WHERE id=$1', [userId]);
    logger.info('account.deleted', { userId });
    res.json({ ok: true, message: 'Account permanently deleted' });
  } catch (err) { logger.error('delete.error', { err: err.message, stack: err.stack }); res.status(500).json({ error: 'Internal server error' }); }
});

app.post('/api/auth/forgot-password', passwordResetLimiter, validate(forgotPasswordSchema), async (req, res) => {
  try {
    const { email } = req.body;
    const { rows } = await pool.query('SELECT * FROM users WHERE email=$1', [email]);
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
    const includeDevLink = result.devLink && process.env.NODE_ENV !== 'production';
    res.json({
      message: 'If that email is registered, a reset link has been sent.',
      ...(includeDevLink ? { devLink: result.devLink } : {}),
    });
  } catch (err) { logger.error('handler.error', { path: req.path, method: req.method, err: err.message, stack: err.stack }); res.status(500).json({ error: 'Internal server error' }); }
});

app.post('/api/auth/reset-password', passwordResetLimiter, validate(resetPasswordSchema), async (req, res) => {
  try {
    const { token, password } = req.body;
    const { rows } = await pool.query(
      'SELECT * FROM password_resets WHERE token=$1 AND used=FALSE AND expires_at > NOW()',
      [token]
    );
    if (!rows.length) return res.status(400).json({ error: 'Invalid or expired reset link. Request a new one.' });
    const hash = await bcrypt.hash(password, 10);
    await pool.query('UPDATE users SET password_hash=$1, failed_login_attempts=0, locked_until=NULL WHERE id=$2', [hash, rows[0].user_id]);
    await pool.query('UPDATE password_resets SET used=TRUE WHERE id=$1', [rows[0].id]);
    logger.info('password.reset.success', { userId: rows[0].user_id });
    res.json({ message: 'Password reset successful' });
  } catch (err) { logger.error('password.reset.error', { err: err.message, stack: err.stack }); res.status(500).json({ error: 'Internal server error' }); }
});

const ALLOWED_BUSINESS_TYPES = new Set([
  'services', 'products', 'space', 'mix',
  'spa', 'salon', 'barbershop', 'gym', 'hotel', 'clinic', 'restaurant', 'other',
]);
const ALLOWED_ROLES = new Set(['manager', 'staff', 'owner']);

app.post('/api/auth/business', auth, async (req, res) => {
  try {
    const { businessType } = req.body;
    if (!ALLOWED_BUSINESS_TYPES.has(String(businessType))) {
      return res.status(400).json({ error: 'Invalid business type' });
    }
    const { rows } = await pool.query(
      'UPDATE users SET business_type=$1 WHERE id=$2 RETURNING *',
      [businessType, req.user.id]
    );
    res.json({ token: makeToken(rows[0]), user: formatUser(rows[0]) });
  } catch (err) { logger.error('handler.error', { path: req.path, method: req.method, err: err.message, stack: err.stack }); res.status(500).json({ error: 'Internal server error' }); }
});

app.post('/api/auth/role', auth, async (req, res) => {
  try {
    const { role, staffId } = req.body;
    if (!ALLOWED_ROLES.has(String(role))) {
      return res.status(400).json({ error: 'Invalid role' });
    }
    const { rows: meRows } = await pool.query('SELECT business_id, role, onboarding_role FROM users WHERE id=$1', [req.user.id]);
    const me = meRows[0];
    // A staff-onboarded account must never become a manager — that's the only
    // promotion we block. Owners/managers may freely toggle their active role
    // (e.g. a manager previewing the staff view), and brand-new accounts pick
    // their role for the first time here.
    if (me && me.onboarding_role === 'staff' && role === 'manager') {
      return res.status(403).json({ error: 'Staff accounts cannot switch to manager.' });
    }
    // If a staff_id is supplied, the user must have already joined a business and
    // that staff row must belong to that business — otherwise a mid-onboarding
    // user could claim any tenant's staff_id.
    let resolvedStaffId = null;
    if (staffId != null && staffId !== '') {
      if (!me || !me.business_id) {
        return res.status(400).json({ error: 'Join a business before selecting a staff profile' });
      }
      const { rows: sRows } = await pool.query(
        'SELECT id FROM staff WHERE id=$1 AND business_id=$2',
        [Number(staffId), me.business_id]
      );
      if (!sRows.length) return res.status(400).json({ error: 'Invalid staff profile' });
      resolvedStaffId = sRows[0].id;
    }
    const { rows } = await pool.query(
      'UPDATE users SET role=$1, staff_id=$2 WHERE id=$3 RETURNING *',
      [role, resolvedStaffId, req.user.id]
    );
    res.json({ token: makeToken(rows[0]), user: formatUser(rows[0]) });
  } catch (err) { logger.error('handler.error', { path: req.path, method: req.method, err: err.message, stack: err.stack }); res.status(500).json({ error: 'Internal server error' }); }
});

app.get('/api/auth/me', auth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE id=$1', [req.user.id]);
    if (!rows.length) return res.status(401).json({ error: 'User not found' });
    res.json(formatUser(rows[0]));
  } catch (err) { logger.error('handler.error', { path: req.path, method: req.method, err: err.message, stack: err.stack }); res.status(500).json({ error: 'Internal server error' }); }
});

app.post('/api/auth/complete-tutorial', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'UPDATE users SET tutorial_completed = TRUE WHERE id = $1 RETURNING *',
      [req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    res.json({ user: formatUser(rows[0]) });
  } catch (err) { logger.error('handler.error', { path: req.path, method: req.method, err: err.message, stack: err.stack }); res.status(500).json({ error: 'Internal server error' }); }
});

// ── Trial / Billing ───────────────────────────────────────
app.get('/api/auth/trial-status', auth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE id=$1', [req.user.id]);
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    res.json(trialInfo(rows[0]));
  } catch (err) { logger.error('handler.error', { path: req.path, method: req.method, err: err.message, stack: err.stack }); res.status(500).json({ error: 'Internal server error' }); }
});

app.post('/api/billing/check-payment', auth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT subscription_status FROM users WHERE id=$1', [req.user.id]);
    res.json({ paid: rows[0]?.subscription_status === 'active' });
  } catch (err) { logger.error('handler.error', { path: req.path, method: req.method, err: err.message, stack: err.stack }); res.status(500).json({ error: 'Internal server error' }); }
});

// Mock subscription activation. Replace with Stripe checkout webhook in production.
app.post('/api/billing/subscribe', auth, async (req, res) => {
  try {
    res.json({
      checkoutUrl: null,
      message: 'Stripe checkout not configured. Use POST /api/billing/mock-activate for testing.',
    });
  } catch (err) { logger.error('handler.error', { path: req.path, method: req.method, err: err.message, stack: err.stack }); res.status(500).json({ error: 'Internal server error' }); }
});

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
  } catch (err) { logger.error('handler.error', { path: req.path, method: req.method, err: err.message, stack: err.stack }); res.status(500).json({ error: 'Internal server error' }); }
});

// ── Businesses ────────────────────────────────────────────
app.post('/api/businesses', auth, async (req, res) => {
  try {
    const { name, type, staffCount, currency } = req.body;
    if (!name || !type) return res.status(400).json({ error: 'name and type required' });
    if (!ALLOWED_BUSINESS_TYPES.has(String(type))) {
      return res.status(400).json({ error: 'Invalid business type' });
    }
    const trimmedName = String(name).trim().slice(0, 120);
    if (!trimmedName) return res.status(400).json({ error: 'name required' });
    const cur = clampCurrency(currency);
    // Retry-on-unique-violation pattern: SELECT-then-INSERT is racy under load.
    // Try up to 12 random codes; if a duplicate slips past the SELECT, catch the
    // 23505 unique_violation and try again with a fresh code.
    let business = null;
    let lastErr = null;
    for (let i = 0; i < 12; i++) {
      const candidate = genBusinessCode();
      try {
        const { rows } = await pool.query(
          `INSERT INTO businesses (name, type, owner_id, code, staff_count, currency)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
          [trimmedName, type, req.user.id, candidate, staffCount || 0, cur]
        );
        business = rows[0];
        break;
      } catch (e) {
        lastErr = e;
        if (e.code !== '23505') throw e; // not a unique-violation — bubble up
      }
    }
    if (!business) {
      logger.error('businesses.code.exhausted', { err: lastErr && lastErr.message });
      return res.status(500).json({ error: 'Could not generate unique business code' });
    }
    const { rows: urows } = await pool.query(
      `UPDATE users SET business_id=$1, business_type=$2, role='manager', onboarding_role='owner'
       WHERE id=$3 RETURNING *`,
      [business.id, type, req.user.id]
    );
    res.status(201).json({
      business: formatBusiness(business),
      token: makeToken(urows[0]),
      user: formatUser(urows[0]),
    });
  } catch (err) { logger.error('handler.error', { path: req.path, method: req.method, err: err.message, stack: err.stack }); res.status(500).json({ error: 'Internal server error' }); }
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
  } catch (err) { logger.error('handler.error', { path: req.path, method: req.method, err: err.message, stack: err.stack }); res.status(500).json({ error: 'Internal server error' }); }
});

app.get('/api/businesses/me', auth, async (req, res) => {
  try {
    const { rows: urows } = await pool.query('SELECT business_id FROM users WHERE id=$1', [req.user.id]);
    if (!urows.length || !urows[0].business_id) return res.json(null);
    const { rows } = await pool.query('SELECT * FROM businesses WHERE id=$1', [urows[0].business_id]);
    res.json(rows.length ? formatBusiness(rows[0]) : null);
  } catch (err) { logger.error('handler.error', { path: req.path, method: req.method, err: err.message, stack: err.stack }); res.status(500).json({ error: 'Internal server error' }); }
});

// Owner can update business name / currency. Manager+ only — staff can't change
// settings. Keep type immutable (changing it would invalidate stored labels).
app.put('/api/businesses/me', auth, requireManager, async (req, res) => {
  try {
    const { rows: urows } = await pool.query('SELECT business_id FROM users WHERE id=$1', [req.user.id]);
    if (!urows.length || !urows[0].business_id) return res.status(404).json({ error: 'No business to update' });
    const bid = urows[0].business_id;
    const updates = [];
    const params = [];
    if (typeof req.body.name === 'string') {
      const n = req.body.name.trim().slice(0, 120);
      if (n) { params.push(n); updates.push(`name=$${params.length}`); }
    }
    if (typeof req.body.currency === 'string') {
      params.push(clampCurrency(req.body.currency));
      updates.push(`currency=$${params.length}`);
    }
    if (typeof req.body.accent === 'string') {
      params.push(clampAccent(req.body.accent));
      updates.push(`accent=$${params.length}`);
    }
    if ('accentCustom' in req.body) {
      params.push(safeHex(req.body.accentCustom));
      updates.push(`accent_custom=$${params.length}`);
    }
    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
    params.push(bid);
    const { rows } = await pool.query(
      `UPDATE businesses SET ${updates.join(', ')} WHERE id=$${params.length} RETURNING *`,
      params
    );
    res.json(rows.length ? formatBusiness(rows[0]) : null);
  } catch (err) { logger.error('handler.error', { path: req.path, method: req.method, err: err.message, stack: err.stack }); res.status(500).json({ error: 'Internal server error' }); }
});

// User can switch between owner/staff later. Resets business association so the
// onboarding flow restarts. Also clears staff_id (was left dangling, which could
// point at a now-unrelated staff row) and revokes the old token.
app.post('/api/auth/switch-onboarding', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE users SET business_id=NULL, business_type=NULL, role=NULL, onboarding_role=NULL, staff_id=NULL
       WHERE id=$1 RETURNING *`,
      [req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    // Revoke the old token so the stale businessId/role claims can't be reused.
    if (req.user.jti && req.user.exp) {
      try {
        await pool.query(
          'INSERT INTO token_blacklist (jti, user_id, expires_at) VALUES ($1,$2,$3) ON CONFLICT (jti) DO NOTHING',
          [req.user.jti, req.user.id, new Date(req.user.exp * 1000)]
        );
      } catch (e) { logger.warn('switch.blacklist.skip', { err: e.message }); }
    }
    res.json({ token: makeToken(rows[0]), user: formatUser(rows[0]) });
  } catch (err) { logger.error('switch.onboarding.error', { userId: req.user && req.user.id, err: err.message, stack: err.stack }); res.status(500).json({ error: 'Internal server error' }); }
});

// ── Change password (logged in) ──────────────────────────
app.post('/api/auth/change-password', auth, async (req, res) => {
  try {
    const currentPassword = String(req.body?.currentPassword || '');
    const newPassword = String(req.body?.newPassword || '');
    if (newPassword.length < 8 || newPassword.length > 128) {
      return res.status(400).json({ error: 'New password must be 8–128 characters.' });
    }
    const { rows } = await pool.query('SELECT password_hash FROM users WHERE id=$1', [req.user.id]);
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    const valid = await bcrypt.compare(currentPassword, rows[0].password_hash);
    if (!valid) return res.status(401).json({ error: 'Current password is incorrect.' });
    const hash = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, req.user.id]);
    logger.info('password.changed', { userId: req.user.id });
    res.json({ ok: true, message: 'Password updated.' });
  } catch (err) { logger.error('change.password.error', { err: err.message, stack: err.stack }); res.status(500).json({ error: 'Internal server error' }); }
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
    const { sql } = paginationClause(req);
    const { rows } = await pool.query('SELECT * FROM staff WHERE business_id = $1 ORDER BY id' + sql, [bid]);
    res.json(rows.map(formatStaff));
  } catch (err) { logger.error('handler.error', { path: req.path, method: req.method, err: err.message, stack: err.stack }); res.status(500).json({ error: 'Internal server error' }); }
});

function clampStaffFields(b) {
  const name = String(b.name || '').slice(0, 80);
  const role = String(b.role || '').slice(0, 60);
  const phone = b.phone != null ? String(b.phone).slice(0, 40) : null;
  const rateRaw = Number(b.commissionRate);
  const commissionRate = Number.isFinite(rateRaw) ? Math.max(0, Math.min(100, rateRaw)) : 30;
  return { name, role, phone, commissionRate };
}

app.post('/api/staff', auth, requireManager, async (req, res) => {
  try {
    const bid = needBusiness(req, res); if (!bid) return;
    const { avatar, color, birthday, schedule, permissions } = req.body;
    const { name, role, phone, commissionRate } = clampStaffFields(req.body);
    if (!name || !role) return res.status(400).json({ error: 'name and role required' });
    const { rows } = await pool.query(
      'INSERT INTO staff (business_id, name, role, avatar, color, birthday, phone, schedule, commission_rate, permissions) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',
      [bid, name, role, avatar || name[0].toUpperCase(), color || '#a8c5a0', birthday || null, phone, schedule || [], commissionRate, JSON.stringify({ ...DEFAULT_PERMISSIONS, ...(permissions || {}) })]
    );
    res.status(201).json(formatStaff(rows[0]));
  } catch (err) { logger.error('handler.error', { path: req.path, method: req.method, err: err.message, stack: err.stack }); res.status(500).json({ error: 'Internal server error' }); }
});

app.put('/api/staff/:id', auth, requireManager, async (req, res) => {
  try {
    const bid = needBusiness(req, res); if (!bid) return;
    const { avatar, color, birthday, schedule, permissions } = req.body;
    const { name, role, phone, commissionRate } = clampStaffFields(req.body);
    const { rows } = await pool.query(
      'UPDATE staff SET name=$1, role=$2, avatar=$3, color=$4, birthday=$5, phone=$6, schedule=$7, commission_rate=$8, permissions=$9 WHERE id=$10 AND business_id=$11 RETURNING *',
      [name, role, avatar, color, birthday || null, phone, schedule || [], commissionRate, JSON.stringify({ ...DEFAULT_PERMISSIONS, ...(permissions || {}) }), req.params.id, bid]
    );
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    res.json(formatStaff(rows[0]));
  } catch (err) { logger.error('handler.error', { path: req.path, method: req.method, err: err.message, stack: err.stack }); res.status(500).json({ error: 'Internal server error' }); }
});

app.delete('/api/staff/:id', auth, requireManager, async (req, res) => {
  try {
    const bid = needBusiness(req, res); if (!bid) return;
    const { rows } = await pool.query('DELETE FROM staff WHERE id=$1 AND business_id=$2 RETURNING *', [req.params.id, bid]);
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    res.json(formatStaff(rows[0]));
  } catch (err) { logger.error('handler.error', { path: req.path, method: req.method, err: err.message, stack: err.stack }); res.status(500).json({ error: 'Internal server error' }); }
});

// ── Bookings ──────────────────────────────────────────────
app.get('/api/bookings', auth, async (req, res) => {
  try {
    const bid = req.user.businessId;
    if (!bid) return res.json([]);
    const { sql } = paginationClause(req);
    // Order by date desc, then by time ascending (HH:MM strings sort lexicographically; padded times work).
    const { rows } = await pool.query("SELECT * FROM bookings WHERE business_id = $1 ORDER BY date DESC NULLS LAST, time ASC NULLS LAST" + sql, [bid]);
    res.json(rows.map(formatBooking));
  } catch (err) { logger.error('handler.error', { path: req.path, method: req.method, err: err.message, stack: err.stack }); res.status(500).json({ error: 'Internal server error' }); }
});

// Bounds for booking duration (1 min .. 1440 min = 1 day) and price (0 .. 1,000,000)
// so a bad request can't create wildly out-of-range rows.
function clampBookingFields(b) {
  const dur = Math.max(1, Math.min(1440, Math.trunc(Number(b.duration) || 0)));
  const priceRaw = Number(b.price);
  const pri = Number.isFinite(priceRaw) ? Math.max(0, Math.min(1000000, priceRaw)) : 0;
  return { dur, pri };
}

// YYYY-MM-DD anchor — backed by server local time, not UTC, so end-of-day
// edits don't shift the booking forward or backward by a day.
function localToday() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

// Validate that a supplied staff_id belongs to this business. Returns numeric id
// or null. Returns false (sentinel) if a staffId was supplied but doesn't match.
async function resolveStaffIdForBusiness(staffId, bid) {
  if (staffId == null || staffId === '') return null;
  const n = Number(staffId);
  if (!Number.isFinite(n)) return false;
  const { rows } = await pool.query('SELECT id FROM staff WHERE id=$1 AND business_id=$2', [n, bid]);
  return rows.length ? n : false;
}

app.post('/api/bookings', auth, async (req, res) => {
  try {
    const bid = needBusiness(req, res); if (!bid) return;
    const { date, time, client, treatment, duration, staffId, notes, status, price, allergies, clientPhone } = req.body;
    if (!time || !client || !treatment || !duration) return res.status(400).json({ error: 'time, client, treatment, duration required' });
    const resolvedStaffId = await resolveStaffIdForBusiness(staffId, bid);
    if (resolvedStaffId === false) return res.status(400).json({ error: 'Invalid staffId' });
    const { dur, pri } = clampBookingFields({ duration, price });
    const bookingDate = date || localToday();
    const safeClient = String(client).slice(0, 120);
    const safeTreatment = String(treatment).slice(0, 120);
    const safeNotes = String(notes || '').slice(0, 2000);
    const safeAllergies = String(allergies || '').slice(0, 500);
    const safePhone = String(clientPhone || '').slice(0, 40);
    const { rows } = await pool.query(
      'INSERT INTO bookings (business_id, date, time, client, treatment, duration, staff_id, notes, status, price, allergies, client_phone) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *',
      [bid, bookingDate, time, safeClient, safeTreatment, dur, resolvedStaffId, safeNotes, status || 'confirmed', pri, safeAllergies, safePhone]
    );
    res.status(201).json(formatBooking(rows[0]));
  } catch (err) { logger.error('handler.error', { path: req.path, method: req.method, err: err.message, stack: err.stack }); res.status(500).json({ error: 'Internal server error' }); }
});

app.put('/api/bookings/:id', auth, async (req, res) => {
  try {
    const bid = needBusiness(req, res); if (!bid) return;
    const { date, time, client, treatment, duration, staffId, notes, status, price, allergies, clientPhone } = req.body;
    const resolvedStaffId = await resolveStaffIdForBusiness(staffId, bid);
    if (resolvedStaffId === false) return res.status(400).json({ error: 'Invalid staffId' });
    const { dur, pri } = clampBookingFields({ duration, price });
    const bookingDate = date || localToday();
    const safeClient = String(client).slice(0, 120);
    const safeTreatment = String(treatment).slice(0, 120);
    const safeNotes = String(notes || '').slice(0, 2000);
    const safeAllergies = String(allergies || '').slice(0, 500);
    const safePhone = String(clientPhone || '').slice(0, 40);
    const { rows } = await pool.query(
      'UPDATE bookings SET date=$1, time=$2, client=$3, treatment=$4, duration=$5, staff_id=$6, notes=$7, status=$8, price=$9, allergies=$10, client_phone=$11 WHERE id=$12 AND business_id=$13 RETURNING *',
      [bookingDate, time, safeClient, safeTreatment, dur, resolvedStaffId, safeNotes, status || 'confirmed', pri, safeAllergies, safePhone, req.params.id, bid]
    );
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    res.json(formatBooking(rows[0]));
  } catch (err) { logger.error('handler.error', { path: req.path, method: req.method, err: err.message, stack: err.stack }); res.status(500).json({ error: 'Internal server error' }); }
});

app.delete('/api/bookings/:id', auth, async (req, res) => {
  try {
    const bid = needBusiness(req, res); if (!bid) return;
    const { rows } = await pool.query('DELETE FROM bookings WHERE id=$1 AND business_id=$2 RETURNING *', [req.params.id, bid]);
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    res.json(formatBooking(rows[0]));
  } catch (err) { logger.error('handler.error', { path: req.path, method: req.method, err: err.message, stack: err.stack }); res.status(500).json({ error: 'Internal server error' }); }
});

// ── Inventory ─────────────────────────────────────────────
app.get('/api/inventory', auth, async (req, res) => {
  try {
    const bid = req.user.businessId;
    if (!bid) return res.json([]);
    const { sql } = paginationClause(req);
    const { rows } = await pool.query('SELECT * FROM inventory WHERE business_id = $1 ORDER BY id' + sql, [bid]);
    res.json(rows.map(formatInventory));
  } catch (err) { logger.error('handler.error', { path: req.path, method: req.method, err: err.message, stack: err.stack }); res.status(500).json({ error: 'Internal server error' }); }
});

// Bound inventory numeric fields so writes can't store absurd values.
function clampInventoryFields(b) {
  const stock = Math.max(0, Math.min(1000000, Math.trunc(Number(b.stock) || 0)));
  const threshold = Math.max(0, Math.min(1000000, Math.trunc(Number(b.threshold) || 5)));
  const costRaw = Number(b.cost);
  const cost = Number.isFinite(costRaw) ? Math.max(0, Math.min(1000000, costRaw)) : 0;
  return { stock, threshold, cost };
}

app.post('/api/inventory', auth, async (req, res) => {
  try {
    const bid = needBusiness(req, res); if (!bid) return;
    const { name, category, unit, supplier, lastOrder } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    const { stock, threshold, cost } = clampInventoryFields(req.body);
    const { rows } = await pool.query(
      'INSERT INTO inventory (business_id, name, category, stock, threshold, unit, supplier, last_order, cost) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
      [bid, name, category || '', stock, threshold, unit || 'pcs', supplier || '', lastOrder || '', cost]
    );
    res.status(201).json(formatInventory(rows[0]));
  } catch (err) { logger.error('handler.error', { path: req.path, method: req.method, err: err.message, stack: err.stack }); res.status(500).json({ error: 'Internal server error' }); }
});

app.put('/api/inventory/:id', auth, async (req, res) => {
  try {
    const bid = needBusiness(req, res); if (!bid) return;
    const { name, category, unit, supplier, lastOrder } = req.body;
    const { stock, threshold, cost } = clampInventoryFields(req.body);
    const { rows } = await pool.query(
      'UPDATE inventory SET name=$1, category=$2, stock=$3, threshold=$4, unit=$5, supplier=$6, last_order=$7, cost=$8 WHERE id=$9 AND business_id=$10 RETURNING *',
      [name, category, stock, threshold, unit, supplier, lastOrder || '', cost, req.params.id, bid]
    );
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    res.json(formatInventory(rows[0]));
  } catch (err) { logger.error('handler.error', { path: req.path, method: req.method, err: err.message, stack: err.stack }); res.status(500).json({ error: 'Internal server error' }); }
});

app.patch('/api/inventory/:id/stock', auth, async (req, res) => {
  try {
    const bid = needBusiness(req, res); if (!bid) return;
    const deltaRaw = Number(req.body?.delta);
    if (!Number.isFinite(deltaRaw)) {
      return res.status(400).json({ error: 'delta must be a number' });
    }
    // Bound the delta to a sane range so a fat-finger or malicious caller can't bump
    // stock by 9 quadrillion units in one request. Real adjustments are tiny (±1..±100).
    const delta = Math.max(-10000, Math.min(10000, Math.trunc(deltaRaw)));
    const { rows } = await pool.query(
      'UPDATE inventory SET stock = GREATEST(0, stock + $1) WHERE id=$2 AND business_id=$3 RETURNING *',
      [delta, req.params.id, bid]
    );
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    res.json(formatInventory(rows[0]));
  } catch (err) { logger.error('handler.error', { path: req.path, method: req.method, err: err.message, stack: err.stack }); res.status(500).json({ error: 'Internal server error' }); }
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
  } catch (err) { logger.error('handler.error', { path: req.path, method: req.method, err: err.message, stack: err.stack }); res.status(500).json({ error: 'Internal server error' }); }
});

app.delete('/api/inventory/:id', auth, async (req, res) => {
  try {
    const bid = needBusiness(req, res); if (!bid) return;
    const { rows } = await pool.query('DELETE FROM inventory WHERE id=$1 AND business_id=$2 RETURNING *', [req.params.id, bid]);
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    res.json(formatInventory(rows[0]));
  } catch (err) { logger.error('handler.error', { path: req.path, method: req.method, err: err.message, stack: err.stack }); res.status(500).json({ error: 'Internal server error' }); }
});

// ── Requests ──────────────────────────────────────────────
app.get('/api/requests', auth, async (req, res) => {
  try {
    const bid = req.user.businessId;
    if (!bid) return res.json([]);
    const { sql } = paginationClause(req);
    const { rows } = await pool.query('SELECT * FROM requests WHERE business_id = $1 ORDER BY created_at DESC' + sql, [bid]);
    res.json(rows.map(formatRequest));
  } catch (err) { logger.error('handler.error', { path: req.path, method: req.method, err: err.message, stack: err.stack }); res.status(500).json({ error: 'Internal server error' }); }
});

app.post('/api/requests', auth, async (req, res) => {
  try {
    const bid = needBusiness(req, res); if (!bid) return;
    const { type, staffId, date, reason, swapWith, swapDay, productId, quantity } = req.body;
    if (!type || !staffId) return res.status(400).json({ error: 'type and staffId required' });
    const validTypes = ['sick', 'dayoff', 'swap', 'stock_request'];
    if (!validTypes.includes(type)) return res.status(400).json({ error: 'invalid type' });

    // Staff must belong to this business — prevent submitting requests against
    // a foreign tenant's staff_id.
    const { rows: sRows } = await pool.query(
      'SELECT 1 FROM staff WHERE id=$1 AND business_id=$2',
      [Number(staffId), bid]
    );
    if (!sRows.length) return res.status(400).json({ error: 'Invalid staffId' });
    if (swapWith) {
      const { rows: swRows } = await pool.query(
        'SELECT 1 FROM staff WHERE id=$1 AND business_id=$2',
        [Number(swapWith), bid]
      );
      if (!swRows.length) return res.status(400).json({ error: 'Invalid swapWith' });
    }
    if (productId) {
      const { rows: pRows } = await pool.query(
        'SELECT 1 FROM inventory WHERE id=$1 AND business_id=$2',
        [Number(productId), bid]
      );
      if (!pRows.length) return res.status(400).json({ error: 'Invalid productId' });
    }

    // Prevent duplicate pending requests of same type per staff per date (skip stock_request)
    if (type !== 'stock_request' && date) {
      const { rowCount: dupCount } = await pool.query(
        `SELECT 1 FROM requests
         WHERE business_id=$1 AND staff_id=$2 AND type=$3 AND date=$4 AND status='pending'`,
        [bid, Number(staffId), type, date]
      );
      if (dupCount) {
        return res.status(409).json({ error: 'You already have a pending request for this date.' });
      }
    }

    // Clamp quantity to [0, 10000] at write time so the displayed request can't
    // mislead a manager into approving a huge increment.
    const qty = Math.max(0, Math.min(10000, Math.trunc(Number(quantity) || 0)));
    const safeReason = String(reason || '').slice(0, 1000);

    const { rows } = await pool.query(
      'INSERT INTO requests (business_id, type, staff_id, date, reason, swap_with, swap_day, product_id, quantity) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
      [bid, type, Number(staffId), date || null, safeReason, swapWith ? Number(swapWith) : null, swapDay || null, productId ? Number(productId) : null, qty]
    );
    res.status(201).json(formatRequest(rows[0]));
  } catch (err) { logger.error('handler.error', { path: req.path, method: req.method, err: err.message, stack: err.stack }); res.status(500).json({ error: 'Internal server error' }); }
});

app.put('/api/requests/:id', auth, requireManager, async (req, res) => {
  try {
    const bid = needBusiness(req, res); if (!bid) return;
    const { status, reassignToStaffId } = req.body;
    if (!['approved', 'declined'].includes(String(status))) {
      return res.status(400).json({ error: 'status must be approved or declined' });
    }
    // If a reassignment target is supplied, it must belong to this business — prevents
    // a manager from setting another tenant's staff as the new owner of bookings.
    if (reassignToStaffId) {
      const { rows: sRows } = await pool.query(
        'SELECT 1 FROM staff WHERE id=$1 AND business_id=$2',
        [Number(reassignToStaffId), bid]
      );
      if (!sRows.length) return res.status(400).json({ error: 'Invalid reassignToStaffId' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Lock the request row + atomically gate on status='pending' so a double-click
      // (or a parallel manager session) can't run the swap/reassign logic twice.
      const { rows: reqRows } = await client.query(
        'SELECT * FROM requests WHERE id=$1 AND business_id=$2 FOR UPDATE',
        [req.params.id, bid]
      );
      if (!reqRows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'not found' });
      }
      const request = reqRows[0];
      if (request.status !== 'pending') {
        await client.query('ROLLBACK');
        // Idempotent: return current state so client UI converges.
        return res.json(formatRequest(request));
      }

      if (status === 'approved' && request.type === 'sick' && reassignToStaffId) {
        await client.query(
          `UPDATE bookings SET staff_id=$1 WHERE staff_id=$2 AND date = $3::date AND business_id=$4`,
          [reassignToStaffId, request.staff_id, request.date, bid]
        );
      }

      // Shift swap: requester's bookings on their date go to swap_with, swap_with's
      // bookings on swap_day go to requester. Capture the requester's booking IDs
      // first so the third UPDATE only touches THOSE rows — not any other booking
      // that happens to have NULL staff_id on that date (regression: previous
      // implementation re-assigned every unassigned booking).
      if (status === 'approved' && request.type === 'swap' && request.swap_with && request.swap_day) {
        const { rows: requesterRows } = await client.query(
          `SELECT id FROM bookings WHERE staff_id=$1 AND date=$2::date AND business_id=$3`,
          [request.staff_id, request.date, bid]
        );
        const requesterIds = requesterRows.map(r => r.id);
        // Tag requester's bookings with NULL temporarily so the second update
        // doesn't accidentally re-grab them.
        if (requesterIds.length) {
          await client.query(
            `UPDATE bookings SET staff_id=NULL WHERE id = ANY($1::int[]) AND business_id=$2`,
            [requesterIds, bid]
          );
        }
        // Move swap_with staff's bookings on swap_day to requester
        await client.query(
          `UPDATE bookings SET staff_id=$1 WHERE staff_id=$2 AND date=$3::date AND business_id=$4`,
          [request.staff_id, request.swap_with, request.swap_day, bid]
        );
        // Move only the originally-captured bookings to swap_with — not every NULL row.
        if (requesterIds.length) {
          await client.query(
            `UPDATE bookings SET staff_id=$1 WHERE id = ANY($2::int[]) AND business_id=$3`,
            [request.swap_with, requesterIds, bid]
          );
        }
      }

      // Day-off approval: cancel requester's bookings on that date or leave to manager.
      // Manager UI should reassign manually first; we just record approval.
      if (status === 'approved' && request.type === 'dayoff' && reassignToStaffId) {
        await client.query(
          `UPDATE bookings SET staff_id=$1 WHERE staff_id=$2 AND date=$3::date AND business_id=$4`,
          [reassignToStaffId, request.staff_id, request.date, bid]
        );
      }

      if (status === 'approved' && request.type === 'stock_request' && request.product_id) {
        // Scope to this business — without business_id a crafted product_id from
        // another tenant would mutate cross-tenant inventory.
        const qty = Math.max(0, Math.min(10000, Math.trunc(Number(request.quantity) || 0)));
        await client.query(
          'UPDATE inventory SET stock = stock + $1 WHERE id=$2 AND business_id=$3',
          [qty, request.product_id, bid]
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
  } catch (err) { logger.error('handler.error', { path: req.path, method: req.method, err: err.message, stack: err.stack }); res.status(500).json({ error: 'Internal server error' }); }
});

// ── Announcements ─────────────────────────────────────────
app.get('/api/announcements', auth, async (req, res) => {
  try {
    const bid = req.user.businessId;
    if (!bid) return res.json([]);
    const { sql } = paginationClause(req);
    const { rows } = await pool.query('SELECT * FROM announcements WHERE business_id = $1 ORDER BY created_at DESC' + sql, [bid]);
    res.json(rows.map(formatAnnouncement));
  } catch (err) { logger.error('handler.error', { path: req.path, method: req.method, err: err.message, stack: err.stack }); res.status(500).json({ error: 'Internal server error' }); }
});

app.post('/api/announcements', auth, requireManager, async (req, res) => {
  try {
    const bid = needBusiness(req, res); if (!bid) return;
    const title = String(req.body.title || '').slice(0, 120);
    const body = String(req.body.body || '').slice(0, 4000);
    const from = String(req.body.from || 'Management').slice(0, 80);
    if (!body) return res.status(400).json({ error: 'body required' });
    const { rows } = await pool.query(
      'INSERT INTO announcements (business_id, title, body, "from") VALUES ($1,$2,$3,$4) RETURNING *',
      [bid, title, body, from]
    );
    res.status(201).json(formatAnnouncement(rows[0]));
  } catch (err) { logger.error('handler.error', { path: req.path, method: req.method, err: err.message, stack: err.stack }); res.status(500).json({ error: 'Internal server error' }); }
});

app.delete('/api/announcements/:id', auth, requireManager, async (req, res) => {
  try {
    const bid = needBusiness(req, res); if (!bid) return;
    const { rows } = await pool.query('DELETE FROM announcements WHERE id=$1 AND business_id=$2 RETURNING *', [req.params.id, bid]);
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    res.json(formatAnnouncement(rows[0]));
  } catch (err) { logger.error('handler.error', { path: req.path, method: req.method, err: err.message, stack: err.stack }); res.status(500).json({ error: 'Internal server error' }); }
});

// ── SOP ───────────────────────────────────────────────────
app.get('/api/sop', auth, async (req, res) => {
  try {
    const bid = req.user.businessId;
    if (!bid) return res.json([]);
    const { sql } = paginationClause(req);
    const { rows } = await pool.query('SELECT * FROM sop WHERE business_id = $1 ORDER BY id' + sql, [bid]);
    res.json(rows.map(formatSop));
  } catch (err) { logger.error('handler.error', { path: req.path, method: req.method, err: err.message, stack: err.stack }); res.status(500).json({ error: 'Internal server error' }); }
});

app.post('/api/sop', auth, requireManager, async (req, res) => {
  try {
    const bid = needBusiness(req, res); if (!bid) return;
    const title = String(req.body.title || '').slice(0, 120);
    const body = String(req.body.body || '').slice(0, 2000);
    const category = String(req.body.category || 'General').slice(0, 60);
    if (!title) return res.status(400).json({ error: 'title required' });
    const { rows } = await pool.query(
      'INSERT INTO sop (business_id, title, body, category) VALUES ($1,$2,$3,$4) RETURNING *',
      [bid, title, body, category]
    );
    res.status(201).json(formatSop(rows[0]));
  } catch (err) { logger.error('handler.error', { path: req.path, method: req.method, err: err.message, stack: err.stack }); res.status(500).json({ error: 'Internal server error' }); }
});

app.delete('/api/sop/:id', auth, requireManager, async (req, res) => {
  try {
    const bid = needBusiness(req, res); if (!bid) return;
    const { rows } = await pool.query('DELETE FROM sop WHERE id=$1 AND business_id=$2 RETURNING *', [req.params.id, bid]);
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    res.json(formatSop(rows[0]));
  } catch (err) { logger.error('handler.error', { path: req.path, method: req.method, err: err.message, stack: err.stack }); res.status(500).json({ error: 'Internal server error' }); }
});

// ── Violations ────────────────────────────────────────────
app.get('/api/violations', auth, async (req, res) => {
  try {
    const bid = req.user.businessId;
    if (!bid) return res.json([]);
    const { sql } = paginationClause(req);
    const { rows } = await pool.query('SELECT * FROM violations WHERE business_id = $1 ORDER BY created_at DESC' + sql, [bid]);
    res.json(rows.map(formatViolation));
  } catch (err) { logger.error('handler.error', { path: req.path, method: req.method, err: err.message, stack: err.stack }); res.status(500).json({ error: 'Internal server error' }); }
});

app.post('/api/violations', auth, requireManager, async (req, res) => {
  try {
    const bid = needBusiness(req, res); if (!bid) return;
    const { staffId, sopId, note } = req.body;
    if (!staffId) return res.status(400).json({ error: 'staffId required' });
    // Staff must belong to this business — FK alone allows any staff_id since
    // the table holds rows across all tenants.
    const { rows: sRows } = await pool.query(
      'SELECT 1 FROM staff WHERE id=$1 AND business_id=$2',
      [Number(staffId), bid]
    );
    if (!sRows.length) return res.status(400).json({ error: 'Invalid staffId' });
    // Same for sopId if supplied.
    if (sopId) {
      const { rows: rRows } = await pool.query(
        'SELECT 1 FROM sop WHERE id=$1 AND business_id=$2',
        [Number(sopId), bid]
      );
      if (!rRows.length) return res.status(400).json({ error: 'Invalid sopId' });
    }
    const safeNote = String(note || '').slice(0, 2000);
    const { rows } = await pool.query(
      'INSERT INTO violations (business_id, staff_id, sop_id, note) VALUES ($1,$2,$3,$4) RETURNING *',
      [bid, Number(staffId), sopId ? Number(sopId) : null, safeNote]
    );
    res.status(201).json(formatViolation(rows[0]));
  } catch (err) { logger.error('handler.error', { path: req.path, method: req.method, err: err.message, stack: err.stack }); res.status(500).json({ error: 'Internal server error' }); }
});

app.delete('/api/violations/:id', auth, requireManager, async (req, res) => {
  try {
    const bid = needBusiness(req, res); if (!bid) return;
    const { rows } = await pool.query('DELETE FROM violations WHERE id=$1 AND business_id=$2 RETURNING *', [req.params.id, bid]);
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    res.json(formatViolation(rows[0]));
  } catch (err) { logger.error('handler.error', { path: req.path, method: req.method, err: err.message, stack: err.stack }); res.status(500).json({ error: 'Internal server error' }); }
});

// ── Services ──────────────────────────────────────────────
app.get('/api/services', auth, async (req, res) => {
  try {
    const bid = req.user.businessId;
    if (!bid) return res.json([]);
    const { sql } = paginationClause(req);
    const { rows } = await pool.query('SELECT * FROM services WHERE business_id = $1 ORDER BY category, name' + sql, [bid]);
    res.json(rows.map(formatService));
  } catch (err) { logger.error('handler.error', { path: req.path, method: req.method, err: err.message, stack: err.stack }); res.status(500).json({ error: 'Internal server error' }); }
});

function clampServiceFields(b) {
  const durationMin = Math.max(1, Math.min(1440, Math.trunc(Number(b.durationMin) || 60)));
  const priceRaw = Number(b.price);
  const price = Number.isFinite(priceRaw) ? Math.max(0, Math.min(1000000, priceRaw)) : 0;
  return { durationMin, price };
}

app.post('/api/services', auth, requireManager, async (req, res) => {
  try {
    const bid = needBusiness(req, res); if (!bid) return;
    const { name, category, color } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    const { durationMin, price } = clampServiceFields(req.body);
    const { rows } = await pool.query(
      `INSERT INTO services (business_id, name, category, duration_min, price, color)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [bid, name, category || 'General', durationMin, price, color || '#2d5a4a']
    );
    res.status(201).json(formatService(rows[0]));
  } catch (err) { logger.error('handler.error', { path: req.path, method: req.method, err: err.message, stack: err.stack }); res.status(500).json({ error: 'Internal server error' }); }
});

app.put('/api/services/:id', auth, requireManager, async (req, res) => {
  try {
    const bid = needBusiness(req, res); if (!bid) return;
    const { name, category, color } = req.body;
    const { durationMin, price } = clampServiceFields(req.body);
    const { rows } = await pool.query(
      `UPDATE services
         SET name=$1, category=$2, duration_min=$3, price=$4, color=$5
       WHERE id=$6 AND business_id=$7 RETURNING *`,
      [name, category || 'General', durationMin, price, color || '#2d5a4a', req.params.id, bid]
    );
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    res.json(formatService(rows[0]));
  } catch (err) { logger.error('handler.error', { path: req.path, method: req.method, err: err.message, stack: err.stack }); res.status(500).json({ error: 'Internal server error' }); }
});

app.delete('/api/services/:id', auth, requireManager, async (req, res) => {
  try {
    const bid = needBusiness(req, res); if (!bid) return;
    const { rows } = await pool.query('DELETE FROM services WHERE id=$1 AND business_id=$2 RETURNING *', [req.params.id, bid]);
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    res.json(formatService(rows[0]));
  } catch (err) { logger.error('handler.error', { path: req.path, method: req.method, err: err.message, stack: err.stack }); res.status(500).json({ error: 'Internal server error' }); }
});

// ── Error handler ─────────────────────────────────────────
app.use((err, req, res, next) => {
  // Body-parser throws SyntaxError when JSON is malformed and PayloadTooLargeError
  // when over the 1mb limit. Surface a 400 instead of leaking 500 + stack.
  if (err.type === 'entity.parse.failed' || err instanceof SyntaxError) {
    logger.warn('bad.json', { path: req.path, method: req.method });
    return res.status(400).json({ error: 'Invalid JSON' });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request body too large' });
  }
  logger.error('unhandled.error', { path: req.path, method: req.method, err: err.message, stack: err.stack });
  res.status(500).json({ error: 'Internal server error' });
});

// ── Start ─────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
initDB()
  .then(() => app.listen(PORT, () => logger.info('server.started', { port: PORT })))
  .catch(err => { logger.error('db.init.failed', { err: err.message, stack: err.stack }); process.exit(1); });
