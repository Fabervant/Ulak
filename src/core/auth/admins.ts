import type { Env } from "../env";
import { ApiError } from "../errors";
import { nowIso } from "../time";

export interface AdminRow {
  sub: string;
  email_at_pin: string;
  pinned_at: string;
}

export async function findAdmin(db: D1Database, sub: string): Promise<AdminRow | null> {
  return db.prepare("SELECT * FROM admins WHERE sub=?").bind(sub).first<AdminRow>();
}

export async function listAdmins(db: D1Database): Promise<AdminRow[]> {
  return (await db.prepare("SELECT * FROM admins ORDER BY pinned_at").all<AdminRow>()).results;
}

const notAdmin = (detail: string) => new ApiError(403, "not_an_admin", detail, false);

/** Called after a verified sign-in. The sub is the identity; the email is consulted only to pin a new sub once. */
export async function bootstrapAdmin(db: D1Database, env: Env, sub: string, email: string, emailVerified: boolean): Promise<AdminRow> {
  const existing = await findAdmin(db, sub);
  if (existing) return existing;
  const allowed = (env.ADMIN_BOOTSTRAP_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!emailVerified || !allowed.includes(email.toLowerCase())) throw notAdmin("this account is not an admin of this deployment");
  const taken = await db.prepare("SELECT sub FROM admins WHERE lower(email_at_pin)=?").bind(email.toLowerCase()).first();
  if (taken) throw notAdmin("this email already pinned a different account; remove the admin row to re-pin");
  const row: AdminRow = { sub, email_at_pin: email, pinned_at: nowIso() };
  await db.prepare("INSERT INTO admins (sub,email_at_pin,pinned_at) VALUES (?,?,?)").bind(sub, email, row.pinned_at).run();
  return row;
}
