import type { D1Migration } from "@cloudflare/vitest-pool-workers";
import type { Env as UlakEnv, RateLimitBinding } from "../src/core/env";

declare global {
  namespace Cloudflare {
    interface Env extends UlakEnv {
      TEST_MIGRATIONS: D1Migration[];
      /** Test-only rate-limit namespace. Lets the seam test drive BindingRateLimiter against
       *  the real binding without routing the whole suite through the platform limiter. */
      RL_PROBE: RateLimitBinding;
    }
  }
}
