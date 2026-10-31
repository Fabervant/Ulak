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
  remindOpenAlerts,
  stampSent,
  tellAlerts,
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

const MAIL = { MAIL_API_URL: "https://mail.example.invalid/v1.1/email", MAIL_FROM_DOMAIN: "example.invalid", MAIL_API_KEY: "vendor-key", MAIL_WEBHOOK_KEY: "hook-key", MAIL_HASH_SECRET: "hash-secret" };
const LEGAL = { LEGAL_KEEP_DAYS: "1096" };
const TG = { NOTIFIER: "telegram", TELEGRAM_BOT_TOKEN: "t", TELEGRAM_CHAT_ID: "c" };
const lenv = (over: Partial<Env> = {}) => ({ ...env, ...MAIL, ...LEGAL, ...TG, ...over }) as Env;

const ADDRESS = "buyer@example.org";
const SUBJECT = "Your order ORD-77: contract and pre-information form";
const TEXT = "Pre-information form, version tos-2026-10.\nDistance sales contract between the seller and the buyer.\nWithdrawal: 14 days.";
const REFERENCE = "ORD-77";
const VERSION = "tos-2026-10";

/** The vendor double: records each call and answers with the next scripted reply (default 200). */
let calls: Array<{ body: any }> = [];
let replies: Array<() => Response | Promise<Response>> = [];
/** Telegram lines, captured. `failTelegram` makes the next n sends fail. */
let lines: string[] = [];
let failTelegram = 0;
const realFetch = vendorTransport.fetch;
const realSend = TelegramNotifier.prototype.send;
beforeEach(() => {
  calls = [];
  replies = [];
  lines = [];
  failTelegram = 0;
  vendorTransport.fetch = (async (_url: string, init: RequestInit) => {
    calls.push({ body: JSON.parse(String(init.body)) });
    const next = replies.shift();
    return next ? next() : new Response(JSON.stringify({ request_id: `req-${calls.length}`, message: "OK" }), { status: 200 });
  }) as typeof fetch;
  TelegramNotifier.prototype.send = async function (n) {
    if (failTelegram > 0) {
      failTelegram -= 1;
      throw new Error("telegram down");
    }
    lines.push(`${n.text}\n${n.adminLink ?? ""}`);
  };
});
afterEach(() => {
  vendorTransport.fetch = realFetch;
  TelegramNotifier.prototype.send = realSend;
  vi.restoreAllMocks();
});
const down = () => new Response("bad gateway", { status: 502 });
const refusedAddress = () => new Response('{"error":{"code":"TM_4001","details":[{"code":"SM_113","target":"to"}]}}', { status: 400 });
const malformed = () => new Response('{"error":{"code":"TM_3301"}}', { status: 400 });

async function legalApp(id = "shop"): Promise<string> {
  await createApp(env.DB, id);
  await updateApp(env.DB, id, { mail_from_name: "Shop", mail_kinds: ["transactional", "legal_document"], mail_labels: ["order_documents", "receipt"] });
  return rotateSendKey(env.DB, id);
}

const legalBody = (over: Record<string, unknown> = {}) => ({
  to: ADDRESS,
  locale: "tr",
  kind: "legal_document",
  label: "order_documents",
  subject: SUBJECT,
  text: TEXT,
  expires_at: addMinutes(nowIso(), 24 * 60 - 1),
  idempotency_key: `sale-${crypto.randomUUID()}`,
  user_ref: "user-0123456789abcdef",
  document: { version: VERSION, reference: REFERENCE, sale: "one_off" },
  ...over,
});

async function call(path: string, key: string | null, body: unknown, e: Env = lenv(), headers: Record<string, string> = {}) {
  const h: Record<string, string> = { "content-type": "application/json", ...headers };
  if (key) h.authorization = `Bearer ${key}`;
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`https://api.example.invalid${path}`, { method: "POST", headers: h, body: JSON.stringify(body) }), e, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}
const sendLegal = (key: string, over: Record<string, unknown> = {}, e?: Env) => call("/v1/mail", key, legalBody(over), e);
const idOf = async (res: Response) => (await res.json<{ id: string }>()).id;
const copy = (id: string) => env.DB.prepare("SELECT * FROM legal_documents WHERE mail_id=?").bind(id).first<LegalDocument>();
const mailRow = (id: string) => env.DB.prepare("SELECT * FROM mails WHERE id=?").bind(id).first<any>();
const alerts = (id?: string) =>
  (id ? env.DB.prepare("SELECT * FROM legal_alerts WHERE mail_id=? ORDER BY opened_at").bind(id) : env.DB.prepare("SELECT * FROM legal_alerts ORDER BY opened_at")).all<any>().then((r) => r.results);

async function event(mailId: string | null, object: string, extra: { requestId?: string; details?: Record<string, unknown> } = {}) {
  const json = JSON.stringify({
    event_name: object,
    event_message: [
      {
        email_info: { client_reference: mailId ?? undefined, to: [{ email_address: { address: ADDRESS } }], subject: SUBJECT },
        event_data: [{ object, details: [extra.details ?? { reason: "Mailbox not found", diagnostic_message: `550 5.1.1 ${ADDRESS} unknown` }] }],
        request_id: extra.requestId ?? "req-x",
      },
    ],
  });
  const { body, header } = await vendorSigned(json, MAIL.MAIL_WEBHOOK_KEY, Date.now());
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request("https://api.example.invalid/v1/mail/events", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "producer-signature": header }, body }), lenv(), ctx);
  await waitOnExecutionContext(ctx);
  expect(res.status).toBe(200);
  return res;
}

