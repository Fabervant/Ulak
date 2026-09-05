import { html } from "hono/html";
import type { MessageRow } from "../../core/messages";
import type { ReplyRow } from "../../core/replies";

/** Everything from the message is interpolated through html``, which escapes it. Never use raw() here. */
export function detailView(m: MessageRow, replies: ReplyRow[], imageUrls: string[], statuses: string[], csrf: string) {
  let context = "";
  try {
    context = m.context ? JSON.stringify(JSON.parse(m.context), null, 2) : "";
  } catch {
    context = m.context ?? "";
  }
  return html`<p><a href="/?app=${m.app}">← ${m.app}</a></p>
    <table>
      <tr><th>received</th><td>${m.received_at}</td><th>client_ts</th><td>${m.client_ts ?? "-"}</td></tr>
      <tr><th>app</th><td>${m.app} ${m.app_version} ${m.app_build ?? ""}</td><th>platform</th><td>${m.platform} ${m.locale ?? ""}</td></tr>
      <tr><th>user_ref</th><td><code>${m.user_ref ?? "(none)"}</code></td><th>contact_email</th><td>${m.contact_email ?? "-"}</td></tr>
      <tr>
        <th>notified</th>
        <td>${m.notified_at ?? html`<span class="warn">not yet (${m.notify_attempts} attempts)${m.notify_error ? `: ${m.notify_error}` : ""}</span>`}</td>
        <th>status</th>
        <td>
          <form class="inline" method="post" action="/m/${m.id}/status">
            <input type="hidden" name="csrf" value="${csrf}" />
            <select name="status" class="narrow">
              ${statuses.map((s) => html`<option value="${s}" ${m.status === s ? "selected" : ""}>${s}</option>`)}
            </select>
            <button>Set</button>
          </form>
        </td>
      </tr>
    </table>
    <h3>Message</h3>
    <pre>${m.message.length ? m.message : "(empty: crash report)"}</pre>
    ${m.last_error ? html`<h3>last_error</h3><pre>${m.last_error}</pre>` : ""}
    ${context ? html`<h3>context</h3><pre>${context}</pre>` : ""}
    ${imageUrls.length ? html`<h3>Images</h3>${imageUrls.map((u, i) => html`<p><a href="${u}">download image ${i + 1}</a></p>`)}` : ""}
    <h3>Replies</h3>
    ${replies.map((r) => html`<pre><strong>${r.sender_role}</strong> ${r.created_at}\n${r.content}</pre>`)}
    <form method="post" action="/m/${m.id}/reply">
      <input type="hidden" name="csrf" value="${csrf}" />
      <textarea name="content" rows="5" required placeholder="Reply in the user's language (${m.locale ?? "unknown locale"})"></textarea>
      <button>Send reply</button>
    </form>
    ${m.user_ref
      ? html`<hr />
          <form method="post" action="/m/${m.id}/delete-user">
            <input type="hidden" name="csrf" value="${csrf}" />
            <button class="warn">Delete all data for this user_ref</button>
            <small>Deletes every message, reply and image of this user in this app. Irreversible.</small>
          </form>`
      : ""}`;
}
