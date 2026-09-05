import { html } from "hono/html";
import type { AdminTokenRow } from "../../core/auth/admintoken";

export function tokensView(tokens: AdminTokenRow[], csrf: string, created?: { name: string; token: string }) {
  return html`${created
      ? html`<p class="warn">Token <strong>${created.name}</strong>, shown once:</p>
          <pre><code>${created.token}</code></pre>`
      : ""}
    <table>
      <tr><th>name</th><th>created</th><th>last used</th><th>revoked</th><th></th></tr>
      ${tokens.map(
        (t) => html`<tr>
          <td>${t.name}</td>
          <td>${t.created_at}</td>
          <td>${t.last_used_at ?? "-"}</td>
          <td>${t.revoked_at ?? "-"}</td>
          <td>
            ${t.revoked_at
              ? ""
              : html`<form method="post" action="/tokens/${t.id}/revoke"><input type="hidden" name="csrf" value="${csrf}" /><button>Revoke</button></form>`}
          </td>
        </tr>`,
      )}
    </table>
    <h3>New token</h3>
    <p>For the admin API and the MCP server. Full admin scope; revoke when a device is lost.</p>
    <form method="post" action="/tokens">
      <input type="hidden" name="csrf" value="${csrf}" />
      <input name="name" required placeholder="where it will live, e.g. laptop" />
      <button>Create</button>
    </form>`;
}
