import { nowIso } from "./time";
import { MAX_NOTIFY_ATTEMPTS } from "./retention";

export interface CheckResult {
  ok: boolean;
  unnotified_over_10m: number;
  past_retention: number;
  unclaimed_images_over_30m: number;
  /** 1 when the outbox timer last found the mail settings half set. */
  mail_config_half_set: number;
  /** Queued mails 15 minutes past their expiry: the outbox timer is not running. */
  mails_stuck: number;
  /** 1 when the outbox timer last found the legal-document settings invalid. */
  legal_config_bad: number;
  /** Informational: open legal alerts are the operator's work, not a fault of Ulak. */
  legal_alerts_open: number;
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
  const mail_config_half_set = await one("SELECT COUNT(*) n FROM service_state WHERE key='mail_config' AND value='half_set' AND at <= ?");
  const mails_stuck = await one(`SELECT COUNT(*) n FROM mails WHERE status='queued' AND expires_at < strftime('%Y-%m-%dT%H:%M:%fZ', ?, '-15 minutes')`);
  const legal_config_bad = await one("SELECT COUNT(*) n FROM service_state WHERE key='legal_config' AND value='bad' AND at <= ?");
  const legal_alerts_open = (await db.prepare("SELECT COUNT(*) n FROM legal_alerts WHERE closed_at IS NULL").first<{ n: number }>())?.n ?? 0;
  const storage = await db.prepare("SELECT COUNT(*) c, COALESCE(SUM(bytes),0) b FROM images").first<{ c: number | null; b: number | null }>();
  return {
    ok: unnotified_over_10m === 0 && past_retention === 0 && unclaimed_images_over_30m === 0 && mail_config_half_set === 0 && mails_stuck === 0 && legal_config_bad === 0,
    unnotified_over_10m,
    past_retention,
    unclaimed_images_over_30m,
    mail_config_half_set,
    mails_stuck,
    legal_config_bad,
    legal_alerts_open,
    stored_images: storage?.c ?? 0,
    stored_image_bytes: storage?.b ?? 0,
  };
}
