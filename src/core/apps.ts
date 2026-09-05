import { sha256Hex, randomToken } from "./ids";
import { nowIso } from "./time";

export interface AppRow {
  id: string;
  key_hash: string;
  retention_days: number;
  images_enabled: boolean;
  allowed_origins: string[];
  created_at: string;
}

type AppPatch = Partial<Pick<AppRow, "retention_days" | "images_enabled" | "allowed_origins">>;

interface Raw {
  id: string;
  key_hash: string;
  retention_days: number;
  images_enabled: number;
  allowed_origins: string;
  created_at: string;
}

const toRow = (r: Raw): AppRow => ({ ...r, images_enabled: r.images_enabled === 1, allowed_origins: JSON.parse(r.allowed_origins) as string[] });

export const APP_ID = /^[a-z0-9_-]{2,32}$/;
const KEY = /^ulak_[a-z0-9_-]{2,32}_[0-9a-f]{48}$/;
const ORIGIN = /^https?:\/\/[^/\s]+$/;

function validatePatch(cur: AppRow, patch: AppPatch): { days: number; images: boolean; origins: string[] } {
  const days = patch.retention_days ?? cur.retention_days;
  if (!Number.isInteger(days) || days < 1 || days > 3650) throw new Error("retention_days must be 1 to 3650");
  const origins = patch.allowed_origins ?? cur.allowed_origins;
  for (const o of origins) if (!ORIGIN.test(o)) throw new Error(`bad origin ${o}`);
  return { days, images: patch.images_enabled ?? cur.images_enabled, origins };
}

export async function createApp(db: D1Database, id: string, opts: AppPatch = {}): Promise<{ app: AppRow; key: string }> {
  if (!APP_ID.test(id)) throw new Error("app id must match [a-z0-9_-]{2,32}");
  if (await getApp(db, id)) throw new Error(`app ${id} already exists`);
  const defaults: AppRow = { id, key_hash: "", retention_days: 90, images_enabled: false, allowed_origins: [], created_at: "" };
  const { days, images, origins } = validatePatch(defaults, opts);
  const key = randomToken(`ulak_${id}`);
  await db
    .prepare("INSERT INTO apps (id,key_hash,retention_days,images_enabled,allowed_origins,created_at) VALUES (?,?,?,?,?,?)")
    .bind(id, await sha256Hex(key), days, images ? 1 : 0, JSON.stringify(origins), nowIso())
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
  if (!cur) throw new Error(`app ${id} not found`);
  const { days, images, origins } = validatePatch(cur, patch);
  await db.prepare("UPDATE apps SET retention_days=?, images_enabled=?, allowed_origins=? WHERE id=?").bind(days, images ? 1 : 0, JSON.stringify(origins), id).run();
}

export async function rotateKey(db: D1Database, id: string): Promise<string> {
  const key = randomToken(`ulak_${id}`);
  const r = await db.prepare("UPDATE apps SET key_hash=? WHERE id=?").bind(await sha256Hex(key), id).run();
  if (!r.meta.changes) throw new Error(`app ${id} not found`);
  return key;
}

export async function allAllowedOrigins(db: D1Database): Promise<Set<string>> {
  const rows = await db.prepare("SELECT allowed_origins FROM apps").all<{ allowed_origins: string }>();
  return new Set(rows.results.flatMap((r) => JSON.parse(r.allowed_origins) as string[]));
}
