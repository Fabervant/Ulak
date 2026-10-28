-- Outbound mail (phase 0). Each app sends with its own server-only send key; only its SHA-256 is kept.
-- The From address is derived from the app id and the deployment's mail domain, so it is not stored.
ALTER TABLE apps ADD COLUMN send_key_hash TEXT;
CREATE UNIQUE INDEX apps_send_key_hash ON apps(send_key_hash);
ALTER TABLE apps ADD COLUMN mail_from_name TEXT;
ALTER TABLE apps ADD COLUMN mail_kinds TEXT NOT NULL DEFAULT '[]';
ALTER TABLE apps ADD COLUMN mail_labels TEXT NOT NULL DEFAULT '[]';

-- One row per accepted mail. The recipient and the content live here only until the vendor accepts the
-- mail or it is given up; the lasting record is metadata and a per-app keyed hash of the address.
CREATE TABLE mails (
  id TEXT PRIMARY KEY,
  app TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  locale TEXT NOT NULL,
  addr_hash TEXT NOT NULL,
  user_ref TEXT,
  idempotency_key TEXT,
  to_addr TEXT,
  subject TEXT,
  text_body TEXT,
  html_body TEXT,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  lease_until TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  sent_at TEXT,
  delivered_at TEXT,
  vendor_request_id TEXT,
  last_error TEXT,
  operator_told_at TEXT,
  last_activity_at TEXT NOT NULL
);
CREATE UNIQUE INDEX mails_idem ON mails(app, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX mails_addr ON mails(app, addr_hash, created_at);
CREATE INDEX mails_due ON mails(status, next_attempt_at);
CREATE INDEX mails_vendor ON mails(vendor_request_id);
CREATE INDEX mails_user ON mails(app, user_ref);
CREATE INDEX mails_activity ON mails(last_activity_at);

-- One row per call to the vendor, for the sending-health check; no personal data, kept an hour.
CREATE TABLE mail_attempts (
  at TEXT NOT NULL,
  ok INTEGER NOT NULL
);
CREATE INDEX mail_attempts_at ON mail_attempts(at);

-- What the API Worker found about itself, for the health check the admin Worker serves (which cannot
-- read the API Worker's settings). The outbox timer writes `mail_config` on every run.
CREATE TABLE service_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  at TEXT NOT NULL
);
