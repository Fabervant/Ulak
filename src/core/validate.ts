import { invalid } from "./errors";
import { isUuidV4 } from "./ids";
import { isIso } from "./time";

export const MAX_BODY_BYTES = 16384;
export const MAX_MESSAGE = 8000;
export const MAX_LAST_ERROR = 4096;
export const MAX_CONTEXT_BYTES = 8192;
export const MAX_ATTACHMENTS = 3;
export const PLATFORMS = ["web", "android", "ios", "windows", "macos", "linux"] as const;
export type Platform = (typeof PLATFORMS)[number];

export interface SubmitPayload {
  app: string;
  app_version: string;
  app_build: string | null;
  platform: Platform;
  user_ref: string | null;
  message: string;
  client_ts: string | null;
  client_msg_id: string;
  locale: string | null;
  last_error: string | null;
  contact_email: string | null;
  /** Serialised JSON object, or null. Stored opaquely, never queried. */
  context: string | null;
  attachments: string[];
}

const str = (o: Record<string, unknown>, k: string, max: number, required: boolean): string | null => {
  const v = o[k];
  if (v === undefined || v === null) {
    if (required) throw invalid(k, `${k} is required`);
    return null;
  }
  if (typeof v !== "string") throw invalid(k, `${k} must be a string`);
  if (required && v.length === 0) throw invalid(k, `${k} must not be empty`);
  if (v.length > max) throw invalid(k, `${k} exceeds ${max} characters`);
  return v;
};

export function validateSubmit(raw: unknown): SubmitPayload {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw invalid("body", "body must be a JSON object");
  const o = raw as Record<string, unknown>;

  const app = str(o, "app", 32, true)!;
  if (!/^[a-z0-9_-]{2,32}$/.test(app)) throw invalid("app", "app must match [a-z0-9_-]{2,32}");
  const app_version = str(o, "app_version", 64, true)!;
  const app_build = str(o, "app_build", 64, false);
  const platform = str(o, "platform", 16, true)!;
  if (!(PLATFORMS as readonly string[]).includes(platform)) throw invalid("platform", `platform must be one of ${PLATFORMS.join(", ")}`);
  const user_ref = str(o, "user_ref", 128, false);
  if (user_ref !== null && user_ref.length < 16) throw invalid("user_ref", "user_ref must be 16 to 128 characters");
  const client_msg_id = str(o, "client_msg_id", 36, true)!;
  if (!isUuidV4(client_msg_id)) throw invalid("client_msg_id", "client_msg_id must be a UUID version 4");
  const last_error = str(o, "last_error", MAX_LAST_ERROR, false);
  const message = str(o, "message", MAX_MESSAGE, false) ?? "";
  if (message.length === 0 && !last_error) throw invalid("message", "message must not be empty unless last_error is set");
  const client_ts = str(o, "client_ts", 35, false);
  if (client_ts !== null && !isIso(client_ts)) throw invalid("client_ts", "client_ts must be ISO 8601");
  const locale = str(o, "locale", 16, false);
  const contact_email = str(o, "contact_email", 254, false);
  if (contact_email !== null && !/^[^@\s]+@[^@\s]+$/.test(contact_email)) throw invalid("contact_email", "contact_email is not an email address");

  let context: string | null = null;
  if (o.context !== undefined && o.context !== null) {
    if (typeof o.context !== "object" || Array.isArray(o.context)) throw invalid("context", "context must be a JSON object");
    context = JSON.stringify(o.context);
    if (new TextEncoder().encode(context).byteLength > MAX_CONTEXT_BYTES) throw invalid("context", `context exceeds ${MAX_CONTEXT_BYTES} bytes`);
  }

  let attachments: string[] = [];
  if (o.attachments !== undefined && o.attachments !== null) {
    if (!Array.isArray(o.attachments) || o.attachments.length > MAX_ATTACHMENTS || !o.attachments.every(isUuidV4))
      throw invalid("attachments", `attachments must be up to ${MAX_ATTACHMENTS} image ids`);
    attachments = o.attachments as string[];
  }

  return { app, app_version, app_build, platform: platform as Platform, user_ref, message, client_ts, client_msg_id, locale, last_error, contact_email, context, attachments };
}
