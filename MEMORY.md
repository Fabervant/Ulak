# Ulak memory

## Focus
Deployed and live. All 16 plan tasks are done and the eight-step verification passed against the
real instance. Next work is whatever a first real client application needs; nothing is outstanding
in the build itself.

## To do
- Audit every dependency-injection seam whose default only runs in production, and exercise that
  default under the real runtime. Two of Session 2's four defects were test doubles diverging from
  the real thing: an injected transport that hid a runtime rejection, and an image codec double
  that stripped metadata correctly while the real codec did not. The seams never checked this way
  are the image binding's dimension call, the signed-URL builder and the object-store access.
- Check whether the tax number reached the billing profile. The company name, Business account
  type and registered address are confirmed saved; the profile summary does not display the tax
  field, so that one part is unverified. It belongs on the same billing address form.

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
