# Completed tasks

## Session 16 — 2026-10-31

Phase 1 (legal documents) built ahead of deployment on the owner's word; phase 0 still waits on the account.

- **Mailbox:** empty (no letter since S260).
- **Phase 0 ship:** blocked, re-read at the source 10:04: FabervantOps' memory still lists the CPaaS DKIM and CNAME as
  "next with him"; public DNS has no CPaaS record (SPF includes only zohomail.eu). Not deployed.
- **Owner: "Build now, deploy later (Recommended)"** (asked because his order was phase 1 after phase 0 ships, and
  phase 0 waits on an outside account). Built from the plan: migration 0006 (`legal_documents`, `legal_alerts`,
  `mails_idem` scoped by kind), `src/core/mail/legal.ts`, the legal path in `src/api/mail.ts` (always `202 queued`,
  answer before the first attempt), stamps and alerts in outbox/webhook/job, `POST /v1/mail/legal/end`, keeping by
  `LEGAL_KEEP_DAYS` in the hourly job, every deletion path keeping copies without `user_ref`, admin `/legal` (alerts,
  close, search, download), the *sends legal documents* tick, health check fields. Commits `aec3608` (code),
  `5f74881` (docs: client contract, self-hosting, config example), `fcb3613`, `c24a7e1`, `ed1d326`.
