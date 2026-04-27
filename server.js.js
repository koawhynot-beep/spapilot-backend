const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();

const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',')
  : ['http://localhost:3001'];

app.use(cors({ origin: allowedOrigins }));
app.use(express.json());

// ── Database ──────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

// ── Create tables on startup ──────────────────────────────
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS staff (
      id        SERIAL PRIMARY KEY,
      name      TEXT NOT NULL,
      role      TEXT NOT NULL,
      avatar    TEXT,
      color     TEXT,
      birthday  TEXT
    );

    CREATE TABLE IF NOT EXISTS bookings (
      id          SERIAL PRIMARY KEY,
      time        TEXT NOT NULL,
      client      TEXT NOT NULL,
      treatment   TEXT NOT NULL,
      duration    INTEGER NOT NULL,
      staff_id    INTEGER REFERENCES staff(id),
      notes       TEXT DEFAULT '',
      status      TEXT DEFAULT 'confirmed',
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
      staff_id    INTEGER REFERENCES staff(id),
      date        TEXT,
      reason      TEXT DEFAULT '',
      swap_with   INTEGER,
      swap_day    TEXT,
      status      TEXT DEFAULT 'pending',
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Seed staff if empty
  const { rowCount } = await pool.query('SELECT 1 FROM staff LIMIT 1');
  if (rowCount === 0) {
    await pool.query(`
      INSERT INTO staff (name, role, avatar, color, birthday) VALUES
        ('Putri Ayu',    'Therapist',    'P', '#d4a574', '1990-03-15'),
        ('Kadek Sari',   'Therapist',    'K', '#a8c5a0', '1993-07-22'),
        ('Wayan Dewi',   'Receptionist', 'W', '#93c5fd', '1995-11-08'),
        ('Made Surya',   'Therapist',    'M', '#c4b5fd', '1988-04-30'),
        ('Nyoman Indah', 'Manager',      'N', '#2d5a4a', '1985-09-12');
    `);

    await pool.query(`
      INSERT INTO bookings (time, client, treatment, duration, staff_id, notes, status) VALUES
        ('09:00', 'Sarah Mitchell', 'Deep Tissue Massage', 60, 2, 'Prefers firm pressure', 'confirmed'),
        ('10:30', 'Emma Johnson',   'Swedish Massage',     90, 1, '',                      'confirmed'),
        ('11:00', 'Lily Chen',      'Hot Stone Therapy',   75, 4, 'First time client',     'confirmed'),
        ('12:00', 'Grace Lee',      'Aromatherapy',        60, 2, '',                      'confirmed'),
        ('13:30', 'Maya Williams',  'Deep Tissue Massage', 90, 1, 'Allergic to nuts',      'confirmed'),
        ('14:00', 'Zoe Martinez',   'Facial Treatment',    60, 3, '',                      'confirmed'),
        ('15:30', 'Ava Thompson',   'Swedish Massage',     60, 4, '',                      'confirmed'),
        ('16:00', 'Chloe Davis',    'Hot Stone Therapy',   90, 2, 'VIP client',            'confirmed');
    `);

    await pool.query(`
      INSERT INTO inventory (name, category, stock, threshold, unit, supplier, last_order) VALUES
        ('Massage Oil',            'Oils',      24,  5,  'bottles', 'BaliNaturals', '2024-03-01'),
        ('Hot Stones Set',         'Equipment',  3,  2,  'sets',    'SpaEquip Co',  '2024-01-15'),
        ('Bamboo Towels',          'Linens',    48, 10,  'pcs',     'LinenPro',     '2024-02-20'),
        ('Lavender Essential Oil', 'Oils',       4,  5,  'bottles', 'BaliNaturals', '2024-02-28'),
        ('Face Mask Sheets',       'Skincare',  60, 15,  'pcs',     'BeautySupply', '2024-03-05'),
        ('Sandalwood Candles',     'Ambiance',  12,  8,  'pcs',     'AromaCo',      '2024-02-10'),
        ('Exfoliating Scrub',      'Skincare',   8,  6,  'jars',    'BeautySupply', '2024-02-15'),
        ('Disposable Sheets',      'Linens',   200, 50,  'pcs',     'LinenPro',     '2024-03-03');
    `);

    console.log('Database seeded with demo data');
  }

  console.log('Database ready');
}

