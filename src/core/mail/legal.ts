import type { Env } from "../env";
import { ApiError, invalid } from "../errors";
import { newId, sha256Hex } from "../ids";
import { addMinutes, isIso, nowIso, storedIso } from "../time";
import { D1_MAX_PARAMS, placeholders } from "../sql";
import { channelFromEnv } from "../notify/notifier";
import type { MailRequest } from "./validate";

// ---------------------------------------------------------------------------------------------
// Settings. The legal reads change these numbers, never the code.

export interface LegalConfig {
  /** The copy's keeping period in days, counted from its `keep_from`. */
  keepDays: number;
  /** How long Ulak keeps trying to send a legal document. */
  expiryHours: number;
}

export const DEFAULT_LEGAL_EXPIRY_HOURS = 24;
export const MAX_LEGAL_EXPIRY_HOURS = 72;

export class LegalConfigError extends Error {}

const wholeNumber = (v: string): number | null => (/^\d{1,6}$/.test(v.trim()) ? Number(v.trim()) : null);

/** The legal settings; null while `LEGAL_KEEP_DAYS` is unset, so no copy is ever kept under a
 *  guessed period. Any value outside its range throws: a bad setting never looks like a good one. */
export function legalConfig(env: Env): LegalConfig | null {
  const keepRaw = env.LEGAL_KEEP_DAYS?.trim() ?? "";
  const expRaw = env.LEGAL_EXPIRY_HOURS?.trim() ?? "";
  let expiryHours = DEFAULT_LEGAL_EXPIRY_HOURS;
  if (expRaw) {
    const n = wholeNumber(expRaw);
    if (n === null || n < 1 || n > MAX_LEGAL_EXPIRY_HOURS) throw new LegalConfigError(`LEGAL_EXPIRY_HOURS must be a whole number from 1 to ${MAX_LEGAL_EXPIRY_HOURS}`);
    expiryHours = n;
  }
  if (!keepRaw) return null;
  const keepDays = wholeNumber(keepRaw);
  if (keepDays === null || keepDays < 1) throw new LegalConfigError("LEGAL_KEEP_DAYS must be a whole number of at least 1");
  return { keepDays, expiryHours };
}

export type LegalConfigState = { state: "set"; cfg: LegalConfig } | { state: "unset" } | { state: "bad"; message: string };

export function legalConfigState(env: Env): LegalConfigState {
  try {
    const cfg = legalConfig(env);
    return cfg ? { state: "set", cfg } : { state: "unset" };
  } catch (e) {
    if (e instanceof LegalConfigError) return { state: "bad", message: e.message };
    throw e;
  }
}

/** The legal settings for a request that carries a legal document: 422 while unset, 500 when bad. */
export function requireLegalConfig(s: LegalConfigState): LegalConfig {
  if (s.state === "set") return s.cfg;
  if (s.state === "bad") {
    console.error("legal config", s.message);
    throw new ApiError(500, "legal_config_bad", "this instance's legal-document settings are invalid", false);
  }
  throw new ApiError(422, "kind_not_allowed", "this instance does not send legal_document mail", false);
}

/** What the timer found of the legal settings, for the health check the admin Worker serves. */
export async function recordLegalConfigState(db: D1Database, s: LegalConfigState, now: string): Promise<void> {
  await db
    .prepare("INSERT INTO service_state (key,value,at) VALUES ('legal_config',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, at=excluded.at")
    .bind(s.state, now)
    .run();
}

/** The last recorded state of the legal settings, or null before the timer first ran. */
export async function recordedLegalConfig(db: D1Database): Promise<string | null> {
  return (await db.prepare("SELECT value FROM service_state WHERE key='legal_config'").first<{ value: string }>())?.value ?? null;
}

// ---------------------------------------------------------------------------------------------
// The copy.

