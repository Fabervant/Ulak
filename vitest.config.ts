import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.test.jsonc" },
        miniflare: {
          // Test-only binding so the setup file can apply the migrations.
          bindings: { TEST_MIGRATIONS: migrations },
        },
      }),
    ],
    test: {
      include: ["test/**/*.test.ts"],
      setupFiles: ["./test/setup.ts"],
      // Fastest measured count on the 32-thread development machine; CI keeps its runner's default.
      maxWorkers: process.env.CI ? undefined : 12,
      // No test asserts on elapsed time, and the bulk ones outlast Vitest's 5 s on a busy machine.
      testTimeout: 30_000,
    },
  };
});
