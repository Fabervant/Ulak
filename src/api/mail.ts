import type { Context, Hono } from "hono";
import type { Env } from "../core/env";
import { ApiError, invalid } from "../core/errors";
import { requireSendKey, type AppVars } from "../core/auth/appkey";
import { nowIso } from "../core/time";
import { requireMailConfig } from "../core/mail/config";
import { addrHash } from "../core/mail/hash";
import { validateMail, mailMistake, MAIL_MAX_BODY_BYTES, ADDRESS, type MailRequest } from "../core/mail/validate";
import { attemptMail, deleteMailsByAddress, findByIdempotencyKey, getMail, insertMail, isSuppressed, recipientWaitSec, sendingHealth, type MailStatus } from "../core/mail/outbox";
import { DEFAULT_LEGAL_EXPIRY_HOURS, findLegal, insertLegal, legalConfigState, reportEnd, requireLegalConfig, tellAlerts } from "../core/mail/legal";
import type { MailConfig } from "../core/mail/config";
import type { AppRow } from "../core/apps";
import { applyEvent, parseEvents, signedPayload, verifySignature } from "../core/mail/webhook";
import { tellFailures } from "../core/mail/job";
import { readJsonCapped, readTextCapped } from "./body";

type Ctx = { Bindings: Env; Variables: AppVars };

const suppressed = () => new ApiError(422, "suppressed", "this address does not receive mail from this app", false);

/** The answer for a mail in a given state, the same on the first call and on every repeat of its key:
 *  a mail Ulak will not send is never answered 2xx, so the app's own path can still send it. */
function answer(c: Context<Ctx>, id: string, status: MailStatus): Response {
  switch (status) {
    case "queued":
      return c.json({ id, status: "queued" }, 202);
    case "refused":
      throw suppressed();
    case "failed":
      throw new ApiError(500, "mail_failed", "the mail service refused this mail as malformed; the operator has been told", false, { id });
    case "given_up":
      throw new ApiError(410, "mail_expired", "this mail reached its expires_at before it could be sent", false, { id });
    default:
      return c.json({ id, status: "sent" }, 202);
  }
}

const refuseBrowser = (c: Context<Ctx>) => {
  if (c.req.header("origin")) throw new ApiError(403, "server_only", "mail is sent from a server, never from a browser", false);
};

/** Mail is sent from an app's server: a browser request is refused before the key is even read,
 *  so a send key is never tried from a page. */
async function serverApp(c: Context<Ctx>) {
  refuseBrowser(c);
  await requireSendKey()(c, async () => {}); // 401
  return c.get("app");
}

/** A legal document is always answered `202 queued`, on the first call and on every repeat of its
 *  key however old (spec 5.1, 5.2, 5.4): the app's daily reconciliation depends on a sale never being
 *  mailed twice, and every problem after acceptance is the operator's, raised as an alert. The answer
 *  goes before the first attempt, which runs after it; the timer takes the mail if it never runs. */
async function sendLegal(c: Context<Ctx>, cfg: MailConfig, tenant: AppRow, m: MailRequest, now: string): Promise<Response> {
  const queued = (id: string) => c.json({ id, status: "queued" }, 202);
  const prior = await findLegal(c.env.DB, tenant.id, m.idempotency_key);
  if (prior) return queued(prior.mail_id);
  const hash = await addrHash(cfg.hashSecret, tenant.id, m.to);
  const suppressed = await isSuppressed(c.env.DB, tenant.id, hash);
  const ins = await insertLegal(c.env.DB, tenant.id, m, hash, suppressed, now);
  if (!ins.created) return queued(ins.id);
  const env = c.env;
  const first = async () => {
    if (!suppressed) {
      const row = await getMail(env.DB, ins.id);
      if (row) await attemptMail(env.DB, cfg, row, tenant);
    }
    await tellAlerts(env);
  };
  c.executionCtx.waitUntil(first().catch((e: unknown) => console.error("legal first attempt", ins.id, e instanceof Error ? e.message : String(e))));
  return queued(ins.id);
}

