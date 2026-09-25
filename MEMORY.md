# Ulak memory

## Focus
Live with one client application. Session 5 added owner notices (`POST /v1/notify`, spec section
14) and renewing, revocable admin sessions; both are deployed. Refactor mandate: `test/seams.test.ts`
round 1 of 3 closed; `src/core/images.ts` opens next.

## To do
- Independent review (`/code-review`) of the Session 5 code the refactor reviewer did not see:
  owner notices (`src/core/notices.ts`, the `/v1/notify` route) and the session change
  (`src/core/auth/session.ts`, `src/admin/auth.ts`, `/auth/logout-all`).
- Live read-back that needs the operator's browser: one Google sign-in to the admin panel after the
  Session 5 deploy (the old session format is refused, so the operator signs in once), a page an
  hour later showing the session re-issued, and the first real owner notice once the operator
  enables notices for the client. Blocker: the operator's sign-in and switch.

## Consumers
- The first client application exists on the live instance (Session 4); its identity, origins and
  key location are in the operator's private notes, not here, because this repository is public.
  Before removing or changing anything in the client contract, tell that client and wait.
- Session 5: that client was given the `/v1/notify` contract and may use it; changing or removing
  the route now needs its answer too. Notices stay off for it until the operator enables them.

## Operational notes
- Rate limits: the per-user submit ceilings are counted in the database and are exact. The per-IP
  and read limits stay on the platform limiter, approximate and counted per location, by the
  owner's ruling in Session 3 — exact per-IP would mean storing IP counters the privacy statement
  says are not stored, and exact reads would make every poll a database write. Do not restate the
  two as guarantees; the specification says which is which. Settled, not pending.
- The image service reports a file it cannot decode with a different number in every
  implementation: the live service 9516, the local one 9523, the type definitions document 9412.
  Never switch on the code to decide a file is bad. The rule is the shape of the error, and it is
  in `src/core/images.ts`.
- A corrupt upload must never answer a retryable 500: a client honouring the flag resends a file
  that can never succeed. Coded error means the file, so 415 and not retryable; no code means the
  service, so 503 and retryable. The one exception (Session 4): five codes the service documents
  as its own limit, timeout or setup are a retryable 503. The list may only move codes to 503.
- Image metadata is stripped by Ulak, not by the re-encoder. The re-encoder keeps the EXIF
  copyright tag on JPEG by default and was observed returning GPS coordinates intact.
- The scheduled job did not run in its first window after deployment and ran on time thereafter.
  Expect the first firing after any fresh deployment to be unreliable rather than to indicate a
  fault.
- A health route guarded by a secret in the path exists for the uptime monitor, whose free plan
  cannot send an authorization header. It reports only pass or fail. Unset the secret and the
  route disappears.
- Three defects reached production despite a green suite, all in the gap between a test double and
  the real platform: an injected transport, an accepted-but-inert configuration form, and a codec
  double that was more correct than the real codec. When a seam exists for testing, something has
  to exercise the default that runs in production.
- The test config's main module is the API Worker, loaded before a test file's `vi.mock` exists.
  A test that mocks something the API Worker imports must `vi.resetModules()` and import the
  Worker afresh (see `test/notice.test.ts`), or the real module runs.
- A remote `wrangler d1 migrations apply` can finish without applying anything. Read its full
  output and `migrations list` before deploying code that needs the new schema.

## Session index
- [S1, 2026-09-05/06, ~3.7h] Spec, plan, full build, docs, CI.
- [S2, 2026-09-07] Deployment, eight-step live verification, four defects fixed, storage totals and
  the health route added.
- [S3, 2026-09-08, ~0.5h] Injection-seam audit: `test/seams.test.ts` and `docs/seam-audit.md`, 174
  to 190 tests. Found a corrupt upload answering a retryable 500; a live probe gave the real codec
  error number and overturned the first fix. VKN confirmed, rate limits ruled settled.
- [S4, 2026-09-19, ~1.7h] Sign-out audit (3 stores fixed), deploy, independent review (5 findings
  fixed, parallel-submit limit the worst), account renamed, first client created. `5d0314c`,
  `3770c97`.
- [S5, 2026-09-25, ~4.0h] Refactor round 1 on the seam tests (14 fixed); owner notices endpoint;
  admin sessions renewed in use and revocable everywhere; live no-store read back; Google Cloud
  project moved and billing unlinked. 200 to 216 tests. `c03ae3f`, `d6e1bfd`.

## Blockers
None.

## Open decisions
None. The rate-limit scope question was settled in Session 3.
