import { newId } from "../ids";
import { addMinutes } from "../time";
import { D1_MAX_PARAMS, placeholders } from "../sql";
import type { AppRow } from "../apps";
import type { MailConfig } from "./config";
import type { MailRequest } from "./validate";
import { sendViaVendor, type VendorResult } from "./vendor";

/** queued -> sent -> delivered | bounced | complained; queued -> given_up | refused | failed. */
export type MailStatus = "queued" | "sent" | "delivered" | "bounced" | "complained" | "given_up" | "refused" | "failed";

export interface MailRow {
  id: string;
  app: string;
  kind: string;
  label: string;
  locale: string;
  addr_hash: string;
  user_ref: string | null;
  idempotency_key: string | null;
  to_addr: string | null;
  subject: string | null;
  text_body: string | null;
  html_body: string | null;
  status: MailStatus;
  attempts: number;
  next_attempt_at: string | null;
  lease_until: string | null;
  expires_at: string;
  created_at: string;
  sent_at: string | null;
  delivered_at: string | null;
  vendor_request_id: string | null;
  last_error: string | null;
  operator_told_at: string | null;
  last_activity_at: string;
}

export const RECIPIENT_HOURLY_LIMIT = 10;
export const IDEMPOTENCY_DAYS = 7;
export const LEASE_MINUTES = 2;
export const OUTBOX_BATCH = 50;
const HOUR = 60;

/** Minutes to wait after the n-th failed attempt: 5, 10, 20, 40, then every hour. */
export const backoffMinutes = (n: number): number => Math.min(5 * 2 ** Math.max(0, n - 1), HOUR);

/** What the app is told about a mail: the vendor has it, or Ulak is still trying. */
export const answerStatus = (s: MailStatus): "sent" | "queued" => (s === "queued" ? "queued" : "sent");

/** The first mail with this idempotency key in the last IDEMPOTENCY_DAYS. */
export async function findByIdempotencyKey(db: D1Database, app: string, key: string, now: string): Promise<MailRow | null> {
  return db
    .prepare("SELECT * FROM mails WHERE app=? AND idempotency_key=? AND created_at>?")
    .bind(app, key, addMinutes(now, -IDEMPOTENCY_DAYS * 24 * HOUR))
    .first<MailRow>();
}

/** Whether the vendor reported this address hard-bounced or complained of spam in this app (owner, S14). */
export async function isSuppressed(db: D1Database, app: string, addrHash: string): Promise<boolean> {
  const r = await db.prepare("SELECT 1 x FROM mails WHERE app=? AND addr_hash=? AND status IN ('bounced','complained') LIMIT 1").bind(app, addrHash).first();
  return r !== null;
}

/** Records an accepted mail as queued, unless the address already had RECIPIENT_HOURLY_LIMIT mails
 *  from this app in the last hour. Count and insert are one statement, so parallel calls cannot both
 *  pass the ceiling. Returns null over the ceiling; the row an equal key created if one raced in. */
export async function insertMail(db: D1Database, app: string, m: MailRequest, addrHash: string, now: string): Promise<{ row: MailRow; created: boolean } | null> {
  const id = newId();
  // A key older than the idempotency window starts a new mail; it gives up its place in the unique index.
  await db
    .prepare("UPDATE mails SET idempotency_key=NULL WHERE app=? AND idempotency_key=? AND created_at<=?")
    .bind(app, m.idempotency_key, addMinutes(now, -IDEMPOTENCY_DAYS * 24 * HOUR))
    .run();
  try {
    const { meta } = await db
      .prepare(
        `INSERT INTO mails (id,app,kind,label,locale,addr_hash,user_ref,idempotency_key,to_addr,subject,text_body,html_body,status,attempts,next_attempt_at,expires_at,created_at,last_activity_at)
         SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,'queued',0,?13,?14,?13,?13
         WHERE (SELECT COUNT(*) FROM mails WHERE app=?2 AND addr_hash=?6 AND created_at>?15) < ?16`,
      )
      .bind(id, app, m.kind, m.label, m.locale, addrHash, m.user_ref, m.idempotency_key, m.to, m.subject, m.text, m.html, now, m.expires_at, addMinutes(now, -HOUR), RECIPIENT_HOURLY_LIMIT)
      .run();
    if (!meta.changes) return null;
  } catch (e) {
    if (!/UNIQUE/i.test(String(e))) throw e;
    const prior = await findByIdempotencyKey(db, app, m.idempotency_key, now);
    if (!prior) throw e;
    return { row: prior, created: false };
  }
  return { row: (await getMail(db, id))!, created: true };
}

