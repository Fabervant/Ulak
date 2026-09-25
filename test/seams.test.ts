// Every dependency-injection seam whose default only runs in production, exercised through
// that default. Three of the defects the first deployment exposed lived in the gap between an
// injected double and the real platform, so a seam that exists for testing needs something
// that drives the production side of it. docs/seam-audit.md is the inventory this file backs;
// it also records the two seams that cannot be driven here and what covers them instead.
import { env, createExecutionContext } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import imagesWorker from "../src/images/index";
import adminWorker from "../src/admin/index";
import { BindingCodec, PassthroughCodec, codecFromEnv, getImage, deleteImageObjects } from "../src/core/images";
import { BindingRateLimiter, MemoryRateLimiter, limiterFor } from "../src/core/ratelimit";
import { defaultFetch } from "../src/core/http";
import { createAdminToken } from "../src/core/auth/admintoken";
import { createSession } from "../src/core/auth/session";
import { PNG as png, JPG_WITH_GPS as jpg } from "./fixtures";
import { hex, imagesApp, uploadImage, submitWithImages } from "./helpers";

const buf = (u: Uint8Array): ArrayBuffer => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
/** A vector the image service can actually decode. The fixture SVG has no intrinsic size, so
 *  the service refuses it outright; this one is answered normally - with a format and no width,
 *  which is the branch that keeps a vector out of the bucket. */
const decodableSvg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="6"><rect width="8" height="6" fill="#123"/><script>alert(1)</script></svg>');
/** A real PNG signature and IHDR followed by nothing usable: it passes the byte sniff and only
 *  the codec can tell it is not an image. */
const truncatedPng = new Uint8Array([...png.subarray(0, 24), 0, 0, 0, 0, 0, 0, 0, 0]);

let key: string;
let U: string;
beforeEach(async () => {
  key = await imagesApp();
  U = hex();
});

const upload = (bytes: Uint8Array, ct: string) => uploadImage(key, bytes, ct, U);

// ── Seam 1: the image codec ─────────────────────────────────────────────────────────────────
// codecFromEnv returns BindingCodec when the Images binding is present and PassthroughCodec
// when it is not. The test config binds the image service, so the whole suite runs the
// production branch.
//
// Caveat, stated in docs/seam-audit.md too: the local image service is backed by libvips, not
// by the codec Cloudflare runs in production. This proves our side of the seam - the branch
// taken, the stream plumbing, the shape of the info response, the guard on a non-raster - and
// it does not prove that the production codec answers the same way.
describe("seam: image codec", () => {
  const throwing = (extra: object) =>
    ({ info: async () => { throw Object.assign(new Error("service said no"), extra); } }) as unknown as ImagesBinding;

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

  it("a code the service documents as its own limit or timeout is a retryable 503, never a 415", async () => {
    // The binding throws a numeric code for every failure, not only for a bad file. A timeout or
    // a processing limit on a perfectly good PNG must not tell the client to discard the file.
    // These codes are listed because they name the service's condition in the service's own
    // documentation; every other number keeps the 415 rule above.
    for (const code of [9422, 9432, 9522, 9524, 9529]) {
      await expect(new BindingCodec(throwing({ code })).info(buf(png))).rejects.toMatchObject({
        status: 503,
        code: "image_service_unavailable",
        retryable: true,
        extra: { platform_code: code },
      });
    }
  });

  it("a file the codec cannot decode is a 415 the client must not retry, not an internal 500", async () => {
    // It sniffs as a PNG, so it passes the byte check and reaches the codec. A codec failure
    // must name the file, or a client honouring the retry flag resends it forever.
    const res = await upload(truncatedPng, "image/png");
    expect(res.status).toBe(415);
    expect(await res.json()).toMatchObject({ error: "unsupported_media_type", retryable: false });
  });

  it("BindingCodec.reencode returns a PNG for a PNG", async () => {
    // The JPEG side, and its metadata stripping, runs through the upload path in images.test.ts.
    const out = new Uint8Array(await new BindingCodec(env.IMG!).reencode(buf(png), "image/png"));
    expect(out.slice(0, 4)).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
  });
});

