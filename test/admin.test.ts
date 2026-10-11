import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { createApp, updateApp, findAppByKey } from "../src/core/apps";
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
/** Follows a post that made a key or token: the page it redirects to, opened with the cookie the
 *  post set, shows the secret once and expires that cookie. */
const reveal = async (res: Response) => {
  expect(res.status).toBe(303);
  const set = res.headers.getSetCookie().find((c) => c.startsWith("ulak_reveal=") && !c.startsWith("ulak_reveal=;"))!;
  expect(set).toMatch(/HttpOnly; Secure; SameSite=Strict; Path=\/; Max-Age=60$/);
  const value = set.split(";")[0]!.slice("ulak_reveal=".length);
  const page = await req(res.headers.get("location")!, { headers: { cookie: `ulak_admin=${cookie}; ulak_reveal=${value}` } });
  expect(page.status).toBe(200);
  expect(cleared(page, "ulak_reveal", "/")).toBeDefined();
  return { value, text: await page.text() };
};
const nowSec = () => Math.floor(Date.now() / 1000);
const hoursAgo = (h: number) => nowSec() - h * 3600;

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
// One signing key for the file: jose caches the key set it fetched, so a second key under the
// same id would be checked against the first.
const googleKey = generateKeyPair("RS256");
/** Programs Google to accept the next code exchange as `sub` (the pinned admin by default) with this nonce. */
async function googleSignsIn(nonce: string, sub = "sub-1", email = "a@example.invalid", emailVerified = true) {
  const { publicKey, privateKey } = await googleKey;
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  const idToken = await new SignJWT({ email, email_verified: emailVerified, nonce })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer("https://accounts.google.com")
    .setAudience(E.GOOGLE_CLIENT_ID ?? "")
    .setSubject(sub)
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
    // Each sign-in gets its own state and nonce, and Google is sent exactly the ones the cookie holds.
    const pair = async () => {
      const r = await req("/auth/login", {}, null);
      const q = new URL(r.headers.get("location")!).searchParams;
      expect(r.headers.get("set-cookie")).toContain(`ulak_oauth=${q.get("state")}.${q.get("nonce")};`);
      return [q.get("state"), q.get("nonce")];
    };
    const [a, b] = [await pair(), await pair()];
    expect(a[0]).not.toBe(b[0]);
    expect(a[1]).not.toBe(b[1]);
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
  it("the list filters by app and by status", async () => {
    await createApp(env.DB, "other");
    await insertMessage(env.DB, mk({ message: "alpha" }), "pending");
    await insertMessage(env.DB, mk({ message: "beta" }), "completed");
    await insertMessage(env.DB, mk({ app: "other", message: "gamma" }), "pending");
    const shown = async (query: string) => {
      const html = await (await req(`/?${query}`)).text();
      return ["alpha", "beta", "gamma"].filter((w) => html.includes(w));
    };
    expect(await shown("app=other")).toEqual(["gamma"]);
    expect(await shown("status=completed")).toEqual(["beta"]);
    expect(await shown("app=demo&status=pending")).toEqual(["alpha"]);
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
  it("a message with an image opens without download links when the image secret is unset", async () => {
    await updateApp(env.DB, "demo", { images_enabled: true });
    const { messageId } = await imageOnMessage(key, hex());
    expect(await (await req(`/m/${messageId}`)).text()).toContain("download image 1");
    const res = await req(`/m/${messageId}`, {}, cookie, { ...E, IMAGE_URL_SECRET: undefined });
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain("download image");
  });
  it("reply and status update the row and return to it; an unknown status or an oversized reply is refused", async () => {
    const m = (await insertMessage(env.DB, mk(), "pending")).row;
    const replied = await form(`/m/${m.id}/reply`, { content: "Merhaba, düzeltiyoruz." });
    expect(replied.status).toBe(303);
    expect(replied.headers.get("location")).toBe(`/m/${m.id}`);
    expect((await listReplies(env.DB, m.id))[0]!.content).toBe("Merhaba, düzeltiyoruz.");
    const set = await form(`/m/${m.id}/status`, { status: "in_progress" });
    expect(set.status).toBe(303);
    expect(set.headers.get("location")).toBe(`/m/${m.id}`);
    expect((await getMessage(env.DB, m.id))!.status).toBe("in_progress");
    expect((await form(`/m/${m.id}/status`, { status: "bogus" })).status).toBe(400);
    expect((await getMessage(env.DB, m.id))!.status).toBe("in_progress");
    expect((await form(`/m/${m.id}/reply`, { content: "x".repeat(8001) })).status).toBe(400);
  });
  it("an unknown message is 404 to every message form; an anonymous sender cannot be deleted by reference", async () => {
    const ghost = crypto.randomUUID();
    for (const [path, fields] of [[`/m/${ghost}/reply`, { content: "x" }], [`/m/${ghost}/status`, { status: "viewed" }], [`/m/${ghost}/delete-user`, {}]] as const) {
      expect((await form(path, fields)).status, path).toBe(404);
    }
    const anon = (await insertMessage(env.DB, mk({ user_ref: null }), "pending")).row;
    expect((await form(`/m/${anon.id}/delete-user`, {})).status).toBe(404);
    expect(await getMessage(env.DB, anon.id)).not.toBeNull();
  });
  // A forged cross-site post must not rotate a live client's key, delete a user's data or sign
  // the operator out, so every form the panel accepts is refused without the session's csrf.
  it("every form post without the right csrf is refused and changes nothing", async () => {
    const m = (await insertMessage(env.DB, mk(), "pending")).row;
    const { id: tokenId } = await createAdminToken(env.DB, "laptop");
    const state = async () =>
      JSON.stringify(await Promise.all(["apps", "admins", "admin_tokens", "messages", "replies"].map(async (t) => (await env.DB.prepare(`SELECT * FROM ${t}`).all()).results)));
    const before = await state();
    const posts = ["/auth/logout", "/auth/logout-all", `/m/${m.id}/reply`, `/m/${m.id}/status`, `/m/${m.id}/delete-user`, "/apps", "/apps/demo", "/apps/demo/rotate", "/apps/demo/notice-key", "/tokens", `/tokens/${tokenId}/revoke`];
    for (const path of posts) {
      const body = "csrf=wrong&content=x&status=viewed&id=forged&name=forged&retention_days=1";
      const res = await req(path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
      expect(res.status, path).toBe(403);
      expect(res.headers.getSetCookie(), path).toHaveLength(0);
    }
    expect(await state()).toBe(before);
  });
  it("delete-user removes the sender's messages and their stored images", async () => {
    await updateApp(env.DB, "demo", { images_enabled: true });
    const ref = hex();
    const { imageId, messageId } = await imageOnMessage(key, ref);
    const r2Key = (await getImage(env.DB, imageId))!.r2_key;
    // The same reference in another app is another person's: it stays.
    await createApp(env.DB, "other");
    const elsewhere = (await insertMessage(env.DB, submission({ app: "other", user_ref: ref }), "pending")).row.id;
    const res = await form(`/m/${messageId}/delete-user`, {});
    expect(await getMessage(env.DB, elsewhere)).not.toBeNull();
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/?app=demo");
    expect(await getMessage(env.DB, messageId)).toBeNull();
    expect(await getImage(env.DB, imageId)).toBeNull();
    expect(await env.IMAGES.get(r2Key)).toBeNull();
  });
  it("the apps page creates, updates and rotates an app", async () => {
    const created = await reveal(await form("/apps", { id: "newapp", retention_days: "30" }));
    expect(created.text).toMatch(/ulak_newapp_[0-9a-f]{48}/);
    // The cookie carrying it to the page is sealed: the key is not readable in it.
    expect(created.value).not.toContain("ulak_newapp_");
    expect((await form("/apps", { id: "Bad Id", retention_days: "30" })).status).toBe(400);
    expect((await form("/apps", { id: "plain" })).status).toBe(303);
    const row = (id: string) =>
      env.DB.prepare("SELECT retention_days, images_enabled, notify_enabled, allowed_origins FROM apps WHERE id=?").bind(id).first<{ retention_days: number; images_enabled: number; notify_enabled: number; allowed_origins: string }>();
    expect((await row("plain"))!.retention_days).toBe(90);
    expect((await row("newapp"))!.retention_days).toBe(30);
    const updated = await form("/apps/newapp", { retention_days: "45", images_enabled: "on", notify_enabled: "on", allowed_origins: " https://a.example , https://b.example " });
    expect(updated.status).toBe(303);
    expect(updated.headers.get("location")).toBe("/apps");
    expect(await row("newapp")).toEqual({ retention_days: 45, images_enabled: 1, notify_enabled: 1, allowed_origins: '["https://a.example","https://b.example"]' });
    // An app served only through its own server has no origins; the empty field must save.
    expect((await form("/apps/newapp", { retention_days: "45", allowed_origins: "" })).status).toBe(303);
    // An unticked box is absent from the form, and absent means off: notices and images stop.
    expect(await row("newapp")).toMatchObject({ images_enabled: 0, notify_enabled: 0, allowed_origins: "[]" });
    const rotated = await reveal(await form("/apps/newapp/rotate", {}));
    const newKey = rotated.text.match(/ulak_newapp_[0-9a-f]{48}/)![0];
    // A refresh of the page is a plain read: no key shown, and the key just copied still works.
    expect(await (await req("/apps")).text()).not.toMatch(/ulak_newapp_[0-9a-f]{48}/);
    expect(await findAppByKey(env.DB, newKey)).not.toBeNull();
  });
  it("a shown-once key is shown to no other admin, and a tampered or stale cookie shows nothing", async () => {
    const { value } = await reveal(await form("/apps/demo/rotate", {}));
    await pinAdmin("sub-2");
    const other = await createSession("s3", "sub-2");
    const shown = async (session: string, sealed: string, path = "/apps") => {
      const res = await req(path, { headers: { cookie: `ulak_admin=${session}; ulak_reveal=${sealed}` } });
      expect(cleared(res, "ulak_reveal", "/"), sealed).toBeDefined();
      return /ulak_demo_[0-9a-f]{48}/.test(await res.text());
    };
    expect(await shown(cookie, value)).toBe(true);
    expect(await shown(other, value)).toBe(false);
    expect(await shown(cookie, value.slice(0, -2) + (value.endsWith("A") ? "BB" : "AA"))).toBe(false);
    expect(await shown(cookie, "junk")).toBe(false);
    // An app key's cookie opened on the tokens page shows nothing there.
    expect(await shown(cookie, value, "/tokens")).toBe(false);
  });
  // The operator sees why a form was refused: a typed refusal from core, never a bare 500.
  it("every refused apps or tokens form answers its status with the reason", async () => {
    const refusals: [string, Record<string, string>, number, string][] = [
      ["/apps/ghost", { retention_days: "30" }, 404, "app ghost not found"],
      ["/apps/ghost/rotate", {}, 404, "app ghost not found"],
      ["/apps/ghost/notice-key", {}, 404, "app ghost not found"],
      ["/apps/demo", { retention_days: "0" }, 400, "retention_days must be 1 to 3650"],
      ["/apps/demo", { retention_days: "30", allowed_origins: "javascript:alert(1)" }, 400, "bad origin javascript:alert(1)"],
      ["/apps", { id: "demo" }, 400, "app demo already exists"],
      ["/tokens", { name: " " }, 400, "token name required"],
    ];
    for (const [path, fields, status, reason] of refusals) {
      const res = await form(path, fields);
      expect(res.status, path).toBe(status);
      expect(await res.text(), path).toBe(reason);
    }
  });
  it("the apps page issues a notice key, shown once and marked as server-only, and then says one exists", async () => {
    expect(await (await req("/apps")).text()).toContain("no notice key");
    const issued = (await reveal(await form("/apps/demo/notice-key", {}))).text;
    expect(issued).toMatch(/ulak_notice_demo_[0-9a-f]{48}/);
    expect(issued).toContain("never in a web page");
    const after = await (await req("/apps")).text();
    expect(after).not.toMatch(/ulak_notice_demo_[0-9a-f]{48}/);
    expect(after).toContain("notice key set");
  });
  it("the tokens page creates, lists and revokes an admin token", async () => {
    const tok = await reveal(await form("/tokens", { name: "laptop" }));
    expect(tok.text).toMatch(/ulak_admin_[0-9a-f]{48}/);
    const page = await (await req("/tokens")).text();
    expect(page).toContain("laptop");
    expect(page).not.toMatch(/ulak_admin_[0-9a-f]{48}/);
    expect(await listAdminTokens(env.DB)).toHaveLength(1);
    // Sign out everywhere ends browser sessions only; the page says where a lost device's token is ended.
    expect(page).toContain("Sign out everywhere does not revoke these");
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
    // Refused before the code is spent at Google or an admin row is written.
    expect(outbound).not.toHaveBeenCalled();
  });
});

// The panel is server-rendered with a CSP that forbids scripts, so the browser-side stores a
// signed-in admin can leave behind are exactly these: the two cookies the panel sets, the HTTP
// cache, and the browser's own form-autofill memory. Sign-out has to empty all of them, and the
// sign-in that consumed the OAuth state must not leave that state lying around either.
describe("sign-out leaves the browser a stranger", () => {
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
        // Every post form, the layout's sign-outs included, carries this session's token or it is refused.
        if (tag.includes('method="post"')) expect(fields, `${path}: <form${tag}>`).toContain(`name="csrf" value="${csrf}"`);
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
    // A state cookie without its nonce would let a token without one through; no code has nothing to exchange.
    const noNonce = await req("/auth/callback?state=s0&code=c1", { headers: { cookie: "ulak_oauth=s0" } }, null);
    const noCode = await req("/auth/callback?state=s0", { headers: { cookie: "ulak_oauth=s0.n0" } }, null);
    for (const res of [noNonce, noCode]) {
      expect(res.status).toBe(400);
      expect(res.headers.getSetCookie()).toHaveLength(0);
    }
    expect(outbound).not.toHaveBeenCalled();

    // The exchange fails after the state matched: the state is spent and the cookie goes with it.
    outbound.mockResolvedValueOnce(new Response("nope", { status: 500 }));
    const failed = await callback("s1", "n1");
    expect(failed.status).toBe(500);
    expect(await failed.text()).toBe("internal error");
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
    // Google refuses the exchange unless it names the address the sign-in was sent back to.
    const sentBackTo = new URL((await req("/auth/login", {}, null)).headers.get("location")!).searchParams.get("redirect_uri");
    expect(sentBackTo).toBe(`${E.ADMIN_URL}/auth/callback`);
    expect((outbound.mock.calls[1]![1]!.body as URLSearchParams).get("redirect_uri")).toBe(sentBackTo);
  });

  it("a Google account that is not an admin is refused with a logged 403 and gets no session", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await googleSignsIn("n1", "sub-2", "b@example.invalid");
    const res = await callback("s1", "n1");
    expect(res.status).toBe(403);
    expect(sessionSet(res)).toBeUndefined();
    expect(cleared(res, "ulak_oauth", "/auth")).toBeDefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("not_an_admin"));
    warn.mockRestore();
  });

  it("a bootstrap address pins its account only when Google says the address is verified", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const pinned =(sub: string) => env.DB.prepare("SELECT sub FROM admins WHERE sub=?").bind(sub).first();
    await googleSignsIn("n1", "sub-new", "admin@example.invalid", false);
    const refused = await callback("s1", "n1");
    expect(refused.status).toBe(403);
    expect(sessionSet(refused)).toBeUndefined();
    expect(await pinned("sub-new")).toBeNull();
    await googleSignsIn("n2", "sub-new", "admin@example.invalid", true);
    const accepted = await callback("s2", "n2");
    expect(accepted.status).toBe(302);
    expect(sessionSet(accepted)).toBeDefined();
    expect(await pinned("sub-new")).not.toBeNull();
    warn.mockRestore();
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
      expect(cleared(res, "ulak_reveal", "/"), path).toBeDefined();
      expect(res.headers.getSetCookie(), path).toHaveLength(3);
    }
  });

  it("signing out on a device whose session was already ended still leaves it a stranger", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Sign out everywhere on another device, then Sign out on this one: the dead cookie must go.
    await revokeSessions(env.DB, "sub-1", nowSec());
    const res = await form("/auth/logout", {});
    expect(res.headers.get("location")).toBe("/auth/login");
    expect(cleared(res, "ulak_admin", "/")).toBeDefined();
    expect(cleared(res, "ulak_oauth", "/auth")).toBeDefined();
    // Any refused cookie is cleared, so a removed admin's browser keeps nothing of the account either.
    const unpinned = await req("/", {}, await createSession("s3", "sub-9"));
    expect(unpinned.status).toBe(403);
    expect(cleared(unpinned, "ulak_admin", "/")).toBeDefined();
    warn.mockRestore();
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

  it("a renewal racing sign out everywhere cannot outlive it: revocation goes by the sign-in, not the renewal", async () => {
    const signedIn = hoursAgo(2);
    cookie = await createSession("s3", "sub-1", { csrf, iat: signedIn });
    // The renewal is minted in the second after the revocation's cutoff, as when the two cross.
    const renewed = sessionValue(sessionSet(await req("/"))!);
    await revokeSessions(env.DB, "sub-1", nowSec() - 1);
    expect((await req("/", {}, renewed)).status).toBe(302);
  });
});
