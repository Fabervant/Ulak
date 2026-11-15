# Phase 2: Inbound mail and withdrawal clocks - Implementation Plan

**Goal:** Build phase 2 of the approved communication spec (`docs/specs/2026-10-24-communication-service.md`,
sections 7.1-7.3, 8, 9, 10 and 11.1): replies to the apps' mails come back into Ulak, the selling apps' mailboxes are
forwarded to Ulak behind a vendor filter (decision 5), every inbound message gets its arrival time, and the operator
can mark a message as a withdrawal, which opens a 14-day refund clock that pings the owner until it is done.

**Started:** agent recommendation, approved S22 ("Write the plan now (Recommended)"). Nothing in
this plan is built before the owner approves it.
**Approved, built ahead, deployed after the gates:** agent recommendation, approved S23 ("Approve, build now (Recommended)")
(agent recommendation, approved S23).

**Goes live only after:** operations closes legal read 10 for each app whose channel opens (per app: its replies and
its forwarded mailbox, including whether any of it can be seen by another person) and the AI-assistant row of read 1
(the operator drafts replies with an assistant that has no known processing contract); the inbound subdomain's DNS
(operations, with the owner's go); the owner's word on the deploy. Each app's channel opens on its own, after its own
read 10: the per-app switches below stay off until then.

**Legal reads answered by operations (2026-11-10, a legal reading, not advice):**
- Read 7: the refund is due within 14 days of the notice **reaching the seller** (Distance Contracts Regulation art
  12(3)); keep the notice as received and its arrival time for the legal period (art 20(1); the longer TTK art 82
  period governs: the end of the arrival's calendar year plus 10 years). Whether a product is exempt from withdrawal is
  the app's read, not Ulak's: Ulak records whatever arrives.
- Read 9: where an app offers a form as a way to withdraw, a confirmation of receipt goes to the buyer at once on a
  durable medium (mail); for a reply by mail it is not required, but operations wants it sent anyway. One text per
  app, in its languages, read by operations before it ships.
- Read 11: e-mail is a durable medium (art 4(1)(c)); nothing here changes phase 1.
- The mailbox check (decision 5's condition): the app mailboxes also receive vendor, store, CI and test-purchase mail,
  so forwarding needs a filter first: a **deny list** of vendor sender domains (missing a withdrawal costs a 14-day
  legal clock; letting one vendor mail through costs nothing). Where the filter lives is Ulak's design: see below.

**Not in phase 2:** quoted-text stripping (O6) and withdrawal-word flagging (O8) (decision 8: none of the options);
the KEP mailbox (stays a manual read; the operator opens a clock by hand); a withdrawal through the payment provider's
own buyer portal (stays with the app); delivering inbound mail to the company's agents (the owner's parked idea: the
design keeps a second destination addable, and every inbound mail is data, never instructions).

## What earlier phases already give

- Support messages with images, the text-free Telegram ping and its retries (`notifyMessage`), the admin message list,
  the operator's answer stored in `replies` and read by the app's poll.
- The outbox (`mails`), its retries, the vendor call, Ulak's own suppression, deletion by address and by `user_ref`,
  the per-app keyed address hash.
- Phase 1's kept copies and owner alerts that stay open until closed by hand, and the hourly job that deletes copies
  past their keeping period.
- Every outbound mail carries `Reply-To` = the app's own address (`vendorBody`).

## Design decisions (mine; each open to the owner)

1. **The vendor filter lives in Ulak, which drops a denied sender on arrival** (operations offered both places). One
   list, in one place, tested, with a count the operator can see; no mail-provider rule to keep in step and no owner
   step at the mail provider beyond turning the forward on. The original stays in the app mailbox (the forward keeps a
   copy: checked in task 1), so a dropped mail is never lost. The list is a table edited in the admin panel, not a
   setting, so changing it needs no deploy; the repository is public and names no vendor, so the list is never
   committed. A domain matches itself and its subdomains (`example.com` covers `mail.example.com`), never a longer
   name (`example.com` does not cover `myexample.com`). The filter applies to forwarded
   mailbox copies only: a reply carries a token Ulak signed, so it answers a mail Ulak sent.
2. **Dropped mail leaves a count, not a copy:** per app, per day, per denied domain; no address, subject or text.
3. **A receipt confirmation goes to every inbound mail** (a reply or a forwarded copy) and to every support-form
   message that carries a contact address, once the app's text is set: Ulak cannot know a message is a withdrawal
   until the operator reads it, and read 9 asks for "at once". It never goes to an automatic mail (`Auto-Submitted`,
   `Precedence: bulk/list/junk`, a mailer-daemon or no-reply sender), never to a mail whose sender fails its own
   domain's check (no backscatter to forged senders), and at most once a day per address per app. **The daily cap
   never holds back a withdrawal's confirmation** (operations, 2026-11-15, read 9: art 11(2) asks for it "at once" for
   every withdrawal through a route the app offers): a form message the app sends with `purpose: "withdrawal"` (its
   withdrawal form; a new optional field of the submit call) always gets it, and marking a message as a withdrawal
   sends it if none went for that message. A form message has no domain check: the typed contact address gets it.
   Without its text the app sends none and the admin panel says so. (Operations agreed decisions 1 and 2, 2026-11-15.)
4. **A reply is shown in the person's own thread only when** its token is valid, the hash of its From address equals
   the original recipient's hash, the sender's domain check passes, and the original mail carried a `user_ref`.
   Anything else is for the operator only. (The spec's address check, plus the domain check, because a From header
   alone can be forged.)
5. **The operator answers a mail-borne message by mail:** the answer is stored in `replies` as today (so a thread the
   person sees shows it) and also queued in the outbox as a `transactional` mail from the app's address, label
   `support_reply`, with a fresh reply token, so the conversation can go on.

## Architecture

A fourth Worker, `src/inbound`, has only the platform's mail handler: it reads the raw mail, hands it to
`src/core/inbound`, and rejects a mail to an unknown address. All logic is in `src/core/inbound` (no HTTP). The
platform's mail routing sends every address of the inbound subdomain to it; the root domain's mail is never touched.

### Addresses on the inbound subdomain

- `r.<app>.<mail id>.<sig>@` - a reply. `<sig>` is an HMAC of `app` and the mail id under a new secret
  `REPLY_TOKEN_SECRET`, lower-case base32, 16 bytes. The app is in the address, so a reply to a mail whose row has
  expired is still filed under its app (unlinked). Local part under 64 characters for every app id in use (checked
  in a test).
- `f.<app>.<secret>@` - a forwarded mailbox. `<secret>` is a per-app random value issued in the admin panel (like the
  send key; only its hash is kept), so a stranger cannot file mail as a forwarded copy by guessing the address.
- Anything else: rejected at the door.

`vendorBody` sets `Reply-To` to the reply address when the app's `inbound_replies` switch is on; otherwise the app's
own address, as today.

### Migration `0009_inbound.sql`

```
apps + inbound_replies INTEGER NOT NULL DEFAULT 0     -- Reply-To goes to Ulak; on only after read 10 for this app
apps + forward_secret_hash TEXT                       -- the forwarded mailbox address's secret; null = no forward
apps + receipt_texts TEXT NOT NULL DEFAULT '{}'       -- {locale: {subject, text}}, read by operations first

messages + source TEXT NOT NULL DEFAULT 'form'        -- form | reply | forward
messages + origin_mail_id TEXT                        -- the mail a reply answers
messages + thread_visible INTEGER NOT NULL DEFAULT 1  -- 0: operator only (decision 4)
messages + arrived_at TEXT                            -- when it reached us (7.3): a forward's original receipt time
messages + arrived_from TEXT                          -- received_header | forward_time | ulak
messages + contact_hash TEXT                          -- the sender's keyed hash, for deletion by address
messages + mail_message_id TEXT                       -- the mail's Message-ID hash; one filing per mail (re-delivery)

inbound_denied_domains (domain TEXT PRIMARY KEY, added_at TEXT NOT NULL)
inbound_dropped (app TEXT, day TEXT, domain TEXT, n INTEGER, PRIMARY KEY (app, day, domain))

withdrawals                       -- a marked notice or a clock opened by hand; outlives the message
id TEXT PRIMARY KEY, app TEXT NOT NULL
message_id TEXT                   -- no foreign key: the record outlives the message's retention
arrived_at TEXT NOT NULL, arrived_source TEXT NOT NULL   -- message | kep | letter | call | other
notice_text TEXT, notice_from TEXT, notice_sha256 TEXT   -- the notice as received (null for a call)
due_at TEXT NOT NULL              -- arrived_at + 14 days
marked_at TEXT NOT NULL, marked_by TEXT NOT NULL
done_at TEXT, done_note TEXT
told_marked_at TEXT, told_3days_at TEXT, told_due_at TEXT
addr_hash TEXT, user_ref TEXT     -- for finding; user_ref nulled by a deletion request
```

`received_at` stays the sort key of every list; `arrived_at` is only the clock's start. Retention of inbound messages
is `last_activity_at` as for every message.

### Arrival time (7.3)

For a reply: the time the platform hands the mail to the Worker. For a forwarded copy: the time the app mailbox
received the original, read from the `Received` header its provider added (the provider's host suffix is a setting,
`INBOUND_RECEIVER_HOSTS`, never committed). If that header is missing or unreadable, the forward time, marked
`forward_time`, shown to the operator beside the clock, and the owner told once: the clock then starts later than the
law counts it. Task 1 checks on a real forwarded mail that the header survives.

### Filing one inbound mail

1. Parse the raw mail (a small MIME parser, a new dependency checked in task 1): From, Message-ID, `Auto-Submitted`,
   `Precedence`, `Received`, the platform's authentication results, text (or the HTML part turned into text; never
   kept as markup), image attachments.
