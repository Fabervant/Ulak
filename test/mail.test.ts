import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import worker from "../src/api/index";
import { OUTBOX_CRON } from "../src/api/index";
import { createApp, updateApp, rotateSendKey, rotateKey } from "../src/core/apps";
import { vendorTransport } from "../src/core/mail/vendor";
import { addrHash } from "../src/core/mail/hash";
import { runOutbox } from "../src/core/mail/job";
import { claimMail, insertMail } from "../src/core/mail/outbox";
import { validateMail } from "../src/core/mail/validate";
import { tellFailures } from "../src/core/mail/job";
import { runScheduled } from "../src/core/retention";
import { runChecks } from "../src/core/checks";
import { deleteUser } from "../src/core/messages";
import type { Env } from "../src/core/env";
import { addMinutes, nowIso } from "../src/core/time";
import { vendorSigned } from "./helpers";

const MAIL = { MAIL_API_URL: "https://mail.example.invalid/v1.1/email", MAIL_FROM_DOMAIN: "example.invalid", MAIL_API_KEY: "vendor-key", MAIL_WEBHOOK_KEY: "hook-key", MAIL_HASH_SECRET: "hash-secret", MAIL_SENDER_INFO: "Example Ltd, 1 Main St, Town; +1 555 0100; abuse@example.invalid" };
const menv = (over: Partial<Env> = {}) => ({ ...env, ...MAIL, ...over }) as Env;

/** The vendor double: records each call and answers with the next scripted reply (default 200). */
let calls: Array<{ url: string; auth: string | null; body: any }> = [];
let replies: Array<() => Response | Promise<Response>> = [];
const original = vendorTransport.fetch;
beforeEach(() => {
  calls = [];
  replies = [];
  vendorTransport.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, auth: new Headers(init.headers).get("authorization"), body: JSON.parse(String(init.body)) });
    const next = replies.shift();
    return next ? next() : new Response(JSON.stringify({ request_id: `req-${calls.length}`, message: "OK" }), { status: 200 });
  }) as typeof fetch;
});
afterEach(() => {
  vendorTransport.fetch = original;
});
const down = () => new Response("bad gateway", { status: 502 });

async function mailApp(id = "demo"): Promise<string> {
  await createApp(env.DB, id);
  await updateApp(env.DB, id, { mail_from_name: "Demo App", mail_kinds: ["transactional"], mail_labels: ["password_reset", "confirm_email"] });
  return rotateSendKey(env.DB, id);
}

const inAnHour = () => addMinutes(nowIso(), 60);
const mailBody = (over: Record<string, unknown> = {}) => ({
  to: "person@example.org",
  locale: "en",
  kind: "transactional",
  label: "password_reset",
  subject: "Reset your password",
  text: "Open https://app.example.org/reset?t=secret-token to reset.",
  expires_at: inAnHour(),
  idempotency_key: crypto.randomUUID(),
  ...over,
});

async function call(path: string, key: string | null, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}, e: Env = menv()) {
  const headers: Record<string, string> = { "content-type": "application/json", ...init.headers };
  if (key) headers.authorization = `Bearer ${key}`;
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`https://api.example.invalid${path}`, { method: init.method ?? "POST", headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) }), e, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}
const send = (key: string, over: Record<string, unknown> = {}, e?: Env) => call("/v1/mail", key, { body: mailBody(over) }, e);
const row = (id: string) => env.DB.prepare("SELECT * FROM mails WHERE id=?").bind(id).first<any>();

