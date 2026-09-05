import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { buildNotification, type Notifier } from "../src/core/notify/notifier";
import { TelegramNotifier } from "../src/core/notify/telegram";
import { notifyMessage } from "../src/core/notify/dispatch";
import { createApp } from "../src/core/apps";
import { insertMessage, getMessage } from "../src/core/messages";
import { validateSubmit } from "../src/core/validate";

const seed = async () => {
  await createApp(env.DB, "demo");
  const p = validateSubmit({
    app: "demo",
    app_version: "2.1",
    platform: "ios",
    user_ref: "f3a9c2e1d4b5a6978877665544332211",
    message: "Şifremi unuttum, İstanbul'dan yazıyorum ğüşıöç",
    client_msg_id: crypto.randomUUID(),
    locale: "tr-TR",
  });
  return (await insertMessage(env.DB, p, "pending")).row;
};

describe("buildNotification", () => {
  it("carries app, version, platform, locale, text and an admin link, unmangled", async () => {
    const row = await seed();
    const n = buildNotification(row, "https://admin.example.invalid");
    expect(n.text).toContain("demo 2.1 ios tr-TR");
    expect(n.text).toContain("ğüşıöç");
    expect(n.adminLink).toBe(`https://admin.example.invalid/m/${row.id}`);
  });
  it("truncates long text", async () => {
    const row = { ...(await seed()), message: "x".repeat(5000) };
    expect(buildNotification(row, "https://a").text.length).toBeLessThan(1200);
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