// ---------------------------------------------------------------------------------------------
describe("task 1: schema and keys scoped by kind", () => {
  it("has the two tables; a copy has no foreign key, an alert cascades from its copy", async () => {
    const t = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('legal_documents','legal_alerts') ORDER BY name").all<{ name: string }>();
    expect(t.results.map((x) => x.name)).toEqual(["legal_alerts", "legal_documents"]);
    expect((await env.DB.prepare("PRAGMA foreign_key_list(legal_documents)").all()).results).toEqual([]);
    const fk = (await env.DB.prepare("PRAGMA foreign_key_list(legal_alerts)").all<any>()).results;
    expect(fk).toHaveLength(1);
    expect(fk[0]).toMatchObject({ table: "legal_documents", from: "mail_id", on_delete: "CASCADE" });
    const idx = (await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name IN ('legal_documents','legal_alerts','mails')").all<{ name: string }>()).results.map((r) => r.name);
    expect(idx).toEqual(expect.arrayContaining(["legal_documents_idem", "legal_documents_reference", "legal_documents_created", "legal_documents_addr", "legal_documents_user", "legal_alerts_open", "legal_alerts_closed", "mails_idem"]));
  });

  it("removing an app never deletes its legal copies", async () => {
    const key = await legalApp();
    const id = await idOf(await sendLegal(key));
    await env.DB.prepare("DELETE FROM apps WHERE id='shop'").run();
    expect(await mailRow(id)).toBeNull(); // the transport row cascades, as in phase 0
    expect(await copy(id)).not.toBeNull();
  });

  it("one key can serve a receipt and a legal document, in either order", async () => {
    const key = await legalApp();
    for (const order of [["transactional", "legal_document"], ["legal_document", "transactional"]] as const) {
      const k = `sale-${crypto.randomUUID()}`;
      const ids: string[] = [];
      for (const kind of order) {
        const body = kind === "legal_document" ? legalBody({ idempotency_key: k }) : { ...legalBody({ idempotency_key: k, kind, label: "receipt" }), document: undefined };
        const res = await call("/v1/mail", key, body);
        expect(res.status).toBe(202);
        ids.push(await idOf(res));
      }
      expect(ids[0]).not.toBe(ids[1]);
      const now = nowIso();
      expect((await findByIdempotencyKey(env.DB, "shop", "transactional", k, now))!.kind).toBe("transactional");
      expect((await findByIdempotencyKey(env.DB, "shop", "legal_document", k, now))!.kind).toBe("legal_document");
    }
    expect(calls).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------------------------
describe("task 2: settings", () => {
  const cfg = (over: Record<string, string | undefined>) => legalConfig({ ...env, ...over } as Env);
  it("unset keeping period: null; set: the numbers; expiry 24 by default", () => {
    expect(cfg({})).toBeNull();
    expect(cfg({ LEGAL_KEEP_DAYS: "  " })).toBeNull();
    expect(cfg({ LEGAL_KEEP_DAYS: "1096" })).toEqual({ keepDays: 1096, expiryHours: 24 });
    expect(cfg({ LEGAL_KEEP_DAYS: "3650", LEGAL_EXPIRY_HOURS: "72" })).toEqual({ keepDays: 3650, expiryHours: 72 });
    expect(cfg({ LEGAL_KEEP_DAYS: "365", LEGAL_EXPIRY_HOURS: "1" })).toEqual({ keepDays: 365, expiryHours: 1 });
  });
  for (const [name, over] of [
    ["keep 0", { LEGAL_KEEP_DAYS: "0" }],
    ["keep under a year (109 typed for 1096)", { LEGAL_KEEP_DAYS: "109" }],
    ["keep 364", { LEGAL_KEEP_DAYS: "364" }],
    ["keep negative", { LEGAL_KEEP_DAYS: "-5" }],
    ["keep fraction", { LEGAL_KEEP_DAYS: "1.5" }],
    ["keep words", { LEGAL_KEEP_DAYS: "3 years" }],
    ["expiry 0", { LEGAL_KEEP_DAYS: "1096", LEGAL_EXPIRY_HOURS: "0" }],
    ["expiry 73", { LEGAL_KEEP_DAYS: "1096", LEGAL_EXPIRY_HOURS: "73" }],
    ["expiry words", { LEGAL_KEEP_DAYS: "1096", LEGAL_EXPIRY_HOURS: "a day" }],
    ["expiry bad while keep unset", { LEGAL_EXPIRY_HOURS: "99" }],
  ] as const) {
    it(`bad setting throws: ${name}`, () => expect(() => cfg(over)).toThrow(/LEGAL_/));
  }

  it("the timer records the state; the health check goes red on a bad setting and green again once fixed", async () => {
    await runOutbox(lenv({ LEGAL_KEEP_DAYS: "0" }));
    let r = await runChecks(env.DB, addMinutes(nowIso(), 1));
    expect(r).toMatchObject({ ok: false, legal_config_bad: 1 });
    await runOutbox(lenv());
    r = await runChecks(env.DB, addMinutes(nowIso(), 1));
    expect(r).toMatchObject({ ok: true, legal_config_bad: 0 });
    await runOutbox(lenv({ LEGAL_KEEP_DAYS: undefined }));
    expect((await env.DB.prepare("SELECT value FROM service_state WHERE key='legal_config'").first<{ value: string }>())!.value).toBe("unset");
    expect((await runChecks(env.DB, addMinutes(nowIso(), 1))).ok).toBe(true);
  });

  it("an open alert shows in the health check without turning it red", async () => {
    const key = await legalApp();
    await env.DB.prepare("INSERT INTO mails (id,app,kind,label,locale,addr_hash,status,expires_at,created_at,last_activity_at) VALUES ('x','shop','transactional','receipt','en','h','bounced',?1,?1,?1)").bind(nowIso()).run();
    await env.DB.prepare("UPDATE mails SET addr_hash=? WHERE id='x'").bind(await addrHash(MAIL.MAIL_HASH_SECRET, "shop", ADDRESS)).run();
    expect((await sendLegal(key)).status).toBe(202);
    expect(await runChecks(env.DB)).toMatchObject({ ok: true, legal_alerts_open: 1 });
  });

  it("the legal path refuses while the keeping period is unset, and answers 500 when it is bad", async () => {
    const key = await legalApp();
    const unset = await sendLegal(key, {}, lenv({ LEGAL_KEEP_DAYS: undefined }));
    expect(unset.status).toBe(422);
    expect(await unset.json()).toMatchObject({ error: "kind_not_allowed", retryable: false });
    const bad = await sendLegal(key, {}, lenv({ LEGAL_KEEP_DAYS: "forever" }));
    expect(bad.status).toBe(500);
    expect(await bad.json()).toMatchObject({ error: "legal_config_bad" });
    expect(calls).toHaveLength(0);
    expect((await env.DB.prepare("SELECT COUNT(*) n FROM legal_documents").first<{ n: number }>())!.n).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
describe("task 3: validation", () => {
  const NOW = "2026-10-31T10:00:00.000Z";
  const raw = (over: Record<string, unknown> = {}) => ({ ...legalBody(over), expires_at: "2026-11-01T09:00:00Z" });
  it("a good legal request carries its document", () => {
    expect(validateMail(raw(), NOW).document).toEqual({ version: VERSION, reference: REFERENCE, sale: "one_off" });
  });
  for (const [name, over, field] of [
    ["document missing", { document: undefined }, "document"],
    ["document not an object", { document: "ORD-77" }, "document"],
    ["reference with a space", { document: { version: "v", reference: "ORD 77", sale: "one_off" } }, "document.reference"],
    ["reference with a quote", { document: { version: "v", reference: 'ORD"77', sale: "one_off" } }, "document.reference"],
    ["reference too long", { document: { version: "v", reference: "x".repeat(65), sale: "one_off" } }, "document.reference"],
    ["version empty", { document: { version: "", reference: "r", sale: "one_off" } }, "document.version"],
    ["sale unknown", { document: { version: "v", reference: "r", sale: "lifetime" } }, "document.sale"],
    ["document on a transactional mail", { kind: "transactional" }, "document"],
  ] as const) {
    it(`400 for ${name}`, () => {
      try {
        validateMail(raw(over), NOW);
        expect.unreachable();
      } catch (e: any) {
        expect(e.status).toBe(400);
        expect(e.extra.field).toBe(field);
      }
    });
  }
  it("the legal expiry follows its setting; a transactional mail keeps 24 hours", () => {
    const at = (h: number) => addMinutes(NOW, h * 60);
    expect(() => validateMail({ ...raw(), expires_at: at(25) }, NOW)).toThrow(/at most 24 hours/);
    expect(validateMail({ ...raw(), expires_at: at(47) }, NOW, 48).expires_at).toBe(at(47));
    expect(() => validateMail({ ...raw(), expires_at: at(49) }, NOW, 48)).toThrow(/at most 48 hours/);
    expect(() => validateMail({ ...raw({ kind: "transactional", document: undefined }), expires_at: at(25) }, NOW, 48)).toThrow(/at most 24 hours/);
  });
  it("the route applies the expiry setting", async () => {
    const key = await legalApp();
    const e = lenv({ LEGAL_EXPIRY_HOURS: "48" });
    expect((await sendLegal(key, { expires_at: addMinutes(nowIso(), 47 * 60) }, e)).status).toBe(202);
    expect((await sendLegal(key, { expires_at: addMinutes(nowIso(), 47 * 60) })).status).toBe(400);
  });
  it("html is refused on a legal document: 422 bad_html", async () => {
    const key = await legalApp();
    const res = await sendLegal(key, { html: "<p>Contract</p>" });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: "bad_html" });
  });
  it("the copy's hash is SHA-256 of the subject, a blank line and the text", async () => {
    const key = await legalApp();
    const id = await idOf(await sendLegal(key));
    expect((await copy(id))!.text_sha256).toBe(await sha256Hex(`${SUBJECT}\n\n${TEXT}`));
  });
});

// ---------------------------------------------------------------------------------------------
describe("task 4: acceptance, the ceiling exemption and repeats", () => {
  it("answers 202 queued, keeps the copy, sends, and stamps the acceptance on the copy", async () => {
    const key = await legalApp();
    const res = await sendLegal(key);
    expect(res.status).toBe(202);
    const { id, status } = await res.json<{ id: string; status: string }>();
    expect(status).toBe("queued");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toMatchObject({ subject: SUBJECT, textbody: TEXT, client_reference: id });
    expect(calls[0]!.body.htmlbody).toBeUndefined();
    const c = (await copy(id))!;
    expect(c).toMatchObject({ app: "shop", reference: REFERENCE, version: VERSION, to_addr: ADDRESS, subject: SUBJECT, text_body: TEXT, vendor_request_id: "req-1", user_ref: "user-0123456789abcdef" });
    expect(c.sent_at).not.toBeNull();
    expect(c.keep_from).toBe(c.created_at); // a one-off sale's period starts at the sale
    expect(await mailRow(id)).toMatchObject({ kind: "legal_document", status: "sent", to_addr: null, subject: null, text_body: null });
  });

  it("a subscription's copy has no keeping start until the app reports the end", async () => {
    const key = await legalApp();
    const id = await idOf(await sendLegal(key, { document: { version: VERSION, reference: REFERENCE, sale: "subscription" } }));
    expect((await copy(id))!.keep_from).toBeNull();
  });

  it("11 legal documents to one address are all accepted and do not count toward the transactional ceiling", async () => {
    const key = await legalApp();
    for (let i = 0; i < 11; i++) expect((await sendLegal(key)).status).toBe(202);
    expect((await env.DB.prepare("SELECT COUNT(*) n FROM legal_documents").first<{ n: number }>())!.n).toBe(11);
    for (let i = 0; i < 10; i++) {
      const r = await call("/v1/mail", key, { ...legalBody({ kind: "transactional", label: "receipt" }), document: undefined });
      expect(r.status, `transactional ${i + 1}`).toBe(202);
    }
    const over = await call("/v1/mail", key, { ...legalBody({ kind: "transactional", label: "receipt" }), document: undefined });
    expect(over.status).toBe(429);
  });

  it("a repeat answers 202 queued with the first id and sends nothing, whatever the body", async () => {
    const key = await legalApp();
    const body = legalBody();
    const first = await idOf(await call("/v1/mail", key, body));
    const again = await call("/v1/mail", key, { ...body, subject: "changed" });
    expect(again.status).toBe(202);
    expect(await again.json()).toEqual({ id: first, status: "queued" });
    expect(calls).toHaveLength(1);
  });

  it("parallel calls with one key make one copy and one send, and all answer its id", async () => {
    const key = await legalApp();
    const body = legalBody();
    const res = await Promise.all([1, 2, 3, 4].map(() => call("/v1/mail", key, body)));
    const ids = await Promise.all(res.map(async (r) => (expect(r.status).toBe(202), idOf(r))));
    expect(new Set(ids).size).toBe(1);
    expect((await env.DB.prepare("SELECT COUNT(*) n FROM legal_documents").first<{ n: number }>())!.n).toBe(1);
    expect((await env.DB.prepare("SELECT COUNT(*) n FROM mails").first<{ n: number }>())!.n).toBe(1);
    expect(calls).toHaveLength(1);
  });

  it("a suppressed address: copy kept, transport row closed with nothing in it, held alert, one line, nothing sent", async () => {
    const key = await legalApp();
    const hash = await addrHash(MAIL.MAIL_HASH_SECRET, "shop", ADDRESS);
    await env.DB.prepare("INSERT INTO mails (id,app,kind,label,locale,addr_hash,status,expires_at,created_at,last_activity_at) VALUES ('b','shop','transactional','receipt','en',?1,'bounced',?2,?2,?2)").bind(hash, nowIso()).run();
    const res = await sendLegal(key);
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ status: "queued" });
    const id = (await env.DB.prepare("SELECT mail_id FROM legal_documents").first<{ mail_id: string }>())!.mail_id;
    expect(calls).toHaveLength(0);
    const m = await mailRow(id);
    expect(m).toMatchObject({ status: "refused", to_addr: null, subject: null, text_body: null, html_body: null });
    expect(m.operator_told_at).not.toBeNull();
    expect((await copy(id))!.text_body).toBe(TEXT);
    expect((await alerts(id)).map((a) => a.kind)).toEqual(["held"]);
    expect(lines).toEqual(["[shop] legal document held: open in the admin panel\nhttps://admin.example.invalid/legal"]);
    expect(await tellFailures(lenv())).toBe(0); // the phase-0 line is never sent for it
  });

  it("repeats after held, after given up and after 8 days all answer 202 queued with the first id", async () => {
    const key = await legalApp();
    const hash = await addrHash(MAIL.MAIL_HASH_SECRET, "shop", "held@example.org");
    await env.DB.prepare("INSERT INTO mails (id,app,kind,label,locale,addr_hash,status,expires_at,created_at,last_activity_at) VALUES ('b','shop','transactional','receipt','en',?1,'bounced',?2,?2,?2)").bind(hash, nowIso()).run();
    const heldBody = legalBody({ to: "held@example.org" });
    const held = await idOf(await call("/v1/mail", key, heldBody));

    replies.push(down);
    const goneBody = legalBody({ expires_at: addMinutes(nowIso(), 10) });
    const gone = await idOf(await call("/v1/mail", key, goneBody));
    await runOutbox(lenv(), addMinutes(nowIso(), 11));
    expect((await mailRow(gone)).status).toBe("given_up");

    const oldBody = legalBody();
    const old = await idOf(await call("/v1/mail", key, oldBody));
    const eightDaysAgo = addMinutes(nowIso(), -8 * 24 * 60);
    await env.DB.prepare("UPDATE legal_documents SET created_at=? WHERE mail_id=?").bind(eightDaysAgo, old).run();
    await env.DB.prepare("UPDATE mails SET created_at=? WHERE id=?").bind(eightDaysAgo, old).run();
    await purgeMailHousekeeping(env.DB, nowIso());
    expect((await mailRow(old)).idempotency_key).toBeNull(); // phase 0's key is spent; the copy's is not

    const sentBefore = calls.length;
    for (const [body, id] of [[heldBody, held], [goneBody, gone], [oldBody, old]] as const) {
      const again = await call("/v1/mail", key, { ...body, expires_at: addMinutes(nowIso(), 60) });
      expect(again.status).toBe(202);
      expect(await again.json()).toEqual({ id, status: "queued" });
    }
    expect(calls.length).toBe(sentBefore);
  });
});

// ---------------------------------------------------------------------------------------------
describe("task 5: stamps and alerts on every transition", () => {
  it("the vendor refuses the address: held alert, told once, and no phase-0 line", async () => {
    const key = await legalApp();
    replies.push(refusedAddress);
    const id = await idOf(await sendLegal(key));
    expect((await mailRow(id)).status).toBe("refused");
    expect((await alerts(id)).map((a) => a.kind)).toEqual(["held"]);
    expect(lines).toHaveLength(1);
    expect(await untoldFailures(env.DB)).toEqual([]);
  });

  it("the vendor calls it malformed: failed alert", async () => {
    const key = await legalApp();
    replies.push(malformed);
    const id = await idOf(await sendLegal(key));
    expect((await alerts(id)).map((a) => a.kind)).toEqual(["failed"]);
    expect((await copy(id))!.sent_at).toBeNull();
  });

  it("given up at expiry: given_up alert and exactly one Telegram line", async () => {
    const key = await legalApp();
    replies.push(down);
    const id = await idOf(await sendLegal(key, { expires_at: addMinutes(nowIso(), 10) }));
    const after = addMinutes(nowIso(), 11);
    await runOutbox(lenv(), after);
    await runOutbox(lenv(), addMinutes(after, 5));
    expect((await alerts(id)).map((a) => a.kind)).toEqual(["given_up"]);
    expect(lines).toEqual(["[shop] legal document given_up: open in the admin panel\nhttps://admin.example.invalid/legal"]);
  });

  it("a delivered event stamps the copy with its time and receiving server, once", async () => {
    const key = await legalApp();
    const id = await idOf(await sendLegal(key));
    await event(id, "email_delivered", { details: { delivered_to_server: "mx.example.org", time: "x" } });
    const c = (await copy(id))!;
    expect(c.delivered_at).not.toBeNull();
    expect(c.delivered_server).toBe("mx.example.org");
    await event(id, "email_delivered", { details: { mx: "other.example.net" } });
    expect((await copy(id))!).toMatchObject({ delivered_at: c.delivered_at, delivered_server: "mx.example.org" });
  });

  it("the acceptance is stamped once: a second stamp keeps the first time and id", async () => {
    const key = await legalApp();
    const id = await idOf(await sendLegal(key));
    const first = (await copy(id))!;
    await stampSent(env.DB, id, addMinutes(nowIso(), 5), "req-again");
    expect((await copy(id))!).toMatchObject({ sent_at: first.sent_at, vendor_request_id: "req-1" });
  });

  it("a receiving server that is not shaped as a host is not kept", async () => {
    const key = await legalApp();
    const id = await idOf(await sendLegal(key));
    await event(id, "email_delivered", { details: { server_response: `250 ok ${ADDRESS}` } });
    expect((await copy(id))!.delivered_server).toBeNull();
  });

  it("a delivered event stamps the copy even after the transport row is gone, found by the vendor's id", async () => {
    const key = await legalApp();
    const id = await idOf(await sendLegal(key));
    await env.DB.prepare("DELETE FROM mails WHERE id=?").bind(id).run();
    await event(null, "email_delivered", { requestId: "req-1" });
    expect((await copy(id))!.delivered_at).not.toBeNull();
  });

  it("a delivery closes the open undelivered alert by itself", async () => {
    const key = await legalApp();
    const id = await idOf(await sendLegal(key));
    expect(await openUndelivered(env.DB, addMinutes(nowIso(), 61))).toBe(1);
    await event(id, "email_delivered");
    expect(await alerts(id)).toMatchObject([{ kind: "undelivered", close_reason: "delivered" }]);
    expect((await alerts(id))[0].closed_at).not.toBeNull();
  });

  it("a hard bounce opens bounced once; a replay after closing does not reopen it", async () => {
    const key = await legalApp();
    const id = await idOf(await sendLegal(key));
    await event(id, "hardbounce");
    await event(id, "hardbounce");
    let a = await alerts(id);
    expect(a.map((x) => x.kind)).toEqual(["bounced"]);
    await closeAlert(env.DB, a[0].id, "sent by hand", null, nowIso());
    await event(id, "hardbounce");
    a = await alerts(id);
    expect(a).toHaveLength(1);
    expect(a[0].closed_at).not.toBeNull();
  });

  it("a spam complaint and a soft bounce open no alert", async () => {
    const key = await legalApp();
    const a = await idOf(await sendLegal(key));
    const b = await idOf(await sendLegal(key));
    await event(a, "feedback_loop");
    await event(b, "softbounce");
    expect(await alerts()).toEqual([]);
  });

  it("an undelivered alert and a later bounce are two alerts, each told once", async () => {
    const key = await legalApp();
    const id = await idOf(await sendLegal(key));
    await runOutbox(lenv(), addMinutes(nowIso(), 61));
    await event(id, "hardbounce");
    await tellAlerts(lenv());
    // The undelivered alert was opened at a clock an hour ahead, so order by kind, not by time.
    expect((await alerts(id)).map((x) => x.kind).sort()).toEqual(["bounced", "undelivered"]);
    expect(lines.map((l) => l.split("\n")[0]).sort()).toEqual(["[shop] legal document bounced: open in the admin panel", "[shop] legal document undelivered: open in the admin panel"]);
  });

  it("race: a bounce that lands mid-attempt wins; the attempt's late write records nothing, the event records the acceptance", async () => {
    const key = await legalApp();
    let id = "";
    replies.push(async () => {
      // The vendor took the mail and its bounce arrived before Ulak wrote the acceptance.
      id = (await env.DB.prepare("SELECT id FROM mails").first<{ id: string }>())!.id;
      await applyEvent(env.DB, { type: "hardbounce", ref: id, requestId: null, reason: "x" }, nowIso());
      return new Response(JSON.stringify({ request_id: "req-late" }), { status: 200 });
    });
    await sendLegal(key);
    expect((await mailRow(id)).status).toBe("bounced");
    const c = (await copy(id))!;
    expect(c.vendor_request_id).toBeNull(); // never the losing write's "req-late"
    expect(c.sent_at).not.toBeNull(); // the bounce proves the vendor had it
    expect((await alerts(id)).map((x) => x.kind)).toEqual(["bounced"]);
  });

  it("race: a refusal whose write lost to a delivery opens no held alert", async () => {
    const key = await legalApp();
    replies.push(async () => {
      const id = (await env.DB.prepare("SELECT id FROM mails").first<{ id: string }>())!.id;
      await applyEvent(env.DB, { type: "delivered", ref: id, requestId: "req-d", server: null }, nowIso());
      return refusedAddress();
    });
    const id = await idOf(await sendLegal(key));
    expect((await mailRow(id)).status).toBe("delivered");
    expect(await alerts(id)).toEqual([]);
  });

  it("a delivered copy that later bounces cannot close its alert with itself", async () => {
    const key = await legalApp();
    const id = await idOf(await sendLegal(key));
    await event(id, "email_delivered");
    await event(id, "hardbounce");
    const [a] = await alerts(id);
    await expect(closeAlert(env.DB, a.id, "itself", id, nowIso())).rejects.toMatchObject({ status: 400 });
  });

  it("an event fills a missing acceptance with its time and the vendor's id, and never overwrites one", async () => {
    const key = await legalApp();
    const id = await idOf(await sendLegal(key));
    const first = (await copy(id))!;
    await event(id, "softbounce", { requestId: "req-other" });
    expect((await copy(id))!).toMatchObject({ sent_at: first.sent_at, vendor_request_id: "req-1" });
    await env.DB.prepare("UPDATE legal_documents SET sent_at=NULL, vendor_request_id=NULL WHERE mail_id=?").bind(id).run();
    await env.DB.prepare("DELETE FROM mails WHERE id=?").bind(id).run();
    await event(id, "feedback_loop", { requestId: "req-1" });
    const c = (await copy(id))!;
    expect(c.vendor_request_id).toBe("req-1");
    expect(c.sent_at).not.toBeNull();
  });

  it("a stopped Worker's lost stamp and lost alerts are repaired by the 5-minute job, once", async () => {
    const key = await legalApp();
    const sent = await idOf(await sendLegal(key));
    replies.push(refusedAddress);
    const refused = await idOf(await sendLegal(key));
    replies.push(down);
    const gone = await idOf(await sendLegal(key, { expires_at: addMinutes(nowIso(), 10) }));
    await runOutbox(lenv(), addMinutes(nowIso(), 11));
    // What a Worker stopped between its two writes leaves: the transport row written, the copy's part not.
    await env.DB.prepare("UPDATE legal_documents SET sent_at=NULL, vendor_request_id=NULL WHERE mail_id=?").bind(sent).run();
    await env.DB.prepare("DELETE FROM legal_alerts").run();
    lines = [];
    await runOutbox(lenv(), addMinutes(nowIso(), 12));
    const s = (await copy(sent))!;
    expect(s.vendor_request_id).toBe("req-1");
    expect(s.sent_at).toBe((await mailRow(sent)).sent_at);
    expect((await alerts(refused)).map((a) => a.kind)).toEqual(["held"]);
    expect((await alerts(gone)).map((a) => a.kind)).toEqual(["given_up"]);
    expect(lines).toHaveLength(2);
    await runOutbox(lenv(), addMinutes(nowIso(), 17));
    expect(await alerts()).toHaveLength(2);
    expect(lines).toHaveLength(2);
  });

  it("untoldFailures skips legal mails", async () => {
    const key = await legalApp();
    replies.push(malformed);
    await sendLegal(key);
    expect(await untoldFailures(env.DB)).toEqual([]);
  });
});

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

  it("a line that fails to send is given back and sent at the next run", async () => {
    const key = await legalApp();
    failTelegram = 1;
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
    failTelegram = 1;
    await sendLegal(key);
    await Promise.all([tellAlerts(lenv()), tellAlerts(lenv()), tellAlerts(lenv())]);
    expect(lines).toHaveLength(1);
  });

  it("the daily reminder: one line a day while alerts are open, given back if it fails", async () => {
    const key = await legalApp();
    replies.push(refusedAddress, malformed);
    await sendLegal(key);
    await sendLegal(key);
    lines = [];
    const day1 = "2026-11-01T08:00:00.000Z";
    failTelegram = 1;
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
    lines = [];
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
    failTelegram = 1;
    const id = await idOf(await sendLegal(key, { expires_at: addMinutes(nowIso(), 10) }));
    await runOutbox(lenv(), addMinutes(nowIso(), 61));
    await event(id, "hardbounce");
    await tellAlerts(lenv());
    await remindOpenAlerts(lenv(), "2026-12-01T00:00:00.000Z");
    await runOutbox(lenv({ LEGAL_KEEP_DAYS: "bad" }));
    await sendLegal(key, {}, lenv({ LEGAL_KEEP_DAYS: "bad" }));
    expect(lines.length).toBeGreaterThanOrEqual(4);
    for (const text of [...lines, ...logs]) for (const secret of [ADDRESS, REFERENCE, SUBJECT, VERSION, "buyer"]) expect(text).not.toContain(secret);
  });
});

// ---------------------------------------------------------------------------------------------
describe("task 7: the route answers before the first attempt", () => {
  it("202 queued while the vendor is still answering; the attempt finishes after", async () => {
    const key = await legalApp();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    replies.push(async () => {
      await gate;
      return new Response(JSON.stringify({ request_id: "req-slow" }), { status: 200 });
    });
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request("https://api.example.invalid/v1/mail", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify(legalBody()) }),
      lenv(),
      ctx,
    );
    expect(res.status).toBe(202);
    const id = await idOf(res);
    expect((await copy(id))!.sent_at).toBeNull();
    release();
    await waitOnExecutionContext(ctx);
    expect((await copy(id))!.vendor_request_id).toBe("req-slow");
  });

  it("the timer sends a legal document whose first attempt never ran", async () => {
    await legalApp();
    const now = nowIso();
    const m = validateMail(legalBody(), now);
    const { id } = await insertLegal(env.DB, "shop", m, await addrHash(MAIL.MAIL_HASH_SECRET, "shop", ADDRESS), false, now);
    const run = await runOutbox(lenv(), addMinutes(now, 1));
    expect(run).toMatchObject({ attempted: 1, sent: 1 });
    expect((await copy(id))!.sent_at).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
describe("task 8: deletion and keeping", () => {
  const USER = "user-0123456789abcdef";
  it("deleting a person keeps their copies and a still-queued legal mail, without the user_ref", async () => {
    const key = await legalApp();
    const sent = await idOf(await sendLegal(key));
    replies.push(down);
    const queued = await idOf(await sendLegal(key));
    const receipt = await idOf(await call("/v1/mail", key, { ...legalBody({ kind: "transactional", label: "receipt" }), document: undefined }));
    const r = await deleteUser(lenv(), "shop", USER);
    expect(r).toEqual({ deleted_messages: 0, kept_legal_copies: 2 });
    expect(await mailRow(receipt)).toBeNull();
    expect(await mailRow(sent)).toBeNull();
    expect(await mailRow(queued)).toMatchObject({ status: "queued", user_ref: null, to_addr: ADDRESS });
    expect((await copy(sent))!.user_ref).toBeNull();
    expect((await copy(queued))!.user_ref).toBeNull();
    // The queued one is still sent.
    expect((await runOutbox(lenv(), addMinutes(nowIso(), 6))).sent).toBe(1);
  });

  it("the public deletion answers carry the kept count: by user_ref and by address", async () => {
    const key = await legalApp();
    const appKey = await rotateKey(env.DB, "shop");
    await sendLegal(key);
    const ctx = createExecutionContext();
    const del = await worker.fetch(new Request(`https://api.example.invalid/v1/messages?user_ref=${USER}`, { method: "DELETE", headers: { authorization: `Bearer ${appKey}` } }), lenv(), ctx);
    await waitOnExecutionContext(ctx);
    expect(await del.json()).toEqual({ deleted_messages: 0, kept_legal_copies: 1 });
    await sendLegal(key);
    const byAddr = await call("/v1/mail/delete", key, { address: ADDRESS });
    expect(await byAddr.json()).toEqual({ deleted_mails: 1, kept_legal_copies: 2 });
    expect((await env.DB.prepare("SELECT COUNT(*) n FROM legal_documents WHERE user_ref IS NULL").first<{ n: number }>())!.n).toBe(2);
  });

  it("deleting by address keeps a still-queued legal mail, which is still sent", async () => {
    const key = await legalApp();
    replies.push(down);
    const queued = await idOf(await sendLegal(key));
    const receipt = await idOf(await call("/v1/mail", key, { ...legalBody({ kind: "transactional", label: "receipt" }), document: undefined }));
    expect(await (await call("/v1/mail/delete", key, { address: ADDRESS })).json()).toEqual({ deleted_mails: 1, kept_legal_copies: 1 });
    expect(await mailRow(receipt)).toBeNull();
    expect(await mailRow(queued)).toMatchObject({ status: "queued", user_ref: null });
    expect((await runOutbox(lenv(), addMinutes(nowIso(), 6))).sent).toBe(1);
  });

  it("the admin JSON API's deletion answers the kept count", async () => {
    const key = await legalApp();
    await sendLegal(key);
    const { token } = await createAdminToken(env.DB, "t");
    const res = await adminRequest({ ...env, SESSION_SECRET: "s3" } as typeof env, `/api/users?app=shop&user_ref=${USER}`, { method: "DELETE", headers: { authorization: `Bearer ${token}` } });
    expect(await res.json()).toEqual({ deleted_messages: 0, kept_legal_copies: 1 });
  });

  it("the subscription's end sets only empty keeping starts, of that app and reference", async () => {
    const key = await legalApp();
    const other = await legalApp("other");
    const sub = { document: { version: VERSION, reference: REFERENCE, sale: "subscription" } };
    const a = await idOf(await sendLegal(key, sub));
    const b = await idOf(await sendLegal(key, sub)); // a renewal
    const c = await idOf(await sendLegal(other, sub));
    const ended = nowIso();
    const r = await call("/v1/mail/legal/end", key, { reference: REFERENCE, ended_at: ended });
    expect(await r.json()).toEqual({ updated: 2 });
    expect((await copy(a))!.keep_from).toBe(ended);
    expect((await copy(b))!.keep_from).toBe(ended);
    expect((await copy(c))!.keep_from).toBeNull();
    expect(await (await call("/v1/mail/legal/end", key, { reference: REFERENCE, ended_at: nowIso() })).json()).toEqual({ updated: 0 });
    expect((await copy(a))!.keep_from).toBe(ended);
  });

  it("the end call refuses a time before the newest document, and never touches a one-off sale", async () => {
    const key = await legalApp();
    const sub = await idOf(await sendLegal(key, { document: { version: VERSION, reference: REFERENCE, sale: "subscription" } }));
    const oneOff = await idOf(await sendLegal(key));
    const oneOffStart = (await copy(oneOff))!.keep_from;
    const early = await call("/v1/mail/legal/end", key, { reference: REFERENCE, ended_at: "2020-01-01T00:00:00Z" });
    expect(early.status).toBe(400);
    expect(await early.json()).toMatchObject({ error: "invalid_request", field: "ended_at" });
    expect((await copy(sub))!.keep_from).toBeNull();
    expect(await (await call("/v1/mail/legal/end", key, { reference: REFERENCE, ended_at: nowIso() })).json()).toEqual({ updated: 1 });
    expect((await copy(oneOff))!.keep_from).toBe(oneOffStart);
  });

  it("the end call refuses a future time, a bad reference, a browser and a missing key", async () => {
    const key = await legalApp();
    for (const body of [{ reference: REFERENCE, ended_at: addMinutes(nowIso(), 60) }, { reference: "a b", ended_at: nowIso() }, { reference: REFERENCE, ended_at: "yesterday" }]) {
      expect((await call("/v1/mail/legal/end", key, body)).status).toBe(400);
    }
    expect((await call("/v1/mail/legal/end", key, { reference: REFERENCE, ended_at: nowIso() }, lenv(), { origin: "https://shop.example.org" })).status).toBe(403);
    expect((await call("/v1/mail/legal/end", null, { reference: REFERENCE, ended_at: nowIso() })).status).toBe(401);
  });

  it("the hourly job deletes copies by the setting at run time, with their alerts; a copy with no end is kept", async () => {
    const key = await legalApp();
    replies.push(refusedAddress);
    const oneOff = await idOf(await sendLegal(key));
    const noEnd = await idOf(await sendLegal(key, { document: { version: VERSION, reference: "SUB-1", sale: "subscription" } }));
    expect(await alerts(oneOff)).toHaveLength(1);
    const in1100Days = addMinutes(nowIso(), 1100 * 24 * 60);
    expect((await runScheduled(lenv({ LEGAL_KEEP_DAYS: "3650" }), in1100Days)).purged_legal_copies).toBe(0);
    expect(await copy(oneOff)).not.toBeNull();
    expect((await runScheduled(lenv({ LEGAL_KEEP_DAYS: undefined }), in1100Days)).purged_legal_copies).toBe(0);
    expect((await runScheduled(lenv({ LEGAL_KEEP_DAYS: "bad" }), in1100Days)).purged_legal_copies).toBe(0);
    expect((await runScheduled(lenv(), in1100Days)).purged_legal_copies).toBe(1);
    expect(await copy(oneOff)).toBeNull();
    expect(await alerts(oneOff)).toEqual([]); // the open alert went with it
    expect((await runScheduled(lenv(), addMinutes(nowIso(), 20 * 365 * 24 * 60))).purged_legal_copies).toBe(0);
    expect(await copy(noEnd)).not.toBeNull();
  });

  it("purging more copies than one statement may bind goes in slices", async () => {
    await env.DB.prepare(
      `WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM k WHERE i<230)
       INSERT INTO legal_documents (mail_id,app,reference,version,idempotency_key,label,locale,to_addr,subject,text_body,text_sha256,addr_hash,created_at,keep_from)
       SELECT printf('c-%04d',i),'shop','R','v',printf('k-%04d',i),'l','en','a@example.org','s','t','h','h','2020-01-01T00:00:00.000Z','2020-01-01T00:00:00.000Z' FROM k`,
    ).run();
    const { withD1ParamLimit } = await import("./helpers");
    expect((await runScheduled({ ...lenv(), DB: withD1ParamLimit(env.DB) })).purged_legal_copies).toBe(230);
  });

  it("retention_days never touches a copy", async () => {
    const key = await legalApp();
    await updateApp(env.DB, "shop", { retention_days: 1 });
    const id = await idOf(await sendLegal(key));
    expect(await expireMails(env.DB, addMinutes(nowIso(), 3 * 24 * 60))).toBe(1);
    expect(await mailRow(id)).toBeNull();
    expect(await copy(id)).not.toBeNull();
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
    const [, subjectLine] = text.match(/^Subject: (.*)$/m)!;
    const body = text.slice(text.indexOf("\n\n") + 2);
    expect(body).toBe(TEXT);
    expect(await sha256Hex(hashedText(subjectLine!, body))).toBe((await copy(id))!.text_sha256);
    expect((await get("/legal/nope/copy")).status).toBe(404);
  });

  it("copies waiting over 400 days for their end are counted for the operator", async () => {
    await env.DB.prepare("INSERT INTO legal_documents (mail_id,app,reference,version,idempotency_key,label,locale,to_addr,subject,text_body,text_sha256,addr_hash,created_at) VALUES ('old','shop','S','v','k','l','en','a@example.org','s','t','h','h','2020-01-01T00:00:00.000Z')").run();
    expect(await (await get("/legal")).text()).toContain("1 subscription copy has waited over 400 days");
  });

  it("the legal tick is refused until the timer found the keeping period set, and is kept on save", async () => {
    await legalApp();
    await createApp(env.DB, "plain");
    const fields = { retention_days: "90", mail_from_name: "Plain", mail_labels: "receipt", allowed_origins: "" };
    const refused = await post("/apps/plain", { ...fields, mail_transactional: "on", mail_legal: "on" });
    expect(refused.status).toBe(400);
    expect(await refused.text()).toMatch(/LEGAL_KEEP_DAYS/);
    await runOutbox(lenv());
    expect((await post("/apps/plain", { ...fields, mail_transactional: "on", mail_legal: "on" })).status).toBe(303);
    const kinds = async (id: string) => JSON.parse((await env.DB.prepare("SELECT mail_kinds FROM apps WHERE id=?").bind(id).first<{ mail_kinds: string }>())!.mail_kinds);
    expect(await kinds("plain")).toEqual(["transactional", "legal_document"]);
    // An app that already sends legal documents keeps the tick on any later save, even with the setting gone.
    await runOutbox(lenv({ LEGAL_KEEP_DAYS: undefined }));
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

