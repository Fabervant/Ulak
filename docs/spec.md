# Ulak specification

Ulak (Turkish for *courier*) is a small, self-hostable support-message service. A user of any of
your apps taps "contact support", writes a message (or the app sends a crash report on the user's
behalf), and sends it. Ulak saves the message durably first, then pings you on Telegram. You read,
classify and reply from one admin surface that shows every app, and the reply travels back to the
user inside the app that sent the message. An assistant such as Claude Code can read the messages
through a token-protected admin API and draft replies with the app's code in view.

Ulak is one shared service, not a bot per app. Its defining property is a single place that can
answer "has anyone written to me today" across every app you run.

Ulak is not a ticketing product. It never has: a customer-facing inbox on its own web surface,
ticket assignment, SLAs, analytics, end-user accounts, non-image attachments, a captcha, or a
per-app bot. It stores no personal data beyond what the sending app already holds, with one
exception the user volunteers (`contact_email`).

Ulak runs on Cloudflare Workers with D1 (SQLite) for the store and R2 for images. A self-hoster
deploys it to their own free Cloudflare account. Everything deployment-specific is configuration.

## 1. Tenancy and configuration

- `app` is the tenant key. Rate limits, keys, retention, image enablement, allowed origins and the
  admin grouping all hang off it.
- Apps are rows in the `apps` table, created with the `add-app` script or from the admin surface.
  Each app has: an id (lowercase, `[a-z0-9_-]{2,32}`), a hashed API key, `retention_days`
  (default 90), `images_enabled` (default false), `allowed_origins` (list, may be empty).
- The per-app key is friction and tenancy, **not authentication**. It ships inside public clients
  and must be treated as public. Its job is to identify the tenant. A server-to-server integration
  that keeps the key on the server is the stronger form; the browser-direct POST is the weaker
  fallback.
- Deployment values (database ids, hostnames, the Telegram token and chat id, the Google OAuth
  client, secrets) live in gitignored Wrangler config and Wrangler secrets. Committed `.example`
  files carry placeholders.
- The data controller name is a configuration value (`CONTROLLER_NAME`), shown in the privacy
  statement.

## 2. Three origins

The public API, the admin surface and the image server are three separate Workers on three
separate origins. A self-hoster may use three `workers.dev` subdomains or three custom hostnames.
Browsers therefore never share cookies or execution context between the public endpoint, the admin
surface and any served image.

## 3. Submit contract

```
POST /v1/messages
Authorization: Bearer <app key>
Content-Type: application/json
```

Shape: a named core plus one bounded free-form map. Unknown top-level fields are ignored, never
rejected. Fields are only ever added, never repurposed or removed.

| Field | Rule |
|---|---|
| `app` | required; must equal the app the key belongs to |
| `app_version` | required; string, max 64 chars. A build number distinct from the marketing version goes in `context` or the additive `app_build` field (string, max 64) |
| `platform` | required; one of `web`, `android`, `ios`, `windows`, `macos`, `linux` |
| `user_ref` | nullable; opaque string, 16 to 128 chars. See section 4 |
| `message` | string, max 8000 chars; may be empty only when `last_error` is non-empty |
| `client_ts` | optional ISO 8601 timestamp from the client clock; stored as reported, never used for ordering |
| `client_msg_id` | required; UUID version 4, minted by the client before its first attempt |
| `locale` | optional BCP 47 tag, max 16 chars; taken from the client, never inferred server-side |
| `last_error` | optional string, max 4096 chars, truncated client-side |
| `contact_email` | optional, nullable; max 254 chars, must contain one `@` |
| `context` | optional JSON object, max 8 KB serialised; stored opaquely, never indexed or queried, documented as non-PII |
| `attachments` | optional list of at most 3 image ids from the upload endpoint (section 7); only accepted when the app has images enabled |

Server-written fields: `id`, `received_at` (server clock, the sort key everywhere),
`last_activity_at`, `status`, `notified_at`, `notify_error`, `notify_attempts`.

**Idempotency.** Submit is idempotent on `(app, user_ref, client_msg_id)`, falling back to
`(app, client_msg_id)` when `user_ref` is null. A repeat whose body hash matches the original
returns `200` with the original id and creates nothing. A repeat with a different body returns
`409 idempotency_conflict`.

**Size cap.** The whole request body is capped at 16384 bytes, checked from `Content-Length` and
again while reading, before JSON parsing. Over the cap: `413 payload_too_large`.

**Responses.** Every response is JSON. Every error body has the shape
`{"error": "<code>", "retryable": <bool>, "detail": "<human text>"}` plus code-specific fields.

