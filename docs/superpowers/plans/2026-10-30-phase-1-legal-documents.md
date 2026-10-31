# Phase 1: Legal documents - Implementation Plan

**Goal:** Build phase 1 of the approved communication spec (`docs/specs/2026-10-24-communication-service.md`,
sections 5.1-5.4, 8, 9, 11.1 and 14): `kind: legal_document` on `POST /v1/mail`, the kept copy and its delivery
evidence, the `held` state, the owner alerts that stay open until closed by hand, search by reference and download in
the admin panel, and the copy's own keeping period that outlives a deletion request.

**Started:** the owner, Session 15: "Plan phase 1 now (Recommended)", while phase 0 waits on the vendor account.
**Built ahead, deployed after phase 0:** the owner, Session 16: "Build now, deploy later (Recommended)", while phase
0 still waits on the vendor account. It is deployed only after phase 0 has shipped (decision 8: phases in order).

**Goes live only after:** phase 0 live; each selling app's own side (its sale handler, its daily reconciliation, its
subscription-end call, its mailed form read by operations in Turkish and English). Ulak's part is built and tested
before those.

**Legal reads answered by operations (2026-10-30, a legal reading, not advice):**
- Read 3: keep each copy **3 years** (Distance Contracts Regulation art 20(1)), counted from **the end of the
  subscription** (for a one-off sale, the sale), so every renewal's records last 3 years after it; the ground to
  outlive a deletion request is KVKK art 5(2)(ç) with 5(2)(e) (operations marks it to verify). Whether TTK art 82
  (10 years) applies is on operations' lawyer list; until answered, 3 years. The period stays one setting.
- Read 6: no after-sale deadline for a sale on a screen; the weight sits on the checkout screens before payment. Send
  at once; the 24-hour `expires_at` with the one-hour ping is right as an operating window.
- Read 11: the definition names e-mail, so the plain-text mail is a durable medium. The delivered event with the copy is
  enough evidence; keep together the exact text and its hash, the send time, and the delivered event with its time and
  the receiving server. An HTML part is not forbidden, but refusing it is the simpler safe choice: refused.
- The receipt check: the payment provider's receipt carries none of the pre-information form, the contract or the
  withdrawal right, and no Turkish; phase 1 does not shrink. Plan as if the company is the seller; operations reports
  if the provider's answer on the seller of record changes that.

**Not in phase 1:** HTML parts or attachments on a legal document (decision 2: plain text; read 11: refused),
templates or figures computed by Ulak (never), anything of the app's own side (each app builds it).

## What phase 0 already gives

- `POST /v1/mail` with `kind` validated; `legal_document` refused `422 kind_not_allowed` by `SENDABLE_KINDS`.
- The outbox row in `mails`, its lease, retries with backoff bounded by `expires_at`, the vendor call, the signed
  webhook that marks `delivered`, `bounced`, `complained`, Ulak's own suppression by address hash (owner, S14), the
  once-only operator line (`operator_told_at`), deletion by address and by `user_ref`, retention by `retention_days`.
- In `mails` the body and the plain address are deleted when the vendor accepts the mail or Ulak stops trying it.

Phase 1 keeps every phase-0 rule for the transport row unchanged and adds the lasting copy beside it.
## Architecture

The transport row in `mails` behaves exactly as in phase 0: its body goes on acceptance, its status moves as phase 0
moves it. Beside it, phase 1 keeps two things: the **copy**, a record written once at acceptance and afterwards only
stamped with the evidence times, and the **alerts**, one row per problem. No second state machine is kept in step with
`mails` (independent review, Session 15: that would race the lease and lose its history when `mails` rows expire).

### Migration `0006_legal_documents.sql`

