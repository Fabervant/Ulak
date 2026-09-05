# Completed tasks

Newest first. Task numbers refer to `docs/superpowers/plans/2026-09-05-ulak.md`.

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
