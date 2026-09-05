import { Hono } from "hono";
import type { Env } from "../core/env";
import { statusList } from "../core/env";
import { ApiError } from "../core/errors";
import { requireAdminToken, type AdminTokenVars } from "../core/auth/admintoken";
import { listAdmin, getMessage, setStatus, deleteUser, type MessageRow } from "../core/messages";
import { addReply, listReplies, listRepliesFor } from "../core/replies";
import { listImagesFor, deleteImageObjects } from "../core/images";
import { signImageUrl } from "../core/signedurl";
import { runChecks } from "../core/checks";
import { listApps } from "../core/apps";
import { isIso } from "../core/time";

export const api = new Hono<{ Bindings: Env; Variables: AdminTokenVars }>();

api.onError((err) => (err instanceof ApiError ? err.toResponse() : new ApiError(500, "internal", err instanceof Error ? err.message : String(err), true).toResponse()));
api.use("*", requireAdminToken());

const notFound = () => new ApiError(404, "not_found", "no such message", false);

api.get("/messages", async (c) => {
  const since = c.req.query("since");
  if (since && !isIso(since)) throw new ApiError(400, "invalid_request", "since must be ISO 8601", false, { field: "since" });
  const rows = await listAdmin(c.env.DB, {
    app: c.req.query("app") || undefined,
    status: c.req.query("status") || undefined,
    sinceIso: since || undefined,
    limit: Number(c.req.query("limit") || 100),
  });
  const replies = await listRepliesFor(c.env.DB, rows.map((r) => r.id));
  const counts = new Map<string, number>();
  if (rows.length) {
    const ph = rows.map(() => "?").join(",");
    const q = await c.env.DB.prepare(`SELECT message_id, COUNT(*) n FROM images WHERE message_id IN (${ph}) GROUP BY message_id`)
      .bind(...rows.map((r) => r.id))
      .all<{ message_id: string; n: number }>();
    for (const r of q.results) counts.set(r.message_id, r.n);
  }
  const summary = (r: MessageRow) => ({
    id: r.id,
    app: r.app,
    app_version: r.app_version,
    app_build: r.app_build,
    platform: r.platform,
    locale: r.locale,
    user_ref: r.user_ref,
    status: r.status,
    received_at: r.received_at,
    last_activity_at: r.last_activity_at,
    message: r.message,
    has_error: !!r.last_error,
    reply_count: replies.get(r.id)?.length ?? 0,
    image_count: counts.get(r.id) ?? 0,
  });
  return c.json({ messages: rows.map(summary) });
});

api.get("/messages/:id", async (c) => {
  const m = await getMessage(c.env.DB, c.req.param("id"));
  if (!m) throw notFound();
  const [replies, images] = await Promise.all([listReplies(c.env.DB, m.id), listImagesFor(c.env.DB, m.id)]);
  const exp = Math.floor(Date.now() / 1000) + 600;
  let context: unknown = null;
  try {
    context = m.context ? JSON.parse(m.context) : null;
  } catch {
    context = m.context;
  }
  const { body_hash: _h, ...rest } = m;
  const secret = c.env.IMAGE_URL_SECRET;
  return c.json({
    ...rest,
    context,
    replies,
    images: await Promise.all(
      images.map(async (i) => ({ id: i.id, width: i.width, height: i.height, bytes: i.bytes, url: secret ? await signImageUrl(secret, c.env.IMAGES_URL, i.id, exp) : null })),
    ),
  });
});

api.post("/messages/:id/replies", async (c) => {
  const m = await getMessage(c.env.DB, c.req.param("id"));
  if (!m) throw notFound();
  const body = await c.req.json<{ content?: string }>().catch(() => ({}) as { content?: string });
  if (!body.content?.trim()) throw new ApiError(400, "invalid_request", "content is required", false, { field: "content" });
  return c.json(await addReply(c.env.DB, m.id, "owner", body.content), 201);
});

api.post("/messages/:id/status", async (c) => {
  const body = await c.req.json<{ status?: string }>().catch(() => ({}) as { status?: string });
  const status = body.status ?? "";
  if (!statusList(c.env).includes(status)) throw new ApiError(400, "invalid_request", `status must be one of ${statusList(c.env).join(", ")}`, false, { field: "status" });
  await setStatus(c.env.DB, c.req.param("id"), status).catch(() => {
    throw notFound();
  });
  return c.json({ id: c.req.param("id"), status });
});

api.delete("/users", async (c) => {
  const app = c.req.query("app") ?? "";
  const user_ref = c.req.query("user_ref") ?? "";
  if (!app || user_ref.length < 16) throw new ApiError(400, "invalid_request", "app and user_ref are required", false, { field: "user_ref" });
  const { deleted_messages, image_keys } = await deleteUser(c.env.DB, app, user_ref);
  c.executionCtx.waitUntil(deleteImageObjects(c.env, image_keys));
  return c.json({ deleted_messages });
});

api.get("/apps", async (c) => c.json({ apps: (await listApps(c.env.DB)).map(({ key_hash: _k, ...a }) => a) }));

api.get("/checks", async (c) => {
  const r = await runChecks(c.env.DB);
  return c.json(r, r.ok ? 200 : 503);
});
