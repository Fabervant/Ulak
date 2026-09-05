import { describe, it, expect } from "vitest";
import manifest from "./hygiene-manifest.json";

// The manifest is produced by scripts/hygiene-manifest.mjs from `git ls-files` and holds every
// committed text file's content. Regenerate it before running the suite: `npm run hygiene`.
// This is the automated half of the public-repository rule; operator-internal names are the
// human half, checked in review, because a regex cannot know them.

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
});
