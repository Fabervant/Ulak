import { ApiError } from "./errors";
import type { RateLimitBinding } from "./env";

export interface RateLimiter {
  allow(key: string): Promise<boolean>;
}

/** Fixed-window in-memory limiter. Per isolate only: for tests and local dev when no binding is configured. */
export class MemoryRateLimiter implements RateLimiter {
  private hits = new Map<string, { count: number; windowStart: number }>();
  constructor(
    private limit: number,
    private periodSec: number,
  ) {}
  async allow(key: string): Promise<boolean> {
    const now = Date.now();
    const cur = this.hits.get(key);
    if (!cur || now - cur.windowStart >= this.periodSec * 1000) {
      this.hits.set(key, { count: 1, windowStart: now });
      return true;
    }
    cur.count += 1;
    return cur.count <= this.limit;
  }
}

export class BindingRateLimiter implements RateLimiter {
  constructor(private binding: RateLimitBinding) {}
  async allow(key: string): Promise<boolean> {
    return (await this.binding.limit({ key })).success;
  }
}

export function limiterFor(binding: RateLimitBinding | undefined, fallback: MemoryRateLimiter): RateLimiter {
  return binding ? new BindingRateLimiter(binding) : fallback;
}

export async function enforce(limiters: Array<{ limiter: RateLimiter; key: string }>, retryAfterSec: number): Promise<void> {
  for (const { limiter, key } of limiters) {
    if (!(await limiter.allow(key))) {
      throw new ApiError(429, "rate_limited", "too many requests; retry after the indicated seconds", true, {}, { "Retry-After": String(retryAfterSec) });
    }
  }
}

/** Per-user submit ceilings enforced in D1. The binding limiter above is a cheap first
 *  pass only: it is approximate by design and cannot hold a limit of this size. */
export const SUBMIT_BURST_LIMIT = 3;
export const SUBMIT_HOURLY_LIMIT = 10;
