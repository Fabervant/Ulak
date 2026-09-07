import type { Env } from "./env";
import type { AppRow } from "./apps";
import { ApiError } from "./errors";
import { newId } from "./ids";
import { nowIso, addMinutes } from "./time";

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGE_SIDE = 4096;
export const CLAIM_WINDOW_MIN = 15;
export type ImageType = "image/png" | "image/jpeg" | "image/webp";

export interface ImageRow {
  id: string;
  app: string;
  message_id: string | null;
  user_ref: string | null;
  r2_key: string;
  content_type: string;
  bytes: number;
  width: number;
  height: number;
  created_at: string;
}

/** Type from the file's own bytes; the declared Content-Type and filename are never consulted. */
export function sniffImageType(b: Uint8Array): ImageType | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  return null;
}

export interface ImageCodec {
  info(bytes: ArrayBuffer): Promise<{ width: number; height: number }>;
  reencode(bytes: ArrayBuffer, type: ImageType): Promise<ArrayBuffer>;
}

const notRaster = () => new ApiError(415, "unsupported_media_type", "not a raster image", false);

/** Removes every JPEG metadata segment: APP1-APP15 (EXIF, XMP, ICC, IPTC/Photoshop) and
 *  COM comments. APP0/JFIF is kept because decoders expect it and it carries only density.
 *  Ulak strips metadata itself rather than trusting a re-encoder's defaults: Cloudflare's
 *  transform keeps the EXIF copyright tag on JPEG by default, and defaults can change. */
export function stripJpegMetadata(bytes: ArrayBuffer): ArrayBuffer {
  const b = new Uint8Array(bytes);
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return bytes.slice(0);
  const parts: Uint8Array[] = [b.subarray(0, 2)];
  let i = 2;
  while (i < b.length - 3 && b[i] === 0xff) {
    const marker = b[i + 1]!;
    if (marker === 0xda) break; // start of scan: image data follows, stop here
    const len = dv(b).getUint16(i + 2);
    const drop = (marker >= 0xe1 && marker <= 0xef) || marker === 0xfe;
    if (!drop) parts.push(b.subarray(i, i + 2 + len));
    i += 2 + len;
  }
  parts.push(b.subarray(i));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out.buffer;
}

/** Production: the Images binding re-encodes, then Ulak strips the metadata it leaves behind. */
export class BindingCodec implements ImageCodec {
  constructor(private img: ImagesBinding) {}
  async info(bytes: ArrayBuffer): Promise<{ width: number; height: number }> {
    const i = await this.img.info(new Blob([bytes]).stream());
    if (!("width" in i)) throw notRaster();
    return { width: i.width, height: i.height };
  }
  async reencode(bytes: ArrayBuffer, type: ImageType): Promise<ArrayBuffer> {
    const out = await this.img.input(new Blob([bytes]).stream()).output({ format: type, quality: 85 });
    const encoded = await out.response().arrayBuffer();
    // WebP and PNG output always drops EXIF; JPEG does not, so strip it ourselves.
    return type === "image/jpeg" ? stripJpegMetadata(encoded) : encoded;
  }
}

const dv = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);

/** Tests and local dev without the binding: dimensions from headers, no re-encoding.
 *  Metadata is removed by the same stripper production uses. Not for production. */
export class PassthroughCodec implements ImageCodec {
  async info(bytes: ArrayBuffer): Promise<{ width: number; height: number }> {
    const b = new Uint8Array(bytes);
    const t = sniffImageType(b);
    if (t === "image/png") return { width: dv(b).getUint32(16), height: dv(b).getUint32(20) };
    if (t === "image/jpeg") {
      let i = 2;
      while (i < b.length - 9) {
        if (b[i] !== 0xff) {
          i++;
          continue;
        }
        const marker = b[i + 1]!;
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { height: dv(b).getUint16(i + 5), width: dv(b).getUint16(i + 7) };
        }
        i += 2 + dv(b).getUint16(i + 2);
      }
    }
    if (t === "image/webp") return { width: 1, height: 1 };
    throw notRaster();
  }
  async reencode(bytes: ArrayBuffer, type: ImageType): Promise<ArrayBuffer> {
    return type === "image/jpeg" ? stripJpegMetadata(bytes) : bytes.slice(0);
  }
}

