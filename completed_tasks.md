# Completed tasks

## Session 28 — 2026-11-15

- **[K12] done:** rules review step 4 (`7229525`). Stale copies of C7, D1, D2, M6, M15, M18, M10-M12 searched in tracked
  files and `memory/`: none left; C7 and D1 subjects in `README.md`/`docs/spec.md` kept as product facts (test-enforced).
  Code-comment source tags re-labelled from the S14/S15 review pop-up records: `src/core/mail/outbox.ts:58`,
  `src/core/mail/legal.ts:379`. Index lint OK, 548 passed, before -> after figures in the inventory (36 -> 32 rows,
  CLAUDE.md 1,723 -> 1,670 B). Report letter to operations (`2026-11-15-ulak-s28-rules-review-step-4-report.md`)
  (re-labelled rows D2, M10, M11 S5 part, M12, M18; runbook grep misses `(owner, Session n)`; pop-up answers sit only
  in `review.md`; shared source-tag check proposed).
- **[K10] done:** `npm audit` 10 -> 0 (`9563462`): wrangler 4.162.0, vitest 4.1.12, `overrides` for sharp, undici, zod
  inside the copy @cloudflare/vitest-pool-workers pins (0.23.0 pins the same). Runtime deps unchanged. tsc clean, 548
  passed, three Workers bundle in a dry run.

- **Letters (archived):** operations S326 re step 4 (Ulak on the fixed 15,360 B limit; nothing owed). Operations S326
  asked whether Ulak carries other apps' operator alerts: answered yes, already live as `POST /v1/notify` (notice key,
  owner-notices box, 10 a day, `[app]` prefix); nothing built; the payments service's key and box join its deploy question.

- **CI red after the audit push, fixed (`eb0df66`):** CI's `npm ci` refused the lock file made on Windows (sharp's
  Linux helpers `@emnapi/runtime`, `@emnapi/core` missing). Lock re-resolved from scratch with hono and jose kept at
  their earlier versions; 548 passed locally, CI green (run 43753495362).

## Session 27 — 2026-11-15

- **[K11] done:** rules review step 3. Quotes checked against `.session_prompts` (S299 rule): found word for word D3
  (S11), M3 (S20), M9 (S21), M11's S4 part, M19 (S2); not in the record D2 (S6), M10 (S3), M12 (S8), M11's S5 part, M18
  (S5). Five pop-ups, all his picks of the recommended option (agent recommendations, approved S27): C7 deleted
  (`01e4d00`); D1 trimmed to "No end-user accounts" (`3c63e3a`); D2 Google-only admin panel kept and re-labelled
  (`5fb26d3`); memory: M15 note and M6 sentence deleted, M10-M12 re-labelled; M18 note deleted. Quote check and rulings
  table appended to the inventory (`50bb0b5`; memory/ is git-ignored, so that record is the memory rulings' commit).
- **[K9] done:** after Google sign-in the admin panel returns to the page asked for (`d380386`): a refused GET sends its
  path as `next`, it rides in the state cookie (base64url), the callback lands there; only a page of the panel is
  accepted (`//host`, `/\host`, a full URL or `/auth/*` land on Messages). Test red first ("/"), then green; 548 passed.
  Not deployed: goes with the next deploy on his word.
- **Letters (archived):** operations S326 (shared test picker `pick_tests.py`; quiet-clock tests asked with each legal
  text): nothing owed now; Ulak keeps `scripts/test-impact.mjs` until it next changes. The payments service's S6
  questions answered (`letters/Tezgahtar/2026-11-15-ulak-s27-answers-legal-documents-questions.md`): each selling app
  sends under its own Ulak app and send key (app, key and tick are the owner's, put to him with the deploy); no re-call
  of rows Ulak took (the row is written before the `202`, `src/api/mail.ts:61`), but a look-back against the payment
  provider's completed sales; one reference for a subscription's life; `legal/end` not live until the deploy.

## Session 26 — 2026-11-15

- **[K7] done:** rules review step 2 (`96b5523`): every row re-read against its file; D1 is the spec's text (agent
  recommendation, approved S13), enforced by `test/docs.test.ts:104` (captcha, AI provider, password) and
  `test/images.test.ts:53` (non-image 415), not for end-user accounts: re-marked DEL-X in part (trim to the accounts
  clause). M6's merge target (global legal line) loads every session; M18 stays ASK (his S5 words). Operations S326
  point 1: none found; retention and the TTK/TBK copies both have quiet-clock tests. M22's note corrected (only 14 files
  CRLF, read with `git ls-files --eol`). Scenarios for C7 and M15 lettered to operations
  (letter `2026-11-15-ulak-s26-rules-review-step-2-scenarios.md`).
