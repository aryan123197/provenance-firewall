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
-- Outcome of sending an allowed payment to the provider. Mutable: a retryable failure can later succeed.
CREATE TABLE IF NOT EXISTS executions (
  idempotency_key TEXT PRIMARY KEY REFERENCES decisions(idempotency_key),
  state           TEXT NOT NULL CHECK (state IN ('executed', 'failed')),
  retryable       INTEGER NOT NULL DEFAULT 0,
  payload_json    TEXT NOT NULL,
  reference       TEXT,
  request_id      TEXT,
  provider_status TEXT,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS executions_reference ON executions(reference);
CREATE INDEX IF NOT EXISTS executions_request_id ON executions(request_id);

-- Provider webhook events already processed (providers retry deliveries).
CREATE TABLE IF NOT EXISTS webhook_events (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL,
  received_at TEXT NOT NULL
);

-- Places where the provider's records disagree with ours. Opened by reconciliation, resolved if they turn out to be a race.
CREATE TABLE IF NOT EXISTS drift (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL CHECK (kind IN ('unmatched_payment', 'detail_mismatch')),
  reference   TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  created_at  TEXT NOT NULL,
  resolved_at TEXT,
  UNIQUE (kind, reference)
);
-- Pending and resolved human approvals. One per idempotency key, bound to that exact intent.
CREATE TABLE IF NOT EXISTS approvals (
  id              TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE REFERENCES decisions(idempotency_key),
  request_hash    TEXT NOT NULL,
  intent_json     TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  requested_at    TEXT NOT NULL,
  resolved_by     TEXT,
  resolved_at     TEXT,
  note            TEXT
);

-- Hash-chained, signed history of everything that happened. Rows are never changed or removed.
CREATE TABLE IF NOT EXISTS audit_keys (
  key_id     TEXT PRIMARY KEY,
  public_pem TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_log (
  seq          INTEGER PRIMARY KEY,
  ts           TEXT NOT NULL,
  type         TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  prev_hash    TEXT NOT NULL,
  key_id       TEXT NOT NULL REFERENCES audit_keys(key_id),
  hash         TEXT NOT NULL,
  signature    TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;

CREATE INDEX IF NOT EXISTS payments_created ON payments(created_at);
`;
