# Self-hosting Ulak

Ulak runs on Cloudflare Workers with a D1 database and an R2 bucket. Everything below fits in a
free Cloudflare account; no card is needed. Expect about an hour the first time.

You will end up with three Workers on three origins:

| Worker | Config | Purpose |
|---|---|---|
| `ulak-api` | `wrangler.api.jsonc` | the public endpoint your apps call, plus the hourly job |
| `ulak-admin` | `wrangler.admin.jsonc` | your sign-in-protected admin surface and the admin API |
| `ulak-images` | `wrangler.images.jsonc` | serves attachments through short-lived signed links |

They must be on different origins. Either use three `workers.dev` subdomains (free, no domain
needed) or three hostnames on a domain you keep in Cloudflare.

If you use your own domain, keep the three names **one level below the apex** - `ulak`,
`ulak-admin`, `ulak-images` under `example.com`, not `api.ulak.example.com`. Cloudflare's free
Universal SSL certificate covers the apex and one level of subdomain only, and a Workers custom
domain does **not** issue its own certificate to fill the gap: a two-level name resolves, serves
no certificate, and every HTTPS request to it fails the TLS handshake. Two levels need Advanced
Certificate Manager, which is a paid add-on.

## 1. Prerequisites

- Node.js 22 or newer.
- A Cloudflare account. Run `npx wrangler login` once.
- A Telegram account (for the bot) and a Google account (for admin sign-in).

## 2. Clone and install

```sh
git clone https://github.com/Fabervant/Ulak.git
cd Ulak
npm install
npm test
```

`npm test` runs the whole suite locally in a simulated Workers runtime; it should be green before
you touch anything else.

## 3. Create the database and the bucket

```sh
npx wrangler d1 create ulak
npx wrangler r2 bucket create ulak-images
```

The first command prints a `database_id`. Keep it for the next step.

## 4. Fill in the three configs

```sh
cp wrangler.api.jsonc.example wrangler.api.jsonc
cp wrangler.admin.jsonc.example wrangler.admin.jsonc
cp wrangler.images.jsonc.example wrangler.images.jsonc
```

The copies are gitignored. In each, replace every `REPLACE_ME`:

- `database_id`: from step 3, the same in all three.
- `routes`: your three hostnames. If you would rather use `workers.dev`, delete the `routes` line
  and Wrangler assigns `<worker name>.<your subdomain>.workers.dev`.
- `ADMIN_URL` and `IMAGES_URL`: the full `https://` origins of the admin and image Workers. The API
  Worker needs both, the admin Worker needs both, the image Worker needs neither.
- `CONTROLLER_NAME`: the legal name of whoever is responsible for the data (you, or your company).
- `ADMIN_BOOTSTRAP_EMAILS`: comma-separated Google account emails allowed to become admins on
  their first sign-in.
- `GOOGLE_CLIENT_ID`: from step 6.

The rate-limit bindings in `wrangler.api.jsonc` are declared under `unsafe.bindings`, which is
where Wrangler expected them when this was written. If `wrangler deploy` complains, check the
current syntax at https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/ and
move them to the key it now expects. The four bindings and their limits stay the same.

## 5. Apply the schema

```sh
npm run migrate:remote
```

## 6. Create the two external credentials

**Telegram bot.** In Telegram, message `@BotFather`, send `/newbot`, follow the prompts, and copy
the token it gives you. Then open a chat with your new bot and send it any message. Now visit
`https://api.telegram.org/bot<token>/getUpdates` in a browser and read the `chat.id` number from
the response. That is your chat id. Sending to a group works the same way after you add the bot to
the group.

**Google OAuth client.** In Google Cloud Console, create a project (or use one), open
*APIs & Services, Credentials*, create an *OAuth client ID* of type *Web application*, and add
`https://<your admin host>/auth/callback` as an authorised redirect URI. Copy the client id into
`wrangler.admin.jsonc` and keep the client secret for the next step. If the consent screen is in
testing mode, add your own Google account as a test user.

## 7. Set the secrets

Secrets are stored by Cloudflare, never in files. `IMAGE_URL_SECRET` and `SESSION_SECRET` are
random strings you generate; the same `IMAGE_URL_SECRET` goes to all three Workers.

```sh
openssl rand -hex 32      # run twice: one for IMAGE_URL_SECRET, one for SESSION_SECRET

npx wrangler secret put TELEGRAM_BOT_TOKEN -c wrangler.api.jsonc
npx wrangler secret put TELEGRAM_CHAT_ID   -c wrangler.api.jsonc
npx wrangler secret put IMAGE_URL_SECRET   -c wrangler.api.jsonc

npx wrangler secret put GOOGLE_CLIENT_SECRET -c wrangler.admin.jsonc
npx wrangler secret put SESSION_SECRET       -c wrangler.admin.jsonc
npx wrangler secret put IMAGE_URL_SECRET     -c wrangler.admin.jsonc

npx wrangler secret put IMAGE_URL_SECRET -c wrangler.images.jsonc
```

## 8. Deploy

```sh
npm run deploy:api
npm run deploy:admin
npm run deploy:images
```

If you use custom hostnames, Wrangler creates the DNS records for you when the domain is in the
same Cloudflare account.

## 9. First sign-in and first app

Open your admin origin. You are redirected to Google; sign in with an email listed in
`ADMIN_BOOTSTRAP_EMAILS`. Ulak pins your Google account's permanent id as an admin; from then on
the email is not consulted, so renaming the account cannot lock you out.

Open **Apps**, create an app, and copy its key. The key is shown once. Give it to the app's
developer with the API origin and `docs/client-contract.md`.