- **Operations' S326 privacy final read (letter, archived):** its three rows applied word for word (`f2fc144`): legal
  basis for support messages (KVKK 5/2-c, f), a "Your rights" section (KVKK 11, 30 days), "a crash report you chose to
  send". Changed lines EN+TR sent (letter `2026-11-15-ulak-s26-privacy-page-three-rows-applied.md`).
- **Operations' answer (letter, archived):** privacy page READY in EN and TR; clean-room test C7 5/5 and M15 5/5, both
  deletable as obvious on his word in step 3; recorded in the inventory.
- **[K8] done:** Hono 4.13.7 -> 4.13.16 (`865ba31`); `npm audit` lists no Hono advisory; `npm test` 547 passed,
  typecheck clean. 10 dev-tooling advisories remain (vitest mocker, sharp, zod), on the to-do list.

## Session 25 — 2026-11-15

- **[K5] done ([O3], operations S325 point 2 and 3):** `d1cbbe1`: a legal copy is deleted only once both its sending
  year + `LEGAL_KEEP_YEARS` and its `keep_from` year + the same years have passed (Türkiye calendar); a one-off copy's
  `keep_from` is its acceptance, a subscription's is the reported end, so an unreported end keeps the copy. Once a year
  the operator's Telegram gets the per-app count of subscription copies past their TTK date with no end reported
  (`reportCopiesWithoutEnd`, claim-then-send shared with the daily reminder in `sendOncePer`). Named test (S291 pair, sent
  2026 / ended 2030 kept to the first moment of 2041, no-end copy kept in 2099) and the yearly-count test were red (3
  failed) before the code; `npm test` 546 passed. Contract, self-hosting doc and privacy section B (operations' wording)
  updated. Letters: both clients told of the end call before it ships; operations got the whole page EN+TR
  (`{{CONTACT}}` ops@fabervant.com, storage region WEUR read live, support sections in Turkish for the first time) and
  the correction that the mail vendor's "Save content" setting was read unticked in S20 (the S24 "never read" was wrong).
  Deploy waits on his word.
- **[K6] done:** rules review step 1 (`308257e`): `docs/rules-review/2026-11-15-rules-inventory.md`, before figures
  (CLAUDE.md 1,723 B; MEMORY.md 2,374 B / 22 lines; 24 memory files; no lessons, skills or hooks) and 36 rows: KEEP 31,
  DEL-O 2, MERGE 1, ASK 2. Other projects' names kept out (public repo). Lettered to operations.

## Session 24 — 2026-11-15

- **[K3] done:** phase 2 task 1, Ulak's side (`2707005`): `postal-mime` 4.2.0 (MIT-0, no dependencies, kept up) runs in the
  Workers runtime, 91 KB / 29 KB gzipped bundled; a throwaway test parsed two real raw mails from a public archive (From,
  Message-ID, text, a non-image attachment, `Received` chain, authentication results) and a Turkish encoded header. An
  HTML-only mail gets no text from it: task 4 converts. Findings under task 1 in the plan; no "no", so no owner question.
  Operations' forward test still open [W6]. Hono 4.13.7's six advisories checked: none reachable in Ulak; upgrade in todo.
- **[K4] done:** run-order tests per operations' S288 letter (`6f1f5f6`): `unstubGlobals`, `unstubEnvs`, `restoreMocks` in both
  vitest configs; `test/leakDetector.ts` (globals, console methods by descriptor, `process.env`, test bindings, fake timers,
  the mail and Telegram transports) wired in `test/setup.ts`, each check red with its line removed; `test/reverseOrderRunner.ts`
  (`ULAK_TEST_ORDER=reverse`, imports `TestRunner` from `vitest`: the `vitest/runners` import hangs the Workers pool);
  the per-test wipe list (`test/wipedTables.ts`) checked against the schema. Normal run named 0; reverse 0 failed; 545 passed
  both ways. Lettered to operations with the figures.
- **Mailbox (during wrap-up):** operations' S325 letter read and archived: received letters count from arrival (section C
  stands); a subscription's legal copy is kept to the later of TTK and TBK 146 dates (to build next, [O3]; the end call's
  retirement cancelled); privacy text ready after fixes; forward test waits on the owner's steps. Its forward points went
  into the plan under task 1; answered by letter.

