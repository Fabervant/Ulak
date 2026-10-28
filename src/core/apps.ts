import { sha256Hex, randomToken } from "./ids";
import { nowIso } from "./time";
import { ApiError, invalid } from "./errors";
import { MAIL_KINDS, LABEL } from "./mail/validate";

const appNotFound = (id: string) => new ApiError(404, "not_found", `app ${id} not found`, false);

export interface AppRow {
  id: string;
  key_hash: string;
  retention_days: number;
  images_enabled: boolean;
  notify_enabled: boolean;
  allowed_origins: string[];
  created_at: string;
  /** Whether owner notices have a key; the key itself is shown once and only its hash is kept. */
  has_notice_key: boolean;
  /** Whether the app has a send key (server only, like the notice key). */
  has_send_key: boolean;
  /** The display name of the app's From; its address is derived from the app id. */
  mail_from_name: string | null;
  mail_kinds: string[];
  mail_labels: string[];
}

type AppPatch = Partial<Pick<AppRow, "retention_days" | "images_enabled" | "notify_enabled" | "allowed_origins" | "mail_from_name" | "mail_kinds" | "mail_labels">>;

interface Raw {
  id: string;
  key_hash: string;
  retention_days: number;
  images_enabled: number;
  notify_enabled: number;
  allowed_origins: string;
  created_at: string;
  notice_key_hash: string | null;
  send_key_hash: string | null;
  mail_from_name: string | null;
  mail_kinds: string;
  mail_labels: string;
}

const toRow = ({ notice_key_hash, send_key_hash, ...r }: Raw): AppRow => ({
  ...r,
  images_enabled: r.images_enabled === 1,
  notify_enabled: r.notify_enabled === 1,
  allowed_origins: JSON.parse(r.allowed_origins) as string[],
  has_notice_key: notice_key_hash !== null,
  has_send_key: send_key_hash !== null,
  mail_kinds: JSON.parse(r.mail_kinds) as string[],
  mail_labels: JSON.parse(r.mail_labels) as string[],
});

export const APP_ID = /^[a-z0-9_-]{2,32}$/;
const KEY = /^ulak_[a-z0-9_-]{2,32}_[0-9a-f]{48}$/;
const NOTICE_KEY = /^ulak_notice_[a-z0-9_-]{2,32}_[0-9a-f]{48}$/;
const SEND_KEY = /^ulak_send_[a-z0-9_-]{2,32}_[0-9a-f]{48}$/;
const ORIGIN = /^https?:\/\/[^/\s]+$/;

type Valid = { days: number; images: boolean; notify: boolean; origins: string[]; fromName: string | null; kinds: string[]; labels: string[] };