Alternatively, from the command line: `npm run add-app -- myapp --remote`.

## 10. Verify with real traffic

Send one message with `curl` using the key:

```sh
curl -i -X POST https://<api host>/v1/messages \
  -H "Authorization: Bearer ulak_myapp_..." -H "Content-Type: application/json" \
  -d '{"app":"myapp","app_version":"0.1","platform":"web","user_ref":"0123456789abcdef0123456789abcdef","message":"merhaba dünya ışğİ","client_msg_id":"9b2c1a0e-3f4d-4e5f-8a9b-0c1d2e3f4a5b","locale":"tr"}'
```

Expect `201`, a Telegram ping with the Turkish characters intact, and the message on the admin
surface. Reply to it there, then poll:

```sh
curl -i "https://<api host>/v1/messages?user_ref=0123456789abcdef0123456789abcdef" -H "Authorization: Bearer ulak_myapp_..."
```

## 11. Point a monitor at the result check

Create an admin token on the **Tokens** page and give any free uptime monitor this request:

```
GET https://<admin host>/api/checks
Authorization: Bearer ulak_admin_...
```

It answers `200` when every message was notified within ten minutes, nothing is past its retention,
and no uploaded image is orphaned. It answers `503` with the counts otherwise. This is the one check
that tells you the notifier is silently failing while you believe nobody wrote.

## Outbound mail (optional)

Ulak can send your apps' transactional mail through a transactional mail service. The code speaks
one vendor's API: an agent key in the `Authorization` header, one JSON call per mail, and signed
webhooks for delivery, bounce and spam-complaint reports. Mail needs five settings, **all or none**:

| Name | Where | Value |
|---|---|---|
| `MAIL_API_URL` | `vars` in `wrangler.api.jsonc` | the vendor's send endpoint for your account's data centre |
| `MAIL_FROM_DOMAIN` | `vars` | the domain your apps send from; each app sends as `<app id>@` it |
| `MAIL_API_KEY` | secret | the agent's send key |
| `MAIL_WEBHOOK_KEY` | secret | the agent's webhook Authentication Key |
| `MAIL_HASH_SECRET` | secret | 32 random bytes, for example `openssl rand -hex 32`; keys the per-app address hashes. Never change it once mail has been sent: suppressions and deletion by address match on it |

`npm run deploy:api` refuses to deploy while some but not all five are set. If one goes missing
later, the mail calls answer `500 mail_config_half_set` and the result check goes red within five
minutes; support messages keep working.

In the vendor's console, for the agent Ulak sends with:

1. Verify the sending domain (its SPF and DKIM records) and set DMARC for it.
2. Turn **open tracking and click tracking off**. Ulak sends `track_opens: false` and
   `track_clicks: false` on every mail as well.
3. Turn **auto-suppression** on for hard bounces, for this agent, and **content storage off**, so the
   vendor's 60-day delivery log holds no mail text (the privacy statement says it does not).
4. Add a webhook: URL `https://<api host>/v1/mail/events`; events soft bounce, hard bounce, delivered
   and feedback loop (spam complaints); open and click off. Set the agent's **Authentication Key**
   and put the same value in `MAIL_WEBHOOK_KEY`. Requests without a valid signature less than five
   minutes old are refused. The vendor signs the event, not its timestamp, so the window cannot stop a
   replay of a captured event; every event is safe to apply twice.
5. Send the console's test hard bounce and check that `/v1/mail/events` answered `200`.

Then, per app, on **Apps**: the From name, the *sends transactional mail* tick, the app's labels,
and *New send key*, which you hand to the app's server once.

The second cron (`*/5 * * * *`) retries queued mails until each one's `expires_at`; a mail it gives
up is reported once on Telegram, without its address or content. **Outbox** in the admin panel lists
queued, failed, given-up, refused, bounced and complained mails with their reason; it never shows an
address, a subject or a body.

What Ulak keeps of a mail: the app, kind, label, language, a keyed hash of the address, the times,
the result and the vendor's id. The address and the content are deleted the moment the vendor
accepts the mail or Ulak gives it up. A hard bounce or a spam complaint makes later mail from that
app to that address answer `422 suppressed`, until the records go by deletion or retention.

## What happens when Telegram is down

The message is stored and the app gets `201` regardless. The row records the failure. The hourly
job retries up to five times. `GET /api/checks` goes red after ten minutes. Nothing is lost; you are
told.

## Rotation and revocation

- App key: **Apps**, *Rotate key*. The old key stops working immediately; update the app.
- Admin token: **Tokens**, *Revoke*.
- Google account change: the pinned id survives an email rename. To transfer admin to a different
  Google account, delete the row from the `admins` table with `wrangler d1 execute` and sign in
  with the new account (its email must be in `ADMIN_BOOTSTRAP_EMAILS`).
- Secrets: `wrangler secret put` again with a new value and redeploy.

## Updating

```sh
git pull
npm install
npm test
npm run migrate:remote
npm run deploy:api && npm run deploy:admin && npm run deploy:images
```

## Privacy statement

`docs/privacy-statement.md` is a template. Fill in the placeholders and publish it wherever your
apps' privacy policies live. Each consuming app should name your Ulak instance as a recipient of
support messages and state the retention period you configured.

`{{STORAGE_REGION}}` is where your database and bucket run: read `running_in_region` from
`wrangler d1 info <database>` and `location` from `wrangler r2 bucket info <bucket>`, and name the
region in words (for example `WEUR` is Western Europe). `{{CONTROLLER_COUNTRY}}` is the country the
controller is in.

Owner notices (`POST /v1/notify`) reach the operator on the same Telegram chat. Apps must not put
end-user data in operator notices.
