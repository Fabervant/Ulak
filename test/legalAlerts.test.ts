import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import worker from "../src/api/index";
import { createApp, updateApp, rotateSendKey, rotateKey } from "../src/core/apps";
import { vendorTransport } from "../src/core/mail/vendor";
import { addrHash } from "../src/core/mail/hash";
import { runOutbox, tellFailures } from "../src/core/mail/job";
import { applyEvent } from "../src/core/mail/webhook";
import { findByIdempotencyKey, purgeMailHousekeeping, untoldFailures, expireMails } from "../src/core/mail/outbox";
import { validateMail } from "../src/core/mail/validate";
import {
  closeAlert,
  hashedText,
  insertLegal,
  legalConfig,
  openUndelivered,
  recordSenderInfo,
  remindOpenAlerts,
  tellAlerts,
  ALERT_BATCH,
  SEARCH_LIMIT,
  type LegalDocument,
} from "../src/core/mail/legal";
import { runScheduled } from "../src/core/retention";
import { runChecks } from "../src/core/checks";
import { deleteUser } from "../src/core/messages";
import { createSession, readSession } from "../src/core/auth/session";
import { createAdminToken } from "../src/core/auth/admintoken";
import { TelegramNotifier } from "../src/core/notify/telegram";
import { sha256Hex } from "../src/core/ids";
import type { Env } from "../src/core/env";
import { addMinutes, nowIso } from "../src/core/time";
import { adminRequest, pinAdmin, submission, vendorSigned } from "./helpers";
import { insertMessage } from "../src/core/messages";
import {
  ADDRESS,
  LEGAL,
  MAIL,
  REFERENCE,
  SUBJECT,
  TEXT,
  TG,
  VERSION,
  alerts,
  call,
  calls,
  copy,
  down,
  event,
  idOf,
  legalApp,
  legalBody,
  lenv,
  lines,
  mailRow,
  malformed,
  refusedAddress,
  replies,
  sendLegal,
  signedPayloadEvent,
  telegram,
} from "./legalHarness";

