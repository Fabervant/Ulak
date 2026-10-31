import type { Env } from "../env";
import { getApp } from "../apps";
import { nowIso } from "../time";
import { channelFromEnv } from "../notify/notifier";
import { mailConfig, MailConfigError, type MailConfig } from "./config";
import { legalConfigState, openUndelivered, recordLegalConfigState, repairLegal, tellAlerts } from "./legal";
import { attemptMail, claimTelling, dueMails, failureLine, giveUpExpired, purgeMailHousekeeping, releaseTelling, untoldFailures } from "./outbox";

/** A run stops taking mails after this long, so two runs five minutes apart never overlap. */
export const RUN_BUDGET_MS = 2 * 60_000;

/** What the timer found of the mail settings: `set`, `unset` or `half_set`. The health check reads it. */
async function recordConfigState(db: D1Database, value: string, now: string): Promise<void> {
  await db.prepare("INSERT INTO service_state (key,value,at) VALUES ('mail_config',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, at=excluded.at").bind(value, now).run();
}

/** Tells the operator, once each, of the mails Ulak stopped trying. Each line is claimed before it is
 *  sent, so a request and the timer never both send it; a line that cannot be sent waits for the next run. */
export async function tellFailures(env: Env, now: string = nowIso()): Promise<number> {
  const channel = channelFromEnv(env);
  if (!channel) return 0;
  let told = 0;
  for (const r of await untoldFailures(env.DB)) {
    if (!(await claimTelling(env.DB, r.id, now))) continue;
    try {
      await channel.send({ text: failureLine(r), adminLink: `${env.ADMIN_URL.replace(/\/$/, "")}/outbox?app=${encodeURIComponent(r.app)}` });
      told += 1;
    } catch (e) {
      console.error("mail failure line", e instanceof Error ? e.message : String(e));
      await releaseTelling(env.DB, r.id);
      return told;
    }
  }
  return told;
}

export interface OutboxRun {
  given_up: number;
  attempted: number;
  sent: number;
  told: number;
  legal_alerts_opened: number;
  legal_alerts_told: number;
  skipped?: string;
}

/** The 5-minute job: give up what expired, retry what is due, tell the operator, tidy up. Giving up
 *  needs no mail settings and runs first, so an expired mail's address and content are deleted on
 *  time even while the settings are missing or half set. The legal alerts need no mail settings either. */
export async function runOutbox(env: Env, now: string = nowIso(), transport?: typeof fetch): Promise<OutboxRun> {
  const run = await runMail(env, now, transport);
  await recordLegalConfigState(env.DB, legalConfigState(env), now);
  await repairLegal(env.DB, now);
  const legal_alerts_opened = await openUndelivered(env.DB, now);
  return { ...run, legal_alerts_opened, legal_alerts_told: await tellAlerts(env, now) };
}

async function runMail(env: Env, now: string, transport?: typeof fetch): Promise<Omit<OutboxRun, "legal_alerts_opened" | "legal_alerts_told">> {
  const started = Date.now();
  const given_up = (await giveUpExpired(env.DB, now)).length;
  await purgeMailHousekeeping(env.DB, now);
  let cfg: MailConfig | null;
  try {
    cfg = mailConfig(env);
  } catch (e) {
    if (!(e instanceof MailConfigError)) throw e;
    console.error("mail config", e.message);
    await recordConfigState(env.DB, "half_set", now);
    return { given_up, attempted: 0, sent: 0, told: await tellFailures(env, now), skipped: "mail configuration half set" };
  }
  await recordConfigState(env.DB, cfg ? "set" : "unset", now);
  if (!cfg) return { given_up, attempted: 0, sent: 0, told: await tellFailures(env, now), skipped: "mail not configured" };
  let attempted = 0;
  let sent = 0;
  for (const row of await dueMails(env.DB, now)) {
    if (Date.now() - started > RUN_BUDGET_MS) break;
    const app = await getApp(env.DB, row.app);
    if (!app) continue;
    const out = await attemptMail(env.DB, cfg, row, app, transport);
    if (out.result === "not_claimed") continue;
    attempted += 1;
    if (out.status === "sent") sent += 1;
  }
  return { given_up, attempted, sent, told: await tellFailures(env, now) };
}
