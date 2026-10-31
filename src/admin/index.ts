import { Hono, type Context } from "hono";
import { getCookie } from "hono/cookie";
import type { Env } from "../core/env";
import { statusList } from "../core/env";
import { ApiError } from "../core/errors";
import { requireAdmin, readForm, CsrfError, logAuthFailure, dropCookies, type AdminVars } from "./auth";
import { layout } from "./views/layout";
import { listView } from "./views/list";
import { detailView } from "./views/detail";
import { appsView } from "./views/apps";
import { tokensView } from "./views/tokens";
import { authUrl, exchangeCode, verifyIdToken } from "../core/auth/google";
import { createSession, sessionCookie, OAUTH_COOKIE, oauthCookie, newPkce, clearOauthCookie, REVEAL_COOKIE, sealReveal, openReveal, revealCookie, clearRevealCookie } from "../core/auth/session";
import { bootstrapAdmin, revokeSessions } from "../core/auth/admins";
import { listAdmin, countByAppAndStatus, getMessage, setStatus, deleteUser } from "../core/messages";
import { addReply, listReplies } from "../core/replies";
import { listApps, getApp, createApp, updateApp, rotateKey, rotateNoticeKey, rotateSendKey } from "../core/apps";
import { closeAlert, copyText, countCopiesWithoutEnd, getLegal, listOpenAlerts, recordedLegalConfig, searchCopies } from "../core/mail/legal";
import { legalView } from "./views/legal";
import { html } from "hono/html";
import { listOutbox } from "../core/mail/outbox";
import { outboxView } from "./views/outbox";
import { listImagesFor } from "../core/images";
import { createAdminToken, listAdminTokens, revokeAdminToken } from "../core/auth/admintoken";
import { api, imageLinks } from "./api";
import { runChecks } from "../core/checks";
import { nowIso, nowSec } from "../core/time";
import { sha256Hex, timingSafeEqual } from "../core/ids";

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
  if (err instanceof ApiError) {
    if (err.status === 403) logAuthFailure(err.code, c.req.path);
    return c.text(err.detail, err.status as 400);
  }
  console.error("admin unhandled", err);
  return c.text("internal error", 500);
});

// --- token-protected JSON API: mounted before the cookie gate ---
app.route("/api", api);

// --- unauthenticated health route for an external monitor ---
// The secret lives in the path so monitors that cannot send headers still work. It returns
// only a status code: 200 healthy, 503 not. No counts, no messages, nothing about the data.
// A wrong secret and an unconfigured feature both give a bare 404, so probing cannot tell
// which. It does not hide that the route exists - other unknown paths redirect to sign-in -
// and the secret's length and randomness are the only thing guarding it. Comparison is over
// SHA-256 digests so a wrong guess cannot be narrowed down by timing.
app.get("/status/:secret", async (c) => {
  const expected = c.env.STATUS_SECRET;
  if (!expected) return c.notFound();
  const [a, b] = await Promise.all([sha256Hex(c.req.param("secret")), sha256Hex(expected)]);
  if (!timingSafeEqual(a, b)) return c.notFound();
  const { ok } = await runChecks(c.env.DB);
  return c.json({ ok }, ok ? 200 : 503);
});

// --- sign-in ---
// Google refuses the code exchange unless it names the same address the sign-in was sent from.
const callbackUrl = (env: Env) => `${env.ADMIN_URL}/auth/callback`;

app.get("/auth/login", async (c) => {
  const state = crypto.randomUUID();
  const nonce = crypto.randomUUID();
  const { verifier, challenge } = await newPkce();
  c.header("set-cookie", oauthCookie(state, nonce, verifier));
  return c.redirect(authUrl(c.env, state, nonce, challenge, callbackUrl(c.env)), 302);
});

app.get("/auth/callback", async (c) => {
  const [state, nonce, verifier] = (getCookie(c, OAUTH_COOKIE) ?? "").split(".");
  const code = c.req.query("code");
  if (!state || !nonce || !verifier || c.req.query("state") !== state || !code) return c.text("sign-in state mismatch; start again at /auth/login", 400);
  // The state matched, so it is spent whatever happens next; the header survives an error response.
  c.header("set-cookie", clearOauthCookie());
  if (!c.env.SESSION_SECRET) return c.text("SESSION_SECRET not configured", 500);
  const { id_token } = await exchangeCode(c.env, code, verifier, callbackUrl(c.env));
  const who = await verifyIdToken(c.env, id_token, nonce);
  const admin = await bootstrapAdmin(c.env.DB, c.env, who.sub, who.email, who.email_verified); // 403 not_an_admin otherwise
  c.header("set-cookie", sessionCookie(await createSession(c.env.SESSION_SECRET, admin.sub)), { append: true });
  return c.redirect("/", 302);
});