// ---------------------------------------------------------------------------------------------
describe("task 6: alerts", () => {
  it("undelivered opens after an hour, once; not on a delivered or a held copy", async () => {
    const key = await legalApp();
    const plain = await idOf(await sendLegal(key));
    const delivered = await idOf(await sendLegal(key));
    await event(delivered, "email_delivered");
    replies.push(refusedAddress);
    const held = await idOf(await sendLegal(key));
    expect(await openUndelivered(env.DB, addMinutes(nowIso(), 59))).toBe(0);
    expect(await openUndelivered(env.DB, addMinutes(nowIso(), 61))).toBe(1);
    expect(await openUndelivered(env.DB, addMinutes(nowIso(), 120))).toBe(0);
    expect((await alerts(plain)).map((a) => a.kind)).toEqual(["undelivered"]);
    expect(await alerts(delivered)).toEqual([]);
    expect((await alerts(held)).map((a) => a.kind)).toEqual(["held"]);
  });

  it("old held copies never crowd a newer undelivered copy out of its alert", async () => {
    const key = await legalApp();
    const old = "2020-01-01T00:00:00.000Z";
    await env.DB.batch(
      Array.from({ length: ALERT_BATCH + 1 }, (_, i) => [
        env.DB.prepare("INSERT INTO legal_documents (mail_id,app,reference,version,idempotency_key,label,locale,to_addr,subject,text_body,text_sha256,addr_hash,created_at) VALUES (?1,'shop','R','v',?1,'l','en','a@example.org','s','t','h','h',?2)").bind(`held-${i}`, old),
        env.DB.prepare("INSERT INTO legal_alerts (id,mail_id,app,kind,opened_at) VALUES (?1,?2,'shop','held',?3)").bind(`alert-${i}`, `held-${i}`, old),
      ]).flat(),
    );
    const undelivered = await idOf(await sendLegal(key));
    expect(await openUndelivered(env.DB, addMinutes(nowIso(), 61))).toBe(1);
    expect((await alerts(undelivered)).map((a) => a.kind)).toEqual(["undelivered"]);
  });

  it("a line that fails to send is given back and sent at the next run", async () => {
    const key = await legalApp();
    telegram.failNext = 1;
    replies.push(refusedAddress);
    const id = await idOf(await sendLegal(key));
    expect(lines).toEqual([]);
    expect((await alerts(id))[0].told_at).toBeNull();
    expect(await tellAlerts(lenv())).toBe(1);
    expect(await tellAlerts(lenv())).toBe(0);
    expect(lines).toHaveLength(1);
  });

  it("with no Telegram channel nothing is claimed, so the lines go once one is set", async () => {
    const key = await legalApp();
    replies.push(refusedAddress);
    await sendLegal(key, {}, lenv({ NOTIFIER: "none" }));
    expect(await tellAlerts(lenv({ NOTIFIER: "none" }))).toBe(0);
    expect(await remindOpenAlerts(lenv({ NOTIFIER: "none" }))).toBe(false);
    expect((await alerts())[0].told_at).toBeNull();
    expect(await tellAlerts(lenv())).toBe(1);
    expect(await remindOpenAlerts(lenv())).toBe(true);
  });

  it("parallel tellers send each line once", async () => {
    const key = await legalApp();
    replies.push(refusedAddress);
    telegram.failNext = 1;
    await sendLegal(key);
    await Promise.all([tellAlerts(lenv()), tellAlerts(lenv()), tellAlerts(lenv())]);
    expect(lines).toHaveLength(1);
  });

  it("the daily reminder: one line a day while alerts are open, given back if it fails", async () => {
    const key = await legalApp();
    replies.push(refusedAddress, malformed);
    await sendLegal(key);
    await sendLegal(key);
    lines.length = 0;
    const day1 = "2026-11-01T08:00:00.000Z";
    telegram.failNext = 1;
    expect(await remindOpenAlerts(lenv(), day1)).toBe(false);
    expect(await remindOpenAlerts(lenv(), "2026-11-01T09:00:00.000Z")).toBe(true);
    expect(await remindOpenAlerts(lenv(), "2026-11-01T10:00:00.000Z")).toBe(false);
    expect(await Promise.all([remindOpenAlerts(lenv(), "2026-11-02T08:00:00.000Z"), remindOpenAlerts(lenv(), "2026-11-02T08:00:00.000Z")])).toEqual(expect.arrayContaining([true, false]));
    expect(lines).toEqual(["[legal] open alerts: shop 2\nhttps://admin.example.invalid/legal", "[legal] open alerts: shop 2\nhttps://admin.example.invalid/legal"]);
    for (const a of await alerts()) await closeAlert(env.DB, a.id, "done", null, nowIso());
    expect(await remindOpenAlerts(lenv(), "2026-11-03T08:00:00.000Z")).toBe(false);
  });

  it("the hourly job sends the reminder", async () => {
    const key = await legalApp();
    replies.push(refusedAddress);
    await sendLegal(key);
    lines.length = 0;
    expect((await runScheduled(lenv())).legal_reminder).toBe(true);
    expect(lines[0]).toMatch(/^\[legal\] open alerts: shop 1/);
  });

  it("closing needs a reason; replaced_by must be a delivered copy of the same app and reference; closed stays closed", async () => {
    const key = await legalApp();
    replies.push(refusedAddress);
    const bad = await idOf(await sendLegal(key));
    const [alert] = await alerts(bad);
    const fixed = await idOf(await sendLegal(key, { to: "buyer2@example.org" }));
    const otherRef = await idOf(await sendLegal(key, { document: { version: VERSION, reference: "ORD-78", sale: "one_off" } }));
    await event(otherRef, "email_delivered");
    const now = nowIso();
    await expect(closeAlert(env.DB, alert.id, "   ", null, now)).rejects.toMatchObject({ status: 400 });
    await expect(closeAlert(env.DB, alert.id, "x".repeat(501), null, now)).rejects.toMatchObject({ status: 400 });
    await expect(closeAlert(env.DB, alert.id, "resent", fixed, now)).rejects.toMatchObject({ status: 400 }); // not delivered yet
    await expect(closeAlert(env.DB, alert.id, "resent", otherRef, now)).rejects.toMatchObject({ status: 400 }); // another order
    await event(fixed, "email_delivered");
    await expect(closeAlert(env.DB, alert.id, "itself", bad, now)).rejects.toMatchObject({ status: 400 });
    await closeAlert(env.DB, alert.id, "resent to the corrected address", fixed, now, "sub-op");
    expect((await alerts(bad))[0]).toMatchObject({ close_reason: "resent to the corrected address", replaced_by: fixed, closed_by: "sub-op" });
    await expect(closeAlert(env.DB, alert.id, "again", null, now)).rejects.toMatchObject({ status: 404 });
  });

  it("no line and no log holds the address, the reference, the subject or the version", async () => {
    const logs: string[] = [];
    for (const m of ["log", "error", "warn", "info"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(" ")));
    const key = await legalApp();
    replies.push(refusedAddress, malformed, down);
    await sendLegal(key);
    await sendLegal(key);
    telegram.failNext = 1;
    const id = await idOf(await sendLegal(key, { expires_at: addMinutes(nowIso(), 10) }));
    await runOutbox(lenv(), addMinutes(nowIso(), 61));
    await event(id, "hardbounce");
    await tellAlerts(lenv());
    await remindOpenAlerts(lenv(), "2026-12-01T00:00:00.000Z");
    await runOutbox(lenv({ LEGAL_KEEP_YEARS: "bad" }));
    await sendLegal(key, {}, lenv({ LEGAL_KEEP_YEARS: "bad" }));
    expect(lines.length).toBeGreaterThanOrEqual(4);
    for (const text of [...lines, ...logs]) for (const secret of [ADDRESS, REFERENCE, SUBJECT, VERSION, "buyer"]) expect(text).not.toContain(secret);
  });
});

