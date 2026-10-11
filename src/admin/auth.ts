import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import type { Env } from "../core/env";
import { readSession, createSession, sessionCookie, SESSION_COOKIE, SESSION_RENEW_AFTER_SEC, clearSessionCookie, clearOauthCookie, clearRevealCookie } from "../core/auth/session";
import { findAdmin } from "../core/auth/admins";
import { nowSec } from "../core/time";

export type AdminVars = { admin: { sub: string; csrf: string } };

export const logAuthFailure = (reason: string, path: string) => console.warn(`admin auth failed: ${reason} path=${path}`);

/** Expires every cookie the panel ever sets, each on its own path, leaving the browser as on a first visit. */
export function dropCookies(c: Context) {
  c.header("set-cookie", clearSessionCookie());
  c.header("set-cookie", clearOauthCookie(), { append: true });
  c.header("set-cookie", clearRevealCookie(), { append: true });
}

/** Session cookie -> pinned admin, re-checked on every request. Failures are logged and distinguishable. */
export function requireAdmin(): MiddlewareHandler<{ Bindings: Env; Variables: AdminVars }> {
  return async (c, next) => {
    const fail = (reason: string, status: 401 | 403) => {
      logAuthFailure(reason, c.req.path);
      // A refused cookie is worth nothing, so the browser drops it: a sign-out after "Sign out
      // everywhere" elsewhere, or any visit after the admin row was removed, leaves no account behind.
      if (getCookie(c, SESSION_COOKIE) !== undefined) dropCookies(c);
      return status === 401 ? c.redirect("/auth/login", 302) : c.text("forbidden: this account is not an admin of this deployment", 403);
    };
    if (!c.env.SESSION_SECRET) return fail("SESSION_SECRET not configured", 403);
    const s = await readSession(c.env.SESSION_SECRET, getCookie(c, SESSION_COOKIE));
    if (!s) return fail("no valid session", 401);
    const admin = await findAdmin(c.env.DB, s.sub);
    if (!admin) return fail("sub not pinned as admin", 403);
    if (admin.sessions_invalid_before !== null && s.auth <= admin.sessions_invalid_before) return fail("session revoked", 401);
    // Re-issued while in use, so an active admin never meets the 30-day end. Set before the
    // handler runs: a sign-out's own set-cookie replaces this one rather than being undone by it.
    if (nowSec() - s.iat > SESSION_RENEW_AFTER_SEC) c.header("set-cookie", sessionCookie(await createSession(c.env.SESSION_SECRET, s.sub, { csrf: s.csrf, auth: s.auth })));
    c.set("admin", { sub: s.sub, csrf: s.csrf });
    await next();
  };
}

export class CsrfError extends Error {}

/** Parses a form body and requires its csrf field to match the session's token. */
export async function readForm(c: Context<{ Bindings: Env; Variables: AdminVars }>): Promise<Record<string, string>> {
  const body = await c.req.parseBody();
  const fields: Record<string, string> = {};
  for (const [k, v] of Object.entries(body)) if (typeof v === "string") fields[k] = v;
  if (!fields.csrf || fields.csrf !== c.get("admin").csrf) throw new CsrfError("bad csrf token");
  return fields;
}
