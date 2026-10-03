import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { createApp, updateApp } from "../src/core/apps";
import { insertMessage, getMessage } from "../src/core/messages";
import { addReply } from "../src/core/replies";
import { runScheduled } from "../src/core/retention";
import { addMinutes } from "../src/core/time";
import { submission, withD1ParamLimit, seedMessages } from "./helpers";

const DAY = 24 * 60;
const NOW = "2026-06-01T00:00:00.000Z";
const mk = (app = "demo") => submission({ app });
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
  it("expires more messages in one run than one statement may bind, with every image they carry", async () => {
    await createApp(env.DB, "demo");
    const ids = await seedMessages(150, addMinutes(NOW, -91 * DAY));
    await env.DB.prepare("INSERT INTO images (id,app,message_id,user_ref,r2_key,content_type,bytes,width,height,created_at) VALUES ('i1','demo',?,NULL,'img/demo/i1','image/png',1,1,1,?)").bind(ids[149], NOW).run();
    await env.IMAGES.put("img/demo/i1", "x");
    const r = await runScheduled({ ...env, DB: withD1ParamLimit(env.DB) }, NOW);
    expect(r.expired).toBe(150);
    expect((await env.DB.prepare("SELECT COUNT(*) n FROM messages").first<{ n: number }>())!.n).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) n FROM images").first<{ n: number }>())!.n).toBe(0);
    expect(await env.IMAGES.get("img/demo/i1")).toBeNull();
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
