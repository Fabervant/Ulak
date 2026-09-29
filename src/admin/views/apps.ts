import { html } from "hono/html";
import type { AppRow } from "../../core/apps";

/** `newKey` is shown once: the app key goes in the app's config, the notice key on its server only. */
export function appsView(apps: AppRow[], csrf: string, newKey?: { id: string; key: string; notice?: boolean }) {
  return html`${newKey
      ? newKey.notice
        ? html`<p class="warn">Notice key for <strong>${newKey.id}</strong>, shown once. Put it on that app's server only, never in a web page:</p>
            <pre><code>${newKey.key}</code></pre>`
        : html`<p class="warn">Key for <strong>${newKey.id}</strong>, shown once. Put it in that app's own config now:</p>
            <pre><code>${newKey.key}</code></pre>`
      : ""}
    <table>
      <tr><th>app</th><th>retention days, images, owner notices, allowed origins</th><th></th></tr>
      ${apps.map(
        (a) => html`<tr>
          <td>${a.id}</td>
          <td>
            <form method="post" action="/apps/${a.id}" autocomplete="off">
              <input type="hidden" name="csrf" value="${csrf}" />
              <input name="retention_days" type="number" min="1" max="3650" value="${a.retention_days}" class="narrow" />
              <label><input type="checkbox" name="images_enabled" ${a.images_enabled ? "checked" : ""} class="narrow" /> images</label>
              <label><input type="checkbox" name="notify_enabled" ${a.notify_enabled ? "checked" : ""} class="narrow" /> owner notices</label>
              <input name="allowed_origins" value="${a.allowed_origins.join(",")}" placeholder="https://a.example,https://www.a.example" />
              <button>Save</button>
            </form>
          </td>
          <td>
            <form method="post" action="/apps/${a.id}/rotate"><input type="hidden" name="csrf" value="${csrf}" /><button>Rotate key</button></form>
            <form method="post" action="/apps/${a.id}/notice-key"><input type="hidden" name="csrf" value="${csrf}" /><button>New notice key</button></form>
            ${a.has_notice_key ? "notice key set" : "no notice key"}
          </td>
        </tr>`,
      )}
    </table>
    <h3>New app</h3>
    <form method="post" action="/apps" autocomplete="off">
      <input type="hidden" name="csrf" value="${csrf}" />
      <input name="id" pattern="[a-z0-9_-]{2,32}" required placeholder="app id, e.g. myapp" />
      <input name="retention_days" type="number" value="90" min="1" max="3650" />
      <button>Create</button>
    </form>`;
}
