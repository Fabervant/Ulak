import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import admin from "../src/admin/index";
import api from "../src/api/index";
import images from "../src/images/index";

const SHAPE = { error: expect.any(String), retryable: expect.any(Boolean), detail: expect.any(String) };

async function ask(worker: { fetch: Function }, path: string, e: unknown = env) {
  const ctx = createExecutionContext();
  const res: Response = await worker.fetch(new Request(`https://x.example.invalid${path}`), e, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

describe("every error response is { error, retryable, detail }", () => {
  it.each([
    ["the API Worker, an unknown route", api, "/no-such-route", 404],
    ["the image Worker, an unknown route", images, "/no-such-route", 404],
    ["the image Worker, a bad link", images, "/i/no-such-image?exp=1&sig=x", 403],
  ] as const)("%s", async (_name, worker, path, status) => {
    const res = await ask(worker, path, { ...env, IMAGE_URL_SECRET: "s" });
    expect(res.status).toBe(status);
    expect(await res.json()).toMatchObject(SHAPE);
  });
  it("the admin API, signed out", async () => {
    const res = await ask(admin, "/api/no-such-route");
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject(SHAPE);
  });
});
