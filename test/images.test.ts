import { env, createExecutionContext } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import worker from "../src/api/index";
import imagesWorker from "../src/images/index";
import { createApp, updateApp } from "../src/core/apps";
import { sniffImageType, purgeUnclaimedImages, getImage } from "../src/core/images";
import { signImageUrl } from "../src/core/signedurl";
import { addMinutes, nowIso } from "../src/core/time";
import { PNG as png, JPG_WITH_GPS as jpg, SVG as svg } from "./fixtures";
let key: string;
let U: string;
const hex = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");

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
    expect(await env.IMAGES.get(row.r2_key)).not.toBeNull();
  });
  it("strips EXIF: the stored JPEG has no APP1 segment", async () => {
    let fixtureHasApp1 = false;
    for (let i = 2; i < jpg.length - 1; i++) if (jpg[i] === 0xff && jpg[i + 1] === 0xe1) fixtureHasApp1 = true;
    expect(fixtureHasApp1).toBe(true);
    const { id } = await (await upload(jpg, "image/jpeg")).json<{ id: string }>();
    const stored = new Uint8Array(await (await env.IMAGES.get((await getImage(env.DB, id))!.r2_key))!.arrayBuffer());
    let hasApp1 = false;
    for (let i = 2; i < stored.length - 1; i++) if (stored[i] === 0xff && stored[i + 1] === 0xe1) hasApp1 = true;
    expect(hasApp1).toBe(false);
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
    expect(new Uint8Array(await good.arrayBuffer())).toEqual(png);
    expect((await imagesWorker.fetch(new Request(url.replace(/sig=[0-9a-f]+/, "sig=00")), e, createExecutionContext())).status).toBe(403);
    const expired = await signImageUrl(secret, "https://images.example.invalid", id, Math.floor(Date.now() / 1000) - 1);
    expect((await imagesWorker.fetch(new Request(expired), e, createExecutionContext())).status).toBe(403);
  });
});
