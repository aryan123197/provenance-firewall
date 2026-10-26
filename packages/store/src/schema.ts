export const SCHEMA = `
CREATE TABLE IF NOT EXISTS vendors (
  id        TEXT PRIMARY KEY,
  name      TEXT NOT NULL UNIQUE,
  account   TEXT NOT NULL,
  category  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS purchase_orders (
  id        TEXT PRIMARY KEY,
  vendor_id TEXT NOT NULL REFERENCES vendors(id),
  amount    INTEGER NOT NULL CHECK (amount >= 0),
  currency  TEXT NOT NULL,
  status    TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed'))
);

-- One row per idempotency key. Written once, never changed.
CREATE TABLE IF NOT EXISTS decisions (
  idempotency_key TEXT PRIMARY KEY,
  agent_id        TEXT NOT NULL,
  request_hash    TEXT NOT NULL,
  verdict         TEXT NOT NULL,
  decision_json   TEXT NOT NULL,
  created_at      TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS decisions_no_update BEFORE UPDATE ON decisions
BEGIN SELECT RAISE(ABORT, 'decisions are append-only'); END;
CREATE TRIGGER IF NOT EXISTS decisions_no_delete BEFORE DELETE ON decisions
BEGIN SELECT RAISE(ABORT, 'decisions are append-only'); END;

-- Allowed payments, used for daily spend and velocity counters.
CREATE TABLE IF NOT EXISTS payments (
  idempotency_key TEXT PRIMARY KEY REFERENCES decisions(idempotency_key),
  agent_id        TEXT NOT NULL,
  vendor_id       TEXT,
  amount          INTEGER NOT NULL,
  currency        TEXT NOT NULL,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS payments_created ON payments(created_at);
`;
