import { nowIso } from "./time";
import { MAX_NOTIFY_ATTEMPTS } from "./retention";

export interface CheckResult {
  ok: boolean;
  unnotified_over_10m: number;
  past_retention: number;
  unclaimed_images_over_30m: number;
  /** Informational, not a pass/fail condition: R2 has no free size query, so this is the
   *  sum of what Ulak recorded on upload. Orphans in the bucket would not be counted. */
  stored_images: number;
  stored_image_bytes: number;
}

/** Asserts on results, never on liveness. Any breach makes ok=false. */
export async function runChecks(db: D1Database, now: string = nowIso()): Promise<CheckResult> {
  const one = async (sql: string) => (await db.prepare(sql).bind(now).first<{ n: number }>())?.n ?? 0;
  const unnotified_over_10m = await one(
    `SELECT COUNT(*) n FROM messages WHERE notified_at IS NULL AND notify_attempts < ${MAX_NOTIFY_ATTEMPTS} AND received_at < strftime('%Y-%m-%dT%H:%M:%fZ', ?, '-10 minutes')`,
  );
  const past_retention = await one(
    `SELECT COUNT(*) n FROM messages m JOIN apps a ON a.id=m.app WHERE m.last_activity_at < strftime('%Y-%m-%dT%H:%M:%fZ', ?, '-' || a.retention_days || ' days')`,
  );
  const unclaimed_images_over_30m = await one(`SELECT COUNT(*) n FROM images WHERE message_id IS NULL AND created_at < strftime('%Y-%m-%dT%H:%M:%fZ', ?, '-30 minutes')`);
  const storage = await db.prepare("SELECT COUNT(*) c, COALESCE(SUM(bytes),0) b FROM images").first<{ c: number | null; b: number | null }>();
  return {
    ok: unnotified_over_10m === 0 && past_retention === 0 && unclaimed_images_over_30m === 0,
    unnotified_over_10m,
    past_retention,
    unclaimed_images_over_30m,
    stored_images: storage?.c ?? 0,
    stored_image_bytes: storage?.b ?? 0,
  };
}
