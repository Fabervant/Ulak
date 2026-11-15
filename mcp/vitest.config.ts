import { defineConfig } from "vitest/config";

// The MCP server is plain Node, not a Worker: no Cloudflare plugin here.
// No test's stub reaches the next test.
export default defineConfig({
  test: { include: ["test/**/*.test.ts"], unstubGlobals: true, unstubEnvs: true, restoreMocks: true },
});