// ── Seam 2: the signed-URL builder ──────────────────────────────────────────────────────────
// signImageUrl and verifyImageSig run real WebCrypto in tests and in production. The seam is
// the join between two Workers: the admin builds the URL from its own IMAGES_URL and secret,
// and a different Worker verifies it, so only a URL the admin itself minted can catch a
// divergence in the signed string, the base URL or the query names.
describe("seam: signed-URL builder across the two Workers", () => {
  const E = { ...env, SESSION_SECRET: "s3", IMAGE_URL_SECRET: "shared-image-secret" };

  const seedImageOnMessage = async () => {
    const { id } = await (await upload(png, "image/png")).json<{ id: string }>();
    const ok = await submitWithImages(key, [id], U);
    expect(ok.status).toBe(201);
    return { imageId: id, messageId: (await ok.json<{ id: string }>()).id };
  };

  /** The URL the admin API gives for one image of one message, under the admin's own env. */
  const adminApiImageUrl = async (adminEnv: typeof env, messageId: string, imageId: string) => {
    const token = (await createAdminToken(env.DB, hex())).token;
    const detail = await adminWorker.fetch(
      new Request(`https://admin.example.invalid/api/messages/${messageId}`, { headers: { authorization: `Bearer ${token}` } }),
      adminEnv,
      createExecutionContext(),
    );
    expect(detail.status).toBe(200);
    const body = await detail.json<{ images: Array<{ id: string; url: string | null }> }>();
    return body.images.find((i) => i.id === imageId)!.url;
  };

  /** The origin serves exactly the stored bytes, with the recorded length. */
  const expectServesStored = async (url: string, imageId: string) => {
    expect(new URL(url).origin).toBe("https://images.example.invalid");
    const served = await imagesWorker.fetch(new Request(url), E, createExecutionContext());
    expect(served.status).toBe(200);
    const bytes = new Uint8Array(await served.arrayBuffer());
    const row = (await getImage(env.DB, imageId))!;
    expect(served.headers.get("content-length")).toBe(String(row.bytes));
    expect(bytes).toEqual(new Uint8Array(await (await env.IMAGES.get(row.r2_key))!.arrayBuffer()));
  };

  it("a URL the admin API minted is accepted by the image origin and serves the stored bytes", async () => {
    const { imageId, messageId } = await seedImageOnMessage();
    await expectServesStored((await adminApiImageUrl(E, messageId, imageId))!, imageId);
  });

  it("a link on the admin's HTML message page is accepted by the image origin", async () => {
    const { imageId, messageId } = await seedImageOnMessage();
    await env.DB.prepare("INSERT INTO admins (sub,email_at_pin,pinned_at) VALUES ('sub-seam','a@example.invalid','2026-01-01T00:00:00.000Z')").run();
    const page = await adminWorker.fetch(
      new Request(`https://admin.example.invalid/m/${messageId}`, { headers: { cookie: `ulak_admin=${await createSession("s3", "sub-seam")}` } }),
      E,
      createExecutionContext(),
    );
    expect(page.status).toBe(200);
    const href = /href="(https:[^"]+)"/.exec(await page.text())![1]!.replaceAll("&amp;", "&");
    await expectServesStored(href, imageId);
  });

  it("the image origin rejects an admin-minted URL when the two Workers hold different secrets", async () => {
    const { imageId, messageId } = await seedImageOnMessage();
    const url = (await adminApiImageUrl(E, messageId, imageId))!;
    const mismatched = { ...env, IMAGE_URL_SECRET: "a-different-secret" };
    expect((await imagesWorker.fetch(new Request(url), mismatched, createExecutionContext())).status).toBe(403);
  });

  it("the admin API returns no URL at all when the secret is unset, rather than an unsigned one", async () => {
    const { imageId, messageId } = await seedImageOnMessage();
    expect(await adminApiImageUrl({ ...E, IMAGE_URL_SECRET: undefined }, messageId, imageId)).toBeNull();
  });
});

// ── Seam 3: object-store access ─────────────────────────────────────────────────────────────
// No double exists here either: the same R2 API is called in tests and in production, against
// the local object store the Workers runtime provides. What needs driving is where the store and
// the database can disagree - a delete over a key the store no longer holds, and whether the
// bucket ends up holding anything Ulak did not record.
describe("seam: object-store access", () => {
  it("deleteImageObjects tolerates a key the store no longer holds, so purge finishes", async () => {
    const { id } = await (await upload(png, "image/png")).json<{ id: string }>();
    const row = (await getImage(env.DB, id))!;
    await env.IMAGES.delete(row.r2_key); // the store lost it; the row still names it
    await expect(deleteImageObjects(env, [row.r2_key, `img/demo/${crypto.randomUUID()}`])).resolves.toBeUndefined();
  });

  it("the bucket holds exactly the keys the database recorded, under the app-scoped prefix", async () => {
    await upload(png, "image/png");
    await upload(jpg, "image/jpeg");
    const listed = (await env.IMAGES.list()).objects.map((o) => o.key).sort();
    const recorded = (await env.DB.prepare("SELECT r2_key FROM images").all<{ r2_key: string }>()).results.map((r) => r.r2_key).sort();
    expect(listed).toEqual(recorded);
    expect(listed).toHaveLength(2);
    for (const k of listed) expect(k).toMatch(/^img\/demo\/[0-9a-f-]{36}$/);
  });
});

// ── Seam 4: the rate-limit binding ──────────────────────────────────────────────────────────
// limiterFor picks BindingRateLimiter in production and MemoryRateLimiter everywhere else. The
// production limiter namespaces are unbound in tests, so the test config binds RL_PROBE only
// for this file to execute the adapter over the platform binding.
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
// An unbound global fetch passes every test that injects its own transport, then throws
// "Illegal invocation" in production the moment it is stored on an object and called as a
// method. Both injectable transports default to one exported value, so this single probe
// covers TelegramNotifier and the OpenID Connect token exchange together.
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
