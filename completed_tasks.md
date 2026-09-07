# Completed tasks

## Session 2 — 2026-09-07

Deployed the operator's instance (Task 16) and ran the eight-step live verification. All eight
pass. Three defects were found by deploying, none of which the 165-test suite could catch: each
lived in the gap between a test double and the real platform. Every fix carries a test that was
demonstrated red against the unfixed code before being accepted.

Deployment, on the operator's existing Cloudflare account:

- D1 database and R2 bucket created, both in the western Europe region so image reads and database
  reads sit together. Migration applied and the schema read back from the live database.
- Three Workers deployed on three subdomains of the company domain, one level below the apex.
  Two-level names were tried first and abandoned: the free certificate covers the apex and one
  level only, and Workers custom domains do not issue a certificate to fill the gap. Proven by
  handshake, including against a hostname that does not exist.
- Secrets set through Wrangler only, read back from each Worker to confirm. No secret was written
  to the repository or shown in the session.
- The billing profile form was located and its fields identified: organisation name, a Business
  account type and a tax number all live on the billing address form, not on the checkout page.
  Whether the operator saved it was not confirmed in this session, so it is not claimed here.

Defects found and fixed:

- Telegram notifications all failed with "Illegal invocation". The global fetch was held as an
  object property and called as a method, which the Workers runtime rejects. Every test injected
  a mock through the same seam, so the default value was never once executed. Bound to the global
  scope; the regression test calls the default transport detached from its object, the one
  condition that reproduces it.
- The rate-limit bindings were declared in the retired beta form. Wrangler accepted them silently
  as opaque metadata and the platform returned a limiter whose counter reset on every request, so
  no burst limit existed in production. Moved to the supported top-level form, in the committed
  example too.
- Even correctly configured, the platform limiter is approximate and per location, and cannot hold
  a limit as small as three. The per-user submit ceilings now count rows in the database on the
  write path, which is exact; the platform limiter stays as a free first pass. The specification
  and the client contract were corrected to say which limits are guarantees and which are damping.
- Images kept their metadata. The re-encoder preserves the EXIF copyright tag on JPEG by default,
  and in practice returned GPS coordinates untouched: a downloaded image still carried the
  latitude of the source fixture. The test-only codec stripped metadata correctly, so the double
  was more correct than the production path it stood in for. A shared stripper now removes every
  APP1-APP15 segment and comments, applied to the production codec's output, and the guarantee
  belongs to Ulak rather than to a re-encoder's defaults.

Verification, all against the live instance, asserting on results:

1. Sign-in pins the administrator row on the permanent account id, with the address recorded only
   as the address at pinning.
2. An application created through the admin surface works: its key submits, images are refused
   because that application has them off, and another application's key is rejected as a mismatch.
3. A Turkish message returns 201, stores byte-identical, and the notification arrives with every
   Turkish character intact.
4. Polling returns the message; a reply posted by the operator comes back on the next poll; the
   retention clock moves with the activity; a repeated poll answers 304 and the tag changes when
   the content does.
5. The administrator token authenticates the result check, which answered 503 on a real breach and
   200 once it cleared.
6. A photograph carrying GPS coordinates was uploaded, attached, downloaded from the image origin
   and parsed: no GPS, no camera tags, nothing.
7. The fourth message inside a minute is refused with 429 and a retry hint; the first three are not.
8. An external monitor polls a health route and alerted the operator on a planted breach, then
   cleared on recovery.

Added this session:

- Storage totals in the result check, so growth is visible before a bill is.
- An unauthenticated health route guarded by a long secret in the path, returning only a pass or
  fail status code and no data. It exists because the chosen monitor's free plan cannot send an
  authorization header, and a monitor asserting on a real result matters more than the shape of
  the credential. It stays absent unless the secret is configured.

The scheduled job was watched across two firings. The first window after deployment did not run;
the next ran on time and retried the notification it was given. The handler itself was proven
separately against the live database.

