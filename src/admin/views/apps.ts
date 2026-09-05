import { html } from "hono/html";
import type { AppRow } from "../../core/apps";

export function appsView(apps: AppRow[], csrf: string, newKey?: { id: string; key: string }) {
  return html`${newKey
      ? html`<p class="warn">Key for <strong>${newKey.id}</strong>, shown once. Put it in that app's own config now:</p>
          <pre><code>${newKey.key}</code></pre>`
      : ""}
    <table>
      <tr><th>app</th><th>retention days, images, allowed origins</th><th></th></tr>
      ${apps.map(
        (a) => html`<tr>
          <td>${a.id}</td>
          <td>
            <form method="post" action="/apps/${a.id}">
              <input type="hidden" name="csrf" value="${csrf}" />
              <input name="retention_days" type="number" min="1" max="3650" value="${a.retention_days}" class="narrow" />
              <label><input type="checkbox" name="images_enabled" ${a.images_enabled ? "checked" : ""} class="narrow" /> images</label>
              <input name="allowed_origins" value="${a.allowed_origins.join(",")}" placeholder="https://a.example,https://www.a.example" />
              <button>Save</button>
            </form>
          </td>
          <td>
            <form method="post" action="/apps/${a.id}/rotate"><input type="hidden" name="csrf" value="${csrf}" /><button>Rotate key</button></form>
          </td>
        </tr>`,
      )}
    </table>
    <h3>New app</h3>
    <form method="post" action="/apps">
      <input type="hidden" name="csrf" value="${csrf}" />
      <input name="id" pattern="[a-z0-9_-]{2,32}" required placeholder="app id, e.g. myapp" />
      <input name="retention_days" type="number" value="90" min="1" max="3650" />
      <button>Create</button>
    </form>`;
}
