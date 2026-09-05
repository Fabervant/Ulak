import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import admin from "../src/admin/index";
import { createApp } from "../src/core/apps";
import { insertMessage } from "../src/core/messages";
import { validateSubmit } from "../src/core/validate";
import { createAdminToken, revokeAdminToken } from "../src/core/auth/admintoken";
import { addMinutes, nowIso } from "../src/core/time";

const E = { ...env, SESSION_SECRET: "s3", IMAGE_URL_SECRET: "i3" };
let token: string;
let tokenId: string;
const mk = (over: Record<string, unknown> = {}) =>
  validateSubmit({
    app: "demo",
    app_version: "1",
    platform: "web",
    user_ref: "f3a9c2e1d4b5a6978877665544332211",
    message: "hola",
    client_msg_id: crypto.randomUUID(),
    locale: "es",
    last_error: "E",
    context: { a: 1 },
    contact_email: "x@example.invalid",
    ...over,
  });
async function call(path: string, init: RequestInit = {}, t = token) {
  const ctx = createExecutionContext();
  const res = await admin.fetch(new Request(`https://admin.example.invalid${path}`, { ...init, headers: { authorization: `Bearer ${t}`, "content-type": "application/json", ...(init.headers as Record<string, string>) } }), E, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

beforeEach(async () => {
  await createApp(env.DB, "demo");
  ({ token, id: tokenId } = await createAdminToken(env.DB, "test"));
});

describe("admin API", () => {
  it("401 without a token or with a revoked one, never a redirect", async () => {
    const r = await call("/api/messages", {}, "nope");
    expect(r.status).toBe(401);
    expect(await r.json()).toMatchObject({ error: "invalid_admin_token", retryable: false });
    await revokeAdminToken(env.DB, tokenId);
    expect((await call("/api/messages")).status).toBe(401);
  });
  it("lists summaries with filters and reads one message in full", async () => {
    const m = (await insertMessage(env.DB, mk(), "pending")).row;
    await insertMessage(env.DB, mk({ locale: "en" }), "completed");
    const list = await (await call("/api/messages?app=demo&status=pending")).json<{ messages: Array<Record<string, unknown>> }>();
    expect(list.messages).toHaveLength(1);
    expect(list.messages[0]).toMatchObject({ id: m.id, locale: "es", has_error: true, reply_count: 0, image_count: 0 });
    expect(list.messages[0]!.last_error).toBeUndefined();
    expect(list.messages[0]!.contact_email).toBeUndefined();
    const one = await (await call(`/api/messages/${m.id}`)).json<Record<string, unknown>>();
    expect(one).toMatchObject({ id: m.id, last_error: "E", context: { a: 1 }, contact_email: "x@example.invalid", replies: [], images: [] });
    expect(one.body_hash).toBeUndefined();
    expect((await call(`/api/messages/${crypto.randomUUID()}`)).status).toBe(404);
    expect((await call("/api/messages?since=nope")).status).toBe(400);
  });
  it("replies, sets status, deletes a user, lists apps without key hashes", async () => {
    const m = (await insertMessage(env.DB, mk(), "pending")).row;
    const r = await call(`/api/messages/${m.id}/replies`, { method: "POST", body: JSON.stringify({ content: "Hola, lo revisamos." }) });
    expect(r.status).toBe(201);
    expect((await r.json<{ content: string }>()).content).toBe("Hola, lo revisamos.");
    expect((await call(`/api/messages/${m.id}/replies`, { method: "POST", body: JSON.stringify({ content: " " }) })).status).toBe(400);
    expect((await (await call(`/api/messages/${m.id}/status`, { method: "POST", body: JSON.stringify({ status: "viewed" }) })).json<{ status: string }>()).status).toBe("viewed");
    expect((await call(`/api/messages/${m.id}/status`, { method: "POST", body: JSON.stringify({ status: "nope" }) })).status).toBe(400);
    expect((await call(`/api/messages/${crypto.randomUUID()}/status`, { method: "POST", body: JSON.stringify({ status: "viewed" }) })).status).toBe(404);
    const apps = await (await call("/api/apps")).json<{ apps: Array<Record<string, unknown>> }>();
    expect(apps.apps[0]!.id).toBe("demo");
    expect(apps.apps[0]!.key_hash).toBeUndefined();
    expect(await (await call(`/api/users?app=demo&user_ref=${m.user_ref}`, { method: "DELETE" })).json()).toEqual({ deleted_messages: 1 });
  });
  it("checks answer 200 when green and 503 with counts when a planted row breaches", async () => {
    expect((await call("/api/checks")).status).toBe(200);
    const m = (await insertMessage(env.DB, mk(), "pending")).row;
    await env.DB.prepare("UPDATE messages SET received_at=? WHERE id=?").bind(addMinutes(nowIso(), -11), m.id).run();
    const red = await call("/api/checks");
    expect(red.status).toBe(503);
    expect(await red.json()).toMatchObject({ ok: false, unnotified_over_10m: 1 });
  });
});
