import type { Env } from "../env";
import type { MessageRow } from "../messages";
import { nowIso } from "../time";
import { buildNotification, notifierFromEnv, type Notifier } from "./notifier";

/** Runs after the response is sent. Records the attempt on the row. Never throws. */
export async function notifyMessage(env: Env, row: MessageRow, notifier?: Notifier): Promise<void> {
  try {
    const n = notifier ?? notifierFromEnv(env);
    await n.send(buildNotification(row, env.ADMIN_URL));
    await env.DB.prepare("UPDATE messages SET notified_at=?, notify_error=NULL, notify_attempts=notify_attempts+1 WHERE id=?").bind(nowIso(), row.id).run();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await env.DB.prepare("UPDATE messages SET notify_error=?, notify_attempts=notify_attempts+1 WHERE id=?")
      .bind(msg.slice(0, 500), row.id)
      .run()
      .catch(() => {});
  }
}
