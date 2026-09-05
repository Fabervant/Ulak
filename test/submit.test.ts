import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import worker from "../src/api/index";
import { createApp, updateApp } from "../src/core/apps";

let key: string;
let userRef: string;
let ip: string;
const url = "https://api.example.invalid/v1/messages";
const body = () => ({
  app: "demo",
  app_version: "1.0.0",
  platform: "web",
  user_ref: userRef,
  message: "Giriş yapamıyorum: şifre ekranı boş",
  client_msg_id: crypto.randomUUID(),
  locale: "tr",
});
async function post(json: unknown, init: RequestInit = {}) {
  const req = new Request(url, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "cf-connecting-ip": ip, ...(init.headers as Record<string, string>) },
    body: typeof json === "string" ? json : JSON.stringify(json),
  });
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

beforeEach(async () => {
  key = (await createApp(env.DB, "demo")).key;
  // The in-memory limiter is per isolate, so every test acts as a distinct client.
  userRef = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
  ip = `203.0.113.${Math.floor(Math.random() * 250) + 1}`;
});

describe("POST /v1/messages", () => {
  it("stores and returns 201 with id and received_at, keeping Turkish text intact", async () => {
    const b = body();
    const res = await post(b);
    expect(res.status).toBe(201);
    const j = await res.json<{ id: string; received_at: string }>();
    const row = await env.DB.prepare("SELECT message, status, client_ts, last_activity_at FROM messages WHERE id=?")
      .bind(j.id)
      .first<{ message: string; status: string; client_ts: string | null; last_activity_at: string }>();
    expect(row!.message).toBe(b.message);
    expect(row!.status).toBe("pending");
    expect(row!.client_ts).toBeNull();
    expect(row!.last_activity_at).toBe(j.received_at);
  });
  it("is idempotent: same body -> 200 same id; different body -> 409", async () => {
    const b = body();
    const first = await (await post(b)).json<{ id: string }>();
    const again = await post(b);
    expect(again.status).toBe(200);
    expect((await again.json<{ id: string }>()).id).toBe(first.id);
    const changed = await post({ ...b, message: "different" });
    expect(changed.status).toBe(409);
    expect(await changed.json()).toMatchObject({ error: "idempotency_conflict", retryable: false });
    expect((await env.DB.prepare("SELECT COUNT(*) n FROM messages").first<{ n: number }>())!.n).toBe(1);
  });
  it("null user_ref falls back to (app, client_msg_id)", async () => {
    const b = { ...body(), user_ref: null };
    await post(b);
    expect((await post(b)).status).toBe(200);
  });
  it("413 before parsing when Content-Length or the body exceeds 16384 bytes", async () => {
    const big = JSON.stringify({ ...body(), message: "a".repeat(17000) });
    const res = await post(big);
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: "payload_too_large", retryable: false, max_bytes: 16384 });
    const lying = await post("{}", { headers: { "content-length": "99999" } });
    expect(lying.status).toBe(413);
  });
  it("401 without key, 403 when app field does not match the key's app", async () => {
    const noKey = new Request(url, { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
    expect((await worker.fetch(noKey, env, createExecutionContext())).status).toBe(401);
    const res = await post({ ...body(), app: "other" });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "app_mismatch" });
  });
  it("400 on malformed JSON and on validation failures, 415 on wrong content type", async () => {
    expect((await post("{not json")).status).toBe(400);
    const res = await post({ ...body(), platform: "tv" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_request", field: "platform", retryable: false });
    expect((await post(body(), { headers: { "content-type": "text/plain" } })).status).toBe(415);
  });
  it("403 images_disabled when attachments are sent to an app without images", async () => {
    const res = await post({ ...body(), attachments: [crypto.randomUUID()] });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "images_disabled" });
  });
  it("429 with Retry-After on the 4th message in a minute for one user_ref", async () => {
    for (let i = 0; i < 3; i++) expect((await post(body())).status).toBe(201);
    const res = await post(body());
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
    expect(await res.json()).toMatchObject({ error: "rate_limited", retryable: true });
  });
  it("CORS preflight succeeds only for an origin some app listed", async () => {
    await updateApp(env.DB, "demo", { allowed_origins: ["https://app.example"] });
    const pre = (origin: string) =>
      worker.fetch(new Request(url, { method: "OPTIONS", headers: { origin, "access-control-request-method": "POST" } }), env, createExecutionContext());
    const ok = await pre("https://app.example");
    expect(ok.status).toBe(204);
    expect(ok.headers.get("access-control-allow-origin")).toBe("https://app.example");
    const bad = await pre("https://evil.example");
    expect(bad.headers.get("access-control-allow-origin")).toBeNull();
  });
  it("returns 201 even though notification runs after the response, and the row records the attempt", async () => {
    const res = await post(body());
    expect(res.status).toBe(201);
    const { id } = await res.json<{ id: string }>();
    const row = await env.DB.prepare("SELECT notified_at, notify_attempts FROM messages WHERE id=?").bind(id).first<{ notified_at: string | null; notify_attempts: number }>();
    expect(row!.notify_attempts).toBe(1);
    expect(row!.notified_at).not.toBeNull();
  });
});