- **Tests:** 487 pass (87 new in `test/legal.test.ts`, plus updated old tests for the new answers). Written after the
  code, so proven by 26 planted defects: 23 caught; 3 survive, each a guard another guard backs up (the repeat
  check before the unique index, the undelivered select guard, the delivered stamp's COALESCE).
- **Independent review** (fresh reviewer): 0 high, 3 medium, 8 low. Fixed: lost acceptance or alert after a stopped
  Worker repaired by the 5-minute job and filled by any vendor event (M1); `ended_at` before the newest copy refused
  (M2); `LEGAL_KEEP_DAYS` under 365 a bad setting (M3); `closed_by`, no self `replaced_by`, late receiving server
  filled, downloads logged by id (L1, L4, L5). Accepted: L3, L6, L7, L8 (reasons in the plan's last section).
- **Agent choices** (recorded in the plan's "Changes during the build"): each alert kind once per copy, so a replay
  never reopens a closed alert; no `undelivered` on a held copy; a bounce alerts whenever it matches a copy; the hash
  covers subject, blank line, text; the 365-day floor (a typo must not delete copies within the hour).
- **FabervantOps told** (`letters/FabervantOps/2026-10-31-ulak-s16-phase-1-built-not-deployed.md`): built not
  deployed, its two open answers stay settings, the 365-day floor, no privacy-statement change, phase 2 not near.

## Session 15 — 2026-10-30

Mailbox cleared, the last two apps' answers folded into the spec, phase 1 planned; phase 0 still waits on the account.

- **Mailbox.** Seven letters, all acted on and archived: Astrolect S86 and TradeComrade S769 (their late answers to the
  2026-10-24 question) folded into the spec (`ae6eaa7`: sections 0, 13, 14; launch lists are commercial and stay in the
  app; Ulak never alters a body; an app moves a flow only after its privacy text names the vendor) and answered;
  FabervantOps S256/S257 (the account opens under the owner's Zoho login) noted and answered; S259 (draw HOME INDEX)
  answered as not applicable (Ulak has no public screen; a search of src, test and docs found no Home Index text);
  S260 (account not opened, no CPaaS DNS record as of 14:00) and S260 (Home Index v1.4 lean checks, no reply asked;
  folded into the phase 1 admin page).
- **Owner, TradeComrade's Telegram alerts:** "Stays in the app (Recommended)": recorded as option O9 (off) in the spec,
  TradeComrade told.
- **Phase 0 ship:** blocked; asked FabervantOps (owner: "COO is live"), whose S260 answer is that the account, the
  validation form and the DNS are all not done yet.
- **Owner: "Plan phase 1 now (Recommended)".** Plan `docs/superpowers/plans/2026-10-30-phase-1-legal-documents.md`
  (`9481ac4`): the copy table written once and stamped by guarded statements, alerts as rows, idempotency keys scoped
  by kind, the keeping period and the retry window as settings the legal reads fill. Stress test: the owner chose
  "Daily reminder (Recommended)" for open alerts. An independent reviewer found 2 high, 7 medium, 8 low; all folded in
  (the plan's last section lists them). Legal reads 3, 6, 11 and the receipt check asked of FabervantOps
  (`letters/FabervantOps/2026-10-30-ulak-s15-phase-1-reads-3-6-11.md`). Not built: built after phase 0 ships.
- **Legal reads 3, 6, 11 and the receipt check answered** (FabervantOps S260, same day; letter archived) and folded
  into the phase 1 plan: copies kept 3 years from the subscription's end (the sale for a one-off), reported by a new
  `POST /v1/mail/legal/end`, a copy with no end never deleted; `text_sha256` and the receiving server kept as evidence;
  24-hour window and HTML refusal confirmed; the provider's receipt does not shrink phase 1. TTK art 82 (10 years) is on
  operations' lawyer list.
- **Intermittent mail test:** 15 full-suite runs, 15 passed (35 of 35 since S14's fixes); not reproduced. Full suite
  after the doc changes: 21 files, 399 tests passed.

## Session 14 — 2026-10-28

Phase 0 of the approved communication spec (O2) built, reviewed and committed; not deployed.

- **Mailbox.** Empty at start. During the session FabervantOps S256 sent legal read 4 (READY AFTER FIXES) and its gate
  change; acted on (fixes applied, `80fe7c4`), answered, archived.
- **Vendor documentation read** (vendor option 1): the product was renamed (ZeptoMail is now Zoho CPaaS, 2026-09-23;
  keys and agents unchanged; send API documented at `cpaas.zoho.com/v1.1/email`); no send-time code for a suppressed
  recipient; auto-suppression covers hard bounces only; webhooks signed with HMAC-SHA256 (`producer-signature`) over the
  decoded form parameter. Saved copies in the session scratchpad only.
- **Plan** `docs/superpowers/plans/2026-10-28-phase-0-sending.md` (`25dd66f`), stress-tested with /grill-me. Owner's
  two answers: suppression "Ulak remembers them (Recommended)" (a hard bounce or complaint marks the address hash; later
  mail answers `422 suppressed`; no lift button, O3 stays declined); "fails at start" = "Block deploy + red health
  (Recommended)". Both enforced in code and tests (`isSuppressed`, `scripts/check-mail-config.mjs`, `runChecks`).
- **Build** (`80e7e99`): migration `0005_mail.sql` (apps' send key and sending identity, `mails`, `mail_attempts`,
  `service_state`); `src/core/mail/` (config all-or-nothing, per-app keyed address hash, validation with the 422
  reasons, vendor client with tracking off and an 8-second timeout, outbox with lease, ceiling, idempotency, backoff,
  give-up, retention, webhook verification and events, 5-minute job); routes `POST /v1/mail`, `GET /v1/mail/status`,
  `POST /v1/mail/delete`, `POST /v1/mail/events`; second cron `*/5 * * * *`; admin Outbox page, send-key button and
  sending fields; `deploy:api` runs the half-set check first (proven red on a half-set list; the live read found none
  of the five settings set). Agent calls: `legal_document` refused with `422 kind_not_allowed` until phase 1; the From
  address derived from the app id, never stored; the per-app hash key derived from one secret, never stored; the vendor
  endpoint in configuration (its EU host unknown until the account exists); `down` = the last 3 vendor calls in 10
  minutes all failed on the vendor's side; styles allowed in `html`, anything that loads refused.
- **Independent review** (fresh agent) of `80e7e99`: 1 high (expired mails' address and text kept while the settings
  were missing), 4 medium (failed mails answered `queued`; stale-clock leases; bounce overwritten by a late `sent`;
  reported test flakiness), 7 low. All fixed with a test each (`80fe7c4`); new answers `500 mail_failed` and
  `410 mail_expired` (agent call: a mail Ulak will not send is never answered `202`). The flakiness (2 of 11 runs) did
  not recur in 20 runs after the fixes; its cause was not confirmed.
- **Proof:** 399 tests pass (`npm test`, verbose); typecheck and gitleaks clean; 17 planted defects in the first build
  and 9 in the review fixes each turned the mail tests red, tree restored each time.
- **Privacy template** (legal read 4): draft sent; FabervantOps's six fixes applied in `docs/privacy-statement.md`
  (10-year copies from the end of the purchase year, a legal ground per section, "a code made from your address with a
  secret key"). After the wrap-up its two sentences arrived (vendor log 60 days without text; transfer abroad) and
  went in word for word (`e2b3d13`), with "content storage off" added to the console steps; read 4 closed for section
  A and "Where". FabervantOps added the vendor's processors row.
- **Vendor account:** asked whether to open it under his own Zoho login, the owner answered "why don't we handle this
  with COO?"; his words were sent to FabervantOps, which takes the account up with him.
- **Letters:** to FabervantOps: phase 0 built, read 4 draft, four vendor facts (including that its mail gate missed the
  `cpaas.zoho.*` host; it added it, read back in `mail_vendor_gate.py`); then the fixes applied.

## Session 13 — 2026-10-28

Mailbox (1 letter); communication-service spec draft 3 (O2) out for the re-read.

- **Mailbox.** FabervantOps S256's second review of draft 2 (NOT YET: 2 high, 5 medium, 14 low; all
  15 draft-1 findings closed) acted on and archived.
- **Spec draft 3** (`cd15ec1`), every finding taken as written:
  - N1: section 0 and decision 1 say vendor options 1 and 2 change the owner's standing mail rule
    (current account, no second vendor) and are his decision; option 0 (send over the current
    account) added first, sized (phase 0 about 14 files / 1,400 lines), no new cost, losing delivery
    events and the vendor's bounce list. Option 1 still recommended for those reports (agent).
  - N2: optional `html` part on `transactional` mail, https links only, `422 bad_html`, never
    rendered, refused on `legal_document`; chosen over a "no HTML" decision because the owner's S253
    pick ("Fuller mail + dashboards") needs it (agent, FabervantOps's recommended fix).
  - N3 delivery gain "possible, unproven"; N4 `202 held` plus owner alert for an address-dependent
    refusal of a legal document, `422` kept for the app's own mistakes; N5 AI-assistant row gates
    phase 2; N6 withdrawal-word flagging moved to option O8 with its three conditions; N7 sale
    handler sized (200-350 lines per selling app), 36-hour dead-man ping, sale without acceptance
    listed as an alert.
  - Read in the payment provider's webhook documentation: answer within 5 seconds, re-delivery for
    about two days live. Draft 2's 8-second wait would have failed every legal call: a legal call is
    now answered once the copy is stored, the app waits at most 4 s; the 3-day reconciliation is the
    two-day window plus a day.
  - All 14 LOW items fixed (per-app keyed hash, `down` counts only vendor failures, double-send
    stated, "evidence" not "proof", forwarded `Received` time acceptance, product fingerprints
    generalised, Ulak's size 4,850 lines so +66%). Public-repo grep for project, vendor and person
    names: none.
- Letters: FabervantOps (re-read `cd15ec1`, source links, ask for the plain-text durable-medium read
  before the final version); GRIDIGMA (four app-side changes; asked for AGREED).
- After the first wrap-up, two more letters, both acted on and archived:
  - GRIDIGMA S565: draft 3 AGREED with one change: its sale event comes from a subscription service,
    not the payment provider, so 5.4's wait cap and look-back now come from each app's own sale-event
    sender (`62f5353`). Read in that service's webhook documentation: 60 s timeout, 5 retries over
    about 80 minutes. Told GRIDIGMA and FabervantOps.
  - FabervantOps S256 review of `cd15ec1`: N1-N7 closed; one medium (N-A: `held` could not be in the
    `202`, because a legal call is answered before the first attempt) and nine low items, all fixed
    as written (`fdcb269`): `held` is now a stored state; Ulak sets Reply-To; `html` carries no
    images; option 0 says a bounced legal document is never detected and Ulak never uses the owner's
    own login secret; only the legal call inside the sale handler; remedy path for a held document.
    Its durable-medium read accepts plain text on three conditions, now in 5.4, read 11 and decision 2
    (no longer conditional). Re-read asked at `fdcb269`, with option 0's daily limit and Apple relay
    question; GRIDIGMA told of three app-side lines.
- Two more letters, acted on and archived: GRIDIGMA S565 AGREED at `fdcb269` (it sets no Reply-To
  today and its mail HTML has no images); FabervantOps S256 read `62f5353` as consistent with one low,
  fixed as its first option: the reconciliation look-back is never less than two days (`ba2e91c`).
  Told FabervantOps; its re-read of `cd15ec1..ba2e91c` is what remains.
- FabervantOps S256: `fdcb269` AGREED, with its two option-0 reads, folded in (`e82a60e`): the
  current account has one outgoing quota of 50-500 mails an hour shared by every app and the
  company's own mail, no bursts, up to an hour's stop when exceeded; the Apple relay registration
  already covers the company domain. With GRIDIGMA's AGREED, the spec is marked the final version
  for the owner's approval (`ce045ca`). FabervantOps's last letter ("ba2e91c - AGREED, nothing
  open") archived; told it the final version is with the owner.
- **Owner's decisions on the final spec** (pop-ups, S13): decision 2 "Plain text in the mail
  (Recommended)", asked twice at his request with the reasons against HTML attachments; recorded in
  the spec (`d9e06aa`). Decision 1: he picked "Mail service, option 1 (Recommended)", then asked why
  it is recommended; answered (delivery and bounce reports as legal evidence, bounced legal documents
  caught, one shared hourly quota on the current account; better inbox placement unproven); he
  answered "yeah my pick of option 1 stands" (`51d6d90`). FabervantOps updated its mail-vendor gate
  for Ulak alone (hooks `554ef09`); the other apps keep their current path until they move to Ulak.
  Decisions 3-8, each his pick of the recommended choice: push stays in the apps; store reviews not
  now; forward the selling apps' mailboxes after a check; marketing mail off; sign-in backup kept
  until he says; no extras, phases 0-4 in order (`4f96476`).
- **The spec is APPROVED** ("Approve, start phase 0 (Recommended)", `9366f0c`). Letters:
  FabervantOps (decisions 3-8, the approval, what phase 0 needs from it), GRIDIGMA and TEGlyx (spec
  approved, current contract unchanged, they are written to before their mails move). FabervantOps's
  gate letter archived. Its "approval noted; phase-0 items" letter read and archived: the account
  opens under the owner's login (FabervantOps asks him), DNS and processors row follow the account.
- No code changed. Commits `cd15ec1`, `62f5353`, `fdcb269`, `ba2e91c`, `e82a60e`, `ce045ca`.

## Session 12 — 2026-10-28

Mailbox (11 letters), communication-service spec draft 2 (O2) out for the second review, the owner's
admin sign-in proven live.

- **Mailbox.** 10 letters at the start, 1 during; all 11 acted on and archived.
  - FabervantOps S248 (delete non-coding history): MEMORY.md session index, the empty Blockers and
    Open decisions sections, and the copied plain-language pointer deleted; 124 lines / 10,399 B to
    80 lines / 7,244 B, memory_lint OK; CLAUDE.md unchanged (25 lines, 1,462 B). Reported by letter.
    The same cut answers FabervantOps S253 (MEMORY.md under 120 lines).
  - FabervantOps S251 (next prompt last; no file outside the project folder): read, followed.
  - Answers from CashFlow, BooMoo, CoDoList, DuPari and TEGlyx folded into draft 2; TEGlyx (a client)
    answered by letter. Astrolect and TradeComrade have not read the 2026-10-24 letter yet.
- **Spec draft 2** (`ed24fbf`, amended `22664db`): GRIDIGMA's 12 points and FabervantOps's 15
  findings folded in. New section 0, the owner's one screen: base phases 0-4 about 33 files / 3,200
  lines in Ulak plus about 8 apps x 150-500 lines; smallest Türkiye-documents path about 15 files /
  1,300 lines; vendor option 1 about $5 a year, option 2 $5 a month (prices read 2026-10-28 on the
  vendors' pages; option 1's per-credit amount only from third-party listings). Sign-in mails go
  after the app's answer, so nothing reveals an account; `immediate`/`durable` merged into one model
  bounded by each mail's `expires_at`; art 9 table; attachment decision put once with the exact
  Decision wording; extras moved to options O1-O7. Sent to GRIDIGMA and FabervantOps.
  - GRIDIGMA S565: AGREED, three notes; the status check capped at 2 s with no answer as ok, and a
    daily reconciliation of sales against Ulak, folded in (`22664db`). FabervantOps told to review
    that commit.
- **Owner's admin sign-in after PKCE:** he asked for the address ("give me the address and I'll do
  it now"), signed in with his Google account; his screenshot shows the panel's message list. The
  live `/auth/login` was read first: it sends `code_challenge_method=S256` to Google.
- No code changed; 271 tests unchanged. Commits `ed24fbf`, `22664db`.

## Session 11 — 2026-10-24

Maintenance session: mailbox (17 letters), drift review, refactor round 3 and the feature review,
PKCE on the admin sign-in (deployed), the admin API `since` fix (deployed), and draft 1 of the
communication-service specification by the owner's new brief.

- **Mailbox.** 17 letters arrived (13 at the start, 4 during the session); 16 acted on and
  archived, the session-ledger letter closes with this wrap-up's commit.
  - Nothing for Ulak (checked with `git grep`): the Codex/Hermes ruling, ads measure-only, the
    native Google exception, Paddle in Türkiye, `tmp/` already ignored.
  - Home Index line (three letters): Ulak has no public screen; FabervantOps agreed, no feed.
  - Open orders: `## Owner's open orders` created in MEMORY.md, seeded from every recorded prompt
    and pop-up answer (the drift review's reading).
  - PKCE: built and deployed (below), commit sent to FabervantOps.
  - Türkiye documents (FabervantOps S248, GRIDIGMA S556) and "can Ulak send every app's mails":
    the smallest version was put to the owner; he stopped the question and gave a new brief (below).
- **Owner's brief** (his words): "you don't need to build the smallest version. That was the brief
  for GRIDIGMA, because it's not its core business - I mean communication. Yet, it is yours. You
  can build a capable software. My priority is that it will handle all the external communication
  of all our apps. The apps will build their bridges but you will handle the incoming and outgoing
  communication." Then: "We need to prepare a specification for the new features first. ...
  Please ask them to give you feedback so that you can prepare the specification. Then submit it
  to them for their initial review. For final version, come back to me for approval."
  - Feedback asked of GRIDIGMA and FabervantOps; both answered (GRIDIGMA twice: facts and an
    unbiased view). The seven other mail-sending apps were asked by letter for their extras.
  - FabervantOps relayed the owner's scope ruling: people outside the company only; agent messages
    and the company mailbox are not Ulak's.
  - A reader agent went through the first client's mail code (17 kinds of mail) and its 32
    never-shipped Türkiye patches for lessons (`tmp/comms-research.md`, not tracked).
  - Draft 1 written and sent to both for the initial review:
    `docs/specs/2026-10-24-communication-service.md` (`fef3b6c`). GRIDIGMA's review arrived at wrap-up
    and waits in the mailbox for draft 2.
- **Drift review** (maintenance session): no contradictions in sessions 1-10
  (`docs/drift-reviews/review-2026-10-24-up-to-10.md`). The rule-file audit was approved by the
  owner ("Apply all"): six MEMORY lines deleted (each owned by a test, a topic file, the code or the
  refactor hook), Open decisions trimmed. Ruling replay: 0 owner-credited values.
- **Refactor round 3, `src/admin/index.ts`, CLOSED** with 0 defects (13 breaks, 4 green, none
  harmful). Feature review of `0886129..b8ee5be`: 0 findings, 3 observations, all answered:
  O18 dialog question escaping pinned; O19 sub-millisecond `since` pinned (the signed-year case
  cannot pass `isIso`); O20 was a real bug - the admin JSON API compared `since` as raw text, so
  an offset or millisecond-less value skipped messages; fixed with the shared `storedIso`.
- **PKCE S256 on the admin Google sign-in** (`0e18799`), letter of FabervantOps S235: verifier in
  the state cookie, challenge to Google, verifier on the exchange, a callback without one refused.
  Red tests first; an independent review found 0 defects with 5 planted breaks all red.
  Deployed (owner's approval); live: S256 challenge sent, verifier absent from the URL, 400
  without a verifier, Google accepts the request. The owner's own sign-in was asked for as the
  last proof.
- 268 to 271 tests. Commits `0e18799`, `fef3b6c`.

## Session 10 — 2026-10-14

Mailbox (10 letters), refactor round 1 on `src/api/index.ts`, the Session 9 deploy with a live
probe, confirm dialogs on the five destructive admin actions (deployed), the credentials moved
inside the root.

- **Mailbox.** Ten letters, all acted on and archived; answered live to FabervantOps.
  - GA / 31 countries, statistics box, sign-in standard (document, section 11), standards rollout,
    footer layout: no surface. Ulak has no public UI, and the operator panel is Google-only by
    redirect. FabervantOps agreed: no footer, card or sign-in standard applies.
  - Legal name: `LICENSE` reads "Fabervant Teknoloji Anonim Şirketi". FabervantOps approved it,
    the owner approved the push. The dated 2026-09-05 plan was left as history. The live
    `CONTROLLER_NAME` setting also carried the short form; it was changed and read back from the
    deployed version. No code reads it today; it names the controller for the privacy template.
  - Forms inventory sent: every admin form is inline on a full page. Five destructive actions
    posted on one click.
  - Code ruling sweep: 0 owner-credited values (`docs/audits/2026-10-14-owner-ruling-sweep.md`).
  - No folder outside the root. Owner's choice: move everything. Ten credential files went from
    his Desktop store into `.secrets/` (git-ignored), with matching SHA-256. GRIDIGMA confirmed
    nothing of theirs reads the old path; the emptied Desktop folder is his and stays.
    `tmp/` is git-ignored for session scratch.
- **Refactor round 1, `src/api/index.ts`, CLOSED** (`05d15d9`). There was 1 defect, which
  mattered: the read's `no-store` header was unpinned. It is now pinned in the ETag test, red with
  the header removed. Spec section 5 states it, because a cached thread would survive sign-out.
  The verify pass found nothing.
- **Observations O11-O17.** O11, O13 and O16 were already pinned by `5e10a29`; mutation re-runs
  turned them red. O12 was a real gap: the page binding of the reveal cookie stayed green with
  the check removed. Fixed in `7461890`. O14 and O15 were already in `skipped_issues.md`. O17 is
  covered by the spec line.
- **Deploy of `a5e7969`..`7461890`** (owner approved). Live probe with throwaway app `probe-s10`:
  - three submits;
  - a read without `since`: oldest first, `no-store`, correct cursor;
  - a `since` written `+03:00` without milliseconds read the same three rows.
  The owner rotated its key in the panel and refreshed. The key hash changed once, and the old
  key now answers 401. The app and its rows were deleted and read back at zero; two real apps
  remain. GRIDIGMA was told live; TEGlyx by letter, for its one live read.
- **Confirm dialogs** (owner: all five; `60fe68c`, `112751b`, deployed). Delete user data,
  Rotate key, New notice key, Revoke and Sign out everywhere each open a dialog over the dimmed,
  blurred page, and only its own button posts. It is pure CSS `:target`, because the panel's CSP
  allows no script. Cancel targets `#_` so the page keeps its scroll. The header wraps at phone
  width. Screenshots were taken before the deploy, and the owner confirmed the live dialog
  matches. Independent review found 0 defects and 2 test gaps; both are closed (always-visible
  dialog, duplicate ids), each red under its mutation. Escape-to-close and history entries were
  left out, as they need script.
- 266 to 268 tests. Commits `4db1cd7`, `05d15d9`, `7461890`, `60fe68c`, `112751b`.

## Session 9 — 2026-10-11

Mailbox, refactor round 2 on the admin panel, refresh-safe key display, and the user message list
fix agreed with both clients. Nothing deployed.

- **Mailbox.** Six letters, all acted on and archived. The form-dialog, no-wordmark, sign-in-fix
  and analytics rulings have no surface in Ulak: the admin panel has no sign-in screen (it
  redirects straight to Google), no separate form pages, no wordmark, and no analytics. The
  operations project was told by live message. It confirmed the `ulak@` group has been the consent
  screen's support address since its own Session 209, so the support-address letter is archived
  on its record, without a fresh console read-back.
- **Refactor mandate, `src/admin/index.ts` round 2, CLOSED** (`a5e7969`). The reviewer ran 14
  breaks (10 stayed green) and listed 11 defects, 2 that mattered, both test gaps:
  - unticked app boxes saving as off;
  - the callback passing Google's `email_verified` claim on.
  Each test went red under its break. Tidy batch: delete-user scoping, fresh state and nonce, no-store
  on the admin API, the status allow-list moved into `setStatus`, one auth-failure log, one
  `page()` helper, shown-once types, a stale comment. D10 (reply pre-read) left open, equivalence
  unsettled. From its observations:
  - **Sign-out after "Sign out everywhere" elsewhere left the dead session cookie in the
    browser.** `requireAdmin` now expires every panel cookie whenever it refuses a presented
    session (`dropCookies`); the test is red on the base.
  - The callback checks the session secret before spending Google's code.
  - An unhandled error's text is pinned out of the response.
  - The context-parser merge was declined because the two shapes differ.
  The verify pass found D12 (csrf in every post form) and D13 (empty API reply), both now tested.
  The owner kept the two new error texts.
- **Refresh-safe key display** (`ecf14e4`, owner). Rotate key, New notice key, Create app and
  Create token now redirect. The secret rides in `ulak_reveal`, sealed with AES-GCM to that admin
  and page for 60 seconds. The page shows it once and expires it, and sign-out clears it.
- **User message list** (`0886129`, `5e10a29`). Both clients were told first and answered that
  neither change breaks them; both read without `since` and rely on ETag/304.
  - A read without `since` now returns the newest 200, oldest first.
  - A `since` page is widened to every row sharing its last activity time, because the cursor is
    that time and `since` is strict.
  - `since` is normalised with `toISOString()`, because an offset or a missing millisecond part
    skipped rows when compared as text.
  - The owner dropped the proposed `more` field.
  - Spec section 5 is updated.
- **Independent feature review**: 0 findings. Its test gaps are closed: a stale reveal cookie
  (red with the expiry check removed), cross-page reveal, and the 200 cap on a `since` page.
- `C:\tmp_apps_bak` was found already deleted.
- Tests: 259 to 266.

## Session 8 — 2026-10-06

Mailbox with a second client, refactor round on the admin panel, the text-free Telegram notice,
deploy and live probe. The PC crashed mid-session; the work was recovered and continued.

- **Mailbox.** Eight letters. Answered and archived: the refactor record, Law 5651 (Ulak owes no
  traffic record: no user's content reaches another user), the global rulings and sign-in standard
  (nothing applies: the admin panel is Google only), the first client's parent refunds (Ulak does not
  classify; the owner chose a `context` flag set by the client's form). The Telegram letter was acted
  on and archived. The support-address letter stays open until the operations project says who creates the
  group.
- **Second client.** The owner approved an app row for the second client: retention 90, images
  off, no origins, notices off. Created on the live instance, read back from the database before and
  after the crash, and its key answered 200 live. Its five contract questions were answered from the
  code; one exposed the 200-message list ordering defect (see MEMORY to do).
- **Refactor mandate, `src/admin/index.ts` round 1, CLOSED** (`d6b4bf6`). A fresh reviewer made 42
  mutations, 29 stayed green, and it listed 17 defects. All were fixed:
  - Every panel POST is tested for CSRF refusal.
  - The error handler no longer picks 400 or 500 by matching words in the error text; core throws
    `ApiError`.
  - One `timingSafeEqual` in `src/core/ids.ts` replaces three copies, and the status route uses
    `sha256Hex`.
  - The callback URL is built once.
  - A non-admin sign-in answers a logged 403.
  - The callback guards, the list filters, the origin parsing and the no-image-secret page are
    pinned.
  The first fix check found D18: five typed refusals unprotected at the panel. A table test now
  covers it, red on each. The PC crash killed the second fix check mid-mutation and left
  `src/core/apps.ts:49` mutated; it was found by checking the reviewer's mutation list against the
  tree and restored from its backup. A third fix check verified the round. Footprint 397 to 390.
- **Telegram notice** (`c45c973`). The owner approved the notice carrying only `[app] new message
  (platform)`, or `new crash report`, plus the admin link. Platform is a validated fixed list, so
  nothing a user wrote or a device reported reaches Telegram. The legal reviewer worded the privacy line,
  and the operator's name is the template's `{{CONTROLLER_NAME}}` placeholder because the file is a
  self-hostable template. Both clients were told it is live and may shorten their pages after
  the legal reviewer's Turkish review.
- **Two pre-existing test gaps** the third reviewer reported (`ae3fdf6`): a same-length tampered
  image signature, and a new app's typed retention value. Both went red under mutation.
- **Deploy.** The owner approved the push, deploy and probe. CI was green (259 tests, gitleaks
  clean). All three Workers were read back at 100%. A probe app's message was notified on the first
  attempt with no error. Its rows were deleted and the counts read back to zero, with only the two
  client apps remaining.
- **Uptime monitor.** The owner deleted the monitor on `/api/checks`. Two live-log windows (10 and
  26 minutes, against a 12-minute interval) showed only status-path calls, none on `/api/checks`.
- 250 to 259 tests.

## Session 7 — 2026-10-03

Mailbox, refactor round on the image module with the live defects it found, the privacy statement
through legal review, test impact analysis, deploy and live probe.

- **Mailbox.** No letter from the client. The operations project's rename letter: the one live reference (a
  private memory path) updated, history left. Its legal letter: the privacy-statement template sent
  for review with what changed since 2026-09-06; ruled NOT READY, then the diff approved.
- **Refactor mandate, `src/core/images.ts` review 1 of 3, CLOSED.** A fresh reviewer listed 15
  defects; all fixed, cleanliness gate OK, footprint fell. What the round found live:
  - Attaching images is atomic: the insert checks every attachment is claimable and the claim runs
    in the same D1 batch, so a submit losing a race for an image saves nothing. Before, the loser
    got 400 while its message was already saved without the image.
  - Ulak strips PNG and WebP metadata itself, as for JPEG. The local re-encoder kept PNG text,
    EXIF and time chunks, so the old comment "PNG and WebP output always drops EXIF" was false.
  - D1 refuses a statement binding more than 100 parameters (read in the D1 limits page); the local
    database does not. Expiry, unclaimed-image purge, reply lists and admin image counts bound one
    parameter per row, so the hourly job would fail once more than 100 messages were due and the
    admin list failed above 100. `src/core/sql.ts` slices; `withD1ParamLimit` in the test helpers
    enforces the limit so the tests go red.
  - One deletion path, `deleteImagesWhere`: objects before rows, so a failed object delete keeps its
    row for the next run; user deletion and expiry used to drop rows first and orphan objects.
  - `PassthroughCodec` removed: it stored bytes nobody re-encoded, against spec 7.3. Without the
    image service an upload answers the existing `403 images_disabled`, so the client contract is
    unchanged.
  - Every new test went red on the old code or under a mutation (pixel limit, both sides of the
    claim window, JPEG APP2/13/15, WebP flags, PNG chunk list). 232 to 244 tests. `6940f14`.
- **Privacy statement** (legal review 2026-10-03, approved): IP counted by Cloudflare for
  about a minute and not stored; Claude by Anthropic (US) named as the drafting assistant; storage
  region and controller country as placeholders (live: Western Europe, read from D1 and R2, and
  Türkiye); the notification's full content. `docs/self-hosting.md`: how to fill them, and apps
  must not put end-user data in operator notices. The owner turned Claude's "Help improve Claude"
  OFF today; the client matched all 11 earlier messages to its own or the owner's tests. `8f854ef`.
- **Test impact analysis** built to the 2026-09-29 plan: `npm run test:impact`. Selection by
  Vitest's Node API with an explicit changed-file list, the hygiene test always included because it
  scans every committed file through a generated manifest. Six tests on the decision rule. Evidence:
  the four test files that failed on the old code this session are all in the 11 of 19 selected for
  this session's src change; replay of the last 20 commits: 11 full, 9 selective, 0 changed test
  files missed (with today's import graph). The operations project told. 250 tests. `001f9e5`.
- **Live (owner: deploy and push; owner: probe).** CI green (19 files, MCP suite); API, admin and
  image Workers deployed and read back at 100%; the admin list with `limit=150` answered 200 with
  11 messages and 1 image. Probe app: three submits racing for one image gave 201, 400, 400 with one
  message saved carrying it; a PNG sent with a text chunk was stored as IHDR, PLTE, IDAT, IEND by
  the production re-encoder; the delete-user route answered 200; afterwards zero probe rows and the
  bucket back to its one object.

## Earlier months

- [2026-09](completed_tasks/2026-09.md)
