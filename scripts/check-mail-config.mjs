// Runs before `npm run deploy:api`. Mail needs five settings, set together or not at all
// (src/core/mail/config.ts): the two vars in wrangler.api.jsonc and the three Wrangler secrets.
// A half-set configuration stops the deploy here instead of failing at the first send.
// Usage: node scripts/check-mail-config.mjs            reads the config and the live secret names
//        node scripts/check-mail-config.mjs NAME ...   judges the given names (for its own test)
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

export const MAIL_SETTINGS = ["MAIL_API_URL", "MAIL_FROM_DOMAIN", "MAIL_API_KEY", "MAIL_WEBHOOK_KEY", "MAIL_HASH_SECRET"];

/** null when all five or none are present; otherwise the missing names. */
export function halfSet(names) {
  const present = new Set(names);
  const missing = MAIL_SETTINGS.filter((n) => !present.has(n));
  return missing.length === 0 || missing.length === MAIL_SETTINGS.length ? null : missing;
}

function configuredNames() {
  const text = readFileSync("wrangler.api.jsonc", "utf8");
  // JSONC: drop line comments that start a line, then trailing commas.
  const json = text.replace(/^\s*\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1");
  const vars = Object.entries(JSON.parse(json).vars ?? {}).filter(([, v]) => String(v).trim() && !String(v).includes("REPLACE_ME")).map(([k]) => k);
  const secrets = JSON.parse(execFileSync("npx", ["wrangler", "secret", "list", "-c", "wrangler.api.jsonc", "--format", "json"], { encoding: "utf8", shell: process.platform === "win32" }));
  return [...vars, ...secrets.map((s) => s.name)];
}

const given = process.argv.slice(2);
const missing = halfSet(given.length ? given : configuredNames());
if (missing) {
  console.error(`mail configuration is half set; missing: ${missing.join(", ")}. Set all five or none (docs/self-hosting.md).`);
  process.exit(1);
}
console.log("mail configuration: all or nothing, as required");
