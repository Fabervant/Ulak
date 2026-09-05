import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { Env } from "../env";

const ISSUERS = ["https://accounts.google.com", "accounts.google.com"];
const JWKS_URL = new URL("https://www.googleapis.com/oauth2/v3/certs");
let jwks: JWTVerifyGetKey | undefined;

export function authUrl(env: Env, state: string, nonce: string, redirectUri: string): string {
  const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  u.searchParams.set("client_id", env.GOOGLE_CLIENT_ID ?? "");
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", "openid email");
  u.searchParams.set("state", state);
  u.searchParams.set("nonce", nonce);
  u.searchParams.set("prompt", "select_account");
  return u.toString();
}

export async function exchangeCode(env: Env, code: string, redirectUri: string, fetchImpl: typeof fetch = fetch): Promise<{ id_token: string }> {
  const res = await fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID ?? "",
      client_secret: env.GOOGLE_CLIENT_SECRET ?? "",
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) throw new Error(`token exchange failed: HTTP ${res.status}`);
  const j = await res.json<{ id_token?: string }>();
  if (!j.id_token) throw new Error("token exchange returned no id_token");
  return { id_token: j.id_token };
}

/** Verifies signature, issuer, audience, expiry and nonce. Returns the stable subject and the email as claimed. */
export async function verifyIdToken(env: Env, idToken: string, nonce: string, getKey?: JWTVerifyGetKey): Promise<{ sub: string; email: string; email_verified: boolean }> {
  const key = getKey ?? (jwks ??= createRemoteJWKSet(JWKS_URL));
  const { payload } = await jwtVerify(idToken, key, { issuer: ISSUERS, audience: env.GOOGLE_CLIENT_ID ?? "" });
  if (payload.nonce !== nonce) throw new Error("nonce mismatch");
  if (typeof payload.sub !== "string" || typeof payload.email !== "string") throw new Error("token lacks sub or email");
  return { sub: payload.sub, email: payload.email, email_verified: payload.email_verified === true };
}
