import { describe, it, expect } from "vitest";
import { newId, isUuidV4, sha256Hex, randomToken } from "../src/core/ids";

describe("ids", () => {
  it("newId is a v4 uuid", () => expect(isUuidV4(newId())).toBe(true));
  it("isUuidV4 rejects v1 and junk", () => {
    expect(isUuidV4("6ba7b810-9dad-11d1-80b4-00c04fd430c8")).toBe(false);
    expect(isUuidV4("not-a-uuid")).toBe(false);
    expect(isUuidV4("9B2C1A0E-3F4D-4E5F-8A9B-0C1D2E3F4A5B")).toBe(true);
  });
  it("sha256Hex is stable and handles Turkish text", async () => {
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(await sha256Hex("ışğİ")).toHaveLength(64);
  });
  it("randomToken has prefix and 48 hex chars", () => {
    expect(randomToken("ulak_demo")).toMatch(/^ulak_demo_[0-9a-f]{48}$/);
  });
});
