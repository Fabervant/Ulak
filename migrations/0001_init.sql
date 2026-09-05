CREATE TABLE apps (
  id TEXT PRIMARY KEY,
  key_hash TEXT NOT NULL UNIQUE,
  retention_days INTEGER NOT NULL DEFAULT 90,
  images_enabled INTEGER NOT NULL DEFAULT 0,
  allowed_origins TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  app TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  app_version TEXT NOT NULL,
  app_build TEXT,
  platform TEXT NOT NULL,
  user_ref TEXT,
  message TEXT NOT NULL,
  client_ts TEXT,
  client_msg_id TEXT NOT NULL,
  locale TEXT,
  last_error TEXT,
  contact_email TEXT,
  context TEXT,
  body_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  received_at TEXT NOT NULL,
  last_activity_at TEXT NOT NULL,
  notified_at TEXT,
  notify_error TEXT,
  notify_attempts INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX messages_idem ON messages(app, COALESCE(user_ref, ''), client_msg_id);
CREATE INDEX messages_user ON messages(app, user_ref, last_activity_at);
CREATE INDEX messages_admin ON messages(app, status, received_at);
CREATE INDEX messages_activity ON messages(last_activity_at);
CREATE INDEX messages_unnotified ON messages(notified_at, received_at);

CREATE TABLE replies (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  sender_role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX replies_message ON replies(message_id, created_at);

CREATE TABLE images (
  id TEXT PRIMARY KEY,
  app TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
  user_ref TEXT,
  r2_key TEXT NOT NULL,
  content_type TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX images_message ON images(message_id);
CREATE INDEX images_unclaimed ON images(message_id, created_at);

CREATE TABLE admins (
  sub TEXT PRIMARY KEY,
  email_at_pin TEXT NOT NULL,
  pinned_at TEXT NOT NULL
);

CREATE TABLE admin_tokens (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);
