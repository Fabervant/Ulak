import type { Env } from "./env";
import { expireMessages, unnotified } from "./messages";
import { notifyMessage } from "./notify/dispatch";
import { nowIso } from "./time";
import { purgeUnclaimedImages, deleteImageObjects } from "./images";
import { purgeNotices } from "./notices";

export const MAX_NOTIFY_ATTEMPTS = 5;

/** The hourly job: expire by retention, purge unclaimed images and spent notice counts, retry notifications. */
export async function runScheduled(env: Env, now: string = nowIso()): Promise<{ expired: number; purged_images: number; purged_notices: number; retried: number }> {
  const { expired, image_keys } = await expireMessages(env.DB, now);
  await deleteImageObjects(env, image_keys);
  const purged_images = await purgeUnclaimedImages(env, now);
  const purged_notices = await purgeNotices(env.DB, now);
  let retried = 0;
  for (const row of await unnotified(env.DB, MAX_NOTIFY_ATTEMPTS)) {
    await notifyMessage(env, row);
    retried += 1;
  }
  return { expired, purged_images, purged_notices, retried };
}
