import { ApiError } from "./errors";
import { newId, sha256Hex } from "./ids";
import { nowIso } from "./time";
import type { SubmitPayload } from "./validate";

export interface MessageRow {
  id: string;
  app: string;
  app_version: string;
  app_build: string | null;
  platform: string;
  user_ref: string | null;
  message: string;
  client_ts: string | null;
  client_msg_id: string;
  locale: string | null;
  last_error: string | null;
  contact_email: string | null;
  context: string | null;
  body_hash: string;
  status: string;
  received_at: string;
  last_activity_at: string;
  notified_at: string | null;
  notify_error: string | null;
  notify_attempts: number;
}

const CONFLICT = () => new ApiError(409, "idempotency_conflict", "client_msg_id was already used with a different body", false);

export function bodyHash(p: SubmitPayload): Promise<string> {
  return sha256Hex(JSON.stringify([p.app_version, p.app_build, p.platform, p.message, p.client_ts, p.locale, p.last_error, p.contact_email, p.context, p.attachments]));
}

export async function getMessage(db: D1Database, id: string): Promise<MessageRow | null> {
  return db.prepare("SELECT * FROM messages WHERE id=?").bind(id).first<MessageRow>();
}

export async function findByIdempotency(db: D1Database, app: string, user_ref: string | null, client_msg_id: string): Promise<MessageRow | null> {
  return db.prepare("SELECT * FROM messages WHERE app=? AND COALESCE(user_ref,'')=? AND client_msg_id=?").bind(app, user_ref ?? "", client_msg_id).first<MessageRow>();
}

