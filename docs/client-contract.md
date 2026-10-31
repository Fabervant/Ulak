# Ulak client contract

This is what an app needs to integrate with a running Ulak instance. It is written for the person
adding a "contact support" feature to an app, on any platform, with plain HTTPS and JSON.

## The one function

Put the whole integration behind one function in your app, for example `submitSupportMessage(...)`.
Screens call the function; the function talks to Ulak. If you ever change how messages travel, you
change one function body and no screen.

## Endpoints

The operator gives you two things: the API base URL and your app's key. The key looks like
`ulak_<app>_<48 hex characters>`. It ships inside your app, so treat it as public: it identifies
your app as a tenant, it does not authenticate anyone. An app that has a server of its own should
keep the key on the server and relay messages from there.

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/messages` | submit a message or crash report |
| `GET` | `/v1/messages?user_ref=…&since=…` | poll for status and replies |
| `DELETE` | `/v1/messages?user_ref=…` | delete everything a user sent, from your account-deletion path |
| `POST` | `/v1/images` | upload one image before submitting, if the operator enabled images for your app |

Every request carries `Authorization: Bearer <app key>`.

## Submit

```
POST /v1/messages
Authorization: Bearer ulak_myapp_…
Content-Type: application/json
```

```json
{
  "app": "myapp",
  "app_version": "2.3.1",
  "app_build": "231",
  "platform": "android",
  "user_ref": "3f9c2e1d4b5a6978877665544332211aabbccdd",
  "message": "The export button does nothing on the orders screen.",
  "client_ts": "2026-09-05T18:22:04.120Z",
  "client_msg_id": "9b2c1a0e-3f4d-4e5f-8a9b-0c1d2e3f4a5b",
  "locale": "tr-TR",
  "last_error": null,
  "contact_email": null,
  "context": { "screen": "orders", "device": "Pixel 8", "os": "Android 15" },
  "attachments": []
}
```

| Field | Rule |
|---|---|
| `app` | required; must be the app your key belongs to |
| `app_version` | required; max 64 chars. `app_build` (optional, max 64) is for a build number distinct from the marketing version |
| `platform` | required; `web`, `android`, `ios`, `windows`, `macos`, `linux` |
| `user_ref` | optional; see below. `null` is fine for an anonymous user |
| `message` | max 8000 chars; may be empty only when `last_error` is set (a crash report) |
| `client_ts` | optional ISO 8601 timestamp from the device clock; stored as sent, never used for ordering |
| `client_msg_id` | required; a UUID version 4 you generate before the first attempt and reuse on every retry |
| `locale` | optional BCP 47 tag such as `tr-TR` or `en`; drives the language of status labels and tells the operator which language to reply in |
| `last_error` | optional; max 4096 chars; truncate on the device |
| `contact_email` | optional; only if the user typed it; it is never shown back through the API |
| `context` | optional JSON object, max 8 KB serialised; anything a human reading the ticket would want; never queried; do not put personal data in it |
| `attachments` | optional; up to 3 image ids from the upload endpoint |

Unknown fields are ignored. Fields are only ever added, so an older client keeps working.

Responses:

| Status | Meaning | Retry? |
|---|---|---|
| `201` | stored; body `{"id","received_at"}` | no |
| `200` | this `client_msg_id` was already stored with the same body; same `id` back | no |
| `400` | `invalid_request`, with `field` naming the problem | no: fix the payload |
| `401` | `invalid_app_key` | no: fix the key |
| `403` | `app_mismatch` or `images_disabled` | no |
| `409` | `idempotency_conflict`: the id was reused with a different body; generate a new id | no |
| `413` | `payload_too_large`: over 16384 bytes; shorten `message` or `context` | no: tell the user |
| `415` | wrong `Content-Type` | no |
| `429` | `rate_limited`; the `Retry-After` header says how many seconds to wait | yes, after `Retry-After` |
| `5xx` | server trouble | yes |

Every error body is `{"error": "<code>", "retryable": true|false, "detail": "<text>"}`.

## Offline queue and retries

Users write support messages precisely when things are broken, so queue locally and retry. Rules
that keep six different queues from guessing differently:

- Generate `client_msg_id` once, before the first attempt, and store it with the queued message.
  Retrying with the same id can never create a duplicate.
- Retry a network failure, a `5xx`, and a `429` (after `Retry-After`).
- Never retry any other `4xx`. Show the user what happened ("your message was too long") and move on
  to the next queued message. A stuck message must not block the ones behind it.
- Keep `client_ts` as the moment the user wrote the message, not the moment it was sent.

Rate limits on submit: 3 per minute and 10 per hour per `user_ref`, plus a per-address backstop.
The two per-`user_ref` limits are exact. The per-address backstop and the read limit are
best-effort and counted per Cloudflare location, so do not rely on their precise thresholds.
Assume your own cooldown on the device may be bypassed; the server enforces its own.

## `user_ref`

An opaque, stable, high-entropy string that only your app can resolve back to a person. Ulak
stores it, matches on it, and never interprets it. Requirements:

- 16 to 128 characters, at least 96 bits of entropy. This is a security requirement: on the read
  endpoint, whoever knows a `user_ref` can read that user's thread. A sequential id, an email, a
  phone number or a short hash would expose every user.
- Never the raw account id. Two recipes that work:
  - **HMAC**: `hex(HMAC_SHA256(per_app_secret, account_id))`. Stable across devices for a signed-in
    user; unreadable without your secret.
  - **Random token**: generate 32 random bytes on first launch, store them on the device, send the
    hex. Simple, but dies with an uninstall or cleared storage.
- Prefer a stable account id (recipe one) over a device token whenever the user is signed in, and
  persist whatever you send, because it is also the key you poll with. A `user_ref` you lose is a
  reply the user never sees.
- Anonymous is allowed: send `null`. The user then cannot receive a reply, which is why the form
  should offer the optional email field.

## Poll for replies and status

```
GET /v1/messages?user_ref=<ref>&since=<cursor>
Authorization: Bearer ulak_myapp_…
If-None-Match: "<etag from last time>"
```

```json
{
  "messages": [
    {
      "id": "…",
      "received_at": "2026-09-05T18:22:05.301Z",
      "last_activity_at": "2026-09-06T09:10:44.002Z",
      "status": "in_progress",
      "status_label": "İlgileniliyor",
      "message": "The export button does nothing on the orders screen.",
      "replies": [{ "id": "…", "sender_role": "owner", "content": "Merhaba, …", "created_at": "2026-09-06T09:10:44.002Z" }]
    }
  ],
  "cursor": "2026-09-06T09:10:44.002Z"
}
```

- Send `since` as the `cursor` from your previous response; the reply contains only messages with
  activity after it. Omit it the first time.
- Send `If-None-Match` with the previous `ETag`; a `304` means nothing changed.
- Do not poll one `user_ref` more often than every 60 seconds. Faster gets `429` with `Retry-After`.
  Poll while the support screen is open, and once on app start if there are messages awaiting a
  reply.
- `status_label` is the status in the message's `locale` when Ulak has a translation, English
  otherwise. Render `status` yourself if you prefer your own wording.
- An unknown `user_ref` returns an empty list, never an error.
- The response never contains `contact_email`, `context`, `last_error` or attachments.

Users do not reply to replies. A follow-up is a new message.

## Deletion

```
DELETE /v1/messages?user_ref=<ref>
```

Hard-deletes every message, reply and image that `user_ref` sent to your app. Call it from your
account-deletion flow. Returns `{"deleted_messages": n, "kept_legal_copies": k}`: `k` legal documents
of that person are kept by the seller's legal duty, with the `user_ref` removed (see Legal documents).

## Sending mail

If the operator has set up outbound mail and turned it on for your app, your app's server hands its
finished mails to Ulak, and Ulak sends them from your app's own address (`<app id>@` the operator's
mail domain). Your app keeps its words and its timing; Ulak owns the transport, the retries and the
record.

**The send key.** Mail takes its own key, `ulak_send_<app>_<48 hex characters>`, issued on the
operator's **Apps** page and kept on your server only. Every mail call that carries an `Origin`
header is refused (`403 server_only`) before the key is read, so a send key never works from a web
page, and the app key in your pages can never send mail.

The operator also records, for your app: the From name, which kinds it sends (`transactional`,
`legal_document`), and the list of your mail labels (one per kind of mail, for example
`confirm_email`, `password_reset`, `order_documents`).

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/mail` | send one mail |
| `GET` | `/v1/mail/status` | whether Ulak can send right now |
| `POST` | `/v1/mail/delete` | delete every record of mail to one address |
| `POST` | `/v1/mail/legal/end` | a subscription ended: its legal documents' keeping period starts |

