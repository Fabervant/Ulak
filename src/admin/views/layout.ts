import { html } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";

export const CSS = `
body{font:14px/1.45 system-ui,sans-serif;margin:0;background:#f6f7f9;color:#1c1f24}
header{background:#1f2a3a;color:#fff;padding:.6rem 1rem;display:flex;flex-wrap:wrap;gap:1rem;align-items:center}
header a{color:#fff;text-decoration:none} main{max-width:64rem;margin:1rem auto;padding:0 1rem}
table{width:100%;border-collapse:collapse;background:#fff} td,th{padding:.45rem .6rem;border-bottom:1px solid #e3e6ea;text-align:left;vertical-align:top}
pre{white-space:pre-wrap;word-break:break-word;background:#fff;border:1px solid #e3e6ea;padding:.6rem}
.badge{display:inline-block;padding:.1rem .45rem;border-radius:.6rem;background:#e3e6ea;font-size:12px}
.pending{background:#ffe8a3} form.inline{display:inline} textarea,input,select{font:inherit;width:100%;box-sizing:border-box;margin:.2rem 0 .6rem}
.narrow{width:auto} button{font:inherit;padding:.35rem .8rem} .apps a{margin-right:.8rem} .warn{color:#8a1c1c} code{user-select:all}
a.button{display:inline-block;padding:.35rem .8rem;border:1px solid #8f959e;border-radius:3px;background:#f0f1f3;color:#1c1f24;text-decoration:none} a.button.warn{color:#8a1c1c}
.dialog{display:none;position:fixed;inset:0;z-index:10;padding:1rem;align-items:center;justify-content:center;background:rgba(20,26,36,.45);-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px)}
.dialog:target{display:flex} .dialog .box{background:#fff;color:#1c1f24;border-radius:.5rem;padding:1.2rem;width:100%;max-width:28rem;box-shadow:0 10px 30px rgba(0,0,0,.25)}
.dialog .actions{display:flex;gap:1rem;align-items:center;justify-content:flex-end} .dialog .actions a{color:#1c1f24;text-decoration:underline}
`;

/** An action that destroys or cuts something off asks first: its button opens a dialog over the
 *  dimmed, blurred page, and only the dialog's own button posts. CSS `:target` opens it, since the
 *  CSP allows no script; Cancel clears the fragment. `id` must be unique on the page. */
export function confirmAction(id: string, label: string, question: string, action: string, csrf: string) {
  return html`<a class="button warn" href="#${id}">${label}</a>
    <section class="dialog" id="${id}" role="dialog" aria-modal="true" aria-labelledby="${id}-q">
      <div class="box">
        <p id="${id}-q">${question}</p>
        <form class="actions" method="post" action="${action}">
          <input type="hidden" name="csrf" value="${csrf}" /><a href="#">Cancel</a><button class="warn">${label}</button>
        </form>
      </div>
    </section>`;
}

export function layout(title: string, body: HtmlEscapedString | Promise<HtmlEscapedString>, csrf: string): HtmlEscapedString | Promise<HtmlEscapedString> {
  return html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <title>${title} · Ulak</title>
        <style>
          ${CSS}
        </style>
      </head>
      <body>
        <header>
          <strong>Ulak</strong><a href="/">Messages</a><a href="/apps">Apps</a><a href="/tokens">Tokens</a>
          <form class="inline" method="post" action="/auth/logout" style="margin-left:auto">
            <input type="hidden" name="csrf" value="${csrf}" /><button>Sign out</button>
          </form>
          ${confirmAction("confirm-logout-all", "Sign out everywhere", "Sign out on every device, this one included?", "/auth/logout-all", csrf)}
        </header>
        <main>${body}</main>
      </body>
    </html>`;
}