export async function insertMessage(db: D1Database, p: SubmitPayload, statusOnReceipt: string): Promise<{ row: MessageRow; created: boolean }> {
  const hash = await bodyHash(p);
  const existing = await findByIdempotency(db, p.app, p.user_ref, p.client_msg_id);
  if (existing) {
    if (existing.body_hash !== hash) throw CONFLICT();
    return { row: existing, created: false };
  }
  const id = newId();
  const now = nowIso();
  try {
    await db
      .prepare(
        `INSERT INTO messages (id,app,app_version,app_build,platform,user_ref,message,client_ts,client_msg_id,locale,last_error,contact_email,context,body_hash,status,received_at,last_activity_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .bind(id, p.app, p.app_version, p.app_build, p.platform, p.user_ref, p.message, p.client_ts, p.client_msg_id, p.locale, p.last_error, p.contact_email, p.context, hash, statusOnReceipt, now, now)
      .run();
  } catch (e) {
    // Lost a race with an identical concurrent submit: re-read and apply the same rule.
    if (String(e).includes("UNIQUE")) {
      const raced = await findByIdempotency(db, p.app, p.user_ref, p.client_msg_id);
      if (raced && raced.body_hash === hash) return { row: raced, created: false };
      throw CONFLICT();
    }
    throw e;
  }
  return { row: (await getMessage(db, id))!, created: true };
}

export async function countUserMessagesSince(db: D1Database, app: string, user_ref: string, sinceIso: string): Promise<number> {
  const r = await db.prepare("SELECT COUNT(*) n FROM messages WHERE app=? AND user_ref=? AND received_at>=?").bind(app, user_ref, sinceIso).first<{ n: number }>();
  return r?.n ?? 0;
}

/** Per-user submit counts for the burst and hourly windows, in one round trip.
 *  The Cloudflare rate-limit binding is approximate and cannot hold a limit this small,
 *  so the guarantee lives here where it is exact and testable. */
export async function countUserSubmitWindows(
  db: D1Database,
  app: string,
  user_ref: string,
  sinceBurstIso: string,
  sinceHourIso: string,
): Promise<{ burst: number; hour: number }> {
  const r = await db
    .prepare(
      "SELECT SUM(CASE WHEN received_at>=?3 THEN 1 ELSE 0 END) burst, COUNT(*) hour FROM messages WHERE app=?1 AND user_ref=?2 AND received_at>=?4",
    )
    .bind(app, user_ref, sinceBurstIso, sinceHourIso)
    .first<{ burst: number | null; hour: number | null }>();
  return { burst: r?.burst ?? 0, hour: r?.hour ?? 0 };
}

export async function touchActivity(db: D1Database, id: string, iso: string): Promise<void> {
  await db.prepare("UPDATE messages SET last_activity_at=? WHERE id=?").bind(iso, id).run();
}

export async function listForUser(db: D1Database, app: string, user_ref: string, sinceIso: string | null): Promise<MessageRow[]> {
  const q = sinceIso
    ? db.prepare("SELECT * FROM messages WHERE app=? AND user_ref=? AND last_activity_at>? ORDER BY last_activity_at, received_at LIMIT 200").bind(app, user_ref, sinceIso)
    : db.prepare("SELECT * FROM messages WHERE app=? AND user_ref=? ORDER BY last_activity_at, received_at LIMIT 200").bind(app, user_ref);
  return (await q.all<MessageRow>()).results;
}

export async function setStatus(db: D1Database, id: string, status: string): Promise<void> {
  const r = await db.prepare("UPDATE messages SET status=?, last_activity_at=? WHERE id=?").bind(status, nowIso(), id).run();
  if (!r.meta.changes) throw new Error("message not found");
}

/** Hard deletion of everything a user_ref owns in one app. Cascades take the replies; image rows go here, objects by the caller. */
export async function deleteUser(db: D1Database, app: string, user_ref: string): Promise<{ deleted_messages: number; image_keys: string[] }> {
  const keys = (await db.prepare("SELECT r2_key FROM images WHERE app=? AND user_ref=?").bind(app, user_ref).all<{ r2_key: string }>()).results.map((r) => r.r2_key);
  // meta.changes would include cascaded reply rows, so count first.
  const n = (await db.prepare("SELECT COUNT(*) n FROM messages WHERE app=? AND user_ref=?").bind(app, user_ref).first<{ n: number }>())?.n ?? 0;
  await db.batch([
    db.prepare("DELETE FROM messages WHERE app=? AND user_ref=?").bind(app, user_ref),
    db.prepare("DELETE FROM images WHERE app=? AND user_ref=?").bind(app, user_ref),
  ]);
  return { deleted_messages: n, image_keys: keys };
}

/** Rows past their app's retention, measured from last activity. Deletes them and returns their image keys. */
export async function expireMessages(db: D1Database, nowIso_: string): Promise<{ expired: number; image_keys: string[] }> {
  const due = await db
    .prepare(`SELECT m.id FROM messages m JOIN apps a ON a.id=m.app WHERE m.last_activity_at < strftime('%Y-%m-%dT%H:%M:%fZ', ?, '-' || a.retention_days || ' days')`)
    .bind(nowIso_)
    .all<{ id: string }>();
  const ids = due.results.map((r) => r.id);
  if (!ids.length) return { expired: 0, image_keys: [] };
  const ph = ids.map(() => "?").join(",");
  const keys = (await db.prepare(`SELECT r2_key FROM images WHERE message_id IN (${ph})`).bind(...ids).all<{ r2_key: string }>()).results.map((r) => r.r2_key);
  await db.prepare(`DELETE FROM messages WHERE id IN (${ph})`).bind(...ids).run();
  return { expired: ids.length, image_keys: keys };
}

export async function unnotified(db: D1Database, maxAttempts: number, limit = 50): Promise<MessageRow[]> {
  return (await db.prepare("SELECT * FROM messages WHERE notified_at IS NULL AND notify_attempts < ? ORDER BY received_at LIMIT ?").bind(maxAttempts, limit).all<MessageRow>()).results;
}

export async function listAdmin(db: D1Database, f: { app?: string; status?: string; sinceIso?: string; limit?: number } = {}): Promise<MessageRow[]> {
  const where: string[] = [];
  const binds: unknown[] = [];
  if (f.app) {
    where.push("app=?");
    binds.push(f.app);
  }
  if (f.status) {
    where.push("status=?");
    binds.push(f.status);
  }
  if (f.sinceIso) {
    where.push("last_activity_at>?");
    binds.push(f.sinceIso);
  }
  const sql = `SELECT * FROM messages ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY received_at DESC LIMIT ?`;
  const limit = Math.min(Math.max(1, f.limit || 100), 500);
  return (await db.prepare(sql).bind(...binds, limit).all<MessageRow>()).results;
}

export async function countByAppAndStatus(db: D1Database, status: string): Promise<Array<{ app: string; n: number }>> {
  return (await db.prepare("SELECT app, COUNT(*) n FROM messages WHERE status=? GROUP BY app ORDER BY app").bind(status).all<{ app: string; n: number }>()).results;
}
