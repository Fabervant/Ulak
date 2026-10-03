import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { expect } from "vitest";
import worker from "../src/api/index";
import admin from "../src/admin/index";
import { createApp, updateApp } from "../src/core/apps";
import { validateSubmit } from "../src/core/validate";
import { PNG } from "./fixtures";

/** 32 random hex characters: a fresh user_ref, so each test is its own client to the per-isolate limiters. */
export const hex = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");

/** A random documentation-range address, so tests do not share a per-IP window. */
export const randomIp = () => `203.0.113.${Math.floor(Math.random() * 250) + 1}`;

/** Whether the bytes hold JPEG marker `marker` (0xff followed by it) anywhere. */
export const hasJpegMarker = (b: Uint8Array, marker: number) => {
  for (let i = 0; i < b.length - 1; i++) if (b[i] === 0xff && b[i + 1] === marker) return true;
  return false;
};

/** Creates app "demo" with images enabled and returns its key. */
export async function imagesApp(): Promise<string> {
  const key = (await createApp(env.DB, "demo")).key;
  await updateApp(env.DB, "demo", { images_enabled: true });
  return key;
}

export const uploadImage = (key: string, bytes: Uint8Array, ct: string, userRef: string) =>
  worker.fetch(
    new Request("https://api.example.invalid/v1/images", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": ct, "x-ulak-user-ref": userRef, "cf-connecting-ip": randomIp() },
      body: bytes,
    }),
    env,
    createExecutionContext(),
  );

export const submitWithImages = (key: string, attachments: string[], userRef: string) =>
  worker.fetch(
    new Request("https://api.example.invalid/v1/messages", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "cf-connecting-ip": randomIp() },
      body: JSON.stringify({ app: "demo", app_version: "1", platform: "web", user_ref: userRef, message: "see image", client_msg_id: crypto.randomUUID(), attachments }),
    }),
    env,
    createExecutionContext(),
  );

/** Uploads a PNG and submits a message carrying it; the app needs images enabled. */
export async function imageOnMessage(key: string, userRef: string): Promise<{ imageId: string; messageId: string }> {
  const { id } = await (await uploadImage(key, PNG, "image/png", userRef)).json<{ id: string }>();
  const ok = await submitWithImages(key, [id], userRef);
  expect(ok.status).toBe(201);
  return { imageId: id, messageId: (await ok.json<{ id: string }>()).id };
}

/** A validated submission for app "demo" from one fixed sender; `over` replaces any field. */
export const submission = (over: Record<string, unknown> = {}) =>
  validateSubmit({ app: "demo", app_version: "1", platform: "web", user_ref: "f3a9c2e1d4b5a6978877665544332211", message: "m", client_msg_id: crypto.randomUUID(), ...over });

/** Pins `sub` as an admin of this deployment, as the first Google sign-in would. */
export const pinAdmin = (sub: string) =>
  env.DB.prepare("INSERT INTO admins (sub,email_at_pin,pinned_at) VALUES (?,'a@example.invalid','2026-01-01T00:00:00.000Z')").bind(sub).run();

