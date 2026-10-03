import { describe, it, expect } from "vitest";
import { decide, touchesMcp, ALWAYS_WITH_A_CHANGE, type Change } from "../scripts/test-impact-rules";

const BASE = "0e8bc8adb99462f253551f3e6f43c51528ea8a33";
const changed = (...paths: string[]): Change[] => paths.map((path) => ({ path, deleted: false }));

describe("test impact: what a local change runs", () => {
  it("a change under src/ alone selects by the import graph, with the hygiene test always included", () => {
    expect(decide(BASE, changed("src/core/images.ts", "test/images.test.ts"))).toEqual({
      run: "related",
      sources: ["src/core/images.ts", "test/images.test.ts", ALWAYS_WITH_A_CHANGE],
      reason: "2 changed file(s) since 0e8bc8a",
    });
  });

  it("a document alone still runs the hygiene test, which scans every committed file", () => {
    expect(decide(BASE, changed("docs/spec.md"))).toMatchObject({ run: "related", sources: ["docs/spec.md", ALWAYS_WITH_A_CHANGE] });
  });

  it("every global input forces the full run, whatever else changed", () => {
    for (const path of [
      "package.json",
      "package-lock.json",
      "tsconfig.json",
      "vitest.config.ts",
      "wrangler.test.jsonc",
      "migrations/0005_new.sql",
      "test/setup.ts",
      "test/fixtures.ts",
      "test/helpers.ts",
      ".github/workflows/ci.yml",
      "scripts/test-impact-rules.ts",
      "scripts/hygiene-manifest.mjs",
    ]) {
      expect(decide(BASE, changed("src/core/images.ts", path))).toEqual({ run: "all", reason: `${path} is a global input` });
    }
  });

  it("a deleted file forces the full run, since the graph cannot follow it", () => {
    expect(decide(BASE, [{ path: "src/core/old.ts", deleted: true }])).toMatchObject({ run: "all" });
  });

  it("no base commit forces the full run", () => {
    expect(decide(null, changed("src/core/images.ts"))).toEqual({ run: "all", reason: "no base commit could be resolved" });
  });

  it("no change runs nothing; a change only under mcp/ runs only the MCP server's suite", () => {
    expect(decide(BASE, [])).toMatchObject({ run: "none" });
    expect(touchesMcp([])).toBe(false);
    expect(decide(BASE, changed("mcp/src/server.ts"))).toEqual({ run: "none", reason: "only mcp/ changed" });
    expect(touchesMcp(changed("mcp/src/server.ts"))).toBe(true);
  });
});