describe("POST /v1/mail", () => {
  it("sends at once, answers sent, and keeps no body or address after the vendor accepts", async () => {
    const key = await mailApp();
    const res = await send(key);
    expect(res.status).toBe(202);
    const { id, status } = await res.json<{ id: string; status: string }>();
    expect(status).toBe("sent");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(MAIL.MAIL_API_URL);
    expect(calls[0]!.auth).toBe("Zoho-enczapikey vendor-key");
    expect(calls[0]!.body).toMatchObject({ from: { address: "demo@example.invalid", name: "Demo App" }, to: [{ email_address: { address: "person@example.org" } }], track_clicks: false, track_opens: false, client_reference: id });
    const r = await row(id);
    expect(r).toMatchObject({ status: "sent", attempts: 1, vendor_request_id: "req-1", to_addr: null, subject: null, text_body: null, html_body: null });
    expect(r.addr_hash).toBe(await addrHash(MAIL.MAIL_HASH_SECRET, "demo", "person@example.org"));
  });

  it("passes the optional html part through untouched, closed by the sender block in both parts", async () => {
    const key = await mailApp();
    const html = '<p><a href="https://app.example.org/reset?t=secret-token" style="padding:8px">Reset</a></p>';
    expect((await send(key, { html })).status).toBe(202);
    expect(calls[0]!.body.htmlbody).toBe(`${html}<hr><p style="font-size:12px;color:#666">${MAIL.MAIL_SENDER_INFO}</p>`);
    expect(calls[0]!.body.textbody).toBe(`${mailBody().text}\n\n-- \n${MAIL.MAIL_SENDER_INFO}`);
  });

  it("queues when the vendor is down, keeping the content for the retry", async () => {
    const key = await mailApp();
    replies.push(down);
    const { id, status } = await (await send(key)).json<{ id: string; status: string }>();
    expect(status).toBe("queued");
    const r = await row(id);
    expect(r).toMatchObject({ status: "queued", attempts: 1, to_addr: "person@example.org" });
    expect(Date.parse(r.next_attempt_at) - Date.now()).toBeGreaterThan(4 * 60_000);
  });

  it("the same idempotency key returns the first result and sends nothing again", async () => {
    const key = await mailApp();
    const body = mailBody();
    const first = await (await call("/v1/mail", key, { body })).json<{ id: string }>();
    const again = await call("/v1/mail", key, { body: { ...body, subject: "changed" } });
    expect(again.status).toBe(202);
    expect(await again.json()).toEqual({ id: first.id, status: "sent" });
    expect(calls).toHaveLength(1);
  });

  it("refuses a browser request before reading the key", async () => {
    const key = await mailApp();
    const res = await call("/v1/mail", key, { body: mailBody(), headers: { origin: "https://app.example.org" } });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "server_only", retryable: false });
  });

  it("the app key and the notice key cannot send", async () => {
    await mailApp();
    const appKey = await rotateKey(env.DB, "demo");
    expect((await send(appKey)).status).toBe(401);
    expect((await send("ulak_send_demo_" + "0".repeat(48))).status).toBe(401);
  });

  it("is 503 mail_unconfigured with no settings and 500 when half set, and calls no vendor", async () => {
    const key = await mailApp();
    const none = await send(key, {}, env as Env);
    expect(none.status).toBe(503);
    expect(await none.json()).toMatchObject({ error: "mail_unconfigured", retryable: false });
    const half = await send(key, {}, menv({ MAIL_WEBHOOK_KEY: undefined }));
    expect(half.status).toBe(500);
    expect(await half.json()).toMatchObject({ error: "mail_config_half_set" });
    expect(calls).toHaveLength(0);
  });

  it("answers 422 with the reason for the app's own mistakes", async () => {
    const key = await mailApp();
    for (const [over, code] of [[{ label: "welcome" }, "unknown_label"], [{ text: "<p>x</p>" }, "not_plain_text"], [{ text: "http://x.example.org" }, "bad_link"], [{ html: "<img src='https://t.example.org/p.gif'>" }, "bad_html"], [{ kind: "legal_document", document: { version: "v1", reference: "o-1", sale: "one_off" } }, "kind_not_allowed"]] as const) {
      const res = await send(key, over);
      expect(res.status).toBe(422);
      expect(await res.json()).toMatchObject({ error: code, retryable: false });
    }
    expect(calls).toHaveLength(0);
  });

  it("caps an address at 10 mails an hour per app with an exact Retry-After; another app is not counted", async () => {
    const key = await mailApp();
    for (let i = 0; i < 10; i++) expect((await send(key)).status).toBe(202);
    const over = await send(key);
    expect(over.status).toBe(429);
    const wait = Number(over.headers.get("retry-after"));
    expect(wait).toBeGreaterThan(3500);
    expect(wait).toBeLessThanOrEqual(3600);
    const other = await mailApp("other");
    expect((await send(other)).status).toBe(202);
  });

  it("the ceiling holds under parallel calls", async () => {
    const key = await mailApp();
    const codes = await Promise.all(Array.from({ length: 14 }, () => send(key).then((r) => r.status)));
    expect(codes.filter((c) => c === 202)).toHaveLength(10);
    expect(codes.filter((c) => c === 429)).toHaveLength(4);
  });

  it("an address the vendor refuses is 422 suppressed, its content deleted", async () => {
    const key = await mailApp();
    replies.push(() => new Response('{"error":{"code":"TM_4001","details":[{"code":"SM_113","target":"to"}]}}', { status: 400 }));
    const res = await send(key);
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: "suppressed" });
    const r = await env.DB.prepare("SELECT * FROM mails").first<any>();
    expect(r).toMatchObject({ status: "refused", to_addr: null, text_body: null });
  });

  it("refuses a body over 512 KiB", async () => {
    const key = await mailApp();
    expect((await send(key, { html: "<p>" + "x".repeat(600_000) + "</p>" })).status).toBe(413);
  });
});