### `POST /v1/mail`

```json
{
  "to": "person@example.org",
  "locale": "en",
  "kind": "transactional",
  "label": "password_reset",
  "subject": "Reset your password",
  "text": "Open https://app.example.org/reset?t=... to choose a new password. The link works for one hour.",
  "html": "<p><a href=\"https://app.example.org/reset?t=...\">Choose a new password</a></p>",
  "expires_at": "2026-11-01T10:00:00Z",
  "idempotency_key": "reset-7f3c...",
  "user_ref": "0123456789abcdef0123456789abcdef"
}
```

| Field | Rule |
|---|---|
| `to` | one address |
| `locale` | the language the text is in, for example `en`, `tr`, `pt-BR`; recorded, never used to choose words |
| `kind` | `transactional`, or `legal_document` (see Legal documents below) |
| `label` | your name for this mail; must be on your app's list |
| `subject` | one line, at most 500 characters |
| `text` | your finished plain text, at most 100,000 characters; every link absolute `https://` |
| `html` | optional: the same mail as HTML, at most 200,000 characters. Links absolute `https://`; no scripts, forms, images, frames or anything that loads from elsewhere (styles are fine). A guard against mistakes, not a sanitiser: Ulak sends it as given |
| `expires_at` | required, later than now and at most 24 hours ahead. After it, Ulak gives the mail up instead of sending it late. A sign-in link mail: the link's own lifetime or less |
| `idempotency_key` | required, 1 to 128 printable characters; one per action of the person or event of your app. The same key within 7 days returns the first result and sends nothing. Keys are scoped by `kind`: one sale's id can key both its legal document and its receipt |
| `user_ref` | optional, as elsewhere; only used to delete the person's records with your account deletion |

