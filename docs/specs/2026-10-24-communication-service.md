# Ulak as the communication service - specification (DRAFT 3, for the re-read of changes)

Status: draft 3, 2026-10-28 (Session 13; amended at the first client's request and for operations' third review). Draft 1 (2026-10-24) was reviewed by the first client application and by
company operations; draft 2 (`22664db`) was agreed by the first client with three notes and reviewed again by
operations (NOT YET: 2 high, 5 medium, 14 low; all 15 draft-1 findings closed). Draft 3 answers that second review.
Two of the other mail-sending apps have not answered the question "what do you send and receive". Next: operations
re-reads what changed; then the owner's approval. **Nothing in this document is built before the owner approves it.**

This repository is public: this document names no other project, person or deployment host, and
no mail or payment vendor (Telegram and Apple are named where their role needs it). "The company domain" and
"`<app>`" stand for the deployment's values. Prices and the payment provider's webhook terms were read on the date
given; sizes are estimates, counted in lines of code including tests.

## 0. The owner's summary (one screen)

**What it is.** Today each app sends its own mail. After this work, each app hands its finished mail to Ulak; Ulak
sends it, keeps a short record, hands back replies, keeps the legally required copies, and pings the owner when
something fails. The apps keep their own words and their own timing.

**It changes a standing rule of the owner's, if he picks vendor option 1 or 2.** Today app mail goes over the company's
mail account from each app's own address, and no second mail vendor is used. Options 1 and 2 (decision 1) add a sending
service; option 0 keeps the current account. This is his decision.

**What the apps send today** (their own answers; two apps have not answered): about eight apps send mail. Most send only
the sign-in mails (confirm your address, reset your password, "someone tried to sign up with your address", "a sign-in
was added"); a few also send others (payment receipts, a mail that closes an account, a warning before an unused
account is removed, game mails). None sends marketing. Volume, all apps together, as the apps estimate it (none keeps a
send log to count from): well under 1,000 mails a month.

**Base (what the brief and the law need):**

| Phase | What changes | Ulak: files / lines (with tests) | New in Ulak |
|---|---|---|---|
| 0 | Sending: the send key, the mail call (plain text, and an optional HTML part), the outbox and retries, the vendor's delivery reports, the sending-health check, the admin outbox view | about 15 files / 1,500 lines | 1 table, 4 routes, a 5-minute timer |
| 1 | Legal documents after a sale: the kept copy, search and download in the admin panel, an owner alert until each is delivered (sized for the plain-text form; HTML attachments add about 150 lines) | about 7 files / 600 lines; each selling app another 200-350 lines (its sale handler, a daily check job, its alerts) | 1 table |
| 2 | Inbound: replies to the apps' mails come to Ulak; the 14-day withdrawal clock | about 11 files / 1,100 lines | a fourth small Worker, 1 table, 1 mail subdomain |
| 3 | Each app's other mails move to Ulak, one app at a time | Ulak: none; each app: 50-300 lines | - |
| 4 | Each app's sign-in mails move, last, with the app's own path kept as a fallback | Ulak: none; each app: 100-200 lines | - |
| **Total** | | **about 33 files / 3,200 lines in Ulak** (Ulak today: about 4,850 lines, 2,250 of code and 2,600 of tests, so about +66%); each app 150-500 lines; each selling app another 200-350 lines in phase 1 (its sale handler, a daily check job, its alerts) | 3 tables |

With vendor option 0 (no new vendor), phase 0 is about 14 files / 1,400 lines: no vendor reports, plus a small mail
client for the current account.

**Options** (each off unless the owner picks it; section 11.2): push through Ulak, store reviews, and six small extras.

**Smallest path for the Türkiye documents** (phase 0 cut to `legal_document` only, plus phase 1): about 15 files /
1,300 lines in Ulak; in the selling app, a changed sale handler and a daily check job (about 200-350 lines). It removes
the after-sale documents blocker only; other prerequisites for selling are outside Ulak.

