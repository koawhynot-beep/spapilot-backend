const express = require('express');
const cors = require('cors');

const app = express();
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',')
  : ['http://localhost:3001'];
app.use(cors({ origin: allowedOrigins }));
app.use(express.json());

const STAFF = [
  { id: 1, name: 'Putri Ayu',    role: 'Therapist',    avatar: 'P', color: '#d4a574', birthday: '1990-03-15' },
  { id: 2, name: 'Kadek Sari',   role: 'Therapist',    avatar: 'K', color: '#a8c5a0', birthday: '1993-07-22' },
  { id: 3, name: 'Wayan Dewi',   role: 'Receptionist', avatar: 'W', color: '#93c5fd', birthday: '1995-11-08' },
  { id: 4, name: 'Made Surya',   role: 'Therapist',    avatar: 'M', color: '#c4b5fd', birthday: '1988-04-30' },
  { id: 5, name: 'Nyoman Indah', role: 'Manager',      avatar: 'N', color: '#2d5a4a', birthday: '1985-09-12' },
];

const BOOKINGS = [
  { id: 1, time: '09:00', client: 'Sarah Mitchell', treatment: 'Deep Tissue Massage', duration: 60, staffId: 2, notes: 'Prefers firm pressure', status: 'confirmed' },
  { id: 2, time: '10:30', client: 'Emma Johnson',   treatment: 'Swedish Massage',     duration: 90, staffId: 1, notes: '',                  status: 'confirmed' },
  { id: 3, time: '11:00', client: 'Lily Chen',      treatment: 'Hot Stone Therapy',   duration: 75, staffId: 4, notes: 'First time client',  status: 'confirmed' },
  { id: 4, time: '12:00', client: 'Grace Lee',      treatment: 'Aromatherapy',        duration: 60, staffId: 2, notes: '',                  status: 'confirmed' },
  { id: 5, time: '13:30', client: 'Maya Williams',  treatment: 'Deep Tissue Massage', duration: 90, staffId: 1, notes: 'Allergic to nuts',  status: 'confirmed' },
  { id: 6, time: '14:00', client: 'Zoe Martinez',   treatment: 'Facial Treatment',    duration: 60, staffId: 3, notes: '',                  status: 'confirmed' },
  { id: 7, time: '15:30', client: 'Ava Thompson',   treatment: 'Swedish Massage',     duration: 60, staffId: 4, notes: '',                  status: 'confirmed' },
  { id: 8, time: '16:00', client: 'Chloe Davis',    treatment: 'Hot Stone Therapy',   duration: 90, staffId: 2, notes: 'VIP client',         status: 'confirmed' },
];

const INVENTORY = [
  { id: 1, name: 'Massage Oil',           category: 'Oils',      stock: 24,  threshold: 5,  unit: 'bottles', supplier: 'BaliNaturals', lastOrder: '2024-03-01' },
  { id: 2, name: 'Hot Stones Set',         category: 'Equipment', stock: 3,   threshold: 2,  unit: 'sets',    supplier: 'SpaEquip Co',  lastOrder: '2024-01-15' },
  { id: 3, name: 'Bamboo Towels',          category: 'Linens',    stock: 48,  threshold: 10, unit: 'pcs',     supplier: 'LinenPro',     lastOrder: '2024-02-20' },
  { id: 4, name: 'Lavender Essential Oil', category: 'Oils',      stock: 4,   threshold: 5,  unit: 'bottles', supplier: 'BaliNaturals', lastOrder: '2024-02-28' },
  { id: 5, name: 'Face Mask Sheets',       category: 'Skincare',  stock: 60,  threshold: 15, unit: 'pcs',     supplier: 'BeautySupply', lastOrder: '2024-03-05' },
  { id: 6, name: 'Sandalwood Candles',     category: 'Ambiance',  stock: 12,  threshold: 8,  unit: 'pcs',     supplier: 'AromaCo',      lastOrder: '2024-02-10' },
  { id: 7, name: 'Exfoliating Scrub',      category: 'Skincare',  stock: 8,   threshold: 6,  unit: 'jars',    supplier: 'BeautySupply', lastOrder: '2024-02-15' },
  { id: 8, name: 'Disposable Sheets',      category: 'Linens',    stock: 200, threshold: 50, unit: 'pcs',     supplier: 'LinenPro',     lastOrder: '2024-03-03' },
];

const requests = [];

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.get('/api/staff', (req, res) => res.json(STAFF));

app.get('/api/bookings', (req, res) => res.json(BOOKINGS));

app.get('/api/inventory', (req, res) => res.json(INVENTORY));

app.get('/api/requests', (req, res) => res.json(requests));

app.post('/api/requests', (req, res) => {
  const { type, staffId, date, reason, swapWith, swapDay } = req.body;
  if (!type || !staffId) {
    return res.status(400).json({ error: 'type and staffId are required' });
  }
  if (!['sick', 'dayoff', 'swap'].includes(type)) {
    return res.status(400).json({ error: 'type must be sick, dayoff, or swap' });
  }
  const request = {
    id: requests.length + 1,
    type,
    staffId: Number(staffId),
    date: date || null,
    reason: reason || '',
    swapWith: swapWith || null,
    swapDay: swapDay || null,
    status: 'pending',
    createdAt: new Date().toISOString(),
  };
  requests.push(request);
  res.status(201).json(request);
});

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`SpaPilot backend running on port ${PORT}`));
