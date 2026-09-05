import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { Env } from "../core/env";
import { statusList } from "../core/env";
import { ApiError } from "../core/errors";
import { requireAdmin, readForm, CsrfError, type AdminVars } from "./auth";
import { layout } from "./views/layout";
import { listView } from "./views/list";
import { detailView } from "./views/detail";
import { appsView } from "./views/apps";
import { tokensView } from "./views/tokens";
import { authUrl, exchangeCode, verifyIdToken } from "../core/auth/google";
import { createSession, sessionCookie, clearSessionCookie } from "../core/auth/session";
import { bootstrapAdmin } from "../core/auth/admins";
import { listAdmin, countByAppAndStatus, getMessage, setStatus, deleteUser } from "../core/messages";
import { addReply, listReplies } from "../core/replies";
import { listApps, createApp, updateApp, rotateKey } from "../core/apps";
import { listImagesFor, deleteImageObjects } from "../core/images";
import { signImageUrl } from "../core/signedurl";
import { createAdminToken, listAdminTokens, revokeAdminToken } from "../core/auth/admintoken";
import { api } from "./api";

type Ctx = { Bindings: Env; Variables: AdminVars };
const app = new Hono<Ctx>();

// No JavaScript anywhere on the surface; the CSP enforces that.
app.use("*", async (c, next) => {
  await next();
  c.res.headers.set("content-security-policy", `default-src 'none'; style-src 'unsafe-inline'; img-src ${c.env.IMAGES_URL}; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`);
  c.res.headers.set("x-content-type-options", "nosniff");
  c.res.headers.set("referrer-policy", "no-referrer");
  c.res.headers.set("cache-control", "no-store");
});

app.onError((err, c) => {
  if (err instanceof CsrfError) return c.text("forbidden: bad csrf token", 403);
  if (err instanceof ApiError) return c.text(err.detail, err.status as 400);
  if (err instanceof Error && /must|exists|not found|bad origin|required/.test(err.message)) return c.text(err.message, 400);
  console.error("admin unhandled", err);
  return c.text("internal error", 500);
});

// --- token-protected JSON API: mounted before the cookie gate ---
app.route("/api", api);

// --- sign-in ---
app.get("/auth/login", (c) => {
  const state = crypto.randomUUID();
  const nonce = crypto.randomUUID();
  setCookie(c, "ulak_oauth", `${state}.${nonce}`, { httpOnly: true, secure: true, sameSite: "Lax", path: "/auth", maxAge: 600 });
  return c.redirect(authUrl(c.env, state, nonce, `${c.env.ADMIN_URL}/auth/callback`), 302);
});

app.get("/auth/callback", async (c) => {
  const [state, nonce] = (getCookie(c, "ulak_oauth") ?? "").split(".");
  const code = c.req.query("code");
  if (!state || !nonce || c.req.query("state") !== state || !code) return c.text("sign-in state mismatch; start again at /auth/login", 400);
  const { id_token } = await exchangeCode(c.env, code, `${c.env.ADMIN_URL}/auth/callback`);
  const who = await verifyIdToken(c.env, id_token, nonce);
  const admin = await bootstrapAdmin(c.env.DB, c.env, who.sub, who.email, who.email_verified); // 403 not_an_admin otherwise
  if (!c.env.SESSION_SECRET) return c.text("SESSION_SECRET not configured", 500);
  c.header("set-cookie", sessionCookie(await createSession(c.env.SESSION_SECRET, admin.sub)));
  return c.redirect("/", 302);
});

app.use("/*", requireAdmin());

app.post("/auth/logout", async (c) => {
  await readForm(c);
  c.header("set-cookie", clearSessionCookie());
  return c.redirect("/auth/login", 303);
});

// --- pages ---
app.get("/", async (c) => {
  const statuses = statusList(c.env);
  const filter = { app: c.req.query("app") || undefined, status: c.req.query("status") || undefined };
  const [rows, counts, apps] = await Promise.all([listAdmin(c.env.DB, filter), countByAppAndStatus(c.env.DB, statuses[0] ?? "pending"), listApps(c.env.DB)]);
  const csrf = c.get("admin").csrf;
  return c.html(layout("Messages", listView(rows, counts, apps.map((a) => a.id), filter, statuses), csrf));
});

