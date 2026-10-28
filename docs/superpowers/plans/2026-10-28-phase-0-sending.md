# Phase 0: Sending - Implementation Plan

**Goal:** Build phase 0 of the approved communication spec (`docs/specs/2026-10-24-communication-service.md`,
sections 4, 5, 8, 9, 11.1 and 14): the send key, `POST /v1/mail` with the optional `html` part, the outbox with the
5-minute retry bounded by `expires_at`, `GET /v1/mail/status`, the vendor's event webhook, delete by address with the
per-app keyed hash, and the admin outbox view.

**Not in phase 0:** `legal_document` (phase 1: the kept copy, `held`, the open alerts, search and download). Phase 0
accepts the `kind` field and refuses `legal_document` with `422 kind_not_allowed` until phase 1 enables it.

**Ships only after:** the vendor account, its sending DNS, and legal read 4 (the privacy-statement extension, read by
operations in every locale). Until then the code is built, tested and committed, and not deployed. Nothing is sent to a
real person before all three are done.

## The vendor, as read in its documentation on 2026-10-28

The chosen vendor (option 1) renamed its transactional mail product in September 2026; its integrations, keys and
agents are unchanged. Read today:

- **Send:** `POST <api base>/v1.1/email`, the agent's key in the `Authorization` header under the vendor's own scheme name, JSON body `from`
  `{address,name}`, `to` `[{email_address:{address}}]`, `reply_to` `[{address}]`, `subject` (at most 500 characters),
  `textbody`, `htmlbody`, `track_clicks`, `track_opens`, `client_reference`. Success is HTTP 200 with `request_id`;
  an error is HTTP 400 with `data.error_code` and a sub-code. The documentation names only the global host; the account's
  data-centre host is read from the account once it exists, so the base URL is configuration.
- **Error codes** (its error-code page): request mistakes (`TM_3201` missing field, `TM_3301` bad JSON, `TM_8001` over a
  limit), account state (`TM_3501`/`LE_101` credits expired, `TM_5001`/`LE_102` credits exhausted, `TM_3601` sending IP
  not allowed / trial limit / daily limit / account blocked, `TM_4001` sender domain not verified / account not yet
  reviewed / API key invalid, or an invalid `to`). **There is no code for a suppressed recipient**: the send call does
  not say that an address is suppressed.
- **Suppression list:** kept by the vendor; addresses are added by hand or by **auto-suppression, which covers hard
  bounces only** (domain, mailbox or user not found), is switched on in the console, and is set per agent or for all.
  Spam complaints are not added automatically; the vendor tells the sender to suppress complaining recipients itself.
  No API to read the list (console and a 60-day export only).
