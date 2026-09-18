# Ulak memory

## Focus
Deployed and live, independently reviewed (Session 4), and the first client application is
created. Next work is whatever that client's integration asks of the contract.

## To do
None.

## Consumers
- The first client application exists on the live instance (Session 4); its identity, origins and
  key location are in the operator's private notes, not here, because this repository is public.
  Before removing or changing anything in the client contract, tell that client and wait.

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

## Blockers
None.

## Open decisions
None. The rate-limit scope question was settled in Session 3; the two To do items are actions,
not decisions.
