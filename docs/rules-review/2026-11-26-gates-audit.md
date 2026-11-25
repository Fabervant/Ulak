# 2026-11-26 - Gates audit (rules review, "Gates and limits that do more harm than good")

Per the operations project's rules-review runbook of 2026-11-11. Every automatic gate in Ulak, judged on
its record. The evidence was gathered by the S30 session; the verdicts are a fresh reviewer's that built none of them.

## Where the record comes from

- **GitHub Actions:** all 92 CI runs of this repository (85 passed, 7 failed); each failure's failing step read from its log.
- **Session transcripts:** the 19 Claude Code transcripts kept for this project (2026-10-28 to 2026-11-15, Sessions 14-29,
  subagents included), every tool result searched for each gate's refusal text. Sessions 1-13 (2026-09-05 to 2026-10-24)
  have no transcript; for them only CI and the session reviews speak.
- **Refactor mandate state** (`~/.claude/hooks/state/refactor_mandates/Ulak.json`): 9 rounds, 35 observations.
- **Timings** measured in S30 on the development machine.

A "firing" is a time the gate stopped something. Runs where an agent read the gate's code, or a test planted a failure
on purpose to prove the gate, are not counted.

## The gates

| # | Gate | Who set it | Firings | What each firing cost | Real problem stopped? | Running cost when silent |
|---|---|---|---|---|---|---|
| G1 | **Test timeout 30 s** (`vitest.config.ts` `testTimeout`) | agent, S20 (2026-11-05), after Vitest's 5 s default tripped two bulk tests under load | 0 since set (S20-S29). The 5 s default it replaced fired twice in S20 on a loaded machine (D1 100-parameter purge 6.6 s, 11 legal documents 5.3 s) | - | The 5 s firings were false: both tests were correct and slow under load | none; a hung test now takes 30 s instead of 5 s to fail |
| G2 | **Worker count 12 locally, runner default in CI** (`vitest.config.ts` `maxWorkers`) | agent, S20 (measured 32 workers 41.1 s, 12 about 28.9 s); re-measured S29 (8/16/24: 12 and 16 within noise) | a limit, not a gate: never refuses | - | - | Takes 12 threads whatever else runs. The operations project's S373 rule (owner: "yes build that shared limit") now requires `CPU_SLOTS` first, the old figure only as fallback |
| G3 | **Push check, part 1: gitleaks over the whole history** (`.githooks/pre-push`) | agent, S1 bootstrap (2026-09-05) | 0 (no "leaks found" above 0 in any transcript) | - | none recorded | about 8 s per push (4.8 s scan of 1.82 MB history) |
| G4 | **Push check, part 2: tests the change can affect** (`.githooks/pre-push` -> `npm run test:impact`) | agent, S20 (2026-11-05) | 5 refusals: S21 (2026-11-08), S22, S24, S26, S28 (all 2026-11-15) - every one the name check (G7) on a `completed_tasks.md` or rules-inventory line written at wrap-up. One push passed it and CI then failed on names (S25, `047b3a0`): the check reads the working tree, not the commits being pushed | 2-5 min each: reword the line, rebuild the manifest, re-run, re-push | Yes, each time a name of another project would have gone into the public repository | about 20-50 s per push (S20: 48 s for a clean push); selects all tests when a global input changes |
| G5 | **Leak detector** (`test/leakDetector.ts`, wired in `test/setup.ts`; with `unstubGlobals`, `unstubEnvs`, `restoreMocks`) | the operations project's S288 rollout to every project (agent recommendation, approved operations S288); built S24 (`6f1f5f6`, 2026-11-15) | 0 real firings. While being built it named workerd's console methods as replaced on every test (false: workerd hands out a fresh function each read), fixed by comparing the property itself | build-time only, about 3 min | none: the first run named 0 tests, the reverse-order run 0 failures | one snapshot before and after each of ~547 tests; not measured separately (the whole suite runs 21.5 s) |
| G6 | **Hygiene manifest** (`scripts/hygiene-manifest.mjs`, run by `pretest`, `typecheck`, `hygiene`, `test:impact`, CI) | agent, S1-S2 (2026-09-06, `c0bac2e`, `f2599cc`) | 1 CI failure at bootstrap (typecheck before the manifest existed, 2026-09-05), fixed the same day. One crash S19 on a tracked file deleted but not staged, fixed (`db83798`) | minutes, once each | no: these were the manifest's own faults | 0.2 s per run. A side cost: it scans tracked files only, so a new untracked note is not checked until `git add` (memory note "Name check needs git add") |
| G7 | **Public-repo hygiene test** (`test/docs.test.ts`): secrets, real-looking keys, bare IPv4, workers.dev hosts, other projects' names (hashed list), only example Wrangler configs | agent, S2 (`c0bac2e`) for secrets/addresses; the name check added later and extended S27-S29, each time red first. The rule it enforces (CLAUDE.md "This repository is public ... no names of the operator's other projects") carries no owner quote | Name check: fired in 8 sessions - S21, S22, S24, S25 (in CI, after the push), S26, S27, S28, S29 (twice: names already in `CLAUDE.md` found once the list was extended, and a wrap-up line). Every firing but S29's first was a line in `completed_tasks.md` or a review file written at wrap-up. Secret/address check: 1 (S17, 2026-10-31, a bare IPv4 in `completed_tasks.md`, caught by CI after the push - before G4 existed) | 2-5 min each locally; the two CI catches also left the name or address in public git history (a force push to remove it was recommended against, S29) | Yes, every one was a real name or address about to go public; and it missed one (S27 entry, still in history) until its list was extended | runs with every change (always selected), under 1 s |
| G8 | **Source-rule tests** (`test/docs.test.ts` "rules a scan of the source decides": verbose reporter, list sort key, retention clock, no captcha/AI/password) | agent, S20 ("rules as tests") | 0 | - | none recorded | under 50 ms |
| G9 | **CI** (`.github/workflows/ci.yml`: gitleaks binary, `npm ci`, hygiene, typecheck, `npm test`, the MCP suite) | agent, S1 | 7 failures in 92 runs: 2 bootstrap (paid gitleaks Action, 2026-09-05), 1 bootstrap typecheck (G6), 2 hygiene catches (G7), 2 `npm ci` lockfile out of sync (S28, 2026-11-15) | bootstrap: one session; lockfile: one re-push each | Yes: the 2 G7 catches and the 2 lockfile breaks (a deploy from that lock would not install) | about 1-2 min per push, on GitHub's runners |
| G10 | **Deploy mail-config check** (`scripts/check-mail-config.mjs`, run by `npm run deploy:api`): all six mail settings or none | agent, S14 (2026-10-28), widened to six S17 | 0 in 3 live API deploys (S20, S21 twice) | - | none recorded; it guards a self-hoster's half-set mail configuration | one `wrangler secret list` call per API deploy (a few seconds) |
| G11 | **Refactor mandate, Ulak's part** (shared hook `refactor_mandate.py`; Ulak's state file): a round on the next file owed one; while open, edits to other code refused | the operations project (shared hook; not Ulak's to change) | 9 rounds 2026-09-25 to 2026-11-15: 72 defects listed, 9+2+1+2+1 "mattered" in the five rounds that counted it (7 proven by a test red on the base). Edit gate: 2 refusals (S20 an edit outside the `legal.ts` round; S29 a shell edit of `webhook.ts` put back) | each round 7-73 min; each refusal a minute plus a deferred change (S29's `webhook.ts` fix waits in todo.md) | Yes: 7 defects proven real by a red test on the base | session-start time to open and close rounds |