export interface LegalDocument {
  mail_id: string;
  app: string;
  reference: string;
  version: string;
  idempotency_key: string;
  label: string;
  locale: string;
  user_ref: string | null;
  to_addr: string;
  subject: string;
  text_body: string;
  text_sha256: string;
  addr_hash: string;
  created_at: string;
  keep_from: string | null;
  sent_at: string | null;
  vendor_request_id: string | null;
  delivered_at: string | null;
  delivered_server: string | null;
}

/** The bytes whose SHA-256 proves a copy unchanged: the subject, a blank line, the text, as sent. */
export const hashedText = (subject: string, text: string): string => `${subject}\n\n${text}`;

export async function getLegal(db: D1Database, mailId: string): Promise<LegalDocument | null> {
  return db.prepare("SELECT * FROM legal_documents WHERE mail_id=?").bind(mailId).first<LegalDocument>();
}

/** The copy an app already holds under this key, however old: a repeat answers its id. */
export async function findLegal(db: D1Database, app: string, key: string): Promise<{ mail_id: string } | null> {
  return db.prepare("SELECT mail_id FROM legal_documents WHERE app=? AND idempotency_key=?").bind(app, key).first<{ mail_id: string }>();
}

const NEW_ALERT = `INSERT INTO legal_alerts (id,mail_id,app,kind,opened_at)
  SELECT ?1, d.mail_id, d.app, ?3, ?4 FROM legal_documents d
  WHERE d.mail_id=?2 AND NOT EXISTS (SELECT 1 FROM legal_alerts x WHERE x.mail_id=?2 AND x.kind=?3)
  ON CONFLICT DO NOTHING`;

export type AlertKind = "held" | "given_up" | "failed" | "bounced" | "undelivered";

/** Opens an alert of this kind on the copy, unless the copy ever had one: each problem is raised
 *  once per copy, so a replayed event never reopens what the operator closed. Nothing happens when
 *  the mail has no copy (a transactional mail). Returns whether an alert opened. */
export async function openAlert(db: D1Database, mailId: string, kind: AlertKind, now: string): Promise<boolean> {
  return (await alertStatement(db, mailId, kind, now).run()).meta.changes === 1;
}

const alertStatement = (db: D1Database, mailId: string, kind: AlertKind, now: string) => db.prepare(NEW_ALERT).bind(newId(), mailId, kind, now);

/** Writes an accepted legal document: its transport row and its copy in one batch, so neither
 *  exists without the other. A suppressed address gets a transport row already closed (no address,
 *  no body, already told) and an open `held` alert; nothing is sent. No per-recipient ceiling: a
 *  legal document is exempt (spec 5.3). A parallel call with the same key loses on the unique
 *  index, its whole batch rolls back, and it gets the winner's id. */