## Session 23 — 2026-11-15

- **[K1] done:** phase 2 plan written (`docs/superpowers/plans/2026-11-15-phase-2-inbound.md`, `5cab936`), put to the owner; his answer
  S23: "Approve, build now (Recommended)" (agent recommendation, approved S23). Design: Ulak drops denied vendor senders on arrival
  (forwarded copies only, list in an admin-edited table, counts kept), receipt confirmation to every inbound mail, a reply visible in
  the person's thread only with a valid token, matching address hash, passing domain check and a `user_ref`; withdrawal clocks kept
  to the end of their arrival year + 10. Letter to operations `2026-11-15-ulak-s23-phase-2-plan-approved.md` (four task-1 questions).
- **[K2] done:** legal copies deleted at the end of their sending calendar year (UTC+3) + `LEGAL_KEEP_YEARS` (`1eaabc4`), per
  operations' S291 TTK art 82 ruling; `LEGAL_KEEP_DAYS` refused as bad until removed; the subscription's end no longer holds a copy
  and the 400-day warning went. Test with copies sent 31 Dec / 1 Jan red on the old rule, green after; `npm test` 530 passed.
  Lettered (`2026-11-15-ulak-s23-ttk-82-rule-built.md`); deploy waits on the owner's word.

## Session 22 — 2026-11-15

Mailbox session; the owner gave the word for the phase 2 plan.

- **Mailbox:** 19 letters from operations (S287-S316) read, acted on and archived; one letter back (filled privacy text EN + TR for review, TTK design and one
  question, mailbox-filter lean, measured volume: test mail only, under 10 a month, read live).
