export interface RateLimitBinding {
  limit(opts: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  DB: D1Database;
  IMAGES: R2Bucket;
  IMG?: ImagesBinding;
  RL_SUBMIT_USER?: RateLimitBinding;
  RL_SUBMIT_IP?: RateLimitBinding;
  RL_READ_USER?: RateLimitBinding;
  RL_UPLOAD_USER?: RateLimitBinding;
  STATUS_LIST: string;
  TRUST_X_FORWARDED_FOR?: string;
  READ_IP_BACKSTOP?: string;
  CONTROLLER_NAME: string;
  ADMIN_URL: string;
  IMAGES_URL: string;
  ADMIN_BOOTSTRAP_EMAILS?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  SESSION_SECRET?: string;
  IMAGE_URL_SECRET?: string;
  /** When set, GET /status/<this value> reports health to an external monitor. Unset disables the route. */
  STATUS_SECRET?: string;
  NOTIFIER?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  /** Outbound mail: all six or none (src/core/mail/config.ts). */
  MAIL_API_URL?: string;
  MAIL_FROM_DOMAIN?: string;
  MAIL_API_KEY?: string;
  MAIL_WEBHOOK_KEY?: string;
  MAIL_HASH_SECRET?: string;
  MAIL_SENDER_INFO?: string;
  /** Legal documents: the copy's keeping period in days; unset refuses legal documents (src/core/mail/legal.ts). */
  LEGAL_KEEP_DAYS?: string;
  /** Legal documents: how many hours Ulak keeps trying; 24 when unset. */
  LEGAL_EXPIRY_HOURS?: string;
}

export function statusList(env: Env): string[] {
  return env.STATUS_LIST.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
