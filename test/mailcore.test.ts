import { describe, it, expect } from "vitest";
import { mailConfig, MailConfigError, MAIL_SETTINGS } from "../src/core/mail/config";
import { addrHash, scrubAddresses } from "../src/core/mail/hash";
import { validateMail, mailMistake } from "../src/core/mail/validate";
import { classify, vendorBody, sendViaVendor, withSenderInfo } from "../src/core/mail/vendor";
import { signedPayload, verifySignature, parseEvents } from "../src/core/mail/webhook";
import { backoffMinutes } from "../src/core/mail/outbox";
import type { Env } from "../src/core/env";
import type { AppRow } from "../src/core/apps";
import { vendorSigned } from "./helpers";

const FULL = { MAIL_API_URL: "https://mail.example.invalid/v1.1/email", MAIL_FROM_DOMAIN: "example.invalid", MAIL_API_KEY: "k", MAIL_WEBHOOK_KEY: "w", MAIL_HASH_SECRET: "h", MAIL_SENDER_INFO: "Example Ltd" };
const asEnv = (o: Record<string, string>) => o as unknown as Env;

describe("mail configuration is all or nothing", () => {
  it("none set is unconfigured", () => expect(mailConfig(asEnv({}))).toBeNull());
  it("all set gives the values", () => expect(mailConfig(asEnv(FULL))?.fromDomain).toBe("example.invalid"));
  for (const name of MAIL_SETTINGS) {
    it(`all but ${name} throws, naming it`, () => {
      const { [name]: _gone, ...rest } = FULL;
      expect(() => mailConfig(asEnv(rest))).toThrow(MailConfigError);
      expect(() => mailConfig(asEnv(rest))).toThrow(name);
    });
  }
  it("the sender block is one of the settings: no mail goes without it", () => {
    expect(MAIL_SETTINGS).toContain("MAIL_SENDER_INFO");
    expect(mailConfig(asEnv({ ...FULL, MAIL_SENDER_INFO: " Example Ltd \n" }))?.senderInfo).toBe("Example Ltd");
  });
  it("a blank value counts as missing", () => expect(() => mailConfig(asEnv({ ...FULL, MAIL_API_KEY: "  " }))).toThrow(/MAIL_API_KEY/));
});