The whole request is at most 512 KiB.

Answers:

| Status | Body | Meaning |
|---|---|---|
| `202` | `{"id":"...","status":"sent"}` | the mail service accepted it |
| `202` | `{"id":"...","status":"queued"}` | Ulak has it and retries every few minutes until `expires_at` |
| `400` | `invalid_request` with `field` | a field is missing or malformed |
| `422` | `unknown_label`, `kind_not_allowed`, `bad_link`, `not_plain_text`, `bad_html` | your app's own mistake: a bug to fix, never shown to the person |
| `422` | `suppressed` | this address does not receive your app's mail (it bounced, the person marked a mail as spam, or the mail service refused it) |
| `429` | `rate_limited`, `Retry-After` | more than 10 mails to this address from your app in the last hour |
| `410` | `mail_expired` | a repeat of a key whose mail reached its `expires_at` unsent: send it by your own path or not at all |
| `500` | `mail_failed` | the mail service refused this mail as malformed (a fault on Ulak's side; the operator is told): send it by your own path |
| `401` | `invalid_send_key` | |
| `403` | `server_only` | the request carried an `Origin` header |
| `500` | `mail_config_half_set` | the operator's mail settings are incomplete |
| `503` | `mail_unconfigured` | this instance does not send mail |

The call waits for the first attempt, at most about 8 seconds. A repeat of an `idempotency_key` gets the same
answer as the mail it names has now: `sent`, `queued`, `422 suppressed`, `410 mail_expired` or `500 mail_failed`.

**Your app's side** (the same for every app):

- Answer the person first; call Ulak after, and cap your wait at 10 seconds.
- Treat `422 suppressed` and `429` exactly as a sent mail on screen. Never reveal, by words or by
  timing, whether an address has an account.
- While your app keeps its own sending path, a failed or timed-out call sends through that path at
  once. A timed-out call may still have been queued by Ulak, so the person may receive the mail
  twice: duplicate over loss, chosen knowingly.
- Send no `Reply-To`: Ulak sets it to your app's own address.
- Your throttles and quiet hours stay in your app; Ulak only adds the per-address ceiling above.

### Legal documents

For the after-sale documents a buyer must receive on a durable medium (the pre-information form,
the contract, the withdrawal notice), filled with the order's facts. Your app sends the filled text
exactly as the buyer accepted it; Ulak keeps no templates and fills, computes or changes nothing.
Ulak keeps an exact copy with its delivery evidence for the keeping period the operator sets, also
after a deletion request, and raises every problem with it to the operator.

The call is `POST /v1/mail` with `"kind": "legal_document"` and one more field:

```json
{
  "to": "buyer@example.org",
  "locale": "tr",
  "kind": "legal_document",
  "label": "order_documents",
  "subject": "Your order ORD-77: contract and pre-information form",
  "text": "...the filled documents, as accepted...",
  "expires_at": "2026-11-01T10:00:00Z",
  "idempotency_key": "<the sale's id from the payment provider>",
  "user_ref": "0123456789abcdef0123456789abcdef",
  "document": { "version": "tos-2026-10", "reference": "ORD-77", "sale": "subscription" }
}
```

| Field | Rule |
|---|---|
| `document.version` | the document version the buyer accepted; `[A-Za-z0-9._:/-]`, 1 to 64 characters |
| `document.reference` | your order number, which the operator searches by; the same characters |
| `document.sale` | `one_off` (the keeping period starts at the sale) or `subscription` (it starts when you report the subscription's end) |
| `text` | plain text only: `html` is refused (`422 bad_html`) |
| `expires_at` | at most 24 hours ahead unless the operator set another window (at most 72) |
| `idempotency_key` | the sale's id. For a legal document it never expires while the copy is kept: a repeat a year later still sends nothing |

No per-address ceiling applies to legal documents, and they do not count toward the transactional one.
The operator ticks *sends legal documents* for your app; until then, and while the operator has not
set the keeping period, the call answers `422 kind_not_allowed`.

**The answer is always `202 {"id":"...","status":"queued"}`**, on the first call and on every repeat
of its key: also for a suppressed address, and also when a send later fails. From that `202` on, the
duty is Ulak's record: every problem after it (a refused or bounced address, no delivery within an
hour, a mail given up at `expires_at`) opens an alert for the operator, who settles it by hand. The
answer comes before the mail is sent, so it is fast; any other answer (`400`, `401`, `403`, `422`,
`500`, `503`, a timeout) means Ulak did not take the duty.

**Your app's side** (the same for every selling app):

- Call inside your handling of the sale event, once you have the figures and the accepted version.
  Cap your wait below the sale sender's own webhook timeout (for a sender that wants an answer in 5
  seconds, about 4). If Ulak has not answered `202` in that time, answer the sale event with an
  error so the sender delivers it again; the `idempotency_key` keeps it to one mail. Do not mark the
  sale processed before Ulak's `202`.
