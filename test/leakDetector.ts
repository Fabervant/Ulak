// The leak detector (operations' run-order rollout, 2026-11-09; rule: no test depends on the clock or on run order).
// A test that leaves shared state changed makes the next test pass or fail for a reason of its own. test/setup.ts
// takes a snapshot of that state before each test and compares after it; a test that leaves a difference fails,
// named, in one normal-order run. What it reads is the state Ulak's tests can reach: a global replaced or added, a
// console method silenced, an environment variable, fake timers left on, the swappable transports (the mail vendor's
// fetch, the Telegram sender) and the test bindings object every file shares.
import { env } from "cloudflare:test";
import { vi } from "vitest";
import { vendorTransport } from "../src/core/mail/vendor";
import { TelegramNotifier } from "../src/core/notify/telegram";

export type Snapshot = {
  globals: Set<string>;
  values: Map<string, unknown>;
  env: Map<string, string | undefined>;
  bindings: Map<string, unknown>;
  seams: Map<string, unknown>;
  fakeTimers: boolean;
};

/** Globals whose identity a test changing is a leak. */
const WATCHED_GLOBALS = ["fetch", "Date", "setTimeout", "setInterval", "clearTimeout", "clearInterval", "queueMicrotask", "crypto", "Request", "Response", "Headers", "caches", "console"];
const WATCHED_CONSOLE = ["log", "info", "warn", "error", "debug"] as const;

/** Globals the test runner adds on its own while a file runs, never a test's doing. */
const IGNORED_GLOBALS = new Set(["__vitest_worker__", "__vitest_index__", "__vitest_mocker__", "__vite_ssr_import_meta__"]);

/** What an object's own or inherited property holds: its value, or its getter when it has one. */
function held(target: object, name: string): unknown {
  for (let o: object | null = target; o; o = Object.getPrototypeOf(o)) {
    const d = Object.getOwnPropertyDescriptor(o, name);
    if (d) return d.get ?? d.value;
  }
  return undefined;
}

function seams(): Map<string, unknown> {
  const out = new Map<string, unknown>([["vendorTransport.fetch", vendorTransport.fetch]]);
  const proto = TelegramNotifier.prototype as unknown as Record<string, unknown>;
  for (const name of Object.getOwnPropertyNames(proto)) out.set(`TelegramNotifier.prototype.${name}`, proto[name]);
  return out;
}

export function takeSnapshot(): Snapshot {
  const g = globalThis as unknown as Record<string, unknown>;
  const values = new Map<string, unknown>(WATCHED_GLOBALS.map((name) => [name, g[name]]));
  // workerd hands out a fresh function on each read of a console method, so the property itself is compared.
  for (const m of WATCHED_CONSOLE) values.set(`console.${m}`, held(console, m));
  values.set("Date.now", Date.now);
  return {
    globals: new Set(Object.getOwnPropertyNames(globalThis)),
    values,
    env: new Map(Object.entries(process.env)),
    bindings: new Map(Object.entries(env as unknown as Record<string, unknown>)),
    seams: seams(),
    fakeTimers: vi.isFakeTimers(),
  };
}

function changedKeys(label: string, before: Map<string, unknown>, after: Map<string, unknown>): string[] {
  const keys = new Set([...before.keys(), ...after.keys()]);
  return [...keys].filter((k) => before.get(k) !== after.get(k) || before.has(k) !== after.has(k)).map((k) => `${label}: ${k}`);
}

/** What changed between two snapshots, one line each; empty when the test left nothing behind. */
export function leaksBetween(before: Snapshot, after: Snapshot): string[] {
  const out: string[] = [];
  for (const name of after.globals) if (!before.globals.has(name) && !IGNORED_GLOBALS.has(name)) out.push(`global added: ${name}`);
  out.push(...changedKeys("global replaced", before.values, after.values));
  out.push(...changedKeys("env changed", before.env, after.env));
  out.push(...changedKeys("binding changed", before.bindings, after.bindings));
  out.push(...changedKeys("seam replaced", before.seams, after.seams));
  if (after.fakeTimers && !before.fakeTimers) out.push("fake timers left on");
  return out;
}