describe("the outbox timer", () => {
  it("retries a queued mail when it is due, and not before", async () => {
    const key = await mailApp();
    replies.push(down);
    const { id } = await (await send(key)).json<{ id: string }>();
    expect((await runOutbox(menv(), nowIso())) as any).toMatchObject({ attempted: 0 });
    const later = addMinutes(nowIso(), 6);
    expect((await runOutbox(menv(), later)) as any).toMatchObject({ attempted: 1, sent: 1 });
    expect(await row(id)).toMatchObject({ status: "sent", attempts: 2, to_addr: null });
    expect(calls).toHaveLength(2);
  });

  it("gives up at expires_at, deletes the content, and tells the operator once", async () => {
    const key = await mailApp();
    replies.push(down);
    const { id } = await (await send(key, { expires_at: addMinutes(nowIso(), 10) })).json<{ id: string }>();
    const lines: string[] = [];
    const tg = menv({ NOTIFIER: "telegram", TELEGRAM_BOT_TOKEN: "t", TELEGRAM_CHAT_ID: "c" });
    const { TelegramNotifier } = await import("../src/core/notify/telegram");
    const sendLine = TelegramNotifier.prototype.send;
    TelegramNotifier.prototype.send = async function (n) {
      lines.push(n.text);
    };
    try {
      const after = addMinutes(nowIso(), 11);
      expect((await runOutbox(tg, after)) as any).toMatchObject({ given_up: 1, attempted: 0, told: 1 });
      expect((await runOutbox(tg, addMinutes(after, 5))) as any).toMatchObject({ given_up: 0, told: 0 });
    } finally {
      TelegramNotifier.prototype.send = sendLine;
    }
    expect(await row(id)).toMatchObject({ status: "given_up", to_addr: null, subject: null, text_body: null });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[demo\] mail password_reset given up/);
    expect(lines[0]).not.toMatch(/person@|secret-token|Reset your/);
  });

  it("never sends a mail the request is still holding", async () => {
    const key = await mailApp();
    replies.push(down);
    const { id } = await (await send(key)).json<{ id: string }>();
    await env.DB.prepare("UPDATE mails SET next_attempt_at=?, lease_until=? WHERE id=?").bind(nowIso(), addMinutes(nowIso(), 2), id).run();
    expect((await runOutbox(menv(), addMinutes(nowIso(), 1))) as any).toMatchObject({ attempted: 0 });
  });

  it("only one caller can hold a mail at a time, until the lease runs out", async () => {
    const key = await mailApp();
    replies.push(down);
    const { id } = await (await send(key)).json<{ id: string }>();
    const now = nowIso();
    expect(await claimMail(env.DB, id, now)).toBeTruthy();
    expect(await claimMail(env.DB, id, addMinutes(now, 1))).toBeNull();
    expect(await claimMail(env.DB, id, addMinutes(now, 3))).toBeTruthy();
    // Never once its expiry has passed, lease or not.
    expect(await claimMail(env.DB, id, addMinutes(now, 61))).toBeNull();
  });

  it("runs on the 5-minute schedule; the hourly schedule does not send", async () => {
    const key = await mailApp();
    replies.push(down);
    const { id } = await (await send(key)).json<{ id: string }>();
    await env.DB.prepare("UPDATE mails SET next_attempt_at=? WHERE id=?").bind(addMinutes(nowIso(), -1), id).run();
    const run = async (cron: string) => {
      const ctx = createExecutionContext();
      await worker.scheduled({ cron, scheduledTime: Date.now(), type: "scheduled", noRetry() {} } as unknown as ScheduledEvent, menv(), ctx);
      await waitOnExecutionContext(ctx);
    };
    await run("17 * * * *");
    expect(calls).toHaveLength(1);
    await run(OUTBOX_CRON);
    expect(calls).toHaveLength(2);
    expect((await row(id)).status).toBe("sent");
  });

  it("records a half-set configuration for the health check, which turns red", async () => {
    await runOutbox(menv({ MAIL_API_KEY: undefined }), nowIso());
    const c = await runChecks(env.DB);
    expect(c.mail_config_half_set).toBe(1);
    expect(c.ok).toBe(false);
    await runOutbox(menv(), nowIso());
    expect((await runChecks(env.DB)).ok).toBe(true);
  });

  it("the health check turns red on a queued mail long past its expiry", async () => {
    const key = await mailApp();
    replies.push(down);
    const { id } = await (await send(key)).json<{ id: string }>();
    await env.DB.prepare("UPDATE mails SET expires_at=? WHERE id=?").bind(addMinutes(nowIso(), -20), id).run();
    expect(await runChecks(env.DB)).toMatchObject({ ok: false, mails_stuck: 1 });
  });
});