app.use("/*", requireAdmin());

// Sign-out leaves the browser as on a first visit: both cookies go. The pages are already
// no-store and the forms opt out of autofill, so nothing else of the admin's remains on the device.
const signedOut = (c: Context<Ctx>) => {
  dropCookies(c);
  return c.redirect("/auth/login", 303);
};

app.post("/auth/logout", async (c) => {
  await readForm(c);
  return signedOut(c);
});

// For a lost or shared device: every session this admin holds anywhere stops at once, this one too.
app.post("/auth/logout-all", async (c) => {
  await readForm(c);
  await revokeSessions(c.env.DB, c.get("admin").sub, nowSec());
  return signedOut(c);
});

// --- pages ---
// Every page carries the session's csrf token, in its own forms and the layout's sign-out forms.
const page = (c: Context<Ctx>, title: string, body: (csrf: string) => Parameters<typeof layout>[1]) =>
  c.html(layout(title, body(c.get("admin").csrf), c.get("admin").csrf));
app.get("/", async (c) => {
  const statuses = statusList(c.env);
  const filter = { app: c.req.query("app") || undefined, status: c.req.query("status") || undefined };
  const [rows, counts, apps] = await Promise.all([listAdmin(c.env.DB, filter), countByAppAndStatus(c.env.DB, statuses[0] ?? "pending"), listApps(c.env.DB)]);
  // The line after a person's deletion: what went, and the legal copies kept by the seller's duty.
  const deleted = c.req.query("deleted");
  const kept = c.req.query("kept");
  const done = /^\d{1,9}$/.test(deleted ?? "") && /^\d{1,9}$/.test(kept ?? "") ? html`<p class="warn">Deleted ${deleted} message(s) of that person; kept ${kept} legal cop${kept === "1" ? "y" : "ies"}, without the person's reference, by the seller's legal duty.</p>` : "";
  return page(c, "Messages", () => html`${done}${listView(rows, counts, apps.map((a) => a.id), filter, statuses)}`);
});

app.get("/m/:id", async (c) => {
  const m = await getMessage(c.env.DB, c.req.param("id"));
  if (!m) return c.text("not found", 404);
  const [replies, images] = await Promise.all([listReplies(c.env.DB, m.id), listImagesFor(c.env.DB, m.id)]);
  const urls = (await imageLinks(c.env, images.map((i) => i.id))) ?? [];
  return page(c, `Message ${m.id.slice(0, 8)}`, (csrf) => detailView(m, replies, urls, statusList(c.env), csrf));
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
  await setStatus(c.env.DB, c.req.param("id"), f.status ?? "", statusList(c.env));
  return c.redirect(`/m/${c.req.param("id")}`, 303);
});

app.post("/m/:id/delete-user", async (c) => {
  await readForm(c);
  const m = await getMessage(c.env.DB, c.req.param("id"));
  if (!m || !m.user_ref) return c.text("not found or anonymous", 404);
  const r = await deleteUser(c.env, m.app, m.user_ref);
  return c.redirect(`/?app=${m.app}&deleted=${r.deleted_messages}&kept=${r.kept_legal_copies}`, 303);
});

// A key or token is shown once. The post that made it redirects, carrying it sealed in a cookie,
// and the page opens and expires that cookie: a refresh is a plain read that makes nothing again.
// requireAdmin refuses every request while SESSION_SECRET is unset, so it is set here.
type Shown = "apps" | "tokens";
const shownOnce = async (c: Context<Ctx>, page: Shown, shown: unknown) => {
  c.header("set-cookie", revealCookie(await sealReveal(c.env.SESSION_SECRET ?? "", c.get("admin").sub, page, shown)), { append: true });
  return c.redirect(`/${page}`, 303);
};
const takeShown = async <T,>(c: Context<Ctx>, page: Shown): Promise<T | undefined> => {
  const sealed = getCookie(c, REVEAL_COOKIE);
  if (sealed === undefined) return undefined;
  c.header("set-cookie", clearRevealCookie(), { append: true });
  return openReveal<T>(c.env.SESSION_SECRET ?? "", sealed, c.get("admin").sub, page);
};
const appsPage =async (c: Context<Ctx>, newKey?: Parameters<typeof appsView>[2]) => {
  const apps = await listApps(c.env.DB);
  return page(c, "Apps", (csrf) => appsView(apps, csrf, newKey));
};
const tokensPage = async (c: Context<Ctx>, created?: Parameters<typeof tokensView>[2]) => {
  const tokens = await listAdminTokens(c.env.DB);
  return page(c, "Tokens", (csrf) => tokensView(tokens, csrf, created));
};