Project hooks: `.claude/settings.json` holds only the memory folder; Ulak has no project hook of its own.

## Verdicts

A general-purpose agent with no part in building any gate read this table, the runbook section and every gate's
code, and gave these verdicts. "Ulak's own": set by an agent, only approved by him, so changed on evidence. "To
operations": a shared hook or a company rollout, so only a recommendation.

| # | Verdict | Reason (from the record) | Applied (S30) | Whose |
|---|---|---|---|---|
| G1 | keep | 0 firings since set; the 5 s default it replaced fired twice, both false | - | Ulak's own |
| G2 | loosen | never refuses but takes 12 threads whatever else runs | `maxWorkers` reads `CPU_SLOTS` first, 12 as fallback (`vitest.config.ts`) | Ulak's own |
| G3 | loosen: scan only the pushed commits | 0 detections ever; CI rescans the whole history anyway, but in a public repository only the local scan stops a secret before it is published | `.githooks/pre-push` scans `remote..local` per pushed ref (a new branch: all of it); proven on a planted key in a scratch clone (refused), clean range 0.6 s instead of 8 s; CI keeps the full scan | Ulak's own |
| G4 | keep | does what the company's "tests run by impact" rule asks; its only refusals were G7's real catches | moves to the shared picker in item K16 | Ulak's own |
| G5 | keep, no change from Ulak | 0 real firings; cost not measured apart from the 21.5 s suite | none | to operations: re-judge after about 90 days with no catch, measuring its per-test cost first |
| G6 | loosen: read what is published | it read the working tree only, so a name already committed but fixed in the working tree passed locally and failed in CI (S25); untracked files were not scanned until `git add` | `scripts/hygiene-manifest.mjs` scans the working tree with untracked files and, as `HEAD:<path>`, the committed copy of every file that differs | Ulak's own |
| G7 | keep; widen the name scan; move the cause | every firing was real; it scanned `.md` files only | the name scan now covers every scanned text file: on its first run it found two comments in `src/core/mail/legal.ts` naming another project (fixed); the mail vendor's required authorization scheme is exempt. Not applied: a pre-commit hook (it would add a run to every commit to save a 2-5 minute reword about once a session; the push check already stops the name before it is published) | Ulak's own |
| G8 | keep | 0 firings, under 50 ms, guards conventions nothing else enforces | - | Ulak's own |
| G9 | keep | 7 of 92 runs failed; the 2 hygiene catches and 2 lockfile breaks were real; the only place a lockfile mismatch shows | - | Ulak's own |
| G10 | keep | 0 firings in 3 deploys, a few seconds each; stops a half-set mail configuration that would otherwise fail at the first send | - | Ulak's own |
| G11 | keep, no change from Ulak | 7 defects proven real by a test red on the base; rounds of 7-73 min and 2 edit refusals | none | to operations: no change; a cap on round length is the measure if it is ever cut |

Corrections the reviewer made to the table above: the name scan covered `.md` files only (now all text files); the
push check's selected tests ran outside the shared CPU pool (they move to the shared picker, run in the pool, in K16).
The two names found in code comments were already in public history; removing them from history would be a force push
and is not done (the same call as S29).
