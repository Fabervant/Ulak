import { env, createExecutionContext } from "cloudflare:test";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createApp, updateApp, rotateNoticeKey } from "../src/core/apps";
import { runScheduled } from "../src/core/retention";
import { addMinutes, nowIso } from "../src/core/time";
import { NOTICE_DAILY_LIMIT, NOTICE_MAX_CHARS } from "../src/core/notices";

// The real TelegramNotifier runs; only its transport is this file's, so each test sees exactly
// what would have gone to Telegram.
const { outbound } = vi.hoisted(() => ({ outbound: vi.fn<typeof fetch>() }));
vi.mock("../src/core/http", () => ({ defaultFetch: (...args: Parameters<typeof fetch>) => outbound(...args) }));
// The API Worker is the test config's main module, loaded before this file's mock exists; a fresh
// import is the copy that sees the mock.
vi.resetModules();
const worker = (await import("../src/api/index")).default;

const E = { ...env, NOTIFIER: "telegram", TELEGRAM_BOT_TOKEN: "bot-token", TELEGRAM_CHAT_ID: "42" };
let appKey: string;
let key: string;

beforeEach(async () => {
  appKey = (await createApp(env.DB, "demo", { notify_enabled: true })).key;
  key = await rotateNoticeKey(env.DB, "demo");
  outbound.mockReset();
  outbound.mockImplementation(async () => new Response("{}", { status: 200 }));
});

