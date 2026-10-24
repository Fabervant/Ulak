import { nowSec } from "../time";
import { timingSafeEqual } from "../ids";

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
  /** Issue time, Unix seconds: the key for renewal and for the 30-day end. */
  iat: number;
  /** Sign-in time, Unix seconds, kept through every renewal: the key for `sessions_invalid_before`,
   *  so a renewal minted while "Sign out everywhere" runs is still ended by it. */
  auth: number;
}

/** A renewal passes the old session's csrf and sign-in time, so forms already on screen stay valid
 *  and a revocation of that sign-in reaches the renewed copy. */
export async function createSession(secret: string, sub: string, opts: { ttlSec?: number; csrf?: string; iat?: number; auth?: number } = {}): Promise<string> {
  const csrf = opts.csrf ?? b64u(crypto.getRandomValues(new Uint8Array(24))).slice(0, 32);
  const iat = opts.iat ?? nowSec();
  const auth = opts.auth ?? iat;
  const payload = b64u(enc.encode(JSON.stringify({ sub, csrf, iat, auth, exp: iat + (opts.ttlSec ?? SESSION_TTL_SEC) })));
  return `${payload}.${await mac(secret, payload)}`;
}

export async function readSession(secret: string, cookie: string | undefined): Promise<Session | null> {
  if (!cookie) return null;
  const [payload, sig] = cookie.split(".");
  if (!payload || !sig) return null;
  const want = await mac(secret, payload);
  if (!timingSafeEqual(want, sig)) return null;
  try {
    const p = JSON.parse(new TextDecoder().decode(unb64u(payload))) as { sub: string; csrf: string; iat?: number; auth?: number; exp: number };
    if (typeof p.iat !== "number" || p.exp < nowSec()) return null;
    // A session issued before sign-in time was recorded began at its own issue time.
    return { sub: p.sub, csrf: p.csrf, iat: p.iat, auth: typeof p.auth === "number" ? p.auth : p.iat };
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

/** The sign-in state cookie: one state, nonce and PKCE verifier, scoped to the auth routes, spent by the callback. */
export const OAUTH_COOKIE = "ulak_oauth";
export const OAUTH_TTL_SEC = 600;

export function oauthCookie(state: string, nonce: string, verifier: string): string {
  return `${OAUTH_COOKIE}=${state}.${nonce}.${verifier}; HttpOnly; Secure; SameSite=Lax; Path=/auth; Max-Age=${OAUTH_TTL_SEC}`;
}

/** PKCE S256 (RFC 7636): the verifier stays in the state cookie; Google is sent only its hash. */
export async function newPkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = b64u(crypto.getRandomValues(new Uint8Array(32)));
  return { verifier, challenge: b64u(await crypto.subtle.digest("SHA-256", enc.encode(verifier))) };
}

/** Same Path as the setter, or the browser keeps the original. */
export function clearOauthCookie(): string {
  return `${OAUTH_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/auth; Max-Age=0`;
}

/** A key or token made by a form post rides to the page the post redirects to in this cookie,
 *  sealed so the browser's cookie store never holds it readable, and is shown there once. */
export const REVEAL_COOKIE = "ulak_reveal";
export const REVEAL_TTL_SEC = 60;

const revealKey = async (secret: string) =>
  crypto.subtle.importKey("raw", await crypto.subtle.digest("SHA-256", enc.encode(`reveal:${secret}`)), "AES-GCM", false, ["encrypt", "decrypt"]);

/** Sealed to one admin and one page; it opens nowhere else and not after REVEAL_TTL_SEC. */
export async function sealReveal(secret: string, sub: string, page: string, shown: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = enc.encode(JSON.stringify({ sub, page, shown, exp: nowSec() + REVEAL_TTL_SEC }));
  return `${b64u(iv)}.${b64u(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await revealKey(secret), plain))}`;
}

/** The sealed value, or undefined for a cookie that is absent, altered, stale, or another admin's or page's. */
export async function openReveal<T>(secret: string, cookie: string | undefined, sub: string, page: string): Promise<T | undefined> {
  try {
    const [iv, sealed] = (cookie ?? "").split(".");
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64u(iv!) }, await revealKey(secret), unb64u(sealed!));
    const p = JSON.parse(new TextDecoder().decode(plain)) as { sub: string; page: string; shown: T; exp: number };
    return p.sub === sub && p.page === page && p.exp >= nowSec() ? p.shown : undefined;
  } catch {
    return undefined;
  }
}

export function revealCookie(value: string): string {
  return `${REVEAL_COOKIE}=${value}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${REVEAL_TTL_SEC}`;
}

export function clearRevealCookie(): string {
  return `${REVEAL_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
}
