-- SpaPilot PostgreSQL schema
-- Design-only: not yet connected. Backend uses in-memory data shaped to match.

-- ========== Extensions ==========
CREATE EXTENSION IF NOT EXISTS "pgcrypto"; -- for gen_random_uuid() if desired

-- ========== staff ==========
CREATE TABLE IF NOT EXISTS staff (
    id            SERIAL PRIMARY KEY,
    name          TEXT        NOT NULL,
    role          TEXT        NOT NULL CHECK (role IN ('Therapist', 'Receptionist', 'Manager', 'Housekeeping')),
    avatar        TEXT        NOT NULL,
    color         TEXT        NOT NULL DEFAULT '#2d5a4a',
    birthday      DATE,
    schedule      TEXT[]      NOT NULL DEFAULT ARRAY['Mon','Tue','Wed','Thu','Fri']::TEXT[],
    username      TEXT        UNIQUE NOT NULL,
    pin_hash      TEXT        NOT NULL,
    is_manager    BOOLEAN     NOT NULL DEFAULT FALSE,
    active        BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_staff_username ON staff (username);
CREATE INDEX IF NOT EXISTS idx_staff_role     ON staff (role);

-- ========== bookings ==========
CREATE TABLE IF NOT EXISTS bookings (
    id           SERIAL PRIMARY KEY,
    date         DATE        NOT NULL,
    time         TIME        NOT NULL,
    client       TEXT        NOT NULL,
    treatment    TEXT        NOT NULL,
    duration     INTEGER     NOT NULL DEFAULT 60 CHECK (duration > 0),
    staff_id     INTEGER     NOT NULL REFERENCES staff(id) ON DELETE RESTRICT,
    notes        TEXT        DEFAULT '',
    status       TEXT        NOT NULL DEFAULT 'confirmed'
                 CHECK (status IN ('confirmed','cancelled','completed','no_show')),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_bookings_date     ON bookings (date);
CREATE INDEX IF NOT EXISTS idx_bookings_staff    ON bookings (staff_id);
CREATE INDEX IF NOT EXISTS idx_bookings_day_time ON bookings (date, time);

-- ========== inventory ==========
CREATE TABLE IF NOT EXISTS inventory (
    id          SERIAL PRIMARY KEY,
    name        TEXT        NOT NULL,
    category    TEXT        NOT NULL DEFAULT 'Other',
    stock       INTEGER     NOT NULL DEFAULT 0 CHECK (stock >= 0),
    threshold   INTEGER     NOT NULL DEFAULT 5 CHECK (threshold >= 0),
    unit        TEXT        NOT NULL DEFAULT 'pcs',
    supplier    TEXT        DEFAULT '',
    last_order  DATE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_inventory_category ON inventory (category);
CREATE INDEX IF NOT EXISTS idx_inventory_low_stock ON inventory (stock, threshold);

-- ========== requests (sick / dayoff / swap) ==========
CREATE TABLE IF NOT EXISTS requests (
    id              SERIAL PRIMARY KEY,
    type            TEXT        NOT NULL CHECK (type IN ('sick','dayoff','swap')),
    staff_id        INTEGER     NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
    date            DATE        NOT NULL,
    reason          TEXT        DEFAULT '',
    swap_with       INTEGER     REFERENCES staff(id) ON DELETE SET NULL,
    swap_day        DATE,
    status          TEXT        NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','approved','declined')),
    resolved_by     INTEGER     REFERENCES staff(id) ON DELETE SET NULL,
    resolved_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_requests_status ON requests (status);
CREATE INDEX IF NOT EXISTS idx_requests_staff  ON requests (staff_id);

-- ========== announcements ==========
CREATE TABLE IF NOT EXISTS announcements (
    id          SERIAL PRIMARY KEY,
    title       TEXT        NOT NULL,
    body        TEXT        NOT NULL,
    "from"      TEXT        NOT NULL DEFAULT 'Management',
    author_id   INTEGER     REFERENCES staff(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_announcements_created ON announcements (created_at DESC);

-- ========== sops ==========
CREATE TABLE IF NOT EXISTS sops (
    id          SERIAL PRIMARY KEY,
    title       TEXT        NOT NULL,
    category    TEXT        NOT NULL,
    description TEXT        NOT NULL,
    active      BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ========== sop_violations ==========
CREATE TABLE IF NOT EXISTS sop_violations (
    id          SERIAL PRIMARY KEY,
    staff_id    INTEGER     NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
    sop_id      INTEGER     NOT NULL REFERENCES sops(id)  ON DELETE RESTRICT,
    note        TEXT        DEFAULT '',
    logged_by   INTEGER     REFERENCES staff(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_violations_staff ON sop_violations (staff_id);
CREATE INDEX IF NOT EXISTS idx_violations_sop   ON sop_violations (sop_id);

-- ========== sessions (JWT denylist / session log) ==========
CREATE TABLE IF NOT EXISTS sessions (
    id          SERIAL PRIMARY KEY,
    staff_id    INTEGER     NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
    token_hash  TEXT        NOT NULL,
    issued_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at  TIMESTAMPTZ NOT NULL,
    revoked_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions (token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_staff ON sessions (staff_id);

-- ========== updated_at trigger ==========
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE t TEXT;
BEGIN
    FOR t IN SELECT unnest(ARRAY['staff','bookings','inventory']) LOOP
        EXECUTE format('DROP TRIGGER IF EXISTS trg_%s_updated ON %s', t, t);
        EXECUTE format('CREATE TRIGGER trg_%s_updated BEFORE UPDATE ON %s
                        FOR EACH ROW EXECUTE FUNCTION touch_updated_at()', t, t);
    END LOOP;
END $$;
