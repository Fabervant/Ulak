# Ulak memory

## Focus
Built through Task 15 of `docs/superpowers/plans/2026-09-05-ulak.md`; pushed, CI green. Next: deploy
the operator's instance (Task 16), run its live verification list, then set the Cloudflare billing
profile to the company.

## To do
- Task 16, deploy. Blocked on the operator: confirm R2 is activated on the account; provide the
  Google OAuth client id and secret and the sign-in email for the bootstrap list; say "go" for the
  database, bucket, DNS records and the three Worker deploys. The Telegram bot exists and its token
  and chat id are ready to store as Wrangler secrets.
- After deploy: run the eight-step live verification in Task 16 and record the results here and in
  `completed_tasks.md`, without hostnames.
- After deploy: add the bucket size to the result check output so storage growth is visible.

## Session index
- [S1, 2026-09-05, ~3.7h] Spec, plan, full build, docs, CI. Commits ff0b75a..f2599cc.

## Blockers
See To do.

## Open decisions
None.