| Status | Code | Retryable |
|---|---|---|
| 201 | created: `{"id", "received_at"}` | n/a |
| 200 | idempotent repeat: `{"id", "received_at"}` | n/a |
| 400 | `invalid_request` (adds `field`) | no |
| 401 | `invalid_app_key` | no |
| 403 | `app_mismatch`, `images_disabled` | no |
| 409 | `idempotency_conflict` | no |
| 413 | `payload_too_large` (adds `max_bytes`) | no |
| 415 | `unsupported_media_type` | no |
| 429 | `rate_limited` with `Retry-After` header | yes, after `Retry-After` |
| 5xx | `internal` | yes |

**Encoding.** UTF-8 end to end. Turkish characters (ı, ş, ğ, İ) must survive storage, the
Telegram ping and the admin surface unchanged; this is tested.

## 4. Identity: `user_ref`

An opaque, stable, high-entropy string the sending app can resolve and Ulak cannot. Ulak stores it,
matches on it, and never parses it. It must never be a raw account id, email, phone number or
nickname; apps send an HMAC of their account id under a per-app secret, a server-issued random
token, or a per-install UUID. Minimum 16 characters and at least 96 bits of entropy, because
`user_ref` is the only thing protecting a user's thread on the read endpoint.

Ulak builds no dedupe, no "returning user" logic and no cross-session history on it. It tolerates
an app changing id shape over time. It is the reply key, the rate-limit key and the deletion key.

## 5. Read endpoint: replies by polling

```
GET /v1/messages?user_ref=<ref>&since=<cursor>
Authorization: Bearer <app key>
If-None-Match: <etag>
```

Returns that user's messages for that app whose `last_activity_at` is later than `since`, oldest
first, each with `id`, `received_at`, `last_activity_at`, `status`, `status_label` (the status name
in the message's locale, English fallback), `message`, and `replies` (each `id`, `sender_role`,
`content`, `created_at`). Never returns `contact_email`, `context`, `last_error` or attachments.

- `since` is an ISO 8601 timestamp; omit it for everything. The response carries `cursor`, the
  largest `last_activity_at` returned, or the request's `since` when nothing changed.
- `ETag` is derived from the result. A matching `If-None-Match` returns `304`.
- An unknown `user_ref` returns an empty list with `200`, never an error.
- Minimum poll interval is 60 seconds per `user_ref`. Faster polling gets `429` with
  `Retry-After`, never a silent empty list.
- Read has its own rate budget, separate from submit. The per-IP backstop on read is off by
  default because carrier NAT makes many users share one address.

```
DELETE /v1/messages?user_ref=<ref>
Authorization: Bearer <app key>
```

Hard-deletes every message, reply and image for that `user_ref` in that app. Returns
`{"deleted_messages": n}`. Apps call this from their own account-deletion path.

## 6. Status, replies and the admin surface

Every message has a status from a configurable list. The default list, with `pending` set on
receipt: `pending`, `viewed`, `in_progress`, `completed`, `rejected`. The list is configuration
(`STATUS_LIST`), not a schema enum. The user's app may show the status. A status change alone
notifies nobody; the app sees it on its next poll.

A reply is a row the admin writes; `sender_role` is `owner`. Users do not reply to replies; they
send a new message.

The admin surface, on its own origin, shows every app on one screen, grouped and filtered by app
with a count of `pending` messages per app, sorted by `received_at`. It renders `context`,
`last_error`, `contact_email` and attachments as evidence for a human reading one ticket, never as
filters. Everything a message contains is attacker-controlled and rendered as text, never as
markup. Images are served from the image origin through short-lived signed URLs.

Authentication is Google OpenID Connect. The admin identity is the permanent `sub` claim, pinned
the first time an allowed email signs in and checked on every request afterward; the email is
never consulted again. `ADMIN_BOOTSTRAP_EMAILS` lists the emails allowed to pin themselves.
An authorisation failure is a logged `403`, not a blank page. Sessions are signed, `HttpOnly`,
`Secure`, `SameSite=Lax` cookies. Forms carry a CSRF token. The surface sends a strict CSP.

