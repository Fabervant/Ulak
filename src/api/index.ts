import { Hono } from "hono";
import type { Env } from "../core/env";
import { statusList } from "../core/env";
import { ApiError } from "../core/errors";
import { requireAppKey, type AppVars } from "../core/auth/appkey";
import { validateSubmit, MAX_BODY_BYTES } from "../core/validate";
import { insertMessage, countUserMessagesSince, findByIdempotency, bodyHash } from "../core/messages";
import { MemoryRateLimiter, limiterFor, enforce } from "../core/ratelimit";
import { clientIp } from "../core/clientip";
import { addMinutes, nowIso } from "../core/time";
import { notifyMessage } from "../core/notify/dispatch";
import { cors } from "./cors";

type Ctx = { Bindings: Env; Variables: AppVars };
export const app = new Hono<Ctx>();

// Isolate-local fallbacks, used when the rate-limit bindings are absent (tests, local dev).
const memSubmitUser = new MemoryRateLimiter(3, 60);
const memSubmitIp = new MemoryRateLimiter(10, 60);

app.onError((err) => {
  if (err instanceof ApiError) return err.toResponse();
  console.error("unhandled", err);
  return new ApiError(500, "internal", "internal error", true).toResponse();
});

app.use("*", cors());

const tooLarge = () => new ApiError(413, "payload_too_large", `request body exceeds ${MAX_BODY_BYTES} bytes`, false, { max_bytes: MAX_BODY_BYTES });

/** Reads a JSON body under the cap, rejecting before parsing. Order: 413, 415, then 400. */
async function readJsonCapped(req: Request): Promise<unknown> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) throw tooLarge();
  if (!/^application\/json\b/i.test(req.headers.get("content-type") ?? "")) throw new ApiError(415, "unsupported_media_type", "Content-Type must be application/json", false);
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = req.body?.getReader();
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel();
        throw tooLarge();
      }
      chunks.push(value);
    }
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const ch of chunks) {
    out.set(ch, off);
    off += ch.byteLength;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(out);
  } catch {
    throw new ApiError(400, "invalid_request", "body is not valid UTF-8", false, { field: "body" });
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(400, "invalid_request", "body is not valid JSON", false, { field: "body" });
  }
}

app.post("/v1/messages", async (c) => {
  const raw = await readJsonCapped(c.req.raw); // 413 / 415 / 400 before anything else
  await requireAppKey()(c, async () => {}); // 401
  const tenant = c.get("app");
  const p = validateSubmit(raw); // 400
  if (p.app !== tenant.id) throw new ApiError(403, "app_mismatch", "app does not match the key", false);
  if (p.attachments.length && !tenant.images_enabled) throw new ApiError(403, "images_disabled", "this app does not accept images", false);

  // A retried duplicate must not spend rate budget: answer it before the limiters.
  const prior = await findByIdempotency(c.env.DB, tenant.id, p.user_ref, p.client_msg_id);
  if (prior) {
    if (prior.body_hash !== (await bodyHash(p))) throw new ApiError(409, "idempotency_conflict", "client_msg_id was already used with a different body", false);
    return c.json({ id: prior.id, received_at: prior.received_at }, 200);
  }

  const ip = clientIp(c.req.raw, c.env);
  const limiters = [{ limiter: limiterFor(c.env.RL_SUBMIT_IP, memSubmitIp), key: `ip:${ip}` }];
  if (p.user_ref) limiters.unshift({ limiter: limiterFor(c.env.RL_SUBMIT_USER, memSubmitUser), key: `u:${tenant.id}:${p.user_ref}` });
  await enforce(limiters, 60); // 429 burst
  if (p.user_ref && (await countUserMessagesSince(c.env.DB, tenant.id, p.user_ref, addMinutes(nowIso(), -60))) >= 10) {
    throw new ApiError(429, "rate_limited", "hourly limit reached", true, {}, { "Retry-After": "3600" });
  }

  const statusOnReceipt = statusList(c.env)[0] ?? "pending";
  const { row, created } = await insertMessage(c.env.DB, p, statusOnReceipt);
  if (created) c.executionCtx.waitUntil(notifyMessage(c.env, row));
  return c.json({ id: row.id, received_at: row.received_at }, created ? 201 : 200);
});

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, _env: Env, _ctx: ExecutionContext): Promise<void> {
    // Filled in Task 9.
  },
};
