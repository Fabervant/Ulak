import { describe, it, expect } from "vitest";
import { sha256Hex } from "../src/core/ids";
import manifest from "./hygiene-manifest.json";

// The manifest is produced by scripts/hygiene-manifest.mjs from `git ls-files` and holds every
// committed text file's content. Regenerate it before running the suite: `npm run hygiene`.
// It also holds the CLAUDE.md rules a scan of the source can decide.

const forbidden: Array<{ name: string; re: RegExp }> = [
  { name: "Telegram bot token", re: /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/ },
  { name: "real-looking Ulak key", re: /ulak_(?:admin|[a-z0-9_-]{2,32})_[0-9a-f]{48}/ },
  { name: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: "private key block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "workers.dev hostname", re: /[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev/ },
];
// RFC 5737 and RFC 1918 addresses are documentation ranges and are allowed.
const allowedIps = /\b(?:203\.0\.113|198\.51\.100|192\.0\.2|10\.0\.0)\.\d{1,3}\b/g;
const ipv4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/;

// The operator's other projects and mail vendor, each as the SHA-256 of its lower-cased name, so
// this public file does not hold them. A new project's name is added here when it appears.
const OTHER_NAMES = new Set([
  "0116ade78205b55b9e3a8fd618c4d4e35902f513fa70ef4eb5c7b13d4162bace",
  "04c0d9f099cf52cd45a41ad7a9068b24418242e357c3b3316f85e0fbce7cbed9",
  "129b78122399ecbb0bdf31c726ca861ddec994b513680cdd7229dcfb6aaaef85",
  "1479eab3cdf93ed5f9549803be967f924e67566f56abba24787d08edc79cb638",
  "265831777dfabb283cc96b486ee7d4568d1017da3eeaf4c23b284e12fedf57c1",
  "336178c2e3c358edf8128c1511b6c6e92241381ac533ead80395744e2582c9f8",
  "3f99a74dfd47e8855e8960725af2cda49e8f27506dc1515cf7001e55597b8904",
  "417a71682814ed132f0ee1541ead915d024ea0ff332a7ff7ea7ff608fa4d1ec2",
  "47dd984fb3ac60d0046c7b07e5172a9a0afe938819b4a1d68ad03d609edad402",
  "59166dce664823e8e11ec77f8ebbe50bcdfe31e8aa70ee9bde22534abdd8684d",
  "5ca7587ecd19b8111ba1a82be0fae82c53ffe05d1aea5b9f0874ade5b0abfa4e",
  "632565313a85b83c0239f3b6cdbf99e6f124650bfce7854bf2acb3e269977114",
  "7863a379f7190c022f37a148cc915807b93dd5b3148ae9802e20bb44a0819897",
  "7ecc6a21c03afec7769b1bc0dc2b084c4ea3479e30a7f03e571bdacf98cd315a",
  "903d3f527c442c63c36deca2b9511b238e3b1ddbfbf62ac2f7c0c306c7b1feb0",
  "98e88d646f9b7780b4ed22ad54681e4c8705fac7077391f33088d6646dbe30f1",
  "b71d3c75396c0eac75544faad2d5ecadb919ac552e6561b29c323b2ac456e3f4",
  "cb2317426a5c336d2b0a044101bb5f53bcc1b5ca1630f486fb707b9b1f549cbe",
  "cd1b01f64a548af98b48ce4ecda68d903554310fa11c86584810be3706e25f04",
  "cd7fe5918d707255325553663680b81ba07573a6155baaa0826facf73a3a21dd",
  "cfdd0116375f7c5d147e28a91cd4d065de0175f6f644bc26be23f4adf7951850",
  "e212fc1b78c89af6a945c037f4c8def49e1f4425695ac582b29e55923d126057",
  "e62315d4e0a03c958868348afbf100bf0ff0eceb9952a03177bfc513a599fd03",
  "fe7cb2d7e0392dfe029c7f1c58109b1999eb82f31ac581d2f6cf3a64ae04d62b",
]);

/** The lines of a note that name one, by word or by two words run together. */
async function linesNamingAnother(text: string, known: Map<string, boolean>): Promise<number[]> {
  const found: number[] = [];
  for (const [i, line] of text.split("\n").entries()) {
    const words = line.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
    for (const [j, word] of words.entries()) {
      for (const candidate of [word, word + (words[j + 1] ?? "")]) {
        if (!known.has(candidate)) known.set(candidate, OTHER_NAMES.has(await sha256Hex(candidate)));
        if (known.get(candidate)) found.push(i + 1);
      }
    }
  }
  return found;
}

describe("public repository hygiene", () => {
  const files = Object.entries(manifest as Record<string, string>);
  it("manifest is fresh and non-trivial", () => {
    expect(files.length).toBeGreaterThan(20);
  });
  for (const [f, text] of files) {
    it(`${f} contains no secret or address`, () => {
      for (const { name, re } of forbidden) expect(text, `${f}: ${name}`).not.toMatch(re);
      expect(text.replace(allowedIps, ""), `${f}: bare IPv4 address`).not.toMatch(ipv4);
    });
  }
  // The failure gives the file and line only: CI's log is public too.
  it("no note names another of the operator's projects or its mail vendor", async () => {
    const known = new Map<string, boolean>();
    const hits: string[] = [];
    for (const [f, text] of files) if (f.endsWith(".md")) for (const line of await linesNamingAnother(text, known)) hits.push(`${f}:${line}`);
    expect(hits).toEqual([]);
  });
  it("only the example and test Wrangler configs are committed", () => {
    expect(files.map(([f]) => f).filter((f) => /^wrangler\./.test(f) && !/\.example$|^wrangler\.test\.jsonc$/.test(f))).toEqual([]);
  });
});

describe("rules a scan of the source decides", () => {
  const all = manifest as Record<string, string>;
  const source = Object.entries(all).filter(([f]) => f.startsWith("src/"));
  it("the test script keeps the verbose reporter", () => {
    expect(JSON.parse(all["package.json"]!).scripts.test).toContain("--reporter verbose");
  });
  it("a list of messages sorts by received_at, a user's poll aside", () => {
    const rest = all["src/core/messages.ts"]!.replace(/export async function listForUser[\s\S]*?\n}\n/, "");
    const sorts = [...rest.matchAll(/FROM messages[^`"]*ORDER BY (\w+)/g)].map((m) => m[1]);
    expect(sorts.length).toBeGreaterThan(0);
    expect(sorts.filter((s) => s !== "received_at" && s !== "app")).toEqual([]);
  });
  it("retention counts from last_activity_at alone", () => {
    const lines = source.flatMap(([, text]) => text.split("\n")).filter((l) => l.includes("a.retention_days ||"));
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.filter((l) => !l.includes("last_activity_at"))).toEqual([]);
  });
  it("Ulak holds no captcha, AI provider or password sign-in", () => {
    const banned = /anthropic|openai|gemini|captcha|turnstile|type="password"|password_hash/i;
    expect([...source, ["package.json", all["package.json"]!] as const].filter(([, text]) => banned.test(text)).map(([f]) => f)).toEqual([]);
  });
});
