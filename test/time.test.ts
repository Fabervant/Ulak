import { describe, it, expect } from "vitest";
import { nowIso, addMinutes, isIso } from "../src/core/time";

describe("time", () => {
  it("nowIso is ISO 8601 UTC", () => {
    expect(nowIso()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
  it("addMinutes moves forward and backward", () => {
    expect(addMinutes("2026-01-01T00:00:00.000Z", 15)).toBe("2026-01-01T00:15:00.000Z");
    expect(addMinutes("2026-01-01T00:00:00.000Z", -10)).toBe("2025-12-31T23:50:00.000Z");
  });
  it("isIso rejects garbage", () => {
    expect(isIso("2026-01-01T00:00:00.000Z")).toBe(true);
    expect(isIso("yesterday")).toBe(false);
    expect(isIso("")).toBe(false);
  });
});
