import type { D1Migration } from "@cloudflare/vitest-pool-workers";
import type { Env as UlakEnv } from "../src/core/env";

declare global {
  namespace Cloudflare {
    interface Env extends UlakEnv {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
