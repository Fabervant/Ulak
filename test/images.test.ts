import { env, createExecutionContext } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import worker from "../src/api/index";
import imagesWorker from "../src/images/index";
import { updateApp } from "../src/core/apps";
import { sniffImageType, purgeUnclaimedImages, getImage, stripJpegMetadata, BindingCodec } from "../src/core/images";
import { signImageUrl } from "../src/core/signedurl";
import { addMinutes, nowIso } from "../src/core/time";
import { PNG as png, JPG_WITH_GPS as jpg, SVG as svg } from "./fixtures";
import { hex, hasJpegMarker, imagesApp, uploadImage, submitWithImages } from "./helpers";
let key: string;
let U: string;

beforeEach(async () => {
  key = await imagesApp();
  U = hex();
});

const upload = (bytes: Uint8Array, ct: string, userRef = U) => uploadImage(key, bytes, ct, userRef);
const submit = (attachments: string[], userRef = U) => submitWithImages(key, attachments, userRef);

describe("sniffImageType", () => {
  it("detects from bytes, not the declared type", () => {
    expect(sniffImageType(png)).toBe("image/png");
    expect(sniffImageType(jpg)).toBe("image/jpeg");
    expect(sniffImageType(svg)).toBeNull();
    expect(sniffImageType(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]))).toBe("image/webp");
  });
});

describe("POST /v1/images", () => {
  it("accepts a PNG, stores a re-encoded copy under an opaque key, returns 201 {id}", async () => {
    const res = await upload(png, "image/png");
    expect(res.status).toBe(201);
    const { id } = await res.json<{ id: string }>();
    const row = (await getImage(env.DB, id))!;
    expect(row.message_id).toBeNull();
    expect(row.width).toBe(8);
    expect(row.height).toBe(6);
    expect(row.r2_key).not.toContain("tiny");
    const stored = await env.IMAGES.get(row.r2_key);
    // The recorded byte count is the re-encoded length, not the uploaded length: the image
    // origin sends it as Content-Length.
    expect(stored!.size).toBe(row.bytes);
  });
  it("strips EXIF: the stored JPEG has no APP1 segment", async () => {
    expect(hasJpegMarker(jpg, 0xe1)).toBe(true); // the fixture really carries EXIF
    const { id } = await (await upload(jpg, "image/jpeg")).json<{ id: string }>();
    const stored = new Uint8Array(await (await env.IMAGES.get((await getImage(env.DB, id))!.r2_key))!.arrayBuffer());
    expect(hasJpegMarker(stored, 0xe1)).toBe(false);
    expect(sniffImageType(stored)).toBe("image/jpeg");
  });
  it("rejects SVG declared as PNG with 415, oversize with 413, and images-off apps with 403", async () => {
    expect((await upload(svg, "image/png")).status).toBe(415);
    const big = new Uint8Array(5 * 1024 * 1024 + 1);
    big.set(png);
    expect((await upload(big, "image/png")).status).toBe(413);
    await updateApp(env.DB, "demo", { images_enabled: false });
    expect((await upload(png, "image/png")).status).toBe(403);
  });
  it("stores, records and serves the sniffed type, never the declared one", async () => {
    // A PNG announced as JPEG is a PNG in the row, in the object's metadata and on the wire.
    const { id } = await (await upload(png, "image/jpeg")).json<{ id: string }>();
    const row = (await getImage(env.DB, id))!;
    expect(row.content_type).toBe("image/png");
    expect((await env.IMAGES.get(row.r2_key))!.httpMetadata?.contentType).toBe("image/png");
    const url = await signImageUrl("t", "https://images.example.invalid", id, Math.floor(Date.now() / 1000) + 600);
    const served = await imagesWorker.fetch(new Request(url), { ...env, IMAGE_URL_SECRET: "t" }, createExecutionContext());
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/png");
  });
});

describe("claim and purge", () => {
  it("submit claims uploaded ids; unknown or foreign ids are 400 and create nothing; unclaimed images purge after 15 minutes", async () => {
    const { id } = await (await upload(png, "image/png")).json<{ id: string }>();
    expect((await submit([crypto.randomUUID()])).status).toBe(400);
    expect((await submit([id], hex())).status).toBe(400);
    expect((await env.DB.prepare("SELECT COUNT(*) n FROM messages").first<{ n: number }>())!.n).toBe(0);
    const ok = await submit([id]);
    expect(ok.status).toBe(201);
    const { id: mid } = await ok.json<{ id: string }>();
    expect((await getImage(env.DB, id))!.message_id).toBe(mid);
    const orphan = await (await upload(png, "image/png")).json<{ id: string }>();
    await env.DB.prepare("UPDATE images SET created_at=? WHERE id=?").bind(addMinutes(nowIso(), -16), orphan.id).run();
    expect(await purgeUnclaimedImages(env, nowIso())).toBe(1);
    expect(await getImage(env.DB, orphan.id)).toBeNull();
    expect(await getImage(env.DB, id)).not.toBeNull();
  });
  it("deleting the message deletes the image row and the object", async () => {
    const { id } = await (await upload(png, "image/png")).json<{ id: string }>();
    await submit([id]);
    const r2Key = (await getImage(env.DB, id))!.r2_key;
    const res = await worker.fetch(
      new Request(`https://api.example.invalid/v1/messages?user_ref=${U}`, { method: "DELETE", headers: { authorization: `Bearer ${key}` } }),
      env,
      createExecutionContext(),
    );
    expect(res.status).toBe(200);
    expect(await getImage(env.DB, id)).toBeNull();
    expect(await env.IMAGES.get(r2Key)).toBeNull();
  });
});

