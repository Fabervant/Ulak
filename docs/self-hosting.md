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
