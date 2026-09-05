import { Hono } from "hono";
import type { Env } from "../core/env";
import { statusList } from "../core/env";
import { ApiError } from "../core/errors";
import { requireAppKey, type AppVars } from "../core/auth/appkey";
import { validateSubmit, MAX_BODY_BYTES } from "../core/validate";
import { insertMessage, countUserMessagesSince, findByIdempotency, bodyHash, listForUser, deleteUser } from "../core/messages";
import { listRepliesFor } from "../core/replies";
import { statusLabel } from "../core/locales";
import { sha256Hex } from "../core/ids";
import { isIso } from "../core/time";
import { MemoryRateLimiter, limiterFor, enforce } from "../core/ratelimit";
import { clientIp } from "../core/clientip";
import { addMinutes, nowIso } from "../core/time";
import { notifyMessage } from "../core/notify/dispatch";
import { cors } from "./cors";
import { runScheduled } from "../core/retention";
import { uploadImage, codecFromEnv, claimImages, countClaimable, MAX_IMAGE_BYTES } from "../core/images";

type Ctx = { Bindings: Env; Variables: AppVars };
export const app = new Hono<Ctx>();

// Isolate-local fallbacks, used when the rate-limit bindings are absent (tests, local dev).
const memSubmitUser = new MemoryRateLimiter(3, 60);
const memSubmitIp = new MemoryRateLimiter(10, 60);
const memReadUser = new MemoryRateLimiter(2, 60);
const memReadIp = new MemoryRateLimiter(120, 60);
const memUploadUser = new MemoryRateLimiter(5, 60);

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

  if (p.attachments.length && (await countClaimable(c.env.DB, tenant.id, p.user_ref, p.attachments)) !== p.attachments.length) {
    throw new ApiError(400, "invalid_request", "an attachment id is unknown, already used, or not yours", false, { field: "attachments" });
  }

  const statusOnReceipt = statusList(c.env)[0] ?? "pending";
  const { row, created } = await insertMessage(c.env.DB, p, statusOnReceipt);
  if (created && p.attachments.length) await claimImages(c.env.DB, tenant.id, p.user_ref, row.id, p.attachments);
  if (created) c.executionCtx.waitUntil(notifyMessage(c.env, row));
  return c.json({ id: row.id, received_at: row.received_at }, created ? 201 : 200);
});

const imageTooLarge = () => new ApiError(413, "payload_too_large", `image exceeds ${MAX_IMAGE_BYTES} bytes`, false, { max_bytes: MAX_IMAGE_BYTES });

app.post("/v1/images", requireAppKey(), async (c) => {
  const tenant = c.get("app");
  if (!tenant.images_enabled) throw new ApiError(403, "images_disabled", "this app does not accept images", false);
  if (Number(c.req.header("content-length") ?? "0") > MAX_IMAGE_BYTES) throw imageTooLarge();
  const user_ref = c.req.header("x-ulak-user-ref") ?? null;
  if (user_ref !== null && (user_ref.length < 16 || user_ref.length > 128)) {
    throw new ApiError(400, "invalid_request", "x-ulak-user-ref must be 16 to 128 characters", false, { field: "user_ref" });
  }
  await enforce([{ limiter: limiterFor(c.env.RL_UPLOAD_USER, memUploadUser), key: `up:${tenant.id}:${user_ref ?? clientIp(c.req.raw, c.env)}` }], 60);
  const bytes = await c.req.raw.arrayBuffer();
  if (bytes.byteLength > MAX_IMAGE_BYTES) throw imageTooLarge();
  const { id } = await uploadImage(c.env, codecFromEnv(c.env), tenant, user_ref, bytes);
  return c.json({ id }, 201);
});

function userRefParam(raw: string | undefined): string {
  const u = raw ?? "";
  if (u.length < 16 || u.length > 128) throw new ApiError(400, "invalid_request", "user_ref must be 16 to 128 characters", false, { field: "user_ref" });
  return u;
}

app.get("/v1/messages", requireAppKey(), async (c) => {
  const tenant = c.get("app");
  const user_ref = userRefParam(c.req.query("user_ref"));
  const since = c.req.query("since") ?? null;
  if (since !== null && !isIso(since)) throw new ApiError(400, "invalid_request", "since must be ISO 8601", false, { field: "since" });
  const limiters = [{ limiter: limiterFor(c.env.RL_READ_USER, memReadUser), key: `r:${tenant.id}:${user_ref}` }];
  if (c.env.READ_IP_BACKSTOP === "true") limiters.push({ limiter: memReadIp, key: `rip:${clientIp(c.req.raw, c.env)}` });
  await enforce(limiters, 60);

  const rows = await listForUser(c.env.DB, tenant.id, user_ref, since);
  const replies = await listRepliesFor(c.env.DB, rows.map((r) => r.id));
  const messages = rows.map((r) => ({
    id: r.id,
    received_at: r.received_at,
    last_activity_at: r.last_activity_at,
    status: r.status,
    status_label: statusLabel(r.status, r.locale),
    message: r.message,
    replies: (replies.get(r.id) ?? []).map((x) => ({ id: x.id, sender_role: x.sender_role, content: x.content, created_at: x.created_at })),
  }));
  const cursor = rows.length ? rows[rows.length - 1]!.last_activity_at : since;
  const etag = `"${(await sha256Hex(JSON.stringify(messages))).slice(0, 32)}"`;
  if (c.req.header("if-none-match") === etag) return new Response(null, { status: 304, headers: { etag } });
  return c.json({ messages, cursor }, 200, { etag, "cache-control": "no-store" });
});

app.delete("/v1/messages", requireAppKey(), async (c) => {
  const tenant = c.get("app");
  const user_ref = userRefParam(c.req.query("user_ref"));
  const { deleted_messages, image_keys } = await deleteUser(c.env.DB, tenant.id, user_ref);
  c.executionCtx.waitUntil(Promise.all(image_keys.map((k) => c.env.IMAGES.delete(k))));
  return c.json({ deleted_messages });
});

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runScheduled(env).then((r) => console.log("scheduled", JSON.stringify(r))));
  },
};
