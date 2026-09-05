import type { MiddlewareHandler } from "hono";
import type { Env } from "../env";
import { ApiError } from "../errors";
import { newId, randomToken, sha256Hex } from "../ids";
import { nowIso } from "../time";

export interface AdminTokenRow {
  id: string;
  name: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

const TOKEN = /^ulak_admin_[0-9a-f]{48}$/;

export async function createAdminToken(db: D1Database, name: string): Promise<{ id: string; token: string }> {
  const clean = name.trim().slice(0, 64);
  if (!clean) throw new Error("token name required");
  const token = randomToken("ulak_admin");
  const id = newId();
  await db.prepare("INSERT INTO admin_tokens (id,name,token_hash,created_at) VALUES (?,?,?,?)").bind(id, clean, await sha256Hex(token), nowIso()).run();
  return { id, token };
}

export async function verifyAdminToken(db: D1Database, token: string): Promise<{ id: string; name: string } | null> {
  if (!TOKEN.test(token)) return null;
  const row = await db.prepare("SELECT id,name FROM admin_tokens WHERE token_hash=? AND revoked_at IS NULL").bind(await sha256Hex(token)).first<{ id: string; name: string }>();
  if (row) await db.prepare("UPDATE admin_tokens SET last_used_at=? WHERE id=?").bind(nowIso(), row.id).run();
  return row ?? null;
}

export async function revokeAdminToken(db: D1Database, id: string): Promise<void> {
  await db.prepare("UPDATE admin_tokens SET revoked_at=? WHERE id=? AND revoked_at IS NULL").bind(nowIso(), id).run();
}

export async function listAdminTokens(db: D1Database): Promise<AdminTokenRow[]> {
  return (await db.prepare("SELECT id,name,created_at,last_used_at,revoked_at FROM admin_tokens ORDER BY created_at DESC").all<AdminTokenRow>()).results;
}

export type AdminTokenVars = { adminToken: { id: string; name: string } };

export function requireAdminToken(): MiddlewareHandler<{ Bindings: Env; Variables: AdminTokenVars }> {
  return async (c, next) => {
    const h = c.req.header("authorization") ?? "";
    const t = h.startsWith("Bearer ") ? await verifyAdminToken(c.env.DB, h.slice(7).trim()) : null;
    if (!t) throw new ApiError(401, "invalid_admin_token", "missing, unknown or revoked admin token", false);
    c.set("adminToken", t);
    await next();
  };
}