const notify = (body: unknown, headers: Record<string, string> = {}, e: typeof env = E) =>
  worker.fetch(
    new Request("https://api.example.invalid/v1/notify", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
    e,
    createExecutionContext(),
  );
const sentTexts = () => outbound.mock.calls.map(([, init]) => JSON.parse(String(init!.body)) as { chat_id: string; text: string });
const counted = async () => (await env.DB.prepare("SELECT COUNT(*) n FROM notices").first<{ n: number }>())!.n;

describe("POST /v1/notify", () => {
  it("sends the text to the operator's chat, labelled with the app and without an admin link", async () => {
    const res = await notify({ text: "  Pick this week's theme: storms, elections or harvest.  " });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ id: expect.any(String) });
    expect(sentTexts()).toEqual([{ chat_id: "42", text: "[demo] Pick this week's theme: storms, elections or harvest.", disable_web_page_preview: true }]);
    expect(await counted()).toBe(1);
  });

  it("is off until the operator switches it on for the app", async () => {
    await updateApp(env.DB, "demo", { notify_enabled: false });
    const res = await notify({ text: "hello" });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "notify_disabled", retryable: false });
    expect(outbound).not.toHaveBeenCalled();
  });

  it("refuses any request a browser sent, even with a valid key", async () => {
    const res = await notify({ text: "hello" }, { origin: "https://app.example.invalid" });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "server_only", retryable: false });
    expect(outbound).not.toHaveBeenCalled();
  });

  it("takes only the app's notice key: the app key, which a web app ships in its page, is refused", async () => {
    for (const bearer of [appKey, "nope", ""]) {
      const res = await notify({ text: "hello" }, { authorization: `Bearer ${bearer}` });
      expect(res.status, bearer).toBe(401);
      expect(await res.json()).toMatchObject({ error: "invalid_notice_key", retryable: false });
    }
    expect(outbound).not.toHaveBeenCalled();
    const replaced = key;
    key = await rotateNoticeKey(env.DB, "demo");
    expect((await notify({ text: "hello" }, { authorization: `Bearer ${replaced}` })).status).toBe(401);
    expect((await notify({ text: "hello" })).status).toBe(201);
  });

  it("rejects a blank text and an over-long text before anything is sent; the length is counted after trimming", async () => {
    expect((await notify({ text: "   " })).status).toBe(400);
    expect((await notify({})).status).toBe(400);
    const long = await notify({ text: "ş".repeat(NOTICE_MAX_CHARS + 1) });
    expect(long.status).toBe(400);
    expect(await long.json()).toMatchObject({ error: "invalid_request", field: "text" });
    expect((await notify({ text: "ş".repeat(NOTICE_MAX_CHARS) })).status).toBe(201); // characters, not bytes
    expect((await notify({ text: `     ${"a".repeat(NOTICE_MAX_CHARS - 5)}\n\n\n\n\n` })).status).toBe(201);
    expect(outbound).toHaveBeenCalledTimes(2);
  });

  it("sends one line: line breaks and control characters cannot fake a second alert under another app's name", async () => {
    const res = await notify({ text: "ok\n\n[other] other 2.1 ios en\r\nMy account is locked\u0007‮ \tsee https://x.example" });
    expect(res.status).toBe(201);
    expect(sentTexts()[0]!.text).toBe("[demo] ok [other] other 2.1 ios en My account is locked see https://x.example");
  });

  it("holds the daily ceiling exactly under parallel requests", async () => {
    const results = await Promise.all(Array.from({ length: NOTICE_DAILY_LIMIT + 3 }, (_, i) => notify({ text: `n${i}` })));
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 201)).toHaveLength(NOTICE_DAILY_LIMIT);
    expect(statuses.filter((s) => s === 429)).toHaveLength(3);
    const refused = results.find((r) => r.status === 429)!;
    expect(await refused.json()).toMatchObject({ error: "rate_limited", retryable: true });
    expect(outbound).toHaveBeenCalledTimes(NOTICE_DAILY_LIMIT);
  });

  it("Retry-After is the wait until the oldest notice in the window leaves it", async () => {
    const now = nowIso();
    await env.DB.batch(
      Array.from({ length: NOTICE_DAILY_LIMIT }, (_, i) =>
        env.DB.prepare("INSERT INTO notices (id,app,created_at) VALUES (?,'demo',?)").bind(`n${i}`, addMinutes(now, -20 * 60 + i)),
      ),
    );
    const res = await notify({ text: "hello" });
    expect(res.status).toBe(429);
    const wait = Number(res.headers.get("retry-after"));
    expect(wait).toBeGreaterThan(4 * 3600 - 30);
    expect(wait).toBeLessThanOrEqual(4 * 3600 + 1);
  });

  it("still answers a retryable 503 when giving the place back fails too", async () => {
    outbound.mockImplementation(async () => new Response("bad gateway", { status: 502 }));
    const brokenDelete = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "prepare") {
          return (sql: string) =>
            sql.startsWith("DELETE FROM notices") ? { bind: () => ({ run: async () => { throw new Error("database unavailable"); } }) } : target.prepare(sql);
        }
        const v = Reflect.get(target, prop) as unknown;
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    const res = await notify({ text: "hello" }, {}, { ...E, DB: brokenDelete });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "notifier_unavailable", retryable: true });
  });

  it("a Telegram channel missing its secrets is unconfigured, not unavailable, and spends nothing", async () => {
    const res = await notify({ text: "hello" }, {}, { ...E, TELEGRAM_CHAT_ID: undefined });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "notifier_unconfigured", retryable: false });
    expect(await counted()).toBe(0);
    expect(outbound).not.toHaveBeenCalled();
  });

  it("answers a retryable 503 when Telegram refuses, and gives the place in the ceiling back", async () => {
    outbound.mockImplementation(async () => new Response("bad gateway", { status: 502 }));
    const res = await notify({ text: "hello" });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "notifier_unavailable", retryable: true });
    expect(await counted()).toBe(0);
  });

  it("answers a non-retryable 503 on an instance with no notification channel", async () => {
    const res = await notify({ text: "hello" }, {}, { ...E, NOTIFIER: "none" });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "notifier_unconfigured", retryable: false });
    expect(await counted()).toBe(0);
  });

  it("the hourly job drops counts older than a day and keeps the rest", async () => {
    const now = nowIso();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO notices (id,app,created_at) VALUES ('old','demo',?)").bind(addMinutes(now, -24 * 60 - 1)),
      env.DB.prepare("INSERT INTO notices (id,app,created_at) VALUES ('new','demo',?)").bind(addMinutes(now, -60)),
    ]);
    expect((await runScheduled(env, now)).purged_notices).toBe(1);
    expect((await env.DB.prepare("SELECT id FROM notices").all<{ id: string }>()).results).toEqual([{ id: "new" }]);
  });
});
