import { defineConfig } from "vitest/config";

// The MCP server is plain Node, not a Worker: no Cloudflare plugin here.
export default defineConfig({
  test: { include: ["test/**/*.test.ts"] },
});
