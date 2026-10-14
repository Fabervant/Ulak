import { env, createExecutionContext } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import worker from "../src/api/index";
import { createApp } from "../src/core/apps";
import { insertMessage, setStatus, getMessage } from "../src/core/messages";
import { addReply } from "../src/core/replies";
import { statusLabel } from "../src/core/locales";
import { hex, submission } from "./helpers";

let key: string;
let U: string;
const mk = (over: Record<string, unknown> = {}) => submission({ user_ref: U, message: "hi", locale: "tr", ...over });
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
  // Seeds n messages for U, the i-th last active i seconds after `from`, or all at `from` when tied.
  const seed = (n: number, from: string, tied = false, prefix = "s") =>
    env.DB.prepare(
      `WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM k WHERE i<?1)
       INSERT INTO messages (id,app,user_ref,app_version,platform,message,client_msg_id,body_hash,status,received_at,last_activity_at)
       SELECT printf('%s-%04d',?4,i),'demo',?3,'1','web',printf('m%d',i),printf('%s-%04d',?4,i),'h','pending',?2,
              strftime('%Y-%m-%dT%H:%M:%fZ', ?2, '+' || (CASE WHEN ?5 THEN 0 ELSE i END) || ' seconds') FROM k`,
    )
      .bind(n, from, U, prefix, tied ? 1 : 0)
      .run();
  type Listed = { messages: Array<{ id: string; last_activity_at: string }>; cursor: string };

  it("without since, a user past 200 messages gets the newest 200, oldest first, never the oldest 200", async () => {
    await seed(250, "2026-01-01T00:00:00.000Z");
    const j = await (await get(`user_ref=${U}`)).json<Listed>();
    expect(j.messages).toHaveLength(200);
    expect(j.messages[0]!.id).toBe("s-0051");
    expect(j.messages[199]!.id).toBe("s-0250");
    expect(j.cursor).toBe(j.messages[199]!.last_activity_at);
  });

  it("a page never splits messages that share one last activity, so the cursor skips none", async () => {
    await seed(199, "2026-01-01T00:00:00.000Z");
    await seed(3, "2026-02-01T00:00:00.000Z", true, "t");
    const page = await (await get(`user_ref=${U}&since=2025-12-31T00:00:00.000Z`)).json<Listed>();
    expect(page.messages).toHaveLength(202);
    expect(page.messages.slice(-3).map((m) => m.id)).toEqual(["t-0001", "t-0002", "t-0003"]);
    expect(page.cursor).toBe("2026-02-01T00:00:00.000Z");
    expect((await (await get(`user_ref=${U}&since=${encodeURIComponent(page.cursor)}`)).json<Listed>()).messages).toHaveLength(0);
  });

  it("a since page holds at most 200 when no tie widens it, and the cursor picks up the rest", async () => {
    await seed(250, "2026-01-01T00:00:00.000Z");
    const first = await (await get(`user_ref=${U}&since=2025-12-31T00:00:00.000Z`)).json<Listed>();
    expect(first.messages).toHaveLength(200);
    expect(first.messages[199]!.id).toBe("s-0200");
    const rest = await (await get(`user_ref=${U}&since=${encodeURIComponent(first.cursor)}`)).json<Listed>();
    expect(rest.messages.map((m) => m.id)).toEqual(Array.from({ length: 50 }, (_, i) => `s-${String(i + 201).padStart(4, "0")}`));
  });

  it("since names an instant: without milliseconds or with an offset it reads the same rows", async () => {
    await seed(3, "2026-01-01T00:00:00.000Z");
    // 03:00:01+03:00 is 00:00:01Z, so the messages one and two seconds later follow it.
    const j = await (await get(`user_ref=${U}&since=${encodeURIComponent("2026-01-01T03:00:01+03:00")}`)).json<Listed>();
    expect(j.messages.map((m) => m.id)).toEqual(["s-0002", "s-0003"]);
  });

  it("since cursor returns only newer activity; unknown user_ref is an empty 200", async () => {
    const a = (await insertMessage(env.DB, mk(), "pending")).row;
    const first = await (await get(`user_ref=${U}`)).json<{ cursor: string }>();
    const U2 = hex();
    void U2;
    // second poll of the same user in the minute would be 429; use a fresh user for the negative case below
    await setStatus(env.DB, a.id, "completed", ["completed"]);
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
  it("ETag and 304; a read is no-store, so no cache keeps one user's messages", async () => {
    await insertMessage(env.DB, mk(), "pending");
    const r1 = await get(`user_ref=${U}`);
    expect(r1.headers.get("cache-control")).toBe("no-store");
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
