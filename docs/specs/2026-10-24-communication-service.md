# Ulak as the communication service - specification (DRAFT 1, for initial review)

Status: draft 1, 2026-10-24 (Session 11). Inputs: the owner's brief, the first client application's feedback and its
separate view, and the operator's (company operations) feedback. Next: their initial review, then the owner's
approval. **Nothing in this document is built before the owner approves it, and each phase's size goes to him first.**

This repository is public: this document names no other project, host or person. "The company domain" and
"`<app>`" stand for the deployment's values.

## 1. The brief

The owner, Session 11: "My priority is that it will handle all the external communication of all our apps. The apps
will build their bridges but you will handle the incoming and outgoing communication."

**In scope:** communication between the company's apps and people outside the company (players, customers, buyers), in
both directions: mail out, mail in, push to a phone, store reviews, support messages (existing), and legally required
documents sent after a sale.

**Out of scope** (owner ruling via operations, Session 11): messages between the company's own agents or projects, and
sorting the company mailbox (vendors, accountant, authorities, DMARC reports). Payment and store webhooks
(machine-to-machine) also stay with each app.

## 2. Principles

1. **The app owns the words and the timing; Ulak owns the transport, the inbound channels and the records.** An app
   sends finished text (subject, body, language) and decides what to send and when (its throttles, its no-night and
   one-push-a-day rules, its enumeration-safe sign-in wording). Ulak delivers, retries, records the result, receives
   replies and legal notices, and tells the owner when something fails. Every text has already gone through the app's
   legal and language reads; Ulak never rewrites it.
2. **Store the minimum.** Ulak keeps metadata (which app, which kind, when, result, the vendor's id) and not message
   bodies or plain addresses. The one exception is a legal document: its exact sent copy is kept for its legal period.
3. **Sign-in never depends on Ulak alone.** A sign-in mail is sent with one immediate attempt and its result returned at
   once, so the player sees "we could not send it, try again" instead of waiting. Until sign-in has run through Ulak
   in production for an agreed period, each app keeps its own sending path as a fallback.
4. **One flow at a time, sign-in last.** Each flow moves only after it is proven live; the old path is switched off
   after that, never before.
5. **Each phase's size and running cost go to the owner before it is built.**
6. Existing Ulak rules stay: errors are `{ error, retryable, detail }`; message content is rendered as text, never as
   markup; no AI provider inside Ulak; no end-user accounts; no captcha; no non-image attachments (section 5.4 keeps
   legal documents as text so this rule does not change).

## 3. What Ulak already does (unchanged)

- Support messages in (text plus up to 3 images), a text-free Telegram ping to the operator, replies back by polling.
- Owner notices: `POST /v1/notify` with a separate notice key.
- Admin panel (Google sign-in, PKCE), admin JSON API, retention by `last_activity_at`, per-user deletion.

## 4. Keys and roles

Each app already has an app key (support) and an optional notice key. Sending gets its **own send key per app**,
issued and rotated in the admin panel like the notice key, server-only: a request with an `Origin` header is refused.
A leaked support key, which may live in a web page, can therefore never send mail or push.

Each app's row gains its sending identity: From name, From address (`<app>@` the company domain), Reply-To policy,
and which kinds it may send (transactional, legal document; commercial off - section 5.6).

## 5. Outbound mail

### 5.1 The call

`POST /v1/mail` (send key). Body:

| Field | Meaning |
|---|---|
| `to` | one address |
| `locale` | the language the text is in (recorded, not used to choose words) |
| `kind` | `transactional` \| `legal_document` \| `commercial` |
| `class` | `immediate` (one attempt, result now) \| `durable` (Ulak retries) |
| `label` | the app's own name for the mail, for example `password_reset` (for records and counts) |
| `subject`, `text` | finished plain text; links absolute (`https://`), checked |
| `idempotency_key` | required; the same key within 7 days returns the first result and sends nothing again |
| `user_ref` | optional; the app's opaque account id, used only for deletion |
| `document` | `legal_document` only: `{ version, reference }`, for example the accepted version and the order number |

Answers: `202 { id, status: "sent" | "queued" }`, `409` for an idempotency key reused with different content, `422`
for a suppressed address (not retryable), `503 retryable` for an immediate send that failed.

### 5.2 Delivery

- `immediate`: one attempt with a short timeout (about 8 s; a hung vendor must not hold the caller); the result is
  returned. Ulak does not retry it. Use: sign-in mails, where the player is waiting.
- `durable`: accepted into an outbox (D1) and sent at once; on failure retried with backoff by the scheduled job for up
  to 24 hours. A durable mail still failing after its first hour pings the owner on Telegram (text-free: app, label,
  count). Its body is held only until it is delivered or given up, then deleted, except a legal document's.
- The app's own retries (for example a payment webhook re-delivered) are safe through `idempotency_key`.

### 5.3 Safety limits Ulak enforces (the app's own throttles stay in the app)

- A per-recipient ceiling per app (for example 10 mails per hour per address), so a bug or an abused form in an app
  cannot flood an inbox. Exceeding it answers `429` with `Retry-After`.
- Suppression: a hard bounce or a spam complaint reported by the vendor suppresses that address for that app; later
  sends answer `422`. The operator can lift it in the admin panel.
- Links must be absolute `https://` and the text must be plain text; anything else is refused with a reason.

### 5.4 Legal documents

For the after-sale documents a buyer must receive on a durable medium (an e-mail counts), filled with the order
number, date, plan and price:

- The app sends the filled text exactly as accepted (`kind: legal_document`, `class: durable`) with the document
  version and the order reference. The app owns the text and its legal review; Ulak stores no templates.
- Ulak keeps the exact sent copy (subject, text, recipient, version, reference, sent time, vendor id) for the legal
  period (3 years for distance-sale records), then deletes it. It survives a user-data deletion until that period ends
  (legal read needed, section 10).
- The operator can find a copy in the admin panel by reference and download it, as proof that it was sent (the
  burden of proving the buyer got the documents is the seller's).
- Form: the first client's design sends the filled documents as HTML attachments (the Turkish documents govern; a
  buyer whose account is not Turkish gets an English body with the Turkish documents and their English twins). The
  legal read found HTML sufficient and PDF only recommended. Ulak would accept up to 4 HTML attachments for
  `legal_document` only, each stored as sent. This touches the rule "no non-image attachments", which was written for
  inbound support messages: the owner decides (section 12, item 7). The fallback, if he says no, is the documents as
  plain text in the body.
- Ulak takes every figure as given (amounts and tax exactly as the payment provider stated them) and never fills,
  computes or infers anything; the app must call only once it has the figures and the accepted version, and must not
  call for a sale with no linked acceptance.
- The app calls as soon as it has decided the documents are owed; Ulak's `202 queued` is then the durable record of
  that duty, so a later failure in the app cannot lose it.

### 5.5 Sender, DNS and vendor

- From `<App name> <app@company domain>`, so players and store reviewers recognise the app.
- Vendor: a transactional mail API over HTTPS (a Worker cannot keep an SMTP session reliably). Candidates:
  1. the company mail provider's transactional service, about $2.50 per 10,000 mails, credits valid 6 months, same
     provider family that already sends for the domain (recommended);
  2. the platform's own email sending (public beta; needs the paid Workers plan, $5 a month, which includes 3,000 mails);
  3. another transactional API with a free tier.
  The choice and its monthly figure are the owner's.
- DNS (SPF, DKIM, DMARC) and the Apple private-relay registration of every sender are done by operations with the
  owner. A mail to a hidden Apple address bounces unless its sender is registered.
- The vendor reports deliveries, bounces and complaints to a signed webhook on Ulak; the signature is verified.

### 5.6 Commercial mail

Off in this version: `kind: commercial` is refused. A commercial e-message in Türkiye needs recorded consent in the
national register (İYS), and Ulak cannot verify that today. Turning it on is a separate decision after a legal read.

## 6. Push

Recommended shape: **Ulak delivers, the app schedules, and Ulak stores no device tokens.**

- `POST /v1/push` (send key): the device token, title, body, an optional link or data, an `idempotency_key`. Ulak
  calls the push provider with the app's own credentials (stored as a secret per app) and returns the result. An
  invalid-token answer is passed back, so the app drops that token.
- Keeping tokens in the app means sign-out and account deletion clear them where they already live (the
  sign-out-stranger rule), and Ulak holds no device data.
- Push content carries no personal data (company rule); Ulak refuses a body over a small size and logs nothing of it.
- The app's budget rules (one push a day, the player's own hour, nothing at night) stay in the app; they depend on the
  game's data.