app.get("/m/:id", async (c) => {
  const m = await getMessage(c.env.DB, c.req.param("id"));
  if (!m) return c.text("not found", 404);
  const [replies, images] = await Promise.all([listReplies(c.env.DB, m.id), listImagesFor(c.env.DB, m.id)]);
  const exp = Math.floor(Date.now() / 1000) + 600;
  const secret = c.env.IMAGE_URL_SECRET;
  const urls = secret ? await Promise.all(images.map((i) => signImageUrl(secret, c.env.IMAGES_URL, i.id, exp))) : [];
  const csrf = c.get("admin").csrf;
  return c.html(layout(`Message ${m.id.slice(0, 8)}`, detailView(m, replies, urls, statusList(c.env), csrf), csrf));
});

app.post("/m/:id/reply", async (c) => {
  const f = await readForm(c);
  const m = await getMessage(c.env.DB, c.req.param("id"));
  if (!m) return c.text("not found", 404);
  await addReply(c.env.DB, m.id, "owner", f.content ?? "");
  return c.redirect(`/m/${m.id}`, 303);
});

app.post("/m/:id/status", async (c) => {
  const f = await readForm(c);
  const status = f.status ?? "";
  if (!statusList(c.env).includes(status)) return c.text("unknown status", 400);
  await setStatus(c.env.DB, c.req.param("id"), status);
  return c.redirect(`/m/${c.req.param("id")}`, 303);
});

app.post("/m/:id/delete-user", async (c) => {
  await readForm(c);
  const m = await getMessage(c.env.DB, c.req.param("id"));
  if (!m || !m.user_ref) return c.text("not found or anonymous", 404);
  const { image_keys } = await deleteUser(c.env.DB, m.app, m.user_ref);
  c.executionCtx.waitUntil(deleteImageObjects(c.env, image_keys));
  return c.redirect(`/?app=${m.app}`, 303);
});

app.get("/apps", async (c) => {
  const csrf = c.get("admin").csrf;
  return c.html(layout("Apps", appsView(await listApps(c.env.DB), csrf), csrf));
});

app.post("/apps", async (c) => {
  const f = await readForm(c);
  const id = f.id ?? "";
  const { key } = await createApp(c.env.DB, id, { retention_days: Number(f.retention_days || 90) });
  const csrf = c.get("admin").csrf;
  return c.html(layout("Apps", appsView(await listApps(c.env.DB), csrf, { id, key }), csrf));
});

app.post("/apps/:id", async (c) => {
  const f = await readForm(c);
  await updateApp(c.env.DB, c.req.param("id"), {
    retention_days: Number(f.retention_days),
    images_enabled: f.images_enabled === "on",
    allowed_origins: (f.allowed_origins ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  });
  return c.redirect("/apps", 303);
});

app.post("/apps/:id/rotate", async (c) => {
  await readForm(c);
  const id = c.req.param("id");
  const key = await rotateKey(c.env.DB, id);
  const csrf = c.get("admin").csrf;
  return c.html(layout("Apps", appsView(await listApps(c.env.DB), csrf, { id, key }), csrf));
});

app.get("/tokens", async (c) => {
  const csrf = c.get("admin").csrf;
  return c.html(layout("Tokens", tokensView(await listAdminTokens(c.env.DB), csrf), csrf));
});

app.post("/tokens", async (c) => {
  const f = await readForm(c);
  const name = f.name ?? "";
  const { token } = await createAdminToken(c.env.DB, name);
  const csrf = c.get("admin").csrf;
  return c.html(layout("Tokens", tokensView(await listAdminTokens(c.env.DB), csrf, { name, token }), csrf));
});

app.post("/tokens/:id/revoke", async (c) => {
  await readForm(c);
  await revokeAdminToken(c.env.DB, c.req.param("id"));
  return c.redirect("/tokens", 303);
});

export { app };
export default { fetch: app.fetch };