**Monthly cost** at under 1,000 mails a month:
- Vendor option 0 (keep the company's current mail account): no new cost. No delivery reports (section 5.5).
- Vendor option 1 (the transactional service of the mail provider the company already uses): the first credit (10,000
  mails, valid 6 months) is free. Its pricing page shows no price for further credits; third-party listings say about
  $2.50 each, so about $5 a year at most (unconfirmed).
- Vendor option 2 (the platform Ulak runs on): $5 a month for the paid plan, 3,000 mails a month included.
- Inbound (phase 2): no cost (the platform's mail routing is free).

**His steps and waits:** decision 1 (the vendor, and with it his mail rule); vendor option 1's account check is
reported to take up to a month, so it should start as soon as he picks it; approve the DNS changes operations makes;
register the sending domain for Apple's hidden-address relay in his Apple account (one form); answer decisions 2-8.

**Decisions** (section 12): 1 vendor (and his mail rule); 2 the form of the legal documents; 3 push stays in the apps;
4 store reviews not now; 5 app mailboxes; 6 commercial mail stays off; 7 when the apps' own sign-in path is removed;
8 which of options O3-O8, and the phase order.

## 1. The brief

The owner, Session 11: "My priority is that it will handle all the external communication of all our apps. The apps
will build their bridges but you will handle the incoming and outgoing communication."

**In scope:** communication between the company's apps and people outside the company (players, customers, buyers), in
both directions: mail out, replies in, legally required documents after a sale, support messages (existing); push and
store reviews only if the owner picks them.

**Out of scope** (owner ruling via operations, Session 11): messages between the company's own agents or projects, and
the company mailbox (vendors, accountant, authorities, DMARC reports). Payment and store webhooks (machine-to-machine)
stay with each app.

## 2. Principles

1. **The app owns the words and the timing; Ulak owns the transport, the inbound channel and the records.** An app sends
   finished text (subject, body, language; optionally an HTML part) and decides what to send and when (its throttles,
   its no-night rules, its wording that never reveals whether an address has an account). Ulak delivers, retries until
   the mail's expiry, records the result, receives replies, and tells the owner when something fails. Every text has
   gone through the app's legal and language reads; Ulak never rewrites it.
2. **Store the minimum.** Ulak's lasting record is metadata (which app, which label, when, result, the vendor's id) and
   a keyed hash of the address, not the plain address. Until a mail is delivered or expires, the outbox holds its body
   and its plain recipient address; both are deleted then. Two exceptions, each stated where it applies: a legal
   document's exact sent copy is kept for its legal period (5.4); an inbound reply keeps the sender's address and text
   under support retention, because the operator answers it by mail (7.1).
3. **A mail never changes what the person sees on screen**, and never reveals whether an address has an account. The
   app answers the person first and hands the mail to Ulak after (the sign-in standard's rule). Per-address outcomes
   (suppressed, over the ceiling, bounced) never reach the screen (5.2).
4. **One flow at a time, sign-in last.** Each flow moves only after it is proven live; the old path is switched off after
   that, never before. Each app keeps its own sign-in path as a fallback until the owner decides to remove it (decision
   7). After that, sign-in depends on Ulak and the vendor.
5. **Each phase's size and running cost go to the owner before it is built** (section 0).
6. Existing Ulak rules stay: errors are `{ error, retryable, detail }`; message content is rendered as text, never as
   markup (an app's HTML part is stored and sent, never rendered by Ulak); no AI provider inside Ulak; no end-user
   accounts; no captcha; no non-image attachments. That last rule stands unless the owner changes it (decision 2).

## 3. What Ulak already does (unchanged)

- Support messages in (text plus up to 3 images), a text-free Telegram ping to the operator, replies back by polling.
- Owner notices: `POST /v1/notify` with a separate notice key.
- Admin panel (Google sign-in, PKCE), admin JSON API, retention by `last_activity_at`, per-user deletion.

## 4. Keys and roles

Each app already has an app key (support) and an optional notice key. Sending gets its **own send key per app**, issued
and rotated in the admin panel like the notice key, server-only: a request with an `Origin` header is refused. A leaked
support key, which may live in a web page, can therefore never send mail.

Each app's row gains its sending identity: From name, From address (`<app>@` the company domain, the app's own and only
public address), the kinds it may send (`transactional`, `legal_document`), and its list of mail labels. A label not on
the list is refused (`422 unknown_label`); the list goes to operations before the app's flow moves (legal read 2).

## 5. Outbound mail

### 5.1 The call

`POST /v1/mail` (send key). Body:

| Field | Meaning |
|---|---|
| `to` | one address |
| `locale` | the language the text is in (recorded, not used to choose words; the app chooses the language from the account) |
| `kind` | `transactional` \| `legal_document` |
| `label` | the app's own name for the mail, for example `password_reset`; must be on the app's list |
| `subject`, `text` | finished plain text; links absolute (`https://`) |
| `html` | optional, `transactional` only: the app's finished HTML part of the same mail (for example the link as a button), sent beside `text`. Links in it absolute `https://`; no scripts, no forms and no images (a link button needs none, and an image could track the reader). The check guards against an app's mistakes; it is not a sanitiser. Stored and deleted exactly like `text`, never rendered in the admin panel. Refused on `legal_document` until legal read 11 says otherwise |
| `expires_at` | required: after this time Ulak gives up instead of sending (a sign-in link mail: its link's life or less; a durable notice: its deadline). At most 24 hours ahead, except `legal_document` (5.4) |
| `idempotency_key` | required; one per action of the person or event of the app (a second press of "send again" is a new key). The same key within 7 days returns the first result and sends nothing again |
| `user_ref` | optional; the app's opaque account id, used only for deletion |
| `document` | `legal_document` only: `{ version, reference }`, the accepted version and the order number |

Answers:
- `202 { id, status: "sent" | "queued" }`; for `legal_document` always `queued` (5.2). From the `202` on, the duty is
  Ulak's record. If the vendor then refuses the address (suppressed, or any other refusal that depends on the address,
  5.3), the stored legal document moves to the state **held**: nothing more is sent, the copy is kept, it shows in the
  admin outbox and an owner alert opens (5.4). The app never sees `held` and changes nothing.
- `422` with a reason, not retryable: the app's own mistakes (`unknown_label`, `bad_link`, `not_plain_text`,
  `bad_html`), on any kind; and `suppressed` on `transactional` only. The app treats its own mistakes as a bug and
  pings the owner itself.
- `429` with `Retry-After` over the per-address ceiling (`transactional` only).
- `503 retryable` only when Ulak itself cannot accept the mail.

### 5.2 Delivery

- Every accepted mail goes into the outbox and is tried at once. For `transactional`, the call waits for that first
  attempt for at most about 8 seconds and answers `sent` or `queued`. For `legal_document`, the call answers as soon as
  the copy is stored (`queued`) and the first attempt runs right after, so the answer comes well inside the
  timeout of whatever sends the app its sale event (5.4). A queued mail is retried with backoff by a 5-minute timer until it is sent or its
  `expires_at` passes; then it is given up. A stale mail (a link already dead) is therefore never sent late, at night or
  in a burst.
- Its body and plain address are deleted when the vendor accepts it or when it is given up, except a legal document's
  (5.4).
- Once the vendor accepts a mail, the vendor retries delivery to the recipient's server itself; Ulak's retries cover only
  the vendor or the network being down.
- **The app's side** (the same for every app; also in section 14):
  - the app calls Ulak after it has answered the person, and caps its own wait at 10 seconds;
  - any per-address answer (`422 suppressed`, `429`) is treated on screen exactly as a sent mail;
  - while the app keeps its own sending path (principle 4), a failed or timed-out call to Ulak sends through that path
    at once, and the app tells Ulak nothing. A call that timed out may still have been queued by Ulak, so the person
    can receive the mail twice: duplicate over loss, chosen knowingly (section 14);
  - after the owner removes that path, the app may show "we cannot send mail right now, try again later" only from
    `GET /v1/mail/status` (send key), which answers `{ sending: "ok" | "down" }` from Ulak's recent results with the
    vendor across all apps, never from anything about the address. `down` counts only failures of the vendor's own
    service (no answer, server errors, refused credentials), never bounces, suppressions, `422` or `429`, so a stream of
    bad addresses cannot flip it. The app asks it before answering the person, the same way for every address, caps
    that wait at 2 seconds, and treats no answer as `ok`, so a slow status call never delays a sign-in screen.
- A notice whose loss matters (for example a warning before an unused account is removed) can read its state with
  `GET /v1/mail/:id` (option O5).

### 5.3 Safety limits Ulak enforces (the app's own throttles stay in the app)

- A per-recipient ceiling per app: 10 mails per hour per address, so a bug or an abused form cannot flood an inbox.
  Over it: `429`. `legal_document` is exempt.
- Suppression: the vendor's own list of hard bounces and spam complaints is used (to verify in phase 0 that the vendor
  keeps one). Ulak passes its answer back as `422 suppressed` on `transactional`; on `legal_document`, which was already
  answered `queued`, the stored mail moves to `held` with an open owner alert (5.1, 5.4). Ulak's own list with a lift
  button is option O3. With vendor option 0 there is no vendor list: bounces return as mail to the mailbox of the login
  Ulak sends with, and Ulak learns of none.
