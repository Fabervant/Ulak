import { env, createExecutionContext } from "cloudflare:test";
import worker from "../src/api/index";
import { createApp, updateApp } from "../src/core/apps";

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
