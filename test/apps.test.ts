import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { createApp, findAppByKey, rotateKey, updateApp, allAllowedOrigins } from "../src/core/apps";
import { requireAppKey, type AppVars } from "../src/core/auth/appkey";
import { ApiError } from "../src/core/errors";
import type { Env } from "../src/core/env";

describe("apps", () => {
  it("createApp returns a key that findAppByKey resolves, and stores only its hash", async () => {
    const { app, key } = await createApp(env.DB, "demo");
    expect(key).toMatch(/^ulak_demo_[0-9a-f]{48}$/);
    expect(app.retention_days).toBe(90);
    expect(app.images_enabled).toBe(false);
    const row = await env.DB.prepare("SELECT key_hash FROM apps WHERE id='demo'").first<{ key_hash: string }>();
    expect(row!.key_hash).not.toContain(key);
    expect((await findAppByKey(env.DB, key))!.id).toBe("demo");
    expect(await findAppByKey(env.DB, "ulak_demo_" + "0".repeat(48))).toBeNull();
  });
  it("rejects a bad id and a duplicate", async () => {
    await expect(createApp(env.DB, "Bad Id")).rejects.toThrow(/app id/);
    await createApp(env.DB, "demo");
    await expect(createApp(env.DB, "demo")).rejects.toThrow(/exists/);
  });
  it("rotateKey invalidates the old key", async () => {
    const { key } = await createApp(env.DB, "demo");
    const next = await rotateKey(env.DB, "demo");
    expect(await findAppByKey(env.DB, key)).toBeNull();
    expect((await findAppByKey(env.DB, next))!.id).toBe("demo");
  });
  it("updateApp and allAllowedOrigins", async () => {
    await createApp(env.DB, "app-a");
    await createApp(env.DB, "app-b");
    await updateApp(env.DB, "app-a", { allowed_origins: ["https://a.example"], images_enabled: true, retention_days: 30 });
    await updateApp(env.DB, "app-b", { allowed_origins: ["https://b.example", "https://www.b.example"] });
    expect([...(await allAllowedOrigins(env.DB))].sort()).toEqual(["https://a.example", "https://b.example", "https://www.b.example"]);
    await expect(updateApp(env.DB, "app-a", { retention_days: 0 })).rejects.toThrow(/retention_days/);
    await expect(updateApp(env.DB, "app-a", { allowed_origins: ["javascript:alert(1)"] })).rejects.toThrow(/origin/);
  });
  it("middleware: 401 without or with a bad key, app row with a good one", async () => {
    const { key } = await createApp(env.DB, "demo");
    const app = new Hono<{ Bindings: Env; Variables: AppVars }>();
    app.onError((e) => (e instanceof ApiError ? e.toResponse() : new Response("x", { status: 500 })));
    app.use("*", requireAppKey());
    app.get("/", (c) => c.json({ id: c.get("app").id }));
    const r1 = await app.request("/", {}, env);
    expect(r1.status).toBe(401);
    expect(await r1.json()).toMatchObject({ error: "invalid_app_key", retryable: false });
    const r2 = await app.request("/", { headers: { authorization: "Bearer nope" } }, env);
    expect(r2.status).toBe(401);
    const r3 = await app.request("/", { headers: { authorization: `Bearer ${key}` } }, env);
    expect(await r3.json()).toEqual({ id: "demo" });
  });
});
