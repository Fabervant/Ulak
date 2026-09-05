# Ulak

Ulak (Turkish for *courier*) is a small, self-hostable support-message service for the apps you
build. A user taps "contact support", writes a message (or the app sends a crash report on the
user's behalf), and sends it. Ulak saves the message durably first, then pings you on Telegram.
You read, classify and reply from one admin surface that shows every app, and the reply travels
back to the user inside the app that sent it. An assistant such as Claude Code can read messages
and draft replies through a token-protected API.

One shared service, not a bot per app. Its point is a single place that can answer "has anyone
written to me today" across everything you run.

**What it is not:** a ticketing product. No assignment, SLAs, analytics, end-user accounts, file
attachments other than images, or captcha. It stores nothing about a user beyond what the sending
app already holds, plus an email the user may volunteer.

## How it works

```
your app  --POST /v1/messages-->  Ulak API  --write-->  D1 database
                                     |
                                     +--after the write-->  Telegram ping to you
you  --admin surface-->  read, set status, reply  --row-->  D1
your app  --GET /v1/messages?user_ref=...-->  status and replies, rendered in your app's own UI
```

Replies reach the user by polling, which works even for anonymous users the app has no other way
to contact. The app carries an opaque `user_ref`; Ulak never learns who the person is.

## Self-hosting

Ulak runs on Cloudflare Workers, D1 and R2, all within a free Cloudflare account, as three small
Workers on three origins (API, admin, images). The full runbook is `docs/self-hosting.md`. In
short:

1. `npm install && npm test`
2. `npx wrangler d1 create ulak` and `npx wrangler r2 bucket create ulak-images`
3. Copy the three `wrangler.*.jsonc.example` files and fill in the `REPLACE_ME` values
4. `npm run migrate:remote`
5. Create a Telegram bot and a Google OAuth client, then `wrangler secret put` the secrets
6. `npm run deploy:api && npm run deploy:admin && npm run deploy:images`
7. Sign in to the admin surface, create your first app, copy its key into the app

## Integrating an app

The contract is `docs/client-contract.md`. The minimal call:

```js
await fetch(`${ULAK_API}/v1/messages`, {
  method: "POST",
  headers: { authorization: `Bearer ${APP_KEY}`, "content-type": "application/json" },
  body: JSON.stringify({
    app: "myapp",
    app_version: "2.3.1",
    platform: "android",
    user_ref: stableOpaqueUserRef,        // HMAC of the account id, or a random per-install token
    message: text,
    client_msg_id: crypto.randomUUID(),   // generated once, reused on every retry
    locale: "tr-TR",
    context: { screen: "orders" },
  }),
});
```

and the poll for replies:

```js
const res = await fetch(`${ULAK_API}/v1/messages?user_ref=${ref}&since=${cursor}`, {
  headers: { authorization: `Bearer ${APP_KEY}`, "if-none-match": etag },
});
// 304: nothing new. 200: { messages: [{ status, status_label, replies: [...] }], cursor }
```

Submit is idempotent on `client_msg_id`, so an offline queue can retry safely. The contract says
exactly which responses a queue may retry and which it must surface to the user.

## Notifications and the result check

The message is written and acknowledged before any notification is attempted, so a Telegram
outage cannot lose a message or make a user resend. The attempt is recorded on the message row,
retried hourly up to five times, and `GET /api/checks` on the admin API answers `503` whenever a
message has gone ten minutes without a notification, a row has outlived its retention, or an
uploaded image is orphaned. Point any uptime monitor at it. That check is the difference between
"nobody wrote today" and "the notifier has been silently failing for a week".

## Security model

- The per-app key ships inside public clients and is **not** authentication. It identifies the
  tenant and gives the rate limiter something to key on. Keep it server-side if the app has a server.
- A user's thread is protected only by the secrecy of `user_ref`, which is why the contract
  requires it to be opaque and high-entropy and never a raw id.
- The public API, the admin surface and the image server are three separate origins.
- Images are detected by content, re-encoded server-side (which strips metadata such as GPS),
  served only through signed ten-minute links, always as downloads, with a `default-src 'none'`
  policy. SVG and every non-image file are rejected.
- Admin sign-in is Google OpenID Connect bound to the account's permanent id, not its email.
  Sessions are signed cookies, forms carry CSRF tokens, the surface ships no JavaScript, and
  everything a message contains is rendered as text.
- Rate limits are per `user_ref` first and per address only as a backstop. `X-Forwarded-For` is
  ignored unless explicitly trusted. No captcha, anywhere.

## Assistant access

`mcp/` contains a Model Context Protocol server that wraps the admin API. Point Claude Code (or any
MCP client) at it with an admin token and it can list and read messages, and, after your approval
on each call, post a reply or set a status. Reply drafting happens in the assistant with your app's
code in view, in the message's language. Ulak itself calls no AI provider. See `mcp/README.md`.

## Privacy

Retention defaults to 90 days from a message's last activity and is configurable per app; expiry
is enforced by an hourly job. Users can be deleted per `user_ref` from the app's account-deletion
path or from the admin surface. The data controller's name is configuration.
`docs/privacy-statement.md` is a template to publish.

## Development

```sh
npm test            # vitest on the Workers runtime, verbose
npm run typecheck
npm run hygiene     # regenerates the manifest the repository-hygiene test scans
npm run scan        # gitleaks over the whole history (also runs as a pre-push hook)
```

The repository is public. Nothing deployment-specific is committed: configs are `.example` files
with placeholders, secrets live in Wrangler. A test scans every committed file for token shapes and
addresses; names of an operator's other projects are a human check in review.

## License

MIT. See `LICENSE`. This software is provided as is, without warranty or support. Issues and pull
requests are welcome, but there is no response-time promise.
