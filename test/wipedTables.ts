// Every table test/setup.ts empties before each test, children before parents. test/leakDetector.test.ts fails
// when a migration adds a table this list misses, since that table's rows would reach the next test.
export const WIPED_TABLES = ["legal_alerts", "legal_documents", "mail_attempts", "service_state", "mails", "admin_tokens", "admins", "notices", "images", "replies", "messages", "apps"];