- Links must be absolute `https://`, `text` plain text, and `html` within its limits (5.1); anything else is refused
  with a reason.
- No tracking: open tracking, click tracking and link rewriting are off at the vendor, and Ulak never adds a pixel or
  changes a link. Phase 0 acceptance reads one received mail's raw source to prove it.

### 5.4 Legal documents

For the after-sale documents a buyer must receive on a durable medium (an e-mail counts), filled with the order number,
date, plan and price:

- The app sends the filled text exactly as accepted (`kind: legal_document`) with the document version and the order
  reference. The app owns the text and its legal review; Ulak stores no templates and takes every figure as given
  (amounts and tax exactly as the payment provider stated them); it never fills, computes or infers anything. The app
  calls only once it has the figures and the accepted version.
- **How the app calls** (the same for every selling app): inside its handling of the sale event, from whichever service
  delivers that event to the app (the payment provider itself, or a subscription service between the app and its
  payment rails). The numbers come from that sender's own webhook terms, read for each app before its phase 1: the app
  caps its wait for Ulak below the sender's timeout (for example, one payment provider wants an answer within 5
  seconds, so about 4; one subscription service waits 60 seconds); if Ulak does not answer `202` in that time, the app
  answers the webhook with an error, so the sender delivers the event again, and the `idempotency_key` (the sale's id)
  keeps it to one mail. A timeout counts as "no `202`" and is safe for the same reason. The app does not mark the sale
  processed before Ulak's `202`. From the `202` on, Ulak's record is the durable record of the duty. Inside the sale
  handler the app makes only the legal-document call; every other mail (a payment receipt, a welcome) is sent after
  the webhook is answered, so its longer wait never pushes the handler past the sender's timeout. (Webhook terms read
  2026-10-28: the payment provider re-delivers for up to about 1 day 18 hours in live, but only 3 times in about a
  minute in its sandbox; the subscription service retries 5 times over about 80 minutes.) Phase 1 acceptance in a
  sandbox therefore proves the daily reconciliation, not re-delivery.