- Inside the sale handler make only this call; send the receipt, the welcome and any other mail after
  answering the sale event.
- **Daily reconciliation:** once a day, read the completed sales for a look-back of the sender's
  re-delivery window plus a day, never less than two days, and call `POST /v1/mail` again for each
  with the same key. An accepted one sends nothing; one your records show was never accepted is sent,
  and you ping the owner that it was missed. A sale with no linked acceptance is never called; list it
  in the owner ping as an alert. If the job has not completed a run in 36 hours, ping the owner.
- **The subscription's end:** call `POST /v1/mail/legal/end` when a subscription ends (and report the
  ends your daily reconciliation finds, so a missed call is made up the next day).

### `POST /v1/mail/legal/end`

```json
{"reference": "ORD-77", "ended_at": "2026-12-01T00:00:00Z"}
```

With the send key, from your server. Sets the keeping period's start of every legal document of
your app with that reference that has none yet, so a subscription's renewals share its end; a repeat
changes nothing. `ended_at` is ISO 8601 and not in the future. Answers `{"updated": n}`. A copy whose
end is never reported is kept, never deleted early; the operator sees such copies after 400 days.

### `GET /v1/mail/status`

`{"sending":"ok"}` or `{"sending":"down"}`. `down` means Ulak's last three calls to the mail service
in the past ten minutes all failed on the service's side; it never depends on any address. Ask it,
if at all, the same way for every address, cap the wait at 2 seconds, and treat no answer as `ok`.

