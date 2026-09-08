// Every dependency-injection seam whose default only runs in production, exercised through
// that default. Three of the defects the first deployment exposed lived in the gap between an
// injected double and the real platform, so a seam that exists for testing needs something
// that drives the production side of it. docs/seam-audit.md is the inventory this file backs;
// it also records the two seams that cannot be driven here and what covers them instead.
import { env, createExecutionContext } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import worker from "../src/api/index";
import imagesWorker from "../src/images/index";
import adminWorker from "../src/admin/index";
import { createApp, updateApp } from "../src/core/apps";
import { BindingCodec, PassthroughCodec, codecFromEnv, getImage, deleteImageObjects } from "../src/core/images";
import { BindingRateLimiter, MemoryRateLimiter, limiterFor } from "../src/core/ratelimit";
import { defaultFetch } from "../src/core/http";
import { createAdminToken } from "../src/core/auth/admintoken";
import { PNG as png, JPG_WITH_GPS as jpg, SVG as svg } from "./fixtures";

const buf = (u: Uint8Array): ArrayBuffer => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
const hex = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
/** A vector the image service can actually decode. The fixture SVG has no intrinsic size, so
 *  the service refuses it outright; this one is answered normally - with a format and no width,
 *  which is the branch that keeps a vector out of the bucket. */
const decodableSvg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="6"><rect width="8" height="6" fill="#123"/><script>alert(1)</script></svg>');
/** A real PNG signature and IHDR followed by nothing usable: it passes the byte sniff and only
 *  the codec can tell it is not an image. */
const truncatedPng = new Uint8Array([...png.subarray(0, 24), 0, 0, 0, 0, 0, 0, 0, 0]);
const hasMarker = (b: Uint8Array, m: number) => {
  for (let i = 0; i < b.length - 1; i++) if (b[i] === 0xff && b[i + 1] === m) return true;
  return false;
};

let key: string;
let U: string;
beforeEach(async () => {
  key = (await createApp(env.DB, "demo")).key;
  await updateApp(env.DB, "demo", { images_enabled: true });
  U = hex();
});

const upload = (bytes: Uint8Array, ct: string, userRef = U) =>
  worker.fetch(
    new Request("https://api.example.invalid/v1/images", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": ct, "x-ulak-user-ref": userRef, "cf-connecting-ip": `203.0.113.${Math.floor(Math.random() * 250) + 1}` },
      body: bytes,
    }),
    env,
    createExecutionContext(),
  );

const submit = (attachments: string[], userRef = U) =>
  worker.fetch(
    new Request("https://api.example.invalid/v1/messages", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "cf-connecting-ip": `203.0.113.${Math.floor(Math.random() * 250) + 1}` },
      body: JSON.stringify({ app: "demo", app_version: "1", platform: "web", user_ref: userRef, message: "see image", client_msg_id: crypto.randomUUID(), attachments }),
    }),
    env,
    createExecutionContext(),
  );

