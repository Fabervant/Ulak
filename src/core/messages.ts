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