/** Seconds until the oldest mail in this address's hour leaves the window; at least 1. */
export async function recipientWaitSec(db: D1Database, app: string, addrHash: string, now: string): Promise<number> {
  const r = await db.prepare("SELECT MIN(created_at) oldest FROM mails WHERE app=? AND addr_hash=? AND created_at>?").bind(app, addrHash, addMinutes(now, -HOUR)).first<{ oldest: string | null }>();
  if (!r?.oldest) return 1;
  return Math.max(1, Math.ceil((Date.parse(addMinutes(r.oldest, HOUR)) - Date.parse(now)) / 1000));
}

export async function getMail(db: D1Database, id: string): Promise<MailRow | null> {
  return db.prepare("SELECT * FROM mails WHERE id=?").bind(id).first<MailRow>();
}

/** Takes the mail for one attempt. Only one caller holds it at a time, so the request's first attempt
 *  and the timer never send the same mail together. */
export async function claimMail(db: D1Database, id: string, now: string): Promise<boolean> {
  const { meta } = await db
    .prepare("UPDATE mails SET lease_until=? WHERE id=? AND status='queued' AND to_addr IS NOT NULL AND (lease_until IS NULL OR lease_until<=?)")
    .bind(addMinutes(now, LEASE_MINUTES), id, now)
    .run();
  return meta.changes === 1;
}

export type AttemptOutcome = { status: MailStatus; result: VendorResult["kind"] | "not_claimed" };

/** One attempt at a mail the caller has not claimed yet: claim, call the vendor, record the result.
 *  The body and the plain address are deleted the moment the vendor accepts the mail or Ulak stops
 *  trying it. A mail the vendor took but Ulak could not mark is retried: duplicate over loss. */
export async function attemptMail(db: D1Database, cfg: MailConfig, row: MailRow, app: AppRow, now: string, transport?: typeof fetch): Promise<AttemptOutcome> {
  if (!(await claimMail(db, row.id, now))) return { status: row.status, result: "not_claimed" };
  const result = await sendViaVendor(cfg, {
    id: row.id,
    fromAddress: `${app.id}@${cfg.fromDomain}`,
    fromName: app.mail_from_name ?? app.id,
    to: row.to_addr!,
    subject: row.subject!,
    text: row.text_body!,
    html: row.html_body,
  }, transport);
  const done = new Date().toISOString();
  const attempts = row.attempts + 1;
  const close = (status: MailStatus, error: string | null) =>
    db
      .prepare("UPDATE mails SET status=?, attempts=?, last_error=?, lease_until=NULL, next_attempt_at=NULL, to_addr=NULL, subject=NULL, text_body=NULL, html_body=NULL, last_activity_at=? WHERE id=?")
      .bind(status, attempts, error, done, row.id);
  const stmts: D1PreparedStatement[] = [];
  let status: MailStatus;
  switch (result.kind) {
    case "accepted":
      status = "sent";
      stmts.push(
        db
          .prepare("UPDATE mails SET status='sent', attempts=?, sent_at=?, vendor_request_id=?, last_error=NULL, lease_until=NULL, next_attempt_at=NULL, to_addr=NULL, subject=NULL, text_body=NULL, html_body=NULL, last_activity_at=? WHERE id=?")
          .bind(attempts, done, result.requestId || null, done, row.id),
        db.prepare("INSERT INTO mail_attempts (at,ok) VALUES (?,1)").bind(done),
      );
      break;
    case "vendor_down":
      status = "queued";
      stmts.push(
        db
          .prepare("UPDATE mails SET attempts=?, last_error=?, lease_until=NULL, next_attempt_at=?, last_activity_at=? WHERE id=?")
          .bind(attempts, result.error, addMinutes(done, backoffMinutes(attempts)), done, row.id),
        db.prepare("INSERT INTO mail_attempts (at,ok) VALUES (?,0)").bind(done),
      );
      break;
    case "address_refused":
      status = "refused";
      stmts.push(close("refused", result.error));
      break;
    case "request_bad":
      status = "failed";
      stmts.push(close("failed", result.error));
      break;
  }
  await db.batch(stmts);
  return { status, result: result.kind };
}

/** Queued mails whose `expires_at` has passed: given up, their content deleted. Returns them for the operator line. */
export async function giveUpExpired(db: D1Database, now: string): Promise<MailRow[]> {
  const rows = (await db.prepare("SELECT * FROM mails WHERE status='queued' AND expires_at<=? AND (lease_until IS NULL OR lease_until<=?) ORDER BY created_at LIMIT ?").bind(now, now, OUTBOX_BATCH).all<MailRow>()).results;
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  await db
    .prepare(`UPDATE mails SET status='given_up', lease_until=NULL, next_attempt_at=NULL, to_addr=NULL, subject=NULL, text_body=NULL, html_body=NULL, last_activity_at=? WHERE id IN (${placeholders(ids.length)}) AND status='queued'`)
    .bind(now, ...ids)
    .run();
  return rows.map((r) => ({ ...r, status: "given_up" as const }));
}