- **Daily reconciliation** (each selling app): an Ulak outage longer than the sender's re-delivery window would
  otherwise lose the duty silently. Once a day the app reads the completed sales (from the payment provider or the
  subscription service) for a look-back of the sender's re-delivery window plus a day, and never less than two days
  (3 days for the provider's window; 2 days for a window of 80 minutes, so one late or failed run is still covered by
  the next), and calls `POST /v1/mail` again for each with
  the same `idempotency_key`: an accepted one returns its first result and sends nothing; a missing one is sent, and the app pings the owner that it was missed. A
  sale with no linked acceptance is never called and is listed in the owner ping as an alert, never skipped. If the job
  has not completed a run in 36 hours, the app pings the owner (a check that its safety net still runs).
- Its `expires_at` is set by the legal read of the deadline (legal read 6); until that read, 24 hours, and the owner is
  pinged after the first hour without delivery.
- Ulak keeps the exact sent copy (subject, text, recipient, version, reference, the time the vendor accepted it, the
  vendor's id) **and the vendor's delivery event** (the recipient's server accepted it, and when), which is the
  evidence that the buyer got it (whether it is enough is legal read 11). Kept for the legal period (legal read 3),
  then deleted by the scheduled job; it survives a user-data deletion until then. With vendor option 0 there is no
  delivery event: the evidence is only the time the company's mail server accepted the mail.
- A legal document that is held, given up or bounced stays an **open owner alert** until the operator closes it by hand
  with a reason. Ulak sends only the app's finished text, so the remedy is one of two: the app calls again with the
  corrected address and a new `idempotency_key`, and the alert closes naming that new mail; or the operator downloads
  the copy and sends it by hand from the app's mailbox, and the alert closes saying so.
- The operator finds a copy in the admin panel by reference and downloads it. The admin panel never renders it.
- **Form** (decision 2): (a) the documents as plain text in the mail body: no rule change, about 150 lines less in phase
  1. Operations' durable-medium read (2026-10-28) accepts it: the regulation lists e-mail among its examples of a
  durable medium and names no file format, on three conditions: (1) the whole text of the pre-contract form and the
  contract is in the mail, never only a link to a page that can change; (2) the order fields (number, date, plan,
  price, VAT, trial dates) are filled in; (3) it is the version the buyer accepted, and Ulak keeps the copy it sent
  (each transaction's records kept 3 years). Or (b) up to 4 HTML attachments on `legal_document`
  only, stored as sent and offered only for download: needs the owner to change the Decision to "No non-image
  attachments, except up to 4 HTML attachments on outbound legal documents". Either way, operations reads the final
  mailed form in Turkish and English before phase 1 goes live.

### 5.5 Sender, DNS and vendor

- From `<App name> <app@company domain>`, the app's own address, so people and store reviewers recognise it. Never
  another address, never a product domain that publishes "sends no mail".
- **What a vendor adds over the current account:** the vendor reports each delivery, bounce and spam complaint to Ulak.
  That is what 5.4's delivery evidence and 5.3's suppression rest on; the current account gives neither. Better inbox
  placement is possible but unproven: operations' spam test found app mail in Spam with SPF, DKIM and DMARC passing,
  and read the likely cause as a young, low-volume sending domain plus a thin, link-only mail, which a young domain
  keeps on any vendor. The re-test after the apps' fuller mails decides it. (A Worker can open outbound connections
  except on port 25, so sending over the current account is possible.)
- Vendor options (decision 1; prices read 2026-10-28; operations holds the source links):
  0. **Keep the company's current mail account** (Ulak sends over it): no new company, no new account, no wait, no
     vendor DNS. Loses: delivery events (5.4 keeps only the sent time), the vendor's suppression list (5.3), and the
     sending-health check reads only Ulak's own connection failures. A legal document that bounces is never detected
     by Ulak: the bounce lands in the sending login's mailbox and is found only by someone reading it. Ulak sends with
     its own sending identity or an SMTP-only application password, never the owner's own login secret. Its limit
     (operations, 2026-10-28): one shared outgoing quota of 50-500 mails an hour, set by reputation, for every app's
     mail and the company's own mail together; bursts are not supported, and over the limit nothing can be sent for up
     to an hour. Far above today's volume, but one burst (a bug, a mass re-send) could stop every app's mail and the
     company's own for an hour, so Ulak's retries spread re-sends and never burst. The Apple relay registration
     already covers the company domain, so option 0 needs no new one. Keeps the owner's current rule.
  1. **The transactional service of the mail provider the company already uses** (recommended): first credit free; a
     credit is 10,000 mails, valid 6 months; no monthly minimum. Its pricing page shows no price per credit;
     third-party listings say about $2.50. Its account check is reported to take up to a month. A second product of the
     same company: no new company receives data, but it changes the owner's rule (section 0).
  2. **The platform's own mail sending:** needs the paid plan, $5 a month, which includes 3,000 mails a month, then $0.35
     per 1,000 (the platform's pricing page). It was announced as a public beta in April 2026; for legally required mail
     that is a risk. The platform already processes Ulak's support messages, but for every app's users it is a new
     recipient of their addresses and mails. It is a second mail vendor, so it changes the owner's rule.
  3. Another transactional service with a free tier: adds a new company that receives addresses and texts (section 10).
     Not recommended.
- Operations opens any vendor account under the company's standard vendor login.
- DNS (SPF, DKIM, DMARC) is done by operations with the owner's go. The current provider's SPF entry stays while any
  app's own path lives.
- **Apple's hidden-address relay** delivers only when both match exactly: the registered domain equals the envelope
  sender's domain, or the mail is DKIM-signed with `d=` exactly the From domain (the company domain itself, not a
  subdomain). The vendor's bounce domain is recorded in phase 0, and the matching one is registered (an organisation may
  register up to 100). Phase 0 acceptance: one real mail through the chosen path to a real hidden Apple address arrives.
- The vendor reports deliveries, bounces and complaints to a webhook on Ulak, verified by the vendor's signature (or,
  if it offers none, a secret in the URL; to verify in phase 0). Not with option 0.