export function codecFromEnv(env: Env): ImageCodec {
  return env.IMG ? new BindingCodec(env.IMG) : new PassthroughCodec();
}

export async function uploadImage(env: Env, codec: ImageCodec, app: AppRow, user_ref: string | null, bytes: ArrayBuffer): Promise<{ id: string }> {
  if (!app.images_enabled) throw new ApiError(403, "images_disabled", "this app does not accept images", false);
  if (bytes.byteLength > MAX_IMAGE_BYTES) throw new ApiError(413, "payload_too_large", `image exceeds ${MAX_IMAGE_BYTES} bytes`, false, { max_bytes: MAX_IMAGE_BYTES });
  const type = sniffImageType(new Uint8Array(bytes));
  if (!type) throw new ApiError(415, "unsupported_media_type", "only PNG, JPEG and WebP are accepted", false);
  const { width, height } = await codec.info(bytes);
  if (width > MAX_IMAGE_SIDE || height > MAX_IMAGE_SIDE) throw new ApiError(413, "payload_too_large", `image exceeds ${MAX_IMAGE_SIDE} pixels per side`, false, { max_side: MAX_IMAGE_SIDE });
  const clean = await codec.reencode(bytes, type);
  const id = newId();
  const r2_key = `img/${app.id}/${id}`;
  await env.IMAGES.put(r2_key, clean, { httpMetadata: { contentType: type } });
  await env.DB.prepare("INSERT INTO images (id,app,message_id,user_ref,r2_key,content_type,bytes,width,height,created_at) VALUES (?,?,NULL,?,?,?,?,?,?,?)")
    .bind(id, app.id, user_ref, r2_key, type, clean.byteLength, width, height, nowIso())
    .run();
  return { id };
}

export async function getImage(db: D1Database, id: string): Promise<ImageRow | null> {
  return db.prepare("SELECT * FROM images WHERE id=?").bind(id).first<ImageRow>();
}

export async function listImagesFor(db: D1Database, messageId: string): Promise<ImageRow[]> {
  return (await db.prepare("SELECT * FROM images WHERE message_id=? ORDER BY created_at").bind(messageId).all<ImageRow>()).results;
}

/** How many of these ids are uploaded, unclaimed, and owned by this app and user. */
export async function countClaimable(db: D1Database, app: string, user_ref: string | null, ids: string[]): Promise<number> {
  if (!ids.length) return 0;
  const ph = ids.map(() => "?").join(",");
  const r = await db
    .prepare(`SELECT COUNT(*) n FROM images WHERE id IN (${ph}) AND app=? AND message_id IS NULL AND COALESCE(user_ref,'')=?`)
    .bind(...ids, app, user_ref ?? "")
    .first<{ n: number }>();
  return r?.n ?? 0;
}

/** Attaches uploaded, unclaimed images of the same app and user to a message. Any bad id fails with 400. */
export async function claimImages(db: D1Database, app: string, user_ref: string | null, messageId: string, ids: string[]): Promise<void> {
  for (const id of ids) {
    const r = await db
      .prepare("UPDATE images SET message_id=? WHERE id=? AND app=? AND message_id IS NULL AND COALESCE(user_ref,'')=?")
      .bind(messageId, id, app, user_ref ?? "")
      .run();
    if (!r.meta.changes) throw new ApiError(400, "invalid_request", `attachment ${id} is unknown, already used, or not yours`, false, { field: "attachments" });
  }
}

export async function purgeUnclaimedImages(env: Env, now: string): Promise<number> {
  const cutoff = addMinutes(now, -CLAIM_WINDOW_MIN);
  const rows = (await env.DB.prepare("SELECT id, r2_key FROM images WHERE message_id IS NULL AND created_at < ?").bind(cutoff).all<{ id: string; r2_key: string }>()).results;
  if (!rows.length) return 0;
  await deleteImageObjects(env, rows.map((r) => r.r2_key));
  await env.DB.prepare(`DELETE FROM images WHERE id IN (${rows.map(() => "?").join(",")})`).bind(...rows.map((r) => r.id)).run();
  return rows.length;
}

export async function deleteImageObjects(env: Env, keys: string[]): Promise<void> {
  await Promise.all(keys.map((k) => env.IMAGES.delete(k)));
}