app.get("/apps", async (c) => appsPage(c, await takeShown(c, "apps")));

app.post("/apps", async (c) => {
  const f = await readForm(c);
  const id = f.id ?? "";
  const { key } = await createApp(c.env.DB, id, { retention_days: f.retention_days ? Number(f.retention_days) : undefined });
  return shownOnce(c, "apps", { id, key });
});

app.post("/apps/:id", async (c) => {
  const f = await readForm(c);
  const id = c.req.param("id");
  const cur = await getApp(c.env.DB, id); // an unknown app is updateApp's 404
  const kinds = [...(f.mail_transactional === "on" ? ["transactional"] : []), ...(f.mail_legal === "on" ? ["legal_document"] : [])];
  // A legal document needs the API Worker's keeping period; the admin Worker reads what the timer recorded of it.
  if (kinds.includes("legal_document") && !cur?.mail_kinds.includes("legal_document") && (await recordedLegalConfig(c.env.DB)) !== "set") {
    return c.text("legal documents need LEGAL_KEEP_DAYS set on the API Worker (docs/self-hosting.md); the timer has not found it set", 400);
  }
  await updateApp(c.env.DB, id, {
    retention_days: Number(f.retention_days),
    images_enabled: f.images_enabled === "on",
    notify_enabled: f.notify_enabled === "on",
    allowed_origins: (f.allowed_origins ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    mail_from_name: f.mail_from_name ?? "",
    mail_kinds: kinds,
    mail_labels: (f.mail_labels ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  });
  return c.redirect("/apps", 303);
});

app.post("/apps/:id/send-key", async (c) => {
  await readForm(c);
  const id = c.req.param("id");
  return shownOnce(c, "apps", { id, key: await rotateSendKey(c.env.DB, id), send: true });
});

app.get("/outbox", async (c) => {
  const filterApp = c.req.query("app") || undefined;
  const [rows, apps] = await Promise.all([listOutbox(c.env.DB, nowIso(), filterApp), listApps(c.env.DB)]);
  return page(c, "Outbox", () => outboxView(rows, apps.map((a) => a.id), filterApp));
});

app.get("/legal", async (c) => {
  const reference = (c.req.query("reference") ?? "").trim();
  const filterApp = c.req.query("app") || undefined;
  const [alerts, apps, copiesWithoutEnd] = await Promise.all([listOpenAlerts(c.env.DB), listApps(c.env.DB), countCopiesWithoutEnd(c.env.DB, nowIso())]);
  const search = reference ? { reference, app: filterApp, rows: await searchCopies(c.env.DB, reference, filterApp) } : undefined;
  return page(c, "Legal", (csrf) => legalView({ alerts, search, apps: apps.map((a) => a.id), copiesWithoutEnd }, csrf));
});

app.post("/legal/alerts/:id/close", async (c) => {
  const f = await readForm(c);
  await closeAlert(c.env.DB, c.req.param("id"), f.reason ?? "", f.replaced_by ?? null, nowIso());
  return c.redirect("/legal", 303);
});

// The copy as a plain-text file. The file name carries only Ulak's id, never the app's reference.
app.get("/legal/:mail_id/copy", async (c) => {
  const doc = await getLegal(c.env.DB, c.req.param("mail_id"));
  if (!doc) return c.text("not found", 404);
  return c.body(copyText(doc), 200, {
    "content-type": "text/plain; charset=utf-8",
    "content-disposition": `attachment; filename="legal-${doc.mail_id}.txt"`,
  });
});

app.post("/apps/:id/rotate", async (c) => {
  await readForm(c);
  const id = c.req.param("id");
  return shownOnce(c, "apps", { id, key: await rotateKey(c.env.DB, id) });
});

app.post("/apps/:id/notice-key", async (c) => {
  await readForm(c);
  const id = c.req.param("id");
  return shownOnce(c, "apps", { id, key: await rotateNoticeKey(c.env.DB, id), notice: true });
});

app.get("/tokens", async (c) => tokensPage(c, await takeShown(c, "tokens")));

app.post("/tokens", async (c) => {
  const f = await readForm(c);
  const name = f.name ?? "";
  const { token } = await createAdminToken(c.env.DB, name);
  return shownOnce(c, "tokens", { name, token });
});

app.post("/tokens/:id/revoke", async (c) => {
  await readForm(c);
  await revokeAdminToken(c.env.DB, c.req.param("id"));
  return c.redirect("/tokens", 303);
});

export default { fetch: app.fetch };
