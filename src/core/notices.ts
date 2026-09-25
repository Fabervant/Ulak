import { ApiError } from "./errors";
import { newId } from "./ids";
import { addMinutes } from "./time";

export const NOTICE_MAX_CHARS = 500;
export const NOTICE_DAILY_LIMIT = 10;
const DAY_MINUTES = 24 * 60;

/** The notice text from a request body `{ text }`: a non-blank string of at most NOTICE_MAX_CHARS. */
export function validateNotice(raw: unknown): string {
  const text = (raw as { text?: unknown } | null)?.text;
  if (typeof text !== "string" || !text.trim()) throw new ApiError(400, "invalid_request", "text is required", false, { field: "text" });
  if ([...text].length > NOTICE_MAX_CHARS) throw new ApiError(400, "invalid_request", `text exceeds ${NOTICE_MAX_CHARS} characters`, false, { field: "text", max_chars: NOTICE_MAX_CHARS });
  return text.trim();
}

/** Records one notice for `app` unless it already sent NOTICE_DAILY_LIMIT in the last 24 hours.
 *  The count and the insert are one statement, so parallel requests cannot pass the ceiling together. */
export async function reserveNotice(db: D1Database, app: string, now: string): Promise<string | null> {
  const id = newId();
  const { meta } = await db
    .prepare("INSERT INTO notices (id,app,created_at) SELECT ?1,?2,?3 WHERE (SELECT COUNT(*) FROM notices WHERE app=?2 AND created_at>?4) < ?5")
    .bind(id, app, now, addMinutes(now, -DAY_MINUTES), NOTICE_DAILY_LIMIT)
    .run();
  return meta.changes ? id : null;
}

/** Gives a reservation back when the notice could not be delivered, so a retry does not spend the ceiling. */
export async function releaseNotice(db: D1Database, id: string): Promise<void> {
  await db.prepare("DELETE FROM notices WHERE id=?").bind(id).run();
}

/** Rows older than the ceiling's window count for nothing; the hourly job removes them. */
export async function purgeNotices(db: D1Database, now: string): Promise<number> {
  const { meta } = await db.prepare("DELETE FROM notices WHERE created_at<=?").bind(addMinutes(now, -DAY_MINUTES)).run();
  return meta.changes;
}
