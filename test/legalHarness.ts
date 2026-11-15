import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { expect, beforeEach, afterEach, vi } from "vitest";
import worker from "../src/api/index";
import { createApp, updateApp, rotateSendKey } from "../src/core/apps";
import { vendorTransport } from "../src/core/mail/vendor";
import { type LegalDocument } from "../src/core/mail/legal";
import { TelegramNotifier } from "../src/core/notify/telegram";
import type { Env } from "../src/core/env";
import { addMinutes, nowIso } from "../src/core/time";
import { vendorSigned } from "./helpers";

export const MAIL = { MAIL_API_URL: "https://mail.example.invalid/v1.1/email", MAIL_FROM_DOMAIN: "example.invalid", MAIL_API_KEY: "vendor-key", MAIL_WEBHOOK_KEY: "hook-key", MAIL_HASH_SECRET: "hash-secret", MAIL_SENDER_INFO: "Example Ltd, 1 Main St, Town; +1 555 0100; abuse@example.invalid" };
export const LEGAL = { LEGAL_KEEP_YEARS: "10" };
export const TG = { NOTIFIER: "telegram", TELEGRAM_BOT_TOKEN: "t", TELEGRAM_CHAT_ID: "c" };
export const lenv = (over: Partial<Env> = {}) => ({ ...env, ...MAIL, ...LEGAL, ...TG, ...over }) as Env;

export const ADDRESS = "buyer@example.org";
export const SUBJECT = "Your order ORD-77: contract and pre-information form";
export const TEXT = "Pre-information form, version tos-2026-10.\nDistance sales contract between the seller and the buyer.\nWithdrawal: 14 days.";
export const REFERENCE = "ORD-77";
export const VERSION = "tos-2026-10";

/** The vendor double: records each call and answers with the next scripted reply (default 200). */
export const calls: Array<{ body: any }> = [];
export const replies: Array<() => Response | Promise<Response>> = [];
/** Telegram lines, captured. `telegram.failNext` makes the next n sends fail. */
export const lines: string[] = [];
export const telegram = { failNext: 0 };
const realFetch = vendorTransport.fetch;
const realSend = TelegramNotifier.prototype.send;
beforeEach(() => {
  calls.length = 0;
  replies.length = 0;
  lines.length = 0;
  telegram.failNext = 0;
  vendorTransport.fetch = (async (_url: string, init: RequestInit) => {
    calls.push({ body: JSON.parse(String(init.body)) });
    const next = replies.shift();
    return next ? next() : new Response(JSON.stringify({ request_id: `req-${calls.length}`, message: "OK" }), { status: 200 });
  }) as typeof fetch;
  TelegramNotifier.prototype.send = async function (n) {
    if (telegram.failNext > 0) {
      telegram.failNext -= 1;
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
export const down = () => new Response("bad gateway", { status: 502 });
export const refusedAddress = () => new Response('{"error":{"code":"TM_4001","details":[{"code":"SM_113","target":"to"}]}}', { status: 400 });
export const malformed = () => new Response('{"error":{"code":"TM_3301"}}', { status: 400 });

export async function legalApp(id = "shop"): Promise<string> {
  await createApp(env.DB, id);
  await updateApp(env.DB, id, { mail_from_name: "Shop", mail_kinds: ["transactional", "legal_document"], mail_labels: ["order_documents", "receipt"] });
  return rotateSendKey(env.DB, id);
}

export const legalBody = (over: Record<string, unknown> = {}) => ({
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

export async function call(path: string, key: string | null, body: unknown, e: Env = lenv(), headers: Record<string, string> = {}) {
  const h: Record<string, string> = { "content-type": "application/json", ...headers };
  if (key) h.authorization = `Bearer ${key}`;
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`https://api.example.invalid${path}`, { method: "POST", headers: h, body: JSON.stringify(body) }), e, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}
export const sendLegal = (key: string, over: Record<string, unknown> = {}, e?: Env) => call("/v1/mail", key, legalBody(over), e);
export const idOf = async (res: Response) => (await res.json<{ id: string }>()).id;
export const copy = (id: string) => env.DB.prepare("SELECT * FROM legal_documents WHERE mail_id=?").bind(id).first<LegalDocument>();
export const mailRow = (id: string) => env.DB.prepare("SELECT * FROM mails WHERE id=?").bind(id).first<any>();
export const alerts = (id?: string) =>
  (id ? env.DB.prepare("SELECT * FROM legal_alerts WHERE mail_id=? ORDER BY opened_at").bind(id) : env.DB.prepare("SELECT * FROM legal_alerts ORDER BY opened_at")).all<any>().then((r) => r.results);

export async function event(mailId: string | null, object: string, extra: { requestId?: string; details?: Record<string, unknown> } = {}) {
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
  return signedPayloadEvent(json).then(() => undefined);
}

/** Posts one exact payload as the vendor would, signed and form-encoded; returns the route's answer. */
export async function signedPayloadEvent(json: string) {
  const { body, header } = await vendorSigned(json, MAIL.MAIL_WEBHOOK_KEY, Date.now());
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request("https://api.example.invalid/v1/mail/events", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "producer-signature": header }, body }), lenv(), ctx);
  await waitOnExecutionContext(ctx);
  expect(res.status).toBe(200);
  return res.json();
}
