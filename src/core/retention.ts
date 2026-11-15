import type { Env } from "./env";
import { expireMessages, unnotified } from "./messages";
import { notifyMessage } from "./notify/dispatch";
import { nowIso } from "./time";
import { purgeUnclaimedImages } from "./images";
import { purgeNotices } from "./notices";
import { expireMails } from "./mail/outbox";
import { legalConfigState, purgeLegal, remindOpenAlerts, reportCopiesWithoutEnd } from "./mail/legal";

export const MAX_NOTIFY_ATTEMPTS = 5;

export interface ScheduledRun {
  expired: number;
  expired_mails: number;
  purged_legal_copies: number;
  legal_reminder: boolean;
  legal_no_end_report: boolean;
  purged_images: number;
  purged_notices: number;
  retried: number;
}

/** The hourly job: expire messages and mails by retention, delete legal copies past their keeping
 *  period (as set at this run; none while it is unset or bad), remind the operator of open legal
 *  alerts once a day and of subscription copies with no end reported once a year, purge unclaimed images and spent notice counts, retry notifications. */
export async function runScheduled(env: Env, now: string = nowIso()): Promise<ScheduledRun> {
  const expired = await expireMessages(env, now);
  const expired_mails = await expireMails(env.DB, now);
  const legal = legalConfigState(env);
  const purged_legal_copies = legal.state === "set" ? await purgeLegal(env.DB, legal.cfg.keepYears, now) : 0;
  const legal_reminder = await remindOpenAlerts(env, now);
  const legal_no_end_report = legal.state === "set" ? await reportCopiesWithoutEnd(env, legal.cfg.keepYears, now) : false;
  const purged_images = await purgeUnclaimedImages(env, now);
  const purged_notices = await purgeNotices(env.DB, now);
  let retried = 0;
  for (const row of await unnotified(env.DB, MAX_NOTIFY_ATTEMPTS)) {
    await notifyMessage(env, row);
    retried += 1;
  }
  return { expired, expired_mails, purged_legal_copies, legal_reminder, legal_no_end_report, purged_images, purged_notices, retried };
}
