import type { Env } from "../env";
import { getApp } from "../apps";
import { nowIso } from "../time";
import { channelFromEnv } from "../notify/notifier";
import { mailConfig, MailConfigError } from "./config";
import { attemptMail, dueMails, failureLine, giveUpExpired, markTold, purgeMailHousekeeping, untoldFailures } from "./outbox";

/** What the timer found of the mail settings: `set`, `unset` or `half_set`. The health check reads it. */
async function recordConfigState(db: D1Database, value: string, now: string): Promise<void> {
  await db.prepare("INSERT INTO service_state (key,value,at) VALUES ('mail_config',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, at=excluded.at").bind(value, now).run();
}

/** Tells the operator, once each, of the mails Ulak stopped trying. A line that cannot be sent waits for the next run. */
export async function tellFailures(env: Env, now: string = nowIso()): Promise<number> {
  const channel = channelFromEnv(env);
  if (!channel) return 0;
  let told = 0;
  for (const r of await untoldFailures(env.DB)) {
    try {
      await channel.send({ text: failureLine(r), adminLink: `${env.ADMIN_URL.replace(/\/$/, "")}/outbox?app=${encodeURIComponent(r.app)}` });
      await markTold(env.DB, r.id, now);
      told += 1;
    } catch (e) {
      console.error("mail failure line", e instanceof Error ? e.message : String(e));
      return told;
    }
  }
  return told;
}

/** The 5-minute job: give up what expired, retry what is due, tell the operator, tidy up. */
export async function runOutbox(env: Env, now: string = nowIso(), transport?: typeof fetch): Promise<{ given_up: number; attempted: number; sent: number; told: number } | { skipped: string }> {
  let cfg;
  try {
    cfg = mailConfig(env);
  } catch (e) {
    if (e instanceof MailConfigError) {
      console.error("mail config", e.message);
      await recordConfigState(env.DB, "half_set", now);
      return { skipped: "mail configuration half set" };
    }
    throw e;
  }
  await recordConfigState(env.DB, cfg ? "set" : "unset", now);
  if (!cfg) return { skipped: "mail not configured" };
  const given_up = (await giveUpExpired(env.DB, now)).length;
  let attempted = 0;
  let sent = 0;
  for (const row of await dueMails(env.DB, now)) {
    const app = await getApp(env.DB, row.app);
    if (!app) continue;
    const out = await attemptMail(env.DB, cfg, row, app, now, transport);
    if (out.result === "not_claimed") continue;
    attempted += 1;
    if (out.status === "sent") sent += 1;
  }
  const told = await tellFailures(env, now);
  await purgeMailHousekeeping(env.DB, now);
  return { given_up, attempted, sent, told };
}