### 5.6 Commercial mail

Off: there is no `commercial` kind. A commercial e-message in Türkiye needs recorded consent in the national register
(İYS), and Ulak cannot verify that. None of the apps sends marketing today. Turning it on is a separate decision after
a legal read.

## 6. Push (option O1; recommended: not now)

Of the apps that answered, two send web push with their own keys and no vendor; one sends Android push through a push
provider and has "no strong need" to move it. If the owner picks it anyway:

- `POST /v1/push` (send key): the device token, title, body, an optional link, an `idempotency_key`. Ulak calls the push
  service with the app's own credentials (a secret per app) and returns the result; an invalid-token answer goes back so
  the app drops that token. **No device tokens are stored in Ulak**, so sign-out and account deletion clear them where
  they already live.
- Push carries no personal data; Ulak refuses a body over a small size and logs nothing of it. The app's budget rules
  (one push a day, quiet hours, the person's own hour) stay in the app.
- Cost of the option: Ulak would hold every app's push credential, so it becomes the company's most powerful sending
  point. Size: about 6 files / 400 lines.

## 7. Inbound

### 7.1 Replies to the apps' mails (phase 2)

**Who sets Reply-To.** Ulak sets it on every outbound mail; the app does not send one. Until phase 2 is live and that
app's inbound channel is reviewed (legal read 10), Reply-To is the app's own support address (`<app>@` the company
domain). From that review on, every outbound mail of that app carries `Reply-To: reply+<token>@<inbound subdomain>`,
where `<token>` is a signed id of that mail.
The inbound subdomain's MX points to the platform's mail routing, which hands each mail to a small Ulak mail Worker. The
root domain's MX and the company mailbox are not touched. (Phase 2 acceptance: a reply from a real hidden Apple address
reaches the Worker; Apple's documentation says nothing on replies.)

The Worker verifies the token, keeps the text (images follow the support rules; any other attachment is dropped and the
operator told), and files the reply as a support message under the app. The operator gets the usual text-free Telegram
ping and answers in the admin panel; the answer goes back by mail from the app's address.

- **The reply shows in the app's support thread only when the keyed hash of its From address equals the original
  recipient's hash.** Otherwise (a forwarded mail, a stranger) it is for the operator only and the person's thread
  never shows it. A reply without a valid token is filed as unlinked, operator only.
- To answer by mail, Ulak keeps the sender's address and text under support retention (principle 2's exception).
- Before replies are filed under an app, operations reviews that app's inbound channel (a reply is free text from
  outside) - legal read 10.

### 7.2 App mailboxes and the registered e-mail (KEP) address

The per-app contact mailboxes stay where they are. Decision 5, three choices:

