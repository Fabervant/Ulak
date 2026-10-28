import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";

describe("schema", () => {
  it("has the six tables", async () => {
    const r = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('apps','messages','replies','images','admins','admin_tokens') ORDER BY name",
    ).all<{ name: string }>();
    expect(r.results.map((x) => x.name)).toEqual(["admin_tokens", "admins", "apps", "images", "messages", "replies"]);
  });
  it("has the mail tables and the apps' mail columns", async () => {
    const t = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('mails','mail_attempts','service_state') ORDER BY name").all<{ name: string }>();
    expect(t.results.map((x) => x.name)).toEqual(["mail_attempts", "mails", "service_state"]);
    const cols = (await env.DB.prepare("PRAGMA table_info(apps)").all<{ name: string }>()).results.map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(["send_key_hash", "mail_from_name", "mail_kinds", "mail_labels"]));
  });
  it("one idempotency key per app while it is set", async () => {
    const now = "2026-01-01T00:00:00.000Z";
    await env.DB.prepare("INSERT INTO apps (id,key_hash,created_at) VALUES ('demo','h',?)").bind(now).run();
    const ins = (id: string, key: string | null) =>
      env.DB.prepare("INSERT INTO mails (id,app,kind,label,locale,addr_hash,idempotency_key,status,expires_at,created_at,last_activity_at) VALUES (?,'demo','transactional','l','en','h',?,'sent',?,?,?)")
        .bind(id, key, now, now, now)
        .run();
    await ins("a", "k");
    await expect(ins("b", "k")).rejects.toThrow(/UNIQUE/);
    await ins("c", null);
    await ins("d", null);
  });
  it("idempotency index treats null user_ref as one bucket", async () => {
    const now = "2026-01-01T00:00:00.000Z";
    await env.DB.prepare("INSERT INTO apps (id,key_hash,created_at) VALUES ('demo','h',?)").bind(now).run();
    const ins = (id: string) =>
      env.DB.prepare(
        "INSERT INTO messages (id,app,app_version,platform,user_ref,message,client_msg_id,body_hash,status,received_at,last_activity_at) VALUES (?,'demo','1','web',NULL,'m','cm-1','b','pending',?,?)",
      )
        .bind(id, now, now)
        .run();
    await ins("a");
    await expect(ins("b")).rejects.toThrow(/UNIQUE/);
  });
  it("deleting a message cascades to its replies", async () => {
    const now = "2026-01-01T00:00:00.000Z";
    await env.DB.prepare("INSERT INTO apps (id,key_hash,created_at) VALUES ('demo','h',?)").bind(now).run();
    await env.DB.prepare(
      "INSERT INTO messages (id,app,app_version,platform,message,client_msg_id,body_hash,status,received_at,last_activity_at) VALUES ('m1','demo','1','web','m','cm-1','b','pending',?,?)",
    )
      .bind(now, now)
      .run();
    await env.DB.prepare("INSERT INTO replies (id,message_id,sender_role,content,created_at) VALUES ('r1','m1','owner','x',?)").bind(now).run();
    await env.DB.prepare("DELETE FROM messages WHERE id='m1'").run();
    const n = await env.DB.prepare("SELECT COUNT(*) n FROM replies").first<{ n: number }>();
    expect(n!.n).toBe(0);
  });
});
