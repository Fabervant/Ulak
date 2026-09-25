-- Unix seconds: an admin session issued at or before this is refused. Set by "Sign out everywhere".
ALTER TABLE admins ADD COLUMN sessions_invalid_before INTEGER;
