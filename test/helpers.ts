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
