# Ulak - rules inventory (rules review step 1)

Per the operator's rules-review runbook of 2026-11-11, step 1. Marks are proposals until
steps 2 and 3: DEL-O waits for the clean-room test, ASK and every ruling of his wait for his word.

## Before figures (read from the files, 2026-11-15, Session 25)

| Figure | Value |
|---|---|
| `CLAUDE.md` | 1,723 bytes, 28 lines |
| `memory/MEMORY.md` | 2,374 bytes, 22 lines (21 notes + the to-do file) |
| Memory topic files | 24 (21 notes, `todo.md`, and two script-kept records not indexed: `session_ledger.md`, `task_cost.md`) |
| Lesson files | 0 (no `feedback_*` files; two notes carry lessons, M18 and M19) |
| Project skills | 0 (0 bytes) |
| Project hooks | 0 (`.claude/settings.json` holds only `autoMemoryDirectory`) |
| `skipped_issues.md` | 963 bytes, 2 open entries (deferred work, not rules) |

## CLAUDE.md

| ID | Rule (short) | Source | File:line | Mark | Why |
|---|---|---|---|---|---|
| C1 | You own this codebase: no repeated code, improve, suggest features | operations S297 | CLAUDE.md:3 | KEEP | the sentence every project carries by operations' letter |
| C2 | What Ulak is; spec and plan paths | - | CLAUDE.md:5-6 | KEEP | fact a model cannot know |
| C3 | Stack: three Workers, D1, R2, Hono, jose, Vitest Workers plugin; core has no HTTP | - | CLAUDE.md:9-11 | KEEP | fact; the core/HTTP split is a design rule |
| C4 | `npm test` is verbose; never a quiet reporter | - | CLAUDE.md:14 | KEEP | project convention a model would not guess |
| C5 | Every error response is `{ error, retryable, detail }` | - | CLAUDE.md:15 | KEEP | contract fact the clients rely on |
| C6 | `received_at` sorts every list except the user poll (`last_activity_at`); `last_activity_at` is the only retention clock | - | CLAUDE.md:16-17 | KEEP | contract fact; both clients were told the order |
| C7 | Message content is rendered as text, never markup | - | CLAUDE.md:18 | DEL-O | a capable model escapes user content unprompted; Hono's `html` escapes by default. Clean-room test decides |
| C8 | Deployment values in gitignored `wrangler.*.jsonc` and secrets; only `.example` with `REPLACE_ME` committed | - | CLAUDE.md:19-20 | KEEP | project fact (file names, placeholder word) |
| C9 | Public repo: notes describe Ulak only; no hostnames, tokens, ids, other projects' names | - | CLAUDE.md:21-22 | KEEP | fact a model cannot see (that the repo is public) and the rule that follows |

## CLAUDE.md `## Decisions`

| ID | Rule (short) | Source | File:line | Mark | Why |
|---|---|---|---|---|---|
| D1 | No non-image attachments, no captcha, no end-user accounts, no AI provider inside Ulak | - | CLAUDE.md:25 | ASK | untagged; not enforced by a test that I know of (step 2 checks). Recommendation: find his words in `.session_prompts` and keep it tagged; it holds while nothing enforces it |
| D2 | Admin panel signs in with Google only; the three-way rule covers public sign-ins | owner S6 | CLAUDE.md:26 | KEEP | his ruling; an exception to the global sign-in standard (step 3 checks the quote) |
| D3 | Ulak carries apps' communication with outside people both ways; agent-to-mailbox mail is not Ulak's | owner S11 | CLAUDE.md:27-28 | KEEP | his ruling, scope of the product (step 3 checks the quote) |

## Memory (`memory/`)

