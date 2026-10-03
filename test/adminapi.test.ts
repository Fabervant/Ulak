import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { createApp } from "../src/core/apps";
import { insertMessage } from "../src/core/messages";
import { createAdminToken, revokeAdminToken } from "../src/core/auth/admintoken";
import { addMinutes, nowIso } from "../src/core/time";
import { submission, adminRequest, withD1ParamLimit, seedMessages } from "./helpers";
import { addReply } from "../src/core/replies";

const E = { ...env, SESSION_SECRET: "s3", IMAGE_URL_SECRET: "i3" };
let token: string;
let tokenId: string;
const mk = (over: Record<string, unknown> = {}) =>
  submission({ message: "hola", locale: "es", last_error: "E", context: { a: 1 }, contact_email: "x@example.invalid", ...over });
const call = (path: string, init: RequestInit = {}, t = token) =>
  adminRequest(E, path, { ...init, headers: { authorization: `Bearer ${t}`, "content-type": "application/json", ...(init.headers as Record<string, string>) } });

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
  it("lists more messages than one statement may bind, with their reply and image counts", async () => {
    const ids = await seedMessages(150, nowIso());
    await addReply(env.DB, ids[0]!, "owner", "first");
    await addReply(env.DB, ids[149]!, "owner", "last");
    await env.DB.prepare("INSERT INTO images (id,app,message_id,user_ref,r2_key,content_type,bytes,width,height,created_at) VALUES ('i1','demo',?,NULL,'k','image/png',1,1,1,?)").bind(ids[149], nowIso()).run();
    const res = await adminRequest({ ...E, DB: withD1ParamLimit(env.DB) }, "/api/messages?limit=150", { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const list = (await res.json<{ messages: Array<{ id: string; reply_count: number; image_count: number }> }>()).messages;
    expect(list).toHaveLength(150);
    const byId = new Map(list.map((m) => [m.id, m]));
    expect(byId.get(ids[0]!)).toMatchObject({ reply_count: 1, image_count: 0 });
    expect(byId.get(ids[149]!)).toMatchObject({ reply_count: 1, image_count: 1 });
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
    expect(Object.keys(apps.apps[0]!).filter((k) => k.includes("hash"))).toEqual([]);
    expect(apps.apps[0]!.has_notice_key).toBe(false);
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

describe("GET /status/:secret", () => {
  const S = { ...E, STATUS_SECRET: "a-very-long-random-status-secret" };
  const hit = (path: string, envOverride = S) => adminRequest(envOverride, path);

  it("200 {ok:true} with the right secret when nothing is wrong", async () => {
    const res = await hit("/status/a-very-long-random-status-secret");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("503 when a check is breached, so the monitor sees a real failure", async () => {
    const m = (await insertMessage(env.DB, mk(), "pending")).row;
    await env.DB.prepare("UPDATE messages SET received_at=?, notified_at=NULL WHERE id=?").bind(addMinutes(nowIso(), -30), m.id).run();
    const res = await hit("/status/a-very-long-random-status-secret");
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false });
  });

  it("404 on a wrong secret and when the feature is unconfigured, leaking nothing", async () => {
    expect((await hit("/status/wrong-secret")).status).toBe(404);
    const noSecret = { ...E } as typeof S;
    delete (noSecret as { STATUS_SECRET?: string }).STATUS_SECRET;
    expect((await hit("/status/a-very-long-random-status-secret", noSecret)).status).toBe(404);
  });

  it("reveals no data beyond the ok flag", async () => {
    await insertMessage(env.DB, mk(), "pending");
    const body = await (await hit("/status/a-very-long-random-status-secret")).text();
    expect(body).toBe('{"ok":true}');
    expect(body).not.toMatch(/unnotified|retention|stored_|message/);
  });
});
