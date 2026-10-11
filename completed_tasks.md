# Completed tasks

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
