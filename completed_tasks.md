# Completed tasks

## Session 7 — 2026-10-03

Mailbox, refactor round on the image module with the live defects it found, the privacy statement
through legal review, test impact analysis, deploy and live probe.

- **Mailbox.** No letter from the client. FabervantOps' rename letter: the one live reference (a
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
- **Privacy statement** (FabervantOps review 2026-10-03, approved): IP counted by Cloudflare for
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
  files missed (with today's import graph). FabervantOps told. 250 tests. `001f9e5`.
- **Live (owner: deploy and push; owner: probe).** CI green (19 files, MCP suite); API, admin and
  image Workers deployed and read back at 100%; the admin list with `limit=150` answered 200 with
  11 messages and 1 image. Probe app: three submits racing for one image gave 201, 400, 400 with one
  message saved carrying it; a PNG sent with a text chunk was stored as IHDR, PLTE, IDAT, IEND by
  the production re-encoder; the delete-user route answered 200; afterwards zero probe rows and the
  bucket back to its one object.

## Earlier months

- [2026-09](completed_tasks/2026-09.md)
