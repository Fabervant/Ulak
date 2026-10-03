import type { Env } from "./env";
import type { AppRow } from "./apps";
import { ApiError } from "./errors";
import { newId } from "./ids";
import { D1_MAX_PARAMS, placeholders } from "./sql";
import { nowIso, addMinutes } from "./time";

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_SIDE = 4096;
const CLAIM_WINDOW_MIN = 15;
type ImageType = "image/png" | "image/jpeg" | "image/webp";

interface ImageRow {
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

export const imageTooLarge = () => new ApiError(413, "payload_too_large", `image exceeds ${MAX_IMAGE_BYTES} bytes`, false, { max_bytes: MAX_IMAGE_BYTES });

/** Type from the file's own bytes; the declared Content-Type and filename are never consulted. */
export function sniffImageType(b: Uint8Array): ImageType | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  return null;
}

/** The image service reports a file it cannot read by throwing its own error type, carrying a
 *  numeric code. That is the client's file, not an outage, so it answers 415 and is never
 *  retryable: a client honouring the flag would resend a file that can never succeed.
 *
 *  Do not switch on the code. Three implementations were observed giving three different
 *  numbers for one undecodable PNG - the live service 9516, the local one 9523, and the type
 *  definitions document 9412 - so a code list would only ever describe wherever it was written.
 *  The numeric code is carried into the response for the operator instead of being matched on.
 *
 *  The one exception is a short list of codes the service's own documentation names as its
 *  own condition - a usage or processing limit, a timeout, a billing or routing setup - which
 *  say nothing about the file. Those are a retryable 503: telling the client to discard a good
 *  file is the mirror image of the loop the 415 prevents. The list only ever moves a code to
 *  503; an unlisted or new number keeps the 415 rule.
 *
 *  Anything thrown without a numeric code did not come from the service refusing the file, so
 *  it stays a retryable 503. Neither branch may fall through to the generic 500. */
const SERVICE_CONDITION_CODES = new Set([
  9422, // usage limit reached
  9432, // account billing cannot use the binding
  9522, // image processing limit exceeded
  9524, // a Worker intercepted the request
  9529, // timed out while processing
]);

function asImageError(e: unknown): ApiError {
  const code = typeof e === "object" && e !== null && "code" in e ? (e as { code: unknown }).code : undefined;
  const unavailable = (extra = {}) => new ApiError(503, "image_service_unavailable", "the image service could not process this upload; retry shortly", true, extra);
  if (typeof code !== "number") return unavailable();
  if (SERVICE_CONDITION_CODES.has(code)) return unavailable({ platform_code: code });
  return new ApiError(415, "unsupported_media_type", "the image could not be decoded; it may be incomplete or damaged", false, { platform_code: code });
}

const dv = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);
const joined = (parts: Uint8Array[]) => new Blob(parts).arrayBuffer();

/** Removes every JPEG metadata segment: APP1-APP15 (EXIF, XMP, ICC, IPTC/Photoshop) and
 *  COM comments. APP0/JFIF is kept because decoders expect it and it carries only density.
 *  APP14/Adobe is kept because it carries only the colour-transform flag, and without it a
 *  decoder guesses the colour space of an Adobe RGB or CMYK file and gets it wrong. */
export function stripJpegMetadata(bytes: ArrayBuffer): Promise<ArrayBuffer> {
  const b = new Uint8Array(bytes);
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return joined([b]);
  const parts: Uint8Array[] = [b.subarray(0, 2)];
  let i = 2;
  while (i < b.length - 3 && b[i] === 0xff) {
    const marker = b[i + 1]!;
    if (marker === 0xda) break; // start of scan: image data follows, stop here
    const len = dv(b).getUint16(i + 2);
    const drop = (marker >= 0xe1 && marker <= 0xef && marker !== 0xee) || marker === 0xfe;
    if (!drop) parts.push(b.subarray(i, i + 2 + len));
    i += 2 + len;
  }
  parts.push(b.subarray(i));
  return joined(parts);
}

/** The PNG chunks a stored image keeps: the critical ones (an upper-case first letter) and the
 *  few ancillary ones that change how the pixels look. Text, EXIF, time, ICC profiles and every
 *  chunk not named here go. A chunk that runs past the end ends the walk; nothing after it is
 *  copied, because the walk can no longer tell metadata from pixels there. */
const PNG_KEPT_ANCILLARY = new Set(["tRNS", "gAMA", "cHRM", "sRGB"]);

function stripPngMetadata(bytes: ArrayBuffer): Promise<ArrayBuffer> {
  const b = new Uint8Array(bytes);
  const parts: Uint8Array[] = [b.subarray(0, 8)];
  for (let i = 8; i + 12 <= b.length; ) {
    const end = i + 12 + dv(b).getUint32(i);
    if (end > b.length) break;
    const type = String.fromCharCode(...b.subarray(i + 4, i + 8));
    if (type.charCodeAt(0) < 0x61 || PNG_KEPT_ANCILLARY.has(type)) parts.push(b.subarray(i, end));
    i = end;
  }
  return joined(parts);
}

/** Removes the EXIF, XMP and ICC chunks from a WebP, clears the flags in its extended header
 *  that announce them, and rewrites the container size. Chunks are padded to an even length. */
const WEBP_DROPPED = new Set(["EXIF", "XMP ", "ICCP"]);
const VP8X_METADATA_FLAGS = 0x20 | 0x08 | 0x04; // ICC, EXIF, XMP