- **Webhook:** one URL per agent, events chosen in the console (soft bounce, hard bounce, delivered, feedback loop;
  open and click exist and stay off). Each request carries `producer-signature: ts=<ms>;s=<url-encoded base64>;s-algorithm=HmacSHA256`,
  an HMAC-SHA256 under the agent's Authentication Key. The body is one form-encoded parameter; the signed bytes are its
  value after URL-decoding (the vendor's sample: split the body at the first `=`, decode the rest the way Java's
  `URLDecoder` does, so `+` becomes a space). The payload identifies the mail by `event_message.request_id` and
  `event_message.email_info.client_reference`; `event_data.object` is `hardbounce`, `softbounce` or `fbl_complaint`
  (the delivered event's names are not documented and are read from the first real one). No retry policy is documented.
  Test events can be sent from the console for bounces only; delivered and complaint need a real mail.

What this changes against the spec, put to the owner in the stress test (section "Decisions to take"):
1. Spec 5.3 says Ulak "passes the vendor's answer back as `422 suppressed`". The vendor gives no such answer.
2. Spec 5.3 relies on the vendor's list for complaints too. The vendor does not add complaints to it.

## Architecture

All in the API Worker and the admin Worker; no new Worker. Domain code in `src/core/mail/`, no HTTP dependency except
the vendor client, which takes an injectable `fetch` defaulting to `defaultFetch` (`src/core/http.ts`).

### Configuration (all or nothing)

| Name | Kind | Meaning |
|---|---|---|
| `MAIL_API_URL` | var | the vendor's send endpoint for the account's data centre |
| `MAIL_FROM_DOMAIN` | var | the company domain; every app's From address must be `<app>@` it |
| `MAIL_API_KEY` | secret | the agent's send key |
| `MAIL_WEBHOOK_KEY` | secret | the agent's webhook Authentication Key |
| `MAIL_HASH_SECRET` | secret | the root of the per-app address-hash keys |

`mailConfig(env)` returns the five values when all are set, `null` when none is, and throws `MailConfigError` naming the
missing ones when some are. Every mail route and the 5-minute job call it first:
- none set: the mail routes answer `503 mail_unconfigured` (not retryable); the job does nothing. Never a success.
- half set: the mail routes answer `500 mail_config_half_set`; the health check (`runChecks`, the `/status` route the
  external monitor reads) turns red; the job logs and stops.
- **Before deploy:** `scripts/check-mail-config.mjs` reads the Worker's var names from `wrangler.api.jsonc` and its
  secret names from `wrangler secret list`, and fails the deploy when the five are half set. `deploy:api` runs it first.

### Keys and the app's sending identity (spec 4)

Migration `0005_mail.sql` adds to `apps`: `send_key_hash` (unique), `mail_from_name`, `mail_kinds` (JSON array),
`mail_labels` (JSON array). The From address is derived, `<app id>@MAIL_FROM_DOMAIN`, never stored or typed, so it can
never be another address. The send key is `ulak_send_<app>_<48 hex>`, shown once (the existing shown-once cookie), only
its SHA-256 kept. `requireSendKey()` joins `requireAppKey()`/`requireNoticeKey()`; every send-key route refuses a
request with an `Origin` header (`403 server_only`) before reading the key.

The admin Apps page gains, per app: From name, labels (comma list), the `transactional` tick, and a "New send key"
button. An app can send only with a send key, a From name, at least one label and the kind ticked.

### The address hash (spec 8)

`addrHash(secret, app, address)` = hex HMAC-SHA256 under `HMAC-SHA256(MAIL_HASH_SECRET, "ulak-mail-addr:" + app)` of the
address lower-cased and trimmed. Each app has its own key; the key is never stored. The same address gives a different
hash in each app.

### Table `mails` (migration `0005_mail.sql`)

```
id TEXT PRIMARY KEY            -- also sent as the vendor's client_reference
app TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE
kind TEXT NOT NULL, label TEXT NOT NULL, locale TEXT NOT NULL
addr_hash TEXT NOT NULL, user_ref TEXT
idempotency_key TEXT           -- unique per app while set; cleared after 7 days
to_addr TEXT, subject TEXT, text_body TEXT, html_body TEXT   -- nulled on vendor accept or give-up
status TEXT NOT NULL           -- queued | sent | delivered | bounced | complained | given_up | refused | failed
attempts INTEGER NOT NULL DEFAULT 0
next_attempt_at TEXT, lease_until TEXT
expires_at TEXT NOT NULL, created_at TEXT NOT NULL, sent_at TEXT, delivered_at TEXT
vendor_request_id TEXT, last_error TEXT  -- scrubbed of addresses
operator_told_at TEXT          -- the one operator line on give-up/failure, never repeated
last_activity_at TEXT NOT NULL -- the retention clock
```
Indexes: `(app, idempotency_key)` unique where set; `(app, addr_hash, created_at)`; `(status, next_attempt_at)`;
`(vendor_request_id)`; `(app, user_ref)`; `(last_activity_at)`.

Table `mail_attempts (at TEXT, ok INTEGER)`: one row per vendor attempt, no personal data, purged after an hour; the
sending-health check reads it. Table `service_state`: the outbox timer records whether the mail settings are set,
unset or half set, for the health check the admin Worker serves (it cannot read the API Worker's settings).

### `POST /v1/mail` (spec 5.1, 5.2)

Order: refuse `Origin` (403) -> body cap 512 KiB and JSON (413/415/400) -> send key (401) -> config (503/500) -> fields
(400) -> app's own mistakes (422) -> idempotency (repeat: first result, `202`) -> suppression (422) -> per-recipient
ceiling (429) -> insert -> first attempt (at most 8 s) -> `202 { id, status: "sent" | "queued" }`.

- Fields: `to` one address (at most 254 characters, one `@`, no spaces or angle brackets); `locale` a short language
  tag; `kind`; `label`; `subject` (1-500 characters, one line); `text` (1-100,000 characters); `html` optional
  (at most 200,000 characters); `expires_at` ISO, later than now and at most 24 hours ahead; `idempotency_key`
  (1-128 printable characters); `user_ref` optional (16-128, as elsewhere).
- `422` reasons: `unknown_label` (not on the app's list), `kind_not_allowed` (not ticked, or `legal_document` before
  phase 1), `bad_link` (any `http://` or other non-`https` scheme link in `text` or `html`), `not_plain_text` (`text`
  holding markup: a `<tag>`), `bad_html` (`html` with `<script`, `<form`, `<img`, `<iframe`, `<object`, `<embed`,
  `<style`, `<link`, `<meta`, `<base`, an `on...=` attribute, or a `src=`/`url(`/`srcset`); a guard against an app's
  mistakes, not a sanitiser), `suppressed`.
- Idempotency: the same `(app, idempotency_key)` within 7 days returns the first mail's `{ id, status }`, its status
  mapped to `sent` once the vendor accepted it and `queued` otherwise, and sends nothing. Older keys are cleared by the
  5-minute job, so a reuse after 7 days is a new mail.
- Per-recipient ceiling: 10 per hour per app per address hash, counted and inserted in one statement (as notices are),
  `429` with an exact `Retry-After` from the oldest mail in the window.
- First attempt: the request claims the row's lease, calls the vendor with an 8-second timeout, and records the result.
  `sent` when the vendor answered 200; `queued` on anything else retryable; an address-dependent refusal by the vendor
  (an invalid `to`) answers `422 suppressed` and closes the mail.

### The vendor call (spec 5.3, 5.5, 14)

`sendViaVendor(cfg, mail, app)` posts `from { address: <app>@domain, name }`, `to`, `reply_to [{ address: <app>@domain }]`
(spec 7.1 until phase 2), `subject`, `textbody`, `htmlbody` when given, `track_clicks: false`, `track_opens: false`,
`client_reference: <mail id>`. Never a pixel, never a changed link. Results:
- `accepted { requestId }` (HTTP 200);
- `address_refused` (400 whose detail names `to` as invalid);
- `vendor_down { code }` (timeout, network, 5xx, 401/403, credits, account, domain or key codes): retried, counted for
  the health check;
- `request_bad { code }` (other 400s: a Ulak bug): closed as `failed`, one operator line.
Every error text is passed through `scrubAddresses` (every `x@y` becomes `***@***`) before it is stored or logged.

### The 5-minute job (spec 5.2)

`wrangler.api.jsonc` gains a second cron, `*/5 * * * *`; `scheduled` runs the hourly job on the hourly cron and the
outbox job on the 5-minute one. The outbox job, at most 50 mails a run so a backlog never bursts:
1. gives up every `queued` mail whose `expires_at` has passed: `given_up`, body and address nulled, one operator line
   (`[app] mail <label> given up after <n> attempts: <reason>`; no address, no subject, no link);
2. retries `queued` mails whose `next_attempt_at` has come, oldest first, each under its lease; backoff after attempt n:
   5, 10, 20, 40, then every 60 minutes, never past `expires_at`;
3. clears idempotency keys older than 7 days and `mail_attempts` rows older than an hour.

The hourly job adds: mail rows past their app's `retention_days` by `last_activity_at` are deleted.

### `GET /v1/mail/status` (spec 5.2)

Send key, `Origin` refused. `{ sending: "down" }` only when the last 3 vendor attempts in the past 10 minutes were all
`vendor_down`; otherwise `{ sending: "ok" }`. Address refusals, request mistakes, `422` and `429` are never counted.

### The webhook: `POST /v1/mail/events` (spec 5.5)

No key; the vendor's signature instead. Refused with `401` when the header is missing or malformed, the algorithm is
not `HmacSHA256`, `ts` is more than 5 minutes from now either way, or the signature does not match (constant-time).
Then, per event, the mail is found by `client_reference` (Ulak's id), else by `request_id`:
- `hardbounce`: status `bounced`, scrubbed reason stored; the address hash is suppressed (decision 1);
- `fbl_complaint`: status `complained`; suppressed likewise;
- `softbounce`: the scrubbed reason is stored, status unchanged (the vendor goes on trying);
- delivered: `delivered_at` set, status `delivered`;
- open and click (off at the vendor) and unknown events: ignored.
A verified request is answered `200` even when the mail is unknown or already deleted. No address, subject or reason
from the payload is stored unscrubbed or logged. One test vector is built from the vendor's own sample code's algorithm;
the first real event (the console's test bounce, then a real delivered event) confirms the payload in acceptance.

### Delete by address and by account (spec 8)

- `POST /v1/mail/delete` (send key, `Origin` refused), body `{ "address": "..." }`: deletes every `mails` row of that
  app with that address's hash; `{ deleted_mails: n }`. A body, not a query string, so the address never sits in a URL
  or a platform log. One app's request never touches another app's rows (the hash is per app).
- The existing `DELETE /v1/messages?user_ref=` and the admin "delete user" also delete that app's `mails` rows with that
  `user_ref`.

### Admin outbox view (spec 9)

`/outbox`, linked from the layout, filter by app: queued, failed, given-up, bounced and complained mails of the last
30 days, newest first: created, app, kind, label, status, attempts, expires, last error (scrubbed). Never an address,
a subject or a body. The Apps page gains the sending fields and the send-key button.

### Logging

Nothing of a mail is logged but its id, app, label, status and a scrubbed error.

## Tasks (each: failing test first, then code, `npm test` verbose green, commit)

1. Migration `0005_mail.sql`; schema test covers the new table and columns.
2. `src/core/mail/config.ts`: `mailConfig` all-or-nothing; tests for none, half (each missing name) and all.
3. `src/core/mail/hash.ts`: per-app keyed hash; tests: same address same app equal, case/space folded, different
   apps differ, different secret differs.
4. Apps: send key, sending fields, `findAppBySendKey`, `requireSendKey`; admin Apps page fields and button; tests.
5. `src/core/mail/validate.ts`: field checks and the 422 reasons; table-driven tests for each reason.
6. `src/core/mail/vendor.ts`: request shape (tracking off, reply_to, client_reference) and result classes, against an
   injected fetch; scrubbing; the 8-second timeout. Tests per vendor code family.
7. `src/core/mail/outbox.ts`: insert with ceiling, idempotency, suppression lookup, lease claim, record result,
   give-up, backoff, purge. Tests including two parallel claims and the ceiling under parallel inserts.
8. Routes in `src/api/index.ts`: `POST /v1/mail`, `GET /v1/mail/status`, `POST /v1/mail/delete`,
   `POST /v1/mail/events`; the 5-minute cron. Route tests through `worker.fetch` with a vendor double injected at
   the transport seam, and one seam test that the production default is `defaultFetch`.
9. Webhook signature: `src/core/mail/webhook.ts`; tests: genuine, tampered, stale, future, wrong algorithm, `+` in
   the payload.
10. Deletion by `user_ref` extended; retention by `retention_days`; tests.
11. Admin `/outbox` view and the checks route's half-set config check; tests.
12. `scripts/check-mail-config.mjs` wired before `deploy:api`; proven red on a planted half-set list, then green.
13. Docs: `docs/client-contract.md` (the mail calls, the app's side from spec 14), `docs/self-hosting.md` (the five
    settings, the vendor console steps: auto-suppression on for this agent, open and click tracking off, the webhook
    URL with its events and the Authentication Key), `wrangler.api.jsonc.example`.
14. Privacy-statement extension drafted (outbound mail, legal copies, inbound replies) and sent to operations for legal
    read 4; not merged into `docs/privacy-statement.md` before its read.

## Acceptance (live, after the account, DNS and legal read 4; not this session)

- The console's test hard bounce reaches the webhook, verifies, and marks the matching mail (or is answered 200 when
  unknown).
- One real mail to an address of the operator's own: received; its raw source read: From, Reply-To, DKIM `d=` the company
  domain, no tracking pixel, links unchanged. Its delivered event stored.
- One real mail to a real hidden Apple address arrives (spec 5.5); the vendor's bounce domain recorded.
- A mail to a suppressed address: what the vendor's send call answers is read and recorded here.
- `GET /v1/mail/status` answers `ok`.

## Decisions (stress test, owner, Session 14)

1. **Suppression:** "Ulak remembers them (Recommended)". A hard bounce or a spam complaint reported by the vendor
   marks that mail `bounced` or `complained`; while any such row of that app with that address hash exists, the app's
   next `transactional` mail to it is answered `422 suppressed`. No lift button (option O3 stays declined): the mark
   goes with the rows, by delete by address or by the app's `retention_days`. No separate table.
2. **"Fails at start":** "Block deploy + red health (Recommended)". The pre-deploy check stops a half-set deploy; at run
   time the mail routes answer `500 mail_config_half_set` and the health check turns red, while support messages keep
   working.

## Changes after the independent review (Session 14)

The review of `80e7e99` found 1 high, 4 medium and 7 low findings, all fixed with a test each:
- giving up expired mails runs before the configuration gate, so their address and content are deleted on time while
  the settings are missing or half set;
- a mail Ulak will not send is never answered `202`: `500 mail_failed` (vendor called it malformed), `410
  mail_expired` on a repeat after give-up, `422 suppressed` on a repeat of a refused mail;
- the claim and every result write use the clock at that step and the lease the attempt holds, and a result is written
  only while the mail is still `queued` under that lease, so a bounce reported meanwhile is never overwritten; a run
  stops taking mails after two minutes;
- the webhook body is read under the cap as a stream; the vendor's error text is never stored (status, codes and field
  names only); a bounce keeps the vendor's reason and the SMTP status code, never the remote server's text; the
  operator line is claimed before it is sent; a key that raced in at the ceiling returns its mail, not `429`;
- the webhook's timestamp is not signed by the vendor, so the five-minute window cannot stop a replay; every event is
  safe to apply twice (stated in the code and in `docs/self-hosting.md`);
- `html` may carry styles (mail HTML depends on them) but nothing that loads: `url(`, `image-set(`, `@import`, `src`,
  `srcset`, `background` and `http-equiv` are refused, as are `<img>`, `<link>` and embedded content. This meets the
  spec's "no scripts, no forms and no images"; the plan's earlier list also named `<style` and `<meta`.
