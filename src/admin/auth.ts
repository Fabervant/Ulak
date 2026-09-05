import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import type { Env } from "../core/env";
import { readSession, SESSION_COOKIE } from "../core/auth/session";
import { findAdmin } from "../core/auth/admins";

export type AdminVars = { admin: { sub: string; csrf: string } };

/** Session cookie -> pinned admin, re-checked on every request. Failures are logged and distinguishable. */
export function requireAdmin(): MiddlewareHandler<{ Bindings: Env; Variables: AdminVars }> {
  return async (c, next) => {
    const fail = (reason: string, status: 401 | 403) => {
      console.warn(`admin auth failed: ${reason} path=${c.req.path}`);
      return status === 401 ? c.redirect("/auth/login", 302) : c.text("forbidden: this account is not an admin of this deployment", 403);
    };
    if (!c.env.SESSION_SECRET) return fail("SESSION_SECRET not configured", 403);
    const s = await readSession(c.env.SESSION_SECRET, getCookie(c, SESSION_COOKIE));
    if (!s) return fail("no valid session", 401);
    if (!(await findAdmin(c.env.DB, s.sub))) return fail("sub not pinned as admin", 403);
    c.set("admin", s);
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
