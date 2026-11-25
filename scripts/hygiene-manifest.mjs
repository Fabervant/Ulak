// Writes test/hygiene-manifest.json so the hygiene test (which runs inside the Workers runtime and has no
// filesystem) can scan what this repository publishes: every text file of the working tree that git does
// not ignore, untracked ones included, and - keyed `HEAD:<path>` - the committed copy of each one whose
// committed text differs, because a push publishes the commits, not the working tree.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const scanned = (f) => f && /\.(md|ts|mjs|json|jsonc|toml|yml|sql|example|sh)$/.test(f) && !f.endsWith("hygiene-manifest.json") && !f.endsWith("package-lock.json") && !f.startsWith("test/fixtures");

const out = {};
// A tracked file deleted but not yet staged is still listed; it has no working copy left to read.
for (const f of git("ls-files", "--cached", "--others", "--exclude-standard").split("\n").filter(scanned)) {
  if (existsSync(f)) out[f] = readFileSync(f, "utf8");
}
const headHas = (f) => git("ls-tree", "--name-only", "HEAD", "--", f).trim() !== "";
for (const f of git("diff", "--name-only", "--no-renames", "HEAD").split("\n").filter(scanned)) {
  if (headHas(f)) out[`HEAD:${f}`] = git("show", `HEAD:${f}`);
}
writeFileSync("test/hygiene-manifest.json", JSON.stringify(out, null, 0));
console.log(`hygiene manifest: ${Object.keys(out).length} files`);
