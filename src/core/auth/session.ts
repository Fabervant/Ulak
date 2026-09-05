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
export const SESSION_TTL_SEC = 43200;

export async function createSession(secret: string, sub: string, ttlSec = SESSION_TTL_SEC): Promise<string> {
  const csrf = b64u(crypto.getRandomValues(new Uint8Array(24))).slice(0, 32);
  const payload = b64u(enc.encode(JSON.stringify({ sub, csrf, exp: Math.floor(Date.now() / 1000) + ttlSec })));
  return `${payload}.${await mac(secret, payload)}`;
}

export async function readSession(secret: string, cookie: string | undefined): Promise<{ sub: string; csrf: string } | null> {
  if (!cookie) return null;
  const [payload, sig] = cookie.split(".");
  if (!payload || !sig) return null;
  const want = await mac(secret, payload);
  if (want.length !== sig.length) return null;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ sig.charCodeAt(i);
  if (diff !== 0) return null;
  try {
    const p = JSON.parse(new TextDecoder().decode(unb64u(payload))) as { sub: string; csrf: string; exp: number };
    if (p.exp < Math.floor(Date.now() / 1000)) return null;
    return { sub: p.sub, csrf: p.csrf };
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
