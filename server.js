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
  { id: user.id, email: user.email, role: user.role, businessType: user.business_type, staffId: user.staff_id },
  JWT_SECRET,
  { expiresIn: '12h' }
);

// ── DB init ───────────────────────────────────────────────
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id            SERIAL PRIMARY KEY,
      email         TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role          TEXT,
      business_type TEXT,
      staff_id      INTEGER,
      created_at    TIMESTAMPTZ DEFAULT NOW()
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
  ];
  for (const q of alters) {
    try { await pool.query(q); } catch (e) { console.warn('alter skipped:', e.message); }
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

  // Seed demo data
  const { rowCount: uc } = await pool.query('SELECT 1 FROM users LIMIT 1');
  if (uc === 0) {
    const hash = await bcrypt.hash('demo1234', 10);
    await pool.query(
      'INSERT INTO users (email, password_hash, role, business_type) VALUES ($1,$2,$3,$4)',
      ['demo@opus.app', hash, 'manager', 'spa']
    );
  }

  const { rowCount: sc } = await pool.query('SELECT 1 FROM staff LIMIT 1');
  if (sc === 0) {
    await pool.query(`
      INSERT INTO staff (name, role, avatar, color, birthday, schedule) VALUES
        ('Putri Ayu',    'Therapist',    'P', '#d4a574', '1990-03-15', ARRAY['Mon','Tue','Wed','Thu','Fri']),
        ('Kadek Sari',   'Therapist',    'K', '#a8c5a0', '1993-07-22', ARRAY['Mon','Tue','Thu','Fri','Sat']),
        ('Wayan Dewi',   'Receptionist', 'W', '#93c5fd', '1995-11-08', ARRAY['Mon','Tue','Wed','Fri','Sat']),
        ('Made Surya',   'Therapist',    'M', '#c4b5fd', '1988-04-30', ARRAY['Mon','Tue','Wed','Thu','Sun']),
        ('Nyoman Indah', 'Manager',      'N', '#2d5a4a', '1985-09-12', ARRAY['Mon','Tue','Wed','Thu','Fri']);
    `);

    await pool.query(`
      INSERT INTO bookings (time, client, treatment, duration, staff_id, notes, status, price, allergies) VALUES
        ('09:00', 'Sarah Mitchell', 'Deep Tissue Massage', 60, 2, 'Prefers firm pressure', 'confirmed', 350000, ''),
        ('10:30', 'Emma Johnson',   'Swedish Massage',     90, 1, '',                      'confirmed', 450000, ''),
        ('11:00', 'Lily Chen',      'Hot Stone Therapy',   75, 4, 'First time client',     'confirmed', 400000, ''),
        ('12:00', 'Grace Lee',      'Aromatherapy',        60, 2, '',                      'confirmed', 300000, ''),
        ('13:30', 'Maya Williams',  'Deep Tissue Massage', 90, 1, 'Allergic to nuts',      'confirmed', 450000, 'nuts'),
        ('14:00', 'Zoe Martinez',   'Facial Treatment',    60, 3, '',                      'confirmed', 350000, ''),
        ('15:30', 'Ava Thompson',   'Swedish Massage',     60, 4, '',                      'confirmed', 350000, ''),
        ('16:00', 'Chloe Davis',    'Hot Stone Therapy',   90, 2, 'VIP client',            'confirmed', 500000, '');
    `);

    await pool.query(`
      INSERT INTO inventory (name, category, stock, threshold, unit, supplier, last_order) VALUES
        ('Massage Oil',            'Oils',       24,  5,  'bottles', 'BaliNaturals', '2024-03-01'),
        ('Hot Stones Set',         'Equipment',   3,  2,  'sets',    'SpaEquip Co',  '2024-01-15'),
        ('Bamboo Towels',          'Linens',     48, 10,  'pcs',     'LinenPro',     '2024-02-20'),
        ('Lavender Essential Oil', 'Oils',        4,  5,  'bottles', 'BaliNaturals', '2024-02-28'),
        ('Face Mask Sheets',       'Skincare',   60, 15,  'pcs',     'BeautySupply', '2024-03-05'),
        ('Sandalwood Candles',     'Ambiance',   12,  8,  'pcs',     'AromaCo',      '2024-02-10'),
        ('Exfoliating Scrub',      'Skincare',    8,  6,  'jars',    'BeautySupply', '2024-02-15'),
        ('Disposable Sheets',      'Linens',    200, 50,  'pcs',     'LinenPro',     '2024-03-03');
    `);

    await pool.query(`
      INSERT INTO sop (title, body, category) VALUES
        ('Guest Greeting',    'Greet every guest with a smile and their name if known.', 'Guest Experience'),
        ('Room Reset',        'Leave every room pristine after each treatment.', 'Hygiene'),
        ('Product Decanting', 'Decant products carefully — respect what is given to you.', 'Products'),
        ('Door Policy',       'Lock door from inside only when guest is present.', 'Safety'),
        ('Noise Policy',      'Keep voice low near treatment rooms at all times.', 'Guest Experience');
    `);

    await pool.query(`
      INSERT INTO announcements (title, body, "from") VALUES
        ('Pavonia Training Tuesday', 'New Pavonia gold facial products arriving Monday. Crystal will train everyone Tuesday.', 'Ibu Rachel'),
        ('Product Decanting Reminder', 'Please remember to decant products properly — we have been losing too much product this week.', 'Yanti');
    `);

    console.log('Database seeded');
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
    const { rows } = await pool.query(
      'INSERT INTO users (email, password_hash) VALUES ($1,$2) RETURNING *',
      [email.toLowerCase(), hash]
    );
    res.status(201).json({ token: makeToken(rows[0]), user: formatUser(rows[0]) });
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
    res.json({ token: makeToken(rows[0]), user: formatUser(rows[0]) });
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

// ── Staff ─────────────────────────────────────────────────
app.get('/api/staff', auth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM staff ORDER BY id');
    res.json(rows.map(formatStaff));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/staff', auth, async (req, res) => {
  try {
    const { name, role, avatar, color, birthday, phone, schedule, commissionRate, permissions } = req.body;
    if (!name || !role) return res.status(400).json({ error: 'name and role required' });
    const { rows } = await pool.query(
      'INSERT INTO staff (name, role, avatar, color, birthday, phone, schedule, commission_rate, permissions) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
      [name, role, avatar || name[0].toUpperCase(), color || '#a8c5a0', birthday || null, phone || null, schedule || [], commissionRate || 30, JSON.stringify({ ...DEFAULT_PERMISSIONS, ...(permissions || {}) })]
    );
    res.status(201).json(formatStaff(rows[0]));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/staff/:id', auth, async (req, res) => {
  try {
    const { name, role, avatar, color, birthday, phone, schedule, commissionRate, permissions } = req.body;
    const { rows } = await pool.query(
      'UPDATE staff SET name=$1, role=$2, avatar=$3, color=$4, birthday=$5, phone=$6, schedule=$7, commission_rate=$8, permissions=$9 WHERE id=$10 RETURNING *',
      [name, role, avatar, color, birthday || null, phone || null, schedule || [], commissionRate || 30, JSON.stringify({ ...DEFAULT_PERMISSIONS, ...(permissions || {}) }), req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    res.json(formatStaff(rows[0]));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/staff/:id', auth, async (req, res) => {
  try {
    const { rows } = await pool.query('DELETE FROM staff WHERE id=$1 RETURNING *', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    res.json(formatStaff(rows[0]));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Bookings ──────────────────────────────────────────────
app.get('/api/bookings', auth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM bookings ORDER BY time');
    res.json(rows.map(formatBooking));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/bookings', auth, async (req, res) => {
  try {
    const { time, client, treatment, duration, staffId, notes, status, price, allergies, clientPhone } = req.body;
    if (!time || !client || !treatment || !duration) return res.status(400).json({ error: 'time, client, treatment, duration required' });
    const { rows } = await pool.query(
      'INSERT INTO bookings (time, client, treatment, duration, staff_id, notes, status, price, allergies, client_phone) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',
      [time, client, treatment, duration, staffId || null, notes || '', status || 'confirmed', price || 0, allergies || '', clientPhone || '']
    );
    res.status(201).json(formatBooking(rows[0]));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/bookings/:id', auth, async (req, res) => {
  try {
    const { time, client, treatment, duration, staffId, notes, status, price, allergies, clientPhone } = req.body;
    const { rows } = await pool.query(
      'UPDATE bookings SET time=$1, client=$2, treatment=$3, duration=$4, staff_id=$5, notes=$6, status=$7, price=$8, allergies=$9, client_phone=$10 WHERE id=$11 RETURNING *',
      [time, client, treatment, duration, staffId || null, notes || '', status || 'confirmed', price || 0, allergies || '', clientPhone || '', req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    res.json(formatBooking(rows[0]));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/bookings/:id', auth, async (req, res) => {
  try {
    const { rows } = await pool.query('DELETE FROM bookings WHERE id=$1 RETURNING *', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    res.json(formatBooking(rows[0]));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Inventory ─────────────────────────────────────────────
app.get('/api/inventory', auth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM inventory ORDER BY id');
    res.json(rows.map(formatInventory));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/inventory', auth, async (req, res) => {
  try {
    const { name, category, stock, threshold, unit, supplier, lastOrder } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    const { rows } = await pool.query(
      'INSERT INTO inventory (name, category, stock, threshold, unit, supplier, last_order) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [name, category || '', stock || 0, threshold || 5, unit || 'pcs', supplier || '', lastOrder || '']
    );
    res.status(201).json(formatInventory(rows[0]));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/inventory/:id', auth, async (req, res) => {
  try {
    const { name, category, stock, threshold, unit, supplier, lastOrder } = req.body;
    const { rows } = await pool.query(
      'UPDATE inventory SET name=$1, category=$2, stock=$3, threshold=$4, unit=$5, supplier=$6, last_order=$7 WHERE id=$8 RETURNING *',
      [name, category, stock, threshold, unit, supplier, lastOrder || '', req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    res.json(formatInventory(rows[0]));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/inventory/:id/stock', auth, async (req, res) => {
  try {
    const { delta } = req.body;
    const { rows } = await pool.query(
      'UPDATE inventory SET stock = GREATEST(0, stock + $1) WHERE id=$2 RETURNING *',
      [delta, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    res.json(formatInventory(rows[0]));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/inventory/:id/order', auth, async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const { rows } = await pool.query(
      'UPDATE inventory SET last_order=$1 WHERE id=$2 RETURNING *',
      [today, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    res.json(formatInventory(rows[0]));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/inventory/:id', auth, async (req, res) => {
  try {
    const { rows } = await pool.query('DELETE FROM inventory WHERE id=$1 RETURNING *', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    res.json(formatInventory(rows[0]));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Requests ──────────────────────────────────────────────
app.get('/api/requests', auth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM requests ORDER BY created_at DESC');
    res.json(rows.map(formatRequest));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/requests', auth, async (req, res) => {
  try {
    const { type, staffId, date, reason, swapWith, swapDay, productId, quantity } = req.body;
    if (!type || !staffId) return res.status(400).json({ error: 'type and staffId required' });
    const validTypes = ['sick', 'dayoff', 'swap', 'stock_request'];
    if (!validTypes.includes(type)) return res.status(400).json({ error: 'invalid type' });
    const { rows } = await pool.query(
      'INSERT INTO requests (type, staff_id, date, reason, swap_with, swap_day, product_id, quantity) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
      [type, Number(staffId), date || null, reason || '', swapWith || null, swapDay || null, productId || null, quantity || 0]
    );
    res.status(201).json(formatRequest(rows[0]));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/requests/:id', auth, async (req, res) => {
  try {
    const { status, reassignToStaffId } = req.body;
    const { rows: reqRows } = await pool.query('SELECT * FROM requests WHERE id=$1', [req.params.id]);
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
        'UPDATE requests SET status=$1 WHERE id=$2 RETURNING *',
        [status, req.params.id]
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
    const { rows } = await pool.query('SELECT * FROM announcements ORDER BY created_at DESC');
    res.json(rows.map(formatAnnouncement));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/announcements', auth, async (req, res) => {
  try {
    const { title, body, from } = req.body;
    if (!body) return res.status(400).json({ error: 'body required' });
    const { rows } = await pool.query(
      'INSERT INTO announcements (title, body, "from") VALUES ($1,$2,$3) RETURNING *',
      [title || '', body, from || 'Management']
    );
    res.status(201).json(formatAnnouncement(rows[0]));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/announcements/:id', auth, async (req, res) => {
  try {
    const { rows } = await pool.query('DELETE FROM announcements WHERE id=$1 RETURNING *', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    res.json(formatAnnouncement(rows[0]));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── SOP ───────────────────────────────────────────────────
app.get('/api/sop', auth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM sop ORDER BY id');
    res.json(rows.map(formatSop));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/sop', auth, async (req, res) => {
  try {
    const { title, body, category } = req.body;
    if (!title) return res.status(400).json({ error: 'title required' });
    const { rows } = await pool.query(
      'INSERT INTO sop (title, body, category) VALUES ($1,$2,$3) RETURNING *',
      [title, body || '', category || 'General']
    );
    res.status(201).json(formatSop(rows[0]));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Violations ────────────────────────────────────────────
app.get('/api/violations', auth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM violations ORDER BY created_at DESC');
    res.json(rows.map(formatViolation));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/violations', auth, async (req, res) => {
  try {
    const { staffId, sopId, note } = req.body;
    if (!staffId) return res.status(400).json({ error: 'staffId required' });
    const { rows } = await pool.query(
      'INSERT INTO violations (staff_id, sop_id, note) VALUES ($1,$2,$3) RETURNING *',
      [staffId, sopId || null, note || '']
    );
    res.status(201).json(formatViolation(rows[0]));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/violations/:id', auth, async (req, res) => {
  try {
    const { rows } = await pool.query('DELETE FROM violations WHERE id=$1 RETURNING *', [req.params.id]);
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