describe("GET /v1/mail/status", () => {
  it("is ok, turns down after three vendor failures in ten minutes, and ok again after a success", async () => {
    const key = await mailApp();
    const status = async () => (await (await call("/v1/mail/status", key, { method: "GET" })).json<{ sending: string }>()).sending;
    expect(await status()).toBe("ok");
    replies.push(down, down, down);
    for (let i = 0; i < 3; i++) await send(key, { to: `p${i}@example.org` });
    expect(await status()).toBe("down");
    await send(key, { to: "q@example.org" });
    expect(await status()).toBe("ok");
  });
  it("is never flipped by refused addresses or app mistakes", async () => {
    const key = await mailApp();
    for (let i = 0; i < 4; i++) replies.push(() => new Response('{"error":{"code":"TM_4001","details":[{"code":"SM_113","target":"to"}]}}', { status: 400 }));
    for (let i = 0; i < 4; i++) await send(key, { to: `p${i}@example.org` });
    for (let i = 0; i < 4; i++) await send(key, { label: "nope" });
    expect((await (await call("/v1/mail/status", key, { method: "GET" })).json<{ sending: string }>()).sending).toBe("ok");
  });
  it("refuses a browser", async () => {
    const key = await mailApp();
    expect((await call("/v1/mail/status", key, { method: "GET", headers: { origin: "https://app.example.org" } })).status).toBe(403);
  });
});

describe("the vendor's events", () => {
  async function event(mailId: string, object: string, opts: { key?: string; ts?: number } = {}) {
    const json = JSON.stringify({
      event_name: object,
      event_message: [{ email_info: { client_reference: mailId, to: [{ email_address: { address: "person@example.org" } }], subject: "Reset your password" }, event_data: [{ object, details: [{ reason: "Mailbox not found", diagnostic_message: "550 5.1.1 person@example.org unknown" }] }], request_id: "req-x" }],
      webhook_request_id: "wh-1",
    });
    const { body, header } = await vendorSigned(json, opts.key ?? MAIL.MAIL_WEBHOOK_KEY, opts.ts ?? Date.now());
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request("https://api.example.invalid/v1/mail/events", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "producer-signature": header }, body }), menv(), ctx);
    await waitOnExecutionContext(ctx);
    return res;
  }

  it("a delivered event is stored", async () => {
    const key = await mailApp();
    const { id } = await (await send(key)).json<{ id: string }>();
    expect((await event(id, "email_delivered")).status).toBe(200);
    expect(await row(id)).toMatchObject({ status: "delivered" });
    expect((await row(id)).delivered_at).not.toBeNull();
  });

  it("a hard bounce marks the mail and suppresses the address in this app only", async () => {
    const key = await mailApp();
    const other = await mailApp("other");
    const { id } = await (await send(key)).json<{ id: string }>();
    expect(await (await event(id, "hardbounce")).json()).toEqual({ applied: 1 });
    const r = await row(id);
    expect(r.status).toBe("bounced");
    expect(r.last_error).toMatch(/^hard bounce: Mailbox not found/);
    expect(r.last_error).not.toContain("person@example.org");
    const again = await send(key);
    expect(again.status).toBe(422);
    expect(await again.json()).toMatchObject({ error: "suppressed" });
    expect((await send(key, { to: "Someone.Else@example.org" })).status).toBe(202);
    expect((await send(other)).status).toBe(202);
  });

  it("a spam complaint suppresses the address too", async () => {
    const key = await mailApp();
    const { id } = await (await send(key)).json<{ id: string }>();
    await event(id, "fbl_complaint");
    expect((await row(id)).status).toBe("complained");
    expect((await send(key)).status).toBe(422);
  });

  it("a soft bounce is noted without suppressing", async () => {
    const key = await mailApp();
    const { id } = await (await send(key)).json<{ id: string }>();
    await event(id, "softbounce");
    expect(await row(id)).toMatchObject({ status: "sent" });
    expect((await send(key)).status).toBe(202);
  });

  it("an event for a mail Ulak still holds as queued stops its retry", async () => {
    const key = await mailApp();
    replies.push(down);
    const { id } = await (await send(key)).json<{ id: string }>();
    await event(id, "email_delivered");
    expect(await row(id)).toMatchObject({ status: "delivered", to_addr: null, next_attempt_at: null });
  });

  it("refuses a forged or stale event and changes nothing", async () => {
    const key = await mailApp();
    const { id } = await (await send(key)).json<{ id: string }>();
    expect((await event(id, "hardbounce", { key: "wrong" })).status).toBe(401);
    expect((await event(id, "hardbounce", { ts: Date.now() - 10 * 60_000 })).status).toBe(401);
    expect((await row(id)).status).toBe("sent");
  });

  it("an unknown or deleted mail is answered 200", async () => {
    await mailApp();
    expect(await (await event("no-such-mail", "hardbounce")).json()).toEqual({ applied: 0 });
  });
});