describe("image origin", () => {
  it("serves only with a valid unexpired signature and with attachment headers", async () => {
    const { id } = await (await upload(png, "image/png")).json<{ id: string }>();
    const secret = "test-secret";
    const url = await signImageUrl(secret, "https://images.example.invalid", id, Math.floor(Date.now() / 1000) + 600);
    const e = { ...env, IMAGE_URL_SECRET: secret };
    const good = await imagesWorker.fetch(new Request(url), e, createExecutionContext());
    expect(good.status).toBe(200);
    expect(good.headers.get("content-disposition")).toBe("attachment");
    expect(good.headers.get("x-content-type-options")).toBe("nosniff");
    expect(good.headers.get("content-security-policy")).toBe("default-src 'none'");
    // no-store, not max-age=0: the latter lets the browser keep the body on disk and only
    // revalidate, so an end user's screenshot would survive the admin signing out.
    expect(good.headers.get("cache-control")).toBe("private, no-store");
    // Not the uploaded bytes: the production codec re-encodes, so what the origin serves is
    // what the bucket holds. Comparing against the upload only ever passed because the suite
    // ran the passthrough codec.
    const stored = new Uint8Array(await (await env.IMAGES.get((await getImage(env.DB, id))!.r2_key))!.arrayBuffer());
    const served = new Uint8Array(await good.arrayBuffer());
    expect(served).toEqual(stored);
    expect(sniffImageType(served)).toBe("image/png");
    expect((await imagesWorker.fetch(new Request(url.replace(/sig=[0-9a-f]+/, "sig=00")), e, createExecutionContext())).status).toBe(403);
    const expired = await signImageUrl(secret, "https://images.example.invalid", id, Math.floor(Date.now() / 1000) - 1);
    expect((await imagesWorker.fetch(new Request(expired), e, createExecutionContext())).status).toBe(403);
  });
});

describe("BindingCodec strips metadata the re-encoder leaves behind", () => {
  // Cloudflare's transform keeps the EXIF copyright tag on JPEG by default and, as the first
  // live deployment proved, can return GPS tags intact. The guarantee has to be ours, so this
  // fakes a binding that hands back exactly what it was given - metadata and all.
  const echoBinding = {
    info: async () => ({ width: 8, height: 6 }),
    input(stream: ReadableStream) {
      return {
        output: async () => ({ response: () => new Response(stream) }),
      };
    },
  } as unknown as ImagesBinding;

  it("removes the EXIF segment from a JPEG the binding returns unchanged", async () => {
    const out = await new BindingCodec(echoBinding).reencode(jpg.buffer.slice(0) as ArrayBuffer, "image/jpeg");
    expect(hasJpegMarker(new Uint8Array(out), 0xe1)).toBe(false);
    expect(new Uint8Array(out).slice(0, 2)).toEqual(new Uint8Array([0xff, 0xd8])); // still a JPEG
    expect(out.byteLength).toBeLessThan(jpg.byteLength);
  });
});

describe("stripJpegMetadata", () => {
  it("drops EXIF, XMP and comments but keeps JFIF and the Adobe colour-transform segment", () => {
    const seg = (marker: number, body: number[]) => [0xff, marker, 0x00, body.length + 2, ...body];
    const jpeg = new Uint8Array([
      0xff, 0xd8,
      ...seg(0xe0, [0x4a, 0x46, 0x49, 0x46, 0x00]), // APP0 JFIF
      ...seg(0xe1, [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0x47, 0x50, 0x53]), // APP1 EXIF
      ...seg(0xee, [0x41, 0x64, 0x6f, 0x62, 0x65, 0x00, 0x64, 0x00, 0x00, 0x00, 0x00, 0x01]), // APP14 Adobe, transform=1
      ...seg(0xfe, [0x68, 0x69]), // COM
      0xff, 0xda, 0x00, 0x02, 0x11, 0x22, 0xff, 0xd9,
    ]);
    const out = new Uint8Array(stripJpegMetadata(jpeg.buffer));
    const markers: number[] = [];
    for (let i = 2; i < out.length - 1; ) {
      if (out[i] !== 0xff) break;
      markers.push(out[i + 1]!);
      if (out[i + 1] === 0xda) break;
      i += 2 + ((out[i + 2]! << 8) | out[i + 3]!);
    }
    // Without APP14 a decoder guesses the colour transform, and an Adobe CMYK or RGB JPEG
    // comes back with inverted or shifted colours. The segment holds flags, nothing personal.
    expect(markers).toEqual([0xe0, 0xee, 0xda]);
  });
});
