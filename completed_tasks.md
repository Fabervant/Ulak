# Completed tasks

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
