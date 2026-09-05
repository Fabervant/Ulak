import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import admin from "../src/admin/index";
import { createApp } from "../src/core/apps";
import { insertMessage, getMessage } from "../src/core/messages";
import { validateSubmit } from "../src/core/validate";
import { createSession, readSession } from "../src/core/auth/session";
import { listReplies } from "../src/core/replies";

const E = { ...env, SESSION_SECRET: "s3", IMAGE_URL_SECRET: "i3" };
let cookie: string;
let csrf: string;
const mk = (over: Record<string, unknown> = {}) =>
  validateSubmit({
    app: "demo",
    app_version: "1",
    platform: "web",
    user_ref: "f3a9c2e1d4b5a6978877665544332211",
    message: "<script>alert(1)</script> ışğİ",
    client_msg_id: crypto.randomUUID(),
    contact_email: "u@example.invalid",
    context: { screen: "<b>home</b>" },
    ...over,
  });
async function req(path: string, init: RequestInit = {}) {
  const ctx = createExecutionContext();
  const res = await admin.fetch(new Request(`https://admin.example.invalid${path}`, { ...init, headers: { cookie: `ulak_admin=${cookie}`, ...(init.headers as Record<string, string>) } }), E, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}
const form = (path: string, fields: Record<string, string>) =>
  req(path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf, ...fields }).toString() });

beforeEach(async () => {
  await createApp(env.DB, "demo");
  await env.DB.prepare("INSERT INTO admins (sub,email_at_pin,pinned_at) VALUES ('sub-1','a@example.invalid','2026-01-01T00:00:00.000Z')").run();
  cookie = await createSession("s3", "sub-1");
  csrf = (await readSession("s3", cookie))!.csrf;
});

describe("admin surface", () => {
  it("redirects to login without a session; 403 with a session for an unpinned sub", async () => {
    const anon = await admin.fetch(new Request("https://admin.example.invalid/"), E, createExecutionContext());
    expect(anon.status).toBe(302);
    expect(anon.headers.get("location")).toBe("/auth/login");
    const stranger = await admin.fetch(new Request("https://admin.example.invalid/", { headers: { cookie: `ulak_admin=${await createSession("s3", "sub-9")}` } }), E, createExecutionContext());
    expect(stranger.status).toBe(403);
  });
  it("login redirects to Google with state and nonce in a cookie", async () => {
    const res = await admin.fetch(new Request("https://admin.example.invalid/auth/login"), E, createExecutionContext());
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("https://accounts.google.com/o/oauth2/v2/auth?client_id=test-client-id");
    expect(res.headers.get("set-cookie")).toContain("ulak_oauth=");
    const cb = await admin.fetch(new Request("https://admin.example.invalid/auth/callback?state=x&code=y"), E, createExecutionContext());
    expect(cb.status).toBe(400);
  });
  it("lists messages grouped by app with pending counts, sends a strict CSP, and escapes content", async () => {
    await insertMessage(env.DB, mk(), "pending");
    const res = await req("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(res.headers.get("content-security-policy")).not.toContain("script-src");
    const html = await res.text();
    expect(html).toContain("demo");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("ışğİ");
    expect(html).toContain('class="badge pending">1<');
  });
  it("detail shows context, email and last_error as text; reply and status update the row", async () => {
    const m = (await insertMessage(env.DB, mk({ last_error: "<img src=x onerror=alert(1)>" }), "pending")).row;
    const html = await (await req(`/m/${m.id}`)).text();
    expect(html).toContain("u@example.invalid");
    expect(html).toContain("&lt;b&gt;home&lt;/b&gt;");
    expect(html).not.toContain("<img src=x");
    expect((await form(`/m/${m.id}/reply`, { content: "Merhaba, düzeltiyoruz." })).status).toBe(303);
    expect((await listReplies(env.DB, m.id))[0]!.content).toBe("Merhaba, düzeltiyoruz.");
    expect((await form(`/m/${m.id}/status`, { status: "in_progress" })).status).toBe(303);
    expect((await getMessage(env.DB, m.id))!.status).toBe("in_progress");
    expect((await form(`/m/${m.id}/status`, { status: "bogus" })).status).toBe(400);
    expect((await req(`/m/${crypto.randomUUID()}`)).status).toBe(404);
  });
  it("rejects a form without the right csrf", async () => {
    const m = (await insertMessage(env.DB, mk(), "pending")).row;
    const res = await req(`/m/${m.id}/status`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "csrf=wrong&status=viewed" });
    expect(res.status).toBe(403);
    expect((await getMessage(env.DB, m.id))!.status).toBe("pending");
  });
  it("delete-user removes the sender's data; apps and tokens pages work", async () => {
    const m = (await insertMessage(env.DB, mk(), "pending")).row;
    expect((await form(`/m/${m.id}/delete-user`, {})).status).toBe(303);
    expect(await getMessage(env.DB, m.id)).toBeNull();
    const created = await form("/apps", { id: "newapp", retention_days: "30" });
    expect(created.status).toBe(200);
    expect(await created.text()).toMatch(/ulak_newapp_[0-9a-f]{48}/);
    expect((await form("/apps", { id: "Bad Id", retention_days: "30" })).status).toBe(400);
    expect((await form("/apps/newapp", { retention_days: "45", images_enabled: "on", allowed_origins: "https://a.example" })).status).toBe(303);
    const row = await env.DB.prepare("SELECT retention_days, images_enabled, allowed_origins FROM apps WHERE id='newapp'").first<{ retention_days: number; images_enabled: number; allowed_origins: string }>();
    expect(row).toEqual({ retention_days: 45, images_enabled: 1, allowed_origins: '["https://a.example"]' });
    const rotated = await form("/apps/newapp/rotate", {});
    expect(await rotated.text()).toMatch(/ulak_newapp_[0-9a-f]{48}/);
    const tok = await form("/tokens", { name: "laptop" });
    expect(await tok.text()).toMatch(/ulak_admin_[0-9a-f]{48}/);
    const list = await (await req("/tokens")).text();
    expect(list).toContain("laptop");
    const id = (await env.DB.prepare("SELECT id FROM admin_tokens").first<{ id: string }>())!.id;
    expect((await form(`/tokens/${id}/revoke`, {})).status).toBe(303);
    expect((await env.DB.prepare("SELECT revoked_at FROM admin_tokens WHERE id=?").bind(id).first<{ revoked_at: string | null }>())!.revoked_at).not.toBeNull();
  });
  it("logout clears the cookie", async () => {
    const res = await form("/auth/logout", {});
    expect(res.status).toBe(303);
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
  });
});
