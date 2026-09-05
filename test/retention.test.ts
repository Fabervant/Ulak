import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { createApp, updateApp } from "../src/core/apps";
import { insertMessage, getMessage } from "../src/core/messages";
import { addReply } from "../src/core/replies";
import { validateSubmit } from "../src/core/validate";
import { runScheduled } from "../src/core/retention";
import { addMinutes } from "../src/core/time";

const DAY = 24 * 60;
const NOW = "2026-06-01T00:00:00.000Z";
const mk = (app = "demo") =>
  validateSubmit({ app, app_version: "1", platform: "web", user_ref: "f3a9c2e1d4b5a6978877665544332211", message: "m", client_msg_id: crypto.randomUUID() });
const backdate = (id: string, iso: string) => env.DB.prepare("UPDATE messages SET received_at=?, last_activity_at=? WHERE id=?").bind(iso, iso, id).run();

describe("runScheduled: retention", () => {
  it("deletes messages past the app's retention measured from last activity, with their replies", async () => {
    await createApp(env.DB, "demo");
    const old = (await insertMessage(env.DB, mk(), "pending")).row;
    await backdate(old.id, addMinutes(NOW, -91 * DAY));
    await addReply(env.DB, old.id, "owner", "r"); // bumps last_activity_at to the real now: survives
    const dead = (await insertMessage(env.DB, mk(), "pending")).row;
    await backdate(dead.id, addMinutes(NOW, -91 * DAY));
    await addReply(env.DB, dead.id, "owner", "r");
    await backdate(dead.id, addMinutes(NOW, -91 * DAY)); // reply exists but activity is old: dies with its reply
    const fresh = (await insertMessage(env.DB, mk(), "pending")).row;
    await backdate(fresh.id, addMinutes(NOW, -89 * DAY));
    const r = await runScheduled(env, NOW);
    expect(r.expired).toBe(1);
    expect(await getMessage(env.DB, dead.id)).toBeNull();
    expect(await getMessage(env.DB, old.id)).not.toBeNull();
    expect(await getMessage(env.DB, fresh.id)).not.toBeNull();
    expect((await env.DB.prepare("SELECT COUNT(*) n FROM replies").first<{ n: number }>())!.n).toBe(1);
  });
  it("honours a shorter per-app retention", async () => {
    await createApp(env.DB, "demo");
    await updateApp(env.DB, "demo", { retention_days: 7 });
    const m = (await insertMessage(env.DB, mk(), "pending")).row;
    await backdate(m.id, addMinutes(NOW, -8 * DAY));
    expect((await runScheduled(env, NOW)).expired).toBe(1);
  });
  it("retries unnotified messages up to 5 attempts", async () => {
    await createApp(env.DB, "demo");
    const m = (await insertMessage(env.DB, mk(), "pending")).row;
    await env.DB.prepare("UPDATE messages SET notify_attempts=1, notify_error='x' WHERE id=?").bind(m.id).run();
    const r = await runScheduled(env); // NOTIFIER=none succeeds
    expect(r.retried).toBe(1);
    expect((await getMessage(env.DB, m.id))!.notified_at).not.toBeNull();
    const n = (await insertMessage(env.DB, mk(), "pending")).row;
    await env.DB.prepare("UPDATE messages SET notify_attempts=5, notify_error='x' WHERE id=?").bind(n.id).run();
    expect((await runScheduled(env)).retried).toBe(0);
  });
});
