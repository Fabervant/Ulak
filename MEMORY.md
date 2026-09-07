# Ulak memory

## Focus
Deployed and live. All 16 plan tasks are done and the eight-step verification passed against the
real instance. Next work is whatever a first real client application needs; nothing is outstanding
in the build itself.

## To do
- Confirm the Cloudflare billing profile was saved with the company name, Business account type
  and the tax number. The form was found and filled in during Session 2 but the save was never
  confirmed, so it must be checked rather than assumed.
- Decide whether the `demo` application stays. It was created to verify that the admin surface can
  create one, which it did. Its key is the only copy and lives outside the repository.

## Operational notes
- Rate limits: the per-user submit ceilings are counted in the database and are exact. The per-IP
  and read limits use the platform limiter, which is approximate and counted per location. Do not
  restate them as guarantees; the specification says which is which.
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

## Blockers
None.

## Open decisions
See To do.