- (a) forward an app mailbox to an Ulak inbound address, so it arrives in the admin panel with a Telegram ping - only
  after operations confirms that mailbox holds only mail from people outside the company, or with a filter first (an app
  mailbox may also receive vendor or store mail, which is the company mailbox's category and out of scope);
- (b) no change, with a Telegram reminder every two days. Cost: a withdrawal notice mailed there can wait up to 2 of its
  14 days before anyone sees it;
- (c) no change, no reminder.

Recommended: (a) for the mailbox of every app that sells, after the check; (c) for the rest.

**KEP stays outside Ulak** (recommended): it mainly carries authorities' mail, which is the company mailbox's category,
and moving a KEP message out of the KEP system may lose its value as evidence (to verify). KEP stays a manual read; the
admin panel lets the operator open a withdrawal clock by hand, entering the arrival time read in KEP (7.3).

### 7.3 Legal clocks (the withdrawal notice; phase 2)

A buyer's withdrawal notice starts a 14-day refund clock from the moment it reaches the seller, not from when anyone
marks it (legal read 7).

- Every inbound message (a reply, a forwarded mailbox copy, or a support-form message) already pings the operator, and
  Ulak stores its arrival time. The operator reads it and decides; marking it later still counts the clock from that
  stored arrival time. (Flagging likely withdrawals by their words is option O8.)
- The arrival time is the receipt time: for a forwarded mail, the time the app mailbox received it (its `Received`
  header), not the forward time. A forwarding rule may rewrite that chain: phase 2 acceptance shows on a real forwarded
  mail that the original receipt time survives, or the clock is counted from the forward time and the privacy and
  sales texts allow for it.
- When the operator marks it **withdrawal**, Ulak pings the owner with the due date, again 3 days before and on the day,
  until the operator marks it done. A clock can also be opened by hand with an arrival time (KEP, a letter, a call).
- A marked notice, its clock and its done-mark are kept like a legal document: exempt from per-user deletion and from
  `retention_days` for the legal period (legal read 3).
- **Not complete:** a notice sent through the payment provider's own buyer portal never passes through Ulak; that route
  stays with the app and its payment provider.

### 7.4 Store reviews (option O2; recommended: not now)

The scheduled job would read new reviews from the stores' APIs per app, file them in the admin panel and ping the
operator, who can reply from the panel through the store's API. Few of the apps are in a store today. Cost of the
option: Ulak would hold the store credentials; one store's API key is team-wide, not per app, so it reaches every app
in that store. Operations would set up each store identity with the narrowest role that can read and reply. Size: about
8 files / 600 lines.

## 8. Records, retention and deletion

- Each send writes one metadata row: app, kind, label, a keyed hash of the address (for the ceiling and deletion, never
  shown), `user_ref`, created, sent, delivered, result, vendor id, attempts. Bodies and plain addresses are deleted on
  acceptance or give-up. Rows follow the app's `retention_days`.
- The address hash is keyed per app (each app's own key), so the same address gives a different hash in each app: no
  list is ever merged across apps.
- Legal-document copies and marked withdrawal notices: kept for the legal period, then deleted by the scheduled job.
- **Per-user deletion works by account and by address:** the existing `DELETE` by `user_ref`, and a new delete by
  address (send key), which removes every row of that app with that address's hash; one app's request never touches
  another app's rows. Mails sent before an account existed (confirm your address, "already registered") carry no
  `user_ref`, and deletion requests come by address as often as by account. Both remove send rows and inbound replies,
  except legal-document copies and withdrawal records within their legal period.
- No address, token, link or body in any log or error (addresses masked; vendor error texts carry the recipient's
  address and are scrubbed before they are stored); no personal data to error tracking.
- What Ulak's deletion cannot reach: the vendor's and the platform's own logs. How long they keep addresses and texts is
  legal read 8; the privacy texts must say it.

## 9. Admin panel

- Outbox per app: failed, queued and held mails with their reason (base). Day and week counts and "retry now" are option
  O4.
- Legal documents: search by reference; download the exact copy; open alerts with their close button and reason.
- Withdrawal clocks: open ones with their due dates; open a clock by hand.
- Inbound replies and forwarded mailbox copies appear in the existing message list.

## 10. Legal reads (operations) before the phase that needs them

1. **Data sent abroad (KVKK art 9) and processing contracts (art 12)** - one row per outside company (verify each
   article):

   | Company | Receives | Where | Needed | Phase |
   |---|---|---|---|---|
   | The platform Ulak runs on | addresses, texts, metadata, inbound mail (already: support messages) | abroad | standard contract notified to the Board within 5 business days of signing; processing contract | 0 (already a processor) |
   | Mail vendor, option 0 or 1 | addresses, texts | abroad (its EU region to verify) | the same; this company already carries the apps' mail | 0 |
   | Mail vendor, option 2 | the same | the platform above | covered by the platform's row; new for every app's users | 0 |
   | Mail vendor, option 3 | the same | abroad | the same; a **new** company | 0 |
   | Telegram | text-free pings (app, label, counts, due dates) | abroad | none if they hold no personal data: confirm | 0 |
   | The AI assistant the operator drafts replies with | support messages, inbound replies, forwarded mailbox copies (free text from the public) | abroad | no processing contract known (operations' processors table): **gate for phase 2**; until it is read, the operator drafts only from support-form text | 2 |
   | Apple (hidden-address relay) | mail to a person who chose a hidden address | abroad | the person's own choice: confirm | 0 |
   | Push services | device tokens, push texts | abroad | the same | O1 only |
   | Store APIs | reviews and replies | abroad | the same | O2 only |

   Options 0, 1 and 2 keep the number of companies unchanged; only option 3 adds one. Phase 0 is not gated by this
   table: it builds the send path and sends nothing to a real person, and no existing flow waits on the standard
   contracts. What gates around it: the privacy-statement template read before phase 0 ships (read 4); each app's own
   privacy text naming the vendor before that app's flow moves (phase 3); operations recording the chosen vendor's row
   and its processing-contract position in its processors table. Phase 2 is gated by the AI-assistant row. The
   standard-contract signing and its notice stay a separate open item of the company's; no phase waits on it.
2. **İYS:** every mail in phases 0-4 is transactional. `kind` is the app's own declaration, so each app's label list
   (one line per mail) goes to operations before its flow moves, which catches a promotional line inside a
   transactional mail.
3. **Retention of legal copies and withdrawal records:** the ground that lets them outlive a deletion request (KVKK art
   5(2)(ç) legal obligation or (e) establishing a right; verify), and for how long: 3 years for distance-sale records,
   or longer if commercial or tax record-keeping applies (TTK art 82 keeps commercial correspondence 10 years; verify
   whether a consumer contract mail counts).
4. **Privacy texts:** each app's privacy text names Ulak's processors before its first flow moves; Ulak's privacy
   statement template is extended to outbound mail, legal copies and inbound replies (and push if O1). Each selling
   app's text says that the legal copy is the exception to any shorter keeping time it promises for sent mail.
   Operations reads them in every locale before phase 0 ships.
5. **KEP:** confirm it stays outside Ulak, and whether a KEP message keeps its evidence value only inside KEP.
6. **The documents' deadline:** by when the documents must reach the buyer. A subscription is used from the moment of
   purchase, so "before performance" may mean "at once"; this sets `expires_at` for `legal_document`.
7. **Withdrawal notices as records:** when the clock starts, and the seller carries the burden of proving it was met
   (Distance Contracts Regulation art 12 and 20; verify the paragraphs), hence 7.3's retention.
8. **The vendor's and the platform's own logs:** how long they keep addresses and texts. An app's privacy text may
   promise a short keeping time for sent and unsent mail; the chosen vendor must fit it, or that app's text changes
   first.
9. **Receipt confirmation:** if the support form or replies are offered as a withdrawal channel, whether the buyer must
   get a confirmation of receipt (art 11(2); verify).
10. **Inbound free text, per app:** each app's inbound channel (7.1, 7.2) is reviewed before replies are filed under it,
    including whether any of it ever becomes visible to another person (Law 5651); 7.1's address check keeps a reply
    visible only to the person it was sent to.
11. **The legal documents' mailed form** (5.4): the plain-text form is accepted as a durable medium on 5.4's three
    conditions (operations, 2026-10-28; the definition's exact sentence still to verify); operations reads the final
    mailed form in Turkish and English before phase 1 goes live; whether the vendor's delivery event (or, with option 0, the sent time) is enough evidence of
    receipt; and whether an HTML part may ever accompany a legal document.

## 11. Phases

### 11.1 Base, one at a time (each sized in section 0)

| Phase | What | Needs first |
|---|---|---|
| 0 | Sending path on the chosen vendor (with option 1 or 2: the vendor account, its DNS and webhook, the Apple relay registration), the send key, `POST /v1/mail`, the outbox and the 5-minute retry, `GET /v1/mail/status`, delete by address, the outbox view | owner: decision 1; operations: DNS, legal read 4, the vendor's row in its processors table |
| 1 | Legal documents mail; in each selling app the changed sale handler and the daily check job. **Removes the after-sale documents blocker only; other prerequisites for selling are outside Ulak.** | phase 0; the check whether the payment provider's own receipt carries part of the duty (it may shrink this phase); decision 2; legal reads 3, 6, 11 |
| 2 | Inbound replies and withdrawal clocks; mailbox forwarding if chosen | phase 0; the inbound subdomain's DNS; decision 5; legal reads 7, 9, 10; the AI-assistant row of read 1 |
| 3 | Each app's other mails, one app at a time | the app's privacy text and label list (legal reads 2, 4) |
| 4 | Sign-in mails, one app at a time, the app's own path kept | phases 0-3 proven live |

Acceptance of every phase is read in the live system: a real mail received and its raw source read, a real delivery
event stored (not with option 0), a real reply filed.

### 11.2 Options (off unless the owner picks them)

| Option | What | Size |
|---|---|---|
| O1 | Push through Ulak (section 6) | about 6 files / 400 lines |
| O2 | Store reviews (7.4) | about 8 files / 600 lines |
| O3 | Ulak's own suppression list with a lift button (if the vendor's is enough, not needed; with vendor option 0, it would have to read bounce mails) | about 3 files / 150 lines |
| O4 | Outbox day and week counts, and "retry now" | about 2 files / 120 lines |
| O5 | `GET /v1/mail/:id`: the app reads one mail's state (useful for a notice whose loss shortens someone's notice period) | about 2 files / 80 lines |
| O6 | Strip the quoted earlier mail from inbound replies | about 2 files / 100 lines |
| O7 | `409` when an idempotency key is reused with different content (otherwise the first result is returned silently) | about 1 file / 40 lines |
| O8 | Withdrawal-word flagging: an inbound message with the words for withdrawal in the app's languages gets a "possible withdrawal" ping with the provisional due date. It only changes the ping's wording (7.3 counts the clock from arrival without it) and misses other wordings. If picked: a ping never says "not a withdrawal", an unflagged message is never ranked lower, and operations reads the word lists in every locale first | about 2 files / 120 lines |

## 12. Decisions for the owner

1. **Vendor, and with it his mail rule.** Today's rule: app mail goes over the company's mail account from each app's
   own address, with no second mail vendor. Option 0 keeps it (no cost, no wait; no delivery evidence for legal
   documents and no bounce list: a legal document that bounces is never detected by Ulak, only by someone reading the
   sending mailbox; and one hourly quota of at least 50 mails shared by every app and the company's own mail, which one
   burst could stop for up to an hour). Option 1, the transactional service of the mail provider the company already uses
   (recommended: about $5 a year if third-party prices hold, the same company, delivery and bounce reports; its account
   check may take a month), or option 2, the platform ($5 a month, still in beta), both change the rule.
2. **Legal documents' form:** plain text in the mail body (recommended: operations' read accepts it as a durable medium
   when the whole text is in the mail, never only a link; the order fields are filled in; and it is the version the
   buyer accepted, with Ulak keeping the sent copy; no rule change, smaller), or HTML attachments (the Decision becomes
   "No non-image attachments, except up to 4 HTML attachments on outbound legal documents").
3. **Push stays in the apps** (recommended): no app needs it moved, and Ulak would hold every push credential.
4. **Store reviews: not now** (recommended): few apps are in a store, and one store key reaches every app.
5. **App mailboxes:** forward the selling apps' mailboxes after a check (recommended), a two-day reminder (a withdrawal
   can wait 2 of its 14 days), or nothing.