function validatePatch(cur: AppRow, patch: AppPatch): Valid {
  const days = patch.retention_days ?? cur.retention_days;
  if (!Number.isInteger(days) || days < 1 || days > 3650) throw invalid("retention_days", "retention_days must be 1 to 3650");
  const origins = patch.allowed_origins ?? cur.allowed_origins;
  for (const o of origins) if (!ORIGIN.test(o)) throw invalid("allowed_origins", `bad origin ${o}`);
  const fromName = (patch.mail_from_name === undefined ? cur.mail_from_name : patch.mail_from_name)?.trim() || null;
  if (fromName !== null && (fromName.length > 100 || /[\p{Cc}"<>@]/u.test(fromName))) throw invalid("mail_from_name", "mail_from_name must be up to 100 characters, without quotes, angle brackets or @");
  const kinds = [...new Set(patch.mail_kinds ?? cur.mail_kinds)];
  for (const k of kinds) if (!(MAIL_KINDS as readonly string[]).includes(k)) throw invalid("mail_kinds", `unknown mail kind ${k}`);
  const labels = [...new Set(patch.mail_labels ?? cur.mail_labels)];
  for (const l of labels) if (!LABEL.test(l)) throw invalid("mail_labels", `bad label ${l}; labels match [a-z0-9_.-]{1,64}`);
  if (labels.length > 100) throw invalid("mail_labels", "at most 100 labels");
  return { days, images: patch.images_enabled ?? cur.images_enabled, notify: patch.notify_enabled ?? cur.notify_enabled, origins, fromName, kinds, labels };
}

export async function createApp(db: D1Database, id: string, opts: AppPatch = {}): Promise<{ app: AppRow; key: string }> {
  if (!APP_ID.test(id)) throw invalid("id", "app id must match [a-z0-9_-]{2,32}");
  if (await getApp(db, id)) throw invalid("id", `app ${id} already exists`);
  const defaults: AppRow = { id, key_hash: "", retention_days: 90, images_enabled: false, notify_enabled: false, allowed_origins: [], created_at: "", has_notice_key: false, has_send_key: false, mail_from_name: null, mail_kinds: [], mail_labels: [] };
  const v = validatePatch(defaults, opts);
  const key = randomToken(`ulak_${id}`);
  await db
    .prepare("INSERT INTO apps (id,key_hash,retention_days,images_enabled,notify_enabled,allowed_origins,mail_from_name,mail_kinds,mail_labels,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .bind(id, await sha256Hex(key), v.days, v.images ? 1 : 0, v.notify ? 1 : 0, JSON.stringify(v.origins), v.fromName, JSON.stringify(v.kinds), JSON.stringify(v.labels), nowIso())
    .run();
  return { app: (await getApp(db, id))!, key };
}

export async function getApp(db: D1Database, id: string): Promise<AppRow | null> {
  const r = await db.prepare("SELECT * FROM apps WHERE id=?").bind(id).first<Raw>();
  return r ? toRow(r) : null;
}

export async function findAppByKey(db: D1Database, key: string): Promise<AppRow | null> {
  if (!KEY.test(key)) return null;
  const r = await db.prepare("SELECT * FROM apps WHERE key_hash=?").bind(await sha256Hex(key)).first<Raw>();
  return r ? toRow(r) : null;
}

export async function listApps(db: D1Database): Promise<AppRow[]> {
  return (await db.prepare("SELECT * FROM apps ORDER BY id").all<Raw>()).results.map(toRow);
}

export async function updateApp(db: D1Database, id: string, patch: AppPatch): Promise<void> {
  const cur = await getApp(db, id);
  if (!cur) throw appNotFound(id);
  const v = validatePatch(cur, patch);
  await db
    .prepare("UPDATE apps SET retention_days=?, images_enabled=?, notify_enabled=?, allowed_origins=?, mail_from_name=?, mail_kinds=?, mail_labels=? WHERE id=?")
    .bind(v.days, v.images ? 1 : 0, v.notify ? 1 : 0, JSON.stringify(v.origins), v.fromName, JSON.stringify(v.kinds), JSON.stringify(v.labels), id)
    .run();
}

export async function rotateKey(db: D1Database, id: string): Promise<string> {
  const key = randomToken(`ulak_${id}`);
  const r = await db.prepare("UPDATE apps SET key_hash=? WHERE id=?").bind(await sha256Hex(key), id).run();
  if (!r.meta.changes) throw appNotFound(id);
  return key;
}

/** Issues the app's owner-notice key, replacing any earlier one. It belongs on the app's server only. */
export async function rotateNoticeKey(db: D1Database, id: string): Promise<string> {
  const key = randomToken(`ulak_notice_${id}`);
  const r = await db.prepare("UPDATE apps SET notice_key_hash=? WHERE id=?").bind(await sha256Hex(key), id).run();
  if (!r.meta.changes) throw appNotFound(id);
  return key;
}

export async function findAppByNoticeKey(db: D1Database, key: string): Promise<AppRow | null> {
  if (!NOTICE_KEY.test(key)) return null;
  const r = await db.prepare("SELECT * FROM apps WHERE notice_key_hash=?").bind(await sha256Hex(key)).first<Raw>();
  return r ? toRow(r) : null;
}

/** Issues the app's send key, replacing any earlier one. Mail is sent from the app's server only. */
export async function rotateSendKey(db: D1Database, id: string): Promise<string> {
  const key = randomToken(`ulak_send_${id}`);
  const r = await db.prepare("UPDATE apps SET send_key_hash=? WHERE id=?").bind(await sha256Hex(key), id).run();
  if (!r.meta.changes) throw appNotFound(id);
  return key;
}

export async function findAppBySendKey(db: D1Database, key: string): Promise<AppRow | null> {
  if (!SEND_KEY.test(key)) return null;
  const r = await db.prepare("SELECT * FROM apps WHERE send_key_hash=?").bind(await sha256Hex(key)).first<Raw>();
  return r ? toRow(r) : null;
}

export async function allAllowedOrigins(db: D1Database): Promise<Set<string>> {
  const rows = await db.prepare("SELECT allowed_origins FROM apps").all<{ allowed_origins: string }>();
  return new Set(rows.results.flatMap((r) => JSON.parse(r.allowed_origins) as string[]));
}
