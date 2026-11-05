# Completed tasks

## Session 20 — 2026-11-05

Maintenance session. Nothing deployed: phase 0 still waits on the vendor's validation of its account and the three values
through the owner's inbox. The second client answered the deploy letter, so both clients are clear.

- **Mailbox:** four letters read, acted on and archived. The second client's answer: it never reads the deletion answer's
  body, no deploy of its own needed. The operations project's console findings answered from the vendor's help pages: where
  the auto-suppression switch and the content box are, and that the webhook Authentication Key is typed by us on the agent,
  so it comes before the deploy and the webhook itself after it. The owner's ruling on the footer and review line is recorded.
- **Local test standard:** `maxWorkers: 12`, the fastest measured count (32 workers 41.1 s; 12 workers about 28.9 s). The
  pre-push hook now runs the tests a change can affect, red on a planted failure. Six shuffled seeds and a clock moved 500 days
  ahead, proven by a planted date test: no order or date dependence. The 5 s limit tripped two bulk tests under load, so it is
  30 s; tests that measured elapsed time were removed or pinned to a start time.
- **Drift review (`docs/drift-reviews/review-2026-11-05-up-to-19.md`):** one contradiction: the public notes named other
  projects. Owner: "Keep the rule (Recommended)". Names removed from the notes, an automatic check added holding them only as
  hashes; Git history left as it is. Note cleanup, owner: "Remove all shown (Recommended)".
- **Rules as tests:** six new source scans, each red on a planted violation. New and red on the real code: an unknown route on
  the API and image Workers, and the image Worker's refusals, answered plain text; both now answer the error shape
  (`test/errorshape.test.ts`). The sort-key rule corrected to match the spec; owner: "Yes, keep the fix (Recommended)".
- **Refactor round 1, the legal-documents module:** closed. Two missing tests added (a later delivered event keeps the first
  delivered time; old held copies never crowd out a new alert), both red on their breaks; 13 unused exports dropped.
- **Feature review:** one finding, a missing test: a late delivered event never lifts a bounce or complaint suppression. Fixed, red
  on its break.
- **Webhook address check:** the console's Verify needs a 200, and its help does not say how it asks. A GET and an empty unsigned
  POST now get one and change nothing; any other unsigned request is still refused. The real request is to be read at Verify.
- **Deployed, owner: "yeah, deploy":** the API, admin and image Workers, migrations 0005-0007 and the six mail settings. Read back: empty POST to
  the events route 200, unsigned body 401, unknown routes in the error shape, a client poll 200, the result check ok. Legal documents stay refused and
  client apps have no mail. Live acceptance not yet run: it needs the webhook.
- **Result:** `npm test` 521 of 521, typecheck clean, gitleaks clean.
- **Two later letters from the operations project, read at 23:06:** no validation answer found; the console steps are on the
  owner's list in the order Ulak gave. A new reading of a company standard on speed and crash reports: nothing to build, since a
  search of `src/`, `package.json` and the privacy statement found no such reports.
- **The owner's question on the vendor's mail of 2026-10-31:** the record that nothing can be sent before the account review
  was wrong. The mail gives a free credit and a daily limit until then, so the review holds volume and buying credits, not the
  deploy or the live checks. Recommended to the owner: deploy inside the limit with client apps off for mail; not deployed, his word
  awaited. Ulak made the webhook key (kept in `.secrets\`, never printed) and gave him the console steps one by one.
- **What the console itself showed (the owner's screenshots):** the bounce list and content box are set. The Add webhook box's preview sends
  `event_name` as a list, which the parser dropped; now read, test red first. The Delivered and Hard bounces previews show `event_data`'s
  object also names the event, which the parser already read, so these previews would have parsed before the fix. The box says POST
  only, so the GET answer added earlier is removed. The empty Webhooks tab has no Authentication Key button, so the key goes on the agent
  after the webhook is added, and `docs/self-hosting.md` says so. The preview's delivered event is pinned by a test; it names no
  receiving server, so that field of a legal copy's evidence may stay empty until a real event shows otherwise.

## Earlier months

- [2026-10](completed_tasks/2026-10.md)
- [2026-09](completed_tasks/2026-09.md)