describe("deletion", () => {
  it("by address deletes that app's mails to it, and no other app's", async () => {
    const key = await mailApp();
    const other = await mailApp("other");
    await send(key);
    await send(key, { to: "PERSON@example.org " });
    await send(key, { to: "someone@example.org" });
    await send(other);
    const res = await call("/v1/mail/delete", key, { body: { address: "person@example.org" } });
    expect(await res.json()).toEqual({ deleted_mails: 2, kept_legal_copies: 0 });
    const left = (await env.DB.prepare("SELECT app FROM mails ORDER BY app").all<{ app: string }>()).results.map((r) => r.app);
    expect(left).toEqual(["demo", "other"]);
  });

  it("deleting a user_ref deletes its mails too", async () => {
    const key = await mailApp();
    const user_ref = "u".repeat(20);
    await send(key, { user_ref });
    await send(key, { to: "x@example.org" });
    await deleteUser(env as Env, "demo", user_ref);
    expect((await env.DB.prepare("SELECT COUNT(*) n FROM mails").first<{ n: number }>())!.n).toBe(1);
  });

  it("the hourly job deletes mail rows past the app's retention", async () => {
    const key = await mailApp();
    await send(key);
    await updateApp(env.DB, "demo", { retention_days: 1 });
    const r = await runScheduled(env as Env, addMinutes(nowIso(), 2 * 24 * 60));
    expect(r.expired_mails).toBe(1);
  });
});

