import { describe, it, expect, vi } from "vitest";
import { MemoryRateLimiter, enforce } from "../src/core/ratelimit";
import { clientIp } from "../src/core/clientip";
import { ApiError } from "../src/core/errors";
import type { Env } from "../src/core/env";

describe("MemoryRateLimiter", () => {
  it("allows limit then blocks until the period rolls", async () => {
    vi.useFakeTimers();
    const rl = new MemoryRateLimiter(2, 60);
    expect(await rl.allow("k")).toBe(true);
    expect(await rl.allow("k")).toBe(true);
    expect(await rl.allow("k")).toBe(false);
    expect(await rl.allow("other")).toBe(true);
    vi.advanceTimersByTime(61_000);
    expect(await rl.allow("k")).toBe(true);
    vi.useRealTimers();
  });
});

describe("enforce", () => {
  it("throws 429 with Retry-After when any limiter refuses", async () => {
    const yes = { allow: async () => true };
    const no = { allow: async () => false };
    await expect(enforce([{ limiter: yes, key: "a" }], 60)).resolves.toBeUndefined();
    try {
      await enforce(
        [
          { limiter: yes, key: "a" },
          { limiter: no, key: "b" },
        ],
        60,
      );
      throw new Error("expected throw");
    } catch (e) {
      const err = e as ApiError;
      expect(err.status).toBe(429);
      expect(err.retryable).toBe(true);
      expect(err.headers["Retry-After"]).toBe("60");
    }
  });
});

describe("clientIp", () => {
  const env = (trust: string) => ({ TRUST_X_FORWARDED_FOR: trust }) as unknown as Env;
  it("prefers CF-Connecting-IP", () => {
    const r = new Request("https://x", { headers: { "cf-connecting-ip": "203.0.113.5", "x-forwarded-for": "198.51.100.9" } });
    expect(clientIp(r, env("true"))).toBe("203.0.113.5");
  });
  it("ignores X-Forwarded-For unless trusted", () => {
    const r = new Request("https://x", { headers: { "x-forwarded-for": "198.51.100.9, 10.0.0.1" } });
    expect(clientIp(r, env("false"))).toBe("unknown");
    expect(clientIp(r, env("true"))).toBe("198.51.100.9");
  });
});
