import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, beforeEach, vi } from "vitest";
import admin from "../src/admin/index";
import { createApp } from "../src/core/apps";
import { insertMessage, getMessage } from "../src/core/messages";
import { validateSubmit } from "../src/core/validate";
import { createSession, readSession } from "../src/core/auth/session";
import { listReplies } from "../src/core/replies";

// The callback test below needs Google to answer. This file's copy of the production transport
// is a stub that this file programs; `test/seams.test.ts` still exercises the real one.
const { outbound } = vi.hoisted(() => ({ outbound: vi.fn<typeof fetch>() }));
vi.mock("../src/core/http", () => ({ defaultFetch: (...args: Parameters<typeof fetch>) => outbound(...args) }));

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
});

// The panel is server-rendered with a CSP that forbids scripts, so the browser-side stores a
// signed-in admin can leave behind are exactly these: the two cookies the panel sets, the HTTP
// cache, and the browser's own form-autofill memory. Sign-out has to empty all of them, and the
// sign-in that consumed the OAuth state must not leave that state lying around either.
describe("sign-out leaves the browser a stranger", () => {
  const setCookies = (res: Response) => res.headers.getSetCookie();
  const cleared = (cookies: string[], name: string, path: string) => cookies.find((c) => c.startsWith(`${name}=;`) && c.includes("Max-Age=0") && c.includes(`Path=${path}`));

  it("sign-out expires the session cookie and the OAuth state cookie on their own paths", async () => {
    const res = await form("/auth/logout", {});
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/auth/login");
    const cookies = setCookies(res);
    expect(cleared(cookies, "ulak_admin", "/")).toBeDefined();
    expect(cleared(cookies, "ulak_oauth", "/auth")).toBeDefined();
    expect(cookies).toHaveLength(2);
  });

  it("every response is no-store, so nothing the admin saw sits in the HTTP cache", async () => {
    for (const path of ["/", "/apps", "/tokens", "/auth/login"]) {
      const res = await req(path);
      expect(res.headers.get("cache-control"), path).toBe("no-store");
    }
    expect((await form("/auth/logout", {})).headers.get("cache-control")).toBe("no-store");
  });

  it("every form that takes typed text opts out of browser autofill", async () => {
    const m = (await insertMessage(env.DB, mk(), "pending")).row;
    await env.DB.prepare("INSERT INTO admin_tokens (id,name,token_hash,created_at) VALUES ('t1','laptop','h','2026-01-01T00:00:00.000Z')").run();
    for (const path of ["/", "/apps", "/tokens", `/m/${m.id}`]) {
      const html = await (await req(path)).text();
      // Split on form tags; each chunk starts with that form's attributes and holds its fields.
      for (const chunk of html.split("<form").slice(1)) {
        const tag = chunk.slice(0, chunk.indexOf(">"));
        const fields = chunk.slice(0, chunk.indexOf("</form>"));
        const typed = /<(input(?![^>]*type="(hidden|checkbox)")|textarea)/.test(fields);
        if (typed) expect(tag, `${path}: <form${tag}>`).toContain('autocomplete="off"');
      }
    }
  });

  it("the callback consumes the OAuth state cookie whether the exchange succeeds or fails", async () => {
    const { generateKeyPair, exportJWK, SignJWT } = await import("jose");
    const cb = (state: string, nonce: string, queryState = state) =>
      admin.fetch(new Request(`https://admin.example.invalid/auth/callback?state=${queryState}&code=c1`, { headers: { cookie: `ulak_oauth=${state}.${nonce}` } }), E, createExecutionContext());
    const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

    // A state mismatch is a request the cookie did not authorise: the cookie stays, the flow restarts.
    const mismatch = await cb("s0", "n0", "forged");
    expect(mismatch.status).toBe(400);
    expect(setCookies(mismatch)).toHaveLength(0);
    expect(outbound).not.toHaveBeenCalled();

    // The exchange fails after the state matched: the state is spent and the cookie goes with it.
    outbound.mockResolvedValueOnce(new Response("nope", { status: 500 }));
    const failed = await cb("s1", "n1");
    expect(failed.status).toBe(500);
    expect(cleared(setCookies(failed), "ulak_oauth", "/auth")).toBeDefined();

    // The exchange succeeds: the session cookie is set and the state cookie is cleared in the same response.
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" };
    const idToken = await new SignJWT({ email: "a@example.invalid", email_verified: true, nonce: "n2" })
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer("https://accounts.google.com")
      .setAudience(E.GOOGLE_CLIENT_ID ?? "")
      .setSubject("sub-1")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
    outbound.mockResolvedValueOnce(json({ id_token: idToken }));
    // jose fetches the key set through the global fetch, not through Ulak's transport.
    vi.stubGlobal("fetch", vi.fn(async () => json({ keys: [jwk] })));
    try {
      const ok = await cb("s2", "n2");
      expect(ok.status).toBe(302);
      expect(ok.headers.get("location")).toBe("/");
      const cookies = setCookies(ok);
      expect(cleared(cookies, "ulak_oauth", "/auth")).toBeDefined();
      const session = cookies.find((c) => c.startsWith("ulak_admin=") && !c.startsWith("ulak_admin=;"));
      expect(session).toBeDefined();
      expect(await readSession("s3", session!.split(";")[0]!.slice("ulak_admin=".length))).toMatchObject({ sub: "sub-1" });
      expect(outbound).toHaveBeenCalledTimes(2);
      expect(outbound.mock.calls[1]![0]).toBe("https://oauth2.googleapis.com/token");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
