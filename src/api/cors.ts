import type { MiddlewareHandler } from "hono";
import type { Env } from "../core/env";
import { allAllowedOrigins } from "../core/apps";

/** Browser senders only. Preflight passes for any origin listed by any app; native and server clients never send Origin. */
export function cors(): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const origin = c.req.header("origin");
    if (!origin) return next();
    const allowed = (await allAllowedOrigins(c.env.DB)).has(origin);
    if (c.req.method === "OPTIONS") {
      if (!allowed) return c.body(null, 204);
      return c.body(null, 204, {
        "access-control-allow-origin": origin,
        "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
        "access-control-allow-headers": "authorization, content-type, if-none-match, x-ulak-user-ref",
        "access-control-max-age": "86400",
        vary: "origin",
      });
    }
    await next();
    if (allowed) {
      c.res.headers.set("access-control-allow-origin", origin);
      c.res.headers.append("vary", "origin");
      c.res.headers.set("access-control-expose-headers", "etag, retry-after");
    }
  };
}