export function mountMail(app: Hono<Ctx>): void {
  app.post("/v1/mail", async (c) => {
    refuseBrowser(c); // 403
    const raw = await readJsonCapped(c.req.raw, MAIL_MAX_BODY_BYTES); // 413 / 415 / 400
    const tenant = await serverApp(c); // 401
    const cfg = requireMailConfig(c.env); // 503 / 500
    const now = nowIso();
    const legal = legalConfigState(c.env);
    const m = validateMail(raw, now, legal.state === "set" ? legal.cfg.expiryHours : DEFAULT_LEGAL_EXPIRY_HOURS); // 400
    if (m.kind === "legal_document") requireLegalConfig(legal); // 422 while unset, 500 when bad
    const mistake = mailMistake(tenant, m);
    if (mistake) throw mistake; // 422, the app's own mistake
    if (m.kind === "legal_document") return sendLegal(c, cfg, tenant, m, now);

    const prior = await findByIdempotencyKey(c.env.DB, tenant.id, m.kind, m.idempotency_key, now);
    if (prior) return answer(c, prior.id, prior.status);

    const hash = await addrHash(cfg.hashSecret, tenant.id, m.to);
    if (await isSuppressed(c.env.DB, tenant.id, hash)) throw suppressed();
    const ins = await insertMail(c.env.DB, tenant.id, m, hash, now);
    if (!ins) {
      const wait = await recipientWaitSec(c.env.DB, tenant.id, hash, now);
      throw new ApiError(429, "rate_limited", "too many mails to this address; retry after the indicated seconds", true, {}, { "Retry-After": String(wait) });
    }
    if (!ins.created) return answer(c, ins.row.id, ins.row.status);

    const out = await attemptMail(c.env.DB, cfg, ins.row, tenant);
    if (out.status === "refused" || out.status === "failed") c.executionCtx.waitUntil(tellFailures(c.env));
    // A mail the vendor could not take yet is still Ulak's: the timer retries it until it expires.
    return answer(c, ins.row.id, out.status);
  });

  app.get("/v1/mail/status", async (c) => {
    await serverApp(c);
    requireMailConfig(c.env);
    return c.json({ sending: await sendingHealth(c.env.DB, nowIso()) }, 200, { "cache-control": "no-store" });
  });

  // Deletion by address: in the body, never in a URL, so the address reaches no request log.
  app.post("/v1/mail/delete", async (c) => {
    refuseBrowser(c);
    const raw = (await readJsonCapped(c.req.raw)) as { address?: unknown } | null;
    const tenant = await serverApp(c);
    const cfg = requireMailConfig(c.env);
    const address = typeof raw?.address === "string" ? raw.address.trim() : "";
    if (address.length > 254 || !ADDRESS.test(address)) throw invalid("address", "address must be one mail address");
    return c.json(await deleteMailsByAddress(c.env.DB, tenant.id, await addrHash(cfg.hashSecret, tenant.id, address)));
  });

  // The subscription ended: the keeping period of its legal copies starts at `ended_at`.
  app.post("/v1/mail/legal/end", async (c) => {
    refuseBrowser(c);
    const raw = await readJsonCapped(c.req.raw);
    const tenant = await serverApp(c);
    return c.json({ updated: await reportEnd(c.env.DB, tenant.id, raw, nowIso()) });
  });

  // The vendor's delivery, bounce and complaint reports. No key: the vendor's signature instead.
  // The vendor signs the payload only, not the header's timestamp, so the five-minute window limits
  // stale deliveries but cannot stop a replay of a captured event; every event is safe to apply twice.
  app.post("/v1/mail/events", async (c) => {
    const cfg = requireMailConfig(c.env);
    const body = await readTextCapped(c.req.raw, MAIL_MAX_BODY_BYTES); // 413 before buffering more
    const payload = signedPayload(body, c.req.header("content-type") ?? "");
    if (payload === null || !(await verifySignature(c.req.header("producer-signature") ?? null, payload, cfg.webhookKey, Date.now()))) {
      throw new ApiError(401, "bad_signature", "missing or invalid signature", false);
    }
    const now = nowIso();
    let applied = 0;
    for (const ev of parseEvents(payload)) if (await applyEvent(c.env.DB, ev, now)) applied += 1;
    return c.json({ applied });
  });
}
