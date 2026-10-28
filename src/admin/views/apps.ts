import { html } from "hono/html";
import type { AppRow } from "../../core/apps";
import { confirmAction } from "./layout";

const KEY_NOTES = {
  app: "Put it in that app's own config now:",
  notice: "Put it on that app's server only, never in a web page:",
  send: "Put it on that app's server only, never in a web page. It sends mail as this app:",
} as const;

/** `newKey` is shown once: the app key goes in the app's config, the notice and send keys on its server only. */
export function appsView(apps: AppRow[], csrf: string, newKey?: { id: string; key: string; notice?: boolean; send?: boolean }) {
  const which = newKey?.send ? "send" : newKey?.notice ? "notice" : "app";
  return html`${newKey
      ? html`<p class="warn">${which === "app" ? "Key" : which === "notice" ? "Notice key" : "Send key"} for <strong>${newKey.id}</strong>, shown once. ${KEY_NOTES[which]}</p>
          <pre><code>${newKey.key}</code></pre>`
      : ""}
    <table>
      <tr><th>app</th><th>retention days, images, owner notices, allowed origins; mail: From name, transactional, labels</th><th></th></tr>
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
              <input name="mail_from_name" value="${a.mail_from_name ?? ""}" placeholder="From name, e.g. My App" />
              <label><input type="checkbox" name="mail_transactional" ${a.mail_kinds.includes("transactional") ? "checked" : ""} class="narrow" /> sends transactional mail</label>
              <input name="mail_labels" value="${a.mail_labels.join(",")}" placeholder="mail labels, e.g. confirm_email,password_reset" />
              <button>Save</button>
            </form>
          </td>
          <td>
            ${confirmAction(`rotate-${a.id}`, "Rotate key", `Rotate the key of ${a.id}? Its current key stops working at once, until the app's config holds the new one.`, `/apps/${a.id}/rotate`, csrf)}
            ${confirmAction(`notice-${a.id}`, "New notice key", `Make a new notice key for ${a.id}? Its current notice key stops working at once.`, `/apps/${a.id}/notice-key`, csrf)}
            ${confirmAction(`send-${a.id}`, "New send key", `Make a new send key for ${a.id}? Its current send key stops working at once.`, `/apps/${a.id}/send-key`, csrf)}
            ${a.has_notice_key ? "notice key set" : "no notice key"}; ${a.has_send_key ? "send key set" : "no send key"}
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
