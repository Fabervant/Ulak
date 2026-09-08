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
account-deletion flow. Returns `{"deleted_messages": n}`.

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
