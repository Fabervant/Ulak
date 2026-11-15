import { env } from "cloudflare:test";
import { describe, it, expect, vi } from "vitest";
import { leaksBetween, takeSnapshot } from "./leakDetector";
import { WIPED_TABLES } from "./wipedTables";
import { vendorTransport } from "../src/core/mail/vendor";
import { TelegramNotifier } from "../src/core/notify/telegram";

// Each check plants one leak, reads it named, and takes the plant away before the test ends.
function leaksOf(plant: () => void, undo: () => void): string[] {
  const before = takeSnapshot();
  plant();
  const leaks = leaksBetween(before, takeSnapshot());
  undo();
  return leaks;
}

/** Takes `name` back to exactly what `target` held before: its own descriptor, or none. */
function keeper(target: object, name: string): () => void {
  const own = Object.getOwnPropertyDescriptor(target, name);
  return () => {
    if (own) Object.defineProperty(target, name, own);
    else delete (target as Record<string, unknown>)[name];
  };
}

describe("leak detector", () => {
  it("names nothing when nothing changed", () => {
    expect(leaksBetween(takeSnapshot(), takeSnapshot())).toEqual([]);
  });

  it("names a global added", () => {
    const g = globalThis as Record<string, unknown>;
    expect(leaksOf(() => (g.ulakPlanted = 1), () => delete g.ulakPlanted)).toEqual(["global added: ulakPlanted"]);
  });

  it("names fetch replaced", () => {
    expect(leaksOf(() => (globalThis.fetch = (async () => new Response()) as typeof fetch), keeper(globalThis, "fetch"))).toContain("global replaced: fetch");
  });

  it("names a console method silenced", () => {
    expect(leaksOf(() => (console.warn = () => {}), keeper(console, "warn"))).toEqual(["global replaced: console.warn"]);
  });

  it("names Date.now replaced", () => {
    const real = Date.now;
    expect(leaksOf(() => (Date.now = () => 0), () => (Date.now = real))).toEqual(["global replaced: Date.now"]);
  });

  it("names an environment variable", () => {
    expect(leaksOf(() => (process.env.ULAK_PLANTED = "1"), () => delete process.env.ULAK_PLANTED)).toEqual(["env changed: ULAK_PLANTED"]);
  });

  it("names a binding changed", () => {
    const b = env as unknown as Record<string, unknown>;
    expect(leaksOf(() => (b.ULAK_PLANTED = "1"), () => delete b.ULAK_PLANTED)).toEqual(["binding changed: ULAK_PLANTED"]);
  });

  it("names the mail vendor's transport replaced", () => {
    const real = vendorTransport.fetch;
    expect(leaksOf(() => (vendorTransport.fetch = (async () => new Response()) as typeof fetch), () => (vendorTransport.fetch = real))).toEqual(["seam replaced: vendorTransport.fetch"]);
  });

  it("names the Telegram sender replaced", () => {
    const real = TelegramNotifier.prototype.send;
    expect(leaksOf(() => (TelegramNotifier.prototype.send = async () => {}), () => (TelegramNotifier.prototype.send = real))).toEqual(["seam replaced: TelegramNotifier.prototype.send"]);
  });

  it("names fake timers left on", () => {
    expect(leaksOf(() => vi.useFakeTimers(), () => vi.useRealTimers())).toContain("fake timers left on");
  });

  it("the per-test wipe covers every table", async () => {
    const rows = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name != 'd1_migrations'").all<{ name: string }>();
    expect(rows.results.map((r) => r.name).sort()).toEqual([...WIPED_TABLES].sort());
  });
});
