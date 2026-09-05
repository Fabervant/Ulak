# Ulak

Self-hostable support-message service: apps POST messages, the operator is pinged on Telegram,
replies travel back by polling. Spec: `docs/spec.md`. Plan: `docs/superpowers/plans/`.

## Stack
TypeScript on Cloudflare Workers. Three Workers (`src/api`, `src/admin`, `src/images`) over one
D1 database and one R2 bucket. Domain logic in `src/core` has no HTTP dependency. Hono for
routing, `jose` for OpenID Connect, Vitest with the Cloudflare Workers plugin for tests.

## Conventions
- `npm test` runs `vitest run --reporter verbose`; never a quiet reporter.
- Every error response is `{ error, retryable, detail }`.
- `received_at` is the only sort key; `last_activity_at` is the only retention clock.
- Message content is rendered as text, never as markup.
- Deployment values live in gitignored `wrangler.*.jsonc` and Wrangler secrets; commit only the
  `.example` files with `REPLACE_ME` placeholders.
- This repository is public. Its notes files describe Ulak and nothing else: no hostnames,
  tokens, ids, or names of the operator's other projects.

## Decisions
- No non-image attachments, no captcha, no end-user accounts, no AI provider inside Ulak.
