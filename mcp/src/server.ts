#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { UlakClient } from "./client.js";

const url = process.env.ULAK_ADMIN_URL;
const token = process.env.ULAK_ADMIN_TOKEN;
if (!url || !token) {
  console.error("ulak-mcp: set ULAK_ADMIN_URL and ULAK_ADMIN_TOKEN");
  process.exit(1);
}
const defaultApp = process.env.ULAK_APP;
const client = new UlakClient(url, token);
const text = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }] });

const server = new McpServer({ name: "ulak", version: "1.0.0" });

server.tool(
  "ulak_list_messages",
  "List support messages, newest first. Filter by app, status, since (ISO 8601). Read-only.",
  { app: z.string().optional(), status: z.string().optional(), since: z.string().optional(), limit: z.number().int().min(1).max(500).optional() },
  async (q) => text(await client.listMessages({ app: q.app ?? defaultApp, status: q.status, since: q.since, limit: q.limit })),
);

server.tool("ulak_get_message", "Read one message in full: text, locale, last_error, context, contact_email, replies, image URLs. Read-only.", { id: z.string() }, async ({ id }) =>
  text(await client.getMessage(id)),
);

server.tool(
  "ulak_reply",
  "Post a reply the user will see inside their app. Write it in the message's locale. This is a write: confirm with the operator before calling.",
  { id: z.string(), content: z.string().min(1).max(8000) },
  async ({ id, content }) => text(await client.reply(id, content)),
);

server.tool("ulak_set_status", "Set a message's status, for example pending, viewed, in_progress, completed, rejected. This is a write.", { id: z.string(), status: z.string() }, async ({ id, status }) =>
  text(await client.setStatus(id, status)),
);

server.tool("ulak_checks", "Run the deployment's result check: unnotified messages, rows past retention, orphaned images.", {}, async () => text(await client.checks()));

await server.connect(new StdioServerTransport());
