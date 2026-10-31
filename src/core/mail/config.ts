import type { Env } from "../env";
import { ApiError } from "../errors";

export interface MailConfig {
  apiUrl: string;
  fromDomain: string;
  apiKey: string;
  webhookKey: string;
  hashSecret: string;
  /** Who sends: the operator's name, address, phone, e-mail and abuse contact. It closes every mail. */
  senderInfo: string;
}

/** The six settings mail needs. They are set together or not at all: the vendor's terms require the
 *  sender's identity in every mail, so no mail goes without `MAIL_SENDER_INFO`. */
export const MAIL_SETTINGS = ["MAIL_API_URL", "MAIL_FROM_DOMAIN", "MAIL_API_KEY", "MAIL_WEBHOOK_KEY", "MAIL_HASH_SECRET", "MAIL_SENDER_INFO"] as const;

export class MailConfigError extends Error {
  constructor(public missing: string[]) {
    super(`mail configuration is half set; missing: ${missing.join(", ")}`);
  }
}

/** The mail settings when all six are set, null when none is. Some but not all throws: a half-set
 *  configuration must never look like an unconfigured one, and never like success. */
export function mailConfig(env: Env): MailConfig | null {
  const missing = MAIL_SETTINGS.filter((k) => !env[k]?.trim());
  if (missing.length === MAIL_SETTINGS.length) return null;
  if (missing.length) throw new MailConfigError(missing);
  return { apiUrl: env.MAIL_API_URL!, fromDomain: env.MAIL_FROM_DOMAIN!.trim().toLowerCase(), apiKey: env.MAIL_API_KEY!, webhookKey: env.MAIL_WEBHOOK_KEY!, hashSecret: env.MAIL_HASH_SECRET!, senderInfo: env.MAIL_SENDER_INFO!.trim() };
}

/** mailConfig for a request: 503 when mail is not set up here, 500 when it is half set. */
export function requireMailConfig(env: Env): MailConfig {
  let cfg: MailConfig | null;
  try {
    cfg = mailConfig(env);
  } catch (e) {
    if (!(e instanceof MailConfigError)) throw e;
    console.error("mail config", e.message);
    throw new ApiError(500, "mail_config_half_set", "this instance's mail configuration is incomplete", false);
  }
  if (!cfg) throw new ApiError(503, "mail_unconfigured", "this instance does not send mail", false);
  return cfg;
}

/** For the health check: whether the configuration is half set. */
export function mailConfigHalfSet(env: Env): boolean {
  try {
    mailConfig(env);
    return false;
  } catch (e) {
    if (e instanceof MailConfigError) return true;
    throw e;
  }
}
