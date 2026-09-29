import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { createApp, updateApp } from "../src/core/apps";
import { insertMessage, getMessage } from "../src/core/messages";
import { getImage } from "../src/core/images";
import { createSession, readSession } from "../src/core/auth/session";
import { revokeSessions } from "../src/core/auth/admins";
import { createAdminToken, listAdminTokens } from "../src/core/auth/admintoken";
import { listReplies } from "../src/core/replies";
import { submission, pinAdmin, adminRequest, imageOnMessage, hex } from "./helpers";

// The callback tests need Google to answer. This file's copy of the production transport
// is a stub that this file programs; `test/seams.test.ts` still exercises the real one.
const { outbound } = vi.hoisted(() => ({ outbound: vi.fn<typeof fetch>() }));
vi.mock("../src/core/http", () => ({ defaultFetch: (...args: Parameters<typeof fetch>) => outbound(...args) }));

const E = { ...env, SESSION_SECRET: "s3", IMAGE_URL_SECRET: "i3" };
let key: string;
let cookie: string;
let csrf: string;
const mk = (over: Record<string, unknown> = {}) =>
  submission({ message: "<script>alert(1)</script> ışğİ", contact_email: "u@example.invalid", context: { screen: "<b>home</b>" }, ...over });

/** An admin-surface request carrying `session` as the session cookie; null sends none. */
const req = (path: string, init: RequestInit = {}, session: string | null = cookie, adminEnv: typeof env = E) =>
  adminRequest(adminEnv, path, session === null ? init : { ...init, headers: { cookie: `ulak_admin=${session}`, ...(init.headers as Record<string, string>) } });
const form = (path: string, fields: Record<string, string>) =>
  req(path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf, ...fields }).toString() });

/** The fresh session cookie a response sets, if any; a clearing one does not count. */
const sessionSet = (res: Response) => res.headers.getSetCookie().find((c) => c.startsWith("ulak_admin=") && !c.startsWith("ulak_admin=;"));
const sessionValue = (setCookie: string) => setCookie.split(";")[0]!.slice("ulak_admin=".length);
const cleared = (res: Response, name: string, path: string) =>
  res.headers.getSetCookie().find((c) => c.startsWith(`${name}=;`) && c.includes("Max-Age=0") && c.includes(`Path=${path}`));
const nowSec = () => Math.floor(Date.now() / 1000);
const hoursAgo = (h: number) => nowSec() - h * 3600;

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
// One signing key for the file: jose caches the key set it fetched, so a second key under the
// same id would be checked against the first.
const googleKey = generateKeyPair("RS256");
/** Programs Google to accept the next code exchange as "sub-1" with this nonce. */
async function googleSignsIn(nonce: string) {
  const { publicKey, privateKey } = await googleKey;
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  const idToken = await new SignJWT({ email: "a@example.invalid", email_verified: true, nonce })
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
}
const callback = (state: string, nonce: string, queryState = state, adminEnv: typeof env = E) =>
  req(`/auth/callback?state=${queryState}&code=c1`, { headers: { cookie: `ulak_oauth=${state}.${nonce}` } }, null, adminEnv);

beforeEach(async () => {
  outbound.mockReset();
  key = (await createApp(env.DB, "demo")).key;
  await pinAdmin("sub-1");
  cookie = await createSession("s3", "sub-1");
  csrf = (await readSession("s3", cookie))!.csrf;
});
afterEach(() => vi.unstubAllGlobals());