6. **Commercial mail stays off** (recommended): no app sends it, and İYS consent cannot be checked.
7. **The apps' own sign-in path:** kept as a fallback until he says it goes; after that, sign-in depends on Ulak and the
   vendor.
8. **Which of options O3-O8 (11.2) and the phase order** (recommended: none of them now; base phases 0-4 in order,
   phase 1 first after 0).

## 13. Open inputs

- Two of the other mail-sending apps have not answered yet; their answers fold in at the next round.
- Whether the payment provider's own receipt can carry part of the documents duty: not confirmed with the provider (a
  "needs first" of phase 1).
- The vendor's suppression list, webhook signature and log retention: read in the vendor's documentation in phase 0.
- Each selling app's sale-event sender and its webhook terms (timeout, re-delivery window): read before that app's
  phase 1.

## 14. Requirements carried from earlier work and the apps' answers (must not be lost)

**Ulak's side**
- A send timeout on every network stage; all-or-nothing configuration (a half-set vendor config fails at start, not at
  the first send). An unconfigured vendor never looks like success.
- Addresses masked in anything stored or logged; vendor error texts scrubbed of addresses before they are stored, and
  nulled when that person's data is deleted. A link's token never leaves the mail body: never logged, never kept after
  delivery.
- A send that went out but could not be marked sent may be retried, and an app that falls back after a timeout may send
  the same mail itself: duplicate over loss, chosen knowingly; `expires_at` bounds it.