// ---------------------------------------------------------------------------------------------
describe("task 9: the admin panel", () => {
  const E = { ...env, SESSION_SECRET: "s3" } as typeof env;
  let cookie: string;
  let csrf: string;
  beforeEach(async () => {
    await pinAdmin("sub-1");
    cookie = await createSession("s3", "sub-1");
    csrf = (await readSession("s3", cookie))!.csrf;
  });
  const get = (path: string) => adminRequest(E, path, { headers: { cookie: `ulak_admin=${cookie}` } });
  const post = (path: string, fields: Record<string, string>) =>
    adminRequest(E, path, { method: "POST", headers: { cookie: `ulak_admin=${cookie}`, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf, ...fields }).toString() });

  it("with nothing open the page says so in one line, and the layout links it", async () => {
    const html = await (await get("/legal")).text();
    expect(html).toContain("No open legal alerts.");
    expect(html).toContain('<a href="/legal">Legal</a>');
  });

  it("lists open alerts and closes one by its form; never a body or an address on a page", async () => {
    const key = await legalApp();
    replies.push(refusedAddress);
    const id = await idOf(await sendLegal(key));
    let page = await (await get("/legal")).text();
    expect(page).toContain(REFERENCE);
    expect(page).toContain(VERSION);
    expect(page).toContain("held");
    const searched = await (await get(`/legal?reference=${REFERENCE}`)).text();
    expect(searched).toContain(`/legal/${id}/copy`);
    for (const p of [page, searched]) for (const secret of [ADDRESS, "Withdrawal", SUBJECT]) expect(p).not.toContain(secret);
    const [alert] = await alerts(id);
    expect((await post(`/legal/alerts/${alert.id}/close`, { reason: "", replaced_by: "" })).status).toBe(400);
    const closed = await post(`/legal/alerts/${alert.id}/close`, { reason: "mailed by hand", replaced_by: "" });
    expect(closed.status).toBe(303);
    page = await (await get("/legal")).text();
    expect(page).toContain("No open legal alerts.");
  });

  it("search is exact, filters by app and shows at most SEARCH_LIMIT", async () => {
    await env.DB.prepare(
      `WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM k WHERE i<?1)
       INSERT INTO legal_documents (mail_id,app,reference,version,idempotency_key,label,locale,to_addr,subject,text_body,text_sha256,addr_hash,created_at)
       SELECT printf('c-%04d',i),'shop','R-1','v',printf('k-%04d',i),'l','en','a@example.org','s','t','h','h',printf('2026-10-%02dT00:00:00.000Z', 1 + i % 28) FROM k`,
    )
      .bind(SEARCH_LIMIT + 1)
      .run();
    await env.DB.prepare("INSERT INTO legal_documents (mail_id,app,reference,version,idempotency_key,label,locale,to_addr,subject,text_body,text_sha256,addr_hash,created_at) VALUES ('o-1','other','R-1','v','k','l','en','a@example.org','s','t','h','h','2026-10-01T00:00:00.000Z')").run();
    const all = await (await get("/legal?reference=R-1")).text();
    expect(all.match(/\/copy"/g)).toHaveLength(SEARCH_LIMIT);
    expect(all).toContain(`Showing the newest ${SEARCH_LIMIT}`);
    const other = await (await get("/legal?reference=R-1&app=other")).text();
    expect(other.match(/\/copy"/g)).toHaveLength(1);
    expect(await (await get("/legal?reference=R-")).text()).toContain("No copy with that reference.");
  });

  it("the download is the copy as sent, as a plain-text attachment named by the mail id only", async () => {
    const key = await legalApp();
    const id = await idOf(await sendLegal(key));
    await event(id, "email_delivered", { details: { mx_host: "mx.example.org" } });
    // A reference that could break a header, planted past validation: it never reaches one.
    await env.DB.prepare("UPDATE legal_documents SET reference=? WHERE mail_id=?").bind('O"77\r\nX-Evil: 1', id).run();
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(" ")));
    const res = await get(`/legal/${id}/copy`);
    expect(res.status).toBe(200);
    expect(logs).toEqual([`legal copy downloaded {"mail_id":"${id}","app":"shop","admin":"sub-1"}`]);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename="legal-${id}.txt"`);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-evil")).toBeNull();
    const text = await res.text();
    expect(text).toContain(`Recipient: ${ADDRESS}`);
    expect(text).toContain("receiving server mx.example.org");
    expect(text).toContain("request req-1");
    const [, quoted] = text.match(/^Delivered event as the mail service sent it: (.*)$/m)!;
    expect(JSON.parse(quoted!)).toBe((await copy(id))!.delivered_event);
    expect((await copy(id))!.delivered_event).toContain('"mx_host":"mx.example.org"');
    const [, subjectLine] = text.match(/^Subject: (.*)$/m)!;
    expect(text).toContain("Sender block under the document: as below");
    // The body is the mailed text: the document, then the sender block that went under it.
    const body = text.slice(text.indexOf("\n\n") + 2);
    expect(body).toBe(`${TEXT}\n\n-- \n${MAIL.MAIL_SENDER_INFO}`);
    expect(body).toBe(calls[0]!.body.textbody);
    const doc = body.slice(0, body.lastIndexOf("\n\n-- \n"));
    expect(await sha256Hex(hashedText(subjectLine!, doc))).toBe((await copy(id))!.text_sha256);
    expect((await get("/legal/nope/copy")).status).toBe(404);
  });

  it("the legal tick is refused until the timer found the keeping period set, and is kept on save", async () => {
    await legalApp();
    await createApp(env.DB, "plain");
    const fields = { retention_days: "90", mail_from_name: "Plain", mail_labels: "receipt", allowed_origins: "" };
    const refused = await post("/apps/plain", { ...fields, mail_transactional: "on", mail_legal: "on" });
    expect(refused.status).toBe(400);
    expect(await refused.text()).toMatch(/LEGAL_KEEP_YEARS/);
    await runOutbox(lenv());
    expect((await post("/apps/plain", { ...fields, mail_transactional: "on", mail_legal: "on" })).status).toBe(303);
    const kinds = async (id: string) => JSON.parse((await env.DB.prepare("SELECT mail_kinds FROM apps WHERE id=?").bind(id).first<{ mail_kinds: string }>())!.mail_kinds);
    expect(await kinds("plain")).toEqual(["transactional", "legal_document"]);
    // An app that already sends legal documents keeps the tick on any later save, even with the setting gone.
    await runOutbox(lenv({ LEGAL_KEEP_YEARS: undefined }));
    expect((await post("/apps/shop", { ...fields, mail_transactional: "on", mail_legal: "on" })).status).toBe(303);
    expect(await kinds("shop")).toEqual(["transactional", "legal_document"]);
    expect((await post("/apps/shop", { ...fields, mail_transactional: "on" })).status).toBe(303);
    expect(await kinds("shop")).toEqual(["transactional"]);
    expect(await (await get("/apps")).text()).toContain("sends legal documents");
  });

  it("deleting a person from the panel shows the kept copies", async () => {
    const key = await legalApp();
    await sendLegal(key);
    const m = await insertMessage(env.DB, { ...submission({ app: "shop", user_ref: "user-0123456789abcdef" }) }, "pending", { sinceBurstIso: "2000-01-01T00:00:00.000Z", burstLimit: 100, sinceHourIso: "2000-01-01T00:00:00.000Z", hourLimit: 100 });
    const res = await post(`/m/${m.row.id}/delete-user`, {});
    expect(res.headers.get("location")).toBe("/?app=shop&deleted=1&kept=1");
    expect(await (await get(res.headers.get("location")!)).text()).toContain("kept 1 legal copy");
  });
});
