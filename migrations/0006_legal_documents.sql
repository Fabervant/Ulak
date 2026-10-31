-- Legal documents (phase 1). The copy the law asks for, written once when Ulak accepts the mail and
-- afterwards only stamped with the evidence times. It outlives the transport row in `mails` and a
-- deletion request, and is deleted only when its keeping period, counted from `keep_from`, has passed.
-- No foreign key to `apps` or `mails`: removing an app or expiring a transport row never deletes a copy.
CREATE TABLE legal_documents (
  mail_id TEXT PRIMARY KEY,
  app TEXT NOT NULL,
  reference TEXT NOT NULL,
  version TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  label TEXT NOT NULL,
  locale TEXT NOT NULL,
  user_ref TEXT,
  to_addr TEXT NOT NULL,
  subject TEXT NOT NULL,
  text_body TEXT NOT NULL,
  text_sha256 TEXT NOT NULL,
  addr_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  keep_from TEXT,
  sent_at TEXT,
  vendor_request_id TEXT,
  delivered_at TEXT,
  delivered_server TEXT
);
-- A sale's key is never cleared while its copy is kept, so a late reconciliation never mails it twice.
CREATE UNIQUE INDEX legal_documents_idem ON legal_documents(app, idempotency_key);
CREATE INDEX legal_documents_reference ON legal_documents(reference);
CREATE INDEX legal_documents_created ON legal_documents(created_at);
CREATE INDEX legal_documents_addr ON legal_documents(app, addr_hash);
CREATE INDEX legal_documents_user ON legal_documents(app, user_ref);
CREATE INDEX legal_documents_vendor ON legal_documents(vendor_request_id);
CREATE INDEX legal_documents_keep ON legal_documents(keep_from);

-- One row per problem with one copy; it stays open until the operator closes it with a reason.
CREATE TABLE legal_alerts (
  id TEXT PRIMARY KEY,
  mail_id TEXT NOT NULL REFERENCES legal_documents(mail_id) ON DELETE CASCADE,
  app TEXT NOT NULL,
  kind TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  told_at TEXT,
  closed_at TEXT,
  closed_by TEXT,
  close_reason TEXT,
  replaced_by TEXT
);
CREATE UNIQUE INDEX legal_alerts_open ON legal_alerts(mail_id, kind) WHERE closed_at IS NULL;
CREATE INDEX legal_alerts_closed ON legal_alerts(closed_at);

-- Idempotency keys are scoped by kind: one sale's id can key both its legal document and its receipt.
DROP INDEX mails_idem;
CREATE UNIQUE INDEX mails_idem ON mails(app, kind, idempotency_key) WHERE idempotency_key IS NOT NULL;
