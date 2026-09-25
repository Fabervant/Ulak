const enc = new TextEncoder();
const b64u = (b: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(b)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const unb64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

async function mac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64u(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}

export const SESSION_COOKIE = "ulak_admin";
/** A session ends 30 days after it was last issued; the panel re-issues it while in use. */
export const SESSION_TTL_SEC = 30 * 24 * 3600;
/** A session older than this is re-issued on the admin's next request. */
export const SESSION_RENEW_AFTER_SEC = 3600;

export interface Session {
  sub: string;
  csrf: string;
  /** Issue time, Unix seconds: the key for renewal and for `sessions_invalid_before`. */
  iat: number;
}

const nowSec = () => Math.floor(Date.now() / 1000);

/** A renewal passes the old session's csrf so forms already on screen stay valid. */
export async function createSession(secret: string, sub: string, opts: { ttlSec?: number; csrf?: string; iat?: number } = {}): Promise<string> {
  const csrf = opts.csrf ?? b64u(crypto.getRandomValues(new Uint8Array(24))).slice(0, 32);
  const iat = opts.iat ?? nowSec();
  const payload = b64u(enc.encode(JSON.stringify({ sub, csrf, iat, exp: iat + (opts.ttlSec ?? SESSION_TTL_SEC) })));
  return `${payload}.${await mac(secret, payload)}`;
}

export async function readSession(secret: string, cookie: string | undefined): Promise<Session | null> {
  if (!cookie) return null;
  const [payload, sig] = cookie.split(".");
  if (!payload || !sig) return null;
  const want = await mac(secret, payload);
  if (want.length !== sig.length) return null;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ sig.charCodeAt(i);
  if (diff !== 0) return null;
  try {
    const p = JSON.parse(new TextDecoder().decode(unb64u(payload))) as { sub: string; csrf: string; iat?: number; exp: number };
    if (typeof p.iat !== "number" || p.exp < nowSec()) return null;
    return { sub: p.sub, csrf: p.csrf, iat: p.iat };
  } catch {
    return null;
  }
}

export function sessionCookie(value: string, maxAgeSec = SESSION_TTL_SEC): string {
  return `${SESSION_COOKIE}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAgeSec}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

/** The sign-in state cookie: one state and nonce, scoped to the auth routes, spent by the callback. */
export const OAUTH_COOKIE = "ulak_oauth";
export const OAUTH_TTL_SEC = 600;

export function oauthCookie(state: string, nonce: string): string {
  return `${OAUTH_COOKIE}=${state}.${nonce}; HttpOnly; Secure; SameSite=Lax; Path=/auth; Max-Age=${OAUTH_TTL_SEC}`;
}

/** Same Path as the setter, or the browser keeps the original. */
export function clearOauthCookie(): string {
  return `${OAUTH_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/auth; Max-Age=0`;
}