- **Kickoff items of S18-S22 written before tags, closed in their words:** Phase 0 shipping (O2), plan
  `docs/superpowers/plans/2026-10-28-phase-0-sending.md`: done S20, account open (EU), domain verified with DKIM and the bounce CNAME,
  the six mail settings set together, `MAIL_SENDER_INFO` the agreed value with postal code 34846, the bounce/complaint rate alert and
  migration 0007, main also holding phase 1 and migrations 0006-0007, so the phase 0 migrate and deploy carried them (agent, S17); the
  token and key were in, both clients answered, the agent inbox was read. Phase 0 acceptance: passed S20, read live (the test hard
  bounce, one real mail's raw source with its sender block, its delivered event). Phase 1 deployment, plan
  `docs/superpowers/plans/2026-10-30-phase-1-legal-documents.md`: done S21, `LEGAL_KEEP_DAYS=1096` set in `wrangler.api.jsonc`,
  `npm test` run, api deployed, the plan's live acceptance list run with each test mail on the owner's word via `tmp/s20/test_mail.py
  <address>` and the app's legal tick for the run taken back after; the receiving-server field read on the first delivered legal copy:
  the console's preview names none, operations told it stays empty, since a legal copy's evidence names that field; operations ruled
  it is not needed (S292). Phase 0 built (`80fe7c4`), phase 1 built and reviewed (`aec3608`..`ed1d326`), the deployed state read in
  Session 18 (API last deployed 2026-10-24, everything through `0e18799`): all since deployed. The second client's answer on point 1
  (the deletion answer's new field) came and was archived S21. Read the mailbox first and act on every letter, answer any client,
  every client told before anything it depends on changes: done S20-S22. TTK art 82 (3650 days instead of 1096), the seller of record,
  and the unpublished privacy section's 10 years against the live 1096 days: answered by operations S291 (10 years from the end of the
  sending year; build in todo), seller still open; the filled privacy text went to operations in English and Turkish S22; client apps
  stay off for mail until the account review passes: it passed 2026-11-10, operations holds the chase (owner: "Wait") closed by it.
  "If nothing above can move ..." items S20-S21: moot, work moved each session. The opening lines (live with two client applications,
  phases deployed, `LEGAL_KEEP_DAYS` unset, raw delivered event kept by migration 0008, details in `memory/MEMORY.md` under Live state)
  were state, not tasks; the state now lives in the memory notes.
  Also closed in their words: customer email sources read (S18); the owner's O2 order ("external communication", "bridges", "incoming and outgoing", "new features", "initial review", "please") is carried in memory/todo.md, phases 0-1 done; the second client's unarchived letter on what changes when deploying, the field ignored by it; agent-inbox and Bitwarden key submitted, sender contact exactly as agreed, the 100-a-day restriction lifted; migrations 0005-0007, credentials in .secrets, webhook set, phases live; the contract decision and something a client depends on; Apple relay passed, the suppression list read; independent verify of the webhook, each blocker named; the outbox.ts maintenance round and the project's published privacy text stay in todo.
- **Applied:** CLAUDE.md opens with the ownership sentence (S297); privacy template sections B and C carry the TTK art 82 wording (S291)
  (`9eb10c8`); `docs/work_ledger.md` and `memory/session_timer.md` deleted (S295, S298); memory converted (S303): MEMORY.md 107 lines /
  11,645 B to a 22-line index, `memory/todo.md` the one to-do file.
- **Owner:** "Write the plan now (Recommended)" for phase 2 (agent recommendation, approved S22).
- Carried in `memory/todo.md`: the TTK deletion-rule build, run-order tests (S288), rules review steps 1-5 (S298, S300).

## Session 21 — 2026-11-08

Phase 1 (legal documents) went live and passed its live list.

- **Mailbox:** eight letters read, acted on and archived: tax rule (nothing sold), wrap-up leftovers, the second client's answer on
  `not_found` (nothing to do), the skipped-issues review (2 entries checked at source: 0 delete, 2 still waiting, 0 ready; nothing for the
  owner to approve), a session-tool fix, `/design`, one item per session, and operations' answer (below). Three letters written to operations.
- **Phase 1 live:** `LEGAL_KEEP_DAYS=1096`, `npm test` 525/525, API deployed. Owner: "Yes, run A and B (Recommended)". Run A: a legal
  document to the owner's address answered 202 in 0.8 s, delivered; raw source plain text, DKIM/SPF/DMARC pass, link unchanged; the
  kept copy and sender block equal the received body, hash checks; the repeat answered the first id and sent nothing. Run B: a bounced row
  planted inside Ulak for a test address, the legal document held (nothing sent), one alert told on Telegram (the owner's screenshot,
  22:28); deletion by address `deleted_mails 2, kept_legal_copies 1`, the copy kept with its reference cleared. The owner downloaded the copy
  (body byte-equal to the received mail, ends with the sender block, hash checks) and closed the held alert by hand.
- **Receiving server:** the vendor's delivered event names none, and its help documents no fields for that event. Operations: the evidence is
  enough without it; keep the raw delivered event beside the copy. Built: migration 0008 `delivered_event`, kept once from the first delivered
  event; a payload of one event is kept byte for byte, a batch keeps only that copy's own event; the download shows it as one quoted line above
  the body. 527/527 tests; three planted defects each caught. Owner: "Yes, deploy (Recommended)"; migration applied and read back, API and admin
  deployed; a third test mail (owner: "Yes, send one (Recommended)") stored a 1015-character event, confirming no receiving server.
- **Privacy text mismatch** found and sent to operations: the unpublished legal section says 10 years from the end of the purchase year, the
  live setting is 1096 days from the sale or subscription end.
- **Old scratch:** owner: "Delete, keep the three (Recommended)"; 169 entries removed from `tmp/` after removing a junction to the real
  `node_modules` on its own (read intact after).
- **Other plans (S11):** owner: Ulak delivering incoming mail to agents was refused by operations for now; "Park the thought". Parked in MEMORY.
- **Work ledger:** `docs/work_ledger.md` started, one line per blocked item.

## Session 20 — 2026-11-05

Maintenance session. Nothing deployed: phase 0 still waits on the vendor's validation of its account and the three values
through the owner's inbox. The second client answered the deploy letter, so both clients are clear.

- **Mailbox:** four letters read, acted on and archived. The second client's answer: it never reads the deletion answer's
  body, no deploy of its own needed. The operations project's console findings answered from the vendor's help pages: where
  the auto-suppression switch and the content box are, and that the webhook Authentication Key is typed by us on the agent,
  so it comes before the deploy and the webhook itself after it. The owner's ruling on the footer and review line is recorded.
- **Local test standard:** `maxWorkers: 12`, the fastest measured count (32 workers 41.1 s; 12 workers about 28.9 s). The
  pre-push hook now runs the tests a change can affect, red on a planted failure. Six shuffled seeds and a clock moved 500 days
  ahead, proven by a planted date test: no order or date dependence. The 5 s limit tripped two bulk tests under load, so it is
  30 s; tests that measured elapsed time were removed or pinned to a start time.
- **Drift review (`docs/drift-reviews/review-2026-11-05-up-to-19.md`):** one contradiction: the public notes named other
  projects. Owner: "Keep the rule (Recommended)". Names removed from the notes, an automatic check added holding them only as
  hashes; Git history left as it is. Note cleanup, owner: "Remove all shown (Recommended)".
- **Rules as tests:** six new source scans, each red on a planted violation. New and red on the real code: an unknown route on
  the API and image Workers, and the image Worker's refusals, answered plain text; both now answer the error shape
  (`test/errorshape.test.ts`). The sort-key rule corrected to match the spec; owner: "Yes, keep the fix (Recommended)".
- **Refactor round 1, the legal-documents module:** closed. Two missing tests added (a later delivered event keeps the first
  delivered time; old held copies never crowd out a new alert), both red on their breaks; 13 unused exports dropped.
- **Feature review:** one finding, a missing test: a late delivered event never lifts a bounce or complaint suppression. Fixed, red
  on its break.
- **Webhook address check:** the console's Verify needs a 200, and its help does not say how it asks. A GET and an empty unsigned
  POST now get one and change nothing; any other unsigned request is still refused. The real request is to be read at Verify.
- **Deployed, owner: "yeah, deploy":** the API, admin and image Workers, migrations 0005-0007 and the six mail settings. Read back: empty POST to
  the events route 200, unsigned body 401, unknown routes in the error shape, a client poll 200, the result check ok. Legal documents stay refused and
  client apps have no mail. Live acceptance not yet run: it needs the webhook. The first client answered: it reads a refusal's `error` and
  `retryable` on its send and upload paths, which the new shape fits, and nothing changes on its side.
- **Verify, read from the live log:** the console's check is an unsigned JSON POST, not an empty one, and the route refused it. Now an unsigned POST
  that is not form-encoded gets a 200 and nothing in it is applied; an unsigned form-encoded one or a bad signature is still 401. Test red first, deployed.
- **Live acceptance, part 1:** webhook added, key set, the console's test hard bounce arrived signed and answered 200. One real mail through the second client's
  app (owner: "yes, you may"), its send key given for the run and taken back: answered 202, received; raw source: DKIM pass with `d=` the company domain, SPF
  pass, DMARC pass, From and Reply-To right, no image, link unchanged, sender block in both parts. Its delivered event set the mail to delivered. Status `ok`.
  A legal document answered `422 kind_not_allowed`. A second mail to a real hidden Apple address: the vendor's delivered event arrived and the relay forwarded it to the
  company mailbox, with the bounce domain `bounce-zem` under the company domain. A third mail to an address on the vendor's list: its send call accepted it, and a hard bounce
  event followed with `email-suppression 5.1.8`, so Ulak marked it bounced. Phase 0's live list is passed; the three test rows are deleted.
- **Result:** `npm test` 521 of 521, typecheck clean, gitleaks clean.
- **Two later letters from the operations project, read at 23:06:** no validation answer found; the console steps are on the
  owner's list in the order Ulak gave. A new reading of a company standard on speed and crash reports: nothing to build, since a
  search of `src/`, `package.json` and the privacy statement found no such reports.
- **The owner's question on the vendor's mail of 2026-10-31:** the record that nothing can be sent before the account review
  was wrong. The mail gives a free credit and a daily limit until then, so the review holds volume and buying credits, not the
  deploy or the live checks. Recommended to the owner: deploy inside the limit with client apps off for mail; not deployed, his word
  awaited. Ulak made the webhook key (kept in `.secrets\`, never printed) and gave him the console steps one by one.
- **What the console itself showed (the owner's screenshots):** the bounce list and content box are set. The Add webhook box's preview sends
  `event_name` as a list, which the parser dropped; now read, test red first. The Delivered and Hard bounces previews show `event_data`'s
  object also names the event, which the parser already read, so these previews would have parsed before the fix. The box says POST
  only, so the GET answer added earlier is removed. The empty Webhooks tab has no Authentication Key button, so the key goes on the agent
  after the webhook is added, and `docs/self-hosting.md` says so. The preview's delivered event is pinned by a test; it names no
  receiving server, so that field of a legal copy's evidence may stay empty until a real event shows otherwise.

## Earlier months

- [2026-10](completed_tasks/2026-10.md)
- [2026-09](completed_tasks/2026-09.md)
