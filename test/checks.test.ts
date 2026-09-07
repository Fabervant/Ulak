import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { createApp } from "../src/core/apps";
import { insertMessage } from "../src/core/messages";
import { validateSubmit } from "../src/core/validate";
import { runChecks } from "../src/core/checks";
import { addMinutes, nowIso } from "../src/core/time";
import { createAdminToken, verifyAdminToken, revokeAdminToken } from "../src/core/auth/admintoken";

const mk = () => validateSubmit({ app: "demo", app_version: "1", platform: "web", user_ref: null, message: "m", client_msg_id: crypto.randomUUID() });

describe("runChecks", () => {
  it("is green on an empty store and on a freshly notified row", async () => {
    await createApp(env.DB, "demo");
    expect((await runChecks(env.DB)).ok).toBe(true);
    const m = (await insertMessage(env.DB, mk(), "pending")).row;
    await env.DB.prepare("UPDATE messages SET notified_at=? WHERE id=?").bind(nowIso(), m.id).run();
    expect((await runChecks(env.DB)).ok).toBe(true);
  });
  it("goes RED on a planted unnotified row older than 10 minutes", async () => {
    await createApp(env.DB, "demo");
    const m = (await insertMessage(env.DB, mk(), "pending")).row;
    await env.DB.prepare("UPDATE messages SET received_at=? WHERE id=?").bind(addMinutes(nowIso(), -11), m.id).run();
    const r = await runChecks(env.DB);
    expect(r.ok).toBe(false);
    expect(r.unnotified_over_10m).toBe(1);
  });
  it("reports stored image count and bytes without changing ok", async () => {
    await createApp(env.DB, "demo");
    const empty = await runChecks(env.DB);
    expect(empty.stored_images).toBe(0);
    expect(empty.stored_image_bytes).toBe(0);
    const put = (id: string, bytes: number) =>
      env.DB.prepare(
        "INSERT INTO images (id,app,message_id,user_ref,r2_key,content_type,bytes,width,height,created_at) VALUES (?,?,NULL,NULL,?,?,?,?,?,?)",
      )
        .bind(id, "demo", `k/${id}`, "image/jpeg", bytes, 10, 10, nowIso())
        .run();
    await put(crypto.randomUUID(), 1200);
    await put(crypto.randomUUID(), 3400);
    const after = await runChecks(env.DB);
    expect(after.stored_images).toBe(2);
    expect(after.stored_image_bytes).toBe(4600);
    // Storage is reported, never a failure condition: fresh unclaimed images are not a breach.
    expect(after.ok).toBe(true);
  });
  it("goes RED on a planted row past retention", async () => {
    await createApp(env.DB, "demo");
    const m = (await insertMessage(env.DB, mk(), "pending")).row;
    const old = addMinutes(nowIso(), -91 * 24 * 60);
    await env.DB.prepare("UPDATE messages SET received_at=?, last_activity_at=?, notified_at=? WHERE id=?").bind(old, old, old, m.id).run();
    const r = await runChecks(env.DB);
    expect(r.ok).toBe(false);
    expect(r.past_retention).toBe(1);
  });
});

describe("admin tokens", () => {
  it("creates, verifies, records last use, revokes", async () => {
    const { id, token } = await createAdminToken(env.DB, "laptop");
    expect(token).toMatch(/^ulak_admin_[0-9a-f]{48}$/);
    expect((await verifyAdminToken(env.DB, token))!.name).toBe("laptop");
    const row = await env.DB.prepare("SELECT token_hash, last_used_at FROM admin_tokens WHERE id=?").bind(id).first<{ token_hash: string; last_used_at: string | null }>();
    expect(row!.token_hash).not.toContain(token);
    expect(row!.last_used_at).not.toBeNull();
    expect(await verifyAdminToken(env.DB, "ulak_admin_" + "0".repeat(48))).toBeNull();
    await revokeAdminToken(env.DB, id);
    expect(await verifyAdminToken(env.DB, token)).toBeNull();
  });
});
