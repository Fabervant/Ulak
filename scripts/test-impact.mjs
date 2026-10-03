// Local test selection: runs the test files a change can affect, everything when in doubt.
// `npm test` stays the full run, and it is what CI and every deploy call; this never gates one.
//
//   node scripts/test-impact.mjs              select and run
//   node scripts/test-impact.mjs --replay 20  for each of the last 20 commits, print what the
//                                             rule would have selected from its parent
import { execFileSync, spawnSync } from "node:child_process";
import { createVitest } from "vitest/node";
import { decide, touchesMcp } from "./test-impact-rules.ts";

const git = (...args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
const lines = (s) => s.split("\n").filter(Boolean);

/** The last commit whose CI run on main passed, else origin/main, else null. */
function resolveBase() {
  try {
    const out = execFileSync("gh", ["run", "list", "--workflow", "ci", "--branch", "main", "--status", "success", "--limit", "1", "--json", "headSha"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const sha = JSON.parse(out)[0]?.headSha;
    if (sha) return git("rev-parse", "--verify", "--quiet", `${sha}^{commit}`);
  } catch {}
  try {
    return git("rev-parse", "--verify", "--quiet", "origin/main^{commit}");
  } catch {
    return null;
  }
}

/** Changes from `base` to `head`, or to the working tree with its untracked files when no head. */
function changesSince(base, head) {
  const diff = lines(git("diff", "--name-status", "--no-renames", base, ...(head ? [head] : [])));
  const changes = diff.map((l) => {
    const [status, path] = l.split("\t");
    return { path, deleted: status === "D" };
  });
  if (!head) for (const path of lines(git("ls-files", "--others", "--exclude-standard"))) changes.push({ path, deleted: false });
  return changes;
}

/** The test files Vitest's import graph relates to these sources, repository-relative. */
async function relatedTests(sources) {
  const vitest = await createVitest("test", { watch: false, related: sources, passWithNoTests: true });
  try {
    const slash = (p) => p.split(String.fromCharCode(92)).join("/");
    const root = `${slash(process.cwd())}/`;
    return [...new Set((await vitest.getRelevantTestSpecifications()).map((s) => slash(s.moduleId).replace(root, "")))].sort();
  } finally {
    await vitest.close();
  }
}

const run = (cmd, args, cwd) => spawnSync(cmd, args, { stdio: "inherit", cwd, shell: process.platform === "win32" }).status ?? 1;

async function select(base, changes) {
  const d = decide(base, changes);
  if (d.run !== "related") return { ...d, files: d.run === "all" ? "all" : [] };
  return { ...d, files: await relatedTests(d.sources) };
}

async function main() {
  const at = process.argv.indexOf("--replay");
  if (at !== -1) {
    const n = Number(process.argv[at + 1] ?? 20);
    for (const sha of lines(git("rev-list", "--first-parent", `--max-count=${n}`, "HEAD"))) {
      const parent = git("rev-parse", "--verify", "--quiet", `${sha}^1`);
      const changes = changesSince(parent, sha);
      const s = await select(parent, changes);
      const tests = changes.filter((c) => /^test\/.+\.test\.ts$/.test(c.path) && !c.deleted).map((c) => c.path);
      const missed = s.files === "all" ? [] : tests.filter((t) => !s.files.includes(t));
      const picked = s.files === "all" ? "all" : `${s.files.length}`;
      console.log(`${sha.slice(0, 7)} ${picked.padStart(3)} selected; changed tests ${tests.length}, missed ${missed.length}${missed.length ? ` (${missed.join(", ")})` : ""}; ${s.reason}`);
    }
    return 0;
  }
  const base = resolveBase();
  const changes = base ? changesSince(base) : [];
  const s = await select(base, changes);
  console.log(`test impact: ${s.reason}; ${s.files === "all" ? "running every test file" : `running ${s.files.length} test file(s)`}`);
  let status = 0;
  if (s.files === "all") status = run("npx", ["vitest", "run", "--reporter", "verbose"]);
  else if (s.files.length) status = run("npx", ["vitest", "run", "--reporter", "verbose", ...s.files]);
  if (touchesMcp(changes)) {
    console.log("test impact: mcp/ changed; running its suite");
    status = run("npm", ["run", "build"], "mcp") || run("npm", ["test"], "mcp") || status;
  }
  return status;
}

process.exit(await main());
