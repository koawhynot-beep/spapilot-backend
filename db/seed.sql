-- SpaPilot demo seed data
-- pin_hash values are bcrypt of the 4-digit PIN listed in each comment.
-- Generate real hashes with: node -e "console.log(require('bcryptjs').hashSync('1234',10))"
-- Placeholder hashes below use a known demo pattern; replace before production.

TRUNCATE staff, bookings, inventory, requests, announcements, sops, sop_violations, sessions RESTART IDENTITY CASCADE;

-- ========== Staff (8) ==========
INSERT INTO staff (name, role, avatar, color, birthday, schedule, username, pin_hash, is_manager) VALUES
  ('Nyoman Indah', 'Manager',      'N', '#2d5a4a', '1985-09-12', ARRAY['Mon','Tue','Wed','Thu','Fri'],       'yanti',   '$2a$10$DEMO_HASH_1234_MANAGER',    TRUE),
  ('Putri Ayu',    'Therapist',    'P', '#b8956a', '1990-03-15', ARRAY['Mon','Tue','Wed','Thu','Fri'],       'putri',   '$2a$10$DEMO_HASH_1111_PUTRI',      FALSE),
  ('Kadek Sari',   'Therapist',    'K', '#2d5a4a', '1993-07-22', ARRAY['Tue','Wed','Thu','Fri','Sat'],       'kadek',   '$2a$10$DEMO_HASH_2222_KADEK',      FALSE),
  ('Wayan Dewi',   'Receptionist', 'W', '#8ba888', '1995-11-08', ARRAY['Mon','Tue','Thu','Fri','Sat'],       'wayan',   '$2a$10$DEMO_HASH_3333_WAYAN',      FALSE),
  ('Made Surya',   'Therapist',    'M', '#d4b896', '1988-04-30', ARRAY['Mon','Wed','Thu','Fri','Sun'],       'made',    '$2a$10$DEMO_HASH_4444_MADE',       FALSE),
  ('Ketut Ari',    'Therapist',    'K', '#6b8e7f', '1992-02-18', ARRAY['Tue','Wed','Fri','Sat','Sun'],       'ketut',   '$2a$10$DEMO_HASH_5555_KETUT',      FALSE),
  ('Luh Komang',   'Housekeeping', 'L', '#a17c52', '1987-06-03', ARRAY['Mon','Tue','Wed','Fri','Sat'],       'luh',     '$2a$10$DEMO_HASH_6666_LUH',        FALSE),
  ('Dewi Ratih',   'Receptionist', 'D', '#c9a97a', '1994-10-25', ARRAY['Wed','Thu','Fri','Sat','Sun'],       'dewi',    '$2a$10$DEMO_HASH_7777_DEWI',       FALSE);

-- ========== Bookings (10, today) ==========
INSERT INTO bookings (date, time, client, treatment, duration, staff_id, notes, status) VALUES
  (CURRENT_DATE, '09:00', 'Sarah Mitchell', 'Deep Tissue Massage', 60, 3, 'Prefers firm pressure',     'confirmed'),
  (CURRENT_DATE, '09:30', 'Emma Johnson',   'Swedish Massage',     90, 2, '',                          'confirmed'),
  (CURRENT_DATE, '10:30', 'Lily Chen',      'Hot Stone Therapy',   75, 5, 'First time client',         'confirmed'),
  (CURRENT_DATE, '11:00', 'Grace Lee',      'Aromatherapy',        60, 3, '',                          'confirmed'),
  (CURRENT_DATE, '12:00', 'Maya Williams',  'Deep Tissue Massage', 90, 2, 'Allergic to nuts',          'confirmed'),
  (CURRENT_DATE, '13:30', 'Zoe Martinez',   'Facial Treatment',    60, 4, '',                          'confirmed'),
  (CURRENT_DATE, '14:00', 'Ava Thompson',   'Swedish Massage',     60, 5, '',                          'confirmed'),
  (CURRENT_DATE, '15:00', 'Chloe Davis',    'Hot Stone Therapy',   90, 3, 'VIP client',                'confirmed'),
  (CURRENT_DATE, '16:00', 'Isla Brown',     'Couples Massage',     90, 6, 'Anniversary',               'confirmed'),
  (CURRENT_DATE, '17:30', 'Ruby Patel',     'Reflexology',         60, 2, '',                          'confirmed');

-- ========== Inventory (10) ==========
INSERT INTO inventory (name, category, stock, threshold, unit, supplier, last_order) VALUES
  ('Massage Oil',              'Oils',      24, 5,  'bottles', 'BaliNaturals', '2026-03-01'),
  ('Hot Stones Set',           'Equipment', 3,  2,  'sets',    'SpaEquip Co',  '2026-01-15'),
  ('Bamboo Towels',            'Linens',    48, 10, 'pcs',     'LinenPro',     '2026-02-20'),
  ('Lavender Essential Oil',   'Oils',      4,  5,  'bottles', 'BaliNaturals', '2026-02-28'),
  ('Face Mask Sheets',         'Skincare',  60, 15, 'pcs',     'BeautySupply', '2026-03-05'),
  ('Sandalwood Candles',       'Ambiance',  12, 8,  'pcs',     'AromaCo',      '2026-02-10'),
  ('Exfoliating Scrub',        'Skincare',  8,  6,  'jars',    'BeautySupply', '2026-02-15'),
  ('Disposable Sheets',        'Linens',    200,50, 'pcs',     'LinenPro',     '2026-03-03'),
  ('Eucalyptus Steam Oil',     'Oils',      6,  4,  'bottles', 'BaliNaturals', '2026-03-10'),
  ('Cotton Headbands',         'Linens',    30, 12, 'pcs',     'LinenPro',     '2026-03-08');

-- ========== SOPs (5) ==========
INSERT INTO sops (title, category, description) VALUES
  ('Client Greeting Protocol',  'Reception',  'Greet within 10 seconds, offer welcome tea, confirm booking.'),
  ('Treatment Room Setup',      'Operations', 'Fresh linens, oils at 38°C, ambient music, dim lighting.'),
  ('Sanitation Standards',      'Hygiene',    'Disinfect tools between clients. Wash hands at least 30 seconds.'),
  ('Inventory Check Procedure', 'Operations', 'End-of-day count; flag any item at or below threshold.'),
  ('Emergency Protocols',       'Safety',     'Evacuation map posted. First-aid kit in reception.');

-- ========== Announcements ==========
INSERT INTO announcements (title, body, "from", author_id) VALUES
  ('Welcome to SpaPilot', 'Have a beautiful day, team. Remember: every guest leaves lighter than they arrived.', 'Nyoman Indah', 1);
