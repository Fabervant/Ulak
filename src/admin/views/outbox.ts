import { html } from "hono/html";
import type { MailRow } from "../../core/mail/outbox";

/** Mails waiting or not arrived, with their reason. Never an address, a subject or a body. */
export function outboxView(rows: MailRow[], apps: string[], app?: string) {
  return html`<p class="apps">
      ${apps.map((a) => html`<a href="/outbox?app=${a}">${a}</a>`)}
      <a href="/outbox">all</a>
    </p>
    <p>Queued, failed, given-up, refused, bounced and complained mails of the last 30 days${app ? html` for <strong>${app}</strong>` : ""}.</p>
    <table>
      <tr><th>created</th><th>app</th><th>kind, label</th><th>status</th><th>attempts</th><th>expires</th><th>reason</th></tr>
      ${rows.map(
        (r) => html`<tr>
          <td>${r.created_at.slice(0, 16).replace("T", " ")}</td>
          <td>${r.app}</td>
          <td>${r.kind} ${r.label} ${r.locale}</td>
          <td><span class="badge ${r.status === "queued" ? "" : "pending"}">${r.status}</span></td>
          <td>${r.attempts}</td>
          <td>${r.expires_at.slice(0, 16).replace("T", " ")}</td>
          <td>${r.last_error ?? ""}</td>
        </tr>`,
      )}
    </table>
    ${rows.length ? "" : html`<p>Nothing waiting or failed.</p>`}`;
}
