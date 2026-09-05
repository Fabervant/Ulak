import type { Env } from "./env";

/** The edge sets CF-Connecting-IP; X-Forwarded-For is spoofable and trusted only by explicit config. */
export function clientIp(req: Request, env: Env): string {
  const cf = req.headers.get("cf-connecting-ip");
  if (cf) return cf;
  if (env.TRUST_X_FORWARDED_FOR === "true") {
    const xff = req.headers.get("x-forwarded-for");
    if (xff) return xff.split(",")[0]!.trim();
  }
  return "unknown";
}