- Open: whether moving push gains enough to be worth a phase at all (the transport is one call per app today). Owner
  decides at phase 5.

## 7. Inbound

### 7.1 Replies to our mails

Every outbound mail carries `Reply-To: reply+<token>@<inbound subdomain>`, where `<token>` is a signed id of that mail.
The inbound subdomain's MX points to the platform's email routing, which hands each mail to an Ulak email Worker. The
root domain's MX and the company mailbox are not touched.

The Worker verifies the token, strips the quoted history, keeps text only (images as attachments follow the support
rules; any other attachment is dropped and the operator told), and files the reply as a support message under the app
and the original mail's `user_ref`. The operator gets the usual text-free Telegram ping and answers in the admin panel;
the answer goes back by mail from the app's address. A reply without a valid token is filed as unlinked.

### 7.2 App mailboxes and the registered e-mail (KEP) address

The per-app mailboxes stay where they are (the company mail provider, read by the owner every two days). Two options
for the operator to choose with the owner:

- a forwarding rule in the mail provider copies each app mailbox to an Ulak inbound address, so it arrives in the admin
  panel with a Telegram ping; or
- no change, with a Telegram reminder every two days.

The registered e-mail (KEP) address is a legal channel; whether its provider can forward is unknown (section 10).

### 7.3 Legal clocks (the withdrawal notice)

A buyer's withdrawal notice starts a 14-day refund clock. When an inbound message (from any channel, including the
support form) is marked **withdrawal** by the operator, Ulak records its arrival time, computes the due date, pings
the owner at once with the date, and again 3 days before it falls due and on the day, until the operator marks it
done. Inbound mail containing the words for withdrawal in the app's languages is flagged as a possible withdrawal in
the ping; the decision stays the operator's (no AI inside Ulak).

