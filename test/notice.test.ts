import { env, createExecutionContext } from "cloudflare:test";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createApp, updateApp } from "../src/core/apps";
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
let key: string;

beforeEach(async () => {
  key = (await createApp(env.DB, "demo", { notify_enabled: true })).key;
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

  it("rejects a missing key, a blank text and an over-long text before anything is sent", async () => {
    expect((await notify({ text: "hello" }, { authorization: "Bearer nope" })).status).toBe(401);
    expect((await notify({ text: "   " })).status).toBe(400);
    expect((await notify({})).status).toBe(400);
    const long = await notify({ text: "ş".repeat(NOTICE_MAX_CHARS + 1) });
    expect(long.status).toBe(400);
    expect(await long.json()).toMatchObject({ error: "invalid_request", field: "text" });
    expect((await notify({ text: "ş".repeat(NOTICE_MAX_CHARS) })).status).toBe(201); // characters, not bytes
    expect(outbound).toHaveBeenCalledTimes(1);
  });

  it("holds the daily ceiling exactly under parallel requests", async () => {
    const results = await Promise.all(Array.from({ length: NOTICE_DAILY_LIMIT + 3 }, (_, i) => notify({ text: `n${i}` })));
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 201)).toHaveLength(NOTICE_DAILY_LIMIT);
    expect(statuses.filter((s) => s === 429)).toHaveLength(3);
    const refused = results.find((r) => r.status === 429)!;
    expect(refused.headers.get("retry-after")).toBe("3600");
    expect(await refused.json()).toMatchObject({ error: "rate_limited", retryable: true });
    expect(outbound).toHaveBeenCalledTimes(NOTICE_DAILY_LIMIT);
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