- An ordinary mail that is suppressed or given up is closed once with one operator line, never alarmed again; a legal
  document that is held, given up or bounced stays an open alert until closed by hand (5.4). Every operator alert can be
  closed.
- Throttle per recipient as well as per sender.
- No tracking pixel, no click tracking, no rewritten link, no marketing, no merged lists across apps (the address hash
  is keyed per app).
- Legal documents: the filled values (order number, date, plan, price and the payment provider's own tax figure), the
  version the buyer accepted, the sale linked by the payment provider's signed id, the buyer named only by the account
  address. Never answered `422` for a reason that depends on the address: `held` and an owner alert instead.

**Each app's side** (the same rules for every app)
- Answer the person first; hand the mail to Ulak after; cap the wait at 10 seconds.
- Treat `422 suppressed` and `429` on any mail exactly as a sent mail on screen; never reveal whether an address has an
  account, by words or by timing. A `422` for the app's own mistake is a bug the app reports to the owner.
- One `idempotency_key` per action of the person or event of the app; an `expires_at` on every mail (a stale mail is
  given up, never sent late, at night or in bulk because of a retry).
- The language comes from the account (some apps write German as well as English and Turkish; some write only English
  and Turkish); absolute `https://` links; plain text, with an optional HTML part of the same words.
- Send only from the app's own address, and set no Reply-To (Ulak sets it, 7.1); the app's throttles and quiet hours
  stay in the app.
- A selling app (200-350 lines of its own in phase 1) makes only the legal-document call inside its sale-event
  handling and sends every other mail after the webhook is answered; it caps that wait below the timeout of whatever
  sends it the sale event, answers that webhook with an error until Ulak's `202`, and never marks a sale processed before it. Once a day
  it reconciles the completed sales against Ulak over that sender's re-delivery window plus a day (never less than two days), lists any sale without a linked
  acceptance as an alert, and pings the owner if the job has not completed a run in 36 hours (5.4).
- The sending-health check waits at most 2 seconds and counts no answer as `ok` (5.2).
- A mail the app must send at a fixed moment (for example a notice that states how long data is kept) is sent at that
  moment; Ulak does not delay it.