| ID | Rule (short) | Source | File:line | Mark | Why |
|---|---|---|---|---|---|
| M1 | Open orders O1-O3, outside waits, to-dos | owner S5, S11-S23; operations S325 | todo.md | KEEP | his orders and the work list; the one to-do file (operations S303) |
| M2 | Live state: what is deployed and set, test copies, rollback bookmark | - | ulak-live-state.md | KEEP | fact |
| M3 | Test mail: `tmp/s20/test_mail.py`, one key per run; each further test mail needs his word | - | ulak-test-mail-method.md | KEEP | tool fact; "his word per mail" to be checked against his words in step 3 |
| M4 | Zoho verify call and delivered-event shapes | - | ulak-vendor-webhook-shapes.md | KEEP | fact read live |
| M5 | Privacy values: vendor name and region words (EN, TR) | operations S278 | ulak-privacy-vendor-values.md | KEEP | operations' words |
| M6 | Every privacy or legal change goes to operations first | - | ulak-privacy-vendor-values.md | MERGE | global CLAUDE.md: "All legal matters go to [operations] ... reviews every product's legal text in every locale, on every change" |
| M7 | "Used for nothing else" depends on his Claude "Help improve Claude" being OFF | - | ulak-privacy-vendor-values.md | KEEP | fact a model cannot know |
| M8 | Mail vendor renamed (ZeptoMail is Zoho CPaaS); docs path; credit terms; mail gate allows `cpaas.zoho.*` | - | ulak-mail-vendor-renamed.md | KEEP | fact |
| M9 | Parked: inbound mail to agents | owner S21 | ulak-parked-inbound-to-agents.md | KEEP | his words, parked |
| M10 | Per-user limits exact, per-IP and reads approximate; never reopen | owner S3 | ulak-rate-limits-settled.md | KEEP | his ruling |
| M11 | First client app: uses `/v1/notify`; never touch its code; tell it before contract changes | owner S4, S5 | first-client note | KEEP | client facts; "tell before change" is also in global "Another project's things" for removals, but contract changes are wider |
| M12 | Second client app: server-only; tell it before the list order changes | owner S8 | second-client note | KEEP | client facts and its own condition |
| M13 | Which `.secrets` subfolder holds which credential; never print one | - | ulak-credential-files.md | KEEP | fact |
| M14 | Live probe: throwaway app plus `wrangler tail`, leave nothing; creating anything live is his call | - | ulak-live-probe-method.md | KEEP | method a model would not find; the "his call" line to be checked in step 3 |
| M15 | Read `migrations apply --remote` and `migrations list` output before deploying | - | ulak-remote-migrations-verify.md | DEL-O | a capable model reads a command's output before acting on it |
| M16 | First cron run after a deploy may not fire | - | ulak-first-cron-unreliable.md | KEEP | observed platform fact |
| M17 | Test doubles hid four live bugs; seams audited (`docs/seam-audit.md`, `test/seams.test.ts`) | - | ulak-test-double-defects.md | KEEP | fact and file pointers |
| M18 | Write questions to him in everyday words, the explanation inside the question | owner S5 (his words quoted) | owner-plain-language-questions.md | ASK | global Communication now says this ("define a technical term in plain words", questions stand on their own). Recommendation: MERGE into the global line and delete the note |
| M19 | Never leave a file loose; a named subfolder | owner S2 (his words quoted) | cemil-file-organisation.md | KEEP | his words; not in the global CLAUDE.md (the hook covers folders outside the root, not subfolder naming) |
| M20 | `vi.mock` and the API Worker: `vi.resetModules()` and re-import | - | ulak-vi-mock-api-worker.md | KEEP | tool fact |
| M21 | D1 refuses over 100 binds live only; use `slices` | - | ulak-d1-param-limit.md | KEEP | platform fact the local runtime hides |
| M22 | Mixed LF/CRLF: keep each file's ending, check diff stat | - | ulak-line-endings.md | KEEP | fact, re-read today: `src/core/images.ts`, `test/images.test.ts` and every `docs/*.md` are CRLF, the rest LF |
| M23 | After a crashed mutation run, count each mutant's text in the tree | - | ulak-check-tree-after-crash.md | KEEP | lesson with evidence (S8) a model would not apply unprompted |
| M24 | Admin screenshots: local render plus headless Edge; one live look from him | - | ulak-admin-screenshots.md | KEEP | tool facts (Edge minimum width, where his pastes land) |

## Not rules

- `memory/session_ledger.md`, `memory/task_cost.md`: records kept by the shared wrap-up scripts; no rule in them.
- `skipped_issues.md`: two deferred items with triggers; reviewed in step 4's reconcile, not here.

## Totals

36 rows: KEEP 31, DEL-O 2 (C7, M15), MERGE 1 (M6), ASK 2 (D1, M18), DEL-X 0. Step 2 next: check M6's target is
loaded with the row, check D1 against tests, send operations the clean-room scenarios for C7 and M15; Operations S326 point 1
(a deletion-after-a-time promise counts as implemented only with a quiet-clock test) is applied there.
