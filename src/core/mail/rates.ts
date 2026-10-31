import type { Env } from "../env";
import { addMinutes, nowIso } from "../time";
import { channelFromEnv } from "../notify/notifier";

/** The vendor may close the account, without notice, at these rates (its terms of use). */
export const VENDOR_BOUNCE_LIMIT = 0.05;
export const VENDOR_COMPLAINT_LIMIT = 0.001;
/** The operator is told at half of each limit, while there is time to act. */
export const BOUNCE_ALERT = VENDOR_BOUNCE_LIMIT / 2;
export const COMPLAINT_ALERT = VENDOR_COMPLAINT_LIMIT / 2;
export const RATE_WINDOW_DAYS = 30;

export interface MailRates {
  sent: number;
  bounced: number;
  complained: number;
}

/** Mails the vendor took in the window, and how many of them bounced or drew a spam complaint. */
export async function mailRates(db: D1Database, now: string): Promise<MailRates> {
  const r = await db
    .prepare("SELECT COUNT(*) sent, SUM(status='bounced') bounced, SUM(status='complained') complained FROM mails WHERE sent_at>?")
    .bind(addMinutes(now, -RATE_WINDOW_DAYS * 24 * 60))
    .first<{ sent: number; bounced: number | null; complained: number | null }>();
  return { sent: r?.sent ?? 0, bounced: r?.bounced ?? 0, complained: r?.complained ?? 0 };
}

type Over = "bounce" | "complaint";

/** Which rates are at or past their alert line. */
export function overLines(r: MailRates): Over[] {
  if (!r.sent) return [];
  const over: Over[] = [];
  if (r.bounced / r.sent >= BOUNCE_ALERT) over.push("bounce");
  if (r.complained / r.sent >= COMPLAINT_ALERT) over.push("complaint");
  return over;
}

const pct = (n: number, d: number) => `${((100 * n) / d).toFixed(2)}%`;

/** The operator's line for a rate that passed its alert line. */
export function rateLine(kind: Over, r: MailRates): string {
  return kind === "bounce"
    ? `Mail bounce rate ${pct(r.bounced, r.sent)} (${r.bounced} of ${r.sent} sent in ${RATE_WINDOW_DAYS} days) passed ${pct(BOUNCE_ALERT, 1)}; the vendor may close the account at ${pct(VENDOR_BOUNCE_LIMIT, 1)}`
    : `Mail spam-complaint rate ${pct(r.complained, r.sent)} (${r.complained} of ${r.sent} sent in ${RATE_WINDOW_DAYS} days) passed ${pct(COMPLAINT_ALERT, 1)}; the vendor may close the account at ${pct(VENDOR_COMPLAINT_LIMIT, 1)}`;
}

/** Tells the operator once when a rate passes its alert line, and again only after it has fallen back
 *  under it. A line that cannot be sent is tried again on the next run. Returns the lines sent. */
export async function tellRates(env: Env, now: string = nowIso()): Promise<number> {
  const channel = channelFromEnv(env);
  if (!channel) return 0;
  const r = await mailRates(env.DB, now);
  const over = overLines(r);
  const prev = await env.DB.prepare("SELECT value FROM service_state WHERE key='mail_rates'").first<{ value: string }>();
  const told = new Set((prev?.value ?? "").split(",").filter(Boolean));
  let sent = 0;
  const keep: Over[] = [];
  for (const kind of over) {
    if (told.has(kind)) {
      keep.push(kind);
      continue;
    }
    try {
      await channel.send({ text: rateLine(kind, r), adminLink: `${env.ADMIN_URL.replace(/\/$/, "")}/outbox` });
      keep.push(kind);
      sent += 1;
    } catch (e) {
      console.error("mail rate line", e instanceof Error ? e.message : String(e));
    }
  }
  await env.DB.prepare("INSERT INTO service_state (key,value,at) VALUES ('mail_rates',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, at=excluded.at")
    .bind(keep.join(","), now)
    .run();
  return sent;
}