// ── Seam 1: the image codec ─────────────────────────────────────────────────────────────────
// codecFromEnv returns BindingCodec when the Images binding is present and PassthroughCodec
// when it is not. Until this session the test config bound no image service, so every test in
// the suite ran the passthrough and nothing ever drove BindingCodec.info. The test config now
// binds the image service, which means the whole suite runs the production branch.
//
// Caveat, stated in docs/seam-audit.md too: the local image service is backed by libvips, not
// by the codec Cloudflare runs in production. This proves our side of the seam - the branch
// taken, the stream plumbing, the shape of the info response, the guard on a non-raster - and
// it does not prove that the production codec answers the same way.
describe("seam: image codec", () => {
  it("codecFromEnv takes the production branch whenever the binding exists", () => {
    expect(codecFromEnv(env)).toBeInstanceOf(BindingCodec);
    expect(codecFromEnv({ ...env, IMG: undefined })).toBeInstanceOf(PassthroughCodec);
  });

  it("BindingCodec.info reads real dimensions from PNG and JPEG through the binding", async () => {
    const codec = new BindingCodec(env.IMG!);
    expect(await codec.info(buf(png))).toEqual({ width: 8, height: 6 });
    expect(await codec.info(buf(jpg))).toEqual({ width: 8, height: 6 });
  });

  it("BindingCodec.info answers 415 on a vector, which the binding decodes but Ulak cannot store", async () => {
    // The binding reads the SVG and answers without a width. That branch is the only thing
    // between a script-bearing vector and the bucket, and the passthrough codec can never
    // reach it, because it reads the header itself and never asks a service.
    await expect(new BindingCodec(env.IMG!).info(buf(decodableSvg))).rejects.toMatchObject({ status: 415, code: "unsupported_media_type" });
  });

  it("any numeric platform code is a 415, whatever the number, and a codeless throw is a 503", async () => {
    // The live service, the local service and the type definitions each report one undecodable
    // PNG with a different number - 9516, 9523 and 9412. A test that pinned any one of them
    // would only describe the implementation it was written against, which is the whole failure
    // this audit exists to stop. What is asserted is the rule: a number means the service read
    // the file and refused it, so 415 and never retryable; no number means it never got that
    // far, so 503 and retryable.
    const throwing = (extra: object) =>
      ({ info: async () => { throw Object.assign(new Error("service said no"), extra); } }) as unknown as ImagesBinding;
    for (const code of [9412, 9516, 9523]) {
      await expect(new BindingCodec(throwing({ code })).info(buf(png))).rejects.toMatchObject({
        status: 415,
        code: "unsupported_media_type",
        retryable: false,
        extra: { platform_code: code },
      });
    }
    await expect(new BindingCodec(throwing({})).info(buf(png))).rejects.toMatchObject({ status: 503, code: "image_service_unavailable", retryable: true });
  });

  it("a file the codec cannot decode is a 415 the client must not retry, not an internal 500", async () => {
    // It sniffs as a PNG, so it passes the byte check and reaches the codec. The live instance
    // answered this with {error:"internal", retryable:true} - a generic 500 that told the
    // client nothing and invited an endless retry of a file that can never succeed.
    const res = await upload(truncatedPng, "image/png");
    expect(res.status).toBe(415);
    expect(await res.json()).toMatchObject({ error: "unsupported_media_type", retryable: false });
  });

  it("BindingCodec.reencode returns the declared format and no JPEG metadata", async () => {
    const codec = new BindingCodec(env.IMG!);
    expect(hasMarker(jpg, 0xe1)).toBe(true); // the fixture really carries EXIF
    const outJpg = new Uint8Array(await codec.reencode(buf(jpg), "image/jpeg"));
    expect(outJpg.slice(0, 3)).toEqual(new Uint8Array([0xff, 0xd8, 0xff]));
    expect(hasMarker(outJpg, 0xe1)).toBe(false);
    const outPng = new Uint8Array(await codec.reencode(buf(png), "image/png"));
    expect(outPng.slice(0, 4)).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
  });

  it("an upload through the whole production path records what the real codec produced", async () => {
    const res = await upload(png, "image/png");
    expect(res.status).toBe(201);
    const { id } = await res.json<{ id: string }>();
    const row = (await getImage(env.DB, id))!;
    expect({ width: row.width, height: row.height }).toEqual({ width: 8, height: 6 });
    const stored = await env.IMAGES.get(row.r2_key);
    // The recorded byte count is the re-encoded length, not the uploaded length. A mismatch
    // here would ship a wrong Content-Length from the image origin.
    expect(stored!.size).toBe(row.bytes);
  });
});

// ── Seam 2: the signed-URL builder ──────────────────────────────────────────────────────────
// There is no double here: signImageUrl and verifyImageSig run real WebCrypto in tests and in
// production. What was untested is the join between two Workers - the admin builds the URL
// from its own IMAGES_URL and secret, and a different Worker verifies it. Both sides were only
// ever driven from a URL the test itself assembled, so a divergence in the signed string, the
// base URL or the query names would have passed.
describe("seam: signed-URL builder across the two Workers", () => {
  const secret = "shared-image-secret";
  const E = { ...env, SESSION_SECRET: "s3", IMAGE_URL_SECRET: secret };

  const seedImageOnMessage = async () => {
    const { id } = await (await upload(png, "image/png")).json<{ id: string }>();
    const ok = await submit([id]);
    expect(ok.status).toBe(201);
    return { imageId: id, messageId: (await ok.json<{ id: string }>()).id };
  };

  it("a URL the admin API minted is accepted by the image origin and serves the stored bytes", async () => {
    const { imageId, messageId } = await seedImageOnMessage();
    const token = (await createAdminToken(env.DB, "seam")).token;
    const detail = await adminWorker.fetch(
      new Request(`https://admin.example.invalid/api/messages/${messageId}`, { headers: { authorization: `Bearer ${token}` } }),
      E,
      createExecutionContext(),
    );
    expect(detail.status).toBe(200);
    const body = await detail.json<{ images: Array<{ id: string; url: string | null; bytes: number }> }>();
    const image = body.images.find((i) => i.id === imageId)!;
    expect(image.url).toBeTruthy();
    expect(new URL(image.url!).origin).toBe("https://images.example.invalid");

    const served = await imagesWorker.fetch(new Request(image.url!), E, createExecutionContext());
    expect(served.status).toBe(200);
    const bytes = new Uint8Array(await served.arrayBuffer());
    const row = (await getImage(env.DB, imageId))!;
    expect(bytes.byteLength).toBe(row.bytes);
    expect(served.headers.get("content-length")).toBe(String(row.bytes));
    const stored = new Uint8Array(await (await env.IMAGES.get(row.r2_key))!.arrayBuffer());
    expect(bytes).toEqual(stored);
  });

  it("the image origin rejects an admin-minted URL when the two Workers hold different secrets", async () => {
    const { imageId, messageId } = await seedImageOnMessage();
    const token = (await createAdminToken(env.DB, "seam2")).token;
    const detail = await adminWorker.fetch(
      new Request(`https://admin.example.invalid/api/messages/${messageId}`, { headers: { authorization: `Bearer ${token}` } }),
      E,
      createExecutionContext(),
    );
    const body = await detail.json<{ images: Array<{ id: string; url: string | null }> }>();
    const url = body.images.find((i) => i.id === imageId)!.url!;
    const mismatched = { ...env, IMAGE_URL_SECRET: "a-different-secret" };
    expect((await imagesWorker.fetch(new Request(url), mismatched, createExecutionContext())).status).toBe(403);
  });

  it("the admin API returns no URL at all when the secret is unset, rather than an unsigned one", async () => {
    const { imageId, messageId } = await seedImageOnMessage();
    const token = (await createAdminToken(env.DB, "seam3")).token;
    const detail = await adminWorker.fetch(
      new Request(`https://admin.example.invalid/api/messages/${messageId}`, { headers: { authorization: `Bearer ${token}` } }),
      { ...env, SESSION_SECRET: "s3", IMAGE_URL_SECRET: undefined },
      createExecutionContext(),
    );
    const body = await detail.json<{ images: Array<{ id: string; url: string | null }> }>();
    expect(body.images.find((i) => i.id === imageId)!.url).toBeNull();
  });
});

