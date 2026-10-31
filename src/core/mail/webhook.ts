import { timingSafeEqual } from "../ids";
import { hmacBase64, scrubAddresses } from "./hash";
import { legalIdForEvent, openAlert, stampDelivered } from "./legal";

export const WEBHOOK_TOLERANCE_MS = 5 * 60_000;

/** Decodes form-encoding the way the vendor's own sample does (Java's URLDecoder): `+` is a space. */
const formDecode = (s: string): string => decodeURIComponent(s.replace(/\+/g, " "));

/** The bytes the vendor signs: a form body is one parameter, whose decoded value is signed; a JSON
 *  body is signed as it stands. Null when the body has neither shape. */
export function signedPayload(body: string, contentType: string): string | null {
  if (/^application\/json\b/i.test(contentType)) return body;
  const eq = body.indexOf("=");
  if (eq < 0) return null;
  try {
    return formDecode(body.slice(eq + 1));
  } catch {
    return null;
  }
}

/** Whether the request carries the vendor's valid signature: `producer-signature: ts=<ms>;s=<url-encoded
 *  base64 HMAC-SHA256>;s-algorithm=HmacSHA256`, within WEBHOOK_TOLERANCE_MS of now either way. The
 *  algorithm named in the header is only checked, never used: the header is the caller's to write. */
export async function verifySignature(header: string | null, payload: string, key: string, nowMs: number): Promise<boolean> {
  if (!header) return false;
  const parts = new Map<string, string>();
  for (const p of header.split(";")) {
    const i = p.indexOf("=");
    if (i > 0) parts.set(p.slice(0, i).trim(), p.slice(i + 1).trim());
  }
  const ts = Number(parts.get("ts"));
  const s = parts.get("s");
  if (parts.get("s-algorithm") !== "HmacSHA256" || !s || !Number.isFinite(ts)) return false;
  if (Math.abs(nowMs - ts) > WEBHOOK_TOLERANCE_MS) return false;
  let received: string;
  try {
    received = decodeURIComponent(s);
  } catch {
    return false;
  }
  return timingSafeEqual(received, await hmacBase64(key, payload));
}

export type MailEvent =
  | { type: "hardbounce" | "softbounce" | "complaint"; ref: string | null; requestId: string | null; reason: string }
  | { type: "delivered"; ref: string | null; requestId: string | null; server: string | null }
  | { type: "ignored" };

const s = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

const HOST = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z0-9-]{2,63}\.?$|^\[?\d{1,3}(?:\.\d{1,3}){3}\]?$/;

/** The receiving server a delivered event names, if it names one: the first value under a key that
 *  speaks of a server, mx or host and is shaped as a host name or an IPv4 address. The field's name
 *  is not documented by the vendor, so this reads tolerantly and gives null rather than guess. */
function receivingServer(details: Record<string, any>): string | null {
  for (const [k, v] of Object.entries(details)) {
    if (!/server|mx|host/i.test(k) || typeof v !== "string") continue;
    const t = v.trim();
    if (t.length <= 253 && HOST.test(t)) return t.toLowerCase();
  }
  return null;
}

/** The events of one webhook payload: one object or an array of them. Nothing of the recipient is kept;
 *  a bounce reason is scrubbed of addresses before it leaves this function. */
export function parseEvents(payload: string): MailEvent[] {
  let data: unknown;
  try {
    data = JSON.parse(payload);
  } catch {
    return [];
  }
  return (Array.isArray(data) ? data : [data]).map(parseOne);
}