2. A forwarded copy whose From domain is denied: count it, drop it, stop.
3. Same app and Message-ID already filed: stop (the platform may deliver twice).
4. Write the message (`platform: mail`, `app_version: -`, `contact_email` = the sender, `contact_hash`), its images
   under the support rules (images on for the app, up to 3, type sniffed, metadata stripped), any other attachment
   dropped and named to the operator by type and size only.
5. Ping the operator as for any message. Over 30 inbound mails an hour for one app, the pings for that app are
   folded into one per hour (a spam burst must not drown the withdrawal that matters); every mail is still filed.
6. Send the receipt confirmation (decision 3) through the outbox.

### Withdrawal clocks (7.3)

- The operator marks an inbound or form message **withdrawal** in the admin panel; the clock starts from its
  `arrived_at` (or `received_at` for a form message), never from the mark. Or opens one by hand with an arrival time
  and a source (KEP, a letter, a call).
- The owner is pinged at the mark with the due date, 3 days before, on the day, and every day after until the
  operator marks it done with a note. These are owner notices, as phase 1's alerts are.
- The record keeps the notice as received and its hash, and outlives the message's retention and every deletion
  request, until the end of the arrival's calendar year plus 10 years (the same rule as the legal copies; that rule is
  built first, as its own change, so both use one function).
