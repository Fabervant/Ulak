import { describe, it, expect } from "vitest";
import { validateSubmit } from "../src/core/validate";
import { ApiError } from "../src/core/errors";

const good = () => ({
  app: "demo",
  app_version: "1.2.3",
  platform: "android",
  user_ref: "f3a9c2e1d4b5a6978877665544332211",
  message: "Merhaba, uygulama açılmıyor: ışğİ",
  client_msg_id: "9b2c1a0e-3f4d-4e5f-8a9b-0c1d2e3f4a5b",
  locale: "tr-TR",
});

const fails = (raw: unknown, field: string) => {
  try {
    validateSubmit(raw);
  } catch (e) {
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).status).toBe(400);
    expect((e as ApiError).extra.field).toBe(field);
    return;
  }
  throw new Error("expected ApiError");
};

describe("validateSubmit", () => {
  it("accepts a good payload and normalises absent optionals to null", () => {
    const p = validateSubmit(good());
    expect(p.user_ref).toBe(good().user_ref);
    expect(p.last_error).toBeNull();
    expect(p.contact_email).toBeNull();
    expect(p.context).toBeNull();
    expect(p.attachments).toEqual([]);
    expect(p.message).toContain("ışğİ");
  });
  it("ignores unknown fields", () => {
    expect(() => validateSubmit({ ...good(), future_field: 1 })).not.toThrow();
  });
  it("requires app, app_version, platform, client_msg_id", () => {
    fails({ ...good(), app: undefined }, "app");
    fails({ ...good(), app_version: "" }, "app_version");
    fails({ ...good(), platform: "tv" }, "platform");
    fails({ ...good(), client_msg_id: "6ba7b810-9dad-11d1-80b4-00c04fd430c8" }, "client_msg_id");
  });
  it("V1: message may be empty only with last_error", () => {
    fails({ ...good(), message: "" }, "message");
    expect(validateSubmit({ ...good(), message: "", last_error: "NullPointerException at X" }).message).toBe("");
  });
  it("V2: user_ref null is fine, short user_ref is not", () => {
    expect(validateSubmit({ ...good(), user_ref: null }).user_ref).toBeNull();
    expect(validateSubmit({ ...good(), user_ref: undefined }).user_ref).toBeNull();
    fails({ ...good(), user_ref: "short" }, "user_ref");
    fails({ ...good(), user_ref: "x".repeat(129) }, "user_ref");
  });
  it("caps message, last_error, context", () => {
    fails({ ...good(), message: "a".repeat(8001) }, "message");
    fails({ ...good(), last_error: "a".repeat(4097) }, "last_error");
    fails({ ...good(), context: { big: "a".repeat(8200) } }, "context");
    fails({ ...good(), context: "not an object" }, "context");
    expect(validateSubmit({ ...good(), context: { screen: "home" } }).context).toBe('{"screen":"home"}');
  });
  it("client_ts must be ISO when present and is kept as sent", () => {
    fails({ ...good(), client_ts: "yesterday" }, "client_ts");
    expect(validateSubmit({ ...good(), client_ts: "2026-01-01T00:00:00.000Z" }).client_ts).toBe("2026-01-01T00:00:00.000Z");
  });
  it("contact_email needs an @ and a sane length", () => {
    fails({ ...good(), contact_email: "nope" }, "contact_email");
    expect(validateSubmit({ ...good(), contact_email: "a@b.co" }).contact_email).toBe("a@b.co");
  });
  it("attachments: at most 3 uuids", () => {
    fails({ ...good(), attachments: ["x"] }, "attachments");
    const ids = [
      "9b2c1a0e-3f4d-4e5f-8a9b-0c1d2e3f4a5b",
      "9b2c1a0e-3f4d-4e5f-8a9b-0c1d2e3f4a5c",
      "9b2c1a0e-3f4d-4e5f-8a9b-0c1d2e3f4a5d",
      "9b2c1a0e-3f4d-4e5f-8a9b-0c1d2e3f4a5e",
    ];
    fails({ ...good(), attachments: ids }, "attachments");
    expect(validateSubmit({ ...good(), attachments: ids.slice(0, 3) }).attachments).toHaveLength(3);
  });
});