// ── Seam 3: object-store access ─────────────────────────────────────────────────────────────
// No double exists here either: the same R2 API is called in tests and in production, against
// the local object store the Workers runtime provides. The gap is that no test drove the paths
// where the store and the database can disagree - a delete over a key the store no longer
// holds, and whether the bucket ends up holding anything Ulak did not record.
describe("seam: object-store access", () => {
  it("deleteImageObjects tolerates a key the store no longer holds, so purge finishes", async () => {
    const { id } = await (await upload(png, "image/png")).json<{ id: string }>();
    const row = (await getImage(env.DB, id))!;
    await env.IMAGES.delete(row.r2_key); // the store lost it; the row still names it
    await expect(deleteImageObjects(env, [row.r2_key, `img/demo/${crypto.randomUUID()}`])).resolves.toBeUndefined();
  });

  it("the bucket holds exactly the keys the database recorded, under the app-scoped prefix", async () => {
    const a = await (await upload(png, "image/png")).json<{ id: string }>();
    const b = await (await upload(jpg, "image/jpeg")).json<{ id: string }>();
    const listed = (await env.IMAGES.list()).objects.map((o) => o.key).sort();
    const recorded = (await env.DB.prepare("SELECT r2_key FROM images").all<{ r2_key: string }>()).results.map((r) => r.r2_key).sort();
    expect(listed).toEqual(recorded);
    expect(listed).toHaveLength(2);
    for (const k of listed) expect(k).toMatch(/^img\/demo\/[0-9a-f-]{36}$/);
    expect(a.id).not.toBe(b.id);
  });

  it("the content type the origin sends is the sniffed type, not the declared one", async () => {
    // A PNG announced as JPEG must be stored and served as a PNG; the declared header is never
    // consulted. The stored object carries the type as R2 metadata as well as the row.
    const { id } = await (await upload(png, "image/jpeg")).json<{ id: string }>();
    const row = (await getImage(env.DB, id))!;
    expect(row.content_type).toBe("image/png");
    expect((await env.IMAGES.get(row.r2_key))!.httpMetadata?.contentType).toBe("image/png");
  });
});

// ── Seam 4: the rate-limit binding ──────────────────────────────────────────────────────────
// limiterFor picks BindingRateLimiter in production and MemoryRateLimiter everywhere else. The
// suite has only ever run the memory limiter, so the adapter over the platform binding - the
// one line that reads .success off the binding's answer - had never executed.
describe("seam: rate-limit binding", () => {
  it("limiterFor picks the binding adapter when a namespace is bound, the memory one when not", () => {
    const fallback = new MemoryRateLimiter(3, 60);
    expect(limiterFor(env.RL_PROBE, fallback)).toBeInstanceOf(BindingRateLimiter);
    expect(limiterFor(undefined, fallback)).toBe(fallback);
  });

  it("BindingRateLimiter refuses once the real binding's namespace is spent", async () => {
    const rl = new BindingRateLimiter(env.RL_PROBE);
    const k = `seam:${hex()}`;
    expect(await rl.allow(k)).toBe(true);
    expect(await rl.allow(k)).toBe(true);
    expect(await rl.allow(k)).toBe(false);
    expect(await rl.allow(`seam:${hex()}`)).toBe(true); // a different key is its own window
  });
});

// ── Seam 5: the outbound transport ──────────────────────────────────────────────────────────
// The first deployment failed here: an unbound global fetch passes every test that injects its
// own transport, then throws "Illegal invocation" in production the moment it is stored on an
// object and called as a method. Both injectable transports now default to one exported value,
// so this single probe covers TelegramNotifier and the OpenID Connect token exchange together.
describe("seam: outbound transport", () => {
  it("defaultFetch survives being stored on an object and called as a method", async () => {
    const holder = { impl: defaultFetch };
    let reason = "";
    try {
      await holder.impl("https://ulak-seam-probe.invalid/");
    } catch (e) {
      reason = e instanceof Error ? e.message : String(e);
    }
    // Bound, it fails on the name that does not resolve; unbound it would never get that far.
    expect(reason).not.toMatch(/illegal invocation/i);
    expect(reason).not.toBe("");
  });
});