- Admin panel: open clocks with due dates first, then done ones; mark done with a note.

### Deletion and retention (8)

- Delete by `user_ref` and by address also remove inbound messages (by `user_ref`, and by `contact_hash`), their
  images and replies; a withdrawal record stays until its period ends, with its `user_ref` nulled.
- The hourly job deletes withdrawal records past their period and `inbound_dropped` rows older than 90 days.

## Tasks

Each task: a failing test first, then the code, then `npm test`; one commit each.

1. **Checks before code (read only, no code):** the MIME parser runs in Workers and its size; from operations: the
   provider's forward keeps a copy in the mailbox, keeps the original From, and keeps the `Received` chain (operations
   tests one forward). Any "no" comes back to the owner before task 2. Answered by operations 2026-11-15: the company
   domain's zone is on the platform, so its mail routing can serve a subdomain (operations turns it on when sent the
   exact records); one app sells today, a second will later; each gets its forward after its own read 10.
   **Findings on Ulak's side (Session 24, 2026-11-15): yes, with one note.**
   - Parser: `postal-mime` 4.2.0 (pin it; 4.2.1 was under two weeks old at the check). MIT-0, no dependencies of its
     own, one maintainer, 14 releases between 7 Oct and 10 Nov 2026 (kept up). Bundled and minified with a minimal
     mail handler: 91 KB, 29 KB gzipped, far inside a Worker's size limit. It has its own limits (nesting, header
     bytes, part count, nested messages), so a hostile mail cannot make it run away.
   - Runs in the Workers runtime: a throwaway test in the Vitest Workers pool (removed after) parsed two real raw
     mails from a public mailing-list archive: a signed multipart mail (From, Message-ID, Date, 1,147 characters of
     text, the signature as a non-image attachment with its type and size, both `Received` headers, the
     authentication results, `Precedence`) and an Outlook mail (3 `Received`); and a Turkish encoded From name and
     Subject decoded right. Task 4 commits the signed mail as its fixture (public archive, no private person's data).
   - Note for task 4: a mail with only an HTML part gets no `text` from the parser (it converts HTML to text only
     inside a mixed message, and does not export its converter), so `src/core/inbound` turns the HTML part into
     text itself; its output is still only ever shown as text.
   - Waiting: operations' forward test (copy kept, original From kept, `Received` kept) ; task 2 waits for it, and a
     "no" there goes to the owner first. The test needs the owner to set a test filter in the mail provider
     (operations, S325).
   - Operations' reading of the mail provider's help pages (S325, to be confirmed by the test), which task 3 settles
     before it starts: a per-address forward is a filter matching To or Cc, so a mail that reached the app address
     by Bcc is not forwarded; the destination must first accept a verification mail from the provider, whose domain
     the deny list drops, so that one mail needs a way to reach the operator; the provider allows only a few forward
     addresses per account, so **one inbound address for every app, with the app read from the original To header**,
     may replace one address per app.
2. Migration `0009_inbound.sql` and the row types.
3. Reply and forward addresses: build, sign, verify; `vendorBody`'s `Reply-To` by the app's switch.
4. MIME parsing to the filing input: sender, text, images, automatic-mail and domain-check flags, arrival time.
5. Filing: deny list, dedupe, message and images, thread visibility, ping folding.
6. The inbound Worker, `wrangler.inbound.example.jsonc`, and its entry in `docs/self-hosting.md`.
7. The operator's answer by mail (decision 5).
8. The receipt confirmation (decision 3), the submit call's optional `purpose: "withdrawal"` (the client contract
   gains it; clients told before it ships), and the per-app texts in the admin Apps form.
