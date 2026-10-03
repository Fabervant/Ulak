import { env, createExecutionContext } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import worker from "../src/api/index";
import imagesWorker from "../src/images/index";
import { getApp, updateApp } from "../src/core/apps";
import { sniffImageType, purgeUnclaimedImages, getImage, stripJpegMetadata, BindingCodec, uploadImage as storeImage } from "../src/core/images";
import { signImageUrl } from "../src/core/signedurl";
import { addMinutes, nowIso } from "../src/core/time";
import { PNG as png, JPG_WITH_GPS as jpg, SVG as svg } from "./fixtures";
import { hex, hasJpegMarker, imagesApp, uploadImage, submitWithImages, pngChunk, pngWith, pngChunkTypes, webpChunks, webpWithMetadata, withD1ParamLimit } from "./helpers";
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
    const recent = await (await upload(png, "image/png")).json<{ id: string }>();
    await env.DB.prepare("UPDATE images SET created_at=? WHERE id=?").bind(addMinutes(nowIso(), -14), recent.id).run();
    expect(await purgeUnclaimedImages(env, nowIso())).toBe(1);
    expect(await getImage(env.DB, orphan.id)).toBeNull();
    expect(await getImage(env.DB, recent.id)).not.toBeNull(); // inside the window: the client may still submit it
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
    // Not the uploaded bytes: the codec re-encodes, so what the origin serves is what the
    // bucket holds.
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
  it("drops EXIF, XMP, ICC, IPTC, every other APPn and comments but keeps JFIF and the Adobe colour-transform segment", async () => {
    const seg = (marker: number, body: number[]) => [0xff, marker, 0x00, body.length + 2, ...body];
    const jpeg = new Uint8Array([
      0xff, 0xd8,
      ...seg(0xe0, [0x4a, 0x46, 0x49, 0x46, 0x00]), // APP0 JFIF
      ...seg(0xe1, [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0x47, 0x50, 0x53]), // APP1 EXIF
      ...seg(0xe2, [0x49, 0x43, 0x43, 0x5f, 0x50, 0x52, 0x4f, 0x46, 0x49, 0x4c, 0x45, 0x00]), // APP2 ICC_PROFILE
      ...seg(0xed, [0x50, 0x68, 0x6f, 0x74, 0x6f, 0x73, 0x68, 0x6f, 0x70]), // APP13 Photoshop/IPTC
      ...seg(0xef, [0x01, 0x02]), // APP15
      ...seg(0xee, [0x41, 0x64, 0x6f, 0x62, 0x65, 0x00, 0x64, 0x00, 0x00, 0x00, 0x00, 0x01]), // APP14 Adobe, transform=1
      ...seg(0xfe, [0x68, 0x69]), // COM
      0xff, 0xda, 0x00, 0x02, 0x11, 0x22, 0xff, 0xd9,
    ]);
    const out = new Uint8Array(await stripJpegMetadata(jpeg.buffer));
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

// The same promise for the two other formats. Each is checked twice: through the real local
// image service, and through a binding that returns its input untouched, because the guarantee
// is Ulak's own and must hold whatever the re-encoder keeps.
describe("PNG and WebP keep no metadata", () => {
  const text = (s: string) => new TextEncoder().encode(s);
  const pngMeta = () =>
    pngWith(png, [
      pngChunk("tEXt", text("Comment\0taken at home")),
      pngChunk("eXIf", text("MM\0*GPSLatitude")),
      pngChunk("tIME", new Uint8Array([0x07, 0xea, 1, 1, 0, 0, 0])),
    ]);
  const webpMeta = async () => {
    const plain = new Uint8Array(await (await env.IMG!.input(new Blob([png]).stream()).output({ format: "image/webp" })).response().arrayBuffer());
    return webpWithMetadata(plain, 8, 6);
  };
  const stored = async (id: string) => new Uint8Array(await (await env.IMAGES.get((await getImage(env.DB, id))!.r2_key))!.arrayBuffer());
  const echoBinding = {
    info: async () => ({ width: 8, height: 6 }),
    input: (stream: ReadableStream) => ({ output: async () => ({ response: () => new Response(stream) }) }),
  } as unknown as ImagesBinding;

  it("the fixtures really carry the metadata, and the service reads them", async () => {
    expect(pngChunkTypes(pngMeta())).toEqual(expect.arrayContaining(["tEXt", "eXIf", "tIME"]));
    const webp = await webpMeta();
    expect(webpChunks(webp).map((c) => c.fourcc)).toEqual(expect.arrayContaining(["VP8X", "EXIF", "XMP "]));
    expect(await env.IMG!.info(new Blob([webp]).stream())).toMatchObject({ width: 8, height: 6 });
  });

  it("an uploaded PNG is stored with only its image chunks", async () => {
    const res = await upload(pngMeta(), "image/png");
    expect(res.status).toBe(201);
    const types = pngChunkTypes(await stored((await res.json<{ id: string }>()).id));
    expect(types.filter((t) => !["IHDR", "PLTE", "IDAT", "IEND", "tRNS", "gAMA", "cHRM", "sRGB"].includes(t))).toEqual([]);
    expect(types[0]).toBe("IHDR");
    expect(types.at(-1)).toBe("IEND");
  });

  it("an uploaded WebP is stored without EXIF or XMP, and its header no longer announces them", async () => {
    const res = await upload(await webpMeta(), "image/webp");
    expect(res.status).toBe(201);
    const out = await stored((await res.json<{ id: string }>()).id);
    expect(sniffImageType(out)).toBe("image/webp");
    const chunks = webpChunks(out);
    expect(chunks.map((c) => c.fourcc)).not.toEqual(expect.arrayContaining(["EXIF"]));
    expect(chunks.map((c) => c.fourcc)).not.toEqual(expect.arrayContaining(["XMP "]));
    const vp8x = chunks.find((c) => c.fourcc === "VP8X");
    if (vp8x) expect(vp8x.data[0]! & (0x20 | 0x08 | 0x04)).toBe(0);
  });

  it("a re-encoder that hands the metadata back changes nothing: Ulak strips both formats itself", async () => {
    const codec = new BindingCodec(echoBinding);
    const p = new Uint8Array(await codec.reencode(pngMeta().slice().buffer, "image/png"));
    expect(pngChunkTypes(p)).toEqual(pngChunkTypes(png));
    const w = new Uint8Array(await codec.reencode((await webpMeta()).slice().buffer, "image/webp"));
    const chunks = webpChunks(w);
    expect(chunks.map((c) => c.fourcc)).toEqual(["VP8X", ...webpChunks(await webpMeta()).map((c) => c.fourcc).filter((f) => f !== "VP8X" && f !== "EXIF" && f !== "XMP ")]);
    expect(chunks[0]!.data[0]! & (0x08 | 0x04)).toBe(0);
    expect(new DataView(w.buffer).getUint32(4, true)).toBe(w.length - 8); // container size rewritten
    expect(await env.IMG!.info(new Blob([w]).stream())).toMatchObject({ width: 8, height: 6 }); // still a valid WebP
  });
});

describe("pixel limit", () => {
  const sized = (width: number, height: number) =>
    new BindingCodec({
      info: async () => ({ width, height }),
      input: (stream: ReadableStream) => ({ output: async () => ({ response: () => new Response(stream) }) }),
    } as unknown as ImagesBinding);
  const app = async () => (await getApp(env.DB, "demo"))!;

  it("refuses an image over 4096 pixels on either side with 413 and accepts one of exactly 4096", async () => {
    for (const [w, h] of [[4097, 1], [1, 4097]] as const) {
      await expect(storeImage(env, sized(w, h), await app(), U, png.slice().buffer)).rejects.toMatchObject({
        status: 413,
        code: "payload_too_large",
        retryable: false,
        extra: { max_side: 4096 },
      });
    }
    await expect(storeImage(env, sized(4096, 4096), await app(), U, png.slice().buffer)).resolves.toMatchObject({ id: expect.any(String) });
  });
});

describe("attaching is all or nothing", () => {
  it("two submits racing for one image: one message keeps it, the other is refused and saves nothing", async () => {
    const { id } = await (await upload(png, "image/png")).json<{ id: string }>();
    const results = await Promise.all([submit([id]), submit([id]), submit([id])]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 400, 400]);
    const messages = await env.DB.prepare("SELECT id FROM messages").all<{ id: string }>();
    expect(messages.results).toHaveLength(1);
    expect((await getImage(env.DB, id))!.message_id).toBe(messages.results[0]!.id);
  });

  it("a message naming one upload twice is refused, not saved with one image", async () => {
    const { id } = await (await upload(png, "image/png")).json<{ id: string }>();
    expect((await submit([id, id])).status).toBe(400);
    expect((await env.DB.prepare("SELECT COUNT(*) n FROM messages").first<{ n: number }>())!.n).toBe(0);
  });
});

describe("D1's 100-parameter limit", () => {
  it("purges more unclaimed images than one statement may bind", async () => {
    const old = addMinutes(nowIso(), -60);
    const ids = Array.from({ length: 150 }, () => crypto.randomUUID());
    await env.DB.batch(
      ids.map((id) =>
        env.DB.prepare("INSERT INTO images (id,app,message_id,user_ref,r2_key,content_type,bytes,width,height,created_at) VALUES (?,'demo',NULL,?,?,'image/png',1,1,1,?)").bind(id, U, `img/demo/${id}`, old),
      ),
    );
    await Promise.all(ids.map((id) => env.IMAGES.put(`img/demo/${id}`, "x")));
    expect(await purgeUnclaimedImages({ ...env, DB: withD1ParamLimit(env.DB) }, nowIso())).toBe(150);
    expect((await env.DB.prepare("SELECT COUNT(*) n FROM images").first<{ n: number }>())!.n).toBe(0);
    expect((await env.IMAGES.list()).objects).toHaveLength(0);
  });
});
