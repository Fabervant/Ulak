import { ApiError, invalid } from "../errors";
import { isIso, storedIso } from "../time";
import type { AppRow } from "../apps";

export const MAIL_KINDS = ["transactional", "legal_document"] as const;
export type MailKind = (typeof MAIL_KINDS)[number];

/** Kinds this build can send; `legal_document` comes with phase 1 (its kept copy and alerts). */
export const SENDABLE_KINDS: readonly MailKind[] = ["transactional"];

export const MAIL_MAX_BODY_BYTES = 512 * 1024;
export const SUBJECT_MAX_CHARS = 500;
export const TEXT_MAX_CHARS = 100_000;
export const HTML_MAX_CHARS = 200_000;
export const MAX_EXPIRY_HOURS = 24;

export interface MailRequest {
  to: string;
  locale: string;
  kind: MailKind;
  label: string;
  subject: string;
  text: string;
  html: string | null;
  expires_at: string;
  idempotency_key: string;
  user_ref: string | null;
}

export const ADDRESS = /^[^\s<>"'(),;:@\\]+@[^\s<>"'(),;:@\\]+\.[^\s<>"'(),;:@\\]+$/;
const LOCALE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/;
export const LABEL = /^[a-z0-9_.-]{1,64}$/;
const IDEM = /^[\x21-\x7e]{1,128}$/;
const CONTROL = /[\p{Cc}\p{Zl}\p{Zp}]/u;

const str = (v: unknown, field: string): string => {
  if (typeof v !== "string") throw invalid(field, `${field} must be a string`);
  return v;
};

/** The request's fields, or 400 naming the first bad one. Content rules are `mailMistake`'s. */
export function validateMail(raw: unknown, now: string): MailRequest {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw invalid("body", "body must be a JSON object");
  const b = raw as Record<string, unknown>;
  const to = str(b.to, "to").trim();
  if (to.length > 254 || !ADDRESS.test(to)) throw invalid("to", "to must be one mail address");
  const locale = str(b.locale, "locale");
  if (!LOCALE.test(locale)) throw invalid("locale", "locale must be a language tag such as en or pt-BR");
  const kind = str(b.kind, "kind");
  if (!(MAIL_KINDS as readonly string[]).includes(kind)) throw invalid("kind", `kind must be one of ${MAIL_KINDS.join(", ")}`);
  const label = str(b.label, "label");
  if (!LABEL.test(label)) throw invalid("label", "label must match [a-z0-9_.-]{1,64}");
  const subject = str(b.subject, "subject");
  if (!subject.trim() || [...subject].length > SUBJECT_MAX_CHARS || CONTROL.test(subject)) throw invalid("subject", `subject must be one line of 1 to ${SUBJECT_MAX_CHARS} characters`);
  const text = str(b.text, "text");
  if (!text.trim() || text.length > TEXT_MAX_CHARS) throw invalid("text", `text must be 1 to ${TEXT_MAX_CHARS} characters`);
  let html: string | null = null;
  if (b.html !== undefined && b.html !== null) {
    html = str(b.html, "html");
    if (!html.trim() || html.length > HTML_MAX_CHARS) throw invalid("html", `html must be 1 to ${HTML_MAX_CHARS} characters`);
  }
  const exp = str(b.expires_at, "expires_at");
  if (!isIso(exp)) throw invalid("expires_at", "expires_at must be ISO 8601");
  const expires_at = storedIso(exp);
  const ahead = Date.parse(expires_at) - Date.parse(now);
  if (ahead <= 0 || ahead > MAX_EXPIRY_HOURS * 3_600_000) throw invalid("expires_at", `expires_at must be later than now and at most ${MAX_EXPIRY_HOURS} hours ahead`);
  const idempotency_key = str(b.idempotency_key, "idempotency_key");
  if (!IDEM.test(idempotency_key)) throw invalid("idempotency_key", "idempotency_key must be 1 to 128 printable characters");
  let user_ref: string | null = null;
  if (b.user_ref !== undefined && b.user_ref !== null) {
    user_ref = str(b.user_ref, "user_ref");
    if (user_ref.length < 16 || user_ref.length > 128) throw invalid("user_ref", "user_ref must be 16 to 128 characters");
  }
  return { to, locale, kind: kind as MailKind, label, subject, text, html, expires_at, idempotency_key, user_ref };
}

const unprocessable = (code: string, detail: string) => new ApiError(422, code, detail, false);

const TAG = /<\/?[a-z][a-z0-9]*(\s[^<>]*)?\/?>|<!--|<!doctype/i;
const URL_IN_TEXT = /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"']*/gi;
const LINK_ATTR = /\b(?:href|action|formaction|xlink:href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
// Styles are allowed (mail HTML depends on them) as long as they load nothing.
const FORBIDDEN_TAG = /<\s*(script|form|img|iframe|frame|object|embed|link|base|svg|video|audio|picture|source|input|button|textarea|select)\b/i;
const FORBIDDEN_ATTR = /\s(on[a-z]+|src|srcset|background|poster|http-equiv)\s*=|url\s*\(|image-set\s*\(|@import/i;

const httpsOnly = (url: string) => /^https:\/\/[^\s/]+/i.test(url.trim());

/** The app's own mistakes in content, as the 422 reason the app treats as a bug. A guard against
 *  an app's errors, not a sanitiser: the HTML part is the app's finished text, sent as given. */
export function mailMistake(app: AppRow, m: MailRequest): ApiError | null {
  if (!SENDABLE_KINDS.includes(m.kind) || !app.mail_kinds.includes(m.kind)) return unprocessable("kind_not_allowed", `this app may not send ${m.kind} mail`);
  if (!app.mail_labels.includes(m.label)) return unprocessable("unknown_label", `label ${m.label} is not on this app's list`);
  if (TAG.test(m.text)) return unprocessable("not_plain_text", "text must be plain text; put markup in html");
  for (const u of m.text.match(URL_IN_TEXT) ?? []) if (!httpsOnly(u)) return unprocessable("bad_link", "every link must be an absolute https:// link");
  if (m.html !== null) {
    if (FORBIDDEN_TAG.test(m.html) || FORBIDDEN_ATTR.test(m.html)) return unprocessable("bad_html", "html may not hold scripts, forms, images, embedded content or styles that load anything");
    for (const a of m.html.matchAll(LINK_ATTR)) if (!httpsOnly(a[1] ?? a[2] ?? a[3] ?? "")) return unprocessable("bad_link", "every link must be an absolute https:// link");
    for (const u of m.html.match(URL_IN_TEXT) ?? []) if (!httpsOnly(u)) return unprocessable("bad_link", "every link must be an absolute https:// link");
  }
  return null;
}