The admin surface is English only. Its screens: message list, message detail (reply, set status,
delete the sender's data), apps (create, rotate key, edit retention, images, origins), tokens
(create and revoke admin API tokens).

## 7. Images

Images are opt-in per app and default off. Files that are not images are never accepted.

```
POST /v1/images
Authorization: Bearer <app key>
Content-Type: image/png | image/jpeg | image/webp
<raw bytes>
```

Returns `201 {"id"}`. The client then lists the id in `attachments` on submit. An uploaded image
not claimed by a message within 15 minutes is deleted.

Mandatory handling, all tested:

1. Type is detected from the file's own bytes. Allowed: PNG, JPEG, WebP. SVG and everything else
   is rejected with `415`.
2. Caps checked before decoding: 5 MB per file, 4096 pixels per side, 3 images per message.
3. Every upload is decoded and re-encoded server-side. The client's bytes are never stored or
   served. Re-encoding strips all metadata, verified by a test that uploads a JPEG with GPS EXIF and
   asserts the stored object has none.
4. The client's filename is never used; every image has an opaque id.
5. Images are served only from the image origin, only through signed URLs valid for 10 minutes,
   with `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff` and a CSP of
   `default-src 'none'`.
6. Images inherit their message's retention and its per-`user_ref` deletion.
7. Uploads are rate limited separately from messages, counting bytes.

## 8. Abuse and rate limiting

- Per-`user_ref` limits first; per-IP behind them as a backstop. Submit: burst 3 per minute and 10
  per hour per `user_ref`; 10 per minute per IP. Read: 2 per minute per `user_ref`; per-IP off by
  default. Upload: 5 MB per minute per `user_ref`.
- The client IP is `CF-Connecting-IP`. `X-Forwarded-For` is trusted only when
  `TRUST_X_FORWARDED_FOR=true`, default false.
- The client's own cooldown is assumed absent or lying.
- No captcha anywhere. Attestation is an optional field a deployment may verify, never required.
- The owner ping never fails the request.

## 9. Retention, deletion, controller

- Default retention 90 days per app, configurable, never unbounded. The clock runs from
  `last_activity_at`: the latest of receipt, last reply and last status change.
- An hourly scheduled job hard-deletes expired messages with their replies and images, and deletes
  unclaimed images older than 15 minutes.
- Per-`user_ref` deletion exists from day one (section 5) and from the admin surface.
- `CONTROLLER_NAME` names the data controller in the privacy statement the deployment publishes.

## 10. Persist first, then notify

The message is written and the response returned before any notification is attempted. The
notification attempt is recorded on the message row: `notified_at`, `notify_error`,
`notify_attempts`. The notifier is an interface with a Telegram adapter; the messenger is a
configuration value. The ping carries the message text (truncated), `app`, `app_version`,
`platform`, `locale`, and a link into the admin surface.

The scheduled job retries unnotified messages up to 5 attempts.

One unattended check exists, `GET /api/checks` on the admin API. It asserts on results, never on
liveness: messages older than 10 minutes with no notification and fewer than 5 attempts are a
breach; messages past their retention are a breach; unclaimed images older than 30 minutes are a
breach. Any breach answers `503` with the counts, otherwise `200`. A test plants a breaching row
and proves the check goes red. Point an external uptime monitor at it.

## 11. Client contract

- POST from inside the app is the primary and only path. Plain HTTPS and JSON, no SDK.
- CORS: each app lists its allowed browser origins; preflight succeeds for any origin listed by
  any app. Native and server-to-server clients need no CORS.
- Retry rules for the app's offline queue: a queue MAY retry a network failure, a `5xx`, and a
  `429` after `Retry-After`. It MUST NOT retry any other `4xx`; it surfaces those to the user and
  moves on to the next queued message.
- Poll rules: send `since` and `If-None-Match`; never poll a `user_ref` faster than every 60
  seconds.
- The app persists the `user_ref` it sends, preferring a stable account id over a device token
  when the user is signed in, so that replies stay reachable.
- Form copy on the app side should say a reply is not guaranteed and offer the optional email.

## 12. Admin API and assistant access

```
Authorization: Bearer <admin token>
GET    /api/messages?app=&status=&since=&limit=
GET    /api/messages/:id
POST   /api/messages/:id/replies     {"content"}
POST   /api/messages/:id/status      {"status"}
DELETE /api/users?app=&user_ref=
GET    /api/checks
```

Admin tokens are created and revoked on the admin surface, stored hashed, and carry full admin
scope. The repo ships an MCP (Model Context Protocol) server in `mcp/` that wraps this API so an
assistant such as Claude Code can list and read messages, and, with the operator's approval on each
call, post a reply or set a status. Reply drafting happens in the assistant, in the message's
locale, with the app's code in view. Ulak itself calls no AI provider.

## 13. Public repository rules

- No hostnames, IP addresses, tokens, chat ids, or any operator-internal names anywhere in the
  repo: not in code, tests, examples, commit messages, or the project's own notes.
- Every deployment value in gitignored config with a committed `.example`.
- A stranger must be able to clone and self-host from the README alone.
- Secret scanning runs as a pre-push hook and in CI.
- MIT means no warranty and no support promise from the maintainers.
