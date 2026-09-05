import { html } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";

export const CSS = `
body{font:14px/1.45 system-ui,sans-serif;margin:0;background:#f6f7f9;color:#1c1f24}
header{background:#1f2a3a;color:#fff;padding:.6rem 1rem;display:flex;gap:1rem;align-items:center}
header a{color:#fff;text-decoration:none} main{max-width:64rem;margin:1rem auto;padding:0 1rem}
table{width:100%;border-collapse:collapse;background:#fff} td,th{padding:.45rem .6rem;border-bottom:1px solid #e3e6ea;text-align:left;vertical-align:top}
pre{white-space:pre-wrap;word-break:break-word;background:#fff;border:1px solid #e3e6ea;padding:.6rem}
.badge{display:inline-block;padding:.1rem .45rem;border-radius:.6rem;background:#e3e6ea;font-size:12px}
.pending{background:#ffe8a3} form.inline{display:inline} textarea,input,select{font:inherit;width:100%;box-sizing:border-box;margin:.2rem 0 .6rem}
.narrow{width:auto} button{font:inherit;padding:.35rem .8rem} .apps a{margin-right:.8rem} .warn{color:#8a1c1c} code{user-select:all}
`;

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
        </header>
        <main>${body}</main>
      </body>
    </html>`;
}
