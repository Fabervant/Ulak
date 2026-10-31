import { html } from "hono/html";
import type { CopyView, OpenAlertView } from "../../core/mail/legal";
import { SEARCH_LIMIT } from "../../core/mail/legal";

const at = (iso: string | null) => (iso ? iso.slice(0, 16).replace("T", " ") : "-");

export interface LegalPage {
  alerts: OpenAlertView[];
  search?: { reference: string; app?: string; rows: CopyView[] };
  apps: string[];
  copiesWithoutEnd: number;
}

/** Legal documents. One main action, closing an open alert; the search is the rest of the page.
 *  Never a body or an address: those are only in the download. */
export function legalView(p: LegalPage, csrf: string) {
  return html`${p.alerts.length
      ? html`<h3>Open alerts</h3>
          <table>
            <tr><th>opened</th><th>app</th><th>label</th><th>reference</th><th>version</th><th>alert</th><th>close with a reason</th></tr>
            ${p.alerts.map(
              (a) => html`<tr>
                <td>${at(a.opened_at)}</td>
                <td>${a.app}</td>
                <td>${a.label}</td>
                <td>${a.reference}</td>
                <td>${a.version}</td>
                <td><span class="badge pending">${a.kind}</span></td>
                <td>
                  <form method="post" action="/legal/alerts/${a.id}/close" autocomplete="off">
                    <input type="hidden" name="csrf" value="${csrf}" />
                    <input name="reason" required maxlength="500" placeholder="what was done, e.g. sent by hand on ..." />
                    <input name="replaced_by" placeholder="mail id of the delivered corrected copy (optional)" />
                    <button>Close</button>
                  </form>
                </td>
              </tr>`,
            )}
          </table>`
      : html`<p>No open legal alerts.</p>`}
    ${p.copiesWithoutEnd ? html`<p class="warn">${p.copiesWithoutEnd} subscription cop${p.copiesWithoutEnd === 1 ? "y has" : "ies have"} waited over 400 days for the subscription's end; ask the app.</p>` : ""}
    <form method="get" action="/legal">
      <input name="reference" required maxlength="64" value="${p.search?.reference ?? ""}" placeholder="search by order reference" />
      <select name="app" class="narrow">
        <option value="">any app</option>
        ${p.apps.map((a) => html`<option value="${a}" ${p.search?.app === a ? "selected" : ""}>${a}</option>`)}
      </select>
      <button>Search</button>
    </form>
    ${p.search
      ? p.search.rows.length
        ? html`<table>
            <tr><th>created</th><th>app</th><th>reference</th><th>version</th><th>sent</th><th>delivered</th><th>open alerts</th><th></th></tr>
            ${p.search.rows.map(
              (r) => html`<tr>
                <td>${at(r.created_at)}</td>
                <td>${r.app}</td>
                <td>${r.reference}</td>
                <td>${r.version}</td>
                <td>${at(r.sent_at)}</td>
                <td>${at(r.delivered_at)}</td>
                <td>${r.open_alerts}</td>
                <td><a href="/legal/${r.mail_id}/copy">Download</a> <code>${r.mail_id}</code></td>
              </tr>`,
            )}
          </table>
          ${p.search.rows.length === SEARCH_LIMIT ? html`<p>Showing the newest ${SEARCH_LIMIT}; filter by app to narrow it.</p>` : ""}`
        : html`<p>No copy with that reference.</p>`
      : ""}`;
}