```
legal_documents                 -- the copy the law asks for; one per accepted legal document
mail_id TEXT PRIMARY KEY        -- the mails row's id; no foreign key: the copy outlives that row
app TEXT NOT NULL               -- no foreign key with ON DELETE CASCADE: removing an app never deletes a copy
reference TEXT NOT NULL         -- the order number; [A-Za-z0-9._:/-]{1,64}
version TEXT NOT NULL           -- the accepted version; [A-Za-z0-9._:/-]{1,64}
idempotency_key TEXT NOT NULL   -- the sale's id; unique per app for the copy's whole life (never cleared)
label TEXT NOT NULL, locale TEXT NOT NULL
user_ref TEXT                   -- the app's account id, for finding; nulled by a deletion request
to_addr TEXT NOT NULL, subject TEXT NOT NULL, text_body TEXT NOT NULL   -- the exact copy, as sent
text_sha256 TEXT NOT NULL       -- hex SHA-256 of subject and text as sent, for proving the copy unchanged (read 11)
addr_hash TEXT NOT NULL
created_at TEXT NOT NULL
keep_from TEXT                  -- the keeping period's start (read 3): the sale for a one-off, the subscription's
                                -- end once the app reports it; null = kept until it is reported
sent_at TEXT, vendor_request_id TEXT   -- stamped once, when the vendor accepted it
delivered_at TEXT, delivered_server TEXT  -- stamped once, from the vendor's delivered event (its receiving server, if given)

legal_alerts                    -- one row per problem with one copy
id TEXT PRIMARY KEY
mail_id TEXT NOT NULL REFERENCES legal_documents(mail_id) ON DELETE CASCADE
app TEXT NOT NULL
kind TEXT NOT NULL              -- held | given_up | failed | bounced | undelivered
opened_at TEXT NOT NULL, told_at TEXT
closed_at TEXT, close_reason TEXT, replaced_by TEXT   -- replaced_by: a delivered copy of the same app and reference
```
Indexes: `legal_documents (app, idempotency_key)` unique, `(reference)`, `(created_at)`, `(app, addr_hash)`,
`(app, user_ref)`; `legal_alerts (mail_id, kind)` unique where `closed_at IS NULL`, `(closed_at)`.

**Idempotency scoped by kind:** the same migration replaces phase 0's `mails_idem` with a unique index on
`(app, kind, idempotency_key)`, and `findByIdempotencyKey` takes the kind. A sale's id can then key both its legal
document and its payment receipt without one swallowing the other (review H2; phase 0 refuses `legal_document`, so no
row can collide before this migration).

### Settings (the reads change numbers, not code)

| Name | Kind | Meaning | Until its read |
|---|---|---|---|
| `LEGAL_KEEP_DAYS` | var | the copy's keeping period, from `keep_from` (read 3: 3 years, so `1096`) | unset: `legal_document` is refused `422 kind_not_allowed`, so no copy is kept under a guessed period |
| `LEGAL_EXPIRY_HOURS` | var | how long Ulak keeps trying (read 6: 24 confirmed) | 24 |

`legalConfig(env)`: `LEGAL_KEEP_DAYS` a whole number of at least 1; `LEGAL_EXPIRY_HOURS` a whole number from 1 to 72,
24 when unset. Any other value is a bad setting: the legal path answers `500 legal_config_bad`, and the 5-minute
timer records `legal_config` (`set`, `unset`, `bad`) in `service_state`, which the admin Worker's health check reads
and turns red on `bad` (the admin Worker cannot read the API Worker's vars; phase 0's `mail_config` works the same
way). The keeping period is applied when the hourly job runs, never frozen into a row, so a changed read changes
every copy's period at once (review M3).

