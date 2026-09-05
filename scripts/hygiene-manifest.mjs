// Writes test/hygiene-manifest.json: every committed text file and its content, so the hygiene
// test (which runs inside the Workers runtime and has no filesystem) can scan the repository.
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const files = execSync("git ls-files", { encoding: "utf8" })
  .split("\n")
  .filter((f) => f && /\.(md|ts|mjs|json|jsonc|toml|yml|sql|example|sh)$/.test(f) && !f.endsWith("hygiene-manifest.json") && !f.endsWith("package-lock.json") && !f.startsWith("test/fixtures"));
const out = {};
for (const f of files) out[f] = readFileSync(f, "utf8");
writeFileSync("test/hygiene-manifest.json", JSON.stringify(out, null, 0));
console.log(`hygiene manifest: ${files.length} files`);