function parseOne(raw: unknown): MailEvent {
  const e = (raw ?? {}) as Record<string, any>;
  const msg = (e.event_message ?? {}) as Record<string, any>;
  // Some payloads carry event_message as an array of one.
  const m = (Array.isArray(msg) ? msg[0] ?? {} : msg) as Record<string, any>;
  const info = (m.email_info ?? {}) as Record<string, any>;
  const data = (m.event_data ?? {}) as Record<string, any>;
  const d = (Array.isArray(data) ? data[0] ?? {} : data) as Record<string, any>;
  const details = (Array.isArray(d.details) ? d.details[0] ?? {} : d.details ?? {}) as Record<string, any>;
  const object = `${s(d.object) ?? ""} ${s(e.event_name) ?? ""}`.toLowerCase().replace(/[\s_-]+/g, " ");
  const ref = s(info.client_reference);
  const requestId = s(m.request_id) ?? s(e.request_id);
  // Kept: the vendor's reason category and the server's status code (such as 5.1.1). Never the remote
  // server's own text, which often names the mailbox even without an @.
  const code = (s(details.diagnostic_message) ?? "").match(/\b[245]\.\d{1,3}\.\d{1,3}\b/)?.[0];
  const reason = [scrubAddresses(s(details.reason) ?? "unknown").slice(0, 80), code].filter(Boolean).join(" ");
  if (/hard ?bounce/.test(object)) return { type: "hardbounce", ref, requestId, reason };
  if (/soft ?bounce/.test(object)) return { type: "softbounce", ref, requestId, reason };
  if (/fbl|complaint|feedback/.test(object)) return { type: "complaint", ref, requestId, reason };
  if (/deliver/.test(object) && !/undeliver/.test(object)) return { type: "delivered", ref, requestId, server: receivingServer(details) };
  return { type: "ignored" };
}

/** Applies one event to its mail, found by Ulak's own id (the vendor's client reference), else by the
 *  vendor's request id, and to a legal document's copy: a delivery is stamped on the copy even when
 *  the transport row is gone, a hard bounce opens the copy's `bounced` alert. A mail already deleted
 *  is no error. Returns whether a row changed. */
export async function applyEvent(db: D1Database, ev: MailEvent, now: string): Promise<boolean> {
  const changed = await applyToMail(db, ev, now);
  if (ev.type === "delivered") return (await stampDelivered(db, ev.ref, ev.requestId, ev.server, now)) || changed;
  if (ev.type === "hardbounce") {
    const legal = await legalIdForEvent(db, ev.ref, ev.requestId);
    if (legal && (await openAlert(db, legal, "bounced", now))) return true;
  }
  return changed;
}

async function applyToMail(db: D1Database, ev: MailEvent, now: string): Promise<boolean> {
  if (ev.type === "ignored" || (!ev.ref && !ev.requestId)) return false;
  const where = ev.ref ? "id=?" : "vendor_request_id=?";
  const key = ev.ref ?? ev.requestId;
  // Any event proves the vendor has the mail, even one Ulak still holds as queued after a lost answer:
  // its content goes, and it is never sent again.
  const gone = "to_addr=NULL, subject=NULL, text_body=NULL, html_body=NULL, lease_until=NULL, next_attempt_at=NULL";
  let stmt: D1PreparedStatement;
  switch (ev.type) {
    case "hardbounce":
      stmt = db.prepare(`UPDATE mails SET status='bounced', ${gone}, last_error=?, last_activity_at=? WHERE ${where}`).bind(`hard bounce: ${ev.reason}`, now, key);
      break;
    case "complaint":
      stmt = db.prepare(`UPDATE mails SET status='complained', ${gone}, last_error=?, last_activity_at=? WHERE ${where}`).bind("spam complaint", now, key);
      break;
    case "softbounce":
      stmt = db
        .prepare(`UPDATE mails SET status=CASE status WHEN 'queued' THEN 'sent' ELSE status END, ${gone}, last_error=?, last_activity_at=? WHERE ${where}`)
        .bind(`soft bounce: ${ev.reason}`, now, key);
      break;
    case "delivered":
      // A bounce or complaint that arrived first is not overwritten by a late delivery event.
      stmt = db.prepare(`UPDATE mails SET status='delivered', ${gone}, delivered_at=?, last_activity_at=? WHERE ${where} AND status IN ('sent','queued','delivered')`).bind(now, now, key);
      break;
  }
  return (await stmt.run()).meta.changes > 0;
}