### 7.4 Store reviews

The scheduled job reads new reviews from the two stores' APIs per app, files them in the admin panel and pings the
operator; the operator can reply from the panel through the store's API. Credentials per app as secrets. Owner decides
at phase 6.

## 8. Records, retention and deletion

- Each send writes one metadata row: app, kind, label, class, a keyed hash of the address (for suppression and
  counts, never shown), `user_ref`, created, sent, result, vendor id, attempts. Bodies are deleted on delivery or
  give-up. Retention follows the app's `retention_days`.
- Legal-document copies: kept for the legal period, then deleted by the scheduled job.
- Per-user deletion (existing `DELETE` by `user_ref`) also removes that user's send rows and inbound replies, except
  legal-document copies still within their legal period.
- No address, token or body in any log or error (addresses masked); no personal data to error tracking.

## 9. Admin panel

- Outbox per app: sent, queued, failed counts for the last day and week; failed and queued mails with reason; retry
  now; suppression list with lift.
- Legal documents: search by reference; view and download the exact copy.
- Withdrawal clocks: open ones with their due dates.
- Inbound replies and app-mailbox copies appear in the existing message list.

## 10. Questions for a legal read (operations) before the phase that needs them

1. Transfer abroad (KVKK art 9): the platform and the mail vendor process addresses and bodies; the processors'
   answers are awaited.
2. İYS: confirm that every mail in phases 1-4 is transactional; what the commercial switch would need.
3. Retention: whether a legal-document copy may outlive a user's deletion request, and for how long.
4. Each app's privacy text naming Ulak's processors, before its first flow moves.
5. The KEP channel: whether it may be read or forwarded automatically.

## 11. Phases (one at a time; each sized to the owner first)

| Phase | What | Needs first | Rough size |
|---|---|---|---|
| 0 | Vendor account, sending DNS, Apple relay registration, the send key, the outbox table, the vendor webhook | owner: vendor and monthly cost; operations: DNS, legal read 1 | 1 session |
| 1 | Legal documents mail (unblocks selling in Türkiye) | phase 0; legal read 3 | 1 session |
| 2 | Inbound replies and withdrawal clocks; app-mailbox forwarding if chosen | phase 0; inbound subdomain DNS; legal read 5 | 1-2 sessions |
| 3 | Each app's other transactional mails, one app at a time | the app's privacy text (legal read 4) | per app, small |
| 4 | Sign-in mails, with the app's own path kept as fallback | phases 1-3 proven live | per app, small |
| 5 | Push delivery (if the owner wants it) | owner decision | 1 session |
| 6 | Store reviews (if the owner wants it) | owner decision; store API credentials | 1 session |

Running cost estimate at today's volume (a few hundred mails a day across apps): mail about $1-3 a month on option 1;
the platform's free plan covers the rest; option 2 adds $5 a month.

## 12. Decisions for the owner

1. The mail vendor and its monthly figure (5.5).
2. Push: no tokens in Ulak (recommended) and whether phase 5 happens at all (6).
3. Commercial mail stays off (recommended) (5.6).
4. App mailboxes: forward to Ulak, or a two-day reminder (7.2).
5. Store reviews in Ulak, yes or no (7.4).
6. The phase order in section 11.
7. Legal documents as HTML attachments (outbound, `legal_document` only), or as plain text in the body (5.4).

## 13. Open inputs

- The other apps' extras beyond the sign-in set: asked by letter on 2026-10-24; answers fold into draft 2.
- The first client's existing mail code (17 kinds of mail, about 23 variants, EN/TR/DE plain text) and its
  never-shipped after-sale documents work (32 patches): read in full for this draft; the required parts are in 5.4
  and section 14, and its over-build (a resend job, an admin list and a refund path inside the app) is not carried.
- Whether the payment provider's own receipt can carry part of the documents duty: not confirmed with the provider.

## 14. Requirements carried from earlier work (must not be lost)

- A mail failure never changes the answer a player gets from the app (best effort at the caller), except a sign-in
  mail's "could not send", which the app shows.
- No account enumeration: the app's wording; Ulak never reveals whether an address is suppressed to anyone but the
  calling app.
- Absolute links; plain text; the account's language chosen by the app.
- A send timeout; all-or-nothing configuration (a half-set vendor config fails at start, not at the first send).
- Addresses masked in anything stored or logged; vendor error texts contain the recipient's address and are scrubbed
  before they are stored, and nulled when that person's data is deleted.
- An unconfigured or half-configured vendor must never look like success.
- A send that went out but could not be marked sent may be retried: duplicate over loss, chosen knowingly.
- "No address" (or a suppressed one) is final: closed once with one operator line, never alarmed again.
- Every operator alert can be closed (handled by hand, or no longer owed), or the alert list stops meaning anything.
- Throttle per recipient as well as per sender.
- Legal documents: the filled values (order number, date, plan, price and the payment provider's own tax figure), the
  version the buyer accepted, the sale linked by the payment provider's signed id, the buyer named only by the account
  address.
