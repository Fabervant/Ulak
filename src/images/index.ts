import { Hono } from "hono";
import type { Env } from "../core/env";
import { getImage } from "../core/images";
import { verifyImageSig } from "../core/signedurl";

const app = new Hono<{ Bindings: Env }>();

app.get("/i/:id", async (c) => {
  const id = c.req.param("id");
  const secret = c.env.IMAGE_URL_SECRET;
  if (!secret) return c.text("image origin not configured", 500);
  if (!(await verifyImageSig(secret, id, c.req.query("exp") ?? "", c.req.query("sig") ?? ""))) return c.text("forbidden", 403);
  const row = await getImage(c.env.DB, id);
  if (!row) return c.text("not found", 404);
  const obj = await c.env.IMAGES.get(row.r2_key);
  if (!obj) return c.text("not found", 404);
  return new Response(obj.body, {
    headers: {
      "content-type": row.content_type,
      "content-length": String(row.bytes),
      "content-disposition": "attachment",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'",
      "cache-control": "private, max-age=0",
    },
  });
});

app.all("*", (c) => c.text("not found", 404));

export default { fetch: app.fetch };