/** Queued mails due for another attempt, oldest first, at most OUTBOX_BATCH so a backlog never bursts. */
export async function dueMails(db: D1Database, now: string): Promise<MailRow[]> {
  return (
    await db
      .prepare("SELECT * FROM mails WHERE status='queued' AND next_attempt_at<=? AND expires_at>? AND (lease_until IS NULL OR lease_until<=?) ORDER BY created_at LIMIT ?")
      .bind(now, now, now, OUTBOX_BATCH)
      .all<MailRow>()
  ).results;
}

/** Closed mails the operator has not been told of yet: one line each, never repeated. */
export async function untoldFailures(db: D1Database): Promise<MailRow[]> {
  return (await db.prepare("SELECT * FROM mails WHERE status IN ('given_up','failed','refused') AND operator_told_at IS NULL ORDER BY created_at LIMIT ?").bind(OUTBOX_BATCH).all<MailRow>()).results;
}

export async function markTold(db: D1Database, id: string, now: string): Promise<void> {
  await db.prepare("UPDATE mails SET operator_told_at=? WHERE id=?").bind(now, id).run();
}

/** The operator's line for a mail Ulak stopped trying: no address, no subject, no link. */
export const failureLine = (r: MailRow): string =>
  r.status === "given_up"
    ? `[${r.app}] mail ${r.label} given up at its expiry after ${r.attempts} attempt(s)${r.last_error ? `: ${r.last_error}` : ""}`
    : `[${r.app}] mail ${r.label} ${r.status === "refused" ? "refused for its address" : "failed"}: ${r.last_error ?? "no detail"}`;

/** Spent idempotency keys and old attempt records. */
export async function purgeMailHousekeeping(db: D1Database, now: string): Promise<void> {
  await db.batch([
    db.prepare("UPDATE mails SET idempotency_key=NULL WHERE idempotency_key IS NOT NULL AND created_at<=?").bind(addMinutes(now, -IDEMPOTENCY_DAYS * 24 * HOUR)),
    db.prepare("DELETE FROM mail_attempts WHERE at<=?").bind(addMinutes(now, -HOUR)),
  ]);
}

/** Mail rows past their app's retention, measured from last activity, a slice at a time. */
export async function expireMails(db: D1Database, now: string): Promise<number> {
  const due = db
    .prepare(`SELECT m.id FROM mails m JOIN apps a ON a.id=m.app WHERE m.last_activity_at < strftime('%Y-%m-%dT%H:%M:%fZ', ?, '-' || a.retention_days || ' days') LIMIT ${D1_MAX_PARAMS}`)
    .bind(now);
  let expired = 0;
  for (;;) {
    const ids = (await due.all<{ id: string }>()).results.map((r) => r.id);
    if (!ids.length) return expired;
    await db.prepare(`DELETE FROM mails WHERE id IN (${placeholders(ids.length)})`).bind(...ids).run();
    expired += ids.length;
    if (ids.length < D1_MAX_PARAMS) return expired;
  }
}

/** `down` only when the last 3 calls to the vendor in the past 10 minutes all failed on the vendor's
 *  side. Bounces, refusals, 422 and 429 are never recorded here, so bad addresses cannot flip it. */
export async function sendingHealth(db: D1Database, now: string): Promise<"ok" | "down"> {
  const rows = (await db.prepare("SELECT ok FROM mail_attempts WHERE at>? ORDER BY at DESC LIMIT 3").bind(addMinutes(now, -10)).all<{ ok: number }>()).results;
  return rows.length === 3 && rows.every((r) => r.ok === 0) ? "down" : "ok";
}

export async function deleteMailsByAddress(db: D1Database, app: string, addrHash: string): Promise<number> {
  return (await db.prepare("DELETE FROM mails WHERE app=? AND addr_hash=?").bind(app, addrHash).run()).meta.changes;
}

export async function deleteMailsByUser(db: D1Database, app: string, user_ref: string): Promise<number> {
  return (await db.prepare("DELETE FROM mails WHERE app=? AND user_ref=?").bind(app, user_ref).run()).meta.changes;
}

export const OUTBOX_STATUSES: MailStatus[] = ["queued", "failed", "given_up", "refused", "bounced", "complained"];

/** The admin outbox: mails that are waiting or did not arrive, last 30 days, newest first. */
export async function listOutbox(db: D1Database, now: string, app?: string): Promise<MailRow[]> {
  const sql = `SELECT id,app,kind,label,locale,status,attempts,expires_at,created_at,sent_at,last_error FROM mails
    WHERE status IN (${placeholders(OUTBOX_STATUSES.length)}) AND created_at>? ${app ? "AND app=?" : ""} ORDER BY created_at DESC LIMIT 200`;
  const binds: unknown[] = [...OUTBOX_STATUSES, addMinutes(now, -30 * 24 * HOUR)];
  if (app) binds.push(app);
  return (await db.prepare(sql).bind(...binds).all<MailRow>()).results;
}