The admin Apps form gains a second tick, "sends legal documents" (`mail_legal`), beside "sends transactional mail";
saving the form keeps both (review M4: today's form rebuilds `mail_kinds` from one tick and would drop the kind).

### `POST /v1/mail` with `kind: legal_document` (spec 5.1, 5.2, 5.3)

Validation adds, on `legal_document` only:
- `document` required: `{ version, reference, sale }`, `version` and `reference` each matching
  `[A-Za-z0-9._:/-]{1,64}`, `sale` either `one_off` (the copy's `keep_from` is set to its `created_at`) or
  `subscription` (`keep_from` stays null until the app reports the end); refused on `transactional`.
- `html` refused with `422 bad_html` ("a legal document is plain text"; read 11).
- `expires_at` at most `LEGAL_EXPIRY_HOURS` ahead (`validateMail` takes the limit as a parameter).
- No per-recipient ceiling (5.3: exempt): the legal insert is its own statement without the ceiling, and legal rows
  are not counted in the transactional ceiling.

**The answer is always `202 { id, status: "queued" }`**, on the first call and on every repeat (spec 5.1, 5.2, 5.4;
review M5). Order after the phase-0 checks up to the app's own mistakes:
1. **Repeat:** the same `(app, idempotency_key)` in `legal_documents`, however old, answers `202 queued` with the
   first id and sends nothing. The daily reconciliation depends on this: an accepted sale is never mailed twice.
2. **Suppressed address** (a bounce or complaint on record for this app and hash): one batch writes the `mails` row
   already closed (`refused`, no address or body, `operator_told_at` set, so phase 0's line is never sent for it),
   the copy, and an open `held` alert. Nothing is sent.
3. Otherwise one batch writes the `mails` row (`queued`, as phase 0) and the copy; the answer goes at once, and the
   first attempt runs after it (`executionCtx.waitUntil`); if that attempt never runs, the 5-minute timer takes the
   mail at its next run.
A parallel call with the same key loses on the unique index; its batch rolls back whole and it answers the winner's id.

### What phase 1 adds to phase 0's transitions

The copy is stamped, never moved: each stamp is one guarded statement that writes only a field still empty, so order
and replays do not matter (review M2).

| Event (phase 0 unchanged) | copy | alert |
|---|---|---|
| vendor accepted (`sent`) | `sent_at`, `vendor_request_id` where `sent_at IS NULL` | - |
| vendor refused the address (`refused`) | - | open `held` |
| vendor called it malformed (`failed`) | - | open `failed` |
| `expires_at` passed unsent (`given_up`) | - | open `given_up` |
| delivered event | `delivered_at` (and `delivered_server` when the event names it) where null, found by mail id or vendor id **in `legal_documents`**, even when the `mails` row is gone or given up | the open `undelivered` alert closes itself |
| hard bounce | - | open `bounced` |
| spam complaint | - | none: the mail reached the mailbox; the address is suppressed as in phase 0 |
| soft bounce | - | none: the vendor goes on trying; `undelivered` covers it |

The alert statements run after phase 0's own write and only when it changed a row (its `meta.changes`), so a write that
lost the lease opens nothing. Opening is `INSERT ... ON CONFLICT DO NOTHING` on the open-alert index, so a replayed
event opens one alert. Several problems with one copy are several rows: `undelivered` at the first hour and `bounced`
at the fifth are two alerts, each told once (review H1).

`untoldFailures` excludes `kind='legal_document'`: a legal mail's operator line is its alert's, told once (review M1).

### Alerts (spec 5.4, 14)

- `undelivered`: the 5-minute job opens it with one guarded insert for every copy with `delivered_at IS NULL`,
  `created_at` more than an hour ago, and no `undelivered` alert yet, so a delivery that arrives meanwhile is never
  raced into an alert (review L5).
- **The ping:** one Telegram line per alert when it opens, claimed through `told_at` before it is sent and released
  if the send fails, like phase 0's line: `[app] legal document <kind>: open in the admin panel` with the link to
  `/legal`. No reference, no address, no subject, no version.
- **The daily reminder** (owner, Session 15): while any alert is open, the hourly job sends one line a day,
  `[legal] open alerts: <app> <n>, ...`. The day is claimed in `service_state` (`legal_reminder_day`) with a
  conditional update before sending and released on failure, so a repeat run never sends it twice (review L4).
- **Closing:** the operator closes an alert with a reason (1-500 characters). Optional `replaced_by`: the mail id of a
  delivered copy of the same app and reference, checked; the app's corrected call is the remedy the spec names, the
  other is the copy downloaded and sent by hand, which the reason states. A closed alert stays closed; a new problem
  opens a new row.
- The health check shows the count of open legal alerts and does not turn red for them: they are the operator's work,
  not a fault of Ulak.

### Admin panel (spec 9)

`/legal`, linked from the layout:
- **Open alerts** first: opened, app, label, reference, version, kind; each with a "Close" form (reason, optional
  `replaced_by`).
- **Search by reference** (exact match, optional app filter, at most 50 rows): created, app, reference, version, sent,
  delivered, open alerts.
- **Download** (`/legal/:mail_id/copy`): `text/plain; charset=utf-8`, `Content-Disposition: attachment;
  filename="legal-<mail_id>.txt"` (never the reference in a header, review L6), `X-Content-Type-Options: nosniff`:
  recipient, subject, version, reference, the acceptance time and vendor id, the delivery time, then the body as sent.
- Never a body or an address on a page.
- Lean (global rule "Lean everywhere"): the page's one main action is closing an open alert; with none open it says so
  in one line, and the search field is the rest of the page. A copy's times and ids show only in the search row and
  the download.

### Deletion and keeping (spec 8)

- **The subscription's end** (read 3): `POST /v1/mail/legal/end` (send key, `Origin` refused), body
  `{ reference, ended_at }`, sets `keep_from` on every copy of that app and reference whose `keep_from` is null, so a
  renewal's documents share the subscription's end. `ended_at` is ISO and not in the future; a repeat changes nothing;
  `{ updated: n }`. The app calls it when the subscription ends (its daily reconciliation also reports the ends it
  finds, so a missed call is made up the next day). A copy whose end is never reported is kept: never deleted early,
  and the admin `/legal` page counts copies with no end older than 400 days, for the operator to ask the app.
- The hourly job deletes copies whose `keep_from` is older than `LEGAL_KEEP_DAYS` at that run, in slices; their
  alerts go with them, open or not: the keeping period is the law's, and an alert still open at its end is moot
  (tested).
- **Every deletion path** keeps the copies and nulls their `user_ref`: by `user_ref` (`deleteUser`, called from the
  public API, the admin JSON API and the admin panel) and by address (`POST /v1/mail/delete`). Each answer gains
  `kept_legal_copies` beside its own count; the admin panel's confirmation line shows it (review M6).
- A legal mail's `mails` row that is still `queued` is kept (its body is the only one Ulak can still send) with its
  `user_ref` nulled; every other `mails` row goes as in phase 0. Deleting by address also deletes the bounce and
  complaint rows that suppress the address: the person asked to be forgotten, so the next mail to it is tried again
  (phase 0's behaviour, kept knowingly).
- `retention_days` never touches a copy.

### Privacy statement

The read-4 template already covers legal copies (`docs/privacy-statement.md`, "a legal duty of the seller"). Any
change the keeping period or deletion answer brings goes to operations first.

### Logging

Nothing of a copy is logged but its mail id, app, label and alert kind.

## Tasks (each: failing test first, then code, `npm test` verbose green, commit)

1. Migration `0006_legal_documents.sql`: the two tables, their indexes, the idempotency index scoped by kind; schema
   test (columns, indexes, no cascade from `apps`); `findByIdempotencyKey` by kind, with a test of a receipt and a
   legal document sharing one key in both orders.
2. Settings: `legalConfig(env)` with a table test for each bad value; `legal_config` in `service_state` and the red
   health check, red on a planted bad value, then green; the admin `mail_legal` tick, refused while unset, kept on save.
3. Validation: `document` with its character set and `sale`, `html` refused, the legal expiry parameter,
   `SENDABLE_KINDS` gains `legal_document`; table-driven tests. The copy's `text_sha256` computed at insert, with a
   test that the download's body hashes to it.
4. `src/core/mail/legal.ts`: the insert batch (queued, or closed and `held` when suppressed), the ceiling exemption
   (11 legal mails to one address all accepted), the repeat answer; tests including a parallel duplicate key and
   repeats after `held`, `given_up` and 8 days.
5. Stamps and alerts on every transition of the table above; a test per row; a race test with a vendor double that
   delivers a bounce event mid-attempt (no alert from the losing write, the copy unstamped); a delivered event after
   the `mails` row was deleted still stamps the copy; `untoldFailures` skips legal mails (a legal `given_up` gives
   exactly one Telegram line).
6. Alerts: the guarded `undelivered` opener, its self-close, the once-only ping with release on failure, the daily
   reminder's claim, close by hand with reason and a checked `replaced_by`; a test that every line holds no address,
   reference, subject or version, and that `console` output holds none either.
7. Route: the legal path answers `202 queued` before the first attempt (a vendor double that blocks); the timer sends
   a mail whose `waitUntil` attempt never ran; every repeat answers `202 queued`.
8. Deletion: all four paths keep copies and queued legal rows and null `user_ref`, each answer's counts;
   `POST /v1/mail/legal/end` (sets only null `keep_from`, one app's call never touches another's copies, a future
   `ended_at` refused); a subscription copy with no end is never deleted; the hourly job deletes by the setting at run
   time (raising the setting keeps a copy that the lower one would have deleted);
   `retention_days` leaves copies.
9. Admin `/legal`: alerts, search with its limit, close, the download's headers and filename with a planted
   reference holding a quote; a test that renders every view with a planted address and body and finds neither.
10. Docs: `docs/client-contract.md` (the legal call, `document`, the always-`queued` answer, repeats, keys scoped by
    kind, the app's side from spec 5.4 and 14: the sale handler's capped wait, answer the webhook with an error until
    Ulak's `202`, the daily reconciliation with its look-back and 36-hour ping, the subscription-end call and the
    reconciliation's report of ends), `docs/self-hosting.md` (the two settings, `LEGAL_KEEP_DAYS=1096`),
    `wrangler.api.jsonc.example`.
11. Independent review of the whole diff by a fresh reviewer; planted defects (mutations) on the insert batch, the
    repeat check, the stamp guards, the alert opener, the deletion exemption and the download headers, each caught by
    a test.

## Acceptance (live, after phase 0 and the reads)

- A legal document from a sandbox sale to the operator's own address: `202 queued` inside the sender's timeout; the
  mail received and its raw source read (plain text, no tracking, links unchanged); the copy downloaded and compared
  byte for byte with the received body; the delivered event stored on the copy.
- A repeat of the same key after delivery answers `202 queued` with the first id and sends nothing (the vendor's log
  shows one mail).
- A legal document to a suppressed test address: `202 queued`, a `held` alert, one Telegram line, the alert closed by
  hand with a reason.
- A deletion by that address: the copy kept, its `user_ref` nulled, the answer's counts read.
- The sandbox sender re-delivers only 3 times in about a minute (spec 5.4), so live acceptance proves the app's daily
  reconciliation, not re-delivery.

## Decisions to take (stress test)

The owner, Session 15:
1. **While an alert stays open:** "Daily reminder (Recommended)": one Telegram line a day with the number of open
   alerts per app, until each is closed, besides the one line when an alert opens.

Taken by the agent (recorded here, open to the review):
- The copy in its own table, not kept in `mails`: phase 0's "the body goes on acceptance" stays true without
  exceptions, and the copy's life is separate from the transport row's.
- The legal idempotency key never expires while the copy is kept (phase 0's 7 days would let a late reconciliation
  mail a sale twice).
- `legal_document` refused until `LEGAL_KEEP_DAYS` is set: no copy is kept under a guessed period.
- A spam complaint on a legal document opens no alert: the mail reached the mailbox.
- The one-hour alert counts from `created_at`, not from the vendor's acceptance, so a mail stuck in the outbox is
  caught too.

## Changes after the independent review of the plan (Session 15)

A fresh reviewer read the first draft against the spec and the phase 0 code: 2 high, 7 medium, 8 low findings. All are
folded in above: alerts are rows, so a second problem with one copy is never lost (H1); idempotency keys are scoped by
kind (H2); a legal mail is told once, through its alert, and a suppressed one leaves no body in `mails` (M1); the copy
is stamped by guarded statements instead of a synced state (M2); the keeping period is applied at run time (M3); the
legal setting reaches the health check through `service_state`, and the admin form keeps the kind (M4); every legal
answer is `202 queued` (M5); all four deletion paths are named (M6); the expiry setting is validated (M7); and the
ceiling exemption, delivered evidence keyed on the copy, the daily reminder's claim, the guarded one-hour opener, the
download filename, the search limit and the leak tests (L1-L8). `delivery_code` was dropped: the delivered event
carries no code today.

## Changes after operations' legal reads (Session 15)

Operations answered reads 3, 6, 11 and the receipt check the same day (see the header). Folded in: `LEGAL_KEEP_DAYS`
is 3 years counted from `keep_from` (the sale for a one-off, the subscription's end, reported by the new
`POST /v1/mail/legal/end`), never from `created_at`; `document.sale` says which; the copy keeps `text_sha256` and the
delivered event's receiving server; the 24-hour window and the HTML refusal stand; phase 1 does not shrink.

## Changes during the build (Session 16)

Built in `aec3608`, `5f74881`, `fcb3613` and the review fixes after them; not deployed. Choices the plan left open,
and the independent review's findings (0 high, 3 medium, 8 low), folded in:
- Each alert kind opens at most once per copy, open or closed: a replayed event never reopens what the operator
  closed (the plan's "a new problem opens a new row" stands: a different kind is a new row).
- No `undelivered` alert on a copy with a `held` one: it was never sent and is already the operator's.
- A hard bounce opens `bounced` whenever it matches a copy, also when the transport row is gone.
- `text_sha256` is SHA-256 of the subject, a blank line and the text (a subject holds no line break).
- Any vendor event for a copy fills a missing acceptance with the event's time and the vendor's id, and the 5-minute
  job repairs what a stopped Worker leaves between two writes: an acceptance the transport row holds but the copy
  does not, and an alert a closed transport row calls for (review M1).
- `POST /v1/mail/legal/end` refuses an `ended_at` before the newest copy of that reference: a set start cannot be
  corrected by a repeat (review M2).
- `LEGAL_KEEP_DAYS` below 365 is a bad setting, so a typo (109 for 1096) turns the health check red instead of
  deleting copies within the hour (review M3).
- An alert records who closed it (`closed_by`), `replaced_by` may not be the alert's own copy, a later event can fill
  a missing receiving server, and each download is logged with the mail id, app and admin only (review L1, L4, L5).
- The receiving server is read tolerantly from any event field named for a server, mx or host; pin the exact field
  from the first real delivered event (phase 0's acceptance).
- Accepted as they are: a ping lost between its claim and its send (the daily reminder covers it), no per-sender
  ceiling on legal documents (spec 5.3), the phase-0 replay window, and an admin form error shown as plain text like
  every other form.
- Planted defects: 26; 23 caught by a test. Three survive, each a guard another guard backs up: the repeat check
  before the unique index, the undelivered opener's delivery guard in its select (the insert repeats it), and the
  delivered stamp's COALESCE (its WHERE repeats it). Removing both guards of a pair is caught.
