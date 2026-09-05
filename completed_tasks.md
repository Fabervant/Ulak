# Completed tasks

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
