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

Nothing else. The service has no accounts, no tracking, and no analytics.

## Why

Only to read and answer your message. Messages are read by the operator and by assistant tooling
the operator runs to draft replies; a person approves every reply before it is sent.

## For how long

{{RETENTION_DAYS}} days after the last activity on the message (its arrival, the last reply, or the
last status change), after which it is deleted automatically together with its replies and images.

## Deletion on request

If the app offers account deletion, deleting your account also deletes every support message you
sent from it. Otherwise contact {{CONTACT}} and quote the app name; the operator can delete
everything tied to your reference.

## Where

The service runs on Cloudflare's infrastructure. Notifications of new messages are delivered to
the operator through Telegram; the notification contains the message text and the app name.

## Not done

Your data is not sold, shared with advertisers, or used for anything other than answering you.
