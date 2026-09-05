import type { MiddlewareHandler } from "hono";
import type { Env } from "../env";
import { ApiError } from "../errors";
import { findAppByKey, type AppRow } from "../apps";

export type AppVars = { app: AppRow };

export function requireAppKey(): MiddlewareHandler<{ Bindings: Env; Variables: AppVars }> {
  return async (c, next) => {
    const h = c.req.header("authorization") ?? "";
    const key = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
    const app = key ? await findAppByKey(c.env.DB, key) : null;
    if (!app) throw new ApiError(401, "invalid_app_key", "missing or unknown app key", false);
    c.set("app", app);
    await next();
  };
}
