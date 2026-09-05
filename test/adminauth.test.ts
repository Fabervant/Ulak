import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { SignJWT, generateKeyPair } from "jose";
import { createSession, readSession } from "../src/core/auth/session";
import { verifyIdToken, authUrl } from "../src/core/auth/google";
import { bootstrapAdmin, findAdmin } from "../src/core/auth/admins";
import { ApiError } from "../src/core/errors";

describe("session", () => {
  it("round-trips and rejects tampering and expiry", async () => {
    const s = await createSession("secret", "sub-1", 60);
    const got = await readSession("secret", s);
    expect(got?.sub).toBe("sub-1");
    expect(got?.csrf).toHaveLength(32);
    expect(await readSession("other", s)).toBeNull();
    expect(await readSession("secret", s.slice(0, -2) + "zz")).toBeNull();
    expect(await readSession("secret", await createSession("secret", "sub-1", -1))).toBeNull();
    expect(await readSession("secret", undefined)).toBeNull();
  });
});

describe("google", () => {
  it("authUrl carries client id, redirect, state, nonce and openid email scope", () => {
    const u = new URL(authUrl(env, "st", "no", "https://admin.example.invalid/auth/callback"));
    expect(u.origin + u.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(u.searchParams.get("client_id")).toBe("test-client-id");
    expect(u.searchParams.get("scope")).toBe("openid email");
    expect(u.searchParams.get("state")).toBe("st");
    expect(u.searchParams.get("nonce")).toBe("no");
  });
  it("verifyIdToken accepts a token signed by the key and checks nonce, aud, iss", async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const getKey = async () => publicKey;
    const mint = (claims: Record<string, unknown>, iss = "https://accounts.google.com", aud = "test-client-id") =>
      new SignJWT({ email: "admin@example.invalid", email_verified: true, nonce: "no", ...claims })
        .setProtectedHeader({ alg: "RS256", kid: "k1" })
        .setIssuer(iss)
        .setAudience(aud)
        .setSubject("sub-1")
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(privateKey);
    const ok = await verifyIdToken(env, await mint({}), "no", getKey);
    expect(ok).toEqual({ sub: "sub-1", email: "admin@example.invalid", email_verified: true });
    await expect(verifyIdToken(env, await mint({ nonce: "wrong" }), "no", getKey)).rejects.toThrow(/nonce/);
    await expect(verifyIdToken(env, await mint({}, undefined, "other"), "no", getKey)).rejects.toThrow();
    await expect(verifyIdToken(env, await mint({}, "https://evil.example"), "no", getKey)).rejects.toThrow();
  });
});

describe("admins", () => {
  it("pins the sub on first login for a bootstrap email, then ignores the email", async () => {
    const a = await bootstrapAdmin(env.DB, env, "sub-1", "admin@example.invalid", true);
    expect(a.sub).toBe("sub-1");
    expect((await findAdmin(env.DB, "sub-1"))!.email_at_pin).toBe("admin@example.invalid");
    // Same sub, renamed account: still an admin.
    expect((await bootstrapAdmin(env.DB, env, "sub-1", "renamed@example.invalid", true)).sub).toBe("sub-1");
  });
  it("refuses an unlisted email, an unverified email, and never pins a second sub for the same listed email", async () => {
    await expect(bootstrapAdmin(env.DB, env, "sub-x", "stranger@example.invalid", true)).rejects.toBeInstanceOf(ApiError);
    await expect(bootstrapAdmin(env.DB, env, "sub-y", "admin@example.invalid", false)).rejects.toBeInstanceOf(ApiError);
    await bootstrapAdmin(env.DB, env, "sub-1", "admin@example.invalid", true);
    await expect(bootstrapAdmin(env.DB, env, "sub-2", "admin@example.invalid", true)).rejects.toThrow(/already pinned/);
  });
});
