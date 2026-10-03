import type { Env } from "./env";
import { ApiError } from "./errors";
import { newId, sha256Hex } from "./ids";
import { allClaimable, claimStatement, deleteImagesWhere } from "./images";
import { D1_MAX_PARAMS, placeholders } from "./sql";
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

/** The per-user submit ceilings, counted over the two windows that end now. */
export interface SubmitWindows {
  sinceBurstIso: string;
  burstLimit: number;
  sinceHourIso: string;
  hourLimit: number;
}

const COLUMNS = "id,app,app_version,app_build,platform,user_ref,message,client_ts,client_msg_id,locale,last_error,contact_email,context,body_hash,status,received_at,last_activity_at";

/** Inserts the message with its attachments, or returns the row an identical earlier submit created.
 *
 *  The checks are part of the insert, so nothing can change between a check and the write: with
 *  `windows`, the insert refuses when the user has reached a ceiling, and with attachments it
 *  refuses unless every one is still claimable. The claim runs in the same batch, which D1 runs
 *  as one transaction, so a message is saved with all its images or not at all. A separate
 *  read-then-write let parallel submits pass one ceiling, and let the loser of a race for one
 *  image keep a message without it. */
export async function insertMessage(db: D1Database, p: SubmitPayload, statusOnReceipt: string, windows?: SubmitWindows): Promise<{ row: MessageRow; created: boolean }> {
  const hash = await bodyHash(p);
  const existing = await findByIdempotency(db, p.app, p.user_ref, p.client_msg_id);
  if (existing) {
    if (existing.body_hash !== hash) throw CONFLICT();
    return { row: existing, created: false };
  }
  const id = newId();
  const now = nowIso();
  const values = [id, p.app, p.app_version, p.app_build, p.platform, p.user_ref, p.message, p.client_ts, p.client_msg_id, p.locale, p.last_error, p.contact_email, p.context, hash, statusOnReceipt, now, now];
  const conds: string[] = [];
  const condBinds: unknown[] = [];
  if (windows && p.user_ref) {
    const below = "(SELECT COUNT(*) FROM messages WHERE app=? AND user_ref=? AND received_at>=?) < ?";
    conds.push(below, below);
    condBinds.push(p.app, p.user_ref, windows.sinceBurstIso, windows.burstLimit, p.app, p.user_ref, windows.sinceHourIso, windows.hourLimit);
  }
  if (p.attachments.length) {
    const claimable = allClaimable(p.app, p.user_ref, p.attachments);
    conds.push(claimable.sql);
    condBinds.push(...claimable.binds);
  }
  const insert = db
    .prepare(`INSERT INTO messages (${COLUMNS}) SELECT ${placeholders(values.length)}${conds.length ? ` WHERE ${conds.join(" AND ")}` : ""}`)
    .bind(...values, ...condBinds);
  const statements = p.attachments.length ? [insert, claimStatement(db, p.app, p.user_ref, id, p.attachments)] : [insert];
  try {
    const [inserted] = await db.batch(statements);
    if (inserted!.meta.changes === 0) throw await refusal(db, p, windows!);
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

/** Why the insert refused, read after the fact: an attachment no longer claimable comes first,
 *  as the client must change the request, then the ceiling, so the client gets the right wait. */
async function refusal(db: D1Database, p: SubmitPayload, w: SubmitWindows): Promise<ApiError> {
  if (p.attachments.length) {
    const c = allClaimable(p.app, p.user_ref, p.attachments);
    if (!(await db.prepare(`SELECT ${c.sql} ok`).bind(...c.binds).first<{ ok: number }>())?.ok) {
      return new ApiError(400, "invalid_request", "an attachment id is unknown, already used, or not yours", false, { field: "attachments" });
    }
  }
  return rateLimited(db, p.app, p.user_ref!, w);
}

/** Which ceiling refused the insert, read after the fact so the client gets the right wait. */
async function rateLimited(db: D1Database, app: string, user_ref: string, w: SubmitWindows): Promise<ApiError> {
  const { burst } = await countUserSubmitWindows(db, app, user_ref, w.sinceBurstIso, w.sinceHourIso);
  return burst >= w.burstLimit
    ? new ApiError(429, "rate_limited", "too many requests; retry after the indicated seconds", true, {}, { "Retry-After": "60" })
    : new ApiError(429, "rate_limited", "hourly limit reached", true, {}, { "Retry-After": "3600" });
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

/** Hard deletion of everything a user_ref owns in one app: images first, objects before rows,
 *  then the messages, whose cascade takes the replies. */
export async function deleteUser(env: Env, app: string, user_ref: string): Promise<{ deleted_messages: number }> {
  await deleteImagesWhere(env, "app=? AND user_ref=?", [app, user_ref]);
  // meta.changes would include cascaded reply rows, so count first.
  const n = (await env.DB.prepare("SELECT COUNT(*) n FROM messages WHERE app=? AND user_ref=?").bind(app, user_ref).first<{ n: number }>())?.n ?? 0;
  await env.DB.prepare("DELETE FROM messages WHERE app=? AND user_ref=?").bind(app, user_ref).run();
  return { deleted_messages: n };
}

/** Deletes the messages past their app's retention, measured from last activity, with their
 *  images, a slice at a time so no statement binds more ids than D1 accepts. */
export async function expireMessages(env: Env, nowIso_: string): Promise<number> {
  const due = env.DB.prepare(
    `SELECT m.id FROM messages m JOIN apps a ON a.id=m.app WHERE m.last_activity_at < strftime('%Y-%m-%dT%H:%M:%fZ', ?, '-' || a.retention_days || ' days') LIMIT ${D1_MAX_PARAMS}`,
  ).bind(nowIso_);
  let expired = 0;
  for (;;) {
    const ids = (await due.all<{ id: string }>()).results.map((r) => r.id);
    if (!ids.length) return expired;
    const ph = placeholders(ids.length);
    await deleteImagesWhere(env, `message_id IN (${ph})`, ids);
    await env.DB.prepare(`DELETE FROM messages WHERE id IN (${ph})`).bind(...ids).run();
    expired += ids.length;
    if (ids.length < D1_MAX_PARAMS) return expired;
  }
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