### `POST /v1/mail/delete`

```json
{"address": "person@example.org"}
```

Deletes every record of mail your app sent to that address and answers `{"deleted_mails": n,
"kept_legal_copies": k}`: legal documents are kept by the seller's legal duty, with the `user_ref`
removed, and a legal document still waiting to be sent is still sent. The
address travels in the body, never in the URL, so it reaches no request log. Ulak stores an address
only as a keyed hash that differs per app, so one app's request never touches another app's
records. `DELETE /v1/messages?user_ref=` also deletes the mail records sent with that `user_ref`.

## Images

Only if the operator enabled images for your app. Upload each image first, then list the returned
ids in `attachments`. An image that is not claimed by a submit within 15 minutes is deleted.

```
POST /v1/images
Authorization: Bearer ulak_myapp_…
Content-Type: image/jpeg
X-Ulak-User-Ref: <the same user_ref the submit will carry, or omit for anonymous>
<raw bytes>
```

Returns `201 {"id": "…"}`. Limits: PNG, JPEG or WebP by content; 5 MB; 4096 pixels per side; 3 per
message; 5 uploads per minute per user. Type is detected from the bytes, so a renamed file is
rejected. Images are re-encoded on the server and stripped of all metadata, including location.

A file that cannot be decoded — truncated, or not really the type its bytes claim — comes back
`415 unsupported_media_type` with `retryable: false`. Do not resend it; ask the user for another
file. `503 image_service_unavailable` is the image service failing rather than the file, and is
retryable like any other `5xx`.

## Browser clients and CORS

If your app runs in a browser, the operator must list your page's origin (scheme and host, for
example `https://app.example` and `https://www.app.example`) for your app. Native apps and servers
need nothing.

## Form copy

Say that a reply is not guaranteed, and offer the optional email field for users who want one even
if the app cannot reach them. Ulak sends no email itself; the operator writes back by hand when
only an email exists.

## Minimal example

```js
async function submitSupportMessage(base, key, payload) {
  const res = await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await res.json();
  if (res.ok) return { ok: true, id: body.id };
  const retryable = body.retryable === true;
  return { ok: false, retryable, retryAfterSec: Number(res.headers.get("retry-after") ?? 0), error: body.error, detail: body.detail };
}

async function pollReplies(base, key, userRef, state) {
  const url = new URL(`${base}/v1/messages`);
  url.searchParams.set("user_ref", userRef);
  if (state.cursor) url.searchParams.set("since", state.cursor);
  const res = await fetch(url, { headers: { authorization: `Bearer ${key}`, ...(state.etag ? { "if-none-match": state.etag } : {}) } });
  if (res.status === 304) return [];
  if (!res.ok) return [];
  const body = await res.json();
  state.cursor = body.cursor ?? state.cursor;
  state.etag = res.headers.get("etag");
  return body.messages;
}
```