describe("review findings of the first build", () => {
  const telegram = () => menv({ NOTIFIER: "telegram", TELEGRAM_BOT_TOKEN: "t", TELEGRAM_CHAT_ID: "c" });
  async function withLines<T>(fn: (lines: string[]) => Promise<T>): Promise<T> {
    const { TelegramNotifier } = await import("../src/core/notify/telegram");
    const real = TelegramNotifier.prototype.send;
    const lines: string[] = [];
    TelegramNotifier.prototype.send = async function (n) {
      await Promise.resolve();
      lines.push(n.text);
    };
    try {
      return await fn(lines);
    } finally {
      TelegramNotifier.prototype.send = real;
    }
  }

  it("an expired mail's address and content are deleted even while the mail settings are missing", async () => {
    const key = await mailApp();
    replies.push(down);
    const { id } = await (await send(key, { expires_at: addMinutes(nowIso(), 10) })).json<{ id: string }>();
    const r = await runOutbox(menv({ MAIL_API_KEY: undefined }), addMinutes(nowIso(), 11));
    expect(r).toMatchObject({ given_up: 1, skipped: "mail configuration half set" });
    expect(await row(id)).toMatchObject({ status: "given_up", to_addr: null, subject: null, text_body: null });
  });

  it("a mail the vendor calls malformed is answered 500 mail_failed, never 202, and so is its repeat", async () => {
    const key = await mailApp();
    replies.push(() => new Response('{"error":{"code":"TM_3301"}}', { status: 400 }));
    const body = mailBody();
    const first = await call("/v1/mail", key, { body });
    expect(first.status).toBe(500);
    expect(await first.json()).toMatchObject({ error: "mail_failed", retryable: false });
    const again = await call("/v1/mail", key, { body });
    expect(again.status).toBe(500);
    expect(calls).toHaveLength(1);
  });

  it("a repeat of a refused mail is 422 suppressed again, and of a given-up mail 410 mail_expired", async () => {
    const key = await mailApp();
    replies.push(() => new Response('{"error":{"code":"TM_4001","details":[{"code":"SM_113","target":"to"}]}}', { status: 400 }), down);
    const refusedBody = mailBody();
    expect((await call("/v1/mail", key, { body: refusedBody })).status).toBe(422);
    const again = await call("/v1/mail", key, { body: refusedBody });
    expect(again.status).toBe(422);
    expect(await again.json()).toMatchObject({ error: "suppressed" });
    const lateBody = mailBody({ to: "late@example.org", expires_at: addMinutes(nowIso(), 10) });
    expect(await (await call("/v1/mail", key, { body: lateBody })).json()).toMatchObject({ status: "queued" });
    await runOutbox(menv(), addMinutes(nowIso(), 11));
    const late = await call("/v1/mail", key, { body: lateBody });
    expect(late.status).toBe(410);
    expect(await late.json()).toMatchObject({ error: "mail_expired" });
  });

  it("a bounce recorded while the vendor call is in flight is not overwritten by its answer", async () => {
    const key = await mailApp();
    replies.push(async () => {
      // The vendor's bounce report lands before Ulak records the vendor's answer.
      await env.DB.prepare("UPDATE mails SET status='bounced', lease_until=NULL, to_addr=NULL, subject=NULL, text_body=NULL, html_body=NULL").run();
      return new Response('{"request_id":"req-1"}', { status: 200 });
    });
    const res = await send(key);
    expect(await res.json()).toMatchObject({ status: "sent" });
    expect((await env.DB.prepare("SELECT status FROM mails").first<{ status: string }>())!.status).toBe("bounced");
    expect((await send(key)).status).toBe(422);
  });

  it("an attempt that lost its lease does not record over the new holder", async () => {
    const key = await mailApp();
    replies.push(async () => {
      // Another caller takes the mail meanwhile (as after an expired lease).
      await env.DB.prepare("UPDATE mails SET lease_until=?").bind(addMinutes(nowIso(), 30)).run();
      return down();
    });
    const { id } = await (await send(key)).json<{ id: string }>();
    expect(await row(id)).toMatchObject({ status: "queued", attempts: 0 });
  });

  it("at the ceiling, a repeat of a key that raced in gets that mail, not 429", async () => {
    const key = await mailApp();
    const now = nowIso();
    for (let i = 0; i < 10; i++) expect((await send(key)).status).toBe(202);
    const taken = (await env.DB.prepare("SELECT idempotency_key k, id FROM mails LIMIT 1").first<{ k: string; id: string }>())!;
    const hash = await addrHash(MAIL.MAIL_HASH_SECRET, "demo", "person@example.org");
    const r = await insertMail(env.DB, "demo", validateMail(mailBody({ idempotency_key: taken.k }), now), hash, now);
    expect(r).toMatchObject({ created: false, row: { id: taken.id } });
  });

  it("the operator line is sent once even when a request and the timer tell at the same time", async () => {
    const key = await mailApp();
    replies.push(() => new Response('{"error":{"code":"TM_3301"}}', { status: 400 }));
    await send(key, {}, menv());
    const lines = await withLines(async (lines) => {
      await Promise.all([tellFailures(telegram()), tellFailures(telegram()), tellFailures(telegram())]);
      return lines;
    });
    expect(lines).toHaveLength(1);
  });

  it("a webhook body over the cap is refused before it is read whole", async () => {
    await mailApp();
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request("https://api.example.invalid/v1/mail/events", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "data=" + "x".repeat(600_000) }), menv(), ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(413);
  });

  it("a vendor error that echoes the mail's values stores none of them", async () => {
    const key = await mailApp();
    replies.push(() => new Response('{"error":{"code":"TM_8001","details":[{"code":"SM_129","target":"subject","target_value":"Reset with https://app.example.org/reset?t=secret-token"}]}}', { status: 400 }));
    await send(key);
    const r = (await env.DB.prepare("SELECT last_error FROM mails").first<{ last_error: string }>())!;
    expect(r.last_error).toBe("HTTP 400 TM_8001 SM_129 (field subject)");
  });
});
