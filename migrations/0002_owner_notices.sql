-- Owner notices: an app may send the operator a short note on the notification channel.
-- Off for every app until the operator switches it on.
ALTER TABLE apps ADD COLUMN notify_enabled INTEGER NOT NULL DEFAULT 0;

-- One row per notice sent, kept only to count the daily ceiling; the text is never stored.
CREATE TABLE notices (
  id TEXT PRIMARY KEY,
  app TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);
CREATE INDEX notices_app_created ON notices(app, created_at);
