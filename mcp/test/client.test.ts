import { describe, it, expect } from "vitest";
import { UlakClient } from "../src/client.js";

const fake = (handler: (url: string, init?: RequestInit) => Response) => (async (url: string, init?: RequestInit) => handler(url, init)) as unknown as typeof fetch;

describe("UlakClient", () => {
  it("sends the bearer token and builds query strings", async () => {
    let seen: { url: string; auth: string | null } | undefined;
    const c = new UlakClient(
      "https://admin.example.invalid/",
      "ulak_admin_x",
      fake((url, init) => {
        seen = { url, auth: new Headers(init?.headers).get("authorization") };
        return new Response('{"messages":[]}', { status: 200 });
      }),
    );
    await c.listMessages({ app: "demo", status: "pending", limit: 5 });
    expect(seen!.url).toBe("https://admin.example.invalid/api/messages?app=demo&status=pending&limit=5");
    expect(seen!.auth).toBe("Bearer ulak_admin_x");
  });
  it("throws with the API error code on failure", async () => {
    const c = new UlakClient("https://a", "t", fake(() => new Response('{"error":"invalid_admin_token","retryable":false,"detail":"bad"}', { status: 401 })));
    await expect(c.getMessage("x")).rejects.toThrow(/invalid_admin_token/);
  });
  it("posts JSON for reply and status", async () => {
    let body: string | undefined;
    const c = new UlakClient(
      "https://a",
      "t",
      fake((_u, init) => {
        body = init?.body as string;
        return new Response('{"id":"m","status":"viewed"}', { status: 200 });
      }),
    );
    await c.setStatus("m", "viewed");
    expect(JSON.parse(body!)).toEqual({ status: "viewed" });
  });
});
