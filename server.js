const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

const app = express();

const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',')
  : ['http://localhost:3001', 'https://spapilot-app.onrender.com'];

app.use(cors({ origin: allowedOrigins, credentials: true }));
app.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET || 'spapilot-dev-secret-change-me';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

// ── Format user for frontend (camelCase) ─────────────────
const formatUser = (u) => ({
  ...u,
  businessType: u.business_type,
  staffId: u.staff_id,
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

    CREATE TABLE IF NOT EXISTS staff (
      id              SERIAL PRIMARY KEY,
      name            TEXT NOT NULL,
      role            TEXT NOT NULL,
      avatar          TEXT,
      color           TEXT,
      birthday        TEXT,
      phone           TEXT,
      schedule        TEXT[],
      commission_rate INTEGER DEFAULT 30
    );

    CREATE TABLE IF NOT EXISTS bookings (
      id          SERIAL PRIMARY KEY,
      time        TEXT NOT NULL,
      client      TEXT NOT NULL,
      treatment   TEXT NOT NULL,
      duration    INTEGER NOT NULL,
      staff_id    INTEGER REFERENCES staff(id) ON DELETE SET NULL,
      notes       TEXT DEFAULT '',
      status      TEXT DEFAULT 'confirmed',
      price       NUMERIC DEFAULT 0,
      date        DATE DEFAULT CURRENT_DATE
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
      type        TEXT NOT NULL CHECK (type IN ('sick','dayoff','swap')),
      staff_id    INTEGER REFERENCES staff(id) ON DELETE CASCADE,
      date        TEXT,
      reason      TEXT DEFAULT '',
      swap_with   INTEGER,
      swap_day    TEXT,
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
      INSERT INTO bookings (time, client, treatment, duration, staff_id, notes, status, price) VALUES
        ('09:00', 'Sarah Mitchell', 'Deep Tissue Massage', 60, 2, 'Prefers firm pressure', 'confirmed', 350000),
        ('10:30', 'Emma Johnson',   'Swedish Massage',     90, 1, '',                      'confirmed', 450000),
        ('11:00', 'Lily Chen',      'Hot Stone Therapy',   75, 4, 'First time client',     'confirmed', 400000),
        ('12:00', 'Grace Lee',      'Aromatherapy',        60, 2, '',                      'confirmed', 300000),
        ('13:30', 'Maya Williams',  'Deep Tissue Massage', 90, 1, 'Allergic to nuts',      'confirmed', 450000),
        ('14:00', 'Zoe Martinez',   'Facial Treatment',    60, 3, '',                      'confirmed', 350000),
        ('15:30', 'Ava Thompson',   'Swedish Massage',     60, 4, '',                      'confirmed', 350000),
        ('16:00', 'Chloe Davis',    'Hot Stone Therapy',   90, 2, 'VIP client',            'confirmed', 500000);
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
      INSERT INTO sop (title, body) VALUES
        ('Guest Greeting',    'Greet every guest with a smile and their name if known.'),
        ('Room Reset',        'Leave every room pristine after each treatment.'),
        ('Product Decanting', 'Decant products carefully — respect what is given to you.'),
        ('Door Policy',       'Lock door from inside only when guest is present.'),
        ('Noise Policy',      'Keep voice low near treatment rooms at all times.');
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
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/staff', auth, async (req, res) => {
  try {
    const { name, role, avatar, color, birthday, phone, schedule, commissionRate } = req.body;
    if (!name || !role) return res.status(400).json({ error: 'name and role required' });
    const { rows } = await pool.query(
      'INSERT INTO staff (name, role, avatar, color, birthday, phone, schedule, commission_rate) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
      [name, role, avatar || name[0].toUpperCase(), color || '#a8c5a0', birthday || null, phone || null, schedule || [], commissionRate || 30]
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/staff/:id', auth, async (req, res) => {
  try {
    const { name, role, avatar, color, birthday, phone, schedule, commissionRate } = req.body;
    const { rows } = await pool.query(
      'UPDATE staff SET name=$1, role=$2, avatar=$3, color=$4, birthday=$5, phone=$6, schedule=$7, commission_rate=$8 WHERE id=$9 RETURNING *',
      [name, role, avatar, color, birthday, phone, schedule || [], commissionRate || 30, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/staff/:id', auth, async (req, res) => {
  try {
    const { rows } = await pool.query('DELETE FROM staff WHERE id=$1 RETURNING *', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Bookings ──────────────────────────────────────────────
app.get('/api/bookings', auth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM bookings ORDER BY time');
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/bookings', auth, async (req, res) => {
  try {
    const { time, client, treatment, duration, staff_id, notes, status, price } = req.body;
    if (!time || !client || !treatment || !duration) return res.status(400).json({ error: 'time, client, treatment, duration required' });
    const { rows } = await pool.query(
      'INSERT INTO bookings (time, client, treatment, duration, staff_id, notes, status, price) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
      [time, client, treatment, duration, staff_id || null, notes || '', status || 'confirmed', price || 0]
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/bookings/:id', auth, async (req, res) => {
  try {
    const { time, client, treatment, duration, staff_id, notes, status, price } = req.body;
    const { rows } = await pool.query(
      'UPDATE bookings SET time=$1, client=$2, treatment=$3, duration=$4, staff_id=$5, notes=$6, status=$7, price=$8 WHERE id=$9 RETURNING *',
      [time, client, treatment, duration, staff_id, notes, status, price || 0, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/bookings/:id', auth, async (req, res) => {
  try {
    const { rows } = await pool.query('DELETE FROM bookings WHERE id=$1 RETURNING *', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Inventory ─────────────────────────────────────────────
app.get('/api/inventory', auth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM inventory ORDER BY id');
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/inventory', auth, async (req, res) => {
  try {
    const { name, category, stock, threshold, unit, supplier, last_order } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    const { rows } = await pool.query(
      'INSERT INTO inventory (name, category, stock, threshold, unit, supplier, last_order) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [name, category || '', stock || 0, threshold || 5, unit || 'pcs', supplier || '', last_order || '']
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/inventory/:id', auth, async (req, res) => {
  try {
    const { name, category, stock, threshold, unit, supplier, last_order } = req.body;
    const { rows } = await pool.query(
      'UPDATE inventory SET name=$1, category=$2, stock=$3, threshold=$4, unit=$5, supplier=$6, last_order=$7 WHERE id=$8 RETURNING *',
      [name, category, stock, threshold, unit, supplier, last_order, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/inventory/:id', auth, async (req, res) => {
  try {
    const { rows } = await pool.query('DELETE FROM inventory WHERE id=$1 RETURNING *', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Requests ──────────────────────────────────────────────
app.get('/api/requests', auth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM requests ORDER BY created_at DESC');
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/requests', auth, async (req, res) => {
  try {
    const { type, staffId, date, reason, swapWith, swapDay } = req.body;
    if (!type || !staffId) return res.status(400).json({ error: 'type and staffId required' });
    if (!['sick','dayoff','swap'].includes(type)) return res.status(400).json({ error: 'invalid type' });
    const { rows } = await pool.query(
      'INSERT INTO requests (type, staff_id, date, reason, swap_with, swap_day) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [type, Number(staffId), date || null, reason || '', swapWith || null, swapDay || null]
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/requests/:id', auth, async (req, res) => {
  try {
    const { status } = req.body;
    const { rows } = await pool.query(
      'UPDATE requests SET status=$1 WHERE id=$2 RETURNING *',
      [status, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Announcements ─────────────────────────────────────────
app.get('/api/announcements', auth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM announcements ORDER BY created_at DESC');
    res.json(rows);
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
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/announcements/:id', auth, async (req, res) => {
  try {
    const { rows } = await pool.query('DELETE FROM announcements WHERE id=$1 RETURNING *', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── SOP ───────────────────────────────────────────────────
app.get('/api/sop', auth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM sop ORDER BY id');
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/sop', auth, async (req, res) => {
  try {
    const { title, body } = req.body;
    if (!title) return res.status(400).json({ error: 'title required' });
    const { rows } = await pool.query(
      'INSERT INTO sop (title, body) VALUES ($1,$2) RETURNING *',
      [title, body || '']
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Violations ────────────────────────────────────────────
app.get('/api/violations', auth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM violations ORDER BY created_at DESC');
    res.json(rows);
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
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/violations/:id', auth, async (req, res) => {
  try {
    const { rows } = await pool.query('DELETE FROM violations WHERE id=$1 RETURNING *', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    res.json(rows[0]);
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