function stripWebpMetadata(bytes: ArrayBuffer): Promise<ArrayBuffer> {
  const b = new Uint8Array(bytes);
  const head = b.slice(0, 12);
  const parts: Uint8Array[] = [head];
  for (let i = 12; i + 8 <= b.length; ) {
    const size = dv(b).getUint32(i + 4, true);
    const end = i + 8 + size + (size & 1);
    if (end > b.length) break;
    const fourcc = String.fromCharCode(...b.subarray(i, i + 4));
    const chunk = b.slice(i, end);
    if (fourcc === "VP8X") chunk[8]! &= ~VP8X_METADATA_FLAGS;
    if (!WEBP_DROPPED.has(fourcc)) parts.push(chunk);
    i = end;
  }
  dv(head).setUint32(4, parts.reduce((n, p) => n + p.byteLength, 0) - 8, true);
  return joined(parts);
}

/** Ulak removes metadata itself rather than trusting a re-encoder's defaults: Cloudflare's
 *  transform keeps the EXIF copyright tag on JPEG by default and was seen returning GPS
 *  coordinates intact, and a default that holds for one format today can change. */
const STRIPPERS: Record<ImageType, (bytes: ArrayBuffer) => Promise<ArrayBuffer>> = {
  "image/jpeg": stripJpegMetadata,
  "image/png": stripPngMetadata,
  "image/webp": stripWebpMetadata,
};

/** A call to the image service, whatever it throws answered as asImageError decides. */
async function fromService<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (e) {
    throw asImageError(e);
  }
}

/** The Images binding decodes and re-encodes; Ulak then strips what the re-encoder left. */
export class BindingCodec {
  constructor(private img: ImagesBinding) {}
  async info(bytes: ArrayBuffer): Promise<{ width: number; height: number }> {
    const i = await fromService(() => this.img.info(new Blob([bytes]).stream()));
    // A vector answers without a width. It is not a raster and Ulak never stores one.
    if (!("width" in i)) throw new ApiError(415, "unsupported_media_type", "not a raster image", false);
    return { width: i.width, height: i.height };
  }
  async reencode(bytes: ArrayBuffer, type: ImageType): Promise<ArrayBuffer> {
    const out = await fromService(async () => (await this.img.input(new Blob([bytes]).stream()).output({ format: type, quality: 85 })).response().arrayBuffer());
    return STRIPPERS[type](out);
  }
}

/** The codec for an app's uploads, or 403 when the app or this instance takes no images. An
 *  instance without the image service refuses uploads rather than store bytes nobody re-encoded. */
export function imageCodecFor(env: Env, app: AppRow): BindingCodec {
  if (!app.images_enabled || !env.IMG) throw new ApiError(403, "images_disabled", "this app does not accept images", false);
  return new BindingCodec(env.IMG);
}

export async function uploadImage(env: Env, codec: BindingCodec, app: AppRow, user_ref: string | null, bytes: ArrayBuffer): Promise<{ id: string }> {
  if (bytes.byteLength > MAX_IMAGE_BYTES) throw imageTooLarge();
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

/** An upload a message may still take: same app and user, not on a message yet. */
const CLAIMABLE = "app=? AND message_id IS NULL AND COALESCE(user_ref,'')=?";

/** A condition, with its binds, that holds when every id is claimable by this app and user. A
 *  repeated id counts once, so a list naming one upload twice never holds. */
export function allClaimable(app: string, user_ref: string | null, ids: string[]): { sql: string; binds: unknown[] } {
  return { sql: `(SELECT COUNT(*) FROM images WHERE id IN (${placeholders(ids.length)}) AND ${CLAIMABLE})=?`, binds: [...ids, app, user_ref ?? "", ids.length] };
}

/** Attaches the ids to the message, if the message exists. Batched after the insert that
 *  checked allClaimable, it claims exactly the images that insert counted, or nothing. */
export function claimStatement(db: D1Database, app: string, user_ref: string | null, messageId: string, ids: string[]): D1PreparedStatement {
  return db
    .prepare(`UPDATE images SET message_id=? WHERE id IN (${placeholders(ids.length)}) AND ${CLAIMABLE} AND EXISTS (SELECT 1 FROM messages WHERE id=?)`)
    .bind(messageId, ...ids, app, user_ref ?? "", messageId);
}

/** Deletes the images a condition selects, objects before rows: an object delete that fails
 *  leaves its row, so the next run retries it and no object outlives its record. */
export async function deleteImagesWhere(env: Env, where: string, binds: unknown[]): Promise<number> {
  let deleted = 0;
  for (;;) {
    const rows = (await env.DB.prepare(`SELECT id, r2_key FROM images WHERE ${where} LIMIT ${D1_MAX_PARAMS}`).bind(...binds).all<{ id: string; r2_key: string }>()).results;
    if (!rows.length) return deleted;
    await env.IMAGES.delete(rows.map((r) => r.r2_key));
    await env.DB.prepare(`DELETE FROM images WHERE id IN (${placeholders(rows.length)})`).bind(...rows.map((r) => r.id)).run();
    deleted += rows.length;
    if (rows.length < D1_MAX_PARAMS) return deleted;
  }
}

export async function purgeUnclaimedImages(env: Env, now: string): Promise<number> {
  return deleteImagesWhere(env, "message_id IS NULL AND created_at < ?", [addMinutes(now, -CLAIM_WINDOW_MIN)]);
}