// ── Routes ────────────────────────────────────────────────

app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Staff
app.get('/api/staff', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM staff ORDER BY id');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/staff', async (req, res) => {
  try {
    const { name, role, avatar, color, birthday } = req.body;
    if (!name || !role) return res.status(400).json({ error: 'name and role required' });
    const { rows } = await pool.query(
      'INSERT INTO staff (name, role, avatar, color, birthday) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [name, role, avatar || name[0], color || '#a8c5a0', birthday || null]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/staff/:id', async (req, res) => {
  try {
    const { name, role, avatar, color, birthday } = req.body;
    const { rows } = await pool.query(
      'UPDATE staff SET name=$1, role=$2, avatar=$3, color=$4, birthday=$5 WHERE id=$6 RETURNING *',
      [name, role, avatar, color, birthday, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/staff/:id', async (req, res) => {
  try {
    const { rows } = await pool.query('DELETE FROM staff WHERE id=$1 RETURNING *', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Bookings
app.get('/api/bookings', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM bookings ORDER BY time');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/bookings', async (req, res) => {
  try {
    const { time, client, treatment, duration, staff_id, notes, status } = req.body;
    if (!time || !client || !treatment || !duration) {
      return res.status(400).json({ error: 'time, client, treatment, duration required' });
    }
    const { rows } = await pool.query(
      'INSERT INTO bookings (time, client, treatment, duration, staff_id, notes, status) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [time, client, treatment, duration, staff_id || null, notes || '', status || 'confirmed']
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/bookings/:id', async (req, res) => {
  try {
    const { time, client, treatment, duration, staff_id, notes, status } = req.body;
    const { rows } = await pool.query(
      'UPDATE bookings SET time=$1, client=$2, treatment=$3, duration=$4, staff_id=$5, notes=$6, status=$7 WHERE id=$8 RETURNING *',
      [time, client, treatment, duration, staff_id, notes, status, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/bookings/:id', async (req, res) => {
  try {
    const { rows } = await pool.query('DELETE FROM bookings WHERE id=$1 RETURNING *', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Inventory
app.get('/api/inventory', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM inventory ORDER BY id');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/inventory', async (req, res) => {
  try {
    const { name, category, stock, threshold, unit, supplier, last_order } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    const { rows } = await pool.query(
      'INSERT INTO inventory (name, category, stock, threshold, unit, supplier, last_order) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [name, category || '', stock || 0, threshold || 5, unit || 'pcs', supplier || '', last_order || '']
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/inventory/:id', async (req, res) => {
  try {
    const { name, category, stock, threshold, unit, supplier, last_order } = req.body;
    const { rows } = await pool.query(
      'UPDATE inventory SET name=$1, category=$2, stock=$3, threshold=$4, unit=$5, supplier=$6, last_order=$7 WHERE id=$8 RETURNING *',
      [name, category, stock, threshold, unit, supplier, last_order, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/inventory/:id', async (req, res) => {
  try {
    const { rows } = await pool.query('DELETE FROM inventory WHERE id=$1 RETURNING *', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Requests
app.get('/api/requests', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM requests ORDER BY created_at DESC');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/requests', async (req, res) => {
  try {
    const { type, staffId, date, reason, swapWith, swapDay } = req.body;
    if (!type || !staffId) return res.status(400).json({ error: 'type and staffId required' });
    if (!['sick', 'dayoff', 'swap'].includes(type)) {
      return res.status(400).json({ error: 'type must be sick, dayoff, or swap' });
    }
    const { rows } = await pool.query(
      'INSERT INTO requests (type, staff_id, date, reason, swap_with, swap_day) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [type, Number(staffId), date || null, reason || '', swapWith || null, swapDay || null]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/requests/:id', async (req, res) => {
  try {
    const { status } = req.body;
    const { rows } = await pool.query(
      'UPDATE requests SET status=$1 WHERE id=$2 RETURNING *',
      [status, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