/** One request to the admin Worker; its background work is finished before the response is read. */
export async function adminRequest(adminEnv: typeof env, path: string, init: RequestInit = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await admin.fetch(new Request(`https://admin.example.invalid${path}`, init), adminEnv, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

/** The database as production's D1 sees it in one respect the local one does not enforce: a
 *  statement that binds more than 100 parameters is refused. */
export function withD1ParamLimit(db: D1Database): D1Database {
  const passThrough = <T extends object>(target: T, override: (key: PropertyKey) => unknown) =>
    new Proxy(target, {
      get(t, k) {
        const own = override(k);
        if (own) return own;
        const v = Reflect.get(t, k);
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
  return passThrough(db, (k) =>
    k === "prepare"
      ? (sql: string) =>
          passThrough(db.prepare(sql), (k2) =>
            k2 === "bind"
              ? (...args: unknown[]) => {
                  if (args.length > 100) throw new Error(`D1 binds at most 100 parameters; this statement bound ${args.length}`);
                  return db.prepare(sql).bind(...args);
                }
              : undefined,
          )
      : undefined,
  );
}

/** `n` messages of app "demo" in one statement, all received and last active at `iso`; their ids
 *  in order. For tests that need more rows than one insert at a time can make in a test's time. */
export async function seedMessages(n: number, iso: string): Promise<string[]> {
  await env.DB.prepare(
    `WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM k WHERE i<?1)
     INSERT INTO messages (id,app,app_version,platform,message,client_msg_id,body_hash,status,received_at,last_activity_at)
     SELECT printf('seed-%04d',i),'demo','1','web','m',printf('seed-%04d',i),'h','pending',?2,?2 FROM k`,
  )
    .bind(n, iso)
    .run();
  return Array.from({ length: n }, (_, i) => `seed-${String(i + 1).padStart(4, "0")}`);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (b: Uint8Array) => {
  let c = 0xffffffff;
  for (const x of b) c = CRC_TABLE[(c ^ x) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const ascii = (s: string) => new TextEncoder().encode(s);

/** A PNG chunk with a correct CRC, so a decoder reads it rather than discarding it. */
export function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, data.length);
  out.set(ascii(type), 4);
  out.set(data, 8);
  v.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** The PNG with `chunks` inserted straight after its header chunk. */
export function pngWith(png: Uint8Array, chunks: Uint8Array[]): Uint8Array {
  const afterHeader = 8 + 12 + new DataView(png.buffer, png.byteOffset).getUint32(8);
  return new Uint8Array([...png.subarray(0, afterHeader), ...chunks.flatMap((c) => [...c]), ...png.subarray(afterHeader)]);
}

/** The chunk types of a PNG, in order. */
export function pngChunkTypes(b: Uint8Array): string[] {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const types: string[] = [];
  for (let i = 8; i + 12 <= b.length; i += 12 + v.getUint32(i)) types.push(String.fromCharCode(...b.subarray(i + 4, i + 8)));
  return types;
}

/** The chunks of a WebP: four-character code and data. */
export function webpChunks(b: Uint8Array): { fourcc: string; data: Uint8Array }[] {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const out: { fourcc: string; data: Uint8Array }[] = [];
  for (let i = 12; i + 8 <= b.length; ) {
    const size = v.getUint32(i + 4, true);
    out.push({ fourcc: String.fromCharCode(...b.subarray(i, i + 4)), data: b.subarray(i + 8, i + 8 + size) });
    i += 8 + size + (size & 1);
  }
  return out;
}

/** A WebP container holding `chunks`, with its size field right. */
export function webpOf(chunks: { fourcc: string; data: Uint8Array }[]): Uint8Array {
  const body = chunks.flatMap(({ fourcc, data }) => {
    const head = new Uint8Array(8);
    head.set(ascii(fourcc));
    new DataView(head.buffer).setUint32(4, data.length, true);
    return [...head, ...data, ...(data.length & 1 ? [0] : [])];
  });
  const out = new Uint8Array([...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WEBP"), ...body]);
  new DataView(out.buffer).setUint32(4, out.length - 8, true);
  return out;
}

/** The WebP rewritten as an extended file announcing and carrying EXIF (with a GPS tag name in
 *  it) and XMP, as a phone camera writes one. */
export function webpWithMetadata(webp: Uint8Array, width: number, height: number): Uint8Array {
  const image = webpChunks(webp).filter((c) => c.fourcc !== "VP8X" && c.fourcc !== "EXIF" && c.fourcc !== "XMP ");
  const vp8x = new Uint8Array(10);
  vp8x[0] = 0x08 | 0x04; // EXIF and XMP present
  const v = new DataView(vp8x.buffer);
  v.setUint16(4, width - 1, true);
  v.setUint16(7, height - 1, true);
  return webpOf([
    { fourcc: "VP8X", data: vp8x },
    ...image,
    { fourcc: "EXIF", data: ascii("Exif\0\0GPSLatitude") },
    { fourcc: "XMP ", data: ascii("<x:xmpmeta>GPS</x:xmpmeta>") },
  ]);
}