export async function insertLegal(
  db: D1Database,
  app: string,
  m: MailRequest,
  addrHash: string,
  suppressed: boolean,
  now: string,
): Promise<{ id: string; created: boolean }> {
  const doc = m.document!;
  const id = newId();
  const mails = suppressed
    ? db
        .prepare(
          `INSERT INTO mails (id,app,kind,label,locale,addr_hash,user_ref,idempotency_key,status,attempts,expires_at,created_at,last_error,operator_told_at,last_activity_at)
           VALUES (?1,?2,'legal_document',?3,?4,?5,?6,?7,'refused',0,?8,?9,'suppressed address',?9,?9)`,
        )
        .bind(id, app, m.label, m.locale, addrHash, m.user_ref, m.idempotency_key, m.expires_at, now)
    : db
        .prepare(
          `INSERT INTO mails (id,app,kind,label,locale,addr_hash,user_ref,idempotency_key,to_addr,subject,text_body,html_body,status,attempts,next_attempt_at,expires_at,created_at,last_activity_at)
           VALUES (?1,?2,'legal_document',?3,?4,?5,?6,?7,?8,?9,?10,NULL,'queued',0,?11,?12,?11,?11)`,
        )
        .bind(id, app, m.label, m.locale, addrHash, m.user_ref, m.idempotency_key, m.to, m.subject, m.text, now, m.expires_at);
  const copy = db
    .prepare(
      `INSERT INTO legal_documents (mail_id,app,reference,version,idempotency_key,label,locale,user_ref,to_addr,subject,text_body,text_sha256,addr_hash,created_at,keep_from)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .bind(id, app, doc.reference, doc.version, m.idempotency_key, m.label, m.locale, m.user_ref, m.to, m.subject, m.text, await sha256Hex(hashedText(m.subject, m.text)), addrHash, now, doc.sale === "one_off" ? now : null);
  const statements = [mails, copy];
  if (suppressed) statements.push(alertStatement(db, id, "held", now));
  try {
    await db.batch(statements);
  } catch (e) {
    if (!/UNIQUE/i.test(String(e))) throw e;
    const prior = await findLegal(db, app, m.idempotency_key);
    if (!prior) throw e;
    return { id: prior.mail_id, created: false };
  }
  return { id, created: true };
}

/** The vendor accepted the mail: stamped once, so a replay or a late writer changes nothing. */
export async function stampSent(db: D1Database, mailId: string, at: string, vendorRequestId: string | null): Promise<void> {
  await db.prepare("UPDATE legal_documents SET sent_at=?, vendor_request_id=? WHERE mail_id=? AND sent_at IS NULL").bind(at, vendorRequestId, mailId).run();
}

/** The delivered event: stamped once on the copy, found by Ulak's id or the vendor's, even when the
 *  transport row is gone; the copy's open `undelivered` alert closes itself. Returns whether the copy changed. */
export async function stampDelivered(db: D1Database, ref: string | null, requestId: string | null, server: string | null, now: string): Promise<boolean> {
  const where = ref ? "mail_id=?" : "vendor_request_id=?";
  const key = ref ?? requestId;
  if (!key) return false;
  const doc = await db.prepare(`SELECT mail_id FROM legal_documents WHERE ${where}`).bind(key).first<{ mail_id: string }>();
  if (!doc) return false;
  const [stamp] = await db.batch([
    db.prepare("UPDATE legal_documents SET delivered_at=?, delivered_server=? WHERE mail_id=? AND delivered_at IS NULL").bind(now, server, doc.mail_id),
    db.prepare("UPDATE legal_alerts SET closed_at=?, close_reason='delivered' WHERE mail_id=? AND kind='undelivered' AND closed_at IS NULL").bind(now, doc.mail_id),
  ]);
  return (stamp!.meta.changes ?? 0) > 0;
}

/** The mail id of the copy the vendor knows by this id, for an event that names only the vendor's id. */
export async function legalIdForEvent(db: D1Database, ref: string | null, requestId: string | null): Promise<string | null> {
  if (ref) return (await db.prepare("SELECT mail_id FROM legal_documents WHERE mail_id=?").bind(ref).first<{ mail_id: string }>())?.mail_id ?? null;
  if (requestId) return (await db.prepare("SELECT mail_id FROM legal_documents WHERE vendor_request_id=?").bind(requestId).first<{ mail_id: string }>())?.mail_id ?? null;
  return null;
}

// ---------------------------------------------------------------------------------------------
// Alerts.

/** How long after acceptance a copy with no delivered event opens an alert. Counted from
 *  `created_at`, so a mail stuck in the outbox is caught too. */
export const UNDELIVERED_AFTER_MINUTES = 60;
export const ALERT_BATCH = 50;

/** Opens `undelivered` on every copy an hour old with no delivered event, no `undelivered` alert
 *  yet and no `held` one (a held copy was never sent and is already the operator's). Each insert is
 *  guarded by the copy's own state, so a delivery that arrives meanwhile is never raced into an alert. */
export async function openUndelivered(db: D1Database, now: string): Promise<number> {
  const due = (
    await db
      .prepare(
        `SELECT d.mail_id FROM legal_documents d WHERE d.delivered_at IS NULL AND d.created_at<?
         AND NOT EXISTS (SELECT 1 FROM legal_alerts x WHERE x.mail_id=d.mail_id AND x.kind IN ('undelivered','held')) ORDER BY d.created_at LIMIT ?`,
      )
      .bind(addMinutes(now, -UNDELIVERED_AFTER_MINUTES), ALERT_BATCH)
      .all<{ mail_id: string }>()
  ).results;
  let opened = 0;
  for (const { mail_id } of due) {
    const { meta } = await db
      .prepare(
        `INSERT INTO legal_alerts (id,mail_id,app,kind,opened_at)
         SELECT ?1, d.mail_id, d.app, 'undelivered', ?3 FROM legal_documents d
         WHERE d.mail_id=?2 AND d.delivered_at IS NULL AND NOT EXISTS (SELECT 1 FROM legal_alerts x WHERE x.mail_id=?2 AND x.kind IN ('undelivered','held'))
         ON CONFLICT DO NOTHING`,
      )
      .bind(newId(), mail_id, now)
      .run();
    opened += meta.changes;
  }
  return opened;
}

export interface AlertRow {
  id: string;
  mail_id: string;
  app: string;
  kind: AlertKind;
  opened_at: string;
  told_at: string | null;
  closed_at: string | null;
  close_reason: string | null;
  replaced_by: string | null;
}

/** The operator's line when an alert opens: the app, the kind and where to look. Never a reference,
 *  an address, a subject or a version. */
export const alertLine = (a: Pick<AlertRow, "app" | "kind">): string => `[${a.app}] legal document ${a.kind}: open in the admin panel`;

const legalLink = (env: Env) => `${env.ADMIN_URL.replace(/\/$/, "")}/legal`;

/** One line per alert, once: each is claimed through `told_at` before it is sent and given back if
 *  the send fails, so a request and the timer never both send it and a failed one is tried again. */
export async function tellAlerts(env: Env, now: string = nowIso()): Promise<number> {
  const channel = channelFromEnv(env);
  if (!channel) return 0;
  const rows = (await env.DB.prepare("SELECT * FROM legal_alerts WHERE told_at IS NULL AND closed_at IS NULL ORDER BY opened_at LIMIT ?").bind(ALERT_BATCH).all<AlertRow>()).results;
  let told = 0;
  for (const a of rows) {
    const claimed = (await env.DB.prepare("UPDATE legal_alerts SET told_at=? WHERE id=? AND told_at IS NULL").bind(now, a.id).run()).meta.changes === 1;
    if (!claimed) continue;
    try {
      await channel.send({ text: alertLine(a), adminLink: legalLink(env) });
      told += 1;
    } catch (e) {
      console.error("legal alert line", a.kind, e instanceof Error ? e.message : String(e));
      await env.DB.prepare("UPDATE legal_alerts SET told_at=NULL WHERE id=?").bind(a.id).run();
      return told;
    }
  }
  return told;
}

/** Open alerts per app, for the daily reminder and the health check. */
export async function openAlertCounts(db: D1Database): Promise<Array<{ app: string; n: number }>> {
  return (await db.prepare("SELECT app, COUNT(*) n FROM legal_alerts WHERE closed_at IS NULL GROUP BY app ORDER BY app").all<{ app: string; n: number }>()).results;
}

/** The reminder's line: the number of open alerts per app, nothing else. */
export const reminderLine = (counts: Array<{ app: string; n: number }>): string => `[legal] open alerts: ${counts.map((c) => `${c.app} ${c.n}`).join(", ")}`;

/** While any alert is open, one line a day (owner, Session 15). The day is claimed in `service_state`
 *  by a conditional write before sending and given back if the send fails, so two runs on one day
 *  never both send it. Returns whether the line was sent. */
export async function remindOpenAlerts(env: Env, now: string = nowIso()): Promise<boolean> {
  const channel = channelFromEnv(env);
  if (!channel) return false;
  const counts = await openAlertCounts(env.DB);
  if (!counts.length) return false;
  const day = now.slice(0, 10);
  const prior = (await env.DB.prepare("SELECT value FROM service_state WHERE key='legal_reminder_day'").first<{ value: string }>())?.value ?? null;
  const { meta } = await env.DB.prepare(
    "INSERT INTO service_state (key,value,at) VALUES ('legal_reminder_day',?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value, at=excluded.at WHERE service_state.value<>excluded.value",
  )
    .bind(day, now)
    .run();
  if (meta.changes !== 1) return false;
  try {
    await channel.send({ text: reminderLine(counts), adminLink: legalLink(env) });
    return true;
  } catch (e) {
    console.error("legal reminder line", e instanceof Error ? e.message : String(e));
    if (prior === null) await env.DB.prepare("DELETE FROM service_state WHERE key='legal_reminder_day' AND value=?").bind(day).run();
    else await env.DB.prepare("UPDATE service_state SET value=? WHERE key='legal_reminder_day' AND value=?").bind(prior, day).run();
    return false;
  }
}

export const CLOSE_REASON_MAX = 500;

/** Closes an open alert by hand with the operator's reason. `replacedBy`, when given, must be a
 *  delivered copy of the same app and reference: the app's corrected call is the remedy the spec
 *  names. A closed alert stays closed. */
export async function closeAlert(db: D1Database, id: string, reason: string, replacedBy: string | null, now: string): Promise<void> {
  const why = reason.trim();
  if (!why || [...why].length > CLOSE_REASON_MAX) throw invalid("reason", `reason must be 1 to ${CLOSE_REASON_MAX} characters`);
  const alert = await db
    .prepare("SELECT a.id, d.app, d.reference FROM legal_alerts a JOIN legal_documents d ON d.mail_id=a.mail_id WHERE a.id=? AND a.closed_at IS NULL")
    .bind(id)
    .first<{ id: string; app: string; reference: string }>();
  if (!alert) throw new ApiError(404, "not_found", "no such open alert", false);
  const by = replacedBy?.trim() || null;
  if (by) {
    const ok = await db
      .prepare("SELECT 1 x FROM legal_documents WHERE mail_id=? AND app=? AND reference=? AND delivered_at IS NOT NULL")
      .bind(by, alert.app, alert.reference)
      .first();
    if (!ok) throw invalid("replaced_by", "replaced_by must be the mail id of a delivered copy of the same app and reference");
  }
  const { meta } = await db.prepare("UPDATE legal_alerts SET closed_at=?, close_reason=?, replaced_by=? WHERE id=? AND closed_at IS NULL").bind(now, why, by, id).run();
  if (!meta.changes) throw new ApiError(404, "not_found", "no such open alert", false);
}

// ---------------------------------------------------------------------------------------------
// The admin panel's reads. Never a body or an address.

export interface OpenAlertView {
  id: string;
  mail_id: string;
  app: string;
  kind: AlertKind;
  opened_at: string;
  label: string;
  reference: string;
  version: string;
}

export async function listOpenAlerts(db: D1Database): Promise<OpenAlertView[]> {
  return (
    await db
      .prepare(
        "SELECT a.id, a.mail_id, a.app, a.kind, a.opened_at, d.label, d.reference, d.version FROM legal_alerts a JOIN legal_documents d ON d.mail_id=a.mail_id WHERE a.closed_at IS NULL ORDER BY a.opened_at LIMIT 200",
      )
      .all<OpenAlertView>()
  ).results;
}

export interface CopyView {
  mail_id: string;
  app: string;
  reference: string;
  version: string;
  created_at: string;
  sent_at: string | null;
  delivered_at: string | null;
  open_alerts: number;
}

export const SEARCH_LIMIT = 50;

/** Copies with exactly this reference, newest first, at most SEARCH_LIMIT. */
export async function searchCopies(db: D1Database, reference: string, app?: string): Promise<CopyView[]> {
  const sql = `SELECT d.mail_id, d.app, d.reference, d.version, d.created_at, d.sent_at, d.delivered_at,
      (SELECT COUNT(*) FROM legal_alerts a WHERE a.mail_id=d.mail_id AND a.closed_at IS NULL) open_alerts
    FROM legal_documents d WHERE d.reference=? ${app ? "AND d.app=?" : ""} ORDER BY d.created_at DESC LIMIT ${SEARCH_LIMIT}`;
  const binds: unknown[] = [reference];
  if (app) binds.push(app);
  return (await db.prepare(sql).bind(...binds).all<CopyView>()).results;
}

/** How long a copy may wait for its subscription's end before the operator is shown it to ask the app. */
export const NO_END_DAYS = 400;

export async function countCopiesWithoutEnd(db: D1Database, now: string): Promise<number> {
  return (await db.prepare("SELECT COUNT(*) n FROM legal_documents WHERE keep_from IS NULL AND created_at<?").bind(addMinutes(now, -NO_END_DAYS * 24 * 60)).first<{ n: number }>())?.n ?? 0;
}

/** The download: the copy's evidence, then the text exactly as sent. */
export function copyText(d: LegalDocument): string {
  return [
    `Recipient: ${d.to_addr}`,
    `Subject: ${d.subject}`,
    `Version: ${d.version}`,
    `Reference: ${d.reference}`,
    `Accepted by Ulak: ${d.created_at}`,
    `Accepted by the mail service: ${d.sent_at ?? "not yet"}${d.vendor_request_id ? ` (request ${d.vendor_request_id})` : ""}`,
    `Delivered: ${d.delivered_at ?? "no delivered event yet"}${d.delivered_server ? ` (receiving server ${d.delivered_server})` : ""}`,
    `SHA-256 of the subject, a blank line and the text: ${d.text_sha256}`,
    "",
    d.text_body,
  ].join("\n");
}

// ---------------------------------------------------------------------------------------------
// Keeping and deletion.

const REF = /^[A-Za-z0-9._:/-]{1,64}$/;

/** The subscription ended: its copies' keeping period starts at `ended_at`. Only copies with no
 *  start yet are touched, so a renewal's documents share the end and a repeat changes nothing. */
export async function reportEnd(db: D1Database, app: string, raw: unknown, now: string): Promise<number> {
  const b = (typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  if (typeof b.reference !== "string" || !REF.test(b.reference)) throw invalid("reference", "reference must match [A-Za-z0-9._:/-]{1,64}");
  if (typeof b.ended_at !== "string" || !isIso(b.ended_at)) throw invalid("ended_at", "ended_at must be ISO 8601");
  const ended = storedIso(b.ended_at);
  if (ended > now) throw invalid("ended_at", "ended_at may not be in the future");
  return (await db.prepare("UPDATE legal_documents SET keep_from=? WHERE app=? AND reference=? AND keep_from IS NULL").bind(ended, app, b.reference).run()).meta.changes;
}

/** Deletes the copies whose keeping period, as set at this run, has passed, a slice at a time; their
 *  alerts go with them, open or not. A copy with no `keep_from` is never deleted. */
export async function purgeLegal(db: D1Database, keepDays: number, now: string): Promise<number> {
  const due = db.prepare(`SELECT mail_id FROM legal_documents WHERE keep_from IS NOT NULL AND keep_from<? LIMIT ${D1_MAX_PARAMS}`).bind(addMinutes(now, -keepDays * 24 * 60));
  let purged = 0;
  for (;;) {
    const ids = (await due.all<{ mail_id: string }>()).results.map((r) => r.mail_id);
    if (!ids.length) return purged;
    await db.prepare(`DELETE FROM legal_documents WHERE mail_id IN (${placeholders(ids.length)})`).bind(...ids).run();
    purged += ids.length;
    if (ids.length < D1_MAX_PARAMS) return purged;
  }
}
