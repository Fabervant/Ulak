import type { MiddlewareHandler } from "hono";
import type { Env } from "../env";
import { ApiError } from "../errors";
import { findAppByKey, findAppByNoticeKey, type AppRow } from "../apps";

export type AppVars = { app: AppRow };

/** Bearer key -> app, or 401 `code`. The app key and the server-only notice key are separate doors. */
function requireKey(find: (db: D1Database, key: string) => Promise<AppRow | null>, code: string, what: string): MiddlewareHandler<{ Bindings: Env; Variables: AppVars }> {
  return async (c, next) => {
    const h = c.req.header("authorization") ?? "";
    const key = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
    const app = key ? await find(c.env.DB, key) : null;
    if (!app) throw new ApiError(401, code, `missing or unknown ${what}`, false);
    c.set("app", app);
    await next();
  };
}

export const requireAppKey = () => requireKey(findAppByKey, "invalid_app_key", "app key");
export const requireNoticeKey = () => requireKey(findAppByNoticeKey, "invalid_notice_key", "notice key");
