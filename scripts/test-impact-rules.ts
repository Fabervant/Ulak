// Which tests a local change has to run. Pure, so the rule is tested on its own; the runner in
// test-impact.mjs gathers the changes from git and asks Vitest's import graph for the files.

export interface Change {
  path: string;
  deleted: boolean;
}

export type Decision =
  | { run: "all"; reason: string }
  | { run: "related"; sources: string[]; reason: string }
  | { run: "none"; reason: string };

/** Inputs the import graph cannot see, because tests read them without importing them or they
 *  shape every run. A change to any of them runs everything. */
const GLOBAL_INPUTS: RegExp[] = [
  /^package(-lock)?\.json$/,
  /^tsconfig\.json$/,
  /^vitest\.config\.ts$/,
  /^wrangler\.test\.jsonc$/,
  /^migrations\//,
  /^test\/setup\.ts$/,
  /^test\/fixtures/,
  /^test\/helpers\.ts$/,
  /^\.github\//,
  /^scripts\//,
];

/** The hygiene test scans every committed text file through a generated manifest it imports, so
 *  a change to any file, a document included, can change its result. It runs with every change. */
export const ALWAYS_WITH_A_CHANGE = "test/docs.test.ts";

/** The decision for the root suite. `base` is null when no base commit could be resolved. The
 *  MCP server under mcp/ is its own package with its own suite; the runner handles it apart. */
export function decide(base: string | null, changes: Change[]): Decision {
  if (base === null) return { run: "all", reason: "no base commit could be resolved" };
  const deleted = changes.find((c) => c.deleted);
  if (deleted) return { run: "all", reason: `${deleted.path} was deleted; the graph cannot follow a missing file` };
  const global = changes.find((c) => GLOBAL_INPUTS.some((g) => g.test(c.path)));
  if (global) return { run: "all", reason: `${global.path} is a global input` };
  const root = changes.filter((c) => !c.path.startsWith("mcp/")).map((c) => c.path);
  if (!root.length) return { run: "none", reason: changes.length ? "only mcp/ changed" : `nothing changed since ${base.slice(0, 7)}` };
  return { run: "related", sources: [...root, ALWAYS_WITH_A_CHANGE], reason: `${root.length} changed file(s) since ${base.slice(0, 7)}` };
}

/** Whether the MCP server's own suite has to run. */
export const touchesMcp = (changes: Change[]): boolean => changes.some((c) => c.path.startsWith("mcp/"));
