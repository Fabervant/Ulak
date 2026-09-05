import { env, createExecutionContext } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import worker from "../src/api/index";
import { createApp } from "../src/core/apps";
import { insertMessage, setStatus, getMessage } from "../src/core/messages";
import { addReply } from "../src/core/replies";
import { validateSubmit } from "../src/core/validate";
import { statusLabel } from "../src/core/locales";

let key: string;
let U: string;
const hex = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
const mk = (over: Record<string, unknown> = {}) =>
  validateSubmit({ app: "demo", app_version: "1", platform: "web", user_ref: U, message: "hi", client_msg_id: crypto.randomUUID(), locale: "tr", ...over });
const get = (qs: string, headers: Record<string, string> = {}) =>
  worker.fetch(new Request(`https://api.example.invalid/v1/messages?${qs}`, { headers: { authorization: `Bearer ${key}`, ...headers } }), env, createExecutionContext());

beforeEach(async () => {
  key = (await createApp(env.DB, "demo")).key;
  U = hex(); // distinct client per test: the in-memory poll limiter is per isolate
});

describe("statusLabel", () => {
  it("localises known statuses and falls back to English, then to the key", () => {
    expect(statusLabel("pending", "tr-TR")).toBe("Bekliyor");
    expect(statusLabel("in_progress", "en")).toBe("In progress");
    expect(statusLabel("in_progress", "xx")).toBe("In progress");
    expect(statusLabel("custom_state", null)).toBe("custom_state");
  });
});

describe("GET /v1/messages", () => {
  it("returns only that user's messages for that app, with replies and localised status, never contact_email", async () => {
    const mine = (await insertMessage(env.DB, mk({ contact_email: "a@b.co", context: { k: 1 }, last_error: "boom" }), "pending")).row;
    await insertMessage(env.DB, mk({ user_ref: hex() }), "pending");
    await createApp(env.DB, "other");
    await insertMessage(env.DB, mk({ app: "other" }), "pending");
    await addReply(env.DB, mine.id, "owner", "Merhaba, bakıyoruz ş");
    const res = await get(`user_ref=${U}`);
    expect(res.status).toBe(200);
    const j = await res.json<{ messages: Array<Record<string, unknown> & { replies: Array<Record<string, unknown>> }>; cursor: string }>();
    expect(j.messages).toHaveLength(1);
    expect(j.messages[0]).toMatchObject({ id: mine.id, status: "pending", status_label: "Bekliyor", message: "hi" });
    expect(j.messages[0]!.replies[0]).toMatchObject({ sender_role: "owner", content: "Merhaba, bakıyoruz ş" });
    expect(JSON.stringify(j)).not.toContain("a@b.co");
    expect(JSON.stringify(j)).not.toContain("boom");
    expect(j.messages[0]!.context).toBeUndefined();
    expect(j.cursor).toBe((await getMessage(env.DB, mine.id))!.last_activity_at);
  });
  it("since cursor returns only newer activity; unknown user_ref is an empty 200", async () => {
    const a = (await insertMessage(env.DB, mk(), "pending")).row;
    const first = await (await get(`user_ref=${U}`)).json<{ cursor: string }>();
    const U2 = hex();
    void U2;
    // second poll of the same user in the minute would be 429; use a fresh user for the negative case below
    await setStatus(env.DB, a.id, "completed");
    const after = await (await get(`user_ref=${U}&since=${encodeURIComponent(first.cursor)}`)).json<{ messages: Array<{ status: string }> }>();
    expect(after.messages).toHaveLength(1);
    expect(after.messages[0]!.status).toBe("completed");
    const none = await get(`user_ref=${hex()}`);
    expect(none.status).toBe(200);
    expect((await none.json<{ messages: unknown[] }>()).messages).toEqual([]);
  });
  it("since strictly after the cursor yields nothing when nothing changed", async () => {
    await insertMessage(env.DB, mk(), "pending");
    const first = await (await get(`user_ref=${U}`)).json<{ cursor: string }>();
    const same = await (await get(`user_ref=${U}&since=${encodeURIComponent(first.cursor)}`)).json<{ messages: unknown[]; cursor: string }>();
    expect(same.messages).toHaveLength(0);
    expect(same.cursor).toBe(first.cursor);
  });
  it("ETag and 304", async () => {
    await insertMessage(env.DB, mk(), "pending");
    const r1 = await get(`user_ref=${U}`);
    const etag = r1.headers.get("etag")!;
    expect(etag).toBeTruthy();
    const r2 = await get(`user_ref=${U}`, { "if-none-match": etag });
    expect(r2.status).toBe(304);
  });
  it("400 on a missing or short user_ref, 429 on the third poll in a minute", async () => {
    expect((await get("")).status).toBe(400);
    expect((await get("user_ref=short")).status).toBe(400);
    await get(`user_ref=${U}`);
    await get(`user_ref=${U}`);
    const r = await get(`user_ref=${U}`);
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBe("60");
  });
});

describe("DELETE /v1/messages", () => {
  it("hard-deletes messages and replies for that user in that app only", async () => {
    const m = (await insertMessage(env.DB, mk(), "pending")).row;
    await addReply(env.DB, m.id, "owner", "x");
    await insertMessage(env.DB, mk({ user_ref: hex() }), "pending");
    const res = await worker.fetch(
      new Request(`https://api.example.invalid/v1/messages?user_ref=${U}`, { method: "DELETE", headers: { authorization: `Bearer ${key}` } }),
      env,
      createExecutionContext(),
    );
    expect(await res.json()).toEqual({ deleted_messages: 1 });
    expect((await env.DB.prepare("SELECT COUNT(*) n FROM messages").first<{ n: number }>())!.n).toBe(1);
    expect((await env.DB.prepare("SELECT COUNT(*) n FROM replies").first<{ n: number }>())!.n).toBe(0);
  });
});
