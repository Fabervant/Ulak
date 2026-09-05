import { html } from "hono/html";
import type { MessageRow } from "../../core/messages";

export function listView(rows: MessageRow[], counts: Array<{ app: string; n: number }>, apps: string[], filter: { app?: string; status?: string }, statuses: string[]) {
  const receipt = statuses[0];
  return html`<p class="apps">
      ${apps.map((a) => {
        const n = counts.find((c) => c.app === a)?.n ?? 0;
        return html`<a href="/?app=${a}">${a} <span class="badge ${n ? "pending" : ""}">${n}</span></a>`;
      })}
      <a href="/">all</a>
    </p>
    <form method="get">
      <select name="status" class="narrow">
        <option value="">any status</option>
        ${statuses.map((s) => html`<option value="${s}" ${filter.status === s ? "selected" : ""}>${s}</option>`)}
      </select>
      ${filter.app ? html`<input type="hidden" name="app" value="${filter.app}" />` : ""}
      <button>Filter</button>
    </form>
    <table>
      <tr><th>received</th><th>app</th><th>platform</th><th>status</th><th>message</th></tr>
      ${rows.map(
        (r) =>
          html`<tr>
            <td><a href="/m/${r.id}">${r.received_at.slice(0, 16).replace("T", " ")}</a></td>
            <td>${r.app} ${r.app_version}</td>
            <td>${r.platform} ${r.locale ?? ""}</td>
            <td><span class="badge ${r.status === receipt ? "pending" : ""}">${r.status}</span></td>
            <td>${r.message.length ? r.message.slice(0, 120) : html`<em>crash report</em>`}</td>
          </tr>`,
      )}
    </table>
    ${rows.length ? "" : html`<p>No messages.</p>`}`;
}
