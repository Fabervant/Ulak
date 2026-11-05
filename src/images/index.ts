import { Hono } from "hono";
import type { Env } from "../core/env";
import { ApiError } from "../core/errors";
import { getImage } from "../core/images";
import { verifyImageSig } from "../core/signedurl";

const app = new Hono<{ Bindings: Env }>();

const notFound = () => new ApiError(404, "not_found", "not found").toResponse();

app.get("/i/:id", async (c) => {
  const id = c.req.param("id");
  const secret = c.env.IMAGE_URL_SECRET;
  if (!secret) return new ApiError(500, "not_configured", "image origin not configured").toResponse();
  if (!(await verifyImageSig(secret, id, c.req.query("exp") ?? "", c.req.query("sig") ?? ""))) return new ApiError(403, "forbidden", "forbidden").toResponse();
  const row = await getImage(c.env.DB, id);
  if (!row) return notFound();
  const obj = await c.env.IMAGES.get(row.r2_key);
  if (!obj) return notFound();
  return new Response(obj.body, {
    headers: {
      "content-type": row.content_type,
      "content-length": String(row.bytes),
      "content-disposition": "attachment",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'",
      "cache-control": "private, no-store",
    },
  });
});

app.all("*", notFound);

export default { fetch: app.fetch };
