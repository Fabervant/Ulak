-- Owner notices take their own key, kept on the app's server: the app key ships in web pages.
-- Null until the operator issues one; only its SHA-256 is stored.
ALTER TABLE apps ADD COLUMN notice_key_hash TEXT;
CREATE UNIQUE INDEX apps_notice_key_hash ON apps(notice_key_hash);