describe("admin surface", () => {
  it("redirects to login without a session; 403 with a session for an unpinned sub", async () => {
    const anon = await req("/", {}, null);
    expect(anon.status).toBe(302);
    expect(anon.headers.get("location")).toBe("/auth/login");
    expect((await req("/", {}, await createSession("s3", "sub-9"))).status).toBe(403);
  });
  it("login redirects to Google with state and nonce in a cookie", async () => {
    const res = await req("/auth/login", {}, null);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("https://accounts.google.com/o/oauth2/v2/auth?client_id=test-client-id");
    expect(res.headers.get("set-cookie")).toContain("ulak_oauth=");
  });
  it("lists messages grouped by app with pending counts and escapes content", async () => {
    await insertMessage(env.DB, mk(), "pending");
    const res = await req("/");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("demo");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("ışğİ");
    expect(html).toContain('class="badge pending">1<');
  });
  it("sends the full set of protective headers: no scripts, no framing, no foreign form targets", async () => {
    const res = await req("/");
    expect(res.headers.get("content-security-policy")).toBe(
      `default-src 'none'; style-src 'unsafe-inline'; img-src ${E.IMAGES_URL}; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
    );
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });
  it("detail shows context, email and last_error as text; an unknown id is 404", async () => {
    const m = (await insertMessage(env.DB, mk({ last_error: "<img src=x onerror=alert(1)>" }), "pending")).row;
    const html = await (await req(`/m/${m.id}`)).text();
    expect(html).toContain("u@example.invalid");
    expect(html).toContain("&lt;b&gt;home&lt;/b&gt;");
    expect(html).not.toContain("<img src=x");
    expect((await req(`/m/${crypto.randomUUID()}`)).status).toBe(404);
  });
  it("reply and status update the row; an unknown status is refused", async () => {
    const m = (await insertMessage(env.DB, mk(), "pending")).row;
    expect((await form(`/m/${m.id}/reply`, { content: "Merhaba, düzeltiyoruz." })).status).toBe(303);
    expect((await listReplies(env.DB, m.id))[0]!.content).toBe("Merhaba, düzeltiyoruz.");
    expect((await form(`/m/${m.id}/status`, { status: "in_progress" })).status).toBe(303);
    expect((await getMessage(env.DB, m.id))!.status).toBe("in_progress");
    expect((await form(`/m/${m.id}/status`, { status: "bogus" })).status).toBe(400);
  });
  it("rejects a form without the right csrf", async () => {
    const m = (await insertMessage(env.DB, mk(), "pending")).row;
    const res = await req(`/m/${m.id}/status`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "csrf=wrong&status=viewed" });
    expect(res.status).toBe(403);
    expect((await getMessage(env.DB, m.id))!.status).toBe("pending");
  });
  it("delete-user removes the sender's messages and their stored images", async () => {
    await updateApp(env.DB, "demo", { images_enabled: true });
    const { imageId, messageId } = await imageOnMessage(key, hex());
    const r2Key = (await getImage(env.DB, imageId))!.r2_key;
    expect((await form(`/m/${messageId}/delete-user`, {})).status).toBe(303);
    expect(await getMessage(env.DB, messageId)).toBeNull();
    expect(await getImage(env.DB, imageId)).toBeNull();
    expect(await env.IMAGES.get(r2Key)).toBeNull();
  });
  it("the apps page creates, updates and rotates an app", async () => {
    const created = await form("/apps", { id: "newapp", retention_days: "30" });
    expect(created.status).toBe(200);
    expect(await created.text()).toMatch(/ulak_newapp_[0-9a-f]{48}/);
    expect((await form("/apps", { id: "Bad Id", retention_days: "30" })).status).toBe(400);
    expect((await form("/apps/newapp", { retention_days: "45", images_enabled: "on", notify_enabled: "on", allowed_origins: "https://a.example" })).status).toBe(303);
    const row = await env.DB.prepare("SELECT retention_days, images_enabled, notify_enabled, allowed_origins FROM apps WHERE id='newapp'").first<{ retention_days: number; images_enabled: number; notify_enabled: number; allowed_origins: string }>();
    expect(row).toEqual({ retention_days: 45, images_enabled: 1, notify_enabled: 1, allowed_origins: '["https://a.example"]' });
    const rotated = await form("/apps/newapp/rotate", {});
    expect(await rotated.text()).toMatch(/ulak_newapp_[0-9a-f]{48}/);
  });
  it("the tokens page creates, lists and revokes an admin token", async () => {
    const tok = await form("/tokens", { name: "laptop" });
    expect(await tok.text()).toMatch(/ulak_admin_[0-9a-f]{48}/);
    expect(await (await req("/tokens")).text()).toContain("laptop");
    const [t] = await listAdminTokens(env.DB);
    expect((await form(`/tokens/${t!.id}/revoke`, {})).status).toBe(303);
    expect((await listAdminTokens(env.DB))[0]!.revoked_at).not.toBeNull();
  });
});

// A deployment missing its session secret must not let anyone in, nor hand out a session
// signed with nothing.
describe("without a session secret the panel fails closed", () => {
  const NoSecret = { ...E, SESSION_SECRET: undefined };

  it("every page is refused", async () => {
    expect((await req("/", {}, cookie, NoSecret)).status).toBe(403);
  });

  it("a sign-in Google accepted mints no session", async () => {
    await googleSignsIn("n1");
    const res = await callback("s1", "n1", "s1", NoSecret);
    expect(res.status).toBe(500);
    expect(await res.text()).toBe("SESSION_SECRET not configured");
    expect(sessionSet(res)).toBeUndefined();
  });
});

// The panel is server-rendered with a CSP that forbids scripts, so the browser-side stores a
// signed-in admin can leave behind are exactly these: the two cookies the panel sets, the HTTP
// cache, and the browser's own form-autofill memory. Sign-out has to empty all of them, and the
// sign-in that consumed the OAuth state must not leave that state lying around either.
describe("sign-out leaves the browser a stranger", () => {
  it("sign-out expires the session cookie and the OAuth state cookie on their own paths", async () => {
    const res = await form("/auth/logout", {});
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/auth/login");
    expect(cleared(res, "ulak_admin", "/")).toBeDefined();
    expect(cleared(res, "ulak_oauth", "/auth")).toBeDefined();
    expect(res.headers.getSetCookie()).toHaveLength(2);
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
    await createAdminToken(env.DB, "laptop");
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
    // No state cookie, or a state it does not match, is a request the cookie did not authorise:
    // nothing is spent, Google is not asked, the flow restarts.
    expect((await req("/auth/callback?state=x&code=y", {}, null)).status).toBe(400);
    const mismatch = await callback("s0", "n0", "forged");
    expect(mismatch.status).toBe(400);
    expect(mismatch.headers.getSetCookie()).toHaveLength(0);
    expect(outbound).not.toHaveBeenCalled();

    // The exchange fails after the state matched: the state is spent and the cookie goes with it.
    outbound.mockResolvedValueOnce(new Response("nope", { status: 500 }));
    const failed = await callback("s1", "n1");
    expect(failed.status).toBe(500);
    expect(cleared(failed, "ulak_oauth", "/auth")).toBeDefined();

    // The exchange succeeds: the session cookie is set and the state cookie is cleared in the same response.
    await googleSignsIn("n2");
    const ok = await callback("s2", "n2");
    expect(ok.status).toBe(302);
    expect(ok.headers.get("location")).toBe("/");
    expect(cleared(ok, "ulak_oauth", "/auth")).toBeDefined();
    expect(await readSession("s3", sessionValue(sessionSet(ok)!))).toMatchObject({ sub: "sub-1" });
    expect(outbound).toHaveBeenCalledTimes(2);
    expect(outbound.mock.calls[1]![0]).toBe("https://oauth2.googleapis.com/token");
  });
});

// The session follows the estate's own-auth shape: it ends 30 days after it was issued, is
// re-issued while the admin is active, and "Sign out everywhere" ends every copy of it at once.
describe("a session lives while used and can be ended everywhere", () => {
  it("a fresh session is left alone; an hour-old one comes back re-issued with the same csrf", async () => {
    expect(sessionSet(await req("/"))).toBeUndefined();
    cookie = await createSession("s3", "sub-1", { csrf, iat: hoursAgo(2) });
    const res = await req("/");
    expect(res.status).toBe(200);
    const renewed = sessionSet(res)!;
    expect(renewed).toContain("Max-Age=2592000");
    const s = (await readSession("s3", sessionValue(renewed)))!;
    expect(s.csrf).toBe(csrf);
    expect(s.iat).toBeGreaterThan(hoursAgo(0.1));
  });

  it("a session past its 30 days is refused, however recently it was used", async () => {
    cookie = await createSession("s3", "sub-1", { iat: hoursAgo(30 * 24 + 1) });
    expect((await req("/")).status).toBe(302);
  });

  it("both sign-outs clear both cookies, not re-issue, when the session was due for renewal", async () => {
    for (const path of ["/auth/logout", "/auth/logout-all"]) {
      cookie = await createSession("s3", "sub-1", { csrf, iat: hoursAgo(2) });
      const res = await form(path, {});
      expect(res.status, path).toBe(303);
      expect(res.headers.get("location"), path).toBe("/auth/login");
      expect(sessionSet(res), path).toBeUndefined();
      expect(cleared(res, "ulak_admin", "/"), path).toBeDefined();
      expect(cleared(res, "ulak_oauth", "/auth"), path).toBeDefined();
      expect(res.headers.getSetCookie(), path).toHaveLength(2);
    }
  });

  it("sign out everywhere ends this session and every other device's", async () => {
    const otherDevice = await createSession("s3", "sub-1", { iat: hoursAgo(5) });
    expect((await form("/auth/logout-all", {})).status).toBe(303);
    expect((await req("/")).status).toBe(302);
    expect((await req("/", {}, otherDevice)).status).toBe(302);
  });

  it("revocation takes every session issued up to and including its second, and none after", async () => {
    const T = nowSec() - 60;
    await revokeSessions(env.DB, "sub-1", T);
    expect((await req("/", {}, await createSession("s3", "sub-1", { iat: T }))).status).toBe(302);
    expect((await req("/", {}, await createSession("s3", "sub-1", { iat: T + 1 }))).status).toBe(200);
  });
});
