# ulak-mcp

A small [Model Context Protocol](https://modelcontextprotocol.io) server that lets an assistant such
as Claude Code read your Ulak support messages and, with your approval, reply to them. It wraps the
Ulak admin API; Ulak itself calls no AI provider.

## Build

```sh
cd mcp
npm install
npm run build
```

## Configure

1. On your Ulak admin surface, open **Tokens** and create a token. It is shown once.
2. Tell your assistant where the server is. For Claude Code, copy `.mcp.json.example` from the
   repository root to `.mcp.json` in the project you work in and fill it in:

```json
{
  "mcpServers": {
    "ulak": {
      "command": "node",
      "args": ["/path/to/Ulak/mcp/dist/server.js"],
      "env": {
        "ULAK_ADMIN_URL": "https://admin.example.invalid",
        "ULAK_ADMIN_TOKEN": "the token from step 1",
        "ULAK_APP": "myapp"
      }
    }
  }
}
```

`ULAK_APP` is optional; it filters `ulak_list_messages` to one app by default, which is what you
want when the assistant is working in that app's own repository.

## Tools

| Tool | Kind | What it does |
|---|---|---|
| `ulak_list_messages` | read | newest messages, filtered by app, status, since |
| `ulak_get_message` | read | one message with locale, error, context, email, replies, image links |
| `ulak_reply` | write | posts a reply the user sees inside their app |
| `ulak_set_status` | write | sets the message status |
| `ulak_checks` | read | the deployment's result check |

Replies and status changes are writes; a well-behaved assistant asks before calling them, and
Claude Code shows its normal permission prompt. Write replies in the message's locale: the
message carries it, and the reply text is delivered verbatim.

Revoke the token on the Tokens page if the machine that holds it is lost.
