# Test impact analysis - plan

Date: 2026-09-29. Status: planned, not built.

## Goal
Local test runs between pushes run only the test files a change can affect. Every push and every
manual deploy still runs the full suite; selection never gates a release.

## Approach
Vitest's own change selection (`vitest run --changed <base>`), which walks the module import graph
from each changed file to the test files that import it. The graph is derived from the code on
every run, so there is no map to record and none to go stale. Tried on 2026-09-29 against the
Workers pool: the last commit selected 14 of 18 test files; `vitest related src/core/notices.ts`
selected 10.

## Fail-safes
The import graph does not see inputs a test reads without importing them. A change to any of
these runs everything:
- `package.json`, `package-lock.json`, `tsconfig.json`, `vitest.config.ts`, `wrangler.test.jsonc`
- `migrations/` (applied by the test setup from the config, not imported)
- `test/setup.ts`, `test/fixtures*`, `test/helpers.ts`
- `.github/`, `scripts/`, including the selection script itself
- anything when the base commit cannot be resolved, or the working tree has a deleted file

## Tasks
1. `scripts/test-impact.mjs`: base = the last commit whose CI run on `main` passed (`gh run list`),
   else `origin/main`, else run everything. List changed files (committed since base, staged,
   unstaged, untracked). Any fail-safe hit: `vitest run --reporter verbose`. Otherwise:
   `vitest run --reporter verbose --changed <base>`. Print which rule decided.
2. `npm run test:impact` runs it. `npm test` stays the full run and stays what CI and the
   deploy steps call.
3. Tests for the script's decision function: each fail-safe path forces a full run; a change
   under `src/` alone selects.
4. Replay against the last 20 commits: for each, did the selected set contain every test file that
   failed at that commit? Record the result in `completed_tasks.md`.
