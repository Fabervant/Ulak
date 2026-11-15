import { applyD1Migrations, env } from "cloudflare:test";
import { afterEach, beforeEach, vi } from "vitest";
import { leaksBetween, takeSnapshot } from "./leakDetector";
import { WIPED_TABLES } from "./wipedTables";

// Setup files run outside per-test storage isolation and may run more than
// once; applyD1Migrations only applies what has not been applied yet.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

// The leak detector (test/leakDetector.ts). Registered first, so its afterEach runs last (Vitest runs after-hooks
// in reverse), after the file's own cleanup. What the config's unstubGlobals, unstubEnvs and restoreMocks would undo
// before the next test is undone here first, so only what they cannot reach is named.
let leakBaseline: ReturnType<typeof takeSnapshot> | null = null;
beforeEach(() => {
  leakBaseline = takeSnapshot();
});
afterEach(() => {
  if (!leakBaseline) return;
  const before = leakBaseline;
  leakBaseline = null;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  const leaks = leaksBetween(before, takeSnapshot());
  if (leaks.length > 0) throw new Error(`[leak] this test left state behind for the next one: ${leaks.join("; ")}`);
});

// Storage is shared between the tests of one file, so every test starts from
// empty tables and an empty bucket.
beforeEach(async () => {
  await env.DB.batch(WIPED_TABLES.map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  const objects = await env.IMAGES.list();
  await Promise.all(objects.objects.map((o) => env.IMAGES.delete(o.key)));
});
