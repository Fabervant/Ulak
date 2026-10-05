import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { buildNotification, type Notifier } from "../src/core/notify/notifier";
import { TelegramNotifier } from "../src/core/notify/telegram";
import { notifyMessage } from "../src/core/notify/dispatch";
import { createApp } from "../src/core/apps";
import { insertMessage, getMessage } from "../src/core/messages";
import { submission } from "./helpers";

const seed = async () => {
  await createApp(env.DB, "demo");
  const p = submission({ app_version: "2.1", platform: "ios", message: "Şifremi unuttum, İstanbul'dan yazıyorum ğüşıöç", locale: "tr-TR" });
  return (await insertMessage(env.DB, p, "pending")).row;
};

describe("buildNotification", () => {
  // Telegram is outside the controller's country: the notice says that something arrived and
  // where to read it, and carries nothing the user wrote or the device reported.
  it("carries only the app, the platform and an admin link", async () => {
    const row = { ...(await seed()), last_error: "TypeError at checkout" };
    const n = buildNotification(row, "https://admin.example.invalid/");
    expect(n.text).toBe("[demo] new message (ios)");
    expect(n.adminLink).toBe(`https://admin.example.invalid/m/${row.id}`);
  });
  it("names a crash report without a message as one", async () => {
    const row = { ...(await seed()), message: "" };
    expect(buildNotification(row, "https://a").text).toBe("[demo] new crash report (ios)");
  });
});

describe("TelegramNotifier", () => {
  it("posts JSON to the bot API and surfaces a non-ok response as an error", async () => {
    const calls: Array<{ url: string; body: { chat_id: string; text: string; disable_web_page_preview: boolean } }> = [];
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(init.body as string) });
      return new Response('{"ok":true}', { status: 200 });
    }) as unknown as typeof fetch;
    const t = new TelegramNotifier("TOKEN", "CHAT", fake);
    await t.send({ text: "merhaba ışğİ", adminLink: "https://a/m/1" });
    expect(calls[0]!.url).toBe("https://api.telegram.org/botTOKEN/sendMessage");
    expect(calls[0]!.body).toMatchObject({ chat_id: "CHAT", disable_web_page_preview: true });
    expect(calls[0]!.body.text).toContain("ışğİ");
    expect(calls[0]!.body.text).toContain("https://a/m/1");
    const failing = new TelegramNotifier("T", "C", (async () => new Response("nope", { status: 401 })) as unknown as typeof fetch);
    await expect(failing.send({ text: "x", adminLink: "y" })).rejects.toThrow(/401/);
  });
});

describe("notifyMessage", () => {
  it("records notified_at on success", async () => {
    const row = await seed();
    const ok: Notifier = { send: async () => {} };
    await notifyMessage(env, row, ok);
    const after = (await getMessage(env.DB, row.id))!;
    expect(after.notified_at).not.toBeNull();
    expect(after.notify_error).toBeNull();
    expect(after.notify_attempts).toBe(1);
  });
  it("records notify_error, keeps the message, never throws", async () => {
    const row = await seed();
    const bad: Notifier = {
      send: async () => {
        throw new Error("telegram down");
      },
    };
    await expect(notifyMessage(env, row, bad)).resolves.toBeUndefined();
    const after = (await getMessage(env.DB, row.id))!;
    expect(after.notified_at).toBeNull();
    expect(after.notify_error).toContain("telegram down");
    expect(after.notify_attempts).toBe(1);
    expect(after.message).toBe(row.message);
  });
});

describe("TelegramNotifier default transport", () => {
  // The default fetchImpl is the only part of this class no injected mock ever exercises.
  // An unbound global fetch works when called as a bare function but throws "Illegal
  // invocation" the moment it is stored on an object and called as a method, which is
  // exactly how send() calls it. Bound, it fails on DNS instead. Either way it rejects;
  // only the reason distinguishes a correct default from a broken one.
  it("binds fetch to the global scope so calling it as a method reaches the network", async () => {
    const notifier = new TelegramNotifier("token", "chat");
    const holder = { impl: (notifier as unknown as { fetchImpl: typeof fetch }).fetchImpl };
    let reason = "";
    try {
      await holder.impl("https://ulak-binding-probe.invalid/");
    } catch (e) {
      reason = e instanceof Error ? e.message : String(e);
    }
    expect(reason).not.toMatch(/illegal invocation/i);
  });
});