9. Withdrawal clocks: mark, open by hand, pings, done, keeping.
10. Deletion and retention for inbound messages and withdrawal records.
11. Admin panel: the deny list and the dropped counts, per-app switches and the forward secret, the source and
    "operator only" on each message, the withdrawal page.
12. Docs: the spec's 7.1-7.3 brought to what was built; the privacy-statement template extended to inbound replies,
    forwarded copies and withdrawal records (operations reads it in every locale); the client contract (apps set no
    `Reply-To`; the receipt text per app).
13. Independent review of the whole phase (a fresh reviewer, given the code, not my conclusions), then fixes.

**Size:** about 14 files / 1,500 lines with tests (the spec estimated 11 / 1,100; the filter, the receipt
confirmation and the forward secret are the difference). One new dependency (the MIME parser), one new secret, one
new Worker, one migration. Running cost: none (the platform's mail routing is free; receipt mails count against the
mail vendor's credit).

## Acceptance, in the live system, after the gates

- A reply from an ordinary mailbox to a real Ulak mail is filed under its app, shown in the person's thread, pinged,
  answered by mail from the admin panel, and the answer arrives with a working reply address.
- A reply from a real hidden Apple address reaches the Worker (the spec's open point: Apple's documentation is silent).
- A forwarded copy from an app mailbox is filed with its original receipt time; a mail from a denied domain is dropped
  and counted, and its original is still in the mailbox.
- A receipt confirmation arrives once, and none is sent to an automatic mail.
- A withdrawal marked on a test message pings the owner with the right due date.
- Every test message, clock and count is deleted afterwards.

## What goes to operations with this plan (one letter, after the owner's approval)

- Decision 1 (the filter lives in Ulak; the owner's only step at the mail provider is turning each selling app's
  forward on, which goes to him through operations when that app's read 10 is done).
- Task 1's questions about the provider's forward.
- Read 10, per app: each app's channel is described when its switches are ready to turn on.
- The receipt confirmation texts: one per app and language, for operations to read.