The scratch application used during verification, and everything it held, was deleted afterwards.

## Session 1 — 2026-09-05/06

Built Ulak from the specification to a deployable state and pushed it to the public repository.
Tasks 1 to 15 of `docs/superpowers/plans/2026-09-05-ulak.md` are done; Task 16 (deploying the
operator's instance) waits on operator-side credentials and approval.

Decisions this session, with the reason where it is not obvious:

- Hosting on Cloudflare Workers with D1 and R2. One free account covers compute, the SQLite-style
  store, image storage, the scheduled job and edge rate limiting; it never sleeps and needs no card.
  Cost accepted: TypeScript on the Workers runtime, so a stranger self-hosts on Cloudflare rather
  than in a container.
- Three hostnames on the operator's own domain, so the URL apps embed never changes.
- Admin sign-in with Google OpenID Connect bound to the permanent account id, pinned on first
  login. A renamed account cannot lock the admin out.
- Admin surface in English only. Status labels for users are localised from locale files.
- Status list: pending, viewed, in_progress, completed, rejected; pending on receipt; configurable.
  The user's app may show the status. A status change alone notifies nobody; the app sees it on its
  next poll.
- A dedicated Telegram bot for Ulak, so its token and notification settings belong to Ulak alone.
- Assistant access through a token-protected admin API and an MCP server in the repo. Drafting
  happens in the assistant with the app's code in view; Ulak calls no AI provider, so the public
  project stays vendor-neutral.
- No hosted web form. No versioned phases: everything decided is in this build.
- An idempotent replay is answered before the rate limiters run. The plan had the order reversed,
  which would have given a client that missed a 201 a 429 on retry.
- CI runs the gitleaks binary rather than the GitHub Action, which needs a paid licence for
  organisations.

Task record, newest first:

- 2026-09-06: Task 15, documentation: README for a stranger, client contract, self-hosting runbook, privacy statement template, repository-hygiene test over every committed file.
- 2026-09-06: Task 14, MCP server package over the admin API with five tools, its own test config, CI step.
- 2026-09-06: Tasks 12 and 13, admin surface (Google sign-in, list, detail, reply, status, delete user, apps, tokens; strict CSP, CSRF, no JavaScript) and the token-protected admin API with the result check.
- 2026-09-05: Task 11, Google OpenID Connect sign-in, signed sessions, admins pinned by permanent id.
- 2026-09-05: Task 10, images: byte sniffing, re-encoding, EXIF stripped and tested, claim window, purge, signed image origin.
- 2026-09-05: Task 9, admin tokens, hourly retention and notification retry, result check proven red on a planted row.
- 2026-09-05: Task 8, replies, localised status labels, polling read endpoint with cursor and ETag, per-user deletion.
- 2026-09-05: Tasks 6 and 7, message store, idempotent submit endpoint with body cap and CORS, persist-then-notify with the Telegram adapter and the attempt recorded on the row.
- 2026-09-05: Tasks 4 and 5, app tenancy with hashed keys, app-key middleware, rate limiter abstraction, client IP resolution.
- 2026-09-05: Tasks 2 and 3, schema migration, id and error helpers, submit payload validation.
- 2026-09-05: Task 1, repository bootstrap: license, tooling, secret scanning hook, CI, test harness on the Workers plugin, first push.

## Deviations from the plan worth knowing

- The Workers test integration is now a Vite plugin (`cloudflareTest`) rather than a pool option, and storage is shared between the tests of one file, so `test/setup.ts` wipes every table and the bucket before each test.
- An idempotent replay is answered before the rate limiters run, so a client that missed a `201` and retries gets `200`, never `429`.
- SQL cutoffs use `strftime` in ISO format because `datetime()` output does not sort against the stored ISO strings on the same day.
- Image fixtures are embedded in `test/fixtures.ts` because the Vite version in use has no `?base64` import.