describe("per-app address hash", () => {
  it("is stable and folds case and spaces", async () => {
    expect(await addrHash("s", "a1", " Person@Example.org ")).toBe(await addrHash("s", "a1", "person@example.org"));
  });
  it("differs per app and per secret", async () => {
    const h = await addrHash("s", "a1", "p@example.org");
    expect(await addrHash("s", "a2", "p@example.org")).not.toBe(h);
    expect(await addrHash("t", "a1", "p@example.org")).not.toBe(h);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
  it("scrubs every address from a text", () => {
    expect(scrubAddresses('550 <p.q@example.org> unknown; also "x+y@sub.example.org"')).toBe('550 <***@***> unknown; also "***@***"');
  });
});

const NOW = "2026-10-29T10:00:00.000Z";
const req = (over: Record<string, unknown> = {}) => ({
  to: "p@example.org",
  locale: "en",
  kind: "transactional",
  label: "password_reset",
  subject: "Reset your password",
  text: "Open https://app.example.org/reset?t=abc to reset.",
  expires_at: "2026-10-29T11:00:00Z",
  idempotency_key: "act-1",
  ...over,
});
const APP: AppRow = {
  id: "demo", key_hash: "", retention_days: 90, images_enabled: false, notify_enabled: false, allowed_origins: [], created_at: NOW,
  has_notice_key: false, has_send_key: true, mail_from_name: "Demo", mail_kinds: ["transactional"], mail_labels: ["password_reset"],
};
const mistake = (over: Record<string, unknown>, app: AppRow = APP) => mailMistake(app, validateMail(req(over), NOW))?.code ?? null;

describe("mail request fields", () => {
  it("a good request passes", () => expect(validateMail(req(), NOW).expires_at).toBe("2026-10-29T11:00:00.000Z"));
  const bad: Array<[string, Record<string, unknown>]> = [
    ["to", { to: "two@example.org, three@example.org" }],
    ["to", { to: "nobody" }],
    ["locale", { locale: "English" }],
    ["kind", { kind: "commercial" }],
    ["label", { label: "Has Space" }],
    ["subject", { subject: "two\nlines" }],
    ["subject", { subject: "x".repeat(501) }],
    ["text", { text: " " }],
    ["expires_at", { expires_at: "2026-10-29T09:59:00Z" }],
    ["expires_at", { expires_at: "2026-10-30T10:00:01Z" }],
    ["idempotency_key", { idempotency_key: "" }],
    ["user_ref", { user_ref: "short" }],
  ];
  for (const [field, over] of bad) {
    it(`refuses a bad ${field}: ${JSON.stringify(over).slice(0, 50)}`, () => {
      expect(() => validateMail(req(over), NOW)).toThrow(expect.objectContaining({ status: 400, extra: { field } }));
    });
  }
});

describe("the app's own mistakes are 422 with a reason", () => {
  it("none for a good mail", () => expect(mistake({})).toBeNull());
  it("unknown_label", () => expect(mistake({ label: "welcome" })).toBe("unknown_label"));
  it("kind_not_allowed when the kind is not ticked", () => expect(mistake({}, { ...APP, mail_kinds: [] })).toBe("kind_not_allowed"));
  const DOC = { kind: "legal_document", document: { version: "tos-3", reference: "ord-1", sale: "one_off" } };
  it("kind_not_allowed for legal_document while not ticked", () => expect(mistake(DOC)).toBe("kind_not_allowed"));
  it("a ticked legal_document passes", () => expect(mistake(DOC, { ...APP, mail_kinds: ["legal_document"] })).toBeNull());
  it("bad_html for any html on a legal document, even a harmless one", () => expect(mistake({ ...DOC, html: "<p>x</p>" }, { ...APP, mail_kinds: ["legal_document"] })).toBe("bad_html"));
  it("not_plain_text for markup in text", () => expect(mistake({ text: "<b>hi</b>" })).toBe("not_plain_text"));
  it("an address in angle brackets is still plain text", () => expect(mistake({ text: "Write to <help@example.org>." })).toBeNull());
  it("bad_link for http in text", () => expect(mistake({ text: "Open http://app.example.org/x" })).toBe("bad_link"));
  it("bad_link for a relative href", () => expect(mistake({ html: '<a href="/reset">Reset</a>' })).toBe("bad_link"));
  it("bad_link for javascript:", () => expect(mistake({ html: "<a href='javascript:alert(1)'>x</a>" })).toBe("bad_link"));
  it("an https button with inline styles passes", () => expect(mistake({ html: '<a href="https://app.example.org/r?t=1" style="padding:8px;background-color:#123">Reset</a>' })).toBeNull());
  for (const h of ["<script>x</script>", "<form action='https://x.example'></form>", '<img src="https://t.example/p.gif">', '<div style="background:url(https://t.example/p)">', '<p onclick="x()">', '<img alt="logo">', '<meta http-equiv="refresh" content="0">', "<iframe></iframe>"]) {
    it(`bad_html: ${h}`, () => expect(mistake({ html: h })).toBe("bad_html"));
  }
});

describe("the vendor call", () => {
  const m = { id: "mail-1", fromAddress: "demo@example.invalid", fromName: "Demo", to: "p@example.org", subject: "S", text: "T", html: null };
  it("turns tracking off, sets reply-to to the app's address and carries Ulak's id", () => {
    const b = vendorBody(m);
    expect(b).toMatchObject({ track_clicks: false, track_opens: false, client_reference: "mail-1", reply_to: [{ address: "demo@example.invalid" }], from: { address: "demo@example.invalid", name: "Demo" } });
    expect(b).not.toHaveProperty("htmlbody");
    expect(vendorBody({ ...m, html: "<p>x</p>" }).htmlbody).toBe("<p>x</p>");
  });
  it("withSenderInfo closes the text with the separator and the block", () => {
    expect(withSenderInfo(m, "Example Ltd\n+1 555 0100").text).toBe("T\n\n-- \nExample Ltd\n+1 555 0100");
    expect(withSenderInfo({ ...m, text: "T\n\n  " }, "X").text).toBe("T\n\n-- \nX");
    expect(withSenderInfo(m, "X").html).toBeNull();
  });
  it("withSenderInfo puts the escaped block before the closing body tag, else at the end", () => {
    const block = '<hr><p style="font-size:12px;color:#666">A &#38; B &#60;x&#62;<br>line 2</p>';
    expect(withSenderInfo({ ...m, html: "<html><body><p>x</p></BODY></html>" }, "A & B <x>\nline 2").html).toBe(`<html><body><p>x</p>${block}</BODY></html>`);
    expect(withSenderInfo({ ...m, html: "<p>x</p>" }, "A & B <x>\nline 2").html).toBe(`<p>x</p>${block}`);
  });
  it("every vendor call carries the sender block", async () => {
    let body: any;
    const cfg = { apiUrl: "https://mail.example.invalid/v1.1/email", fromDomain: "example.invalid", apiKey: "k", webhookKey: "w", hashSecret: "h", senderInfo: "Example Ltd" };
    await sendViaVendor(cfg, m, (async (_u: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return new Response("{}", { status: 200 });
    }) as typeof fetch);
    expect(body.textbody).toBe("T\n\n-- \nExample Ltd");
  });
  it("200 is accepted with the request id", () => expect(classify(200, '{"request_id":"req-9","message":"OK"}')).toEqual({ kind: "accepted", requestId: "req-9" }));
  it("a refused to-address is address_refused, scrubbed", () => {
    const r = classify(400, '{"error":{"code":"TM_4001","details":[{"code":"SM_113","message":"Mandatory Field \'to\' has Invalid Value.","target":"to","target_value":"p@example.org"}]}}');
    expect(r.kind).toBe("address_refused");
    expect(JSON.stringify(r)).not.toContain("p@example.org");
  });
  it("an unverified sender domain is vendor_down", () => expect(classify(400, '{"error":{"code":"TM_4001","details":[{"code":"SM_111","target":"from"}]}}').kind).toBe("vendor_down"));
  for (const code of ["TM_3501", "TM_3601", "TM_5001"]) it(`${code} is vendor_down`, () => expect(classify(400, `{"error":{"code":"${code}"}}`).kind).toBe("vendor_down"));
  for (const code of ["TM_3201", "TM_3301", "TM_8001"]) it(`${code} is request_bad`, () => expect(classify(400, `{"error":{"code":"${code}"}}`).kind).toBe("request_bad"));
  for (const st of [500, 503, 401, 429]) it(`HTTP ${st} is vendor_down`, () => expect(classify(st, "").kind).toBe("vendor_down"));
  it("a network failure is vendor_down, never a throw", async () => {
    const cfg = mailConfig(asEnv(FULL))!;
    const r = await sendViaVendor(cfg, m, (async () => {
      throw new TypeError("connection reset");
    }) as unknown as typeof fetch);
    expect(r.kind).toBe("vendor_down");
  });
  it("a vendor that does not answer is cut off by the timeout", async () => {
    const cfg = mailConfig(asEnv(FULL))!;
    const hang = ((_u: string, init: RequestInit) => new Promise((_, rej) => init.signal!.addEventListener("abort", () => rej(init.signal!.reason)))) as unknown as typeof fetch;
    const t = Date.now();
    expect(await sendViaVendor(cfg, m, hang, 50)).toEqual({ kind: "vendor_down", error: "timeout" });
    expect(Date.now() - t).toBeLessThan(2000);
  });
  it("backs off 5, 10, 20, 40, then hourly", () => expect([1, 2, 3, 4, 5, 9].map(backoffMinutes)).toEqual([5, 10, 20, 40, 60, 60]));
});

describe("webhook signature", () => {
  const json = JSON.stringify({ event_name: "hard bounce", note: "a+b c" });
  const FORM = "application/x-www-form-urlencoded";
  it("accepts the vendor's signature, with + and spaces in the payload", async () => {
    const t = Date.now();
    const { body, header } = await vendorSigned(json, "key1", t);
    const payload = signedPayload(body, FORM)!;
    expect(payload).toBe(json);
    expect(await verifySignature(header, payload, "key1", t)).toBe(true);
  });
  it("refuses a tampered payload, a wrong key, a stale or future time, another algorithm and no header", async () => {
    const t = Date.now();
    const { body, header } = await vendorSigned(json, "key1", t);
    const payload = signedPayload(body, FORM)!;
    expect(await verifySignature(header, payload.replace("bounce", "bounc3"), "key1", t)).toBe(false);
    expect(await verifySignature(header, payload, "key2", t)).toBe(false);
    expect(await verifySignature(header, payload, "key1", t + 5 * 60_000 + 1)).toBe(false);
    expect(await verifySignature(header, payload, "key1", t - 5 * 60_000 - 1)).toBe(false);
    expect(await verifySignature(header.replace("HmacSHA256", "HmacSHA1"), payload, "key1", t)).toBe(false);
    expect(await verifySignature(null, payload, "key1", t)).toBe(false);
  });
  it("a JSON body is signed as it stands", () => expect(signedPayload(json, "application/json")).toBe(json));
});

describe("webhook events", () => {
  const ev = (object: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      event_name: object,
      event_message: [{ email_info: { client_reference: "mail-1", to: [{ email_address: { address: "p@example.org" } }] }, event_data: [{ object, details: [{ reason: "Mailbox not found", diagnostic_message: "550 p@example.org unknown" }] }], request_id: "req-1", ...extra }],
    });
  it("a hard bounce, its reason scrubbed", () => {
    const [e] = parseEvents(ev("hardbounce"));
    expect(e).toMatchObject({ type: "hardbounce", ref: "mail-1", requestId: "req-1", reason: "Mailbox not found" });
    // The remote server's text is dropped; only its status code would be kept.
    const [f] = parseEvents(ev("hardbounce").replace("550 p@example.org unknown", "550 5.1.1 user john.doe unknown"));
    expect(f).toMatchObject({ reason: "Mailbox not found 5.1.1" });
    expect(JSON.stringify(f)).not.toContain("john.doe");
    expect(JSON.stringify(e)).not.toContain("p@example.org");
  });
  it("soft bounce, complaint, delivered, and open is ignored", () => {
    expect(parseEvents(ev("softbounce"))[0]!.type).toBe("softbounce");
    expect(parseEvents(ev("fbl_complaint"))[0]!.type).toBe("complaint");
    expect(parseEvents(ev("email_delivered"))[0]!.type).toBe("delivered");
    expect(parseEvents(ev("email_open"))[0]!.type).toBe("ignored");
  });
  it("garbage is no event", () => expect(parseEvents("not json")).toEqual([]));
});
