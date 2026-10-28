# Support messages: privacy statement (template)

Replace the placeholders in double braces and publish this alongside your apps' privacy policies.
Each app that sends messages here should also name this service as a recipient in its own policy.

---

## Who is responsible

{{CONTROLLER_NAME}} operates the support-message service that receives messages sent from the
"contact support" feature of its apps. Contact: {{CONTACT}}.

## What is stored

When you send a support message, or when an app sends a crash report with your consent, the
service stores:

- the text you wrote, and the language of your device;
- which app sent it, its version and the platform (for example Android or web);
- an opaque reference the app uses to show you the reply inside the app; the service cannot turn
  it back into your identity;
- if the app includes them: the last error the app recorded, and technical context the app
  documents (screen name, device model, operating system version);
- if you typed it: the email address you chose to give;
- if you attached them: images, which are re-encoded on receipt so that no hidden metadata such as
  location survives;
- the time the message arrived, and any replies and status changes made by the operator.

Nothing else is stored. To limit abuse, the address your request comes from is counted by
Cloudflare for about a minute; it is not stored. The service has no accounts, no tracking, and no
analytics.

## Why

Only to read and answer your message. The operator uses an AI assistant, Claude by Anthropic
(United States), to draft replies; the message text is sent to it for that purpose, and a person
approves every reply before it is sent.

## For how long

{{RETENTION_DAYS}} days after the last activity on the message (its arrival, the last reply, or the
last status change), after which it is deleted automatically together with its replies and images.

## Deletion on request

If the app offers account deletion, deleting your account also deletes every support message you
sent from it. Otherwise contact {{CONTACT}} and quote the app name; the operator can delete
everything tied to your reference.

## Mail an app sends you

Some of {{CONTROLLER_NAME}}'s apps send their mails to you (for example "confirm your address" or
"reset your password") through this service. The app writes the mail; the service delivers it
through {{MAIL_VENDOR}} ({{MAIL_VENDOR_REGION}}), which receives your address and the mail's text to
deliver it.

Until the mail is handed to {{MAIL_VENDOR}}, or given up because it could no longer be useful (each
mail carries its own expiry, at most 24 hours), the service holds your address and the mail's text.
Both are deleted at that moment. After that it keeps only: which app sent it, the kind and name of
the mail (such as `password_reset`), its language, when it was sent and whether it was delivered,
bounced or marked as spam, {{MAIL_VENDOR}}'s reference for it, the app's opaque account reference if
the app gave one, and a code made from your address with a secret key. That code cannot be turned
back into your address; it differs in every app, so no list is ever merged across apps. It is used
to limit an app to 10 mails an hour to one address, to stop mail to an address that bounced or
marked a mail as spam, and to delete your records when you ask.

Why: to deliver a mail you asked for or that your account needs (the contract with you), and to
stop mail to addresses that bounce or complain (a legitimate interest in not sending unwanted mail).

No mail carries a tracking pixel, open or click tracking, or a rewritten link. No marketing mail is
sent.

These records are deleted {{RETENTION_DAYS}} days after their last activity, or at once when the app
deletes your account or you ask for deletion by address. {{MAIL_VENDOR}} keeps its own delivery log
of each mail for 60 days; the mail's text is not stored there. This service cannot delete that log.

## Documents after a purchase

(Publish this section only once an app sends its after-sale documents through this service.)

If you buy in an app that sends its after-sale documents (the pre-contract information and the
contract) through this service, the exact mail sent to you (its subject, text, your address, the
document version and the order number) and {{MAIL_VENDOR}}'s report that your mail server accepted
it are kept for 10 years from the end of the year of your purchase, because the law requires the
seller to keep copies of the documents it sent. They are kept even if you ask for deletion earlier,
and deleted automatically at the end of that period. The operator can download a copy to resend it
to you; it is never shown to anyone else.

Why: a legal duty of the seller.

## Replies you send to an app's mail

(Publish this section only once replies come to this service.)

If you reply to a mail an app sent you, your reply comes to this service. It keeps your address and
your text, like a support message, so the operator can read and answer it by mail, and deletes them
{{RETENTION_DAYS}} days after the last activity, or on request. Images follow the support-message
rules; other attachments are dropped. Your reply is shown in the app's support thread only if it
comes from the address the mail was sent to; otherwise only the operator sees it. If you write to
withdraw from a purchase, the arrival time of that message and the operator's handling of it are
kept for 10 years from the end of the year of your purchase, as in the section above.

Why: to answer you (the contract with you); for a withdrawal, a legal duty of the seller.

## Where

The service runs on Cloudflare's infrastructure, and messages and images are stored in
{{STORAGE_REGION}}. Notifications of new messages are delivered to the operator through Telegram,
a provider outside {{CONTROLLER_COUNTRY}}; each notification contains only the app's name, the
platform (such as iOS or Android), whether it is a message or a crash report, and a link with a
random identifier that opens the message in {{CONTROLLER_NAME}}'s admin panel, which only the
operator can sign in to. It contains nothing you wrote.

Mails are delivered through {{MAIL_VENDOR}} ({{MAIL_VENDOR_REGION}}). Delivering a mail means your
address and the mail's text leave Türkiye: {{MAIL_VENDOR}} processes them in {{MAIL_VENDOR_REGION}}.

## Not done

Your data is not sold, shared with advertisers, or used for anything other than answering you. No
mail is used to track you or to advertise.
